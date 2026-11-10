import {
  advanceFillSchedule,
  eligiblePostedIncomeMinor,
  nextFillDate,
  planFill,
  type Cadence,
  type FillPlan,
  type FillPolicy,
  type FillRequest,
} from "@budgetcents/domain";
import { id, localDate, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, type Actor, assertBudget, audit, loadSpace, lockHousehold, requireMember } from "./finance.js";

export type FillCadence = Cadence | "once";

export interface FillLineInput {
  bucketId: string;
  mode: "add" | "top_up" | "shortfall" | "percent";
  amountMinor?: number | null;
  percentBps?: number | null;
  priority: number;
  sourceBucketId?: string | null;
}

export interface FillTemplateInput {
  version?: number;
  spaceId: string;
  name: string;
  cadence: FillCadence;
  customDays?: number | null;
  startDate: string;
  endDate?: string | null;
  paused?: boolean;
  shortfallPolicy: FillPolicy;
  sweepBucketId?: string | null;
  lines: FillLineInput[];
}

const CADENCES = new Set(["once", "weekly", "biweekly", "twice_monthly", "monthly", "every_2_months", "every_3_months", "every_6_months", "annual", "custom"]);

export function fillStatusLabel(status: string): string {
  if (status === "applied") return "Applied";
  if (status === "partial") return "Partially funded";
  if (status === "skipped") return "Skipped";
  if (status === "failed") return "Failed";
  if (status === "claimed") return "Running";
  if (status === "paused") return "Paused";
  if (status === "scheduled") return "Scheduled";
  return "Saved";
}

export interface FillPollRecord {
  at: string;
  applied: number;
  skipped: number;
  failed: number;
  error: string | null;
}

let lastFillPoll: FillPollRecord | null = null;

export function recordFillPoll(result: { applied: number; skipped: number; failed: number } | null, error?: string) {
  lastFillPoll = {
    at: nowIso(),
    applied: result?.applied ?? 0,
    skipped: result?.skipped ?? 0,
    failed: result?.failed ?? 0,
    error: error ?? null,
  };
}

/** What this process will do about due fills. Production can poll here or call the due route from cron. */
export function fillSchedulerStatus() {
  const raw = process.env.BUDGETCENTS_FILL_POLL_MS;
  const base = { lastRun: lastFillPoll };
  if (raw == null || raw.trim() === "" || Number(raw) === 0) {
    return {
      ...base,
      mode: "disabled" as const,
      intervalMs: 0,
      healthy: true,
      note: "Automatic fills are off. Run now still works, and an owner can call POST /api/households/:id/fills/due. Set BUDGETCENTS_FILL_POLL_MS to at least 1000 to poll inside this process.",
    };
  }
  const intervalMs = Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    return {
      ...base,
      mode: "unhealthy" as const,
      intervalMs: Number.isFinite(intervalMs) ? intervalMs : 0,
      healthy: false,
      note: "BUDGETCENTS_FILL_POLL_MS must be at least 1000. Automatic fills were not started.",
    };
  }
  if (lastFillPoll?.error) {
    return { ...base, mode: "unhealthy" as const, intervalMs, healthy: false, note: `The last scheduled pass failed: ${lastFillPoll.error}` };
  }
  return {
    ...base,
    mode: "poll" as const,
    intervalMs,
    healthy: true,
    note: `Automatic fills poll every ${intervalMs} ms in this process. Each occurrence key is unique, so a second worker cannot apply the same date twice.`,
  };
}

export async function listFills(db: Database, actor: Actor, householdId: string) {
  await requireMember(db, actor.id, householdId);
  const templates = await db.query(`SELECT * FROM fill_templates WHERE household_id = $1 AND archived = 0 ORDER BY name`, [householdId]);
  const out = [];
  for (const template of templates) {
    out.push(await presentTemplate(db, template));
  }
  const scheduler = fillSchedulerStatus();
  return { fills: out, scheduler, note: `A fill assigns cash that is already in the budget. It is not a bank transfer, and saving or editing a schedule does not move money. ${scheduler.note}` };
}

export async function saveFillTemplate(db: Database, actor: Actor, householdId: string, templateId: string | null, body: FillTemplateInput) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  validateTemplate(body);
  const zone = await householdZone(db, member.householdId);
  return db.tx(async () => {
    await lockHousehold(db, member.householdId);
    await assertLines(db, actor, member.householdId, body);
    if (!templateId) {
      const idValue = id();
      const stamp = nowIso();
      await db.query(
        `INSERT INTO fill_templates (id, household_id, space_id, name, cadence, custom_days, start_date, end_date, next_date, time_zone, paused, shortfall_policy, sweep_bucket_id, created_by, version, archived, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,0,$15,$15)`,
        [idValue, member.householdId, body.spaceId, body.name, body.cadence, body.customDays ?? null, body.startDate, body.endDate ?? null, body.startDate, zone, body.paused ? 1 : 0, body.shortfallPolicy, body.sweepBucketId ?? null, actor.id, stamp],
      );
      await replaceLines(db, member.householdId, idValue, body.lines);
      await audit(db, member.householdId, actor.id, "fill.save", `Saved fill ${body.name}`, "fill", idValue);
      const row = await mustTemplate(db, member.householdId, idValue);
      return { ...(await presentTemplate(db, row)), created: true };
    }
    const current = await mustTemplate(db, member.householdId, templateId);
    if (num(current.version, 1) !== body.version) throw new ApiError(409, "Someone else changed this fill. Reload it and try again.");
    const applied = await db.query(
      `SELECT id FROM fill_occurrences WHERE template_id = $1 AND status IN ('applied','partial') LIMIT 1`,
      [templateId],
    );
    let nextDate = str(current.next_date) ?? null;
    if (!applied.length) nextDate = body.startDate;
    else if (nextDate && nextDate < body.startDate) nextDate = body.startDate;
    const updated = await db.query(
      `UPDATE fill_templates SET name = $1, cadence = $2, custom_days = $3, start_date = $4, end_date = $5, next_date = $6, paused = $7, shortfall_policy = $8, sweep_bucket_id = $9, version = version + 1, updated_at = $10
       WHERE id = $11 AND household_id = $12 AND version = $13 RETURNING version`,
      [body.name, body.cadence, body.customDays ?? null, body.startDate, body.endDate ?? null, nextDate, body.paused ? 1 : 0, body.shortfallPolicy, body.sweepBucketId ?? null, nowIso(), templateId, member.householdId, body.version],
    );
    if (!updated.length) throw new ApiError(409, "Someone else changed this fill. Reload it and try again.");
    await replaceLines(db, member.householdId, templateId, body.lines);
    await audit(db, member.householdId, actor.id, "fill.save", `Updated fill ${body.name}`, "fill", templateId);
    return presentTemplate(db, await mustTemplate(db, member.householdId, templateId));
  });
}

export async function setFillPaused(db: Database, actor: Actor, householdId: string, templateId: string, paused: boolean, today?: string) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  return db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const template = await mustTemplate(db, member.householdId, templateId);
    if (!paused) {
      const zone = await householdZone(db, member.householdId);
      const skipped = await skipMissed(db, template, today ?? localDate(zone));
      await db.query(`UPDATE fill_templates SET paused = 0, updated_at = $1 WHERE id = $2`, [nowIso(), templateId]);
      await audit(db, member.householdId, actor.id, "fill.resume", `Resumed fill ${template.name}`, "fill", templateId);
      return { ...(await presentTemplate(db, await mustTemplate(db, member.householdId, templateId))), skippedDates: skipped, note: "Missed dates were skipped. No money was allocated for them." };
    }
    await db.query(`UPDATE fill_templates SET paused = 1, updated_at = $1 WHERE id = $2`, [nowIso(), templateId]);
    await audit(db, member.householdId, actor.id, "fill.pause", `Paused fill ${template.name}`, "fill", templateId);
    return { ...(await presentTemplate(db, await mustTemplate(db, member.householdId, templateId))), note: "Paused. Scheduled dates will not run until you resume it." };
  });
}

export async function deleteFill(db: Database, actor: Actor, householdId: string, templateId: string) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  const removed = await db.query(`UPDATE fill_templates SET archived = 1, paused = 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND archived = 0 RETURNING id`, [nowIso(), templateId, member.householdId]);
  if (!removed.length) throw new ApiError(404, "Not found");
  await audit(db, member.householdId, actor.id, "fill.delete", "Deleted a fill schedule", "fill", templateId);
  return { ok: true, note: "The schedule was deleted. Its history is still available and no money was moved." };
}

export async function previewFill(db: Database, actor: Actor, householdId: string, body: FillTemplateInput, today?: string) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  validateTemplate(body);
  await assertLines(db, actor, member.householdId, body);
  const zone = await householdZone(db, member.householdId);
  const date = today ?? localDate(zone);
  const decision = advanceFillSchedule({ nextDate: body.startDate, today: date, cadence: body.cadence, customDays: body.customDays ?? undefined, endDate: body.endDate ?? undefined, anchorDay: Number(body.startDate.slice(8, 10)) });
  const plan = await planFor(db, actor, member.householdId, body, decision.applyDate ?? (body.startDate > date ? null : date));
  return {
    statusLabel: plan ? fillStatusLabel(plan.status) : "Scheduled",
    scheduled: decision.applyDate == null,
    skippedDates: decision.skipped,
    nextDate: decision.nextDate,
    plan,
    policy: body.shortfallPolicy,
    policyText: body.shortfallPolicy === "skip"
      ? "If there is not enough available cash for every envelope, the whole occurrence is skipped."
      : "If cash runs out, envelopes are funded in priority order and the rest is left short.",
    note: "This is a preview. No money has moved.",
  };
}

export async function runFill(db: Database, actor: Actor, householdId: string, templateId: string, today?: string) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  const zone = await householdZone(db, member.householdId);
  const date = today ?? localDate(zone);
  return db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const template = await mustTemplate(db, member.householdId, templateId);
    if (num(template.paused) === 1) throw new ApiError(409, "This fill is paused. Resume it before running it.");
    const skipped = await skipMissed(db, template, date);
    const fresh = await mustTemplate(db, member.householdId, templateId);
    const existing = await db.query(`SELECT * FROM fill_occurrences WHERE household_id = $1 AND occurrence_key = $2`, [member.householdId, `${templateId}:${date}`]);
    if (existing.length && String(existing[0].status) !== "failed" && !(String(existing[0].status) === "skipped" && num(existing[0].allocated_minor) === 0)) {
      return {
        ...resultOf(String(existing[0].status), num(existing[0].allocated_minor), num(existing[0].shortfall_minor), "This occurrence was already recorded. Running it again changed nothing.", str(fresh.next_date) ?? null),
        duplicate: true,
        skippedDates: skipped,
      };
    }
    const next = str(fresh.next_date);
    if (next === date) {
      const result = await executeOccurrence(db, actor, fresh, date, true, true);
      return { ...result, skippedDates: skipped };
    }
    if (next && next > date) {
      const result = await executeOccurrence(db, actor, fresh, date, false, true);
      return { ...result, skippedDates: skipped, note: "Today was run early. The next scheduled date was left in place." };
    }
    return {
      statusLabel: "Skipped",
      duplicate: false,
      allocatedMinor: 0,
      skippedDates: skipped,
      nextDate: next ?? null,
      explanation: skipped.length
        ? "Dates that had already passed were skipped. Nothing was allocated, and today is not a scheduled date."
        : "This fill has no date to run.",
    };
  });
}

export async function skipFill(db: Database, actor: Actor, householdId: string, templateId: string) {
  const member = await requireMember(db, actor.id, householdId);
  assertBudget(member);
  return db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const template = await mustTemplate(db, member.householdId, templateId);
    const date = str(template.next_date);
    if (!date) throw new ApiError(400, "This fill has no upcoming date to skip.");
    const key = `${template.id}:${date}`;
    const inserted = await db.query(
      `INSERT INTO fill_occurrences (id, template_id, household_id, occurrence_key, status, allocated_minor, shortfall_minor, detail_json, created_at, finished_at)
       VALUES ($1,$2,$3,$4,'skipped',0,0,$5,$6,$6)
       ON CONFLICT (household_id, occurrence_key) DO NOTHING RETURNING id`,
      [id(), template.id, template.household_id, key, JSON.stringify({ explanation: "You skipped this date. No money was allocated.", policy: template.shortfall_policy }), nowIso()],
    );
    if (!inserted.length) throw new ApiError(409, "That date was already recorded. It was not run again.");
    await advanceTemplate(db, template, date);
    await audit(db, member.householdId, actor.id, "fill.skip", `Skipped ${template.name} on ${date}`, "fill", String(template.id));
    const saved = await presentTemplate(db, await mustTemplate(db, member.householdId, templateId));
    return { ...saved, statusLabel: "Skipped", date, explanation: "You skipped this date. No money was allocated." };
  });
}

export async function fillHistory(db: Database, actor: Actor, householdId: string, templateId: string) {
  const member = await requireMember(db, actor.id, householdId);
  const owned = await db.query(`SELECT id FROM fill_templates WHERE id = $1 AND household_id = $2`, [templateId, member.householdId]);
  if (!owned.length) throw new ApiError(404, "Not found");
  const rows = await db.query(`SELECT * FROM fill_occurrences WHERE template_id = $1 ORDER BY created_at DESC`, [templateId]);
  return {
    history: rows.map((row) => ({
      id: String(row.id),
      date: String(row.occurrence_key).split(":").slice(1).join(":"),
      status: String(row.status),
      statusLabel: fillStatusLabel(String(row.status)),
      allocatedMinor: num(row.allocated_minor),
      shortfallMinor: num(row.shortfall_minor),
      error: str(row.error) ?? null,
      detail: JSON.parse(String(row.detail_json || "{}")),
      finishedAt: str(row.finished_at) ?? null,
    })),
  };
}

export async function runDueFills(db: Database, options: { today?: string; householdId?: string } = {}) {
  const households = await db.query(
    `SELECT id, time_zone FROM households WHERE ($1::text IS NULL OR id = $1)`,
    [options.householdId ?? null],
  );
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const household of households) {
    const today = options.today ?? localDate(String(household.time_zone || "America/Chicago"));
    const due = await db.query(
      `SELECT * FROM fill_templates WHERE household_id = $1 AND archived = 0 AND paused = 0 AND next_date IS NOT NULL AND next_date <= $2`,
      [household.id, today],
    );
    for (const template of due) {
      const outcome = await db.tx(async () => {
        await lockHousehold(db, String(household.id));
        const fresh = await mustTemplate(db, String(household.id), String(template.id));
        if (num(fresh.paused) === 1 || num(fresh.archived) === 1) return "skipped" as const;
        await skipMissed(db, fresh, today);
        const current = await mustTemplate(db, String(household.id), String(template.id));
        if (str(current.next_date) !== today) return "skipped" as const;
        const actor = await actorFor(db, String(current.created_by));
        if (!actor) {
          await failAndPause(db, current, today, "The person who saved this fill can no longer change the plan. Nothing was allocated.");
          return "failed" as const;
        }
        const result = await executeOccurrence(db, actor, current, today, true, false);
        return result.statusLabel === "Failed" ? "failed" as const : result.allocatedMinor > 0 ? "applied" as const : "skipped" as const;
      });
      if (outcome === "applied") applied += 1;
      else if (outcome === "failed") failed += 1;
      else skipped += 1;
    }
  }
  return { applied, skipped, failed };
}

async function executeOccurrence(db: Database, actor: Actor, template: Record<string, unknown>, date: string, advance: boolean, manual: boolean) {
  const householdId = String(template.household_id);
  const key = `${template.id}:${date}`;
  const claim = await claimOccurrence(db, template, key, manual);
  if (claim.duplicate) return claim.result;
  try {
    const member = await requireMember(db, String(template.created_by), householdId);
    assertBudget(member);
    assertBudget(await requireMember(db, actor.id, householdId));
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "The household or the person who saved this fill is no longer allowed to change the plan.";
    await finish(db, claim.id, "failed", 0, 0, { explanation: message }, message);
    await db.query(`UPDATE fill_templates SET paused = 1, updated_at = $1 WHERE id = $2`, [nowIso(), template.id]);
    return resultOf("failed", 0, 0, message, null);
  }
  const body = await templateInput(db, template);
  let plan: FillPlan;
  try {
    const built = await planFor(db, actor, householdId, body, date);
    if (!built) throw new ApiError(400, "That envelope is no longer available.");
    plan = built;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The fill could not be planned.";
    await finish(db, claim.id, "failed", 0, 0, { explanation: message }, message);
    await db.query(`UPDATE fill_templates SET paused = 1, updated_at = $1 WHERE id = $2`, [nowIso(), template.id]);
    return resultOf("failed", 0, 0, message, null);
  }
  const loaded = await loadSpace(db, actor, householdId, body.spaceId, date, date.slice(0, 7));
  for (const delta of plan.deltas) {
    const bucket = loaded.input.buckets.find((item) => item.id === delta.bucketId);
    if (!bucket || bucket.archived || bucket.systemRole) {
      await finish(db, claim.id, "failed", 0, 0, { explanation: "An envelope in this fill is no longer available. Nothing was allocated." }, "An envelope in this fill is no longer available.");
      await db.query(`UPDATE fill_templates SET paused = 1, updated_at = $1 WHERE id = $2`, [nowIso(), template.id]);
      return resultOf("failed", 0, 0, "An envelope in this fill is no longer available. Nothing was allocated.", null);
    }
  }
  const txnsBefore = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [householdId]);
  for (const delta of plan.deltas) {
    const assigned = loaded.budget.buckets.find((row) => row.bucketId === delta.bucketId)?.assignedMinor ?? 0;
    await setAssignmentAbsolute(db, householdId, body.spaceId, delta.bucketId, date.slice(0, 7), assigned + delta.deltaMinor);
  }
  const txnsAfter = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [householdId]);
  if (num(txnsBefore[0].n) !== num(txnsAfter[0].n)) throw new Error("A fill must not create a bank transaction.");
  const status = plan.status === "applied" ? "applied" : plan.status === "partial" ? "partial" : "skipped";
  await finish(db, claim.id, status, plan.totalAllocatedMinor, plan.shortfallMinor, {
    policy: body.shortfallPolicy,
    explanation: plan.explanation,
    allocations: plan.allocations,
    sweepMinor: plan.sweepMinor,
    readyBeforeMinor: plan.readyBeforeMinor,
    readyAfterMinor: plan.readyAfterMinor,
  }, null);
  if (advance && str(template.next_date) === date) await advanceTemplate(db, template, date);
  await audit(db, householdId, actor.id, "fill.run", `${fillStatusLabel(status)} ${template.name} on ${date}`, "fill", String(template.id));
  const fresh = await mustTemplate(db, householdId, String(template.id));
  return {
    ...resultOf(status, plan.totalAllocatedMinor, plan.shortfallMinor, plan.explanation, str(fresh.next_date) ?? null),
    readyBeforeMinor: plan.readyBeforeMinor,
    readyAfterMinor: plan.readyAfterMinor,
    allocations: plan.allocations,
    duplicate: false,
  };
}

async function claimOccurrence(db: Database, template: Record<string, unknown>, key: string, manual: boolean) {
  const inserted = await db.query(
    `INSERT INTO fill_occurrences (id, template_id, household_id, occurrence_key, status, detail_json, created_at)
     VALUES ($1,$2,$3,$4,'claimed','{}',$5)
     ON CONFLICT (household_id, occurrence_key) DO NOTHING RETURNING id`,
    [id(), template.id, template.household_id, key, nowIso()],
  );
  if (inserted.length) return { id: String(inserted[0].id), duplicate: false as const, result: resultOf("claimed", 0, 0, "", null) };
  const existing = await db.query(`SELECT * FROM fill_occurrences WHERE household_id = $1 AND occurrence_key = $2`, [template.household_id, key]);
  const row = existing[0];
  const status = String(row.status);
  const retryable = status === "failed" || (manual && status === "skipped" && num(row.allocated_minor) === 0);
  if (retryable && (manual || num(row.attempt) < 3)) {
    const claimed = await db.query(
      `UPDATE fill_occurrences SET status = 'claimed', attempt = attempt + 1, error = NULL WHERE id = $1 AND status = $2 RETURNING id`,
      [row.id, status],
    );
    if (claimed.length) return { id: String(row.id), duplicate: false as const, result: resultOf("claimed", 0, 0, "", null) };
  }
  return {
    id: String(row.id),
    duplicate: true as const,
    result: { ...resultOf(status, num(row.allocated_minor), num(row.shortfall_minor), "This occurrence was already recorded. Running it again changed nothing.", null), duplicate: true },
  };
}

async function finish(db: Database, occurrenceId: string, status: string, allocated: number, shortfall: number, detail: unknown, error: string | null) {
  await db.query(
    `UPDATE fill_occurrences SET status = $1, allocated_minor = $2, shortfall_minor = $3, detail_json = $4, error = $5, finished_at = $6 WHERE id = $7`,
    [status, allocated, shortfall, JSON.stringify(detail), error, nowIso(), occurrenceId],
  );
}

async function skipMissed(db: Database, template: Record<string, unknown>, today: string) {
  const next = str(template.next_date);
  if (!next || next >= today) return [] as string[];
  const decision = advanceFillSchedule({
    nextDate: next,
    today,
    cadence: String(template.cadence) as FillCadence,
    customDays: template.custom_days == null ? undefined : num(template.custom_days),
    endDate: str(template.end_date),
    anchorDay: Number(String(template.start_date).slice(8, 10)),
  });
  for (const date of decision.skipped) {
    await db.query(
      `INSERT INTO fill_occurrences (id, template_id, household_id, occurrence_key, status, allocated_minor, shortfall_minor, detail_json, created_at, finished_at)
       VALUES ($1,$2,$3,$4,'skipped',0,0,$5,$6,$6)
       ON CONFLICT (household_id, occurrence_key) DO NOTHING`,
      [id(), template.id, template.household_id, `${template.id}:${date}`, JSON.stringify({ explanation: "This date passed before it ran. It was skipped, and no money was allocated.", policy: template.shortfall_policy }), nowIso()],
    );
  }
  await db.query(`UPDATE fill_templates SET next_date = $1, updated_at = $2 WHERE id = $3`, [decision.applyDate ?? decision.nextDate, nowIso(), template.id]);
  if (decision.skipped.length >= 36 && decision.nextDate && decision.nextDate < today) {
    await db.query(`UPDATE fill_templates SET paused = 1, updated_at = $1 WHERE id = $2`, [nowIso(), template.id]);
    await audit(db, String(template.household_id), null, "fill.pause", "Paused a fill that was more than 36 dates behind. No money was allocated.", "fill", String(template.id));
  }
  return decision.skipped;
}

async function advanceTemplate(db: Database, template: Record<string, unknown>, date: string) {
  const cadence = String(template.cadence) as FillCadence;
  if (cadence === "once") {
    await db.query(`UPDATE fill_templates SET next_date = NULL, updated_at = $1 WHERE id = $2`, [nowIso(), template.id]);
    return;
  }
  const following = nextFillDate(date, cadence, template.custom_days == null ? undefined : num(template.custom_days), Number(String(template.start_date).slice(8, 10)));
  const end = str(template.end_date);
  await db.query(`UPDATE fill_templates SET next_date = $1, updated_at = $2 WHERE id = $3`, [end && following > end ? null : following, nowIso(), template.id]);
}

async function planFor(db: Database, actor: Actor, householdId: string, body: FillTemplateInput, date: string | null): Promise<FillPlan | null> {
  if (!date) return null;
  const loaded = await loadSpace(db, actor, householdId, body.spaceId, date, date.slice(0, 7));
  const states = [];
  for (const line of body.lines) {
    const bucket = loaded.input.buckets.find((item) => item.id === line.bucketId);
    if (!bucket || bucket.archived || bucket.systemRole) throw new ApiError(400, "That envelope is no longer available.");
    if (line.sourceBucketId) {
      const source = loaded.input.buckets.find((item) => item.id === line.sourceBucketId);
      if (!source || source.archived || source.systemRole) throw new ApiError(400, "The envelope funding this fill is no longer available.");
    }
  }
  if (body.sweepBucketId) {
    const sweep = loaded.input.buckets.find((item) => item.id === body.sweepBucketId);
    if (!sweep || sweep.archived || sweep.systemRole) throw new ApiError(400, "The sweep envelope is no longer available.");
  }
  const eligible = eligiblePostedIncomeMinor({
    transactions: loaded.input.transactions,
    accounts: loaded.input.accounts,
    currency: loaded.input.currency,
    from: loaded.budget.periodStart,
    to: loaded.budget.periodEnd,
  });
  for (const bucket of loaded.input.buckets) {
    const month = loaded.budget.buckets.find((row) => row.bucketId === bucket.id);
    states.push({ bucketId: bucket.id, availableMinor: month?.availableMinor ?? 0, assignedMinor: month?.assignedMinor ?? 0, target: bucket.target, monthsRemaining: 1 });
  }
  return planFill({
    readyToAssignMinor: loaded.budget.readyToAssignMinor,
    buckets: states,
    lines: body.lines.map(toRequest),
    eligibleIncomeMinor: eligible,
    policy: body.shortfallPolicy,
    sweepBucketId: body.sweepBucketId,
  });
}

function toRequest(line: FillLineInput): FillRequest {
  return { bucketId: line.bucketId, mode: line.mode, amountMinor: line.amountMinor ?? undefined, percentBps: line.percentBps ?? undefined, priority: line.priority, sourceBucketId: line.sourceBucketId };
}

async function templateInput(db: Database, template: Record<string, unknown>): Promise<FillTemplateInput> {
  const lines = await db.query(`SELECT * FROM fill_lines WHERE template_id = $1 ORDER BY priority, id`, [template.id]);
  return {
    spaceId: String(template.space_id),
    name: String(template.name),
    cadence: String(template.cadence) as FillCadence,
    customDays: template.custom_days == null ? null : num(template.custom_days),
    startDate: String(template.start_date),
    endDate: str(template.end_date) ?? null,
    paused: num(template.paused) === 1,
    shortfallPolicy: String(template.shortfall_policy) as FillPolicy,
    sweepBucketId: str(template.sweep_bucket_id) ?? null,
    lines: lines.map((line) => ({
      bucketId: String(line.bucket_id),
      mode: String(line.mode) as FillLineInput["mode"],
      amountMinor: line.amount_minor == null ? null : num(line.amount_minor),
      percentBps: line.percent_bps == null ? null : num(line.percent_bps),
      priority: num(line.priority),
      sourceBucketId: str(line.source_bucket_id) ?? null,
    })),
  };
}

async function presentTemplate(db: Database, template: Record<string, unknown>) {
  const input = await templateInput(db, template);
  const last = await db.query(`SELECT status, allocated_minor, shortfall_minor, error, occurrence_key, finished_at FROM fill_occurrences WHERE template_id = $1 ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [template.id]);
  const paused = num(template.paused) === 1;
  const next = str(template.next_date) ?? null;
  return {
    id: String(template.id),
    ...input,
    version: num(template.version, 1),
    nextDate: next,
    timeZone: String(template.time_zone),
    statusLabel: paused ? "Paused" : next ? "Scheduled" : "Saved",
    lastOutcome: last.length
      ? { statusLabel: fillStatusLabel(String(last[0].status)), allocatedMinor: num(last[0].allocated_minor), shortfallMinor: num(last[0].shortfall_minor), error: str(last[0].error) ?? null, date: String(last[0].occurrence_key).split(":").slice(1).join(":") }
      : null,
  };
}

async function replaceLines(db: Database, householdId: string, templateId: string, lines: FillLineInput[]) {
  await db.query(`DELETE FROM fill_lines WHERE template_id = $1`, [templateId]);
  for (const line of lines) {
    await db.query(
      `INSERT INTO fill_lines (id, template_id, household_id, bucket_id, mode, amount_minor, percent_bps, priority, source_bucket_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id(), templateId, householdId, line.bucketId, line.mode, line.amountMinor ?? null, line.percentBps ?? null, line.priority, line.sourceBucketId ?? null],
    );
  }
}

async function assertLines(db: Database, actor: Actor, householdId: string, body: FillTemplateInput) {
  const loaded = await loadSpace(db, actor, householdId, body.spaceId);
  const known = new Map(loaded.input.buckets.map((bucket) => [bucket.id, bucket]));
  const ids = new Set<string>();
  for (const line of body.lines) {
    const bucket = known.get(line.bucketId);
    if (!bucket || bucket.archived || bucket.systemRole) throw new ApiError(400, "Choose an envelope that is still in this plan.");
    ids.add(line.bucketId);
    if (line.sourceBucketId) {
      const source = known.get(line.sourceBucketId);
      if (!source || source.archived || source.systemRole) throw new ApiError(400, "Choose an available envelope to move money from.");
      if (line.sourceBucketId === line.bucketId) throw new ApiError(400, "A fill cannot take money from the envelope it is funding.");
    }
  }
  if (body.sweepBucketId && (!known.get(body.sweepBucketId) || known.get(body.sweepBucketId)?.systemRole)) {
    throw new ApiError(400, "Choose an envelope for the leftover cash.");
  }
}

function validateTemplate(body: FillTemplateInput) {
  if (!CADENCES.has(body.cadence)) throw new ApiError(400, "Choose a schedule: once, weekly, biweekly, twice monthly, monthly, annual, or a custom number of days.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) throw new ApiError(400, "Enter a start date.");
  if (body.endDate && body.endDate < body.startDate) throw new ApiError(400, "The end date has to be on or after the start date.");
  if (body.cadence === "custom" && (!body.customDays || body.customDays < 1 || body.customDays > 366)) throw new ApiError(400, "A custom schedule needs a number of days from 1 to 366.");
  if (!body.lines.length) throw new ApiError(400, "Add at least one envelope.");
  for (const line of body.lines) {
    if (!["add", "top_up", "shortfall", "percent"].includes(line.mode)) throw new ApiError(400, "Choose what each envelope should receive.");
    if ((line.mode === "add" || line.mode === "top_up") && (line.amountMinor == null || line.amountMinor < 0)) throw new ApiError(400, "Enter an amount of zero or more.");
    if (line.mode === "percent" && (line.percentBps == null || line.percentBps < 0 || line.percentBps > 10_000)) throw new ApiError(400, "Enter a percent from 0 to 100.");
  }
}

async function mustTemplate(db: Database, householdId: string, templateId: string) {
  const rows = await db.query(`SELECT * FROM fill_templates WHERE id = $1 AND household_id = $2 AND archived = 0`, [templateId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  return rows[0];
}

async function householdZone(db: Database, householdId: string) {
  const rows = await db.query(`SELECT time_zone FROM households WHERE id = $1`, [householdId]);
  return String(rows[0]?.time_zone || "America/Chicago");
}

async function actorFor(db: Database, userId: string): Promise<Actor | null> {
  const rows = await db.query(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    privacyMode: num(row.privacy_mode) === 1,
    aiEnabled: num(row.ai_enabled) === 1,
    locale: String(row.locale),
    timeZone: String(row.time_zone),
    theme: String(row.theme),
    weekStart: num(row.week_start),
  };
}

async function failAndPause(db: Database, template: Record<string, unknown>, date: string, message: string) {
  await db.query(
    `INSERT INTO fill_occurrences (id, template_id, household_id, occurrence_key, status, detail_json, error, created_at, finished_at)
     VALUES ($1,$2,$3,$4,'failed',$5,$6,$7,$7)
     ON CONFLICT (household_id, occurrence_key) DO NOTHING`,
    [id(), template.id, template.household_id, `${template.id}:${date}`, JSON.stringify({ explanation: message }), message, nowIso()],
  );
  await db.query(`UPDATE fill_templates SET paused = 1, updated_at = $1 WHERE id = $2`, [nowIso(), template.id]);
}

async function setAssignmentAbsolute(db: Database, householdId: string, spaceId: string, bucketId: string, periodKey: string, amountMinor: number) {
  await db.query(
    `INSERT INTO assignments (id, household_id, space_id, bucket_id, period_key, amount_minor)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (space_id, bucket_id, period_key) DO UPDATE SET amount_minor = EXCLUDED.amount_minor`,
    [id(), householdId, spaceId, bucketId, periodKey, amountMinor],
  );
}

function resultOf(status: string, allocatedMinor: number, shortfallMinor: number, explanation: string, nextDate: string | null) {
  return { statusLabel: fillStatusLabel(status), status, allocatedMinor, shortfallMinor, explanation, nextDate, duplicate: false };
}
