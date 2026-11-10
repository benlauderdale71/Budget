import { describe, expect, it } from "vitest";
import { computeBudget, neededForTarget } from "../src/budget.js";
import { addMonths } from "../src/dates.js";
import { advanceFillSchedule, eligiblePostedIncomeMinor, planFill, targetProgress } from "../src/fills.js";
import { percentBpsFromDecimal, percentTargetMinor } from "../src/percent.js";
import type { Account, Assignment, Bucket, EngineInput, Transaction } from "../src/types.js";

function account(partial: Partial<Account> & Pick<Account, "id" | "kind">): Account {
  return { name: partial.id, currency: "USD", onBudget: true, ...partial };
}

function bucket(partial: Partial<Bucket> & Pick<Bucket, "id" | "name">): Bucket {
  return { group: "Spending", kind: "expense", flexRole: "flexible", envelopeStyle: "regular", rollover: "both", ...partial };
}

function txn(partial: Partial<Transaction> & Pick<Transaction, "id" | "amountMinor" | "type" | "accountId">): Transaction {
  return { date: "2026-11-05", currency: "USD", payee: partial.type, splits: [], bankStatus: "posted", reviewStatus: "reviewed", ...partial };
}

describe("percentage targets", () => {
  it("rounds half away from zero and rejects extra decimal places", () => {
    expect(percentBpsFromDecimal("10.5")).toBe(1050);
    expect(percentBpsFromDecimal("10")).toBe(1000);
    expect(percentBpsFromDecimal("0.01")).toBe(1);
    expect(percentTargetMinor(1, 1050)).toBe(0);
    expect(percentTargetMinor(5, 1050)).toBe(1);
    expect(percentTargetMinor(200_000, 1000)).toBe(20_000);
    expect(() => percentBpsFromDecimal("10.555")).toThrow(/two decimal/);
  });

  it("uses posted cash income and ignores refunds, transfers, openings, and the next month", () => {
    const checking = account({ id: "checking", kind: "checking" });
    const card = account({ id: "card", kind: "credit" });
    const shared = { accounts: [checking, card], currency: "USD", from: "2026-11-01", to: "2026-11-30" };
    const income = eligiblePostedIncomeMinor({
      ...shared,
      transactions: [
        txn({ id: "pay", amountMinor: 200_000, type: "income", accountId: "checking" }),
        txn({ id: "refund", amountMinor: 4_000, type: "refund", accountId: "checking" }),
        txn({ id: "move", amountMinor: 50_000, type: "transfer", accountId: "checking" }),
        txn({ id: "open", amountMinor: 100_000, type: "opening", accountId: "checking" }),
        txn({ id: "loan", amountMinor: 80_000, type: "loan_proceeds", accountId: "checking" }),
        txn({ id: "card-income", amountMinor: 9_000, type: "income", accountId: "card" }),
        txn({ id: "next", amountMinor: 30_000, type: "income", accountId: "checking", date: "2026-12-01" }),
        txn({ id: "pending", amountMinor: 7_000, type: "income", accountId: "checking", bankStatus: "pending" }),
      ],
    });
    expect(income).toBe(200_000);
    const groceries = bucket({ id: "g", name: "Groceries", target: { type: "set_aside", amountMinor: 0, cadence: "monthly", percentBps: 1050 } });
    const progress = targetProgress(groceries, 0, 5_000, income);
    expect(progress.targetMinor).toBe(21_000);
    expect(progress.fundedMinor).toBe(5_000);
    expect(progress.shortfallMinor).toBe(16_000);
    expect(neededForTarget(groceries, 0, 0, 1, 0)).toBe(0);
  });
});

describe("rollover effective dates", () => {
  it("keeps the old carry into this month and applies a new rule when the month closes", () => {
    const checking = account({ id: "checking", kind: "checking" });
    const groceries = bucket({ id: "g", name: "Groceries" });
    const input: EngineInput = {
      currency: "USD",
      asOf: "2026-11-20",
      viewPeriod: "2026-11",
      accounts: [checking],
      buckets: [groceries],
      transactions: [txn({ id: "open", amountMinor: 10_000, type: "opening", accountId: "checking", date: "2026-10-01" })],
      assignments: [{ id: "a", bucketId: "g", periodKey: "2026-10", amountMinor: 4_000 }],
      rolloverPolicies: [{ bucketId: "g", effectivePeriod: "2026-11", rollover: "none" }],
    };
    const november = computeBudget(input);
    expect(november.buckets.find((row) => row.bucketId === "g")?.availableMinor).toBe(4_000);
    const december = computeBudget({ ...input, viewPeriod: "2026-12" });
    expect(december.buckets.find((row) => row.bucketId === "g")?.availableMinor).toBe(0);
    expect(december.readyToAssignMinor).toBe(10_000);
    const rewritten = computeBudget({ ...input, buckets: [{ ...groceries, rollover: "none" }], rolloverPolicies: [], viewPeriod: "2026-11" });
    expect(rewritten.buckets.find((row) => row.bucketId === "g")?.availableMinor).toBe(0);
    expect(rewritten.readyToAssignMinor).toBe(10_000);
  });
});

describe("envelope fills", () => {
  const groceries = { bucketId: "g", availableMinor: 10_000, assignedMinor: 10_000 };
  const trip = { bucketId: "t", availableMinor: 0, assignedMinor: 0 };
  const housing = { bucketId: "h", availableMinor: 60_000, assignedMinor: 60_000 };

  it("tops up and adds from Ready to Assign without taking the balance negative", () => {
    const plan = planFill({
      readyToAssignMinor: 30_000,
      buckets: [groceries, trip, housing],
      lines: [
        { bucketId: "g", mode: "top_up", amountMinor: 20_000, priority: 1 },
        { bucketId: "t", mode: "add", amountMinor: 15_000, priority: 2 },
      ],
      eligibleIncomeMinor: 0,
      policy: "partial",
    });
    expect(plan.status).toBe("applied");
    expect(plan.totalAllocatedMinor).toBe(25_000);
    expect(plan.readyAfterMinor).toBe(5_000);
    expect(plan.deltas).toEqual([
      { bucketId: "g", deltaMinor: 10_000 },
      { bucketId: "t", deltaMinor: 15_000 },
    ]);
  });

  it("skips the whole plan or funds in priority order", () => {
    const lines = [
      { bucketId: "g", mode: "add" as const, amountMinor: 800, priority: 1 },
      { bucketId: "t", mode: "add" as const, amountMinor: 800, priority: 2 },
    ];
    const skipped = planFill({ readyToAssignMinor: 1_000, buckets: [groceries, trip], lines, eligibleIncomeMinor: 0, policy: "skip" });
    expect(skipped.status).toBe("skipped");
    expect(skipped.totalAllocatedMinor).toBe(0);
    expect(skipped.readyAfterMinor).toBe(1_000);
    const partial = planFill({ readyToAssignMinor: 1_000, buckets: [groceries, trip], lines, eligibleIncomeMinor: 0, policy: "partial" });
    expect(partial.status).toBe("partial");
    expect(partial.allocations.map((line) => line.allocatedMinor)).toEqual([800, 200]);
    expect(partial.readyAfterMinor).toBe(0);
  });

  it("does not invent a percent fill when no income has posted", () => {
    const plan = planFill({
      readyToAssignMinor: 5_000,
      buckets: [groceries],
      lines: [{ bucketId: "g", mode: "percent", percentBps: 1000, priority: 1 }],
      eligibleIncomeMinor: 0,
      policy: "partial",
    });
    expect(plan.totalAllocatedMinor).toBe(0);
    expect(plan.readyAfterMinor).toBe(5_000);
  });

  it("skips missed dates and does not apply a backlog", () => {
    const behind = advanceFillSchedule({ nextDate: "2026-01-31", today: "2026-03-15", cadence: "monthly", anchorDay: 31 });
    expect(behind.skipped).toEqual(["2026-01-31", "2026-02-28"]);
    expect(behind.applyDate).toBeNull();
    expect(behind.nextDate).toBe("2026-03-31");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    const week = advanceFillSchedule({ nextDate: "2026-03-07", today: "2026-03-14", cadence: "weekly" });
    expect(week.skipped).toEqual(["2026-03-07"]);
    expect(week.applyDate).toBe("2026-03-14");
    const once = advanceFillSchedule({ nextDate: "2026-01-01", today: "2026-03-01", cadence: "once" });
    expect(once.applyDate).toBeNull();
    expect(once.nextDate).toBeNull();
  });
});
