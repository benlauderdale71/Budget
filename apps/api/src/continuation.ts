import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { createOidcStart, oidcReturnPath, projectMonthlyRetirement, realizeFifo, type TaxLot } from "@budgetcents/domain";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, type Actor, assertBudget, assertWrite, audit, canSeeAccount, requireMember } from "./finance.js";
import { visibleAudit } from "./sharing.js";

const HELP = [
  { id: "ready", title: "Ready to Assign", body: "Ready to Assign is cash already in on-budget accounts that does not yet have a job. Expected income is not included." },
  { id: "ownership", title: "Mine, yours, and ours", body: "A transaction labeled Ours belongs to the household. A split can name a member for part of the same purchase. The parts add up to the purchase once, and the bank total does not change." },
  { id: "alerts", title: "Alerts", body: "Alerts are checked from the ledger you can see. A background refresh does not send the same open alert again. Push, email, and text are off until a provider is connected." },
  { id: "offline", title: "Offline", body: "A transaction or assignment kept on this device is waiting. It is not saved on the ledger until the server accepts it." },
  { id: "retirement", title: "Retirement projections", body: "A projection is a model with stated assumptions. It is not a guarantee and it does not move money in the register." },
  { id: "providers", title: "Outside services", body: "A request stored in BudgetCents is not a completed bank link, cancellation, transfer, booking, tax filing, or legal document." },
];

export interface ContinuationDeps {
  actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>;
  insertTransaction: (user: Actor, householdId: string, body: any) => Promise<{ id?: string }>;
  createGoal: (user: Actor, householdId: string, body: any) => Promise<{ id: string }>;
}

export function mountContinuation(app: Hono, db: Database, deps: ContinuationDeps) {
  app.get("/api/households/:hid/changes", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const since = c.req.query("since") ?? "";
    const events = (await visibleAudit(db, me.id, member.householdId)).filter((event) => String(event.created_at) > since);
    const prefs = await db.query(`SELECT version FROM alert_preferences WHERE user_id = $1 AND household_id = $2`, [me.id, member.householdId]);
    return c.json({
      serverTime: nowIso(),
      planRevision: member.planRevision,
      role: member.role,
      alertVersion: prefs.length ? num(prefs[0].version) : 0,
      events: events.filter((event) => event.action !== "alert.settings" || event.user_id === me.id),
    });
  });

  app.get("/api/help", async (c) => {
    await deps.actor(c);
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const articles = HELP.filter((article) => !q || `${article.title} ${article.body}`.toLowerCase().includes(q));
    return c.json({ articles, note: "These articles were written for BudgetCents. They are guidance, not a filed support request or an appointment." });
  });

  app.get("/api/support", async (c) => {
    const me = await deps.actor(c);
    const tickets = await db.query(`SELECT id, subject, status, created_at FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`, [me.id]);
    return c.json({ tickets });
  });

  app.post("/api/support/:id/messages", async (c) => {
    const me = await deps.actor(c);
    const body = z.object({ body: z.string().min(1).max(4000) }).parse(await c.req.json());
    const tickets = await db.query(`SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`, [c.req.param("id"), me.id]);
    if (!tickets.length) throw new ApiError(404, "Not found");
    const messageId = id();
    await db.query(`INSERT INTO support_messages (id, ticket_id, user_id, body, created_at) VALUES ($1,$2,$3,$4,$5)`, [messageId, tickets[0].id, me.id, body.body, nowIso()]);
    return c.json({ id: messageId, status: tickets[0].status, note: "Your message is stored with the request. It does not mean a person has replied." }, 201);
  });

  app.get("/api/auth/oidc/start", async (c) => {
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!issuer || !clientId || !process.env.OIDC_CLIENT_SECRET) {
      return c.json({ error: "Federated sign-in is not configured.", status: "not_configured" }, 404);
    }
    const start = createOidcStart({
      issuer,
      clientId,
      redirectUri: process.env.OIDC_REDIRECT_URI || "https://localhost/api/auth/oidc/callback",
      returnPath: oidcReturnPath(c.req.query("next")),
    });
    await db.query(`INSERT INTO oidc_states (state, nonce, code_verifier, return_path, created_at) VALUES ($1,$2,$3,$4,$5)`, [start.state, start.nonce, start.codeVerifier, oidcReturnPath(c.req.query("next")), nowIso()]);
    return c.json({ authorizationUrl: start.authorizationUrl, status: "redirect" });
  });

  app.get("/api/auth/oidc/callback", async (c) => {
    if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
      return c.json({ error: "Federated sign-in is not configured.", status: "not_configured" }, 404);
    }
    const state = c.req.query("state") ?? "";
    const saved = await db.query(`SELECT state FROM oidc_states WHERE state = $1`, [state]);
    if (!saved.length) throw new ApiError(400, "The sign-in attempt could not be matched. Start again.");
    await db.query(`DELETE FROM oidc_states WHERE state = $1`, [state]);
    throw new ApiError(502, "The identity provider did not complete sign-in. No account was created or linked, and no invitation was accepted.");
  });

  app.patch("/api/households/:hid/goals/:id", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertBudget(member);
    const body = z.object({ name: z.string().min(1).max(80).optional(), targetMinor: z.number().int().nonnegative().optional(), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(await c.req.json());
    const rows = await db.query(`SELECT id FROM goals WHERE id = $1 AND household_id = $2`, [c.req.param("id"), member.householdId]);
    if (!rows.length) throw new ApiError(404, "Not found");
    if (body.name != null) await db.query(`UPDATE goals SET name = $1 WHERE id = $2`, [body.name, rows[0].id]);
    if (body.targetMinor != null) await db.query(`UPDATE goals SET target_minor = $1 WHERE id = $2`, [body.targetMinor, rows[0].id]);
    if (body.targetDate !== undefined) await db.query(`UPDATE goals SET target_date = $1 WHERE id = $2`, [body.targetDate, rows[0].id]);
    return c.json({ ok: true, note: "The goal target changed. Envelope balances and the register did not." });
  });

  app.get("/api/households/:hid/lots", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const lots = await visibleLots(db, me.id, member.householdId);
    return c.json({
      lots,
      missingBasis: lots.filter((lot) => lot.costBasisMinor == null).length,
      note: "Lots are manual records. A missing cost basis stays missing and is not treated as zero. Selling a lot does not by itself create a bank transaction.",
    });
  });

  app.post("/api/households/:hid/lots", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ holdingId: z.string(), quantityMicro: z.number().int().positive(), costBasisMinor: z.number().int().nonnegative().nullable(), acquired: z.string() }).parse(await c.req.json());
    await visibleHolding(db, me.id, member.householdId, body.holdingId);
    const lotId = id();
    await db.query(`INSERT INTO lots (id, holding_id, quantity, cost_basis_minor, acquired) VALUES ($1,$2,$3,$4,$5)`, [lotId, body.holdingId, String(body.quantityMicro), body.costBasisMinor, body.acquired]);
    await audit(db, member.householdId, me.id, "lot.create", "Added a tax lot. The register was not changed.", "holding", body.holdingId);
    return c.json({ id: lotId }, 201);
  });

  app.patch("/api/households/:hid/lots/:id", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ costBasisMinor: z.number().int().nonnegative().nullable() }).parse(await c.req.json());
    const lot = await ownedLot(db, me.id, member.householdId, c.req.param("id"));
    await db.query(`UPDATE lots SET cost_basis_minor = $1 WHERE id = $2`, [body.costBasisMinor, lot.id]);
    return c.json({ ok: true, note: body.costBasisMinor == null ? "The cost basis is missing. It was not set to zero." : "The cost basis was saved. The register was not changed." });
  });

  app.post("/api/households/:hid/lots/sell", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ holdingId: z.string(), quantityMicro: z.number().int().positive(), proceedsMinor: z.number().int().nonnegative() }).parse(await c.req.json());
    await visibleHolding(db, me.id, member.householdId, body.holdingId);
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    const rows = await db.query(`SELECT * FROM lots WHERE holding_id = $1`, [body.holdingId]);
    if (rows.some((row) => row.cost_basis_minor == null)) throw new ApiError(400, "Add the missing cost basis before recording this sale. Missing basis is not zero.");
    const lots: TaxLot[] = rows.map((row) => ({ id: String(row.id), quantityMicro: Number(row.quantity), costBasisMinor: num(row.cost_basis_minor), acquired: String(row.acquired) }));
    const result = realizeFifo(lots, body.quantityMicro, body.proceedsMinor);
    await db.tx(async () => {
      const remaining = new Set(result.remaining.map((lot) => lot.id));
      for (const lot of lots) {
        if (!remaining.has(lot.id)) await db.query(`DELETE FROM lots WHERE id = $1`, [lot.id]);
      }
      for (const lot of result.remaining) await db.query(`UPDATE lots SET quantity = $1, cost_basis_minor = $2 WHERE id = $3`, [String(lot.quantityMicro), lot.costBasisMinor, lot.id]);
      await audit(db, member.householdId, me.id, "lot.sell", "Recorded a lot sale. No bank transaction was created.", "holding", body.holdingId);
    });
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    if (num(before[0].n) !== num(after[0].n)) throw new Error("A lot sale must not create a bank transaction.");
    return c.json({ gainMinor: result.gainMinor, sales: result.sales, note: "This realized gain is lot history. It is not a register transaction and it is not tax advice." });
  });

  app.post("/api/households/:hid/benchmarks", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ name: z.string().min(1).max(80), points: z.array(z.object({ date: z.string(), valueMinor: z.number().int() })).min(2) }).parse(await c.req.json());
    const benchmarkId = id();
    await db.query(`INSERT INTO benchmarks (id, household_id, name, points_json, source, updated_at) VALUES ($1,$2,$3,$4,'manual',$5)`, [benchmarkId, member.householdId, body.name, JSON.stringify(body.points), nowIso()]);
    return c.json({ id: benchmarkId, source: "manual", note: "This series is what you entered. BudgetCents did not download a market index." }, 201);
  });

  app.get("/api/households/:hid/look-through", async (c) => {
    const me = await deps.actor(c);
    await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ available: false, holdings: [], note: "Fund look-through needs licensed holdings data. None is configured, so no underlying holdings were invented." });
  });

  app.post("/api/households/:hid/retirement/monthly", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    const body = z.object({
      portfolioMinor: z.number().int().nonnegative(),
      traditionalMinor: z.number().int().nonnegative(),
      annualReturnBps: z.number().int(),
      annualSpendingMinor: z.number().int().nonnegative(),
      annualContributionMinor: z.number().int().nonnegative(),
      taxBps: z.number().int().nonnegative(),
      age: z.number().int().min(0).max(120),
      birthYear: z.number().int().optional(),
      months: z.number().int().min(1).max(600),
    }).parse(await c.req.json());
    const projection = projectMonthlyRetirement(body);
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    if (num(before[0].n) !== num(after[0].n)) throw new Error("A retirement projection must not post to the ledger.");
    return c.json({ ...projection, guarantee: false });
  });

  app.post("/api/households/:hid/assistant/actions/preview", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({ kind: z.enum(["create_transaction", "create_goal", "create_rule"]), payload: z.record(z.unknown()) }).parse(await c.req.json());
    const actionId = id();
    await db.query(
      `INSERT INTO assistant_actions (id, household_id, user_id, kind, payload_json, result_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actionId, member.householdId, me.id, body.kind, JSON.stringify(body.payload), JSON.stringify({ status: "preview" }), nowIso()],
    );
    return c.json({ id: actionId, kind: body.kind, payload: body.payload, status: "preview", note: "Nothing was saved. Confirm to run this through the normal ledger rules." });
  });

  app.post("/api/households/:hid/assistant/actions/:id/confirm", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const rows = await db.query(`SELECT * FROM assistant_actions WHERE id = $1 AND household_id = $2 AND user_id = $3`, [c.req.param("id"), member.householdId, me.id]);
    if (!rows.length) throw new ApiError(404, "Not found");
    const result = JSON.parse(String(rows[0].result_json)) as { status?: string };
    if (result.status !== "preview") throw new ApiError(409, "This proposal was already confirmed or undone.");
    const payload = JSON.parse(String(rows[0].payload_json)) as Record<string, unknown>;
    let saved: { id?: string } = {};
    if (rows[0].kind === "create_transaction") saved = await deps.insertTransaction(me, member.householdId, payload);
    else if (rows[0].kind === "create_goal") saved = await deps.createGoal(me, member.householdId, payload);
    else {
      const rule = z.object({ spaceId: z.string().optional(), name: z.string(), priority: z.number().int().default(100), matchMode: z.enum(["all", "any"]), conditions: z.array(z.record(z.unknown())), actions: z.array(z.record(z.unknown())) }).parse(payload);
      saved = { id: id() };
      await db.query(`INSERT INTO rules (id, household_id, space_id, name, priority, enabled, match_mode, conditions_json, actions_json) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`, [saved.id, member.householdId, rule.spaceId ?? null, rule.name, rule.priority, rule.matchMode, JSON.stringify(rule.conditions), JSON.stringify(rule.actions)]);
    }
    await db.query(`UPDATE assistant_actions SET result_json = $1 WHERE id = $2`, [JSON.stringify({ status: "confirmed", entityId: saved.id ?? null }), rows[0].id]);
    await audit(db, member.householdId, me.id, "assistant.confirm", `Confirmed ${String(rows[0].kind)}`, "assistant_action", String(rows[0].id));
    return c.json({ ok: true, entityId: saved.id ?? null, note: "The action ran through the same rules as a form you save yourself." });
  });

  app.post("/api/households/:hid/assistant/actions/:id/undo", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const rows = await db.query(`SELECT * FROM assistant_actions WHERE id = $1 AND household_id = $2 AND user_id = $3`, [c.req.param("id"), member.householdId, me.id]);
    if (!rows.length) throw new ApiError(404, "Not found");
    const result = JSON.parse(String(rows[0].result_json)) as { status?: string; entityId?: string };
    if (result.status !== "confirmed" || !result.entityId) throw new ApiError(409, "There is nothing to undo.");
    if (rows[0].kind !== "create_transaction") throw new ApiError(400, "Undo is available for a transaction this action added, while it is still the latest version and is not reconciled.");
    const updated = await db.query(
      `UPDATE transactions SET deleted = 1, version = version + 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0 AND version = 1 AND reconciled = 0 AND COALESCE(locked, 0) = 0 RETURNING id`,
      [nowIso(), result.entityId, member.householdId],
    );
    if (!updated.length) throw new ApiError(409, "That transaction changed or was reconciled, so it was not undone.");
    await db.query(`UPDATE assistant_actions SET undone_at = $1, result_json = $2 WHERE id = $3`, [nowIso(), JSON.stringify({ status: "undone", entityId: result.entityId }), rows[0].id]);
    await audit(db, member.householdId, me.id, "assistant.undo", "Undid a confirmed transaction.", "transaction", result.entityId);
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/providers/sandbox/connect", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ provider: z.literal("sandbox-bank") }).parse(await c.req.json());
    const connectionId = id();
    await db.query(`INSERT INTO connections (id, household_id, provider, status, consent_at, created_at) VALUES ($1,$2,$3,'sandbox',$4,$4)`, [connectionId, member.householdId, body.provider, nowIso()]);
    await db.query(`INSERT INTO consents (id, user_id, household_id, provider, scope, granted_at) VALUES ($1,$2,$3,$4,'sandbox-read',$5)`, [id(), me.id, member.householdId, body.provider, nowIso()]);
    const transactions = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    return c.json({ id: connectionId, status: "sandbox", transactionsImported: 0, transactionCount: num(transactions[0].n), note: "No accounts were linked and no transactions were imported. A sandbox connection is not a bank." }, 201);
  });

  app.post("/api/households/:hid/providers/sandbox/revoke", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    await db.query(`UPDATE connections SET status = 'revoked' WHERE household_id = $1 AND provider = 'sandbox-bank' AND status = 'sandbox'`, [member.householdId]);
    await db.query(`UPDATE consents SET withdrawn_at = $1 WHERE household_id = $2 AND provider = 'sandbox-bank' AND withdrawn_at IS NULL`, [nowIso(), member.householdId]);
    return c.json({ status: "revoked", note: "The sandbox consent was withdrawn. No bank was contacted." });
  });

  app.post("/api/providers/sandbox/webhook", async (c) => {
    const secret = process.env.SANDBOX_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "The sandbox webhook secret is not configured.", status: "not_configured" }, 404);
    const raw = await c.req.text();
    const sent = c.req.header("x-budgetcents-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const left = Buffer.from(sent);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ApiError(401, "The webhook signature did not match. Nothing was stored.");
    const body = z.object({
      householdId: z.string(),
      externalId: z.string().min(1),
      kind: z.enum(["price_increase", "credit_change", "broken_connection"]),
      title: z.string().min(1).max(80),
      body: z.string().min(1).max(180),
      occurredOn: z.string(),
    }).parse(JSON.parse(raw));
    const inserted = await db.query(
      `INSERT INTO provider_events (id, household_id, provider, kind, external_id, title, body, occurred_on, created_at)
       VALUES ($1,$2,'sandbox-bank',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (household_id, provider, external_id) DO NOTHING RETURNING id`,
      [id(), body.householdId, body.kind, body.externalId, body.title, body.body, body.occurredOn, nowIso()],
    );
    return c.json({ accepted: true, duplicate: inserted.length === 0, transactionsImported: 0 });
  });

  app.post("/api/households/:hid/service-requests", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({ kind: z.enum(["cancellation", "negotiation", "transfer", "booking", "tax", "estate"]), detail: z.string().min(1).max(1000) }).parse(await c.req.json());
    const requestId = id();
    await db.query(`INSERT INTO service_requests (id, household_id, user_id, kind, status, detail, created_at) VALUES ($1,$2,$3,$4,'authorization_recorded',$5,$6)`, [requestId, member.householdId, me.id, body.kind, body.detail, nowIso()]);
    return c.json({ id: requestId, status: "authorization_recorded", completed: false, note: "This records your request. It is not a completed cancellation, transfer, booking, tax filing, or legal document." }, 201);
  });

  app.post("/api/devices/:id/push-token", async (c) => {
    const me = await deps.actor(c);
    const body = z.object({ token: z.string().min(1).max(400) }).parse(await c.req.json());
    const updated = await db.query(`UPDATE devices SET push_token = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL RETURNING id`, [body.token, c.req.param("id"), me.id]);
    if (!updated.length) throw new ApiError(404, "Not found");
    return c.json({ stored: true, delivery: "not_configured", note: "The token is stored. No remote notification was sent." });
  });

  app.post("/api/notifications/email-test", async (c) => {
    await deps.actor(c);
    if (!process.env.SMTP_URL) return c.json({ error: "Email delivery is not connected. A development outbox is not email delivery.", status: "not_configured" }, 404);
    return c.json({ error: "Email delivery is configured, but this build does not send a message without an explicit send operation.", status: "not_sent" }, 409);
  });

  app.get("/api/households/:hid/coaching", async (c) => {
    const me = await deps.actor(c);
    await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ provider: "not_configured", appointments: [], note: "No coaching provider is configured. Nothing here is a confirmed appointment." });
  });
}

async function visibleHolding(db: Database, userId: string, householdId: string, holdingId: string) {
  const rows = await db.query(`SELECT h.id, a.visibility, a.owner_user_id FROM holdings h JOIN accounts a ON a.id = h.account_id WHERE h.id = $1 AND h.household_id = $2`, [holdingId, householdId]);
  if (!rows.length || !canSeeAccount(userId, { visibility: String(rows[0].visibility), owner_user_id: str(rows[0].owner_user_id) ?? null })) throw new ApiError(404, "Not found");
  return rows[0];
}

async function ownedLot(db: Database, userId: string, householdId: string, lotId: string) {
  const rows = await db.query(`SELECT l.id, l.holding_id FROM lots l JOIN holdings h ON h.id = l.holding_id WHERE l.id = $1 AND h.household_id = $2`, [lotId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  await visibleHolding(db, userId, householdId, String(rows[0].holding_id));
  return rows[0];
}

async function visibleLots(db: Database, userId: string, householdId: string) {
  const rows = await db.query(
    `SELECT l.id, l.holding_id, l.quantity, l.cost_basis_minor, l.acquired, h.symbol, a.visibility, a.owner_user_id
     FROM lots l JOIN holdings h ON h.id = l.holding_id JOIN accounts a ON a.id = h.account_id
     WHERE h.household_id = $1`,
    [householdId],
  );
  return rows.filter((row) => canSeeAccount(userId, { visibility: String(row.visibility), owner_user_id: str(row.owner_user_id) ?? null })).map((row) => ({
    id: String(row.id),
    holdingId: String(row.holding_id),
    symbol: String(row.symbol),
    quantityMicro: Number(row.quantity),
    costBasisMinor: row.cost_basis_minor == null ? null : num(row.cost_basis_minor),
    acquired: String(row.acquired),
  }));
}
