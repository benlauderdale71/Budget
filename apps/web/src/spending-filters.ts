import type { SpendingFilters } from "@budgetcents/domain";
import { addDays, addMonths, isIsoDate, periodFromDate } from "@budgetcents/domain/dates";

export const spendingFilterKeys = ["accountId", "bucketId", "group", "merchant", "merchantGroup", "tag", "review", "q"] as const;

export function spendingYearRange(year: number) {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export function spendingMonthRange(year: number, month: number) {
  const period = periodFromDate(`${year}-${String(month + 1).padStart(2, "0")}-01`);
  return { from: period.start, to: period.end };
}

export function presetSpendingRange(preset: string, today: string) {
  const month = periodFromDate(today);
  if (preset === "last-month") { const last = periodFromDate(addMonths(month.start, -1)); return { from: last.start, to: last.end }; }
  if (preset === "90-days") return { from: addDays(today, -89), to: today };
  if (preset === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (preset === "last-year") return spendingYearRange(Number(today.slice(0, 4)) - 1);
  return { from: month.start, to: today };
}

export function spendingFiltersFrom(params: URLSearchParams, today: string): SpendingFilters {
  // Existing year-only bookmarks still work; explicit dates always take precedence.
  const legacyYear = Number(params.get("year"));
  const fallback = !params.has("from") && !params.has("to") && Number.isInteger(legacyYear) && legacyYear >= 1900 && legacyYear <= 2200
    ? spendingYearRange(legacyYear) : presetSpendingRange("month", today);
  return { ...fallback, ...Object.fromEntries(["from", "to", ...spendingFilterKeys].flatMap(key => params.get(key) ? [[key, params.get(key)!]] : [])) };
}

export function spendingCalendar(filters: SpendingFilters, today: string) {
  const date = isIsoDate(filters.to) ? filters.to : today;
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) - 1 };
}

export function spendingQuery(filters: SpendingFilters) {
  return new URLSearchParams(Object.entries(filters).filter(([, value]) => !!value)).toString();
}

export function updateSpendingFilters(current: SpendingFilters, patch: Partial<SpendingFilters>): SpendingFilters {
  const next = { ...current, ...patch };
  if ("merchant" in patch && !("merchantGroup" in patch)) next.merchantGroup = "";
  if ("merchantGroup" in patch && !("merchant" in patch)) next.merchant = "";
  if ("group" in patch && !("bucketId" in patch)) next.bucketId = "";
  if ("bucketId" in patch && !("group" in patch)) next.group = "";
  return next;
}
