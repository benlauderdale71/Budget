import { describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget.js";
import {
  expandSchedule,
  nextScheduleDate,
  scenarioAmount,
  SCHEDULE_EXPLANATION,
  showIncomeOccurrences,
  type RepeatingSchedule,
} from "../src/income.js";

function monthly(anchor: number, start: string): RepeatingSchedule {
  return { cadence: "monthly", startDate: start, anchorDay: anchor, amountMinor: 100 };
}

describe("income dates", () => {
  it("keeps a 31st anchor after February", () => {
    const schedule = monthly(31, "2026-01-31");
    const dates = expandSchedule(schedule, "2026-01-01", "2026-05-31").map((item) => item.date);
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(nextScheduleDate("2026-02-28", schedule)).toBe("2026-03-31");
  });

  it("returns February 29 in the next leap year", () => {
    const dates = expandSchedule(
      { cadence: "annual", startDate: "2024-02-29", anchorDay: 29, amountMinor: 100 },
      "2024-01-01",
      "2028-12-31",
    ).map((item) => item.date);
    expect(dates).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  it("keeps twice-monthly days distinct from every two weeks", () => {
    const twice = expandSchedule(
      { cadence: "twice_monthly", startDate: "2026-01-01", twiceDays: [1, 15], amountMinor: 100 },
      "2026-01-01",
      "2026-02-28",
    ).map((item) => item.date);
    const biweekly = expandSchedule(
      { cadence: "biweekly", startDate: "2026-01-01", amountMinor: 100 },
      "2026-01-01",
      "2026-02-28",
    ).map((item) => item.date);
    expect(twice).toEqual(["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]);
    expect(biweekly).toEqual(["2026-01-01", "2026-01-15", "2026-01-29", "2026-02-12", "2026-02-26"]);
  });

  it("rejects a missing custom interval instead of using 30 days", () => {
    expect(() => expandSchedule({ cadence: "every_n_days", startDate: "2026-01-01", amountMinor: 100 }, "2026-01-01", "2026-03-01")).toThrow(BudgetError);
    expect(() => expandSchedule({ cadence: "every_n_days", startDate: "2026-01-01", customInterval: 0, amountMinor: 100 }, "2026-01-01", "2026-03-01")).toThrow(/not changed to 30 days/);
    const dates = expandSchedule(
      { cadence: "every_n_days", startDate: "2026-01-01", customInterval: 10, amountMinor: 100 },
      "2026-01-01",
      "2026-02-01",
    ).map((item) => item.date);
    expect(dates).toEqual(["2026-01-01", "2026-01-11", "2026-01-21", "2026-01-31"]);
    expect(dates).not.toContain("2026-01-31".replace("31", "30") && "2026-01-30");
  });

  it("uses an explicit irregular list and does not invent a monthly series", () => {
    const dates = expandSchedule(
      {
        cadence: "irregular",
        startDate: "2026-01-01",
        amountMinor: 0,
        dates: [
          { date: "2026-03-03", amountMinor: 120000 },
          { date: "2026-04-18", amountMinor: 65000 },
        ],
      },
      "2026-01-01",
      "2026-12-31",
    );
    expect(dates).toEqual([
      { date: "2026-03-03", amountMinor: 120000, amountMaxMinor: null },
      { date: "2026-04-18", amountMinor: 65000, amountMaxMinor: null },
    ]);
  });

  it("skips an exception without moving the following date, and honors an inclusive end", () => {
    const skipped = expandSchedule(
      { cadence: "monthly", startDate: "2026-01-15", anchorDay: 15, amountMinor: 50, exceptions: ["2026-02-15"], endDate: "2026-03-15" },
      "2026-01-01",
      "2026-06-01",
    ).map((item) => item.date);
    expect(skipped).toEqual(["2026-01-15", "2026-03-15"]);
  });

  it("changes one expected occurrence and drops a received one from the forecast", () => {
    const schedule: RepeatingSchedule = {
      cadence: "irregular",
      startDate: "2026-03-01",
      amountMinor: 0,
      dates: [
        { date: "2026-03-03", amountMinor: 120000 },
        { date: "2026-04-18", amountMinor: 65000 },
      ],
    };
    const shown = showIncomeOccurrences({
      sourceId: "src",
      schedule,
      asOf: "2026-03-01",
      scenario: "expected",
      from: "2026-03-01",
      until: "2026-05-01",
      states: [
        { expectedDate: "2026-03-03", status: "received", expectedAmountMinor: 120000, receivedAmountMinor: 110000, receivedDate: "2026-03-04", transactionId: "txn" },
        { expectedDate: "2026-04-18", status: "expected", expectedAmountMinor: 65000, revisedDate: "2026-04-20", revisedAmountMinor: 70000 },
      ],
    });
    expect(shown.find((item) => item.expectedDate === "2026-03-03")).toMatchObject({ countsAsExpected: false, receivedAmountMinor: 110000 });
    expect(shown.find((item) => item.expectedDate === "2026-04-18")).toMatchObject({ date: "2026-04-20", amountMinor: 70000, countsAsExpected: true });
    expect(shown.filter((item) => item.countsAsExpected).reduce((sum, item) => sum + item.amountMinor, 0)).toBe(70000);
  });

  it("shows only the remainder of a partial paycheck and moves a delay", () => {
    const schedule: RepeatingSchedule = { cadence: "once", startDate: "2026-05-01", amountMinor: 120000 };
    const partial = showIncomeOccurrences({
      sourceId: "src",
      schedule,
      asOf: "2026-04-01",
      scenario: "optimistic",
      from: "2026-04-01",
      until: "2026-06-01",
      states: [{ expectedDate: "2026-05-01", status: "partial", expectedAmountMinor: 120000, remainingMinor: 70000, receivedAmountMinor: 50000, transactionId: "txn" }],
    });
    expect(partial[0]).toMatchObject({ amountMinor: 70000, countsAsExpected: true, inFutureForecast: true, status: "partial" });
    const delayed = showIncomeOccurrences({
      sourceId: "src",
      schedule,
      asOf: "2026-05-02",
      scenario: "expected",
      from: "2026-05-01",
      until: "2026-05-31",
      states: [{ expectedDate: "2026-05-01", status: "delayed", expectedAmountMinor: 120000, delayedUntil: "2026-05-20" }],
    });
    expect(delayed[0]).toMatchObject({ date: "2026-05-20", status: "delayed", inFutureForecast: true });
    expect(SCHEDULE_EXPLANATION).toMatch(/31st/);
    expect(SCHEDULE_EXPLANATION).toMatch(/time zone/i);
  });

  it("uses the low, midpoint, and high amounts for a range", () => {
    expect(scenarioAmount(1000, 1500, "conservative")).toBe(1000);
    expect(scenarioAmount(1000, 1500, "expected")).toBe(1250);
    expect(scenarioAmount(1000, 1500, "optimistic")).toBe(1500);
    expect(scenarioAmount(1000, null, "optimistic")).toBe(1000);
  });
});
