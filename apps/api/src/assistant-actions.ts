import { z } from "zod";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num } from "./db.js";
import { ApiError, type Actor, assertBudget, assertPlanRevision, audit, bumpPlanRevision, lockHousehold, setAssignment, type Member } from "./finance.js";

interface ConfirmDeps {
  insertTransaction: (user: Actor, householdId: string, body: Record<string, unknown>) => Promise<{ id?: string }>;
  createGoal: (user: Actor, householdId: string, body: Record<string, unknown>) => Promise<{ id: string }>;
}

export async function confirmAssistantAction(db: Database, actor: Actor, member: Member, kind: string, payload: Record<string, unknown>, deps: ConfirmDeps): Promise<{ entityId: string | null; undo: Record<string, unknown> }> {
  if (kind === "create_transaction") {
    const saved = await deps.insertTransaction(actor, member.householdId, payload);
    return { entityId: saved.id ?? null, undo: { kind } };
  }
  if (kind === "create_goal") {
    assertBudget(member);
    const saved = await deps.createGoal(actor, member.householdId, payload);
    return { entityId: saved.id, undo: { kind } };
  }
  if (kind === "create_rule") {
    const rule = z.object({
      spaceId: z.string().optional(), name: z.string(), priority: z.number().int().default(100), matchMode: z.enum(["all", "any"]),
      conditions: z.array(z.record(z.string(), z.unknown())), actions: z.array(z.record(z.string(), z.unknown())),
    }).parse(payload);
    const ruleId = id();
    await db.query(`INSERT INTO rules (id, household_id, space_id, name, priority, enabled, match_mode, conditions_json, actions_json) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`, [ruleId, member.householdId, rule.spaceId ?? null, rule.name, rule.priority, rule.matchMode, JSON.stringify(rule.conditions), JSON.stringify(rule.actions)]);
    return { entityId: ruleId, undo: { kind } };
  }
  if (kind === "create_category") {
    assertBudget(member);
    const body = z.object({
      spaceId: z.string(), name: z.string().min(1).max(80), group: z.string().default("Spending"),
      kind: z.enum(["income", "expense"]).default("expense"), flexRole: z.enum(["fixed", "non_monthly", "flexible", "income", "reserve"]).default("flexible"),
    }).parse(payload);
    const space = await db.query(`SELECT id FROM spaces WHERE id = $1 AND household_id = $2`, [body.spaceId, member.householdId]);
    if (!space.length) throw new ApiError(404, "Not found");
    const bucketId = id();
    await db.query(
      `INSERT INTO buckets (id, household_id, space_id, name, group_name, kind, flex_role, envelope_style, rollover, display_order, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'regular','both',0,$8)`,
      [bucketId, member.householdId, body.spaceId, body.name, body.group, body.kind, body.flexRole, nowIso()],
    );
    await db.query(`INSERT INTO bucket_revisions (bucket_id, household_id, version, updated_at) VALUES ($1,$2,1,$3)`, [bucketId, member.householdId, nowIso()]);
    return { entityId: bucketId, undo: { kind } };
  }
  if (kind === "set_category" || kind === "set_tags") {
    const body = z.object({
      transactionId: z.string(), version: z.number().int(),
      bucketId: z.string().optional(), tags: z.array(z.string().min(1).max(40)).max(12).optional(),
    }).parse(payload);
    const rows = await db.query(`SELECT id, version, amount_minor, reconciled, locked FROM transactions WHERE id = $1 AND household_id = $2 AND deleted = 0`, [body.transactionId, member.householdId]);
    if (!rows.length) throw new ApiError(404, "Not found");
    if (num(rows[0].version) !== body.version) throw new ApiError(409, "That transaction changed. Nothing was saved.");
    if (num(rows[0].reconciled) === 1 || num(rows[0].locked) === 1) throw new ApiError(409, "That transaction is locked or reconciled. Nothing was saved.");
    if (kind === "set_category") {
      if (!body.bucketId) throw new ApiError(400, "Choose a category.");
      const bucket = await db.query(`SELECT id FROM buckets WHERE id = $1 AND household_id = $2`, [body.bucketId, member.householdId]);
      if (!bucket.length) throw new ApiError(404, "Not found");
      const previous = await db.query(`SELECT id, bucket_id, amount_minor, role, memo, owner_user_id FROM splits WHERE transaction_id = $1`, [body.transactionId]);
      const updated = await db.query(`UPDATE transactions SET version = version + 1, category_locked = 1, updated_at = $1 WHERE id = $2 AND version = $3 AND deleted = 0 RETURNING version`, [nowIso(), body.transactionId, body.version]);
      if (!updated.length) throw new ApiError(409, "That transaction changed. Nothing was saved.");
      await db.query(`DELETE FROM splits WHERE transaction_id = $1`, [body.transactionId]);
      await db.query(`INSERT INTO splits (id, transaction_id, bucket_id, amount_minor, role) VALUES ($1,$2,$3,$4,'expense')`, [id(), body.transactionId, body.bucketId, Math.abs(num(rows[0].amount_minor))]);
      return { entityId: body.transactionId, undo: { kind, version: num(updated[0].version), previous: previous.map(splitSnapshot) } };
    }
    const previous = await db.query(`SELECT tag FROM transaction_tags WHERE transaction_id = $1`, [body.transactionId]);
    const updated = await db.query(`UPDATE transactions SET version = version + 1, updated_at = $1 WHERE id = $2 AND version = $3 AND deleted = 0 RETURNING version`, [nowIso(), body.transactionId, body.version]);
    if (!updated.length) throw new ApiError(409, "That transaction changed. Nothing was saved.");
    await db.query(`DELETE FROM transaction_tags WHERE transaction_id = $1`, [body.transactionId]);
    for (const tag of body.tags ?? []) await db.query(`INSERT INTO transaction_tags (transaction_id, tag) VALUES ($1,$2)`, [body.transactionId, tag]);
    return { entityId: body.transactionId, undo: { kind, version: num(updated[0].version), previous: previous.map((row) => String(row.tag)) } };
  }
  if (kind === "adjust_plan") {
    assertBudget(member);
    const body = z.object({ spaceId: z.string(), bucketId: z.string(), periodKey: z.string(), amountMinor: z.number().int().nonnegative(), planRevision: z.number().int() }).parse(payload);
    const bucket = await db.query(`SELECT id FROM buckets WHERE id = $1 AND household_id = $2 AND space_id = $3`, [body.bucketId, member.householdId, body.spaceId]);
    if (!bucket.length) throw new ApiError(404, "Not found");
    let previous = 0;
    let revision = body.planRevision;
    await db.tx(async () => {
      await lockHousehold(db, member.householdId);
      await assertPlanRevision(db, member.householdId, body.planRevision);
      const current = await db.query(`SELECT amount_minor FROM assignments WHERE household_id = $1 AND space_id = $2 AND bucket_id = $3 AND period_key = $4`, [member.householdId, body.spaceId, body.bucketId, body.periodKey]);
      previous = current.length ? num(current[0].amount_minor) : 0;
      if (previous === body.amountMinor) return;
      await setAssignment(db, member.householdId, body.spaceId, body.bucketId, body.periodKey, body.amountMinor);
      revision = await bumpPlanRevision(db, member.householdId);
    });
    return { entityId: body.bucketId, undo: { kind, spaceId: body.spaceId, bucketId: body.bucketId, periodKey: body.periodKey, previous, planRevision: revision } };
  }
  throw new ApiError(400, "This assistant action is not supported.");
}

function splitSnapshot(row: Record<string, unknown>) {
  return { bucketId: row.bucket_id == null ? null : String(row.bucket_id), amountMinor: num(row.amount_minor), role: String(row.role), memo: row.memo == null ? null : String(row.memo), ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id) };
}

export async function undoAssistantAction(db: Database, member: Member, kind: string, entityId: string, undo: Record<string, unknown>) {
  if (kind === "create_transaction") {
    const updated = await db.query(
      `UPDATE transactions SET deleted = 1, version = version + 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0 AND version = 1 AND reconciled = 0 AND COALESCE(locked, 0) = 0 RETURNING id`,
      [nowIso(), entityId, member.householdId],
    );
    if (!updated.length) throw new ApiError(409, "That transaction changed or was reconciled, so it was not undone.");
    return;
  }
  if (kind === "create_goal") {
    const removed = await db.query(`DELETE FROM goals WHERE id = $1 AND household_id = $2 RETURNING id`, [entityId, member.householdId]);
    if (!removed.length) throw new ApiError(409, "That goal is no longer available, so it was not undone.");
    return;
  }
  if (kind === "create_rule") {
    const removed = await db.query(`DELETE FROM rules WHERE id = $1 AND household_id = $2 RETURNING id`, [entityId, member.householdId]);
    if (!removed.length) throw new ApiError(409, "That rule is no longer available, so it was not undone.");
    return;
  }
  if (kind === "create_category") {
    const used = await db.query(`SELECT (SELECT count(*) FROM splits WHERE bucket_id = $1) + (SELECT count(*) FROM goals WHERE bucket_id = $1) + (SELECT count(*) FROM assignments WHERE bucket_id = $1 AND amount_minor <> 0) AS n`, [entityId]);
    if (num(used[0]?.n) > 0) throw new ApiError(409, "That category is in use, so it was not undone.");
    const removed = await db.query(`DELETE FROM buckets WHERE id = $1 AND household_id = $2 RETURNING id`, [entityId, member.householdId]);
    if (!removed.length) throw new ApiError(409, "That category is no longer available, so it was not undone.");
    return;
  }
  if (kind === "set_category" || kind === "set_tags") {
    const version = Number(undo.version);
    const updated = await db.query(`UPDATE transactions SET version = version + 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0 AND version = $4 AND reconciled = 0 AND COALESCE(locked, 0) = 0 RETURNING id`, [nowIso(), entityId, member.householdId, version]);
    if (!updated.length) throw new ApiError(409, "That transaction changed, so it was not undone.");
    if (kind === "set_category") {
      await db.query(`DELETE FROM splits WHERE transaction_id = $1`, [entityId]);
      const previous = Array.isArray(undo.previous) ? undo.previous as { bucketId: string | null; amountMinor: number; role: string; memo: string | null; ownerUserId: string | null }[] : [];
      for (const split of previous) {
        await db.query(`INSERT INTO splits (id, transaction_id, bucket_id, amount_minor, role, memo, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id(), entityId, split.bucketId, split.amountMinor, split.role, split.memo, split.ownerUserId]);
      }
      return;
    }
    await db.query(`DELETE FROM transaction_tags WHERE transaction_id = $1`, [entityId]);
    const tags = Array.isArray(undo.previous) ? undo.previous as string[] : [];
    for (const tag of tags) await db.query(`INSERT INTO transaction_tags (transaction_id, tag) VALUES ($1,$2)`, [entityId, tag]);
    return;
  }
  if (kind === "adjust_plan") {
    assertBudget(member);
    const spaceId = String(undo.spaceId ?? "");
    const bucketId = String(undo.bucketId ?? entityId);
    const periodKey = String(undo.periodKey ?? "");
    const previous = Number(undo.previous);
    const revision = Number(undo.planRevision);
    await db.tx(async () => {
      await lockHousehold(db, member.householdId);
      await assertPlanRevision(db, member.householdId, revision);
      await setAssignment(db, member.householdId, spaceId, bucketId, periodKey, previous);
      await bumpPlanRevision(db, member.householdId);
    });
    return;
  }
  throw new ApiError(400, "Undo is not available for this action.");
}

export async function auditAssistant(db: Database, householdId: string, userId: string, action: string, message: string, entityId: string) {
  await audit(db, householdId, userId, action, message, "assistant_action", entityId);
}
