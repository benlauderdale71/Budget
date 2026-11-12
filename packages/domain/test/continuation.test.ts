import { createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyTestDelivery } from "../src/delivery.js";
import { createOidcStart, oidcIdentityDecision, oidcIssuerAllowed, oidcReturnPath, verifyRs256IdToken } from "../src/oidc.js";
import { realizeFifo } from "../src/lots.js";
import { ownershipMoney, transactionMatchesOwnership } from "../src/ownership-share.js";
import { projectMonthlyRetirement, requiredBeginningAge, uniformLifetimeRmd } from "../src/rmd.js";
import { planExternalSync, SANDBOX_INCREMENTAL, SANDBOX_INITIAL } from "../src/sandbox-sync.js";
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
    bankStatus: partial.bankStatus ?? "posted",
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

  it("reduces spending for a refund and ignores a pending or private-excluded row", () => {
    const refund = txn({
      id: "refund",
      amountMinor: 400,
      type: "refund",
      splits: [{ bucketId: "g", amountMinor: 400, role: "refund", ownerUserId: "owner" }],
    });
    const pending = txn({ id: "pending", amountMinor: -900, type: "expense", ownerUserId: "owner", bankStatus: "pending" });
    const mine = ownershipMoney([refund, pending], "mine", "owner", undefined, "2026-11-01", "2026-11-30");
    expect(mine.spendingMinor).toBe(-400);
    expect(ownershipMoney([pending], "all", "owner", undefined, "2026-11-01", "2026-11-30").spendingMinor).toBe(0);
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
    expect(year.months[0].portfolioMinor).toBe(2650000);
    expect(year.months[0].otherMinor).toBe(100000);
    expect(year.assumptions.join(" ")).toMatch(/590-B/);
    expect(rmd.note).toMatch(/not used/);
  });

  it("selects the beginning age and published denominators for several years", () => {
    expect(requiredBeginningAge(1951)).toBe(73);
    expect(requiredBeginningAge(1959)).toBe(73);
    expect(requiredBeginningAge(1960)).toBe(75);
    expect(uniformLifetimeRmd(2_740_000, 72)).toMatchObject({ amountMinor: 100_000, denominatorTenths: 274 });
    expect(uniformLifetimeRmd(2_460_000, 75)).toMatchObject({ amountMinor: 100_000, denominatorTenths: 246 });
    expect(uniformLifetimeRmd(2_000_000, 120).denominatorTenths).toBe(20);
    expect(uniformLifetimeRmd(2_000_000, 70)).toMatchObject({ amountMinor: 0, denominatorTenths: 0 });
    const before = projectMonthlyRetirement({
      portfolioMinor: 1_000_000, traditionalMinor: 1_000_000, annualReturnBps: 0, annualSpendingMinor: 0, annualContributionMinor: 0, taxBps: 0, age: 70, birthYear: 1959, months: 1,
    });
    expect(before.months[0].rmdMinor).toBe(0);
    const later = projectMonthlyRetirement({
      portfolioMinor: 2_460_000, traditionalMinor: 2_460_000, annualReturnBps: 0, annualSpendingMinor: 0, annualContributionMinor: 0, taxBps: 0, age: 75, birthYear: 1960, months: 1,
    });
    expect(later.months[0].rmdMinor).toBe(100_000);
    expect(later.assumptions.join(" ")).toMatch(/Table III/);
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
    expect(oidcIssuerAllowed("https://id.example")).toBe(true);
    expect(oidcIssuerAllowed("http://127.0.0.1/oidc-test")).toBe(true);
    expect(oidcIssuerAllowed("http://localhost:4010/oidc-test")).toBe(true);
    expect(oidcIssuerAllowed("http://id.example")).toBe(false);
    expect(oidcIssuerAllowed("http://127.0.0.1.evil.example")).toBe(false);
    expect(() => createOidcStart({ issuer: "http://id.example", clientId: "client", redirectUri: "https://app.example/callback", returnPath: "/" })).toThrow(/HTTPS/);
  });

  it("rejects a token whose signature, audience, or algorithm does not match", () => {
    const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = generated.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "http://127.0.0.1/oidc-test", aud: "budgetcents", sub: "person", email: "a@example.com", email_verified: true, nonce: "nonce-1", exp: Math.floor(Date.now() / 1000) + 120,
    })).toString("base64url");
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(generated.privateKey).toString("base64url");
    const verified = verifyRs256IdToken(`${header}.${payload}.${signature}`, jwk, { issuer: "http://127.0.0.1/oidc-test", audience: "budgetcents", nonce: "nonce-1" });
    expect(verified).toEqual({ subject: "person", email: "a@example.com", emailVerified: true });
    expect(() => verifyRs256IdToken(`${header}.${payload}.${signature}`, jwk, { issuer: "http://127.0.0.1/oidc-test", audience: "other", nonce: "nonce-1" })).toThrow(/application/);
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    expect(() => verifyRs256IdToken(`${none}.${payload}.`, jwk, { issuer: "http://127.0.0.1/oidc-test", audience: "budgetcents", nonce: "nonce-1" })).toThrow(/RS256/);
  });
});

describe("sandbox synchronization", () => {
  it("imports history, settles a pending line in place, and skips a duplicate", () => {
    const first = planExternalSync([], SANDBOX_INITIAL);
    expect(first.insert.map((row) => row.externalId)).toEqual(["sbx-rent", "sbx-market"]);
    const existing = [
      { id: "rent", externalId: "sbx-rent", bankStatus: "posted" as const },
      { id: "market", externalId: "sbx-market", bankStatus: "pending" as const },
    ];
    const next = planExternalSync(existing, SANDBOX_INCREMENTAL);
    expect(next.insert.map((row) => row.payee)).toEqual(["Sandbox Fuel"]);
    expect(next.settle).toEqual([{ id: "market", activity: SANDBOX_INCREMENTAL[0] }]);
    const again = planExternalSync([
      ...existing.map((row) => ({ ...row, bankStatus: "posted" as const })),
      { id: "market", externalId: "sbx-market-posted", bankStatus: "posted" as const },
      { id: "fuel", externalId: "sbx-fuel", bankStatus: "posted" as const },
    ], SANDBOX_INCREMENTAL);
    expect(again.insert).toEqual([]);
    expect(again.settle).toEqual([]);
    expect(again.duplicates).toEqual(["sbx-market-posted", "sbx-fuel"]);
  });
});

describe("test delivery status", () => {
  it("does not treat acceptance as delivery", () => {
    expect(classifyTestDelivery({ outcome: "accepted", quiet: false, optedOut: false, consented: true })).toMatchObject({ status: "accepted", provenDelivered: false });
    expect(classifyTestDelivery({ outcome: "rejected", quiet: false, optedOut: false, consented: true }).status).toBe("failed");
    expect(classifyTestDelivery({ outcome: "accepted", quiet: true, optedOut: false, consented: true }).status).toBe("queued");
    expect(classifyTestDelivery({ outcome: "accepted", quiet: false, optedOut: true, consented: true }).status).toBe("refused");
    expect(classifyTestDelivery({ outcome: "accepted", quiet: false, optedOut: false, consented: false }).status).toBe("refused");
  });
});
