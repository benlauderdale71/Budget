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
  // Eligibility for this model's 2022-and-later table, not historical first deadlines.
  if (birthYear != null && birthYear <= 1950) return 72;
  if (birthYear != null && birthYear >= 1960) return 75;
  return 73;
}

export function uniformLifetimeRmd(balanceMinor: number, age: number): { amountMinor: number; denominatorTenths: number; note: string } {
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0) throw new MoneyError("The prior-year balance must be a non-negative integer number of minor units.");
  if (!Number.isInteger(age) || age < 0 || age > 170) throw new MoneyError("Enter a valid whole-year age.");
  const denominatorTenths = age >= 120 ? UNIFORM_LIFETIME_TENTHS[120] : UNIFORM_LIFETIME_TENTHS[age];
  if (!denominatorTenths) {
    return { amountMinor: 0, denominatorTenths: 0, note: `${RMD_SOURCE} Table III has no row for age ${age}, so this model does not invent a distribution.` };
  }
  const amountMinor = Number((BigInt(balanceMinor) * 10n + BigInt(denominatorTenths) - 1n) / BigInt(denominatorTenths));
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
  priorYearTraditionalMinor?: number;
  strategy?: "other_first" | "traditional_first";
  inheritedAccount?: boolean;
  youngerSpouseSoleBeneficiary?: boolean;
}

export function projectMonthlyRetirement(input: MonthlyRetirementInput) {
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 600) throw new MoneyError("Choose between 1 and 600 months.");
  for (const [label, value] of Object.entries({
    portfolio: input.portfolioMinor,
    traditional: input.traditionalMinor,
    spending: input.annualSpendingMinor,
    contribution: input.annualContributionMinor,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new MoneyError(`${label} must be a non-negative integer number of minor units.`);
  }
  if (input.traditionalMinor > input.portfolioMinor) throw new MoneyError("Traditional savings cannot exceed the whole portfolio.");
  if (!Number.isInteger(input.age) || input.age < 0 || input.age > 120) throw new MoneyError("Age must be between 0 and 120.");
  if (input.birthYear != null && (!Number.isInteger(input.birthYear) || input.birthYear < 1900 || input.birthYear + input.age < 2022)) throw new MoneyError("This model supports calendar years 2022 and later. Enter age at December 31 of the first modeled year.");
  if (!Number.isInteger(input.taxBps) || input.taxBps < 0 || input.taxBps >= 10000) throw new MoneyError("The assumed tax rate must be at least zero and below 100 percent.");
  if (!Number.isInteger(input.annualReturnBps) || input.annualReturnBps < -10000 || input.annualReturnBps > 100000) throw new MoneyError("Choose an annual return from -100 through 1000 percent.");
  if (input.priorYearTraditionalMinor != null && (!Number.isSafeInteger(input.priorYearTraditionalMinor) || input.priorYearTraditionalMinor < 0)) throw new MoneyError("Enter a valid prior December 31 traditional balance.");
  if (input.inheritedAccount || input.youngerSpouseSoleBeneficiary) throw new MoneyError("This model uses the original owner's Uniform Lifetime table. Inherited accounts and a sole-beneficiary spouse more than ten years younger need a different calculation.");
  if (input.strategy && input.strategy !== "other_first" && input.strategy !== "traditional_first") throw new MoneyError("Choose a supported withdrawal order.");
  const safe = (n: number) => { if (!Number.isSafeInteger(n)) throw new MoneyError("The projected amount exceeds the supported range."); return n; };
  const portion = (annual: number, month: number) => Math.floor(annual / 12) + (month < annual % 12 ? 1 : 0);
  const tax = (gross: number) => Number(divRoundHalfAway(BigInt(gross) * BigInt(input.taxBps), 10000n));
  const grossFor = (net: number) => safe(Number((BigInt(Math.max(0, net)) * 10000n + BigInt(9999 - input.taxBps)) / BigInt(10000 - input.taxBps)));
  const startAge = requiredBeginningAge(input.birthYear);
  const months = [];
  let traditional = input.traditionalMinor;
  let other = input.portfolioMinor - traditional;
  let decemberBalance = input.priorYearTraditionalMinor ?? traditional;
  for (let index = 0; index < input.months; index += 1) {
    const age = input.age + Math.floor(index / 12);
    const calendarMonth = index % 12;
    const contributionMinor = portion(input.annualContributionMinor, calendarMonth);
    const spendingMinor = portion(input.annualSpendingMinor, calendarMonth);
    const rmdMinor = calendarMonth === 0 && age >= startAge ? uniformLifetimeRmd(decemberBalance, age).amountMinor : 0;
    const traditionalReturn = Number(divRoundHalfAway(BigInt(traditional) * BigInt(input.annualReturnBps), 120000n));
    const otherReturn = Number(divRoundHalfAway(BigInt(other) * BigInt(input.annualReturnBps), 120000n));
    traditional = safe(traditional + traditionalReturn + contributionMinor);
    other = safe(other + otherReturn);
    const needed = input.strategy === "traditional_first" ? spendingMinor : Math.max(0, spendingMinor - other);
    const withdrawalMinor = Math.min(traditional, Math.max(rmdMinor, grossFor(needed)));
    const taxMinor = tax(withdrawalMinor);
    traditional -= withdrawalMinor;
    other = safe(other + withdrawalMinor - taxMinor);
    const fundedSpendingMinor = Math.min(other, spendingMinor);
    other -= fundedSpendingMinor;
    const portfolioMinor = safe(traditional + other);
    months.push({ month: index + 1, age, portfolioMinor, traditionalMinor: traditional, otherMinor: other, contributionMinor, spendingMinor, fundedSpendingMinor, unmetSpendingMinor: spendingMinor - fundedSpendingMinor, withdrawalMinor, taxMinor, rmdMinor, unmetRmdMinor: Math.max(0, rmdMinor - withdrawalMinor), returnMinor: traditionalReturn + otherReturn });
    if (calendarMonth === 11) decemberBalance = traditional;
  }
  return {
    months,
    assumptions: [
      "The model starts January 1. Age means age on December 31 of that first year. Annual spending and contributions are divided across twelve months without dropping cents; return is the annual rate divided by twelve, before contributions and withdrawals.",
      "The flat assumed tax applies only to traditional withdrawals and is paid from the portfolio. Other funds and their withdrawals have no modeled tax; capital-gains tax, tax brackets, inflation, early-withdrawal penalties, and contribution eligibility are not modeled.",
      `Required minimum distributions use ${RMD_SOURCE}`,
      `Distribution eligibility in this 2022-and-later model starts at ${startAge}. A missing birth year assumes 73. Historical first-distribution deadlines and inherited-account rules are not modeled.`,
      "The full modeled annual RMD is withdrawn in January using the prior December 31 balance, rounded up to the next cent. First-year deferral to April is not modeled. Later RMDs use the preceding modeled December balance.",
      input.priorYearTraditionalMinor == null ? "The initial traditional balance is assumed to be the prior December 31 balance because no separate value was entered." : "The first RMD uses the separate prior December 31 balance entered.",
      "Unused distributions remain in the other-funds pool after tax. They do not disappear and are not counted as new investment growth. Both pools use the same assumed return. Contributions go to the traditional pool.",
      `Withdrawal order: ${input.strategy === "traditional_first" ? "traditional funds first" : "other funds first"}, while satisfying the modeled RMD. Unfunded spending and RMD shortfalls are reported rather than creating negative balances.`,
      "No household transaction, cash balance, goal assignment, or tax filing is changed by this comparison.",
    ],
  };
}
