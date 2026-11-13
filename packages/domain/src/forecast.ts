import { addDays } from "./dates.js";
import { assertMinor } from "./money.js";

export interface ForecastEvent {
  id: string;
  date: string;
  /** Signed: positive adds cash, negative removes cash. */
  amountMinor: number;
  label: string;
  kind: "income" | "expense" | "transfer" | "plan";
  /** True when the inflow is expected but not yet received. */
  expectedIncome?: boolean;
  scheduleId?: string;
  alreadyReserved?: boolean;
}

export interface ForecastPoint {
  date: string;
  balanceMinor: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  startingMinor: number;
  endingMinor: number;
  minimumMinor: number;
  minimumDate: string;
  overdraftDate: string | null;
  includedExpectedIncome: boolean;
  formula: string;
}

/**
 * Day-by-day cash projection. Events already posted must not be passed in again.
 * Expected income is omitted unless includeExpectedIncome is true, so a plan that
 * only works because of a future paycheck cannot hide a cash shortage.
 */
export function projectCash(input: {
  startingMinor: number;
  startDate: string;
  days: number;
  events: ForecastEvent[];
  includeExpectedIncome: boolean;
}): ForecastResult {
  assertMinor(input.startingMinor, "starting balance");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 3700) {
    throw new Error("Forecast horizon must be between 1 and 3700 days");
  }
  let balance = input.startingMinor;
  let minimum = balance;
  let minimumDate = input.startDate;
  let overdraft: string | null = balance < 0 ? input.startDate : null;
  const points: ForecastPoint[] = [];
  const events = [...input.events].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
  for (let i = 0; i < input.days; i++) {
    const date = addDays(input.startDate, i);
    for (const event of events) {
      if (event.date !== date) continue;
      if (event.expectedIncome && !input.includeExpectedIncome) continue;
      assertMinor(event.amountMinor, event.label);
      balance += event.amountMinor;
    }
    if (balance < minimum) {
      minimum = balance;
      minimumDate = date;
    }
    if (balance < 0 && !overdraft) overdraft = date;
    points.push({ date, balanceMinor: balance });
  }
  return {
    points,
    startingMinor: input.startingMinor,
    endingMinor: balance,
    minimumMinor: minimum,
    minimumDate,
    overdraftDate: overdraft,
    includedExpectedIncome: input.includeExpectedIncome,
    formula:
      "Starting cleared cash, plus scheduled inflows and outflows on their dates. Pending items are included only when the caller adds them. A reserved bill should be included once, as the payment, not again as a budget hold. Expected paychecks are excluded from the cash projection.",
  };
}

export interface Paycheck {
  id: string;
  date: string;
  amountMinor: number;
  received: boolean;
  earner: string;
}

export interface Obligation {
  id: string;
  date: string;
  amountMinor: number;
  name: string;
  reservedMinor: number;
}

export interface PayPeriodPlan {
  paycheckId: string;
  paycheckDate: string;
  nextPaycheckDate: string | null;
  earner: string;
  paycheckMinor: number;
  received: boolean;
  obligations: { id: string; name: string; date: string; amountMinor: number; uncoveredMinor: number }[];
  uncoveredMinor: number;
  cashAfterMinor: number;
  shortageMinor: number;
}

/** Which bills each paycheck must cover, and whether confirmed cash runs out before the next one. */
export function planPaychecks(input: {
  asOf: string;
  startingCashMinor: number;
  paychecks: Paycheck[];
  obligations: Obligation[];
}): {
  nextPaycheckDate: string | null;
  beforeNext: PayPeriodPlan;
  periods: PayPeriodPlan[];
  formula: string;
} {
  const pays = [...input.paychecks].sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextPay = pays.find((pay) => pay.date > input.asOf && !pay.received) ?? null;
  const mapBill = (bill: Obligation) => ({
    id: bill.id,
    name: bill.name,
    date: bill.date,
    amountMinor: bill.amountMinor,
    uncoveredMinor: Math.max(0, bill.amountMinor - bill.reservedMinor),
  });
  const beforeBills = input.obligations
    .filter((bill) => bill.date >= input.asOf && (nextPay == null || bill.date < nextPay.date))
    .map(mapBill);
  const beforeUncovered = beforeBills.reduce((sum, bill) => sum + bill.uncoveredMinor, 0);
  const beforeNext: PayPeriodPlan = {
    paycheckId: nextPay?.id ?? "none",
    paycheckDate: nextPay?.date ?? input.asOf,
    nextPaycheckDate: nextPay?.date ?? null,
    earner: nextPay?.earner ?? "",
    paycheckMinor: nextPay?.amountMinor ?? 0,
    received: false,
    obligations: beforeBills,
    uncoveredMinor: beforeUncovered,
    cashAfterMinor: input.startingCashMinor - beforeUncovered,
    shortageMinor: Math.max(0, beforeUncovered - input.startingCashMinor),
  };
  const periods: PayPeriodPlan[] = pays.map((pay, index) => {
    const next = pays[index + 1]?.date ?? null;
    const obligations = input.obligations
      .filter((bill) => bill.date >= pay.date && (next == null || bill.date < next))
      .map(mapBill);
    const uncovered = obligations.reduce((sum, bill) => sum + bill.uncoveredMinor, 0);
    return {
      paycheckId: pay.id,
      paycheckDate: pay.date,
      nextPaycheckDate: next,
      earner: pay.earner,
      paycheckMinor: pay.amountMinor,
      received: pay.received,
      obligations,
      uncoveredMinor: uncovered,
      cashAfterMinor: pay.amountMinor - uncovered,
      shortageMinor: Math.max(0, uncovered - pay.amountMinor),
    };
  });
  return {
    nextPaycheckDate: nextPay?.date ?? null,
    beforeNext,
    periods,
    formula:
      "Bills due before the next unreceived paycheck are compared with cash already on hand. Reserved amounts are not subtracted again. The paycheck amount is not added to Ready to Assign. A later interval shows whether that paycheck itself covers the bills assigned to it.",
  };
}

export interface ScenarioAdjustment {
  id: string;
  label: string;
  date: string;
  amountMinor: number;
  kind: ForecastEvent["kind"];
}

/** Scenarios change a copy of forecast events. They do not post transactions. */
export function applyScenario(events: ForecastEvent[], adjustments: ScenarioAdjustment[]): ForecastEvent[] {
  const next = events.map((event) => ({ ...event }));
  for (const change of adjustments) {
    next.push({
      id: `scenario-${change.id}`,
      date: change.date,
      amountMinor: change.amountMinor,
      label: change.label,
      kind: change.kind,
      expectedIncome: change.kind === "income",
    });
  }
  return next;
}
