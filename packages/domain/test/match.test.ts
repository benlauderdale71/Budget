import { describe, expect, it } from "vitest";
import { matchProblem, matchedTotals } from "../src/match.js";

const keeper = { id: "user", accountId: "checking", amountMinor: -2500, currency: "USD" };
const bank = { id: "bank", accountId: "checking", amountMinor: -2500, currency: "USD", providerTransactionId: "prov-1" };

describe("transaction matching", () => {
  it("allows an equal pair and rejects a different account, amount, or provider id", () => {
    expect(matchProblem(keeper, bank)).toBeNull();
    expect(matchProblem(keeper, { ...bank, accountId: "card" })).toMatch(/same account/);
    expect(matchProblem(keeper, { ...bank, amountMinor: -2600 })).toMatch(/equal/);
    expect(matchProblem({ ...keeper, providerTransactionId: "a" }, bank)).toMatch(/provider ids/);
    expect(matchProblem(keeper, keeper)).toMatch(/different/);
  });

  it("removes the duplicate once and restores that same amount", () => {
    const totals = matchedTotals([-2500, -2500], -2500);
    expect(totals.afterMatch).toBe(-2500);
    expect(totals.afterUnmatch).toBe(-5000);
  });
});
