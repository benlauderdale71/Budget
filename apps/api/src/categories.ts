import { addMonths, computeBudget, type BudgetResult, type RolloverMode } from "@budgetcents/domain";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, type Actor, assertBudget, audit, loadSpace, lockHousehold, requireMember } from "./finance.js";

export interface CategoryEdit {
  version: number;
  name: string;
  group: string;
  icon: string | null;
  displayOrder: number;
  kind: "income" | "expense";
  flexRole: "fixed" | "non_monthly" | "flexible" | "income" | "reserve";
  envelopeStyle: "regular" | "annual" | "goal" | "debt" | "none";
  rollover: RolloverMode;
  rolloverCapMinor: number | null;
  purpose: string | null;
  archived: boolean;
  hidden?: boolean;
  target: Record<string, unknown> | null;
  effectivePeriod: string;
  recalculate: boolean;
  preview: boolean;
}

export async function saveCategory(db: Database, actor: Actor, householdId: string, bucketId: string, body: CategoryEdit) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  if (!/^\d{4}-\d{2}$/.test(body.effectivePeriod)) throw new ApiError(400, "Choose the month when the rollover change takes effect.");
  if (body.rollover === "capped" && (body.rolloverCapMinor == null || body.rolloverCapMinor < 0)) {
    throw new ApiError(400, "A capped rollover needs a cap of zero or more.");
  }
  return db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const rows = await db.query(`SELECT * FROM buckets WHERE id = $1 AND household_id = $2`, [bucketId, member.householdId]);
    if (!rows.length) throw new ApiError(404, "Not found");
    const row = rows[0];
    if (str(row.system_role)) throw new ApiError(400, "System categories keep the budget balanced and cannot be edited.");
    const loaded = await loadSpace(db, actor, member.householdId, String(row.space_id), `${body.effectivePeriod}-01`, body.effectivePeriod);
    const bucket = loaded.input.buckets.find((item) => item.id === bucketId);
    if (!bucket) throw new ApiError(404, "Not found");
    const currentVersion = bucket.version ?? 1;
    if (body.version !== currentVersion) throw new ApiError(409, "Someone else changed this category. Reload it and try again.");
    const shownRollover = bucket.displayRollover ?? bucket.rollover;
    const shownCap = bucket.displayRollover != null ? bucket.displayRolloverCapMinor ?? null : bucket.rolloverCapMinor ?? null;
    const rolloverChanged = shownRollover !== body.rollover || (shownCap ?? null) !== (body.rolloverCapMinor ?? null);
    const baselineDiffers = bucket.rollover !== body.rollover || (bucket.rolloverCapMinor ?? null) !== (body.rolloverCapMinor ?? null);
    const hasPolicy = (loaded.input.rolloverPolicies ?? []).some((policy) => policy.bucketId === bucketId);
    const rewrite = body.recalculate && (rolloverChanged || baselineDiffers || hasPolicy);
    const before = snapshot(loaded.budget, bucketId, body.effectivePeriod, loaded.input, false, body);
    const proposedPolicies = propose(loaded.input.rolloverPolicies ?? [], bucketId, body, rolloverChanged || rewrite);
    const after = snapshot(loaded.budget, bucketId, body.effectivePeriod, loaded.input, rewrite, body, proposedPolicies);
    const effect = effectText(body, rolloverChanged || rewrite, before, after);
    const impact = {
      effect,
      recalculate: body.recalculate,
      rolloverChanged,
      thisMonth: diff(before.current, after.current, bucketId),
      nextMonth: diff(before.next, after.next, bucketId),
    };
    if (body.preview) {
      return { preview: true, version: currentVersion, bucketId, ...impact };
    }
    const txns = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    const assignments = await db.query(`SELECT count(*) AS n FROM assignments WHERE household_id = $1`, [member.householdId]);
    await db.query(
      `UPDATE buckets SET name = $1, group_name = $2, icon = $3, display_order = $4, kind = $5, flex_role = $6, envelope_style = $7,
        rollover = CASE WHEN $8::int = 1 THEN $9 ELSE rollover END,
        rollover_cap_minor = CASE WHEN $8::int = 1 THEN $10 ELSE rollover_cap_minor END,
        purpose = $11, archived = $12, hidden = $13, target_json = $14
       WHERE id = $15 AND household_id = $16`,
      [
        body.name, body.group, body.icon, body.displayOrder, body.kind, body.flexRole, body.envelopeStyle,
        rewrite ? 1 : 0, body.rollover, body.rolloverCapMinor,
        body.purpose, body.archived ? 1 : 0, body.hidden == null ? num(row.hidden) : body.hidden ? 1 : 0,
        body.target == null ? null : JSON.stringify(body.target), bucketId, member.householdId,
      ],
    );
    if (rewrite) {
      await db.query(`DELETE FROM bucket_policies WHERE bucket_id = $1`, [bucketId]);
    } else if (rolloverChanged) {
      await db.query(
        `INSERT INTO bucket_policies (id, household_id, bucket_id, effective_period, rollover, rollover_cap_minor, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (bucket_id, effective_period) DO UPDATE SET rollover = EXCLUDED.rollover, rollover_cap_minor = EXCLUDED.rollover_cap_minor`,
        [id(), member.householdId, bucketId, body.effectivePeriod, body.rollover, body.rolloverCapMinor, nowIso()],
      );
    }
    const revision = await db.query(
      `INSERT INTO bucket_revisions (bucket_id, household_id, version, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (bucket_id) DO UPDATE SET version = bucket_revisions.version + 1, updated_at = EXCLUDED.updated_at
       WHERE bucket_revisions.version = $5
       RETURNING version`,
      [bucketId, member.householdId, currentVersion + 1, nowIso(), currentVersion],
    );
    if (!revision.length) throw new ApiError(409, "Someone else changed this category. Reload it and try again.");
    const txnsAfter = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    const assignmentsAfter = await db.query(`SELECT count(*) AS n FROM assignments WHERE household_id = $1`, [member.householdId]);
    if (num(txnsAfter[0].n) !== num(txns[0].n) || num(assignmentsAfter[0].n) !== num(assignments[0].n)) {
      throw new ApiError(500, "Editing a category must not create transactions or assignments.");
    }
    await audit(db, member.householdId, actor.id, "bucket.update", `Updated ${body.name}`, "bucket", bucketId);
    return { preview: false, version: num(revision[0].version), bucketId, ...impact };
  });
}

function propose(policies: { bucketId: string; effectivePeriod: string; rollover: RolloverMode; rolloverCapMinor?: number }[], bucketId: string, body: CategoryEdit, rolloverChanged: boolean) {
  if (body.recalculate && rolloverChanged) return policies.filter((policy) => policy.bucketId !== bucketId);
  if (!rolloverChanged) return policies;
  return [
    ...policies.filter((policy) => !(policy.bucketId === bucketId && policy.effectivePeriod === body.effectivePeriod)),
    { bucketId, effectivePeriod: body.effectivePeriod, rollover: body.rollover, rolloverCapMinor: body.rolloverCapMinor ?? undefined },
  ];
}

function snapshot(
  current: BudgetResult,
  bucketId: string,
  period: string,
  input: Parameters<typeof computeBudget>[0],
  replaceBaseline: boolean,
  body: CategoryEdit,
  policies = input.rolloverPolicies,
) {
  const buckets = input.buckets.map((bucket) => (
    replaceBaseline && bucket.id === bucketId
      ? { ...bucket, rollover: body.rollover, rolloverCapMinor: body.rolloverCapMinor ?? undefined }
      : bucket
  ));
  const nextKey = addMonths(`${period}-01`, 1).slice(0, 7);
  if (policies === input.rolloverPolicies && !replaceBaseline) {
    const next = computeBudget({ ...input, viewPeriod: nextKey });
    return { current, next };
  }
  return {
    current: computeBudget({ ...input, buckets, rolloverPolicies: policies, viewPeriod: period }),
    next: computeBudget({ ...input, buckets, rolloverPolicies: policies, viewPeriod: nextKey }),
  };
}

function diff(before: BudgetResult, after: BudgetResult, bucketId: string) {
  const from = before.buckets.find((row) => row.bucketId === bucketId);
  const to = after.buckets.find((row) => row.bucketId === bucketId);
  return {
    readyToAssignMinor: after.readyToAssignMinor,
    readyDeltaMinor: after.readyToAssignMinor - before.readyToAssignMinor,
    availableMinor: to?.availableMinor ?? 0,
    availableDeltaMinor: (to?.availableMinor ?? 0) - (from?.availableMinor ?? 0),
  };
}

function effectText(body: CategoryEdit, rolloverChanged: boolean, before: { current: BudgetResult; next: BudgetResult }, after: { current: BudgetResult; next: BudgetResult }) {
  if (!rolloverChanged) return "The name, target, and other details were saved. No money moved, and the rollover rule is unchanged.";
  if (body.recalculate) {
    return `Earlier months were recalculated with this rollover rule. The Ready to Assign change for ${body.effectivePeriod} is shown with this preview. Transactions and assignments were not rewritten.`;
  }
  return `This rollover rule applies when ${body.effectivePeriod} closes. Earlier months stay as they were. The following month's Ready to Assign change is shown with this preview. This edit does not assign or spend money.`;
}
