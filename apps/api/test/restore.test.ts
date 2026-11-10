import { describe, expect, it } from "vitest";
import { planRestore } from "../src/restore.js";

describe("backup restore planning", () => {
  it("rewrites the household id and rejects an id owned elsewhere", () => {
    const plan = planRestore({
      version: 2,
      accounts: [{ id: "acct-1", household_id: "other", name: "Checking" }],
      transactions: [{ id: "txn-1", household_id: "other", account_id: "acct-1", amount_minor: -500 }],
    }, "home-a", { accounts: {}, transactions: {} });
    expect(plan.inserts.accounts[0].household_id).toBe("home-a");
    expect(plan.inserts.transactions[0].household_id).toBe("home-a");

    expect(() => planRestore({
      version: 2,
      accounts: [{ id: "acct-1", household_id: "home-b", name: "Checking" }],
    }, "home-a", { accounts: { "acct-1": "home-b" } })).toThrow(/different household/);
  });

  it("skips rows this household already has and rejects an unknown version", () => {
    const plan = planRestore({
      version: 1,
      accounts: [{ id: "acct-1", household_id: "home-a", name: "Checking" }],
    }, "home-a", { accounts: { "acct-1": "home-a" } });
    expect(plan.inserts.accounts).toEqual([]);
    expect(plan.skipped).toEqual(["accounts:acct-1"]);
    expect(() => planRestore({ version: 9, accounts: [] }, "home-a", {})).toThrow(/version/);
  });
});
