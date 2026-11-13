import { describe, expect, it } from "vitest";
import { projectRetirement, RetirementError } from "../src/retirement.js";

const quiet = {
  inflationBps: 0,
  meanReturnBps: 0,
  stdevBps: 0,
  feeBps: 0,
  iterations: 1,
  seed: 7,
  annualSpendingMinor: 0,
};

describe("retirement ages", () => {
  it("keeps a younger partner working after the older partner retires", () => {
    const result = projectRetirement({
      people: [
        { currentAge: 60, retireAge: 65, benefitAge: 67, socialSecurityAnnualMinor: 5, pensionAnnualMinor: 10 },
        { currentAge: 50, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 },
      ],
      currentAge: 60,
      endAge: 76,
      portfolioMinor: 1_000,
      annualContributionMinor: 100,
      ...quiet,
      annualSpendingMinor: 40,
      iterations: 2,
    });
    const at = (householdAge: number) => result.yearlyDeterministic.find((year) => year.householdAge === householdAge);
    const fifth = at(65);
    expect(fifth?.people.map((person) => person.modeledAge)).toEqual([65, 55]);
    expect(fifth?.people[1].retired).toBe(false);
    expect(fifth?.contributionMinor).toBe(100);
    expect(fifth?.spendingMinor).toBe(40);
    expect(fifth?.benefitMinor).toBe(10);
    const benefits = at(67);
    expect(benefits?.people[0].modeledAge).toBe(67);
    expect(benefits?.benefitMinor).toBe(15);
    expect(benefits?.contributionMinor).toBe(100);
    const later = at(75);
    expect(later?.people.map((person) => person.modeledAge)).toEqual([75, 65]);
    expect(later?.people[1].retired).toBe(true);
    expect(later?.contributionMinor).toBe(0);
    const again = projectRetirement({
      people: [
        { currentAge: 60, retireAge: 65, benefitAge: 67, socialSecurityAnnualMinor: 5, pensionAnnualMinor: 10 },
        { currentAge: 50, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 },
      ],
      currentAge: 60,
      endAge: 76,
      portfolioMinor: 1_000,
      annualContributionMinor: 100,
      ...quiet,
      annualSpendingMinor: 40,
      iterations: 2,
    });
    expect(again.yearlyDeterministic).toEqual(result.yearlyDeterministic);
  });

  it("matches straightforward arithmetic when return and inflation are zero", () => {
    const result = projectRetirement({
      people: [{ currentAge: 40, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 40,
      endAge: 50,
      portfolioMinor: 1_000_000,
      annualContributionMinor: 100_000,
      ...quiet,
    });
    expect(result.deterministicEndingMinor).toBe(2_000_000);
    expect(result.deterministicSuccess).toBe(true);
    expect(result.deterministicUnmetMinor).toBe(0);
    expect(result.successRateBps).toBe(10000);
  });

  it("keeps surplus income and does not let a later windfall erase a shortfall", () => {
    const surplus = projectRetirement({
      people: [{ currentAge: 70, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 500 }],
      currentAge: 70,
      endAge: 71,
      portfolioMinor: 1_000,
      annualContributionMinor: 0,
      ...quiet,
      annualSpendingMinor: 200,
    });
    expect(surplus.deterministicEndingMinor).toBe(1_300);
    expect(surplus.yearlyDeterministic[0].withdrawalMinor).toBe(0);

    const failed = projectRetirement({
      people: [{ currentAge: 70, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 70,
      endAge: 73,
      portfolioMinor: 50,
      annualContributionMinor: 0,
      ...quiet,
      annualSpendingMinor: 100,
      events: [{ age: 72, amountMinor: 1_000, label: "Later gift" }],
    });
    expect(failed.yearlyDeterministic[0].unmetMinor).toBe(50);
    expect(failed.deterministicSuccess).toBe(false);
    expect(failed.deterministicEndingMinor).toBe(750);
    expect(failed.successRateBps).toBe(0);

    const sameYear = projectRetirement({
      people: [{ currentAge: 70, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 70,
      endAge: 71,
      portfolioMinor: 50,
      annualContributionMinor: 0,
      ...quiet,
      annualSpendingMinor: 100,
      events: [{ age: 70, amountMinor: 1_000, label: "Gift this year" }],
    });
    expect(sameYear.deterministicSuccess).toBe(true);
    expect(sameYear.deterministicEndingMinor).toBe(950);
  });

  it("refuses a loss beyond the whole balance and a return on a shortfall", () => {
    const wiped = projectRetirement({
      people: [{ currentAge: 40, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 40,
      endAge: 41,
      portfolioMinor: 1_000,
      annualContributionMinor: 0,
      ...quiet,
      meanReturnBps: -20_000,
    });
    expect(wiped.deterministicEndingMinor).toBe(0);
    expect(wiped.deterministicSuccess).toBe(true);

    const short = projectRetirement({
      people: [{ currentAge: 70, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 70,
      endAge: 71,
      portfolioMinor: 0,
      annualContributionMinor: 0,
      ...quiet,
      annualSpendingMinor: 100,
      meanReturnBps: 10_000,
    });
    expect(short.deterministicEndingMinor).toBe(-100);
    expect(short.deterministicSuccess).toBe(false);
  });

  it("rejects an empty household and an invalid age", () => {
    expect(() => projectRetirement({
      people: [],
      currentAge: 60,
      endAge: 70,
      portfolioMinor: 0,
      annualContributionMinor: 0,
      ...quiet,
    })).toThrow(RetirementError);
    expect(() => projectRetirement({
      people: [{ currentAge: -1, retireAge: 65, socialSecurityAnnualMinor: 0, pensionAnnualMinor: 0 }],
      currentAge: 60,
      endAge: 70,
      portfolioMinor: 0,
      annualContributionMinor: 0,
      ...quiet,
    })).toThrow(/age/);
  });
});
