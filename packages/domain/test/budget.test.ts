import { describe, expect, it } from "vitest";
import { answerFinanceQuestion } from "../src/assistant.js";
import {
  ageOfMoney,
  computeBudget,
  evaluateIncomePlan,
  explainReadyToAssign,
  moveAssignment,
  neededForTarget,
  previewAutoAssign,
  spendGuidance,
  uncoveredOutflows,
  validateTransaction,
} from "../src/budget.js";
import { monthlyInterestMinor, sanitizeSpreadsheetCell } from "../src/money.js";
import { amortize, compareRefinance, payoffPlan } from "../src/debt.js";
import { applyScenario, planPaychecks, projectCash } from "../src/forecast.js";
import { duplicateKey, mapCsv, parseOfx, parseQif, toCsv } from "../src/importers.js";
import { allocation, allocationByKey, allocationDrift, feeImpact, moneyWeightedReturn, positionView, timeWeightedReturn } from "../src/invest.js";
import { projectRetirement } from "../src/retirement.js";
import { cashFlowSankey, emergencyGap, evaluateWatchlist, incomeRows, netWorth, savingsRate, spendingRows } from "../src/reports.js";
import { applyRules } from "../src/rules.js";
import { mergeProviderTransaction, unseenOps } from "../src/sync.js";
import { monthPeriod } from "../src/dates.js";
import type { Account, Assignment, Bucket, EngineInput, Transaction } from "../src/types.js";

function account(partial: Partial<Account> & Pick<Account, "id" | "kind">): Account {
  return {
    name: partial.id,
    currency: "USD",
    onBudget: partial.kind === "checking" || partial.kind === "savings" || partial.kind === "cash" || partial.kind === "credit",
    ...partial,
  };
}

function bucket(partial: Partial<Bucket> & Pick<Bucket, "id" | "name">): Bucket {
  return {
    group: "Spending",
    kind: "expense",
    flexRole: "flexible",
    envelopeStyle: "regular",
    rollover: "both",
    ...partial,
  };
}

function txn(partial: Partial<Transaction> & Pick<Transaction, "id" | "amountMinor" | "type" | "accountId">): Transaction {
  return {
    date: "2026-11-05",
    currency: "USD",
    payee: partial.type,
    splits: [],
    bankStatus: "posted",
    reviewStatus: "reviewed",
    ...partial,
  };
}

function base(extra: Partial<EngineInput> = {}): EngineInput {
  return {
    currency: "USD",
    asOf: "2026-11-20",
    accounts: [],
    buckets: [],
    transactions: [],
    assignments: [],
    ...extra,
  };
}

describe("money invariants", () => {
  it("rejects fractional minor units", () => {
    expect(() => validateTransaction(txn({ id: "x", amountMinor: 1.5, type: "expense", accountId: "c" }), [account({ id: "c", kind: "checking" })], "USD")).toThrow(/integer/);
  });

  it("keeps a funded card split from being spent twice", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const card = account({ id: "card", kind: "credit" });
    const groceries = bucket({ id: "g", name: "Groceries" });
    const household = bucket({ id: "h", name: "Household" });
    const reserve = bucket({ id: "cc", name: "Card payment", systemRole: "cc_reserve", linkedAccountId: "card", flexRole: "reserve" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const input = base({
      accounts: [checking, card],
      buckets: [groceries, household, reserve, borrowed],
      transactions: [
        txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 100_000, payee: "Opening" }),
        txn({
          id: "buy",
          type: "expense",
          accountId: "card",
          amountMinor: -10_000,
          payee: "Market",
          splits: [
            { bucketId: "g", amountMinor: 6_000, role: "expense" },
            { bucketId: "h", amountMinor: 4_000, role: "expense" },
          ],
        }),
        txn({ id: "pay", type: "cc_payment", accountId: "chk", counterAccountId: "card", amountMinor: -10_000, payee: "Card payment" }),
      ],
      assignments: [
        { id: "a1", bucketId: "g", periodKey: "2026-11", amountMinor: 6_000 },
        { id: "a2", bucketId: "h", periodKey: "2026-11", amountMinor: 4_000 },
      ],
    });
    const result = computeBudget(input);
    expect(result.identityDifferenceMinor).toBe(0);
    expect(result.spendingMinor).toBe(10_000);
    expect(result.incomeMinor).toBe(0);
    expect(result.buckets.find((row) => row.bucketId === "g")?.availableMinor).toBe(0);
    expect(result.buckets.find((row) => row.bucketId === "h")?.availableMinor).toBe(0);
    expect(result.buckets.find((row) => row.bucketId === "cc")?.availableMinor).toBe(0);
    expect(result.cashPoolMinor).toBe(90_000);
    expect(result.readyToAssignMinor).toBe(90_000);
    const spend = spendingRows(input, "2026-11-01", "2026-11-30", (_t, bucketId) => bucketId ?? "?");
    expect(spend.reduce((s, row) => s + row.amountMinor, 0)).toBe(10_000);
    expect(incomeRows(input, "2026-11-01", "2026-11-30")).toHaveLength(0);
  });

  it("does not treat a refund as income", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const groceries = bucket({ id: "g", name: "Groceries" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const input = base({
      accounts: [checking],
      buckets: [groceries, borrowed],
      transactions: [
        txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 10_000 }),
        txn({ id: "buy", type: "expense", accountId: "chk", amountMinor: -5_000, splits: [{ bucketId: "g", amountMinor: 5_000, role: "expense" }] }),
        txn({ id: "back", type: "refund", accountId: "chk", amountMinor: 2_000, payee: "Market refund", splits: [{ bucketId: "g", amountMinor: 2_000, role: "refund" }] }),
      ],
      assignments: [{ id: "a", bucketId: "g", periodKey: "2026-11", amountMinor: 10_000 }],
    });
    const result = computeBudget(input);
    expect(result.identityDifferenceMinor).toBe(0);
    expect(result.incomeMinor).toBe(0);
    expect(result.spendingMinor).toBe(3_000);
    expect(result.refundMinor).toBe(2_000);
    expect(incomeRows(input, "2026-11-01", "2026-11-30")).toHaveLength(0);
  });

  it("leaves expected income out of Ready to Assign", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const result = computeBudget(base({
      accounts: [checking],
      buckets: [borrowed],
      transactions: [txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 20_000 })],
      schedules: [{ id: "pay", name: "Paycheck", cadence: "biweekly", nextDate: "2026-11-25", amountMinor: 200_000, direction: "inflow", type: "income" }],
    }));
    expect(result.readyToAssignMinor).toBe(20_000);
    expect(result.incomeMinor).toBe(0);
    const plan = evaluateIncomePlan(
      [{ id: "p", bucketId: "rent", periodKey: "2026-11", plannedMinor: 150_000 }],
      200_000,
      "2026-11",
    );
    expect(plan.balanced).toBe(false);
    expect(plan.note).toMatch(/not fund/);
  });

  it("computes the documented safe-to-spend example", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const bills = bucket({ id: "bills", name: "Bills", flexRole: "fixed" });
    const goal = bucket({ id: "goal", name: "Goal", flexRole: "reserve", purpose: "goal" });
    const buffer = bucket({ id: "buffer", name: "Buffer", flexRole: "reserve", systemRole: "buffer" });
    const borrowed = bucket({ id: "borrowed", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const assignments: Assignment[] = [
      { id: "1", bucketId: "bills", periodKey: "2026-11", amountMinor: 30_000 },
      { id: "2", bucketId: "goal", periodKey: "2026-11", amountMinor: 20_000 },
      { id: "3", bucketId: "buffer", periodKey: "2026-11", amountMinor: 10_000 },
    ];
    const result = computeBudget(base({
      accounts: [checking],
      buckets: [bills, goal, buffer, borrowed],
      transactions: [txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 100_000 })],
      assignments,
    }));
    expect(result.identityDifferenceMinor).toBe(0);
    expect(result.readyToAssignMinor).toBe(40_000);
    const guidance = spendGuidance({
      result,
      buckets: [bills, goal, buffer, borrowed],
      uncoveredBillsMinor: uncoveredOutflows([{ bucketId: "bills", amountMinor: 30_000 }], result, [bills, goal, buffer, borrowed]),
      expectedIncomeMinor: 50_000,
      daysRemaining: 10,
    });
    expect(guidance.cashSafeMinor).toBe(40_000);
    expect(guidance.shortageMinor).toBe(0);
    expect(guidance.primaryFigure).toBe("cash");
    expect(guidance.projectedAllowanceMinor).toBe(90_000);
    const tight = spendGuidance({
      result,
      buckets: [bills, goal, buffer, borrowed],
      uncoveredBillsMinor: 50_000,
      expectedIncomeMinor: 80_000,
      daysRemaining: 10,
    });
    expect(tight.primaryFigure).toBe("shortage");
    expect(tight.shortageMinor).toBe(10_000);
    expect(tight.cashSafeMinor).toBe(0);
  });

  it("parks loan proceeds outside income", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const loan = account({ id: "loan", kind: "loan", onBudget: false });
    const borrowed = bucket({ id: "borrowed", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const result = computeBudget(base({
      accounts: [checking, loan],
      buckets: [borrowed],
      transactions: [
        txn({ id: "draw", type: "loan_proceeds", accountId: "chk", counterAccountId: "loan", amountMinor: 500_000, payee: "Loan" }),
      ],
    }));
    expect(result.incomeMinor).toBe(0);
    expect(result.readyToAssignMinor).toBe(0);
    expect(result.borrowedFundsMinor).toBe(500_000);
    expect(result.identityDifferenceMinor).toBe(0);
    expect(incomeRows(base({
      accounts: [checking, loan],
      buckets: [borrowed],
      transactions: [txn({ id: "draw", type: "loan_proceeds", accountId: "chk", counterAccountId: "loan", amountMinor: 500_000, payee: "Loan" })],
    }), "2026-11-01", "2026-11-30")).toHaveLength(0);
  });

  it("keeps a foreign-currency account out of the dollar pool", () => {
    const usd = account({ id: "usd", kind: "checking" });
    const eur = account({ id: "eur", kind: "checking", currency: "EUR" });
    const borrowed = bucket({ id: "borrowed", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const result = computeBudget(base({
      accounts: [usd, eur],
      buckets: [borrowed],
      transactions: [
        txn({ id: "usd", type: "opening", accountId: "usd", amountMinor: 10_000 }),
        txn({ id: "eur", type: "opening", accountId: "eur", amountMinor: 99_000, currency: "EUR" }),
      ],
    }));
    expect(result.cashPoolMinor).toBe(10_000);
    expect(result.readyToAssignMinor).toBe(10_000);
    expect(result.identityDifferenceMinor).toBe(0);
  });

  it("reserves future-month assignments without creating cash", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const groceries = bucket({ id: "g", name: "Groceries" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const result = computeBudget(base({
      accounts: [checking],
      buckets: [groceries, borrowed],
      transactions: [txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 100_000 })],
      assignments: [
        { id: "now", bucketId: "g", periodKey: "2026-11", amountMinor: 40_000 },
        { id: "later", bucketId: "g", periodKey: "2026-12", amountMinor: 20_000 },
      ],
    }));
    expect(result.readyToAssignMinor).toBe(40_000);
    expect(result.futureAssignedMinor).toBe(20_000);
    expect(result.identityDifferenceMinor).toBe(0);
    const december = computeBudget({ ...base({
      accounts: [checking],
      buckets: [groceries, borrowed],
      transactions: [txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 100_000 })],
      assignments: [
        { id: "now", bucketId: "g", periodKey: "2026-11", amountMinor: 40_000 },
        { id: "later", bucketId: "g", periodKey: "2026-12", amountMinor: 20_000 },
      ],
    }), viewPeriod: "2026-12" });
    expect(december.buckets.find((row) => row.bucketId === "g")?.availableMinor).toBe(60_000);
    expect(december.identityDifferenceMinor).toBe(0);
  });

  it("explains Ready to Assign from the same cash", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const result = computeBudget(base({
      accounts: [checking],
      buckets: [borrowed],
      transactions: [txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 5_000 })],
    }));
    const explained = explainReadyToAssign(result);
    expect(explained.amountMinor).toBe(5_000);
    expect(explained.formula).toMatch(/Expected paychecks/);
  });
});

describe("cash, debt, and forecasts", () => {
  it("catches a bill due before payday without spending the paycheck early", () => {
    const plan = planPaychecks({
      asOf: "2026-11-01",
      startingCashMinor: 50_000,
      paychecks: [{ id: "p", date: "2026-11-11", amountMinor: 100_000, received: false, earner: "Alex" }],
      obligations: [{ id: "rent", date: "2026-11-06", amountMinor: 60_000, name: "Rent", reservedMinor: 0 }],
    });
    expect(plan.beforeNext.shortageMinor).toBe(10_000);
    expect(plan.beforeNext.obligations.map((bill) => bill.name)).toEqual(["Rent"]);
    const forecast = projectCash({
      startingMinor: 50_000,
      startDate: "2026-11-01",
      days: 15,
      includeExpectedIncome: false,
      events: [
        { id: "rent", date: "2026-11-06", amountMinor: -60_000, label: "Rent", kind: "expense" },
        { id: "pay", date: "2026-11-11", amountMinor: 100_000, label: "Paycheck", kind: "income", expectedIncome: true },
      ],
    });
    expect(forecast.overdraftDate).toBe("2026-11-06");
    expect(forecast.minimumMinor).toBe(-10_000);
    const withPay = projectCash({ ...{
      startingMinor: 50_000,
      startDate: "2026-11-01",
      days: 15,
      events: forecast.points.length ? [
        { id: "rent", date: "2026-11-06", amountMinor: -60_000, label: "Rent", kind: "expense" as const },
        { id: "pay", date: "2026-11-11", amountMinor: 100_000, label: "Paycheck", kind: "income" as const, expectedIncome: true },
      ] : [],
      includeExpectedIncome: true,
    } });
    expect(withPay.endingMinor).toBe(90_000);
    const scenario = applyScenario(
      [{ id: "rent", date: "2026-11-06", amountMinor: -60_000, label: "Rent", kind: "expense" }],
      [{ id: "cut", label: "Cancel subscription", date: "2026-11-08", amountMinor: 2_000, kind: "income" }],
    );
    expect(scenario).toHaveLength(2);
    expect(scenario[0].amountMinor).toBe(-60_000);
  });

  it("reproduces a known amortization and shortens it with extra principal", () => {
    expect(monthlyInterestMinor(100_000, 1200)).toBe(1_000);
    const baseLoan = amortize({ id: "d", name: "Loan", balanceMinor: 100_000, aprBps: 1200, minPaymentMinor: 10_000 }, "2026-11-01");
    expect(baseLoan.months[0].interestMinor).toBe(1_000);
    expect(baseLoan.months[0].principalMinor).toBe(9_000);
    expect(baseLoan.months[0].balanceMinor).toBe(91_000);
    const extra = amortize({ id: "d", name: "Loan", balanceMinor: 100_000, aprBps: 1200, minPaymentMinor: 10_000, extraMinor: 5_000 }, "2026-11-01");
    expect(extra.totalInterestMinor).toBeLessThan(baseLoan.totalInterestMinor);
    expect(extra.payoffMonths!).toBeLessThan(baseLoan.payoffMonths!);
    const snow = payoffPlan({
      startDate: "2026-11-01",
      extraMinor: 5_000,
      strategy: "snowball",
      debts: [
        { id: "big", name: "Big", balanceMinor: 80_000, aprBps: 2000, minPaymentMinor: 2_000 },
        { id: "small", name: "Small", balanceMinor: 20_000, aprBps: 1000, minPaymentMinor: 1_000 },
      ],
    });
    expect(snow.order[0]).toBe("small");
    const ava = payoffPlan({
      startDate: "2026-11-01",
      extraMinor: 5_000,
      strategy: "avalanche",
      debts: [
        { id: "big", name: "Big", balanceMinor: 80_000, aprBps: 2000, minPaymentMinor: 2_000 },
        { id: "small", name: "Small", balanceMinor: 20_000, aprBps: 1000, minPaymentMinor: 1_000 },
      ],
    });
    expect(ava.order[0]).toBe("big");
    const refi = compareRefinance({
      balanceMinor: 100_000,
      aprBps: 1800,
      paymentMinor: 10_000,
      newAprBps: 600,
      newPaymentMinor: 10_000,
      feeMinor: 1_000,
      startDate: "2026-11-01",
    });
    expect(refi.assumptions[0]).toMatch(/fee/);
    expect(refi.netBenefitMinor).not.toBe(0);
  });

  it("ages cash with first-in first-out and says what that means", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const age = ageOfMoney(base({
      asOf: "2026-11-20",
      accounts: [checking],
      buckets: [borrowed],
      transactions: [
        txn({ id: "in", type: "income", accountId: "chk", amountMinor: 10_000, date: "2026-11-01", payee: "Job" }),
        txn({ id: "out", type: "expense", accountId: "chk", amountMinor: -10_000, date: "2026-11-11", payee: "Store", splits: [{ bucketId: null, amountMinor: 10_000, role: "expense" }] }),
      ],
    }));
    expect(age.days).toBe(10);
    expect(age.formula).toMatch(/not a liquidity guarantee/i);
  });
});

describe("reports, investments, retirement, rules, import, sync", () => {
  it("ties a report total to the underlying transactions and skips transfers", () => {
    const checking = account({ id: "chk", kind: "checking" });
    const savings = account({ id: "sav", kind: "savings" });
    const input = base({
      accounts: [checking, savings],
      transactions: [
        txn({ id: "in", type: "income", accountId: "chk", amountMinor: 50_000, payee: "Job" }),
        txn({ id: "gro", type: "expense", accountId: "chk", amountMinor: -12_000, payee: "Market", splits: [{ bucketId: "g", amountMinor: 12_000, role: "expense" }] }),
        txn({ id: "move", type: "transfer", accountId: "chk", counterAccountId: "sav", amountMinor: -8_000, payee: "Savings" }),
      ],
    });
    const rows = spendingRows(input, "2026-11-01", "2026-11-30", () => "Groceries");
    expect(rows[0].amountMinor).toBe(12_000);
    expect(rows[0].transactionIds).toEqual(["gro"]);
    expect(savingsRate(50_000, 12_000).rateBps).toBe(7600);
    const worth = netWorth(input);
    expect(worth.netMinor).toBe(38_000);
    expect(worth.formula).toMatch(/not filled in/i);
    expect(cashFlowSankey(input, "2026-11-01", "2026-11-30").links.length).toBeGreaterThan(0);
  });

  it("does not invent a market price and separates flows from performance", () => {
    const missing = positionView({
      id: "h",
      accountId: "brk",
      symbol: "VTI",
      name: "Total market",
      assetClass: "Equity",
      quantity: "10",
      costBasisMinor: 200_000,
      currency: "USD",
    });
    expect(missing.marketValueMinor).toBeNull();
    expect(missing.missing.join(" ")).toMatch(/does not invent/);
    const priced = positionView(
      { id: "h", accountId: "brk", symbol: "VTI", name: "Total market", assetClass: "Equity", quantity: "10.5", costBasisMinor: 200_000, currency: "USD" },
      { symbol: "VTI", priceMinor: 2_500, asOf: "2026-11-10", source: "manual", delayed: false, currency: "USD" },
    );
    expect(priced.marketValueMinor).toBe(26_250);
    expect(priced.quoteSource).toBe("manual");
    const foreign = positionView(
      { id: "h", accountId: "brk", symbol: "VTI", name: "Total market", assetClass: "Equity", quantity: "10", costBasisMinor: null, currency: "USD" },
      { symbol: "VTI", priceMinor: 2_500, asOf: "2026-11-10", source: "manual", delayed: false, currency: "EUR" },
    );
    expect(foreign.marketValueMinor).toBeNull();
    expect(foreign.unrealizedMinor).toBeNull();
    expect(foreign.missing.join(" ")).toMatch(/not combined/);
    const grouped = allocationByKey([
      { key: "Equity", valueMinor: 2_000 },
      { key: "Equity", valueMinor: 1_000 },
      { key: "Bond", valueMinor: 2_000 },
    ]);
    expect(grouped.find((row) => row.key === "Equity")).toEqual({ key: "Equity", valueMinor: 3_000, weightBps: 6_000 });
    expect(grouped.find((row) => row.key === "Bond")?.weightBps).toBe(4_000);
    const twr = timeWeightedReturn([
      { date: "2026-01-01", valueMinor: 100_000, externalFlowMinor: 0 },
      { date: "2026-07-01", valueMinor: 150_000, externalFlowMinor: 40_000 },
      { date: "2026-11-01", valueMinor: 160_000, externalFlowMinor: 0 },
    ]);
    expect(twr.rate).toBeCloseTo(150_000 / 140_000 * (160_000 / 150_000) - 1, 6);
    const mwr = moneyWeightedReturn([
      { date: "2026-01-01", amountMinor: -100_000 },
      { date: "2026-12-31", amountMinor: 110_000 },
    ]);
    expect(mwr.rate).toBeGreaterThan(0.09);
    expect(mwr.rate).toBeLessThan(0.11);
    const fees = feeImpact({ balanceMinor: 100_000, expenseRatioBps: 50, advisoryBps: 50, growthBps: 500, years: 10 });
    expect(fees.compoundFeeCostMinor).toBeGreaterThan(0);
    const slices = allocation([
      { key: "Equity", valueMinor: 60_000 },
      { key: "Bonds", valueMinor: 40_000 },
    ]);
    expect(allocationDrift(slices, [{ key: "Equity", targetBps: 5000 }, { key: "Bonds", targetBps: 5000 }]).find((row) => row.key === "Equity")?.driftBps).toBe(1000);
  });

  it("replays a seeded retirement trial and labels it as a model", () => {
    const once = projectRetirement({
      people: [{ currentAge: 40, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 40,
      endAge: 50,
      portfolioMinor: 1_000_000,
      annualContributionMinor: 100_000,
      annualSpendingMinor: 0,
      inflationBps: 0,
      meanReturnBps: 0,
      stdevBps: 0,
      feeBps: 0,
      iterations: 20,
      seed: 7,
    });
    const twice = projectRetirement({
      people: [{ currentAge: 40, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 40,
      endAge: 50,
      portfolioMinor: 1_000_000,
      annualContributionMinor: 100_000,
      annualSpendingMinor: 0,
      inflationBps: 0,
      meanReturnBps: 0,
      stdevBps: 0,
      feeBps: 0,
      iterations: 20,
      seed: 7,
    });
    expect(once.deterministicEndingMinor).toBe(twice.deterministicEndingMinor);
    expect(once.assumptions.join(" ")).toMatch(/not a promise/);
    expect(once.assumptions.join(" ")).toMatch(/not a promise/);
    expect(emergencyGap(200_000, 3, 100_000).gapMinor).toBe(500_000);
  });

  it("lets a confirmed category beat a broader rule", () => {
    const applied = applyRules(
      txn({
        id: "t",
        type: "expense",
        accountId: "chk",
        amountMinor: -4_000,
        payee: "Cafe",
        categoryLockedByUser: true,
        splits: [{ bucketId: "coffee", amountMinor: 4_000, role: "expense" }],
      }),
      [{
        id: "r",
        name: "All cafes",
        priority: 10,
        enabled: true,
        matchMode: "all",
        conditions: [{ field: "payee", op: "contains", value: "cafe" }],
        actions: [{ type: "set_bucket", value: "restaurants" }],
      }],
    );
    expect(applied.transaction.splits[0].bucketId).toBe("coffee");
    expect(applied.skipped.length).toBe(1);
  });

  it("previews imports, preserves duplicate keys, and neutralizes spreadsheet formulas", () => {
    const rows = mapCsv("Date,Payee,Amount\n11/02/2026,Market,-12.50\n", { date: "Date", payee: "Payee", amount: "Amount" });
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].amountMinor).toBe(-1250);
    expect(rows[0].duplicateKey).toBe(duplicateKey({ date: "2026-11-02", amountMinor: -1250, description: "Market", account: "" }));
    const ofx = parseOfx("<STMTTRN><DTPOSTED>20261103</DTPOSTED><TRNAMT>-4.25</TRNAMT><FITID>abc</FITID><NAME>Bus</NAME></STMTTRN>");
    expect(ofx[0]).toMatchObject({ date: "2026-11-03", amountMinor: -425, fitId: "abc" });
    const qif = parseQif("D11/04/2026\nT25.00\nPPayroll\n^\n");
    expect(qif[0].amountMinor).toBe(2500);
    expect(toCsv([{ Payee: "=cmd()", Amount: 1 }])).toContain("'=cmd()");
    expect(sanitizeSpreadsheetCell("+1")).toBe("'+1");
  });

  it("updates a pending provider transaction in place", () => {
    const pending = txn({ id: "local", type: "expense", accountId: "chk", amountMinor: -500, bankStatus: "pending", providerTransactionId: "fit-1", notes: "kept", categoryLockedByUser: true, splits: [{ bucketId: "g", amountMinor: 500, role: "expense" }] });
    const posted = txn({ id: "other", type: "expense", accountId: "chk", amountMinor: -525, bankStatus: "posted", providerTransactionId: "fit-1", payee: "Store changed", splits: [{ bucketId: "other", amountMinor: 525, role: "expense" }] });
    const once = mergeProviderTransaction([pending], posted);
    const twice = mergeProviderTransaction(once.transactions, posted);
    expect(once.action).toBe("update");
    expect(twice.transactions).toHaveLength(1);
    expect(twice.transactions[0].id).toBe("local");
    expect(twice.transactions[0].notes).toBe("kept");
    expect(twice.transactions[0].splits[0].bucketId).toBe("g");
    expect(twice.transactions[0].bankStatus).toBe("posted");
    expect(unseenOps([{ opId: "op", kind: "create", transaction: pending }, { opId: "op", kind: "create", transaction: pending }], [])).toHaveLength(1);
  });

  it("refuses to invent an answer without a fact", () => {
    const answer = answerFinanceQuestion("what is my safe to spend?", []);
    expect(answer.missing).toContain("safe_to_spend");
    expect(answer.text).toMatch(/don't have/);
    const known = answerFinanceQuestion("what can I spend?", [{ id: "safe_to_spend", label: "Safe", amountMinor: 4000, text: "$40.00", formula: "cash minus reserves", asOf: "2026-11-10" }]);
    expect(known.facts[0].formula).toMatch(/reserves/);
  });

  it("fills a refill target only up to the funded cash", () => {
    const groceries = bucket({ id: "g", name: "Groceries", target: { type: "refill", amountMinor: 30_000, cadence: "monthly" } });
    const checking = account({ id: "chk", kind: "checking" });
    const borrowed = bucket({ id: "b", name: "Borrowed", systemRole: "borrowed_funds", flexRole: "reserve" });
    const result = computeBudget(base({
      accounts: [checking],
      buckets: [groceries, borrowed],
      transactions: [txn({ id: "open", type: "opening", accountId: "chk", amountMinor: 10_000 })],
    }));
    expect(neededForTarget(groceries, 0, 0)).toBe(30_000);
    const preview = previewAutoAssign({ result, buckets: [groceries, borrowed], strategy: "underfunded" });
    expect(preview.lines[0].amountMinor).toBe(10_000);
    expect(preview.unfundedMinor).toBe(20_000);
    expect(preview.explanation).toMatch(/not enough|No funded/);
    const moved = moveAssignment([], null, "g", "2026-11", 10_000, () => "id");
    expect(moved[0].amountMinor).toBe(10_000);
    expect(monthPeriod(2024, 2).end).toBe("2024-02-29");
  });

  it("sizes a percent target from posted income only", () => {
    const groceries = bucket({ id: "g", name: "Groceries", target: { type: "set_aside", amountMinor: 0, cadence: "monthly", percentBps: 1000 } });
    expect(neededForTarget(groceries, 0, 0, 1, 200_000)).toBe(20_000);
    expect(neededForTarget(groceries, 0, 5_000, 1, 200_000)).toBe(15_000);
    expect(neededForTarget(groceries, 0, 0, 1, 0)).toBe(0);
  });

  it("evaluates a watchlist from real rows only", () => {
    const input = base({
      transactions: [
        txn({ id: "1", type: "expense", accountId: "chk", amountMinor: -4_000, payee: "StreamCo", date: "2026-11-02", tags: ["subs"] }),
        txn({ id: "2", type: "refund", accountId: "chk", amountMinor: 1_000, payee: "StreamCo", date: "2026-11-04", tags: ["subs"], splits: [{ bucketId: null, amountMinor: 1_000, role: "refund" }] }),
      ],
    });
    const watch = evaluateWatchlist({ id: "w", name: "Streaming", payees: ["streamco"], tags: ["subs"] }, input, "2026-11-20");
    expect(watch.actualMinor).toBe(3_000);
    expect(watch.transactionIds).toEqual(["1", "2"]);
    expect(watch.formula).toMatch(/does not invent/);
  });
});
