/** Calendar helpers on ISO dates (YYYY-MM-DD). Lexicographic compare is chronological. */

export interface Period {
  key: string;
  start: string;
  end: string;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function assertDate(value: string, label = "date"): string {
  if (!isIsoDate(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  return value;
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthPeriod(year: number, month: number): Period {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const key = `${year}-${pad(month)}`;
  return { key, start: `${key}-01`, end: `${key}-${pad(last)}` };
}

export function periodFromDate(iso: string): Period {
  assertDate(iso);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return monthPeriod(year, month);
}

export function addMonths(iso: string, count: number): string {
  assertDate(iso);
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const target = new Date(Date.UTC(y, m - 1 + count, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(day)}`;
}

export function addDays(iso: string, days: number): string {
  assertDate(iso);
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  assertDate(start);
  assertDate(end);
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function compareDate(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function enumerateMonths(from: string, to: string): Period[] {
  const start = periodFromDate(from);
  const end = periodFromDate(to);
  const out: Period[] = [];
  let y = Number(start.key.slice(0, 4));
  let m = Number(start.key.slice(5, 7));
  const endKey = end.key;
  for (let guard = 0; guard < 600; guard++) {
    const p = monthPeriod(y, m);
    out.push(p);
    if (p.key >= endKey) break;
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export type Cadence =
  | "weekly"
  | "biweekly"
  | "twice_monthly"
  | "monthly"
  | "every_2_months"
  | "every_3_months"
  | "every_6_months"
  | "annual"
  | "custom";

export function nextDateForCadence(current: string, cadence: Cadence, customDays?: number): string {
  switch (cadence) {
    case "weekly":
      return addDays(current, 7);
    case "biweekly":
      return addDays(current, 14);
    case "twice_monthly": {
      const day = Number(current.slice(8, 10));
      if (day < 15) return `${current.slice(0, 8)}15`;
      const nextMonth = addMonths(`${current.slice(0, 8)}01`, 1);
      return nextMonth;
    }
    case "monthly":
      return addMonths(current, 1);
    case "every_2_months":
      return addMonths(current, 2);
    case "every_3_months":
      return addMonths(current, 3);
    case "every_6_months":
      return addMonths(current, 6);
    case "annual":
      return addMonths(current, 12);
    case "custom":
      return addDays(current, customDays && customDays > 0 ? customDays : 30);
    default:
      return addMonths(current, 1);
  }
}

export function occurrences(start: string, cadence: Cadence, until: string, limit = 400, customDays?: number): string[] {
  const out: string[] = [];
  let cursor = start;
  for (let i = 0; i < limit && cursor <= until; i++) {
    out.push(cursor);
    cursor = nextDateForCadence(cursor, cadence, customDays);
  }
  return out;
}

/** Local calendar date for an IANA time zone. */
export function localDate(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}
