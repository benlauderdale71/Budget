import { describe, expect, it } from "vitest";
import { essentialObligations, monthlyEquivalentMinor } from "../src/reports.js";
import type { Account, Bucket, Schedule } from "../src/types.js";

const housing: Bucket = {
  id: "housing", name: "Housing", group: "Bills", kind: "expense", flexRole: "fixed", envelopeStyle: "regular", rollover: "both",
};
const fun: Bucket = {
  id: "fun", name: "Fun", group: "Spending", kind: "expense", flexRole: "flexible", envelopeStyle: "regular", rollover: "both",
};

function schedule(partial: Partial<Schedule> & Pick<Schedule, "id" | "type" | "direction" | "amountMinor">): Schedule {
  return {
    name: partial.id,
    cadence: "monthly",
    nextDate: "2026-11-01",
    confirmed: true,
    ...partial,
  };
}

describe("essential obligations", () => {
  it("adds confirmed bills and a loan minimum that is not already scheduled", () => {
    const accounts: Account[] = [
      { id: "chk", name: "Checking", kind: "checking", currency: "USD", onBudget: true },
      { id: "car", name: "Car", kind: "loan", currency: "USD", onBudget: false, minimumPaymentMinor: 32_000 },
    ];
    const result = essentialObligations({
      schedules: [
        schedule({ id: "rent", name: "Rent", type: "bill", direction: "outflow", amountMinor: 180_000, bucketId: "housing", accountId: "chk" }),
        schedule({ id: "pay", name: "Pay", type: "income", direction: "inflow", amountMinor: 320_000 }),
        schedule({ id: "move", name: "Fill", type: "fill", direction: "outflow", amountMinor: 5_000, bucketId: "housing" }),
        schedule({ id: "guess", name: "Flexible guess", type: "bill", direction: "outflow", amountMinor: 2_000, bucketId: "fun", confirmed: false }),
      ],
      buckets: [housing, fun],
      accounts,
    });
    expect(result.amountMinor).toBe(212_000);
    expect(result.sources.map((source) => source.name)).toEqual(["Rent", "Car minimum"]);
    expect(result.formula).toMatch(/No default amount/);
    expect(monthlyEquivalentMinor(1_200, "weekly")).toBe(Math.round((1_200 * 52) / 12));
  });

  it("is zero when the household has not selected any obligation", () => {
    const result = essentialObligations({
      schedules: [schedule({ id: "fun", name: "Fun money", type: "expense" as Schedule["type"], direction: "outflow", amountMinor: 4_000, bucketId: "fun" })],
      buckets: [fun],
      accounts: [],
    });
    expect(result.amountMinor).toBe(0);
    expect(result.formula).toMatch(/zero/);
  });
});
