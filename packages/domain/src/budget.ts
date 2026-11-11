import { enumerateMonths, periodFromDate } from "./dates.js";
import { assertMinor, type ExplainedNumber } from "./money.js";
import { percentTargetMinor } from "./percent.js";
import {
  IDENTITY_FORMULA,
  type Account,
  type Assignment,
  type Bucket,
  type BucketMonth,
  type BudgetResult,
  type EngineInput,
  type PlanLine,
  type RolloverPolicy,
  type Split,
  type Transaction,
} from "./types.js";

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

const CASH_KINDS = new Set(["checking", "savings", "cash"]);
const LIABILITY_KINDS = new Set([
  "credit",
  "loan",
  "student_loan",
  "mortgage",
  "other_liability",
]);

export function isLiability(account: Account): boolean {
  return LIABILITY_KINDS.has(account.kind);
}

export function isOnBudgetCash(account: Account): boolean {
  return account.onBudget && CASH_KINDS.has(account.kind);
}

export function isCredit(account: Account): boolean {
  return account.kind === "credit";
}

function isInflowRole(role: Split["role"]): boolean {
  return role === "income" || role === "refund";
}

export function splitNetOutflow(txn: Transaction): number {
  return txn.splits.reduce((sum, split) => {
    assertMinor(split.amountMinor, "split");
    if (split.amountMinor < 0) throw new BudgetError("Split amounts are positive magnitudes");
    return sum + (isInflowRole(split.role) ? -split.amountMinor : split.amountMinor);
  }, 0);
}

export function validateTransaction(txn: Transaction, accounts: Account[], currency: string): void {
  if (txn.deleted) return;
  assertMinor(txn.amountMinor, `transaction ${txn.id}`);
  const account = accounts.find((a) => a.id === txn.accountId);
  if (!account) throw new BudgetError(`Unknown account ${txn.accountId}`);
  if (txn.currency !== account.currency && !txn.fx) {
    throw new BudgetError(`Transaction ${txn.id} currency ${txn.currency} does not match account ${account.currency}`);
  }
  if (txn.counterAccountId && !accounts.some((a) => a.id === txn.counterAccountId)) {
    throw new BudgetError(`Unknown counter account ${txn.counterAccountId}`);
  }
  const magnitude = Math.abs(txn.amountMinor);
  const structural = new Set(["transfer", "cc_payment", "opening", "reconciliation", "loan_proceeds", "buy", "sell", "dividend"]);
  if (txn.type === "loan_payment" && isLiability(account) && !isOnBudgetCash(account)) {
    if (txn.amountMinor < 0) {
      throw new BudgetError("A principal reduction on the loan is a positive amount, which lowers the balance owed.");
    }
    if (txn.splits.length) {
      const sum = txn.splits.reduce((sum, split) => sum + split.amountMinor, 0);
      if (sum !== txn.amountMinor) {
        throw new BudgetError(`Principal reduction splits sum to ${sum} but the amount is ${txn.amountMinor}`);
      }
      if (txn.splits.some((split) => split.role !== "principal")) {
        throw new BudgetError("Interest and fees belong on the cash payment, not on the principal reduction.");
      }
    }
  } else if (txn.splits.length > 0 && structural.has(txn.type)) {
    const sum = txn.splits.reduce((s, split) => s + split.amountMinor, 0);
    if (sum !== magnitude) {
      throw new BudgetError(`Splits for ${txn.id} sum to ${sum} but the transaction magnitude is ${magnitude}`);
    }
  } else if (txn.splits.length > 0) {
    const netOut = splitNetOutflow(txn);
    if (netOut !== -txn.amountMinor) {
      throw new BudgetError(
        `Splits for ${txn.id} net to ${netOut} outflow, but the signed amount ${txn.amountMinor} requires ${-txn.amountMinor}`,
      );
    }
  }
  if ((txn.type === "transfer" || txn.type === "cc_payment" || txn.type === "loan_proceeds") && !txn.counterAccountId) {
    throw new BudgetError(`${txn.type} requires a counter account`);
  }
  void currency;
}

export function signedForAccount(accountId: string, txn: Transaction): number | null {
  if (txn.deleted) return null;
  if (txn.accountId === accountId) return txn.amountMinor;
  if (txn.counterAccountId === accountId) return -txn.amountMinor;
  return null;
}

export function displayBalance(
  account: Account,
  transactions: Transaction[],
  asOf: string,
  includePending = false,
): number {
  let signed = 0;
  for (const txn of transactions) {
    if (!countsInBalance(txn, asOf, includePending)) continue;
    const leg = signedForAccount(account.id, txn);
    if (leg == null) continue;
    if (txn.currency !== account.currency) continue;
    signed += leg;
  }
  return isLiability(account) ? -signed : signed;
}

function countsInBalance(txn: Transaction, asOf: string, includePending: boolean): boolean {
  if (txn.deleted) return false;
  if (txn.date > asOf) return false;
  if (txn.bankStatus === "pending" && !includePending) return false;
  return true;
}

function splitsOrDefault(txn: Transaction): Split[] {
  if (txn.splits.length > 0) return txn.splits;
  const magnitude = Math.abs(txn.amountMinor);
  if (magnitude === 0) return [];
  if (txn.type === "income" || txn.type === "dividend") {
    return [{ bucketId: null, amountMinor: magnitude, role: "income" }];
  }
  if (txn.type === "refund" || txn.type === "reimbursement") {
    return [{ bucketId: null, amountMinor: magnitude, role: "refund" }];
  }
  if (txn.type === "expense" || txn.type === "fee" || txn.type === "interest") {
    return [{ bucketId: null, amountMinor: magnitude, role: txn.type === "expense" ? "expense" : txn.type }];
  }
  return [{ bucketId: null, amountMinor: magnitude, role: "transfer" }];
}

interface WalkState {
  rta: number;
  available: Map<string, number>;
  /** Credit overspend created in the current period, by bucket. */
  creditOverspend: Map<string, number>;
  income: number;
  spending: number;
  refunds: number;
  transfers: number;
  warnings: string[];
}

function emptyState(): WalkState {
  return {
    rta: 0,
    available: new Map(),
    creditOverspend: new Map(),
    income: 0,
    spending: 0,
    refunds: 0,
    transfers: 0,
    warnings: [],
  };
}

function avail(state: WalkState, id: string): number {
  return state.available.get(id) ?? 0;
}

function addAvail(state: WalkState, id: string, delta: number): void {
  state.available.set(id, avail(state, id) + delta);
}

function reduceCashClaim(state: WalkState, bucketId: string | null, amount: number): void {
  if (amount === 0) return;
  if (bucketId) addAvail(state, bucketId, -amount);
  else state.rta -= amount;
}

function ccReserveId(buckets: Bucket[], cardId: string): string {
  const found = buckets.find((b) => b.systemRole === "cc_reserve" && b.linkedAccountId === cardId);
  if (!found) {
    throw new BudgetError(`Credit account ${cardId} needs a card-payment reserve bucket before card activity can be budgeted.`);
  }
  return found.id;
}

function borrowedId(buckets: Bucket[]): string {
  const found = buckets.find((b) => b.systemRole === "borrowed_funds");
  if (!found) throw new BudgetError("Household is missing the borrowed-funds parking bucket.");
  return found.id;
}

function rolloverForPeriod(bucket: Bucket, periodKey: string, policies: RolloverPolicy[] | undefined): Bucket {
  const chosen = (policies ?? [])
    .filter((policy) => policy.bucketId === bucket.id && policy.effectivePeriod <= periodKey)
    .sort((a, b) => (a.effectivePeriod < b.effectivePeriod ? 1 : -1))[0];
  if (!chosen) return bucket;
  return { ...bucket, rollover: chosen.rollover, rolloverCapMinor: chosen.rolloverCapMinor };
}

function applyRollover(amount: number, bucket: Bucket): { keep: number; release: number } {
  const mode = bucket.rollover;
  if (mode === "both") return { keep: amount, release: 0 };
  if (mode === "none") return { keep: 0, release: amount };
  if (mode === "positive") {
    if (amount > 0) return { keep: amount, release: 0 };
    return { keep: 0, release: amount };
  }
  if (mode === "negative") {
    if (amount < 0) return { keep: amount, release: 0 };
    return { keep: 0, release: amount };
  }
  const cap = bucket.rolloverCapMinor ?? 0;
  if (amount <= 0) return { keep: amount, release: 0 };
  const keep = Math.min(amount, cap);
  return { keep, release: amount - keep };
}

function applyTransaction(
  state: WalkState,
  txn: Transaction,
  accounts: Account[],
  buckets: Bucket[],
  currency: string,
  activity: Map<string, { inn: number; out: number }>,
): void {
  if (txn.currency !== currency) return;
  const primary = accounts.find((a) => a.id === txn.accountId);
  if (!primary) return;
  const counter = txn.counterAccountId ? accounts.find((a) => a.id === txn.counterAccountId) : undefined;
  const magnitude = Math.abs(txn.amountMinor);
  const touch = (bucketId: string, field: "inn" | "out", amount: number) => {
    const row = activity.get(bucketId) ?? { inn: 0, out: 0 };
    row[field] += amount;
    activity.set(bucketId, row);
  };

  if (txn.type === "opening") {
    if (isOnBudgetCash(primary) && txn.amountMinor > 0) state.rta += txn.amountMinor;
    return;
  }

  if (txn.type === "reconciliation") {
    if (isOnBudgetCash(primary)) state.rta += txn.amountMinor;
    return;
  }

  if (txn.type === "transfer" || txn.type === "loan_proceeds") {
    state.transfers += magnitude;
    const primaryCash = isOnBudgetCash(primary);
    const counterCash = counter ? isOnBudgetCash(counter) : false;
    if (primaryCash && counterCash) return;
    // Cash entering or leaving the budget on the on-budget leg.
    const legs: { account: Account; signed: number }[] = [{ account: primary, signed: txn.amountMinor }];
    if (counter) legs.push({ account: counter, signed: -txn.amountMinor });
    for (const leg of legs) {
      if (!isOnBudgetCash(leg.account)) continue;
      const other = legs.find((l) => l.account.id !== leg.account.id)?.account;
      const otherCash = other ? isOnBudgetCash(other) : false;
      if (otherCash) continue;
      if (leg.signed > 0) {
        const fromLiability = other ? isLiability(other) : txn.type === "loan_proceeds";
        if (fromLiability || txn.type === "loan_proceeds") {
          addAvail(state, borrowedId(buckets), leg.signed);
          state.warnings.push("Loan proceeds were parked in Borrowed funds and were not treated as income.");
        } else {
          state.rta += leg.signed;
          state.warnings.push("A transfer back into budget cash increased Ready to Assign. It was not counted as income.");
        }
      } else if (leg.signed < 0) {
        const bucketId = txn.splits.find((s) => s.bucketId)?.bucketId ?? null;
        reduceCashClaim(state, bucketId, -leg.signed);
      }
    }
    return;
  }

  if (txn.type === "cc_payment") {
    state.transfers += magnitude;
    if (!counter || !isCredit(counter) && !isCredit(primary)) {
      // Still move cash if one side is on-budget cash.
    }
    const card = isCredit(primary) ? primary : counter && isCredit(counter) ? counter : undefined;
    const cashLeg = isOnBudgetCash(primary)
      ? txn.amountMinor
      : counter && isOnBudgetCash(counter)
        ? -txn.amountMinor
        : 0;
    if (cashLeg < 0 && card) {
      const reserve = ccReserveId(buckets, card.id);
      const have = avail(state, reserve);
      const pay = -cashLeg;
      const fromReserve = Math.min(Math.max(have, 0), pay);
      addAvail(state, reserve, -fromReserve);
      const extra = pay - fromReserve;
      if (extra > 0) {
        const bucketId = txn.splits.find((s) => s.bucketId)?.bucketId ?? null;
        reduceCashClaim(state, bucketId, extra);
      }
    }
    return;
  }

  if (txn.type === "loan_payment") {
    if (isLiability(primary) && !isOnBudgetCash(primary)) {
      // The cash payment already claimed the money. This row only reduces the amount owed.
      return;
    }
    for (const split of splitsOrDefault(txn)) {
      if (split.role === "principal" || split.role === "transfer") {
        state.transfers += split.amountMinor;
        reduceCashClaim(state, split.bucketId, split.amountMinor);
      } else {
        state.spending += split.amountMinor;
        reduceCashClaim(state, split.bucketId, split.amountMinor);
        if (split.bucketId) touch(split.bucketId, "out", split.amountMinor);
      }
    }
    return;
  }

  if (txn.type === "income") {
    if (!isOnBudgetCash(primary)) return;
    for (const split of splitsOrDefault(txn)) {
      state.income += split.amountMinor;
      if (split.bucketId) {
        const bucket = buckets.find((b) => b.id === split.bucketId);
        if (!bucket || bucket.kind === "income") {
          state.rta += split.amountMinor;
          if (split.bucketId) touch(split.bucketId, "inn", split.amountMinor);
        } else {
          addAvail(state, split.bucketId, split.amountMinor);
          touch(split.bucketId, "inn", split.amountMinor);
        }
      } else {
        state.rta += split.amountMinor;
      }
    }
    return;
  }

  if (txn.type === "refund" || txn.type === "reimbursement") {
    const onCard = isCredit(primary) || (counter ? isCredit(counter) : false);
    for (const split of splitsOrDefault(txn)) {
      state.refunds += split.amountMinor;
      state.spending -= split.amountMinor;
      if (split.bucketId) touch(split.bucketId, "inn", split.amountMinor);
      if (onCard) {
        const card = isCredit(primary) ? primary : counter!;
        const reserve = ccReserveId(buckets, card.id);
        const fromReserve = Math.min(Math.max(avail(state, reserve), 0), split.amountMinor);
        if (fromReserve > 0) addAvail(state, reserve, -fromReserve);
        if (split.bucketId && fromReserve > 0) addAvail(state, split.bucketId, fromReserve);
        const remainder = split.amountMinor - fromReserve;
        if (remainder > 0) {
          state.warnings.push(
            "Part of a card refund lowered the card balance because that amount was no longer sitting in the payment reserve.",
          );
        }
      } else if (isOnBudgetCash(primary)) {
        if (split.bucketId) addAvail(state, split.bucketId, split.amountMinor);
        else state.rta += split.amountMinor;
      }
    }
    return;
  }

  if (txn.type === "buy" || txn.type === "sell" || txn.type === "dividend") {
    if (txn.type === "dividend" && isOnBudgetCash(primary)) {
      state.income += magnitude;
      state.rta += txn.amountMinor > 0 ? txn.amountMinor : 0;
    }
    return;
  }

  // expense, fee, interest, and anything else that spends.
  // A single bank amount may mix outflow and inflow splits; the net must match the signed amount.
  const card = isCredit(primary) ? primary : undefined;
  for (const split of splitsOrDefault(txn)) {
    if (isInflowRole(split.role)) {
      if (split.bucketId) touch(split.bucketId, "inn", split.amountMinor);
      if (card && card.onBudget) {
        const reserve = ccReserveId(buckets, card.id);
        const fromReserve = Math.min(Math.max(avail(state, reserve), 0), split.amountMinor);
        if (fromReserve) addAvail(state, reserve, -fromReserve);
        if (split.bucketId && fromReserve) addAvail(state, split.bucketId, fromReserve);
      } else if (isOnBudgetCash(primary)) {
        if (split.bucketId && split.role !== "income") addAvail(state, split.bucketId, split.amountMinor);
        else {
          const bucket = split.bucketId ? buckets.find((b) => b.id === split.bucketId) : undefined;
          if (bucket && bucket.kind !== "income") addAvail(state, bucket.id, split.amountMinor);
          else state.rta += split.amountMinor;
        }
      }
      continue;
    }
    state.spending += split.amountMinor;
    if (split.bucketId) touch(split.bucketId, "out", split.amountMinor);
    if (card && card.onBudget) {
      const current = split.bucketId ? avail(state, split.bucketId) : state.rta;
      const covered = Math.max(0, Math.min(current, split.amountMinor));
      if (split.bucketId) addAvail(state, split.bucketId, -covered);
      else state.rta -= covered;
      const reserve = ccReserveId(buckets, card.id);
      addAvail(state, reserve, covered);
      const uncovered = split.amountMinor - covered;
      if (uncovered > 0 && split.bucketId) {
        state.creditOverspend.set(split.bucketId, (state.creditOverspend.get(split.bucketId) ?? 0) + uncovered);
        state.warnings.push(
          `Card purchase of ${uncovered} minor units was not fully funded and became card debt instead of reducing other cash.`,
        );
      }
    } else if (isOnBudgetCash(primary)) {
      reduceCashClaim(state, split.bucketId, split.amountMinor);
    }
  }
}

export interface ComputeOptions {
  /** When true, future-month assignments reduce Ready to Assign. */
  includeFutureAssignments?: boolean;
}

export function computeBudget(input: EngineInput): BudgetResult {
  const viewKey = input.viewPeriod ?? periodFromDate(input.asOf).key;
  const includePending = input.includePending ?? false;
  for (const txn of input.transactions) validateTransaction(txn, input.accounts, input.currency);

  const dates = [
    input.asOf,
    `${viewKey}-01`,
    ...input.transactions.filter((t) => !t.deleted).map((t) => t.date),
    ...input.assignments.map((a) => `${a.periodKey}-01`),
  ];
  const earliest = dates.reduce((a, b) => (a < b ? a : b));
  const latestKey = input.assignments.reduce((k, a) => (a.periodKey > k ? a.periodKey : k), viewKey);
  const periods = enumerateMonths(earliest, `${latestKey}-01`);

  const state = emptyState();
  let snapshot: WalkState | null = null;
  let snapshotActivity = new Map<string, { inn: number; out: number }>();
  let snapshotAssigned = new Map<string, number>();
  let snapshotRollover = new Map<string, number>();
  let snapshotReleased = new Map<string, number>();
  let futureAssigned = 0;

  for (const period of periods) {
    const activity = new Map<string, { inn: number; out: number }>();
    const assigned = new Map<string, number>();
    const rolloverIn = new Map<string, number>();
    const released = new Map<string, number>();
    state.creditOverspend = new Map();

    if (period.key !== periods[0].key) {
      const previous = periods[periods.indexOf(period) - 1]!;
      for (const bucket of input.buckets) {
        if (bucket.kind !== "expense") continue;
        if (bucket.systemRole === "borrowed_funds" || bucket.systemRole === "cc_reserve") continue;
        const prev = avail(state, bucket.id);
        const { keep, release } = applyRollover(prev, rolloverForPeriod(bucket, previous.key, input.rolloverPolicies));
        state.available.set(bucket.id, keep);
        state.rta += release;
        rolloverIn.set(bucket.id, keep);
        released.set(bucket.id, release);
      }
    }

    for (const assignment of input.assignments) {
      if (assignment.periodKey !== period.key) continue;
      assertMinor(assignment.amountMinor, "assignment");
      addAvail(state, assignment.bucketId, assignment.amountMinor);
      state.rta -= assignment.amountMinor;
      assigned.set(assignment.bucketId, (assigned.get(assignment.bucketId) ?? 0) + assignment.amountMinor);
    }

    const txns = input.transactions
      .filter((txn) => !txn.deleted && txn.date >= period.start && txn.date <= period.end && txn.date <= input.asOf)
      .filter((txn) => includePending || txn.bankStatus !== "pending")
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        const rank = (type: Transaction["type"]) => (type === "opening" ? 0 : type === "income" ? 1 : type === "refund" || type === "reimbursement" ? 3 : type === "cc_payment" ? 4 : 2);
        const byType = rank(a.type) - rank(b.type);
        return byType || a.id.localeCompare(b.id);
      });

    for (const txn of txns) {
      applyTransaction(state, txn, input.accounts, input.buckets, input.currency, activity);
    }

    if (period.key === viewKey) {
      let income = 0;
      let spending = 0;
      let refunds = 0;
      let transfers = 0;
      for (const txn of txns) {
        if (txn.currency !== input.currency || txn.excludeFromReports) continue;
        const account = input.accounts.find((a) => a.id === txn.accountId);
        if (txn.type === "loan_payment" && account && isLiability(account) && !isOnBudgetCash(account)) continue;
        const inPlan = !!account && (isOnBudgetCash(account) || (isCredit(account) && account.onBudget) || txn.type === "loan_payment");
        const mag = Math.abs(txn.amountMinor);
        if (!inPlan) continue;
        if (txn.type === "income") income += mag;
        else if (txn.type === "refund" || txn.type === "reimbursement") {
          refunds += mag;
          spending -= mag;
        } else if (txn.type === "expense" || txn.type === "fee" || txn.type === "interest") spending += txn.splits.length ? Math.max(0, splitNetOutflow(txn)) : mag;
        else if (txn.type === "loan_payment") {
          for (const split of splitsOrDefault(txn)) {
            if (split.role !== "principal" && split.role !== "transfer") spending += split.amountMinor;
            else transfers += split.amountMinor;
          }
        } else if (txn.type === "transfer" || txn.type === "cc_payment" || txn.type === "loan_proceeds") transfers += mag;
      }
      snapshot = {
        rta: state.rta,
        available: new Map(state.available),
        creditOverspend: new Map(state.creditOverspend),
        income,
        spending,
        refunds,
        transfers,
        warnings: [...state.warnings],
      };
      snapshotActivity = activity;
      snapshotAssigned = assigned;
      snapshotRollover = rolloverIn;
      snapshotReleased = released;
      break;
    }
  }
  futureAssigned = input.assignments
    .filter((a) => a.periodKey > viewKey)
    .reduce((sum, a) => sum + a.amountMinor, 0);

  if (!snapshot) snapshot = state;

  // Assignments after the viewed month that were not walked because the view is the last period
  // are already handled. If view is earlier, futureAssigned was summed.
  // Also include assignment periods that are after the last walked period — enumerateMonths includes them.

  const view = periodFromDate(`${viewKey}-01`);
  const balanceAsOf = input.asOf < view.end ? input.asOf : view.end;
  const cashPool = input.accounts
    .filter((a) => isOnBudgetCash(a) && a.currency === input.currency)
    .reduce((sum, account) => sum + displayBalance(account, input.transactions, balanceAsOf, includePending), 0);

  const bucketRows: BucketMonth[] = input.buckets
    .filter((b) => !b.archived || (snapshot!.available.get(b.id) ?? 0) !== 0)
    .map((bucket) => {
      const act = snapshotActivity.get(bucket.id) ?? { inn: 0, out: 0 };
      const availableMinor = snapshot!.available.get(bucket.id) ?? 0;
      return {
        bucketId: bucket.id,
        name: bucket.name,
        group: bucket.group,
        assignedMinor: snapshotAssigned.get(bucket.id) ?? 0,
        activityOutMinor: act.out,
        activityInMinor: act.inn,
        activityMinor: act.out - act.inn,
        availableMinor,
        creditOverspendMinor: snapshot!.creditOverspend.get(bucket.id) ?? 0,
        rolloverInMinor: snapshotRollover.get(bucket.id) ?? 0,
        releasedMinor: snapshotReleased.get(bucket.id) ?? 0,
        funded: availableMinor >= 0 && (snapshot!.creditOverspend.get(bucket.id) ?? 0) === 0,
      };
    });

  const availableSum = bucketRows.reduce((s, row) => s + row.availableMinor, 0);
  // Future-month assignments are real claims on today's cash, but they were not
  // applied in the viewed month's walk. Subtract them from Ready to Assign only.
  const ready = snapshot!.rta - futureAssigned;
  const claimsWithFuture = ready + availableSum + futureAssigned;

  const cardGaps = input.accounts.filter(isCredit).map((card) => {
    const owed = displayBalance(card, input.transactions, balanceAsOf, includePending);
    const reserveBucket = input.buckets.find((b) => b.systemRole === "cc_reserve" && b.linkedAccountId === card.id);
    const reserved = reserveBucket ? snapshot!.available.get(reserveBucket.id) ?? 0 : 0;
    return { accountId: card.id, owedMinor: owed, reservedMinor: reserved, gapMinor: owed - reserved };
  });

  const borrowedBucket = input.buckets.find((b) => b.systemRole === "borrowed_funds");
  const warnings = [...snapshot!.warnings];
  if (ready < 0) {
    warnings.push("Ready to Assign is negative. Category balances are not fully backed by cash until you move money back.");
  }
  const identityDifference = cashPool - claimsWithFuture;
  if (identityDifference !== 0) {
    warnings.push(`Budget identity is off by ${identityDifference} minor units. ${IDENTITY_FORMULA}`);
  }

  return {
    periodKey: viewKey,
    periodStart: view.start,
    periodEnd: view.end,
    currency: input.currency,
    readyToAssignMinor: ready,
    futureAssignedMinor: futureAssigned,
    cashPoolMinor: cashPool,
    claimsMinor: claimsWithFuture,
    identityDifferenceMinor: identityDifference,
    buckets: bucketRows,
    incomeMinor: snapshot!.income,
    spendingMinor: snapshot!.spending,
    refundMinor: snapshot!.refunds,
    transferMinor: snapshot!.transfers,
    warnings: [...new Set(warnings)],
    cardGaps,
    borrowedFundsMinor: borrowedBucket ? snapshot!.available.get(borrowedBucket.id) ?? 0 : 0,
  };
}

export function explainReadyToAssign(result: BudgetResult): ExplainedNumber {
  return {
    amountMinor: result.readyToAssignMinor,
    currency: result.currency,
    title: "Ready to Assign",
    formula:
      "Cash that has entered on-budget accounts and has not been assigned, minus cash that left without a category, plus money released by rollover rules. Expected paychecks are not included.",
    lines: [
      { label: "On-budget cash", amountMinor: result.cashPoolMinor },
      { label: "Held in categories, envelopes, goals, and reserves", amountMinor: result.claimsMinor - result.readyToAssignMinor - result.futureAssignedMinor },
      { label: "Reserved for future months", amountMinor: result.futureAssignedMinor },
      { label: "Ready to Assign", amountMinor: result.readyToAssignMinor },
    ],
  };
}

export interface SpendGuidance {
  cashSafeMinor: number;
  shortageMinor: number;
  projectedAllowanceMinor: number;
  projectedUsesExpectedIncome: boolean;
  dailyCashMinor: number;
  dailyProjectedMinor: number;
  daysRemaining: number;
  formula: string;
  lines: { label: string; amountMinor: number }[];
  primaryFigure: "cash" | "shortage";
}

export function spendGuidance(input: {
  result: BudgetResult;
  buckets: Bucket[];
  /** Bills and other outflows still to happen that are NOT already reserved in a bucket. */
  uncoveredBillsMinor: number;
  /** Expected income still to be received. Never treated as cash. */
  expectedIncomeMinor: number;
  daysRemaining: number;
}): SpendGuidance {
  const flexIds = new Set(input.buckets.filter((b) => b.flexRole === "flexible" && b.kind === "expense").map((b) => b.id));
  const flexAvailable = input.result.buckets
    .filter((b) => flexIds.has(b.bucketId))
    .reduce((s, b) => s + b.availableMinor, 0);
  const cashBeforeBills = input.result.readyToAssignMinor + flexAvailable;
  const cashSafeRaw = cashBeforeBills - input.uncoveredBillsMinor;
  const shortage = cashSafeRaw < 0 ? -cashSafeRaw : 0;
  const cashSafe = Math.max(0, cashSafeRaw);
  const days = Math.max(1, input.daysRemaining);
  const projectedRaw = cashSafeRaw + input.expectedIncomeMinor;
  return {
    cashSafeMinor: cashSafe,
    shortageMinor: shortage,
    projectedAllowanceMinor: projectedRaw,
    projectedUsesExpectedIncome: input.expectedIncomeMinor !== 0,
    dailyCashMinor: Math.floor(cashSafe / days),
    dailyProjectedMinor: Math.floor(Math.max(0, projectedRaw) / days),
    daysRemaining: days,
    primaryFigure: shortage > 0 ? "shortage" : "cash",
    formula:
      "Cash safe-to-spend = Ready to Assign + flexible envelope balances − upcoming bills that are not already reserved. Expected income is shown only as a separate projected allowance. If cash would go negative, the shortage is the number we show.",
    lines: [
      { label: "Ready to Assign", amountMinor: input.result.readyToAssignMinor },
      { label: "Flexible funds", amountMinor: flexAvailable },
      { label: "Upcoming bills not already reserved", amountMinor: -input.uncoveredBillsMinor },
      { label: "Expected income (not cash)", amountMinor: input.expectedIncomeMinor },
    ],
  };
}

/** How much more cash to assign. `availableIncludingAssigned` already includes this period's assignments. */
export function neededForTarget(bucket: Bucket, availableIncludingAssigned: number, assignedThisPeriod: number, monthsRemaining = 1, postedIncomeMinor = 0): number {
  const target = bucket.target;
  if (!target || target.pausedUntil) return 0;
  const months = Math.max(1, monthsRemaining);
  const amount = target.percentBps == null ? target.amountMinor : percentTargetMinor(postedIncomeMinor, target.percentBps);
  if (target.type === "set_aside") return Math.max(0, amount - assignedThisPeriod);
  if (target.type === "refill" || target.type === "maintain_balance") {
    return Math.max(0, amount - availableIncludingAssigned);
  }
  const gap = Math.max(0, amount - availableIncludingAssigned);
  return Math.max(0, Math.ceil(gap / months));
}

export interface AutoAssignLine {
  bucketId: string;
  amountMinor: number;
  reason: string;
}

export function previewAutoAssign(input: {
  result: BudgetResult;
  buckets: Bucket[];
  strategy: "underfunded" | "previous" | "spending" | "average";
  previousAssigned?: { bucketId: string; amountMinor: number }[];
  averageSpending?: { bucketId: string; amountMinor: number }[];
  monthsRemainingByBucket?: Record<string, number>;
  postedIncomeMinor?: number;
}): { lines: AutoAssignLine[]; unfundedMinor: number; explanation: string } {
  const rta = input.result.readyToAssignMinor;
  const lines: AutoAssignLine[] = [];
  const candidates: AutoAssignLine[] = [];
  for (const bucket of input.buckets) {
    if (bucket.kind !== "expense" || bucket.archived || bucket.systemRole === "borrowed_funds" || bucket.systemRole === "cc_reserve") {
      continue;
    }
    const row = input.result.buckets.find((b) => b.bucketId === bucket.id);
    const available = row?.availableMinor ?? 0;
    const assigned = row?.assignedMinor ?? 0;
    let need = 0;
    let reason = "";
    if (input.strategy === "underfunded") {
      need = neededForTarget(bucket, available, assigned, input.monthsRemainingByBucket?.[bucket.id] ?? 1, input.postedIncomeMinor ?? 0);
      reason = bucket.target ? `Target ${bucket.target.type}` : "";
    } else if (input.strategy === "previous") {
      const prev = input.previousAssigned?.find((p) => p.bucketId === bucket.id)?.amountMinor ?? 0;
      need = Math.max(0, prev - assigned);
      reason = "Match previous assignment";
    } else if (input.strategy === "spending" || input.strategy === "average") {
      const avg = input.averageSpending?.find((p) => p.bucketId === bucket.id)?.amountMinor ?? row?.activityOutMinor ?? 0;
      need = Math.max(0, avg - assigned);
      reason = input.strategy === "average" ? "Average spending" : "Prior spending";
    }
    if (need > 0 && reason) candidates.push({ bucketId: bucket.id, amountMinor: need, reason });
  }
  let left = Math.max(0, rta);
  let unfunded = 0;
  for (const line of candidates) {
    const give = Math.min(left, line.amountMinor);
    if (give > 0) lines.push({ ...line, amountMinor: give });
    const short = line.amountMinor - give;
    if (short > 0) unfunded += short;
    left -= give;
  }
  const explanation =
    rta <= 0
      ? "No funded cash is left in Ready to Assign. Expected income was not used."
      : unfunded > 0
        ? `Assigned ${rta - left} minor units. ${unfunded} minor units of targets remain because Ready to Assign is not enough.`
        : "Every selected target fits in Ready to Assign.";
  return { lines, unfundedMinor: unfunded, explanation };
}

export function overfundingSuggestions(result: BudgetResult, buckets: Bucket[]): AutoAssignLine[] {
  const lines: AutoAssignLine[] = [];
  for (const bucket of buckets) {
    if (!bucket.target || bucket.target.type === "set_aside" || bucket.target.percentBps != null) continue;
    const row = result.buckets.find((b) => b.bucketId === bucket.id);
    if (!row) continue;
    const extra = row.availableMinor - bucket.target.amountMinor;
    if (bucket.target.type === "refill" || bucket.target.type === "maintain_balance") {
      if (extra > 0) lines.push({ bucketId: bucket.id, amountMinor: extra, reason: "Above the refill target" });
    }
  }
  return lines;
}

export function evaluateIncomePlan(planLines: PlanLine[], expectedIncomeMinor: number, periodKey: string): {
  plannedMinor: number;
  expectedIncomeMinor: number;
  unplannedMinor: number;
  balanced: boolean;
  note: string;
} {
  const planned = planLines.filter((l) => l.periodKey === periodKey).reduce((s, l) => s + l.plannedMinor, 0);
  const unplanned = expectedIncomeMinor - planned;
  return {
    plannedMinor: planned,
    expectedIncomeMinor,
    unplannedMinor: unplanned,
    balanced: unplanned === 0,
    note: "This is a projected income plan. It does not fund envelopes until the money is actually received and assigned.",
  };
}

export function ageOfMoney(
  input: EngineInput,
  lastN = 10,
): { days: number | null; samples: number; formula: string } {
  const inflows: { date: string; remaining: number }[] = [];
  const cashIds = new Set(input.accounts.filter((a) => isOnBudgetCash(a) && a.currency === input.currency).map((a) => a.id));
  const events = input.transactions
    .filter((t) => !t.deleted && t.date <= input.asOf && (input.includePending || t.bankStatus !== "pending"))
    .filter((t) => t.currency === input.currency)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));

  const ages: number[] = [];
  for (const txn of events) {
    const cashIn = cashInflow(txn, cashIds);
    if (cashIn > 0 && (txn.type === "income" || txn.type === "opening" || txn.type === "reconciliation")) {
      inflows.push({ date: txn.date, remaining: cashIn });
    }
    const cashOut = cashOutflow(txn, cashIds);
    if (cashOut > 0 && (txn.type === "expense" || txn.type === "fee" || txn.type === "interest" || txn.type === "loan_payment" || txn.type === "cc_payment")) {
      let need = cashOut;
      let sourceDate = txn.date;
      while (need > 0 && inflows.length) {
        const head = inflows[0];
        const take = Math.min(head.remaining, need);
        head.remaining -= take;
        need -= take;
        sourceDate = head.date;
        if (head.remaining === 0) inflows.shift();
      }
      if (need === 0) {
        const [y1, m1, d1] = sourceDate.split("-").map(Number);
        const [y2, m2, d2] = txn.date.split("-").map(Number);
        const age = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
        ages.push(age);
      }
    }
  }
  const sample = ages.slice(-lastN);
  if (!sample.length) {
    return {
      days: null,
      samples: 0,
      formula: "Age of money is the average number of days between when cash arrived and when the last cash outflows spent it (first-in, first-out). It is a budgeting measure, not a guarantee you can go that many days without income.",
    };
  }
  const avg = Math.round(sample.reduce((s, n) => s + n, 0) / sample.length);
  return {
    days: avg,
    samples: sample.length,
    formula: `Average FIFO age of the last ${sample.length} cash outflows. Not a liquidity guarantee.`,
  };
}

function cashInflow(txn: Transaction, cashIds: Set<string>): number {
  let total = 0;
  if (cashIds.has(txn.accountId) && txn.amountMinor > 0) total += txn.amountMinor;
  if (txn.counterAccountId && cashIds.has(txn.counterAccountId) && -txn.amountMinor > 0) total += -txn.amountMinor;
  return total;
}

function cashOutflow(txn: Transaction, cashIds: Set<string>): number {
  let total = 0;
  if (cashIds.has(txn.accountId) && txn.amountMinor < 0) total += -txn.amountMinor;
  if (txn.counterAccountId && cashIds.has(txn.counterAccountId) && -txn.amountMinor < 0) total += txn.amountMinor;
  return total;
}

export function moveAssignment(assignments: Assignment[], fromBucketId: string | null, toBucketId: string, periodKey: string, amountMinor: number, idFactory: () => string): Assignment[] {
  assertMinor(amountMinor, "move");
  if (amountMinor <= 0) throw new BudgetError("Move amount must be positive");
  const next = assignments.map((a) => ({ ...a }));
  const touch = (bucketId: string, delta: number) => {
    const existing = next.find((a) => a.bucketId === bucketId && a.periodKey === periodKey);
    if (existing) existing.amountMinor += delta;
    else next.push({ id: idFactory(), bucketId, periodKey, amountMinor: delta });
  };
  if (fromBucketId) touch(fromBucketId, -amountMinor);
  touch(toBucketId, amountMinor);
  return next;
}

export function sumAssignments(assignments: Assignment[], bucketId: string, periodKey: string): number {
  return assignments.filter((a) => a.bucketId === bucketId && a.periodKey === periodKey).reduce((s, a) => s + a.amountMinor, 0);
}

export interface PlannedOutflow {
  bucketId: string | null;
  amountMinor: number;
}

/**
 * Portion of upcoming outflows that is NOT already sitting in a non-flexible bucket.
 * Flexible balances are left in safe-to-spend and the caller subtracts these uncovered amounts once.
 */
export function uncoveredOutflows(bills: PlannedOutflow[], result: BudgetResult, buckets: Bucket[]): number {
  const nonFlex = new Set(
    buckets.filter((b) => b.kind === "expense" && b.flexRole !== "flexible").map((b) => b.id),
  );
  const pools = new Map<string, number>();
  for (const row of result.buckets) {
    if (nonFlex.has(row.bucketId)) pools.set(row.bucketId, Math.max(0, row.availableMinor));
  }
  let uncovered = 0;
  for (const bill of bills) {
    assertMinor(bill.amountMinor, "bill");
    if (bill.bucketId && nonFlex.has(bill.bucketId)) {
      const have = pools.get(bill.bucketId) ?? 0;
      const cover = Math.min(have, bill.amountMinor);
      pools.set(bill.bucketId, have - cover);
      uncovered += bill.amountMinor - cover;
    } else {
      uncovered += bill.amountMinor;
    }
  }
  return uncovered;
}
