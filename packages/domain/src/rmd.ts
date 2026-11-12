import { MoneyError, divRoundHalfAway } from "./money.js";

/**
 * IRS Publication 590-B (2025), Appendix B, Table III (Uniform Lifetime).
 * Applicable denominators are stored in tenths (27.4 is 274) so the division stays in integers.
 * This table is for distribution calendar years beginning on or after January 1, 2022.
 * It is not the Joint Life table and it is not a tax-bracket calculation.
 */
export const UNIFORM_LIFETIME_TENTHS: Record<number, number> = {
  72: 274, 73: 265, 74: 255, 75: 246, 76: 237, 77: 229, 78: 220, 79: 211, 80: 202,
  81: 194, 82: 185, 83: 177, 84: 168, 85: 160, 86: 152, 87: 144, 88: 137, 89: 129,
  90: 122, 91: 115, 92: 108, 93: 101, 94: 95, 95: 89, 96: 84, 97: 78, 98: 73, 99: 68,
  100: 64, 101: 60, 102: 56, 103: 52, 104: 49, 105: 46, 106: 43, 107: 41, 108: 39, 109: 37,
  110: 35, 111: 34, 112: 33, 113: 31, 114: 30, 115: 29, 116: 28, 117: 27, 118: 25, 119: 23, 120: 20,
};

export const RMD_SOURCE = "IRS Publication 590-B (2025), Table III (Uniform Lifetime), for distribution years beginning on or after January 1, 2022.";

/** SECURE 2.0: age 73 when the owner reached 72 after 2022. Age 75 is used here only when a birth year of 1960 or later is supplied. */
export function requiredBeginningAge(birthYear?: number): number {
  if (birthYear != null && birthYear >= 1960) return 75;
  return 73;
}

export function uniformLifetimeRmd(balanceMinor: number, age: number): { amountMinor: number; denominatorTenths: number; note: string } {
  if (!Number.isInteger(balanceMinor) || balanceMinor < 0) throw new MoneyError("The prior-year balance must be a non-negative integer number of minor units.");
  const denominatorTenths = age >= 120 ? UNIFORM_LIFETIME_TENTHS[120] : UNIFORM_LIFETIME_TENTHS[age];
  if (!denominatorTenths) {
    return { amountMinor: 0, denominatorTenths: 0, note: `${RMD_SOURCE} Table III has no row for age ${age}, so this model does not invent a distribution.` };
  }
  const amountMinor = Math.floor((balanceMinor * 10) / denominatorTenths);
  return {
    amountMinor,
    denominatorTenths,
    note: `${RMD_SOURCE} Age ${age} uses denominator ${(denominatorTenths / 10).toFixed(1)}. The spouse-more-than-10-years-younger table is not used.`,
  };
}

export interface MonthlyRetirementInput {
  portfolioMinor: number;
  traditionalMinor: number;
  annualReturnBps: number;
  annualSpendingMinor: number;
  annualContributionMinor: number;
  /** Flat share of the withdrawal. This is not an income-tax bracket. */
  taxBps: number;
  age: number;
  birthYear?: number;
  months: number;
}

export function projectMonthlyRetirement(input: MonthlyRetirementInput): { months: { portfolioMinor: number; traditionalMinor: number; contributionMinor: number; spendingMinor: number; withdrawalMinor: number; taxMinor: number; rmdMinor: number; returnMinor: number }[]; assumptions: string[] } {
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 600) throw new MoneyError("Choose between 1 and 600 months.");
  for (const [label, value] of Object.entries({
    portfolio: input.portfolioMinor,
    traditional: input.traditionalMinor,
    spending: input.annualSpendingMinor,
    contribution: input.annualContributionMinor,
  })) {
    if (!Number.isInteger(value) || value < 0) throw new MoneyError(`${label} must be a non-negative integer number of minor units.`);
  }
  const startAge = requiredBeginningAge(input.birthYear);
  const months = [];
  let portfolio = input.portfolioMinor;
  let traditional = Math.min(input.traditionalMinor, input.portfolioMinor);
  for (let index = 0; index < input.months; index += 1) {
    const age = input.age + Math.floor(index / 12);
    const contributionMinor = Math.floor(input.annualContributionMinor / 12);
    const spendingMinor = Math.floor(input.annualSpendingMinor / 12);
    const rmd = index % 12 === 0 && age >= startAge ? uniformLifetimeRmd(traditional, age) : { amountMinor: 0, denominatorTenths: 0, note: "" };
    const withdrawalMinor = Math.min(portfolio + contributionMinor, Math.max(spendingMinor, rmd.amountMinor));
    const taxMinor = Math.floor((withdrawalMinor * input.taxBps) / 10000);
    const returnMinor = portfolio > 0 ? Number(divRoundHalfAway(BigInt(portfolio) * BigInt(input.annualReturnBps), 120000n)) : 0;
    portfolio = portfolio + contributionMinor + returnMinor - withdrawalMinor;
    traditional = Math.max(0, Math.min(portfolio, traditional + contributionMinor - withdrawalMinor));
    months.push({ portfolioMinor: portfolio, traditionalMinor: traditional, contributionMinor, spendingMinor, withdrawalMinor, taxMinor, rmdMinor: rmd.amountMinor, returnMinor });
  }
  return {
    months,
    assumptions: [
      "Each month uses one twelfth of the annual return, contribution, and spending. It is not a separate monthly market path.",
      "The flat tax rate is an assumption you enter. It is not a federal or state bracket and it is not tax advice.",
      `Required minimum distributions use ${RMD_SOURCE}`,
      input.birthYear != null && input.birthYear >= 1960
        ? "A birth year of 1960 or later uses age 75 as the required beginning age in this model."
        : "When no birth year of 1960 or later is supplied, the required beginning age in this model is 73.",
      "A required distribution is taken from the traditional balance and is not added again as income in the household ledger.",
      "The same portfolio dollars are not also marked available to a separate goal.",
    ],
  };
}
