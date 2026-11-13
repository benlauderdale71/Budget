import { SANDBOX_INCREMENTAL, SANDBOX_INITIAL, planExternalSync, type ExternalActivity, type LedgerMirror } from "@budgetcents/domain";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num } from "./db.js";
import { ApiError, type Actor, audit } from "./finance.js";

async function mirrors(db: Database, householdId: string): Promise<LedgerMirror[]> {
  const transactions = await db.query(
    `SELECT id, provider_transaction_id, bank_status FROM transactions WHERE household_id = $1 AND deleted = 0 AND provider_transaction_id IS NOT NULL`,
    [householdId],
  );
  const aliases = await db.query(`SELECT transaction_id, external_id FROM provider_transaction_ids WHERE household_id = $1`, [householdId]);
  const status = new Map(transactions.map((row) => [String(row.id), String(row.bank_status) === "pending" ? "pending" as const : "posted" as const]));
  const rows: LedgerMirror[] = transactions.map((row) => ({
    id: String(row.id),
    externalId: String(row.provider_transaction_id),
    bankStatus: status.get(String(row.id)) ?? "posted",
  }));
  for (const alias of aliases) {
    const bankStatus = status.get(String(alias.transaction_id));
    if (!bankStatus) continue;
    if (!rows.some((row) => row.externalId === String(alias.external_id))) {
      rows.push({ id: String(alias.transaction_id), externalId: String(alias.external_id), bankStatus });
    }
  }
  return rows;
}

async function sandboxAccount(db: Database, householdId: string, spaceId: string) {
  const spaces = await db.query(`SELECT id FROM spaces WHERE id = $1 AND household_id = $2`, [spaceId, householdId]);
  if (!spaces.length) throw new ApiError(404, "Not found");
  const existing = await db.query(`SELECT id FROM accounts WHERE household_id = $1 AND name = 'Sandbox Checking' AND archived = 0`, [householdId]);
  if (existing.length) return String(existing[0].id);
  const household = await db.query(`SELECT currency FROM households WHERE id = $1`, [householdId]);
  const accountId = id();
  await db.query(
    `INSERT INTO accounts (id, household_id, space_id, name, kind, currency, on_budget, visibility, institution, created_at)
     VALUES ($1,$2,$3,'Sandbox Checking','checking',$4,1,'shared','Sandbox bank',$5)`,
    [accountId, householdId, spaceId, String(household[0]?.currency || "USD"), nowIso()],
  );
  return accountId;
}

export async function importSandboxActivities(db: Database, actor: Actor, householdId: string, spaceId: string, incoming: ExternalActivity[], insertTransaction: (user: Actor, householdId: string, body: Record<string, unknown>) => Promise<{ id?: string }>) {
  const accountId = await sandboxAccount(db, householdId, spaceId);
  const plan = planExternalSync(await mirrors(db, householdId), incoming);
  let imported = 0;
  for (const activity of plan.insert) {
    const created = await insertTransaction(actor, householdId, {
      date: activity.postedOn,
      accountId,
      amountMinor: activity.amountMinor,
      type: activity.amountMinor < 0 ? "expense" : "income",
      payee: activity.payee,
      bankStatus: activity.bankStatus,
      providerTransactionId: activity.externalId,
      opId: `sandbox:${householdId}:${activity.externalId}`,
      splits: [],
    });
    if (created.id) {
      await db.query(`INSERT INTO provider_transaction_ids (household_id, external_id, transaction_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [householdId, activity.externalId, created.id]);
      imported += 1;
    }
  }
  let settled = 0;
  for (const item of plan.settle) {
    const updated = await db.query(
      `UPDATE transactions SET bank_status = 'posted', updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0 AND bank_status = 'pending' RETURNING id`,
      [nowIso(), item.id, householdId],
    );
    if (!updated.length) continue;
    await db.query(`INSERT INTO provider_transaction_ids (household_id, external_id, transaction_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [householdId, item.activity.externalId, item.id]);
    settled += 1;
  }
  return { imported, settled, duplicates: plan.duplicates.length, accountId };
}

export async function sandboxConnection(db: Database, householdId: string) {
  const rows = await db.query(`SELECT id, status FROM connections WHERE household_id = $1 AND provider = 'sandbox-bank' ORDER BY created_at DESC`, [householdId]);
  return rows[0] ? { id: String(rows[0].id), status: String(rows[0].status) } : null;
}

export async function connectSandbox(db: Database, actor: Actor, householdId: string, spaceId: string, insertTransaction: (user: Actor, householdId: string, body: Record<string, unknown>) => Promise<{ id?: string }>) {
  const current = await sandboxConnection(db, householdId);
  if (current?.status === "revoked") throw new ApiError(409, "Reconnect the sandbox before importing again. No transactions were imported.");
  let connectionId = current?.id;
  if (!connectionId) {
    connectionId = id();
    await db.query(`INSERT INTO connections (id, household_id, provider, status, institution, consent_at, created_at) VALUES ($1,$2,'sandbox-bank','sandbox','Sandbox bank',$3,$3)`, [connectionId, householdId, nowIso()]);
  }
  await db.query(`INSERT INTO consents (id, user_id, household_id, provider, scope, granted_at) VALUES ($1,$2,$3,'sandbox-bank','sandbox-read',$4)`, [id(), actor.id, householdId, nowIso()]);
  const result = await importSandboxActivities(db, actor, householdId, spaceId, SANDBOX_INITIAL, insertTransaction);
  await db.query(`UPDATE connections SET status = 'sandbox', last_success_at = $1, error = NULL WHERE id = $2`, [nowIso(), connectionId]);
  await audit(db, householdId, actor.id, "sandbox.connect", `Imported ${result.imported} sandbox fixture transactions and settled ${result.settled}. This is not a live bank.`, "connection", connectionId);
  const transactions = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND deleted = 0 AND provider_transaction_id IS NOT NULL`, [householdId]);
  return { id: connectionId, status: "sandbox", transactionsImported: result.imported, settled: result.settled, duplicates: result.duplicates, sandboxTransactions: num(transactions[0].n), note: "Imported the built-in sandbox history into Sandbox Checking. This is not your bank." };
}

export async function syncSandbox(db: Database, actor: Actor, householdId: string, spaceId: string, insertTransaction: (user: Actor, householdId: string, body: Record<string, unknown>) => Promise<{ id?: string }>) {
  const current = await sandboxConnection(db, householdId);
  if (!current || current.status !== "sandbox") throw new ApiError(409, "Reconnect the sandbox before importing again. No transactions were imported.");
  const result = await importSandboxActivities(db, actor, householdId, spaceId, SANDBOX_INCREMENTAL, insertTransaction);
  await db.query(`UPDATE connections SET last_success_at = $1 WHERE id = $2`, [nowIso(), current.id]);
  await audit(db, householdId, actor.id, "sandbox.sync", `Sandbox sync added ${result.imported} and settled ${result.settled}. Duplicates skipped: ${result.duplicates}.`, "connection", current.id);
  return { ...result, note: "Incremental sandbox history was applied. A pending line that posted was updated in place. This is not your bank." };
}

export async function reconnectSandbox(db: Database, actor: Actor, householdId: string) {
  const current = await sandboxConnection(db, householdId);
  if (!current) throw new ApiError(404, "Not found");
  await db.query(`UPDATE connections SET status = 'sandbox', consent_at = $1, error = NULL WHERE id = $2`, [nowIso(), current.id]);
  await db.query(`INSERT INTO consents (id, user_id, household_id, provider, scope, granted_at) VALUES ($1,$2,$3,'sandbox-bank','sandbox-read',$4)`, [id(), actor.id, householdId, nowIso()]);
  return { status: "sandbox", note: "The sandbox consent is active again. Sync to fetch the fixture history. No live bank was contacted." };
}

export function activityFromWebhook(body: { externalId: string; postedOn: string; payee: string; amountMinor: number; bankStatus: "pending" | "posted"; settlesExternalId?: string }): ExternalActivity {
  return body;
}
