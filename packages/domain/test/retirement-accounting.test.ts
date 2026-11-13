import { expect, it } from "vitest";
import { projectMonthlyRetirement, uniformLifetimeRmd } from "../src/rmd.js";

const base = { portfolioMinor: 100000, traditionalMinor: 100000, annualReturnBps: 0, annualSpendingMinor: 12000, annualContributionMinor: 0, taxBps: 2000, age: 65, birthYear: 1961, months: 12 };

it("funds net spending plus tax and conserves every cent across pools", () => {
  const result = projectMonthlyRetirement(base);
  expect(result.months[0]).toMatchObject({ spendingMinor: 1000, withdrawalMinor: 1250, taxMinor: 250, portfolioMinor: 98750, unmetSpendingMinor: 0 });
  expect(result.months.at(-1)!.portfolioMinor).toBe(85000);
  let prior = base.portfolioMinor;
  for (const row of result.months) {
    expect(row.portfolioMinor).toBe(prior + row.contributionMinor + row.returnMinor - row.fundedSpendingMinor - row.taxMinor);
    expect(row.traditionalMinor + row.otherMinor).toBe(row.portfolioMinor); prior = row.portfolioMinor;
  }
});

it("keeps unused RMD proceeds after tax and bases next year's requirement on December", () => {
  const result = projectMonthlyRetirement({ ...base, portfolioMinor: 2650000, traditionalMinor: 2650000, priorYearTraditionalMinor: 5300000, annualSpendingMinor: 0, age: 73, birthYear: 1953, months: 13 });
  expect(result.months[0]).toMatchObject({ rmdMinor: 200000, withdrawalMinor: 200000, taxMinor: 40000, otherMinor: 160000, traditionalMinor: 2450000, portfolioMinor: 2610000 });
  expect(result.months.slice(1, 12).every((m) => m.rmdMinor === 0)).toBe(true);
  expect(result.months[12].rmdMinor).toBe(uniformLifetimeRmd(2450000, 74).amountMinor);
});

it("allocates annual remainders, handles depletion and compares withdrawal orders", () => {
  const result = projectMonthlyRetirement({ ...base, portfolioMinor: 100, traditionalMinor: 0, annualSpendingMinor: 13, annualContributionMinor: 17, taxBps: 0 });
  expect(result.months.reduce((n, m) => n + m.spendingMinor, 0)).toBe(13);
  expect(result.months.reduce((n, m) => n + m.contributionMinor, 0)).toBe(17);
  expect(result.months.at(-1)!.portfolioMinor).toBe(104);
  const depleted = projectMonthlyRetirement({ ...base, portfolioMinor: 500, traditionalMinor: 500 }).months[0];
  expect(depleted).toMatchObject({ portfolioMinor: 0, taxMinor: 100, fundedSpendingMinor: 400, unmetSpendingMinor: 600 });
  const mixed = { ...base, portfolioMinor: 20000, traditionalMinor: 10000, months: 1 };
  expect(projectMonthlyRetirement({ ...mixed, strategy: "other_first" }).months[0].taxMinor).toBe(0);
  expect(projectMonthlyRetirement({ ...mixed, strategy: "traditional_first" }).months[0].taxMinor).toBe(250);
});

it("rejects unsupported RMD cases and impossible inputs instead of silently clipping them", () => {
  for (const change of [{ traditionalMinor: 100001 }, { taxBps: 10000 }, { annualReturnBps: -10001 }, { inheritedAccount: true }, { youngerSpouseSoleBeneficiary: true }, { priorYearTraditionalMinor: -1 }]) expect(() => projectMonthlyRetirement({ ...base, ...change })).toThrow();
  expect(uniformLifetimeRmd(1, 73).amountMinor).toBe(1);
  const result = projectMonthlyRetirement({ ...base, annualReturnBps: -10000, months: 600 });
  expect(result.months.every((m) => m.portfolioMinor >= 0 && m.traditionalMinor >= 0 && m.otherMinor >= 0)).toBe(true);
});
