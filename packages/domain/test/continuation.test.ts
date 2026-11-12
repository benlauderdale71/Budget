import { describe, expect, it } from "vitest";
import { createOidcStart, oidcIdentityDecision, oidcReturnPath } from "../src/oidc.js";
import { realizeFifo } from "../src/lots.js";
import { ownershipMoney, transactionMatchesOwnership } from "../src/ownership-share.js";
import { projectMonthlyRetirement, requiredBeginningAge, uniformLifetimeRmd } from "../src/rmd.js";
import type { Transaction } from "../src/types.js";

function txn(partial: Partial<Transaction> & Pick<Transaction, "amountMinor" | "type">): Transaction {
  return {
    id: partial.id ?? "t",
    date: partial.date ?? "2026-11-02",
    accountId: "a",
    currency: "USD",
    amountMinor: partial.amountMinor,
    type: partial.type,
    payee: partial.payee ?? "Store",
    bankStatus: "posted",
    reviewStatus: "needs_review",
    cleared: false,
    reconciled: false,
    locked: false,
    splits: partial.splits ?? [],
    tags: [],
    ownerUserId: partial.ownerUserId,
    deleted: false,
    version: 1,
  } as Transaction;
}

describe("split ownership", () => {
  it("keeps a whole-transaction label and does not count a split purchase twice", () => {
    const shared = txn({ id: "shared", amountMinor: -250, type: "expense" });
    const split = txn({
      id: "split",
      amountMinor: -1000,
      type: "expense",
      ownerUserId: "owner",
      splits: [
        { bucketId: "g", amountMinor: 600, role: "expense", ownerUserId: "owner" },
        { bucketId: "g", amountMinor: 400, role: "expense", ownerUserId: "coach" },
      ],
    });
    const rows = [shared, split];
    const all = ownershipMoney(rows, "all", "owner", undefined, "2026-11-01", "2026-11-30");
    const mine = ownershipMoney(rows, "mine", "owner", undefined, "2026-11-01", "2026-11-30");
    const yours = ownershipMoney(rows, "yours", "coach", "coach", "2026-11-01", "2026-11-30");
    const ours = ownershipMoney(rows, "ours", "owner", undefined, "2026-11-01", "2026-11-30");
    expect(all.spendingMinor).toBe(1250);
    expect(mine.spendingMinor).toBe(600);
    expect(yours.spendingMinor).toBe(400);
    expect(ours.spendingMinor).toBe(250);
    expect(mine.spendingMinor + yours.spendingMinor + ours.spendingMinor).toBe(all.spendingMinor);
    expect(transactionMatchesOwnership(shared, "ours", "owner")).toBe(true);
    expect(transactionMatchesOwnership(split, "mine", "owner")).toBe(true);
    expect(transactionMatchesOwnership(split, "yours", "coach", "coach")).toBe(true);
  });
});

describe("tax lots", () => {
  it("sells the earliest lot first and keeps the remaining basis", () => {
    const result = realizeFifo([
      { id: "old", quantityMicro: 2_000_000, costBasisMinor: 4000, acquired: "2020-01-01" },
      { id: "new", quantityMicro: 2_000_000, costBasisMinor: 9000, acquired: "2024-01-01" },
    ], 1_000_000, 3000);
    expect(result.sales.map((sale) => sale.lotId)).toEqual(["old"]);
    expect(result.gainMinor).toBe(1000);
    expect(result.remaining).toEqual([
      { id: "old", quantityMicro: 1_000_000, costBasisMinor: 2000, acquired: "2020-01-01" },
      { id: "new", quantityMicro: 2_000_000, costBasisMinor: 9000, acquired: "2024-01-01" },
    ]);
  });
});

describe("retirement distributions", () => {
  it("uses the published age-73 Uniform Lifetime denominator", () => {
    expect(requiredBeginningAge()).toBe(73);
    expect(requiredBeginningAge(1960)).toBe(75);
    const rmd = uniformLifetimeRmd(2650000, 73);
    expect(rmd.denominatorTenths).toBe(265);
    expect(rmd.amountMinor).toBe(100000);
    const year = projectMonthlyRetirement({
      portfolioMinor: 2650000,
      traditionalMinor: 2650000,
      annualReturnBps: 0,
      annualSpendingMinor: 0,
      annualContributionMinor: 0,
      taxBps: 0,
      age: 73,
      months: 1,
    });
    expect(year.months[0].rmdMinor).toBe(100000);
    expect(year.months[0].withdrawalMinor).toBe(100000);
    expect(year.months[0].portfolioMinor).toBe(2550000);
    expect(year.assumptions.join(" ")).toMatch(/590-B/);
  });
});

describe("federated sign-in decisions", () => {
  it("rejects an open redirect, an unverified email, and a silent link to an existing account", () => {
    expect(oidcReturnPath("https://evil.example")).toBe("/");
    expect(oidcReturnPath("/invite/abc")).toBe("/invite/abc");
    const start = createOidcStart({ issuer: "https://id.example", clientId: "client", redirectUri: "https://app.example/callback", returnPath: "/invite/abc" });
    expect(start.authorizationUrl).toContain("code_challenge_method=S256");
    expect(start.authorizationUrl).not.toContain(start.codeVerifier);
    expect(oidcIdentityDecision({ emailVerified: false, email: "a@example.com", subject: "sub", existingSubjectUserId: null, existingEmailUserId: null }).action).toBe("reject");
    expect(oidcIdentityDecision({ emailVerified: true, email: "a@example.com", subject: "sub", existingSubjectUserId: null, existingEmailUserId: "user" }).action).toBe("link-required");
    expect(oidcIdentityDecision({ emailVerified: true, email: "a@example.com", subject: "sub", existingSubjectUserId: "user", existingEmailUserId: "user" }).action).toBe("sign-in");
  });
});
