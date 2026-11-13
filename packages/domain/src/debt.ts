import { addMonths, isIsoDate } from "./dates.js";
import { assertMinor, monthlyInterestMinor } from "./money.js";
import { BudgetError } from "./budget.js";
import type { Split } from "./types.js";

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
  /** One-time extra included in this payment. Recurring extra is part of the scheduled payment. */
  extraMinor: number;
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
  /** False when the balance is still open after the 100-year horizon. Totals are then only the months shown. */
  paidOff: boolean;
  assumptions: string[];
}

export const LOAN_MODEL_NOTE =
  "Interest in this model is the balance times the APR divided by 12, rounded half away from zero to the cent, and charged once a month. Extra payments reduce principal after that interest. This is a monthly approximation, not a lender payoff quote.";

const MAX_MONTHS = 1200;
const HORIZON_NOTE =
  "This payment does not pay the loan off within 100 years. The totals are only the months shown, not a finished payoff.";

export function combineLoanEvents(events: LoanEvent[]): LoanEvent[] {
  const groups = new Map<number, LoanEvent[]>();
  for (const event of events) {
    if (!Number.isInteger(event.monthIndex) || event.monthIndex < 0 || event.monthIndex >= MAX_MONTHS) {
      throw new BudgetError("Each loan event needs a month from 1 through 1200.");
    }
    const list = groups.get(event.monthIndex) ?? [];
    list.push(event);
    groups.set(event.monthIndex, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([monthIndex, list]) => mergeMonthEvents(monthIndex, list));
}

function mergeMonthEvents(monthIndex: number, list: LoanEvent[]): LoanEvent {
  const label = `Month ${monthIndex + 1}`;
  let extra = 0;
  const payments: number[] = [];
  const rates: number[] = [];
  let holiday = false;
  for (const event of list) {
    if (event.extraOneTimeMinor != null) {
      assertMinor(event.extraOneTimeMinor, "extra payment");
      if (event.extraOneTimeMinor < 0) throw new BudgetError(`${label} has a negative extra payment.`);
      extra += event.extraOneTimeMinor;
    }
    if (event.paymentMinor != null) {
      assertMinor(event.paymentMinor, "payment");
      if (event.paymentMinor < 0) throw new BudgetError(`${label} has a negative payment.`);
      payments.push(event.paymentMinor);
    }
    if (event.aprBps != null) {
      assertMinor(event.aprBps, "APR");
      if (event.aprBps < 0) throw new BudgetError(`${label} has a negative rate.`);
      rates.push(event.aprBps);
    }
    if (event.holiday) holiday = true;
  }
  const distinctPayments = new Set(payments);
  const distinctRates = new Set(rates);
  if (distinctPayments.size > 1) {
    throw new BudgetError(`${label} has more than one payment amount. Keep a single payment for that month.`);
  }
  if (distinctRates.size > 1) {
    throw new BudgetError(`${label} has more than one rate. Keep a single rate for that month.`);
  }
  if (holiday && (distinctPayments.size > 0 || extra > 0)) {
    throw new BudgetError(`${label} is a payment holiday and also has a payment. Keep one of those for that month.`);
  }
  return {
    monthIndex,
    holiday: holiday || undefined,
    paymentMinor: payments[0],
    aprBps: rates[0],
    extraOneTimeMinor: extra > 0 ? extra : undefined,
  };
}

export function amortize(debt: Debt, startDate: string, events: LoanEvent[] = []): AmortizationSummary {
  assertLoanNumbers(debt.balanceMinor, debt.aprBps, debt.minPaymentMinor, debt.extraMinor ?? 0);
  if (!isIsoDate(startDate)) throw new BudgetError("The start date must be YYYY-MM-DD.");
  const combined = combineLoanEvents(events);
  const byMonth = new Map(combined.map((event) => [event.monthIndex, event]));
  const assumptions = [
    LOAN_MODEL_NOTE,
    "A payment change replaces the scheduled payment from that month forward. One-time extras in the same month are added together. A holiday skips the payment and adds that month's interest to the balance.",
  ];
  if (debt.balanceMinor === 0) {
    return {
      months: [],
      payoffDate: startDate,
      totalInterestMinor: 0,
      totalPaidMinor: 0,
      payoffMonths: 0,
      negativeAmortization: false,
      paidOff: true,
      assumptions: [...assumptions, "The balance is already zero, so there is no payment schedule."],
    };
  }
  let balance = debt.balanceMinor;
  let apr = debt.aprBps;
  let payment = debt.minPaymentMinor + (debt.extraMinor ?? 0);
  const months: AmortizationMonth[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let negative = false;
  for (let i = 0; i < MAX_MONTHS && balance > 0; i++) {
    const event = byMonth.get(i);
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
        extraMinor: 0,
        balanceMinor: balance,
        holiday: true,
      });
      continue;
    }
    const interest = monthlyInterestMinor(balance, apr);
    const oneTime = event?.extraOneTimeMinor ?? 0;
    let pay = payment + oneTime;
    if (pay > balance + interest) pay = balance + interest;
    if (pay < 0) pay = 0;
    const principal = pay - interest;
    if (principal <= 0 && balance > 0) negative = true;
    const next = balance - principal;
    balance = next < 0 ? 0 : next;
    totalInterest += interest;
    totalPaid += pay;
    months.push({
      index: i,
      date,
      paymentMinor: pay,
      interestMinor: interest,
      principalMinor: principal,
      extraMinor: Math.min(oneTime, pay),
      balanceMinor: balance,
      holiday: false,
    });
    if (balance === 0) break;
  }
  const last = months[months.length - 1];
  const paidOff = !!last && last.balanceMinor === 0;
  if (!paidOff) assumptions.push(HORIZON_NOTE);
  else if (negative) assumptions.push("At least one payment was not larger than the interest, so the balance grew or did not fall in that month. The later months still reach zero in this model.");
  return {
    months,
    payoffDate: paidOff && last ? last.date : null,
    totalInterestMinor: totalInterest,
    totalPaidMinor: totalPaid,
    payoffMonths: paidOff ? months.length : null,
    negativeAmortization: negative,
    paidOff,
    assumptions,
  };
}

/** Payment that clears a principal within a term under the monthly model. The last payment is capped by the amortizer. */
export function paymentForTerm(principalMinor: number, aprBps: number, months: number): number {
  assertMinor(principalMinor, "principal");
  assertMinor(aprBps, "APR");
  assertMinor(months, "term");
  if (principalMinor < 0 || aprBps < 0 || months <= 0) throw new BudgetError("Principal, rate, and term cannot be negative.");
  if (months > MAX_MONTHS) throw new BudgetError("The term cannot be longer than 100 years in this model.");
  if (principalMinor === 0) return 0;
  if (aprBps === 0) {
    const base = Math.floor(principalMinor / months);
    return base + (principalMinor - base * months > 0 ? 1 : 0);
  }
  const rate = aprBps / 120_000;
  const raw = (principalMinor * rate) / (1 - (1 + rate) ** -months);
  if (!Number.isFinite(raw) || raw <= 0) throw new BudgetError("The payment could not be calculated from these inputs.");
  let payment = Math.round(raw);
  if (payment < 1) payment = 1;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = amortize({ id: "term", name: "Term", balanceMinor: principalMinor, aprBps, minPaymentMinor: payment }, "2020-01-01");
    if (result.paidOff && result.payoffMonths != null && result.payoffMonths <= months) return payment;
    payment += 1;
  }
  throw new BudgetError("This rate and term do not produce a payment that pays the loan off in the model.");
}

export type PayoffStrategy = "snowball" | "avalanche" | "custom";

export interface StrategyResult {
  strategy: PayoffStrategy;
  order: string[];
  months: number | null;
  totalInterestMinor: number;
  /** Sum of balance decreases. At zero interest this equals the starting principal. */
  totalPrincipalMinor: number;
  /** Starting minimums plus the extra amount. A paid-off minimum stays in this budget. */
  monthlyBudgetMinor: number;
  debtFreeDate: string | null;
  paidOff: boolean;
  timeline: { date: string; debtId: string; balanceMinor: number; paymentMinor: number }[];
  assumptions: string[];
}

/**
 * The monthly budget is the sum of the starting minimums plus the extra amount.
 * Every later month keeps that budget, including minimums from debts that are already gone.
 * Active debts still receive their own minimum first. The remainder follows the strategy.
 * The last month pays only what is still owed.
 */
export function payoffPlan(input: {
  debts: Debt[];
  strategy: PayoffStrategy;
  customOrder?: string[];
  startDate: string;
  extraMinor: number;
}): StrategyResult {
  if (!isIsoDate(input.startDate)) throw new BudgetError("The start date must be YYYY-MM-DD.");
  assertMinor(input.extraMinor, "extra payment");
  if (input.extraMinor < 0) throw new BudgetError("The extra payment cannot be negative.");
  const debts = input.debts.map((debt) => ({ ...debt }));
  for (const debt of debts) {
    assertLoanNumbers(debt.balanceMinor, debt.aprBps, debt.minPaymentMinor, 0);
  }
  const order = orderDebts(debts, input.strategy, input.customOrder);
  const monthlyBudget = debts.filter((debt) => debt.balanceMinor > 0).reduce((sum, debt) => sum + debt.minPaymentMinor, 0) + input.extraMinor;
  const assumptions = [
    input.strategy === "snowball"
      ? "Snowball sends the amount above the minimums to the smallest remaining balance. Minimums continue on the other active debts."
      : input.strategy === "avalanche"
        ? "Avalanche sends the amount above the minimums to the highest APR. Minimums continue on the other active debts."
        : "Custom order sends the amount above the minimums in the sequence you chose. Minimums continue on the other active debts.",
    "The monthly budget stays at the starting minimums plus the extra amount. A debt that is paid off leaves its minimum in that budget for the debts that remain.",
    LOAN_MODEL_NOTE,
    "This plan does not move money or change a balance.",
  ];
  let month = 0;
  let totalInterest = 0;
  let totalPrincipal = 0;
  const timeline: StrategyResult["timeline"] = [];
  while (debts.some((debt) => debt.balanceMinor > 0) && month < MAX_MONTHS) {
    const date = addMonths(input.startDate, month);
    const active = debts.filter((debt) => debt.balanceMinor > 0);
    const interest = new Map(active.map((debt) => [debt.id, monthlyInterestMinor(debt.balanceMinor, debt.aprBps)]));
    const planned = new Map<string, number>();
    const room = (debt: Debt) => debt.balanceMinor + (interest.get(debt.id) ?? 0) - (planned.get(debt.id) ?? 0);
    let remaining = monthlyBudget;
    for (const debt of active) {
      const minPay = Math.min(debt.minPaymentMinor, Math.max(0, room(debt)), remaining);
      planned.set(debt.id, minPay);
      remaining -= minPay;
    }
    for (const debt of strategyTargets(active, input.strategy, input.customOrder)) {
      if (remaining <= 0) break;
      const extraPay = Math.min(Math.max(0, room(debt)), remaining);
      planned.set(debt.id, (planned.get(debt.id) ?? 0) + extraPay);
      remaining -= extraPay;
    }
    for (const debt of active) {
      const pay = planned.get(debt.id) ?? 0;
      const due = interest.get(debt.id) ?? 0;
      const principal = pay - due;
      const before = debt.balanceMinor;
      debt.balanceMinor = Math.max(0, debt.balanceMinor - principal);
      totalInterest += due;
      totalPrincipal += Math.max(0, before - debt.balanceMinor);
    }
    for (const debt of debts) {
      timeline.push({ date, debtId: debt.id, balanceMinor: debt.balanceMinor, paymentMinor: planned.get(debt.id) ?? 0 });
    }
    month += 1;
  }
  const paidOff = !debts.some((debt) => debt.balanceMinor > 0);
  if (!paidOff) assumptions.push("These payments do not clear the debts within 100 years. The interest total is only the months shown.");
  return {
    strategy: input.strategy,
    order,
    months: paidOff ? month : null,
    totalInterestMinor: totalInterest,
    totalPrincipalMinor: totalPrincipal,
    monthlyBudgetMinor: monthlyBudget,
    debtFreeDate: paidOff && month > 0 ? addMonths(input.startDate, month - 1) : paidOff ? input.startDate : null,
    paidOff,
    timeline,
    assumptions,
  };
}

function strategyTargets(active: Debt[], strategy: PayoffStrategy, customOrder?: string[]): Debt[] {
  if (strategy === "custom" && customOrder?.length) {
    const rank = new Map(customOrder.map((id, index) => [id, index]));
    return [...active].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  }
  return [...active].sort((a, b) => {
    if (strategy === "avalanche") return b.aprBps - a.aprBps || a.balanceMinor - b.balanceMinor;
    return a.balanceMinor - b.balanceMinor || b.aprBps - a.aprBps;
  });
}

function orderDebts(debts: Debt[], strategy: PayoffStrategy, customOrder?: string[]): string[] {
  return strategyTargets(debts, strategy, customOrder).map((debt) => debt.id);
}

export interface RefinanceInput {
  balanceMinor: number;
  aprBps: number;
  paymentMinor: number;
  newAprBps: number;
  newPaymentMinor?: number;
  newTermMonths?: number;
  /** Financed into the new principal. Kept so earlier callers still mean that. */
  feeMinor?: number;
  upfrontFeeMinor?: number;
  financedFeeMinor?: number;
  startDate: string;
}

export interface RefinanceComparison {
  current: AmortizationSummary;
  proposed: AmortizationSummary;
  currentInterestMinor: number | null;
  refinancedInterestMinor: number | null;
  /** Financed fee, matching the earlier field. Upfront fees are separate. */
  feeMinor: number;
  upfrontFeeMinor: number;
  financedFeeMinor: number;
  interestSavedMinor: number | null;
  netBenefitMinor: number | null;
  comparable: boolean;
  currentPaymentMinor: number;
  proposedPaymentMinor: number;
  paymentDifferenceMinor: number;
  currentPayoffDate: string | null;
  proposedPayoffDate: string | null;
  currentTotalCostMinor: number | null;
  proposedTotalCostMinor: number | null;
  breakEvenMonth: number | null;
  lowerPaymentCostsMore: boolean;
  assumptions: string[];
}

export function compareRefinance(input: RefinanceInput): RefinanceComparison {
  assertLoanNumbers(input.balanceMinor, input.aprBps, input.paymentMinor, 0);
  assertMinor(input.newAprBps, "new APR");
  if (input.newAprBps < 0) throw new BudgetError("The proposed rate cannot be negative.");
  const upfront = input.upfrontFeeMinor ?? 0;
  const financed = input.financedFeeMinor ?? input.feeMinor ?? 0;
  assertMinor(upfront, "upfront fee");
  assertMinor(financed, "financed fee");
  if (upfront < 0 || financed < 0) throw new BudgetError("Fees cannot be negative.");
  if (input.newPaymentMinor != null && input.newTermMonths != null) {
    throw new BudgetError("Choose a new payment or a new term, not both.");
  }
  if (input.newPaymentMinor == null && input.newTermMonths == null) {
    throw new BudgetError("Enter a new payment or a new term.");
  }
  if (!isIsoDate(input.startDate)) throw new BudgetError("The start date must be YYYY-MM-DD.");
  const newPrincipal = input.balanceMinor + financed;
  const proposedPayment = input.newTermMonths != null
    ? paymentForTerm(newPrincipal, input.newAprBps, input.newTermMonths)
    : input.newPaymentMinor ?? 0;
  if (input.newPaymentMinor != null) {
    assertMinor(input.newPaymentMinor, "new payment");
    if (input.newPaymentMinor < 0) throw new BudgetError("The proposed payment cannot be negative.");
  }
  const current = amortize(
    { id: "current", name: "Current", balanceMinor: input.balanceMinor, aprBps: input.aprBps, minPaymentMinor: input.paymentMinor },
    input.startDate,
  );
  const proposed = amortize(
    { id: "new", name: "Refinance", balanceMinor: newPrincipal, aprBps: input.newAprBps, minPaymentMinor: proposedPayment },
    input.startDate,
  );
  const comparable = current.paidOff && proposed.paidOff;
  const currentCost = comparable ? current.totalPaidMinor : null;
  const proposedCost = comparable ? proposed.totalPaidMinor + upfront : null;
  const net = currentCost != null && proposedCost != null ? currentCost - proposedCost : null;
  const interestSaved = comparable ? current.totalInterestMinor - proposed.totalInterestMinor : null;
  const lowerPaymentCostsMore = comparable && proposedPayment < input.paymentMinor && (net ?? 0) < 0;
  const assumptions = [
    "Upfront fees are paid at the start and are not added to the new principal. Financed fees are added to the new principal once and are not counted again.",
    LOAN_MODEL_NOTE,
    "Choosing this comparison does not submit a loan application, refinance the loan, or change the balance.",
  ];
  if (!comparable) {
    assumptions.push("One side does not pay off within 100 years, so the interest totals are not a full lifetime comparison.");
  } else if (lowerPaymentCostsMore) {
    assumptions.push("The new payment is lower, and the longer loan costs more overall. The lower payment is not savings.");
  } else if ((net ?? 0) > 0) {
    assumptions.push("The modeled benefit is the current total future cost minus the proposed total future cost, including upfront fees.");
  } else if ((net ?? 0) < 0) {
    assumptions.push("The proposed loan costs more over its life in this model. That amount is an additional cost, not savings.");
  }
  return {
    current,
    proposed,
    currentInterestMinor: comparable ? current.totalInterestMinor : null,
    refinancedInterestMinor: comparable ? proposed.totalInterestMinor : null,
    feeMinor: financed,
    upfrontFeeMinor: upfront,
    financedFeeMinor: financed,
    interestSavedMinor: interestSaved,
    netBenefitMinor: net,
    comparable,
    currentPaymentMinor: input.paymentMinor,
    proposedPaymentMinor: proposedPayment,
    paymentDifferenceMinor: proposedPayment - input.paymentMinor,
    currentPayoffDate: current.payoffDate,
    proposedPayoffDate: proposed.payoffDate,
    currentTotalCostMinor: currentCost,
    proposedTotalCostMinor: proposedCost,
    breakEvenMonth: comparable && net != null && net > 0 ? breakEvenMonth(current, proposed, upfront) : null,
    lowerPaymentCostsMore,
    assumptions,
  };
}

function breakEvenMonth(current: AmortizationSummary, proposed: AmortizationSummary, upfrontMinor: number): number | null {
  const months = Math.max(current.months.length, proposed.months.length);
  let currentPaid = 0;
  let proposedPaid = upfrontMinor;
  for (let index = 0; index < months; index += 1) {
    currentPaid += current.months[index]?.paymentMinor ?? 0;
    proposedPaid += proposed.months[index]?.paymentMinor ?? 0;
    if (proposedPaid <= currentPaid) return index + 1;
  }
  return null;
}

export interface LoanPaymentDraft {
  cash: {
    accountId: string;
    amountMinor: number;
    type: "loan_payment";
    payee: string;
    notes: string;
    splits: Split[];
  };
  reduction: {
    accountId: string;
    amountMinor: number;
    type: "loan_payment";
    payee: string;
    notes: string;
    splits: Split[];
  } | null;
}

/** A real payment: cash leaves with principal, interest, and fee splits, and only principal reduces the loan. */
export function buildLoanPayment(input: {
  cashAccountId: string;
  loanAccountId: string;
  principalMinor: number;
  interestMinor: number;
  feeMinor: number;
  bucketId?: string | null;
}): LoanPaymentDraft {
  for (const [label, value] of [
    ["principal", input.principalMinor],
    ["interest", input.interestMinor],
    ["fee", input.feeMinor],
  ] as const) {
    assertMinor(value, label);
    if (value < 0) throw new BudgetError(`The ${label} cannot be negative.`);
  }
  const total = input.principalMinor + input.interestMinor + input.feeMinor;
  if (total <= 0) throw new BudgetError("Enter a payment amount.");
  const bucketId = input.bucketId ?? null;
  const splits: Split[] = [];
  if (input.principalMinor > 0) splits.push({ bucketId: null, amountMinor: input.principalMinor, role: "principal" });
  if (input.interestMinor > 0) splits.push({ bucketId, amountMinor: input.interestMinor, role: "interest" });
  if (input.feeMinor > 0) splits.push({ bucketId, amountMinor: input.feeMinor, role: "fee" });
  return {
    cash: {
      accountId: input.cashAccountId,
      amountMinor: -total,
      type: "loan_payment",
      payee: "Loan payment",
      notes: "Principal is not spending. Interest and fees are the cost. This payment was recorded on purpose and is separate from a loan plan.",
      splits,
    },
    reduction: input.principalMinor > 0
      ? {
          accountId: input.loanAccountId,
          amountMinor: input.principalMinor,
          type: "loan_payment",
          payee: "Principal reduction",
          notes: "This is the principal portion of the loan payment. It is not a second expense.",
          splits: [{ bucketId: null, amountMinor: input.principalMinor, role: "principal" }],
        }
      : null,
  };
}

function assertLoanNumbers(balanceMinor: number, aprBps: number, paymentMinor: number, extraMinor: number): void {
  assertMinor(balanceMinor, "balance");
  assertMinor(aprBps, "APR");
  assertMinor(paymentMinor, "payment");
  assertMinor(extraMinor, "extra payment");
  if (balanceMinor < 0 || aprBps < 0 || paymentMinor < 0 || extraMinor < 0) {
    throw new BudgetError("Balance, rate, and payment amounts cannot be negative.");
  }
}
