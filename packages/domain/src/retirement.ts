import { divRoundHalfAway } from "./money.js";

export class RetirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetirementError";
  }
}

export interface LifeEvent {
  age: number;
  /** Today's dollars. Positive is money in, negative is money out. Inflated on the household clock. */
  amountMinor: number;
  label: string;
}

export interface RetirementPerson {
  currentAge: number;
  retireAge: number;
  /** Social Security starts at this age. When omitted, it starts at retireAge. Pension starts at retireAge. */
  benefitAge?: number;
  socialSecurityAnnualMinor: number;
  pensionAnnualMinor: number;
}

export interface RetirementInput {
  people: RetirementPerson[];
  /** Household planning clock. It is not each person's age. */
  currentAge: number;
  endAge: number;
  portfolioMinor: number;
  annualContributionMinor: number;
  /** Annual spending in today's dollars. It starts when the first person reaches their own retirement age. */
  annualSpendingMinor: number;
  inflationBps: number;
  meanReturnBps: number;
  stdevBps: number;
  feeBps: number;
  iterations: number;
  seed: number;
  events?: LifeEvent[];
}

export interface RetirementYear {
  /** Household clock at the end of the modeled year. */
  age: number;
  /** Household clock at the start of the modeled year. */
  householdAge: number;
  portfolioMinor: number;
  withdrawalMinor: number;
  contributionMinor: number;
  benefitMinor: number;
  spendingMinor: number;
  eventMinor: number;
  unmetMinor: number;
  people: { modeledAge: number; retired: boolean; receivingBenefits: boolean }[];
}

export interface RetirementResult {
  successRateBps: number;
  medianEndingMinor: number;
  p10EndingMinor: number;
  p90EndingMinor: number;
  deterministicEndingMinor: number;
  deterministicUnmetMinor: number;
  deterministicSuccess: boolean;
  metric: string;
  assumptions: string[];
  yearlyDeterministic: RetirementYear[];
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

function assertAge(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 120) throw new RetirementError(`${label} must be a whole number from 0 to 120.`);
}

function assertPlan(input: RetirementInput) {
  if (!input.people.length) throw new RetirementError("Add at least one person.");
  assertAge(input.currentAge, "The household planning age");
  if (!Number.isInteger(input.endAge) || input.endAge <= input.currentAge || input.endAge > 140) {
    throw new RetirementError("The plan must end after the household age, and no later than 140.");
  }
  if (input.endAge - input.currentAge > 100) throw new RetirementError("The plan covers at most 100 years.");
  for (const person of input.people) {
    assertAge(person.currentAge, "A person's age");
    assertAge(person.retireAge, "A retirement age");
    assertAge(person.benefitAge ?? person.retireAge, "A benefit age");
    if (person.socialSecurityAnnualMinor < 0 || person.pensionAnnualMinor < 0) throw new RetirementError("Benefits cannot be negative.");
  }
  if (!Number.isInteger(input.portfolioMinor) || input.portfolioMinor < 0) throw new RetirementError("The starting portfolio cannot be negative.");
  if (!Number.isInteger(input.annualContributionMinor) || input.annualContributionMinor < 0) throw new RetirementError("The contribution cannot be negative.");
  if (!Number.isInteger(input.annualSpendingMinor) || input.annualSpendingMinor < 0) throw new RetirementError("Spending cannot be negative.");
  if (!Number.isInteger(input.iterations) || input.iterations < 1 || input.iterations > 2000) throw new RetirementError("Use between 1 and 2000 trials.");
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10000) throw new RetirementError("The fee must be from 0% to 100%.");
  if (!Number.isInteger(input.stdevBps) || input.stdevBps < 0) throw new RetirementError("The return spread cannot be negative.");
  if (!Number.isInteger(input.inflationBps) || input.inflationBps < -10000) throw new RetirementError("Inflation cannot fall below a complete loss of purchasing power.");
  if (!Number.isInteger(input.meanReturnBps)) throw new RetirementError("Enter the assumed return in basis points.");
  if (!Number.isInteger(input.seed)) throw new RetirementError("The seed must be a whole number.");
}

interface YearStep extends RetirementYear {
  failed: boolean;
}

function stepYear(age: number, portfolio: number, input: RetirementInput, annualReturnBps: number): YearStep {
  const elapsed = age - input.currentAge;
  const people = input.people.map((person) => {
    const modeledAge = person.currentAge + elapsed;
    const retired = modeledAge >= person.retireAge;
    const receivingBenefits = modeledAge >= (person.benefitAge ?? person.retireAge);
    return { person, modeledAge, retired, receivingBenefits };
  });
  const anyoneWorking = people.some((person) => !person.retired);
  const anyoneRetired = people.some((person) => person.retired);
  const contribution = anyoneWorking ? input.annualContributionMinor : 0;
  let benefits = 0;
  for (const person of people) {
    if (person.retired) benefits += inflate(person.person.pensionAnnualMinor, input.inflationBps, elapsed);
    if (person.receivingBenefits) benefits += inflate(person.person.socialSecurityAnnualMinor, input.inflationBps, elapsed);
  }
  const spending = anyoneRetired ? inflate(input.annualSpendingMinor, input.inflationBps, elapsed) : 0;
  let eventAmount = 0;
  for (const event of input.events ?? []) {
    if (event.age === age) eventAmount += inflate(event.amountMinor, input.inflationBps, elapsed);
  }
  const beforeReturn = portfolio + contribution + benefits + eventAmount - spending;
  if (!Number.isSafeInteger(beforeReturn)) throw new RetirementError("A modeled balance left the safe integer range.");
  const unmet = beforeReturn < 0 ? -beforeReturn : 0;
  const needFromPortfolio = spending - contribution - benefits - eventAmount;
  const withdrawal = needFromPortfolio > 0 ? Math.min(Math.max(0, portfolio), needFromPortfolio) : 0;
  let ending = beforeReturn;
  if (beforeReturn > 0) {
    const netBps = Math.max(-10000, annualReturnBps - input.feeBps);
    ending = Number(divRoundHalfAway(BigInt(beforeReturn) * BigInt(10000 + netBps), 10000n));
  }
  if (!Number.isSafeInteger(ending)) throw new RetirementError("A modeled balance left the safe integer range.");
  return {
    age: age + 1,
    householdAge: age,
    portfolioMinor: ending,
    withdrawalMinor: withdrawal,
    contributionMinor: contribution,
    benefitMinor: benefits,
    spendingMinor: spending,
    eventMinor: eventAmount,
    unmetMinor: unmet,
    failed: unmet > 0,
    people: people.map((person) => ({ modeledAge: person.modeledAge, retired: person.retired, receivingBenefits: person.receivingBenefits })),
  };
}

export function projectRetirement(input: RetirementInput): RetirementResult {
  assertPlan(input);
  const assumptions = [
    "Success means every modeled year funded its spending before investment returns. A later windfall does not erase an earlier shortfall.",
    "Each person's age is their own current age plus the years elapsed on the household clock. Retirement uses that age, not the household clock by itself.",
    "The household contribution continues while any person is still working. It stops only when every person has reached their own retirement age.",
    "Pension starts at a person's retirement age. Social Security starts at their benefit age, or at retirement when no separate benefit age is set.",
    "Spending starts when the first person retires. Income above spending stays in the portfolio. Life events use the household clock and are applied before spending.",
    "Returns and fees apply only to a positive balance, after that year's cash flow. A return cannot go below a total loss, and a negative balance does not earn a return.",
    "Monte Carlo draws are seeded so the same inputs replay. They are not a promise of market results.",
    "Monthly variation, taxes, and required minimum distributions are not modeled.",
  ];
  const rand = mulberry32(input.seed >>> 0);
  const endings: number[] = [];
  let successes = 0;
  for (let trial = 0; trial < input.iterations; trial++) {
    let portfolio = input.portfolioMinor;
    let failed = false;
    for (let age = input.currentAge; age < input.endAge; age++) {
      const draw = input.stdevBps > 0 ? boxMuller(rand) : 0;
      const annual = Math.round(input.meanReturnBps + draw * input.stdevBps);
      const step = stepYear(age, portfolio, input, annual);
      portfolio = step.portfolioMinor;
      if (step.failed) failed = true;
    }
    if (!failed) successes += 1;
    endings.push(portfolio);
  }
  endings.sort((a, b) => a - b);
  const at = (p: number) => endings[Math.min(endings.length - 1, Math.max(0, Math.round((endings.length - 1) * p)))] ?? 0;
  const yearlyDeterministic: RetirementYear[] = [];
  let portfolio = input.portfolioMinor;
  let unmet = 0;
  let failed = false;
  for (let age = input.currentAge; age < input.endAge; age++) {
    const step = stepYear(age, portfolio, input, input.meanReturnBps);
    portfolio = step.portfolioMinor;
    unmet += step.unmetMinor;
    if (step.failed) failed = true;
    const { failed: _failed, ...row } = step;
    void _failed;
    yearlyDeterministic.push(row);
  }
  return {
    successRateBps: Math.round((successes / input.iterations) * 10000),
    medianEndingMinor: at(0.5),
    p10EndingMinor: at(0.1),
    p90EndingMinor: at(0.9),
    deterministicEndingMinor: portfolio,
    deterministicUnmetMinor: unmet,
    deterministicSuccess: !failed,
    metric: "Share of seeded trials in which every year's spending was funded. Ending above zero is not enough if an earlier year ran short.",
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
  let grown = BigInt(input.currentPortfolioMinor);
  for (let i = 0; i < input.years; i++) grown = divRoundHalfAway(grown * BigInt(10000 + input.growthBps), 10000n);
  const gap = Math.max(0, input.targetPortfolioMinor - Number(grown));
  if (gap === 0) return { annualMinor: 0, assumptions: ["Current savings already reach the target at the assumed growth rate."] };
  let lo = 0;
  let hi = gap;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let value = 0n;
    const deposit = BigInt(mid);
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
