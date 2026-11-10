import { divRoundHalfAway } from "./money.js";

export interface LifeEvent {
  age: number;
  /** Today's dollars. Positive is money in, negative is money out. */
  amountMinor: number;
  label: string;
}

export interface RetirementPerson {
  currentAge: number;
  retireAge: number;
  socialSecurityAnnualMinor: number;
  pensionAnnualMinor: number;
}

export interface RetirementInput {
  people: RetirementPerson[];
  /** Planning age of the household clock (usually the older or the primary earner). */
  currentAge: number;
  endAge: number;
  portfolioMinor: number;
  annualContributionMinor: number;
  /** Annual spending in today's dollars, starting at the first retirement. */
  annualSpendingMinor: number;
  inflationBps: number;
  meanReturnBps: number;
  stdevBps: number;
  feeBps: number;
  iterations: number;
  seed: number;
  events?: LifeEvent[];
}

export interface RetirementResult {
  successRateBps: number;
  medianEndingMinor: number;
  p10EndingMinor: number;
  p90EndingMinor: number;
  deterministicEndingMinor: number;
  metric: string;
  assumptions: string[];
  yearlyDeterministic: { age: number; portfolioMinor: number; withdrawalMinor: number }[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function inflate(baseMinor: number, inflationBps: number, years: number): number {
  let value = BigInt(baseMinor);
  for (let i = 0; i < years; i++) value = divRoundHalfAway(value * BigInt(10000 + inflationBps), 10000n);
  return Number(value);
}

interface YearInput {
  age: number;
  portfolio: number;
  input: RetirementInput;
  annualReturnBps: number;
}

function stepYear({ age, portfolio, input, annualReturnBps }: YearInput): { portfolio: number; withdrawal: number } {
  const yearsOut = age - input.currentAge;
  const firstRetire = Math.min(...input.people.map((person) => person.retireAge));
  const retired = age >= firstRetire;
  let flow = 0;
  if (!retired) flow += input.annualContributionMinor;
  let withdrawal = 0;
  if (retired) {
    const spending = inflate(input.annualSpendingMinor, input.inflationBps, yearsOut);
    let income = 0;
    for (const person of input.people) {
      if (age >= person.retireAge) {
        income += inflate(person.socialSecurityAnnualMinor + person.pensionAnnualMinor, input.inflationBps, yearsOut);
      }
    }
    withdrawal = Math.max(0, spending - income);
    flow -= withdrawal;
  }
  for (const event of input.events ?? []) {
    if (event.age === age) flow += inflate(event.amountMinor, input.inflationBps, yearsOut);
  }
  const netBps = annualReturnBps - input.feeBps;
  let next = BigInt(portfolio + flow);
  next = divRoundHalfAway(next * BigInt(10000 + netBps), 10000n);
  return { portfolio: Number(next < 0n ? 0n : next), withdrawal };
}

export function projectRetirement(input: RetirementInput): RetirementResult {
  const assumptions = [
    "Success means the portfolio is still above zero at the ending age in that trial.",
    "Contributions happen before retirement. Spending, Social Security, and pensions are inflated from today's dollars.",
    "The annual return is applied once a year after that year's cash flow. Fees are subtracted from the return.",
    "Monte Carlo draws are seeded so the same inputs replay. They are not a promise of market results.",
    "Monthly variation is not modeled; each trial uses one annual return drawn from the mean and standard deviation you entered.",
  ];
  const rand = mulberry32(input.seed);
  const endings: number[] = [];
  let successes = 0;
  const iterations = Math.max(1, Math.min(5000, input.iterations));
  for (let trial = 0; trial < iterations; trial++) {
    let portfolio = input.portfolioMinor;
    let failed = false;
    for (let age = input.currentAge; age < input.endAge; age++) {
      const draw = input.stdevBps > 0 ? boxMuller(rand) : 0;
      const annual = Math.round(input.meanReturnBps + draw * input.stdevBps);
      const step = stepYear({ age, portfolio, input, annualReturnBps: annual });
      portfolio = step.portfolio;
      if (portfolio <= 0 && step.withdrawal > 0) failed = true;
    }
    if (!failed && portfolio > 0) successes += 1;
    endings.push(portfolio);
  }
  endings.sort((a, b) => a - b);
  const at = (p: number) => endings[Math.min(endings.length - 1, Math.max(0, Math.round((endings.length - 1) * p)))] ?? 0;
  const yearlyDeterministic: { age: number; portfolioMinor: number; withdrawalMinor: number }[] = [];
  let portfolio = input.portfolioMinor;
  for (let age = input.currentAge; age < input.endAge; age++) {
    const step = stepYear({ age, portfolio, input, annualReturnBps: input.meanReturnBps });
    portfolio = step.portfolio;
    yearlyDeterministic.push({ age: age + 1, portfolioMinor: portfolio, withdrawalMinor: step.withdrawal });
  }
  return {
    successRateBps: Math.round((successes / iterations) * 10000),
    medianEndingMinor: at(0.5),
    p10EndingMinor: at(0.1),
    p90EndingMinor: at(0.9),
    deterministicEndingMinor: portfolio,
    metric: "Share of seeded trials in which the portfolio never hit zero before the ending age.",
    assumptions,
    yearlyDeterministic,
  };
}

export function contributionGap(input: {
  targetPortfolioMinor: number;
  currentPortfolioMinor: number;
  years: number;
  growthBps: number;
}): { annualMinor: number; assumptions: string[] } {
  if (input.years <= 0) return { annualMinor: 0, assumptions: ["No years remain."] };
  // Future value of current assets, then annuity payment for the gap. Integer search.
  let grown = BigInt(input.currentPortfolioMinor);
  for (let i = 0; i < input.years; i++) grown = divRoundHalfAway(grown * BigInt(10000 + input.growthBps), 10000n);
  const gap = Math.max(0, input.targetPortfolioMinor - Number(grown));
  if (gap === 0) return { annualMinor: 0, assumptions: ["Current savings already reach the target at the assumed growth rate."] };
  // Solve payment P such that P * ((1+r)^n - 1) / r ≈ gap. Binary search in minor units.
  let lo = 0;
  let hi = gap;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let value = 0n;
    let deposit = BigInt(mid);
    for (let i = 0; i < input.years; i++) {
      value = divRoundHalfAway((value + deposit) * BigInt(10000 + input.growthBps), 10000n);
    }
    if (value >= BigInt(gap)) hi = mid;
    else lo = mid + 1;
  }
  return {
    annualMinor: lo,
    assumptions: [
      "The gap is the target minus today's portfolio grown at a constant annual rate.",
      "Contributions are made at the start of each year and then grow. This is not tax or pension advice.",
    ],
  };
}
