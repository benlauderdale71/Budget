import { test } from "node:test";
import assert from "node:assert/strict";
import { presetSpendingRange, spendingCalendar, spendingFiltersFrom, spendingMonthRange, spendingQuery, spendingYearRange, updateSpendingFilters } from "../src/spending-filters.ts";

const today = "2026-11-17";
test("a historical date selection drives the annual overview even with a stale year parameter", () => {
  for (const suffix of ["", "&year=2026"]) {
    const filters = spendingFiltersFrom(new URLSearchParams(`from=2025-01-01&to=2025-12-31${suffix}`), today);
    assert.deepEqual(spendingCalendar(filters, today), { year: 2025, month: 11 });
    assert.equal(spendingQuery(filters), "from=2025-01-01&to=2025-12-31");
  }
  assert.deepEqual(spendingFiltersFrom(new URLSearchParams("year=2024"), today), spendingYearRange(2024));
});

test("year, month, shortcuts and reset use one date range, including leap years", () => {
  let filters = { ...spendingYearRange(2025), accountId: "checking", tag: "household" };
  filters = updateSpendingFilters(filters, spendingMonthRange(2024, 1)) as typeof filters;
  assert.deepEqual(filters, { from: "2024-02-01", to: "2024-02-29", accountId: "checking", tag: "household" });
  assert.deepEqual(spendingCalendar(filters, today), { year: 2024, month: 1 });
  assert.deepEqual(presetSpendingRange("last-year", today), spendingYearRange(2025));
  assert.deepEqual(spendingCalendar(presetSpendingRange("last-month", "2026-01-03"), today), { year: 2025, month: 11 });
  const reset = spendingFiltersFrom(new URLSearchParams(spendingQuery(presetSpendingRange("month", today))), today);
  assert.deepEqual(reset, { from: "2026-11-01", to: today });
  assert.deepEqual(spendingCalendar(reset, today), { year: 2026, month: 10 });
});

test("drilling preserves dates and unrelated filters while replacing conflicting category and merchant filters", () => {
  const start = { ...spendingMonthRange(2026, 9), accountId: "checking", tag: "household", merchantGroup: "Walmart", group: "Living", bucketId: "food" };
  const merchant = updateSpendingFilters(start, { merchant: "SAMSCLUB #123" });
  assert.equal(merchant.merchantGroup, "");
  assert.equal(merchant.to, "2026-10-31");
  assert.equal(merchant.accountId, "checking");
  assert.equal(merchant.tag, "household");
  const grouped = updateSpendingFilters(merchant, { merchantGroup: "Sam's Club" });
  assert.equal(grouped.merchant, "");
  assert.equal(updateSpendingFilters(grouped, { group: "Debt" }).bucketId, "");
  assert.equal(updateSpendingFilters(grouped, { bucketId: "uncategorized" }).group, "");
  assert.equal(spendingCalendar(grouped, today).month, 9);
});

test("a range spanning years uses the ending year, and invalid dates cannot create an invalid month index", () => {
  assert.deepEqual(spendingCalendar({ from: "2025-10-01", to: "2026-03-31" }, today), { year: 2026, month: 2 });
  assert.deepEqual(spendingCalendar({ from: "bad", to: "2026-99-01" }, today), { year: 2026, month: 10 });
});
