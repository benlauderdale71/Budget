import { describe, expect, it } from "vitest";
import { computeBudget, displayBalance, validateTransaction } from "../src/budget.js";
import { addMonths } from "../src/dates.js";
import { amortize, buildLoanPayment, combineLoanEvents, compareRefinance, paymentForTerm, payoffPlan } from "../src/debt.js";
import type { Account, EngineInput, Transaction } from "../src/types.js";

function account(partial: Partial<Account> & Pick<Account, "id" | "kind">): Account {
  return {
    name: partial.id,
    currency: "USD",
    onBudget: partial.kind === "checking" || partial.kind === "savings" || partial.kind === "cash",
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

function engine(extra: Partial<EngineInput> = {}): EngineInput {
  return { currency: "USD", asOf: "2026-11-20", accounts: [], buckets: [], transactions: [], assignments: [], ...extra };
}

describe("debt payoff budget", () => {
  const debts = [
    { id: "a", name: "A", balanceMinor: 10_000, aprBps: 0, minPaymentMinor: 10_000 },
    { id: "b", name: "B", balanceMinor: 50_000, aprBps: 0, minPaymentMinor: 10_000 },
  ];

  it("keeps a paid-off minimum in the monthly budget", () => {
    const plan = payoffPlan({ debts, strategy: "snowball", extraMinor: 0, startDate: "2026-01-01" });
    expect(plan.monthlyBudgetMinor).toBe(20_000);
    expect(plan.totalInterestMinor).toBe(0);
    expect(plan.totalPrincipalMinor).toBe(60_000);
    expect(plan.months).toBe(3);
    expect(plan.paidOff).toBe(true);
    expect(plan.debtFreeDate).toBe("2026-03-01");
    const paid = (month: number, id: string) => plan.timeline.find((row) => row.date === addMonths("2026-01-01", month) && row.debtId === id)?.paymentMinor;
    expect(paid(0, "a")).toBe(10_000);
    expect(paid(0, "b")).toBe(10_000);
    expect(paid(1, "a")).toBe(0);
    expect(paid(1, "b")).toBe(20_000);
    expect(paid(2, "b")).toBe(20_000);
    expect(plan.timeline.find((row) => row.date === "2026-03-01" && row.debtId === "b")?.balanceMinor).toBe(0);
  });

  it("does not drop the budget when the debt order changes", () => {
    for (const strategy of ["snowball", "avalanche", "custom"] as const) {
      const plan = payoffPlan({
        debts,
        strategy,
        customOrder: strategy === "custom" ? ["b", "a"] : undefined,
        extraMinor: 0,
        startDate: "2026-01-01",
      });
      expect(plan.totalPrincipalMinor).toBe(60_000);
      expect(plan.months).toBe(3);
      const monthOne = plan.timeline.filter((row) => row.date === "2026-01-01").reduce((sum, row) => sum + row.paymentMinor, 0);
      const monthTwo = plan.timeline.filter((row) => row.date === "2026-02-01").reduce((sum, row) => sum + row.paymentMinor, 0);
      expect(monthOne).toBe(20_000);
      expect(monthTwo).toBe(20_000);
    }
  });

  it("sends an unused minimum to the other debt in the same month", () => {
    const plan = payoffPlan({
      debts: [
        { id: "a", name: "A", balanceMinor: 10_000, aprBps: 0, minPaymentMinor: 50_000 },
        { id: "b", name: "B", balanceMinor: 50_000, aprBps: 0, minPaymentMinor: 10_000 },
      ],
      strategy: "snowball",
      extraMinor: 0,
      startDate: "2026-01-01",
    });
    expect(plan.months).toBe(1);
    expect(plan.totalPrincipalMinor).toBe(60_000);
    expect(plan.totalInterestMinor).toBe(0);
  });
});

describe("loan amortization events", () => {
  it("adds every extra payment that falls in the same month", () => {
    const schedule = amortize(
      { id: "loan", name: "Loan", balanceMinor: 10_000, aprBps: 0, minPaymentMinor: 1_000 },
      "2026-01-01",
      [
        { monthIndex: 0, extraOneTimeMinor: 500 },
        { monthIndex: 0, extraOneTimeMinor: 250 },
      ],
    );
    expect(schedule.months[0].paymentMinor).toBe(1_750);
    expect(schedule.months[0].extraMinor).toBe(750);
    expect(schedule.months[0].balanceMinor).toBe(8_250);
    expect(combineLoanEvents([
      { monthIndex: 2, extraOneTimeMinor: 100 },
      { monthIndex: 2, paymentMinor: 2_000 },
      { monthIndex: 2, aprBps: 0 },
    ])).toEqual([{ monthIndex: 2, extraOneTimeMinor: 100, paymentMinor: 2_000, aprBps: 0, holiday: undefined }]);
  });

  it("rejects two rates or a holiday plus a payment in one month", () => {
    expect(() => amortize({ id: "loan", name: "Loan", balanceMinor: 10_000, aprBps: 0, minPaymentMinor: 1_000 }, "2026-01-01", [
      { monthIndex: 1, aprBps: 100 },
      { monthIndex: 1, aprBps: 200 },
    ])).toThrow(/one rate/i);
    expect(() => amortize({ id: "loan", name: "Loan", balanceMinor: 10_000, aprBps: 0, minPaymentMinor: 1_000 }, "2026-01-01", [
      { monthIndex: 1, holiday: true },
      { monthIndex: 1, extraOneTimeMinor: 100 },
    ])).toThrow(/holiday/i);
  });

  it("caps the final payment and does not leave a negative balance", () => {
    const schedule = amortize({ id: "loan", name: "Loan", balanceMinor: 10_000, aprBps: 0, minPaymentMinor: 4_000 }, "2026-01-01");
    expect(schedule.paidOff).toBe(true);
    expect(schedule.months.map((month) => month.paymentMinor)).toEqual([4_000, 4_000, 2_000]);
    expect(schedule.months.every((month) => month.balanceMinor >= 0)).toBe(true);
    expect(schedule.months[2].balanceMinor).toBe(0);
    expect(schedule.totalPaidMinor).toBe(10_000);
    expect(schedule.totalInterestMinor).toBe(0);
  });

  it("charges no interest at zero APR", () => {
    const schedule = amortize({ id: "loan", name: "Loan", balanceMinor: 5_000, aprBps: 0, minPaymentMinor: 2_000 }, "2026-01-01");
    expect(schedule.months.every((month) => month.interestMinor === 0)).toBe(true);
    expect(schedule.totalInterestMinor).toBe(0);
    expect(schedule.paidOff).toBe(true);
  });

  it("does not call a growing balance a finished payoff", () => {
    const schedule = amortize({ id: "loan", name: "Loan", balanceMinor: 10_000, aprBps: 1200, minPaymentMinor: 50 }, "2026-01-01");
    expect(schedule.negativeAmortization).toBe(true);
    expect(schedule.paidOff).toBe(false);
    expect(schedule.payoffDate).toBeNull();
    expect(schedule.payoffMonths).toBeNull();
    expect(schedule.months[0].balanceMinor).toBeGreaterThan(10_000);
    expect(schedule.assumptions.join(" ")).toMatch(/not a finished payoff/i);
    expect(schedule.assumptions.join(" ")).toMatch(/not a lender payoff quote/i);
  });

  it("stops at the horizon instead of inventing a payoff", () => {
    const schedule = amortize({ id: "loan", name: "Loan", balanceMinor: 1_201, aprBps: 0, minPaymentMinor: 1 }, "2026-01-01");
    expect(schedule.paidOff).toBe(false);
    expect(schedule.payoffDate).toBeNull();
    expect(schedule.totalInterestMinor).toBe(0);
    expect(schedule.months).toHaveLength(1200);
  });
});

describe("refinance comparison", () => {
  it("counts a financed fee once and an upfront fee outside the principal", () => {
    const financed = compareRefinance({
      balanceMinor: 120_000,
      aprBps: 0,
      paymentMinor: 10_000,
      newAprBps: 0,
      newTermMonths: 12,
      financedFeeMinor: 5_000,
      upfrontFeeMinor: 0,
      startDate: "2026-01-01",
    });
    expect(financed.comparable).toBe(true);
    expect(financed.proposed.totalPaidMinor).toBe(125_000);
    expect(financed.proposedTotalCostMinor).toBe(125_000);
    expect(financed.currentTotalCostMinor).toBe(120_000);
    expect(financed.netBenefitMinor).toBe(-5_000);
    expect(financed.financedFeeMinor).toBe(5_000);
    expect(financed.upfrontFeeMinor).toBe(0);

    const upfront = compareRefinance({
      balanceMinor: 120_000,
      aprBps: 0,
      paymentMinor: 10_000,
      newAprBps: 0,
      newTermMonths: 12,
      financedFeeMinor: 0,
      upfrontFeeMinor: 5_000,
      startDate: "2026-01-01",
    });
    expect(upfront.proposed.totalPaidMinor).toBe(120_000);
    expect(upfront.proposedTotalCostMinor).toBe(125_000);
    expect(upfront.netBenefitMinor).toBe(-5_000);
    expect(paymentForTerm(120_000, 0, 12)).toBe(10_000);
  });

  it("does not treat a lower payment as savings when the loan costs more", () => {
    const comparison = compareRefinance({
      balanceMinor: 100_000,
      aprBps: 1200,
      paymentMinor: 10_000,
      newAprBps: 1200,
      newPaymentMinor: 3_000,
      feeMinor: 0,
      startDate: "2026-01-01",
    });
    expect(comparison.comparable).toBe(true);
    expect(comparison.proposedPaymentMinor).toBeLessThan(comparison.currentPaymentMinor);
    expect(comparison.proposed.payoffMonths!).toBeGreaterThan(comparison.current.payoffMonths!);
    expect(comparison.netBenefitMinor).toBeLessThan(0);
    expect(comparison.lowerPaymentCostsMore).toBe(true);
    expect(comparison.assumptions.join(" ")).toMatch(/not savings/i);
  });

  it("reports a break-even month only when the new loan actually costs less", () => {
    const comparison = compareRefinance({
      balanceMinor: 100_000,
      aprBps: 1200,
      paymentMinor: 10_000,
      newAprBps: 600,
      newPaymentMinor: 10_000,
      upfrontFeeMinor: 0,
      financedFeeMinor: 0,
      startDate: "2026-01-01",
    });
    expect(comparison.netBenefitMinor).toBeGreaterThan(0);
    expect(comparison.breakEvenMonth).toBeGreaterThan(0);
  });

  it("does not compare interest when a payment never pays the loan off", () => {
    const comparison = compareRefinance({
      balanceMinor: 100_000,
      aprBps: 1200,
      paymentMinor: 10_000,
      newAprBps: 1200,
      newPaymentMinor: 100,
      feeMinor: 0,
      startDate: "2026-01-01",
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.netBenefitMinor).toBeNull();
    expect(comparison.interestSavedMinor).toBeNull();
    expect(comparison.currentTotalCostMinor).toBeNull();
    expect(comparison.assumptions.join(" ")).toMatch(/not a full lifetime comparison/i);
  });

  it("handles a zero balance, zero fees, and invalid input", () => {
    const done = compareRefinance({
      balanceMinor: 0,
      aprBps: 0,
      paymentMinor: 0,
      newAprBps: 0,
      newPaymentMinor: 0,
      feeMinor: 0,
      startDate: "2026-01-01",
    });
    expect(done.comparable).toBe(true);
    expect(done.netBenefitMinor).toBe(0);
    expect(() => compareRefinance({
      balanceMinor: 1_000,
      aprBps: -1,
      paymentMinor: 100,
      newAprBps: 0,
      newPaymentMinor: 100,
      startDate: "2026-01-01",
    })).toThrow(/negative/i);
    expect(() => compareRefinance({
      balanceMinor: 1_000,
      aprBps: 0,
      paymentMinor: 100,
      newAprBps: 0,
      newPaymentMinor: 100,
      newTermMonths: 12,
      startDate: "2026-01-01",
    })).toThrow(/not both/i);
  });
});

describe("recorded loan payments", () => {
  it("reduces cash by the whole payment and the loan by principal only", () => {
    const checking = account({ id: "cash", kind: "checking" });
    const loan = account({ id: "loan", kind: "loan", onBudget: false });
    const draft = buildLoanPayment({
      cashAccountId: checking.id,
      loanAccountId: loan.id,
      principalMinor: 20_000,
      interestMinor: 5_000,
      feeMinor: 0,
    });
    const payment = txn({ id: "pay", accountId: checking.id, amountMinor: draft.cash.amountMinor, type: "loan_payment", splits: draft.cash.splits, payee: draft.cash.payee });
    const reduction = txn({ id: "principal", accountId: loan.id, amountMinor: draft.reduction!.amountMinor, type: "loan_payment", splits: draft.reduction!.splits, payee: draft.reduction!.payee });
    const accounts = [checking, loan];
    validateTransaction(payment, accounts, "USD");
    validateTransaction(reduction, accounts, "USD");
    const transactions = [
      txn({ id: "open-cash", accountId: checking.id, amountMinor: 100_000, type: "opening" }),
      txn({ id: "open-loan", accountId: loan.id, amountMinor: -60_000, type: "opening" }),
      payment,
      reduction,
    ];
    const result = computeBudget(engine({ accounts, transactions }));
    expect(result.cashPoolMinor).toBe(75_000);
    expect(result.readyToAssignMinor).toBe(75_000);
    expect(result.spendingMinor).toBe(5_000);
    expect(result.identityDifferenceMinor).toBe(0);
    expect(displayBalance(checking, transactions, "2026-11-20")).toBe(75_000);
    expect(displayBalance(loan, transactions, "2026-11-20")).toBe(40_000);
  });
});
