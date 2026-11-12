import { describe, expect, it } from "vitest";
import { planReconciliation } from "../src/reconciliation.js";

const rent = { id: "rent", date: "2026-11-01", accountId: "checking", amountMinor: -120000, reconciled: false };
const later = { id: "later", date: "2026-12-01", accountId: "checking", amountMinor: -500, reconciled: false };
const kept = { id: "kept", date: "2026-11-02", accountId: "checking", amountMinor: -100, reconciled: true };

describe("reconciliation plan", () => {
  it("sums selected and already reconciled rows through the statement date", () => {
    const plan = planReconciliation({
      accountId: "checking",
      accountKind: "checking",
      statementDate: "2026-11-30",
      statementBalanceMinor: -120100,
      clearedIds: ["rent"],
      transactions: [rent, later, kept, { id: "other", date: "2026-11-03", accountId: "cash", amountMinor: -50, reconciled: false }],
    });
    expect(plan.unknownIds).toEqual([]);
    expect(plan.includedIds).toEqual(["rent", "kept"]);
    expect(plan.clearedBalanceMinor).toBe(-120100);
    expect(plan.differenceMinor).toBe(0);
    expect(plan.canLock).toBe(true);
  });

  it("flips the sign for a liability and refuses an unknown transaction", () => {
    const plan = planReconciliation({
      accountId: "card",
      accountKind: "credit",
      statementDate: "2026-11-30",
      statementBalanceMinor: 4000,
      clearedIds: ["charge", "missing"],
      transactions: [{ id: "charge", date: "2026-11-04", accountId: "card", amountMinor: -4000, reconciled: false }],
    });
    expect(plan.clearedBalanceMinor).toBe(4000);
    expect(plan.differenceMinor).toBe(0);
    expect(plan.unknownIds).toEqual(["missing"]);
    expect(plan.canLock).toBe(false);
  });

  it("counts a transfer on the other side once, in the opposite direction", () => {
    const plan = planReconciliation({
      accountId: "savings",
      accountKind: "savings",
      statementDate: "2026-11-30",
      statementBalanceMinor: 2500,
      clearedIds: ["move"],
      transactions: [{ id: "move", date: "2026-11-08", accountId: "checking", counterAccountId: "savings", amountMinor: -2500, reconciled: false }],
    });
    expect(plan.clearedBalanceMinor).toBe(2500);
    expect(plan.differenceMinor).toBe(0);
  });
});
