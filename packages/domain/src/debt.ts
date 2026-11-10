import { addMonths } from "./dates.js";
import { monthlyInterestMinor } from "./money.js";

export interface Debt {
  id: string;
  name: string;
  balanceMinor: number;
  aprBps: number;
  minPaymentMinor: number;
  extraMinor?: number;
}

export interface LoanEvent {
  /** 0-based month index from the start date. */
  monthIndex: number;
  extraOneTimeMinor?: number;
  aprBps?: number;
  paymentMinor?: number;
  holiday?: boolean;
}

export interface AmortizationMonth {
  index: number;
  date: string;
  paymentMinor: number;
  interestMinor: number;
  principalMinor: number;
  balanceMinor: number;
  holiday: boolean;
}

export interface AmortizationSummary {
  months: AmortizationMonth[];
  payoffDate: string | null;
  totalInterestMinor: number;
  totalPaidMinor: number;
  payoffMonths: number | null;
  negativeAmortization: boolean;
  assumptions: string[];
}

const MAX_MONTHS = 1200;

export function amortize(debt: Debt, startDate: string, events: LoanEvent[] = []): AmortizationSummary {
  let balance = debt.balanceMinor;
  let apr = debt.aprBps;
  let payment = debt.minPaymentMinor + (debt.extraMinor ?? 0);
  const months: AmortizationMonth[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let negative = false;
  const assumptions = [
    "Interest is balance × APR / 12, rounded half away from zero to the minor unit, charged monthly.",
    "Extra payments reduce principal after interest. This is a model, not a lender quote.",
  ];
  for (let i = 0; i < MAX_MONTHS && balance > 0; i++) {
    const event = events.find((item) => item.monthIndex === i);
    if (event?.aprBps != null) apr = event.aprBps;
    if (event?.paymentMinor != null) payment = event.paymentMinor;
    const date = addMonths(startDate, i);
    if (event?.holiday) {
      const interest = monthlyInterestMinor(balance, apr);
      balance += interest;
      totalInterest += interest;
      negative = true;
      months.push({
        index: i,
        date,
        paymentMinor: 0,
        interestMinor: interest,
        principalMinor: -interest,
        balanceMinor: balance,
        holiday: true,
      });
      continue;
    }
    const interest = monthlyInterestMinor(balance, apr);
    let pay = payment + (event?.extraOneTimeMinor ?? 0);
    if (pay > balance + interest) pay = balance + interest;
    const principal = pay - interest;
    if (principal <= 0 && balance > 0) negative = true;
    balance = Math.max(0, balance - principal);
    totalInterest += interest;
    totalPaid += pay;
    months.push({
      index: i,
      date,
      paymentMinor: pay,
      interestMinor: interest,
      principalMinor: principal,
      balanceMinor: balance,
      holiday: false,
    });
    if (balance === 0) break;
  }
  const last = months[months.length - 1];
  const paidOff = last ? last.balanceMinor === 0 : debt.balanceMinor === 0;
  return {
    months,
    payoffDate: paidOff && last ? last.date : null,
    totalInterestMinor: totalInterest,
    totalPaidMinor: totalPaid,
    payoffMonths: paidOff ? months.length : null,
    negativeAmortization: negative,
    assumptions,
  };
}

export type PayoffStrategy = "snowball" | "avalanche" | "custom";

export interface StrategyResult {
  strategy: PayoffStrategy;
  order: string[];
  months: number | null;
  totalInterestMinor: number;
  debtFreeDate: string | null;
  timeline: { date: string; debtId: string; balanceMinor: number }[];
  assumptions: string[];
}

/**
 * Pay minimums on every debt. Send the extra payment to the current focus debt.
 * When a debt is gone, its minimum (and any extra that was aimed at it) rolls to the next focus.
 */
export function payoffPlan(input: {
  debts: Debt[];
  strategy: PayoffStrategy;
  customOrder?: string[];
  startDate: string;
  extraMinor: number;
}): StrategyResult {
  const debts = input.debts.map((debt) => ({ ...debt }));
  const order = orderDebts(debts, input.strategy, input.customOrder);
  const assumptions = [
    input.strategy === "snowball"
      ? "Snowball pays the smallest balance first while minimums continue on the rest."
      : input.strategy === "avalanche"
        ? "Avalanche pays the highest APR first while minimums continue on the rest."
        : "Custom order uses the sequence you chose.",
    "Rolled payments keep the same total monthly dollars aimed at debt until the list is clear.",
    "Interest uses the same monthly rounding as the single-loan planner.",
  ];
  let month = 0;
  let totalInterest = 0;
  const timeline: { date: string; debtId: string; balanceMinor: number }[] = [];
  while (debts.some((debt) => debt.balanceMinor > 0) && month < MAX_MONTHS) {
    const date = addMonths(input.startDate, month);
    const active = order.filter((id) => (debts.find((debt) => debt.id === id)?.balanceMinor ?? 0) > 0);
    let extraLeft = input.extraMinor;
    // Minimums first.
    for (const id of active) {
      const debt = debts.find((item) => item.id === id)!;
      const interest = monthlyInterestMinor(debt.balanceMinor, debt.aprBps);
      let pay = Math.min(debt.minPaymentMinor, debt.balanceMinor + interest);
      const principal = pay - interest;
      debt.balanceMinor = Math.max(0, debt.balanceMinor - principal);
      totalInterest += interest;
      if (debt.balanceMinor === 0 && pay < debt.minPaymentMinor) {
        extraLeft += debt.minPaymentMinor - pay;
      }
    }
    // Extra to the first debt that still has a balance. If the minimum already cleared it, roll forward.
    for (const id of active) {
      if (extraLeft <= 0) break;
      const debt = debts.find((item) => item.id === id)!;
      if (debt.balanceMinor <= 0) continue;
      const pay = Math.min(extraLeft, debt.balanceMinor);
      debt.balanceMinor -= pay;
      extraLeft -= pay;
    }
    for (const debt of debts) timeline.push({ date, debtId: debt.id, balanceMinor: debt.balanceMinor });
    month += 1;
  }
  const clear = !debts.some((debt) => debt.balanceMinor > 0);
  return {
    strategy: input.strategy,
    order,
    months: clear ? month : null,
    totalInterestMinor: totalInterest,
    debtFreeDate: clear ? addMonths(input.startDate, month - 1) : null,
    timeline,
    assumptions,
  };
}

function orderDebts(debts: Debt[], strategy: PayoffStrategy, customOrder?: string[]): string[] {
  if (strategy === "custom" && customOrder?.length) {
    const rest = debts.map((debt) => debt.id).filter((id) => !customOrder.includes(id));
    return [...customOrder, ...rest];
  }
  const sorted = [...debts].sort((a, b) => {
    if (strategy === "avalanche") return b.aprBps - a.aprBps || a.balanceMinor - b.balanceMinor;
    return a.balanceMinor - b.balanceMinor || b.aprBps - a.aprBps;
  });
  return sorted.map((debt) => debt.id);
}

export interface RefinanceComparison {
  currentInterestMinor: number;
  refinancedInterestMinor: number;
  feeMinor: number;
  interestSavedMinor: number;
  netBenefitMinor: number;
  assumptions: string[];
}

export function compareRefinance(input: {
  balanceMinor: number;
  aprBps: number;
  paymentMinor: number;
  newAprBps: number;
  newPaymentMinor: number;
  feeMinor: number;
  startDate: string;
}): RefinanceComparison {
  const current = amortize(
    { id: "current", name: "Current", balanceMinor: input.balanceMinor, aprBps: input.aprBps, minPaymentMinor: input.paymentMinor },
    input.startDate,
  );
  const next = amortize(
    {
      id: "new",
      name: "Refinance",
      balanceMinor: input.balanceMinor + input.feeMinor,
      aprBps: input.newAprBps,
      minPaymentMinor: input.newPaymentMinor,
    },
    input.startDate,
  );
  const saved = current.totalInterestMinor - next.totalInterestMinor;
  return {
    currentInterestMinor: current.totalInterestMinor,
    refinancedInterestMinor: next.totalInterestMinor,
    feeMinor: input.feeMinor,
    interestSavedMinor: saved,
    netBenefitMinor: saved - input.feeMinor,
    assumptions: [
      "The refinance fee is added to the new principal.",
      ...current.assumptions,
    ],
  };
}
