import { BudgetError } from "./budget.js";
import { addDays, isIsoDate, pad } from "./dates.js";

/**
 * Income and bill dates. An invalid custom interval throws.
 * It is never replaced with 30 days. A monthly anchor is remembered
 * across short months, so the 31st returns after February.
 * Twice a month and every two weeks stay different schedules.
 */

export const SCHEDULE_EXPLANATION =
  "Dates follow the household calendar. The household time zone decides which day is today; a date you pick is stored as that calendar day and does not shift to the previous UTC day. A short month uses the last real day, then the next month returns to the anchored day, so a schedule anchored to the 31st does not become the 28th forever after February. February 29 stays the anchor and uses February 28 in years that are not leap years. Twice a month uses the two days you choose. Every two weeks adds 14 days and is a different schedule. An irregular list is only the dates and amounts you enter. It is not a monthly recurrence. An invalid custom interval is rejected and is not replaced with 30 days.";

export type ScheduleCadence =
  | "weekly"
  | "biweekly"
  | "twice_monthly"
  | "monthly"
  | "every_2_months"
  | "every_3_months"
  | "every_6_months"
  | "annual"
  | "every_n_days"
  | "every_n_weeks"
  | "once"
  | "irregular";

export type IncomeScenario = "conservative" | "expected" | "optimistic";

export interface DatedAmount {
  date: string;
  amountMinor: number;
  amountMaxMinor?: number | null;
}

export interface RepeatingSchedule {
  cadence: ScheduleCadence;
  startDate: string;
  endDate?: string | null;
  customInterval?: number | null;
  anchorDay?: number | null;
  twiceDays?: [number, number] | null;
  amountMinor: number;
  amountMaxMinor?: number | null;
  dates?: DatedAmount[];
  exceptions?: string[];
}

const CADENCES = new Set<ScheduleCadence>([
  "weekly",
  "biweekly",
  "twice_monthly",
  "monthly",
  "every_2_months",
  "every_3_months",
  "every_6_months",
  "annual",
  "every_n_days",
  "every_n_weeks",
  "once",
  "irregular",
]);

const CADENCE_ALIASES: Record<string, ScheduleCadence> = {
  semimonthly: "twice_monthly",
  yearly: "annual",
  annually: "annual",
  custom: "every_n_days",
};

export function coerceCadence(value: string): ScheduleCadence | null {
  const cadence = CADENCE_ALIASES[value] ?? value;
  return CADENCES.has(cadence as ScheduleCadence) ? (cadence as ScheduleCadence) : null;
}

export function clampCalendarDay(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

function requireDate(value: string, label: string): string {
  if (!isIsoDate(value)) throw new BudgetError(`${label} must be YYYY-MM-DD.`);
  return value;
}

function requireMoney(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new BudgetError(`${label} has to be zero or more, in minor units.`);
}

export function assertRepeatingSchedule(schedule: RepeatingSchedule): void {
  if (!CADENCES.has(schedule.cadence)) throw new BudgetError("That schedule is not one BudgetCents can keep.");
  requireDate(schedule.startDate, "Start date");
  if (schedule.endDate) {
    requireDate(schedule.endDate, "End date");
    if (schedule.endDate < schedule.startDate) throw new BudgetError("The end date is before the start date.");
  }
  requireMoney(schedule.amountMinor, "The planning amount");
  if (schedule.amountMaxMinor != null) {
    requireMoney(schedule.amountMaxMinor, "The high estimate");
    if (schedule.amountMaxMinor < schedule.amountMinor) throw new BudgetError("The high estimate cannot be below the planning amount.");
  }
  if (schedule.cadence === "every_n_days") {
    if (!Number.isInteger(schedule.customInterval) || schedule.customInterval! < 1 || schedule.customInterval! > 366) {
      throw new BudgetError("A custom day interval has to be a whole number from 1 to 366. It was not changed to 30 days.");
    }
  }
  if (schedule.cadence === "every_n_weeks") {
    if (!Number.isInteger(schedule.customInterval) || schedule.customInterval! < 1 || schedule.customInterval! > 52) {
      throw new BudgetError("A custom week interval has to be a whole number from 1 to 52. It was not changed to 30 days.");
    }
  }
  if (schedule.cadence === "twice_monthly") {
    const days = schedule.twiceDays;
    if (!days || days.length !== 2 || days[0] === days[1] || days.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
      throw new BudgetError("Twice a month needs two different days from 1 to 31. Every two weeks is a different schedule.");
    }
  }
  if (monthStep(schedule.cadence)) {
    const anchor = schedule.anchorDay ?? Number(schedule.startDate.slice(8, 10));
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new BudgetError("The anchored day has to be between 1 and 31.");
  }
  if (schedule.cadence === "irregular") {
    if (!schedule.dates?.length) throw new BudgetError("An irregular source needs each expected date and amount. It does not repeat monthly.");
    const seen = new Set<string>();
    for (const item of schedule.dates) {
      requireDate(item.date, "Expected date");
      if (seen.has(item.date)) throw new BudgetError(`Two amounts are listed for ${item.date}. Keep one row per date.`);
      seen.add(item.date);
      requireMoney(item.amountMinor, "Each expected amount");
      if (item.amountMaxMinor != null) {
        requireMoney(item.amountMaxMinor, "Each high estimate");
        if (item.amountMaxMinor < item.amountMinor) throw new BudgetError("A listed high estimate cannot be below that date's amount.");
      }
    }
  }
  for (const date of schedule.exceptions ?? []) requireDate(date, "Exception");
}

function monthStep(cadence: ScheduleCadence): number | null {
  if (cadence === "monthly") return 1;
  if (cadence === "every_2_months") return 2;
  if (cadence === "every_3_months") return 3;
  if (cadence === "every_6_months") return 6;
  if (cadence === "annual") return 12;
  return null;
}

function stepDays(schedule: RepeatingSchedule): number | null {
  if (schedule.cadence === "weekly") return 7;
  if (schedule.cadence === "biweekly") return 14;
  if (schedule.cadence === "every_n_days") return schedule.customInterval ?? null;
  if (schedule.cadence === "every_n_weeks") return schedule.customInterval ? schedule.customInterval * 7 : null;
  return null;
}

function anchorOf(schedule: RepeatingSchedule): number {
  return schedule.anchorDay ?? Number(schedule.startDate.slice(8, 10));
}

function addMonthsTo(year: number, month: number, count: number): { year: number; month: number } {
  const target = new Date(Date.UTC(year, month - 1 + count, 1));
  return { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1 };
}

/** The next date after `current`. The anchor is the stored day, not the clamped day of `current`. */
export function nextScheduleDate(current: string, schedule: RepeatingSchedule): string | null {
  requireDate(current, "Current date");
  if (schedule.cadence === "once" || schedule.cadence === "irregular") return null;
  const days = stepDays(schedule);
  let next: string;
  if (days) {
    next = addDays(current, days);
  } else if (schedule.cadence === "twice_monthly" && schedule.twiceDays) {
    const [firstDay, secondDay] = [...schedule.twiceDays].sort((a, b) => a - b);
    const year = Number(current.slice(0, 4));
    const month = Number(current.slice(5, 7));
    const later = [clampCalendarDay(year, month, firstDay), clampCalendarDay(year, month, secondDay)]
      .filter((date, index, all) => all.indexOf(date) === index && date > current)
      .sort();
    if (later.length) next = later[0];
    else {
      const following = addMonthsTo(year, month, 1);
      next = clampCalendarDay(following.year, following.month, firstDay);
    }
  } else {
    const months = monthStep(schedule.cadence);
    if (!months) return null;
    const following = addMonthsTo(Number(current.slice(0, 4)), Number(current.slice(5, 7)), months);
    next = clampCalendarDay(following.year, following.month, anchorOf(schedule));
  }
  if (schedule.endDate && next > schedule.endDate) return null;
  return next;
}

function firstDate(schedule: RepeatingSchedule): string | null {
  if (schedule.endDate && schedule.startDate > schedule.endDate) return null;
  const days = stepDays(schedule);
  if (days) return schedule.startDate;
  if (schedule.cadence === "twice_monthly" && schedule.twiceDays) {
    let year = Number(schedule.startDate.slice(0, 4));
    let month = Number(schedule.startDate.slice(5, 7));
    for (let guard = 0; guard < 18; guard++) {
      const found = [...schedule.twiceDays]
        .map((day) => clampCalendarDay(year, month, day))
        .filter((date, index, all) => all.indexOf(date) === index && date >= schedule.startDate)
        .sort();
      if (found.length) return schedule.endDate && found[0] > schedule.endDate ? null : found[0];
      const following = addMonthsTo(year, month, 1);
      year = following.year;
      month = following.month;
    }
    return null;
  }
  const months = monthStep(schedule.cadence);
  if (!months) return null;
  let year = Number(schedule.startDate.slice(0, 4));
  let month = Number(schedule.startDate.slice(5, 7));
  for (let guard = 0; guard < 40; guard++) {
    const date = clampCalendarDay(year, month, anchorOf(schedule));
    if (date >= schedule.startDate) return schedule.endDate && date > schedule.endDate ? null : date;
    const following = addMonthsTo(year, month, months);
    year = following.year;
    month = following.month;
  }
  return null;
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

export function expandSchedule(schedule: RepeatingSchedule, from: string, until: string, limit = 400): DatedAmount[] {
  assertRepeatingSchedule(schedule);
  requireDate(from, "From");
  requireDate(until, "Until");
  if (from > until || limit < 1) return [];
  const exceptions = new Set(schedule.exceptions ?? []);
  if (schedule.cadence === "irregular") {
    return [...(schedule.dates ?? [])]
      .filter((item) => item.date >= schedule.startDate && item.date >= from && item.date <= until && (!schedule.endDate || item.date <= schedule.endDate) && !exceptions.has(item.date))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, limit)
      .map((item) => ({ date: item.date, amountMinor: item.amountMinor, amountMaxMinor: item.amountMaxMinor ?? null }));
  }
  if (schedule.cadence === "once") {
    const date = schedule.startDate;
    if (date < from || date > until || exceptions.has(date) || (schedule.endDate && date > schedule.endDate)) return [];
    return [{ date, amountMinor: schedule.amountMinor, amountMaxMinor: schedule.amountMaxMinor ?? null }];
  }
  let cursor = firstDate(schedule);
  if (!cursor) return [];
  const step = stepDays(schedule);
  if (step && cursor < from) {
    const jumps = Math.floor(daysBetween(cursor, from) / step);
    if (jumps > 0) cursor = addDays(cursor, jumps * step);
  }
  const out: DatedAmount[] = [];
  for (let guard = 0; cursor && guard < 800 && out.length < limit; guard++) {
    if (cursor > until) break;
    if (cursor >= from && !exceptions.has(cursor)) {
      out.push({ date: cursor, amountMinor: schedule.amountMinor, amountMaxMinor: schedule.amountMaxMinor ?? null });
    }
    const next = nextScheduleDate(cursor, schedule);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return out;
}

/** Conservative is the planning amount. Optimistic is the high end. Expected is the midpoint when a range exists. */
export function scenarioAmount(planningMinor: number, highMinor: number | null | undefined, scenario: IncomeScenario): number {
  const high = highMinor == null ? planningMinor : highMinor;
  if (scenario === "conservative") return Math.min(planningMinor, high);
  if (scenario === "optimistic") return Math.max(planningMinor, high);
  return Math.round((planningMinor + high) / 2);
}

export function scenarioAssumption(scenario: IncomeScenario): string {
  if (scenario === "conservative") return "Conservative uses the planning amount, the low end when you entered a range. It does not spend the high end, and it is not cash on hand.";
  if (scenario === "optimistic") return "Optimistic uses the high end of the range when you entered one. That figure is still expected income, not cash on hand.";
  return "Expected uses the midpoint of the planning amount and the high end, rounded to the nearest minor unit. With no range, it is the planning amount. It is not cash on hand.";
}

export interface IncomeOccurrenceState {
  expectedDate: string;
  status: "expected" | "received" | "partial" | "delayed" | "cancelled";
  expectedAmountMinor: number;
  revisedDate?: string | null;
  revisedAmountMinor?: number | null;
  remainingMinor?: number | null;
  delayedUntil?: string | null;
  receivedAmountMinor?: number | null;
  receivedDate?: string | null;
  transactionId?: string | null;
}

export interface ShownIncome {
  key: string;
  expectedDate: string;
  date: string;
  amountMinor: number;
  status: "expected" | "overdue" | "received" | "partial" | "delayed" | "cancelled";
  countsAsExpected: boolean;
  inFutureForecast: boolean;
  receivedAmountMinor: number | null;
  transactionId: string | null;
}

function displayDate(state: IncomeOccurrenceState): string {
  if (state.status === "delayed" && state.delayedUntil) return state.delayedUntil;
  if (state.revisedDate) return state.revisedDate;
  if (state.status === "received" && state.receivedDate) return state.receivedDate;
  return state.expectedDate;
}

function shownFromState(sourceKey: string, state: IncomeOccurrenceState, planned: number, asOf: string, from: string, until: string): ShownIncome | null {
  const date = displayDate(state);
  if (date < from || date > until) return null;
  if (state.status === "received") {
    return { key: `${sourceKey}:${state.expectedDate}`, expectedDate: state.expectedDate, date, amountMinor: state.receivedAmountMinor ?? planned, status: "received", countsAsExpected: false, inFutureForecast: false, receivedAmountMinor: state.receivedAmountMinor ?? null, transactionId: state.transactionId ?? null };
  }
  if (state.status === "cancelled") {
    return { key: `${sourceKey}:${state.expectedDate}`, expectedDate: state.expectedDate, date, amountMinor: 0, status: "cancelled", countsAsExpected: false, inFutureForecast: false, receivedAmountMinor: state.receivedAmountMinor ?? null, transactionId: state.transactionId ?? null };
  }
  if (state.status === "partial") {
    const remaining = state.remainingMinor ?? 0;
    return {
      key: `${sourceKey}:${state.expectedDate}`,
      expectedDate: state.expectedDate,
      date,
      amountMinor: remaining,
      status: "partial",
      countsAsExpected: remaining > 0,
      inFutureForecast: remaining > 0 && date >= asOf,
      receivedAmountMinor: state.receivedAmountMinor ?? null,
      transactionId: state.transactionId ?? null,
    };
  }
  const amount = state.revisedAmountMinor ?? planned;
  const status = state.status === "delayed" ? "delayed" : date < asOf ? "overdue" : "expected";
  return {
    key: `${sourceKey}:${state.expectedDate}`,
    expectedDate: state.expectedDate,
    date,
    amountMinor: amount,
    status,
    countsAsExpected: true,
    inFutureForecast: date >= asOf,
    receivedAmountMinor: null,
    transactionId: null,
  };
}

export function showIncomeOccurrences(input: {
  sourceId: string;
  schedule: RepeatingSchedule;
  states: IncomeOccurrenceState[];
  from: string;
  until: string;
  scenario: IncomeScenario;
  asOf: string;
}): ShownIncome[] {
  const byDate = new Map(input.states.map((state) => [state.expectedDate, state]));
  const generated = expandSchedule(input.schedule, input.from, input.until);
  const seen = new Set<string>();
  const out: ShownIncome[] = [];
  for (const item of generated) {
    seen.add(item.date);
    const state = byDate.get(item.date);
    const planned = scenarioAmount(item.amountMinor, item.amountMaxMinor, input.scenario);
    if (!state) {
      if (item.date < input.from || item.date > input.until) continue;
      out.push({
        key: `${input.sourceId}:${item.date}`,
        expectedDate: item.date,
        date: item.date,
        amountMinor: planned,
        status: item.date < input.asOf ? "overdue" : "expected",
        countsAsExpected: true,
        inFutureForecast: item.date >= input.asOf,
        receivedAmountMinor: null,
        transactionId: null,
      });
      continue;
    }
    const row = shownFromState(input.sourceId, { ...state, expectedAmountMinor: state.expectedAmountMinor || planned }, state.revisedAmountMinor == null && state.status === "expected" ? planned : state.expectedAmountMinor || planned, input.asOf, input.from, input.until);
    if (row && state.status === "expected" && state.revisedAmountMinor == null) row.amountMinor = planned;
    if (row && state.status === "delayed" && state.revisedAmountMinor == null) row.amountMinor = planned;
    if (row) out.push(row);
  }
  for (const state of input.states) {
    if (seen.has(state.expectedDate)) continue;
    const row = shownFromState(input.sourceId, state, state.revisedAmountMinor ?? state.expectedAmountMinor, input.asOf, input.from, input.until);
    if (row) out.push(row);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.expectedDate < b.expectedDate ? -1 : 1));
}

/** Future dates for a saved bill or legacy schedule. An invalid custom interval returns only the stored next date, never a 30-day substitute. */
export function forecastDatesForSchedule(input: {
  cadence: string;
  nextDate: string;
  amountMinor: number;
  amountMaxMinor?: number;
  paused?: boolean;
  archived?: boolean;
  fulfilledThrough?: string;
  interval?: number;
  anchorDay?: number;
  twiceDayA?: number;
  twiceDayB?: number;
  endDate?: string;
  exceptionDates?: string[];
  scheduleMode?: "once" | "every_n_days" | "every_n_weeks" | "irregular";
}, from: string, until: string): DatedAmount[] {
  if (input.paused || input.archived) return [];
  if (!isIsoDate(input.nextDate) || !isIsoDate(from) || !isIsoDate(until)) return [];
  const single = (): DatedAmount[] => {
    if (input.nextDate < from || input.nextDate > until) return [];
    if (input.fulfilledThrough && input.nextDate <= input.fulfilledThrough) return [];
    if ((input.exceptionDates ?? []).includes(input.nextDate)) return [];
    return [{ date: input.nextDate, amountMinor: input.amountMinor, amountMaxMinor: input.amountMaxMinor ?? null }];
  };
  const cadence = input.scheduleMode ?? coerceCadence(input.cadence);
  if (!cadence || cadence === "irregular") return single();
  const schedule: RepeatingSchedule = {
    cadence,
    startDate: input.nextDate,
    endDate: input.endDate ?? null,
    customInterval: input.interval ?? null,
    anchorDay: input.anchorDay ?? null,
    twiceDays: input.twiceDayA && input.twiceDayB ? [input.twiceDayA, input.twiceDayB] : cadence === "twice_monthly" ? [1, 15] : null,
    amountMinor: input.amountMinor,
    amountMaxMinor: input.amountMaxMinor ?? null,
    exceptions: input.exceptionDates ?? [],
  };
  try {
    return expandSchedule(schedule, from, until).filter((item) => !input.fulfilledThrough || item.date > input.fulfilledThrough);
  } catch {
    return single();
  }
}
