import { addMonths, nextDateForCadence, type Cadence } from "./dates.js";
import { isOnBudgetCash, neededForTarget } from "./budget.js";
import { percentTargetMinor, PERCENT_PRECISION } from "./percent.js";
import type { Account, Bucket, Target, Transaction } from "./types.js";

export { PERCENT_PRECISION };

const INELIGIBLE = "Eligible income is posted income on an on-budget account. Expected pay, transfers, refunds, reimbursements, loan proceeds, opening balances, and unrealized gains are not included.";

export function eligiblePostedIncomeMinor(input: {
  transactions: Transaction[];
  accounts: Account[];
  currency: string;
  from: string;
  to: string;
}): number {
  let total = 0;
  for (const txn of input.transactions) {
    if (txn.deleted || txn.bankStatus !== "posted" || txn.excludeFromReports) continue;
    if (txn.currency !== input.currency || txn.date < input.from || txn.date > input.to) continue;
    if (txn.type !== "income") continue;
    const account = input.accounts.find((item) => item.id === txn.accountId);
    if (!account || account.currency !== input.currency || !isOnBudgetCash(account)) continue;
    total += Math.abs(txn.amountMinor);
  }
  return total;
}

export function targetAmountMinor(target: Target | undefined, eligibleIncomeMinor: number): number {
  if (!target || target.pausedUntil) return 0;
  if (target.percentBps == null) return target.amountMinor;
  return percentTargetMinor(eligibleIncomeMinor, target.percentBps);
}

export interface TargetProgress {
  bucketId: string;
  eligiblePostedIncomeMinor: number;
  percentBps: number | null;
  percentLabel: string | null;
  targetMinor: number;
  fundedMinor: number;
  shortfallMinor: number;
  paused: boolean;
  formula: string;
}

export function targetProgress(bucket: Bucket, availableMinor: number, assignedMinor: number, eligibleIncomeMinor: number, monthsRemaining = 1): TargetProgress {
  const target = bucket.target;
  const paused = !!target?.pausedUntil;
  const targetMinor = targetAmountMinor(target, eligibleIncomeMinor);
  const fundedMinor = target?.type === "set_aside" || target?.percentBps != null ? assignedMinor : availableMinor;
  const shortfallMinor = neededForTarget(bucket, availableMinor, assignedMinor, monthsRemaining, eligibleIncomeMinor);
  return {
    bucketId: bucket.id,
    eligiblePostedIncomeMinor: eligibleIncomeMinor,
    percentBps: target?.percentBps ?? null,
    percentLabel: target?.percentBps == null ? null : `${(target.percentBps / 100).toFixed(2)}%`,
    targetMinor,
    fundedMinor,
    shortfallMinor,
    paused,
    formula: `${INELIGIBLE} ${PERCENT_PRECISION}`,
  };
}

export type FillMode = "add" | "top_up" | "shortfall" | "percent";
export type FillPolicy = "skip" | "partial";

export interface FillRequest {
  bucketId: string;
  mode: FillMode;
  amountMinor?: number;
  percentBps?: number;
  priority: number;
  sourceBucketId?: string | null;
}

export interface FillBucketState {
  bucketId: string;
  availableMinor: number;
  assignedMinor: number;
  target?: Target;
  monthsRemaining?: number;
}

export interface FillAllocation {
  bucketId: string;
  sourceBucketId: string | null;
  requestedMinor: number;
  allocatedMinor: number;
}

export interface FillPlan {
  status: "applied" | "partial" | "skipped";
  allocations: FillAllocation[];
  sweepMinor: number;
  sweepBucketId?: string;
  totalAllocatedMinor: number;
  shortfallMinor: number;
  readyBeforeMinor: number;
  readyAfterMinor: number;
  deltas: { bucketId: string; deltaMinor: number }[];
  explanation: string;
}

function requestedAmount(line: FillRequest, state: FillBucketState, eligibleIncomeMinor: number, assignedNow: number, availableNow: number): number {
  if (line.mode === "add") return Math.max(0, line.amountMinor ?? 0);
  if (line.mode === "top_up") return Math.max(0, (line.amountMinor ?? 0) - availableNow);
  if (line.mode === "percent") {
    const target = percentTargetMinor(eligibleIncomeMinor, line.percentBps ?? 0);
    return Math.max(0, target - assignedNow);
  }
  const bucket: Bucket = {
    id: state.bucketId,
    name: state.bucketId,
    group: "",
    kind: "expense",
    flexRole: "flexible",
    envelopeStyle: "regular",
    rollover: "both",
    target: state.target,
  };
  return neededForTarget(bucket, availableNow, assignedNow, state.monthsRemaining ?? 1, eligibleIncomeMinor);
}

/** Allocate cash that is already in the plan. This does not create a bank transaction. */
export function planFill(input: {
  readyToAssignMinor: number;
  buckets: FillBucketState[];
  lines: FillRequest[];
  eligibleIncomeMinor: number;
  policy: FillPolicy;
  sweepBucketId?: string | null;
}): FillPlan {
  const readyStart = input.readyToAssignMinor;
  const available = new Map(input.buckets.map((bucket) => [bucket.bucketId, bucket.availableMinor]));
  const assigned = new Map(input.buckets.map((bucket) => [bucket.bucketId, bucket.assignedMinor]));
  const states = new Map(input.buckets.map((bucket) => [bucket.bucketId, bucket]));
  const ordered = [...input.lines].sort((a, b) => a.priority - b.priority || a.bucketId.localeCompare(b.bucketId));
  const draft: FillAllocation[] = [];
  let ready = readyStart;
  let blocked = false;
  for (const line of ordered) {
    if (line.sourceBucketId && line.sourceBucketId === line.bucketId) throw new Error("A fill cannot take money from the envelope it is funding.");
    const state = states.get(line.bucketId);
    if (!state) throw new Error("That envelope is not in this plan.");
    const request = requestedAmount(line, state, input.eligibleIncomeMinor, assigned.get(line.bucketId) ?? 0, available.get(line.bucketId) ?? 0);
    const source = line.sourceBucketId ?? null;
    const have = Math.max(0, source ? available.get(source) ?? 0 : ready);
    const give = Math.min(have, request);
    if (give < request) blocked = true;
    if (input.policy === "skip" && blocked) {
      draft.push({ bucketId: line.bucketId, sourceBucketId: source, requestedMinor: request, allocatedMinor: 0 });
      continue;
    }
    const allocated = input.policy === "skip" ? request : give;
    if (allocated > 0) {
      if (source) available.set(source, (available.get(source) ?? 0) - allocated);
      else ready -= allocated;
      available.set(line.bucketId, (available.get(line.bucketId) ?? 0) + allocated);
      assigned.set(line.bucketId, (assigned.get(line.bucketId) ?? 0) + allocated);
    }
    draft.push({ bucketId: line.bucketId, sourceBucketId: source, requestedMinor: request, allocatedMinor: allocated });
  }
  if (input.policy === "skip" && blocked) {
    const requested = draft.reduce((sum, line) => sum + line.requestedMinor, 0);
    return finish({
      status: "skipped",
      allocations: draft.map((line) => ({ ...line, allocatedMinor: 0 })),
      sweepMinor: 0,
      totalAllocatedMinor: 0,
      shortfallMinor: requested,
      readyBeforeMinor: readyStart,
      readyAfterMinor: readyStart,
      deltas: [],
      explanation: "This occurrence was skipped. There was not enough available cash to fund every envelope, and the policy is to skip rather than fund part of the plan.",
    });
  }
  const allocations = input.policy === "skip" ? draft.map((line) => ({ ...line, allocatedMinor: line.requestedMinor })) : draft;
  if (input.policy === "skip") {
    ready = readyStart;
    for (const line of allocations) {
      if (line.sourceBucketId) continue;
      ready -= line.allocatedMinor;
    }
  }
  let sweepMinor = 0;
  const fullyFunded = allocations.every((line) => line.allocatedMinor === line.requestedMinor);
  if (fullyFunded && input.sweepBucketId && ready > 0) {
    sweepMinor = ready;
    ready = 0;
  }
  const shortfall = allocations.reduce((sum, line) => sum + (line.requestedMinor - line.allocatedMinor), 0);
  const total = allocations.reduce((sum, line) => sum + line.allocatedMinor, 0) + sweepMinor;
  const status = total === 0 && (shortfall > 0 || allocations.some((line) => line.requestedMinor > 0))
    ? "skipped"
    : shortfall > 0
      ? "partial"
      : "applied";
  const deltas = new Map<string, number>();
  const addDelta = (bucketId: string, delta: number) => deltas.set(bucketId, (deltas.get(bucketId) ?? 0) + delta);
  for (const line of allocations) {
    if (line.allocatedMinor === 0) continue;
    addDelta(line.bucketId, line.allocatedMinor);
    if (line.sourceBucketId) addDelta(line.sourceBucketId, -line.allocatedMinor);
  }
  if (sweepMinor && input.sweepBucketId) addDelta(input.sweepBucketId, sweepMinor);
  const nothingDue = allocations.every((line) => line.requestedMinor === 0) && sweepMinor === 0;
  const explanation = status === "skipped"
    ? "Nothing was allocated. Ready to Assign was left unchanged."
    : status === "partial"
      ? "Envelopes were funded in priority order until the available cash ran out. The rest of the plan stayed unfunded."
      : nothingDue
        ? "Nothing was due, so no money moved."
        : sweepMinor
          ? "The plan was funded, and the remaining Ready to Assign was swept into the selected envelope."
          : "The plan was funded from cash that was already available. No bank transaction was created.";
  return finish({
    status,
    allocations,
    sweepMinor,
    sweepBucketId: sweepMinor ? input.sweepBucketId ?? undefined : undefined,
    totalAllocatedMinor: total,
    shortfallMinor: shortfall,
    readyBeforeMinor: readyStart,
    readyAfterMinor: ready,
    deltas: [...deltas.entries()].filter(([, delta]) => delta !== 0).map(([bucketId, deltaMinor]) => ({ bucketId, deltaMinor })),
    explanation,
  });
}

function finish(plan: FillPlan): FillPlan {
  return plan;
}

export interface ScheduleAdvance {
  applyDate: string | null;
  skipped: string[];
  nextDate: string | null;
}

/** Monthly dates keep the start day's number and use the last day of a short month. */
export function nextFillDate(current: string, cadence: Cadence | "once", customDays?: number, anchorDay?: number): string {
  const months = cadence === "monthly" ? 1 : cadence === "every_2_months" ? 2 : cadence === "every_3_months" ? 3 : cadence === "every_6_months" ? 6 : cadence === "annual" ? 12 : 0;
  if (months && anchorDay && anchorDay >= 1 && anchorDay <= 31) {
    const first = addMonths(`${current.slice(0, 7)}-01`, months);
    const year = Number(first.slice(0, 4));
    const month = Number(first.slice(5, 7));
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${first.slice(0, 8)}${String(Math.min(anchorDay, last)).padStart(2, "0")}`;
  }
  if (cadence === "once") return current;
  return nextDateForCadence(current, cadence, customDays);
}

/** Missed dates are listed and not funded. At most today's date is applied. */
export function advanceFillSchedule(input: {
  nextDate: string;
  today: string;
  cadence: Cadence | "once";
  customDays?: number;
  endDate?: string;
  anchorDay?: number;
}): ScheduleAdvance {
  const skipped: string[] = [];
  let cursor = input.nextDate;
  let guard = 0;
  while (cursor < input.today && guard < 36) {
    skipped.push(cursor);
    if (input.cadence === "once") return { applyDate: null, skipped, nextDate: null };
    cursor = nextFillDate(cursor, input.cadence, input.customDays, input.anchorDay);
    guard += 1;
  }
  if (input.endDate && cursor > input.endDate) return { applyDate: null, skipped, nextDate: null };
  if (cursor !== input.today) return { applyDate: null, skipped, nextDate: cursor };
  if (input.cadence === "once") return { applyDate: cursor, skipped, nextDate: null };
  const following = nextFillDate(cursor, input.cadence, input.customDays, input.anchorDay);
  return { applyDate: cursor, skipped, nextDate: input.endDate && following > input.endDate ? null : following };
}
