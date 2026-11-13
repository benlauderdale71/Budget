import type { Hono, Context } from "hono";
import { z } from "zod";
import type { Database } from "../db.js";
import { id, nowIso, sha256 } from "../crypto.js";
import { ApiError, type Actor, assertWrite, audit, canSeeAccount, lockHousehold, requireMember } from "../finance.js";
import { claimSimplefin, fetchSimplefin, simplefinTransactions, type SimplefinAccount } from "./simplefin.js";
import { openProviderSecret, providerKey, sealProviderSecret } from "./secrets.js";

type Importer = (actor: Actor, householdId: string, body: Record<string, unknown>) => Promise<{ id?: string }>;
type SourceRow = ReturnType<typeof simplefinTransactions>[number];
const note = "Posted transactions only. Review transfers and refunds before importing. Bank balances are reference figures and do not replace your ledger balance. Missing rows are never treated as deletions.";

export function mountBankRoutes(app: Hono, db: Database, actor: (c: Context) => Promise<Actor>, insert: Importer) {
  app.get("/api/households/:hid/accounts", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    return c.json(await db.tx(async () => {
      await lockHousehold(db, hid);
      await requireMember(db, me.id, hid);
      const rows = await db.query(`SELECT a.id, a.name, a.currency, a.kind, a.visibility, a.owner_user_id, s.kind AS space_kind, s.owner_user_id AS space_owner FROM accounts a JOIN spaces s ON s.id = a.space_id AND s.household_id = a.household_id WHERE a.household_id = $1 AND a.archived = 0 ORDER BY a.display_order, a.name, a.id`, [hid]);
      return { accounts: rows.filter((row) => canSeeAccount(me.id, { visibility: String(row.visibility), owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id) }) && !(row.space_kind === "personal" && row.space_owner && row.space_owner !== me.id)).map((row) => ({ id: row.id, name: row.name, currency: row.currency, kind: row.kind })) };
    }));
  });
  async function link(userId: string, hid: string, linkId: string) {
    await requireMember(db, userId, hid);
    const rows = await db.query(`SELECT * FROM bank_links WHERE id = $1 AND household_id = $2 AND user_id = $3 AND revoked_at IS NULL`, [linkId, hid, userId]);
    if (!rows[0]) throw new ApiError(404, "Bank connection not found.");
    return rows[0];
  }
  async function target(userId: string, hid: string, accountId: string, currency: string) {
    const rows = await db.query(`SELECT * FROM accounts WHERE id = $1 AND household_id = $2 AND archived = 0`, [accountId, hid]);
    const row = rows[0];
    if (!row || !canSeeAccount(userId, { visibility: String(row.visibility), owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id) })) throw new ApiError(404, "Account not found.");
    const spaces = await db.query(`SELECT kind, owner_user_id FROM spaces WHERE id = $1 AND household_id = $2`, [row.space_id, hid]);
    if (!spaces[0] || (spaces[0].kind === "personal" && spaces[0].owner_user_id != null && spaces[0].owner_user_id !== userId)) throw new ApiError(404, "Account not found.");
    if (row.currency !== currency) throw new ApiError(400, "The bank and ledger account currencies must match.");
    return row;
  }
  async function classify(linkId: string, externalAccountId: string, row: SourceRow) {
    const saved = await db.query(`SELECT r.transaction_id, r.fingerprint FROM bank_imported_rows r JOIN bank_links previous ON previous.id = r.link_id JOIN bank_links current ON current.id = $1 WHERE previous.household_id = current.household_id AND previous.user_id = current.user_id AND r.external_account_id = $2 AND r.external_id = $3 ORDER BY previous.created_at DESC LIMIT 1`, [linkId, externalAccountId, row.externalId]);
    return saved[0] ? saved[0].fingerprint === sha256(JSON.stringify(row)) ? "imported" : "changed" : "new";
  }

  app.get("/api/households/:hid/providers/simplefin", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    await requireMember(db, me.id, hid);
    const links = await db.query(`SELECT id, label, created_at, last_fetch_at FROM bank_links WHERE household_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY created_at`, [hid, me.id]);
    return c.json({ configured: /^[0-9a-f]{64}$/i.test(process.env.BUDGETCENTS_PROVIDER_KEY ?? ""), links, note });
  });
  app.post("/api/households/:hid/providers/simplefin/connect", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    assertWrite(await requireMember(db, me.id, hid));
    const body = z.object({ setupToken: z.string().min(20).max(2000), label: z.string().min(1).max(80), consent: z.literal(true) }).parse(await c.req.json());
    providerKey();
    const access = await claimSimplefin(body.setupToken);
    const linkId = id();
    await db.tx(async () => {
      await lockHousehold(db, hid);
      assertWrite(await requireMember(db, me.id, hid));
      await db.query(`INSERT INTO bank_links (id, household_id, user_id, label, secret, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [linkId, hid, me.id, body.label, sealProviderSecret(access, `${hid}:${me.id}:${linkId}`), nowIso()]);
      await audit(db, hid, me.id, "bank.connect", "Connected a bank data feed. No money moved.", "connection", linkId, { visibility: "private", ownerUserId: me.id });
    });
    return c.json({ id: linkId, note: "Connected. Preview bank history and choose a ledger account before importing." }, 201);
  });
  app.post("/api/households/:hid/providers/simplefin/:id/preview", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const current = await link(me.id, hid, c.req.param("id"));
    const end = Math.floor(Date.now() / 1000);
    const from = end - 90 * 86400;
    // Reserve the fetch slot under a lock so simultaneous devices cannot consume the provider quota.
    const cached = await db.tx(async () => {
      await lockHousehold(db, hid);
      const fresh = await link(me.id, hid, String(current.id));
      if (fresh.last_fetch_at && Date.now() - Date.parse(String(fresh.last_fetch_at)) < 3600000) {
        if (fresh.cache_json) return JSON.parse(String(fresh.cache_json));
        throw new ApiError(429, "Bank refresh is in progress or failed recently. Try again after one hour.");
      }
      await db.query(`UPDATE bank_links SET last_fetch_at = $1 WHERE id = $2`, [nowIso(), current.id]);
      return null;
    });
    const data = cached ?? await fetchSimplefin(openProviderSecret(String(current.secret), `${hid}:${me.id}:${current.id}`), from, end);
    return c.json(await db.tx(async () => {
      await lockHousehold(db, hid);
      await link(me.id, hid, String(current.id));
      if (!cached) await db.query(`UPDATE bank_links SET cache_json = $1 WHERE id = $2`, [JSON.stringify(data), current.id]);
      const previewId = id();
      await db.query(`INSERT INTO bank_previews (id, link_id, user_id, payload, created_at) VALUES ($1,$2,$3,$4,$5)`, [previewId, current.id, me.id, JSON.stringify(data), nowIso()]);
      const accounts = [];
      for (const account of data.accounts as SimplefinAccount[]) {
        const rows = [];
        for (const row of simplefinTransactions(account)) rows.push({ ...row, status: await classify(String(current.id), account.id, row) });
        rows.sort((a, b) => b.date.localeCompare(a.date) || a.externalId.localeCompare(b.externalId));
        accounts.push({ externalAccountId: account.id, name: account.name, currency: account.currency, referenceBalance: account.balance, balanceDate: account["balance-date"], rows });
      }
      return { previewId, accounts, warnings: data.warnings, cached: !!cached, note, expiresInMinutes: 15 };
    }));
  });
  app.post("/api/households/:hid/providers/simplefin/:id/import", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const body = z.object({ previewId: z.string(), externalAccountId: z.string(), accountId: z.string(), rows: z.array(z.object({ externalId: z.string(), type: z.enum(["income", "expense", "refund", "transfer"]), counterAccountId: z.string().optional(), refundOfId: z.string().optional() })).min(1).max(5000) }).parse(await c.req.json());
    return c.json(await db.tx(async () => {
      await lockHousehold(db, hid);
      assertWrite(await requireMember(db, me.id, hid));
      const current = await link(me.id, hid, c.req.param("id"));
      const previews = await db.query(`SELECT payload, created_at FROM bank_previews WHERE id = $1 AND link_id = $2 AND user_id = $3`, [body.previewId, current.id, me.id]);
      if (!previews[0] || Date.now() - Date.parse(String(previews[0].created_at)) > 15 * 60000) throw new ApiError(409, "This bank preview expired. Load a new preview before importing.");
      const account = (JSON.parse(String(previews[0].payload)).accounts as SimplefinAccount[]).find((a) => a.id === body.externalAccountId);
      if (!account) throw new ApiError(400, "Choose an account from this preview.");
      await target(me.id, hid, body.accountId, account.currency);
      const rows = simplefinTransactions(account);
      let imported = 0; let duplicates = 0;
      if (new Set(body.rows.map((r) => r.externalId)).size !== body.rows.length) throw new ApiError(400, "Select each bank transaction once.");
      for (const selected of body.rows) {
        const row = rows.find((r) => r.externalId === selected.externalId);
        if (!row) throw new ApiError(400, "Select a transaction from this preview.");
        const status = await classify(String(current.id), account.id, row);
        if (status === "imported") { duplicates++; continue; }
        if (status === "changed") throw new ApiError(409, "The bank changed an imported transaction. Review the existing register entry; it was not overwritten.");
        if (selected.type === "transfer") {
          if (!selected.counterAccountId || selected.counterAccountId === body.accountId) throw new ApiError(400, "Choose the other account for this transfer.");
          await target(me.id, hid, selected.counterAccountId, account.currency);
        }
        if (selected.type === "refund" && !selected.refundOfId) throw new ApiError(400, "Link the refund to its original expense.");
        const external = `simplefin:${sha256(JSON.stringify([hid, me.id, account.id, row.externalId]))}`;
        const created = await insert(me, hid, { date: row.date, accountId: body.accountId, amountMinor: row.amountMinor, type: selected.type, payee: row.payee, bankStatus: "posted", providerTransactionId: external, opId: external, splits: [], counterAccountId: selected.counterAccountId, refundOfId: selected.refundOfId });
        if (!created.id) throw new ApiError(409, "This transaction could not be imported.");
        await db.query(`INSERT INTO bank_imported_rows (link_id, external_account_id, external_id, transaction_id, fingerprint) VALUES ($1,$2,$3,$4,$5)`, [current.id, account.id, row.externalId, created.id, sha256(JSON.stringify(row))]);
        imported++;
      }
      await audit(db, hid, me.id, "bank.import", "Confirmed a bank import.", "account", body.accountId);
      return { imported, duplicates, note: "Selected posted transactions were imported once. Your opening balance was not changed." };
    }));
  });
  app.post("/api/households/:hid/providers/simplefin/:id/revoke", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    await db.tx(async () => {
      await lockHousehold(db, hid);
      const current = await link(me.id, hid, c.req.param("id"));
      await db.query(`UPDATE bank_links SET revoked_at = $1, secret = '', cache_json = NULL WHERE id = $2`, [nowIso(), current.id]);
      await db.query(`DELETE FROM bank_previews WHERE link_id = $1`, [current.id]);
    });
    return c.json({ note: "Local bank access was removed. Revoke the token in SimpleFIN too. Imported transactions remain in your ledger." });
  });
}
