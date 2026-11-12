import { addDays, assertDate, daysBetween } from "./dates.js";

/** Alert kinds BudgetCents can evaluate from ledger records. */
export const ALERT_KINDS = [
  "bill_due",
  "trial_ending",
  "renewal",
  "low_balance",
  "likely_overdraft",
  "large_transaction",
  "unusual_spending",
  "overspending",
  "missing_pay",
  "underfunded_goal",
  "debt_milestone",
  "card_gap",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  bill_due: "Bills due",
  trial_ending: "Trials ending",
  renewal: "Renewals",
  low_balance: "Low balance",
  likely_overdraft: "Likely overdraft",
  large_transaction: "Large transactions",
  unusual_spending: "Unusual spending",
  overspending: "Overspending",
  missing_pay: "Missing expected pay",
  underfunded_goal: "Underfunded goals",
  debt_milestone: "Debt milestones",
  card_gap: "Card reserve short",
};

/** These stay off until a real provider exists. Evaluation never invents them. */
export const UNSUPPORTED_ALERTS = [
  {
    kind: "price_increase",
    reason: "No price history or bill-data provider is connected. A bill amount range is not a detected price increase.",
  },
  {
    kind: "credit_change",
    reason: "No credit-bureau connection is configured. A score entered by hand is not a bureau change.",
  },
  {
    kind: "broken_connection",
    reason: "Bank aggregation is not connected, so there is no bank connection that can break.",
  },
] as const;

export const ALERT_CHANNELS = ["inapp", "push", "email", "sms"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const CHANNEL_AVAILABILITY: Record<AlertChannel, { available: boolean; reason: string }> = {
  inapp: { available: true, reason: "Shown in BudgetCents on the web and in the Android app." },
  push: {
    available: false,
    reason: "No remote push provider is configured. A notification the Android app posts locally is not remote push.",
  },
  email: {
    available: false,
    reason: "Email delivery is not connected. A development outbox is not email delivery.",
  },
  sms: { available: false, reason: "No SMS provider is configured." },
};

export type AlertStatus = "unread" | "read" | "snoozed" | "resolved";
export type DeliveryStatus = "generated" | "queued" | "attempted" | "delivered";

export interface QuietHours {
  enabled: boolean;
  /** Local HH:mm. The end minute is exclusive. A window may cross midnight. */
  start: string;
  end: string;
}

export interface DigestSchedule {
  enabled: boolean;
  frequency: "daily" | "weekly";
  hour: number;
  minute: number;
  /** 0 is Sunday. Used when frequency is weekly. */
  weekday: number;
}

export interface AlertThresholds {
  /** Alert when visible on-budget cash is at or below this many minor units. */
  lowBalanceMinor: number;
  largeTransactionMinor: number;
  /** 20000 means twice the prior average. */
  unusualSpendingRatioBps: number;
  billLeadDays: number;
  trialLeadDays: number;
  renewalLeadDays: number;
  missingPayGraceDays: number;
  goalHorizonDays: number;
  /** Alert when the amount owed is at or below this. Zero means paid off. */
  debtMilestoneMinor: number;
}

export interface AlertPreferences {
  timezone: string;
  types: Record<AlertKind, boolean>;
  thresholds: AlertThresholds;
  frequency: "immediate" | "digest";
  quietHours: QuietHours;
  digest: DigestSchedule;
  snoozeHours: number;
  escalation: { enabled: boolean; afterHours: number };
  channels: {
    inapp: { enabled: boolean };
    push: { consent: boolean };
    email: { consent: boolean };
    sms: { consent: boolean };
  };
}

export interface AlertCandidate {
  kind: AlertKind | "price_increase" | "credit_change" | "broken_connection";
  dedupeKey: string;
  fingerprint: string;
  title: string;
  body: string;
  amountMinor: number | null;
  entityType: "transaction" | "schedule" | "goal" | "account" | "bucket" | "income" | null;
  entityId: string | null;
  href: string | null;
}

export interface AlertFacts {
  asOf: string;
  cashMinor: number;
  overdraftDate: string | null;
  cardGaps: { accountId: string; name: string; gapMinor: number }[];
  transactions: { id: string; date: string; amountMinor: number; payee: string; accountName: string; type: string }[];
  spending: { bucketId: string; name: string; period: string; spentMinor: number; current: boolean }[];
  buckets: { id: string; name: string; availableMinor: number; period: string }[];
  schedules: {
    id: string;
    name: string;
    nextDate: string;
    amountMinor: number;
    type: string;
    direction: string;
    paused: boolean;
    trialEnds: string | null;
    renewalDate: string | null;
    fulfilledThrough: string | null;
  }[];
  pay: { id: string; name: string; expectedDate: string; amountMinor: number; status: string }[];
  goals: { id: string; name: string; availableMinor: number; targetMinor: number; targetDate: string | null }[];
  debts: { id: string; name: string; balanceMinor: number; hadActivity: boolean }[];
  /** Present only when a provider stored the event. Absence means no price, credit, or connection alert. */
  sourceEvents?: { id: string; kind: "price_increase" | "credit_change" | "broken_connection"; title: string; body: string; occurredOn: string }[];
}

export interface TrackedAlert {
  id: string;
  kind: string;
  dedupeKey: string;
  fingerprint: string;
  title: string;
  body: string;
  status: AlertStatus;
  deliveryStatus: DeliveryStatus;
  snoozedUntil: string | null;
  createdAt: string;
  escalatedAt: string | null;
  lastNotifiedAt: string | null;
  amountMinor: number | null;
  entityType: string | null;
  entityId: string | null;
  href: string | null;
}

export type AlertChange =
  | { op: "insert"; alert: Omit<TrackedAlert, "id">; reason: string }
  | { op: "patch"; id: string; patch: Partial<TrackedAlert>; reason: string }
  | { op: "resolve"; id: string; reason: string };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const OPEN_PAY = new Set(["expected", "overdue", "partial"]);
const LARGE_TYPES = new Set(["expense", "fee", "interest"]);

export function isAlertKind(value: string): value is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(value);
}

export function defaultAlertPreferences(timezone = "UTC"): AlertPreferences {
  const types = Object.fromEntries(ALERT_KINDS.map((kind) => [kind, true])) as Record<AlertKind, boolean>;
  return {
    timezone,
    types,
    thresholds: {
      lowBalanceMinor: 0,
      largeTransactionMinor: 20000,
      unusualSpendingRatioBps: 20000,
      billLeadDays: 3,
      trialLeadDays: 7,
      renewalLeadDays: 7,
      missingPayGraceDays: 1,
      goalHorizonDays: 30,
      debtMilestoneMinor: 0,
    },
    frequency: "immediate",
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
    digest: { enabled: false, frequency: "daily", hour: 8, minute: 0, weekday: 1 },
    snoozeHours: 24,
    escalation: { enabled: false, afterHours: 48 },
    channels: { inapp: { enabled: true }, push: { consent: false }, email: { consent: false }, sms: { consent: false } },
  };
}

export function parseAlertPreferences(input: unknown, fallbackTimezone = "UTC"): { ok: true; value: AlertPreferences } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Alert settings must be an object." };
  const raw = input as Record<string, unknown>;
  const base = defaultAlertPreferences(fallbackTimezone);
  try {
    const timezone = readString(raw.timezone ?? base.timezone, "Time zone");
    assertTimezone(timezone);
    const types = readTypes(raw.types ?? base.types);
    const thresholds = readThresholds(raw.thresholds ?? base.thresholds);
    const frequency = readEnum(raw.frequency ?? base.frequency, ["immediate", "digest"] as const, "Frequency");
    const quietHours = readQuiet(raw.quietHours ?? base.quietHours);
    const digest = readDigest(raw.digest ?? base.digest);
    if (frequency === "digest" && !digest.enabled) return { ok: false, error: "Turn on a digest schedule, or choose immediate alerts." };
    const snoozeHours = readInt(raw.snoozeHours ?? base.snoozeHours, "Snooze hours", 1, 168);
    const escalation = readEscalation(raw.escalation ?? base.escalation);
    const channels = readChannels(raw.channels ?? base.channels);
    return { ok: true, value: { timezone, types, thresholds, frequency, quietHours, digest, snoozeHours, escalation, channels } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Alert settings are not valid." };
  }
}

export function channelCatalog(preferences: AlertPreferences) {
  return ALERT_CHANNELS.map((id) => {
    const availability = CHANNEL_AVAILABILITY[id];
    const consent = id === "inapp" ? preferences.channels.inapp.enabled : preferences.channels[id].consent;
    const enabled = id === "inapp" ? preferences.channels.inapp.enabled && availability.available : false;
    return { id, ...availability, consent, enabled };
  });
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  isoDate: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(now: Date, timeZone: string): ZonedParts {
  assertTimezone(timeZone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const weekday = WEEKDAYS[parts.weekday] ?? 0;
  return {
    year,
    month,
    day,
    hour,
    minute: Number(parts.minute),
    weekday,
    isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Convert a civil local time to UTC. A clock time that does not exist returns the next valid instant the iteration reaches. */
export function zonedTimeToUtc(isoDate: string, hour: number, minute: number, timeZone: string): Date {
  assertDate(isoDate);
  const [year, month, day] = isoDate.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(utc), timeZone);
    const got = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = wanted - got;
    if (delta === 0) return new Date(utc);
    utc += delta;
  }
  return new Date(utc);
}

export function isQuietHours(now: Date, preferences: AlertPreferences): boolean {
  if (!preferences.quietHours.enabled) return false;
  const current = localMinutes(now, preferences.timezone);
  const start = clockMinutes(preferences.quietHours.start);
  const end = clockMinutes(preferences.quietHours.end);
  if (start === end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function nextDigestUtc(after: Date, preferences: AlertPreferences): Date | null {
  if (preferences.frequency !== "digest" || !preferences.digest.enabled) return null;
  const start = zonedParts(after, preferences.timezone);
  for (let add = 0; add < 14; add++) {
    const date = addDays(start.isoDate, add);
    const utc = zonedTimeToUtc(date, preferences.digest.hour, preferences.digest.minute, preferences.timezone);
    const local = zonedParts(utc, preferences.timezone);
    if (local.isoDate !== date || local.hour !== preferences.digest.hour || local.minute !== preferences.digest.minute) continue;
    if (preferences.digest.frequency === "weekly" && local.weekday !== preferences.digest.weekday) continue;
    if (utc.getTime() > after.getTime()) return utc;
  }
  return null;
}

export function digestDue(createdAt: Date, now: Date, preferences: AlertPreferences): boolean {
  const next = nextDigestUtc(createdAt, preferences);
  return next != null && now.getTime() >= next.getTime();
}

export function evaluateAlerts(facts: AlertFacts, preferences: AlertPreferences): AlertCandidate[] {
  assertDate(facts.asOf);
  const out: AlertCandidate[] = [];
  const enabled = (kind: AlertKind) => preferences.types[kind] && preferences.channels.inapp.enabled;
  const lead = preferences.thresholds;

  if (enabled("low_balance") && facts.cashMinor <= lead.lowBalanceMinor) {
    out.push(candidate({
      kind: "low_balance",
      dedupeKey: "low_balance:cash",
      fingerprint: `at-or-below:${lead.lowBalanceMinor}`,
      title: "Low balance",
      body: "On-budget cash you can see is at or below the threshold you set.",
      amountMinor: facts.cashMinor,
      entityType: null,
      entityId: null,
      href: "/accounts",
    }));
  }

  if (enabled("likely_overdraft") && facts.overdraftDate) {
    assertDate(facts.overdraftDate);
    out.push(candidate({
      kind: "likely_overdraft",
      dedupeKey: "likely_overdraft",
      fingerprint: facts.overdraftDate,
      title: "Likely overdraft",
      body: `Projected cash goes negative on ${facts.overdraftDate}. Expected pay is not included in that projection.`,
      amountMinor: null,
      entityType: null,
      entityId: null,
      href: "/forecast",
    }));
  }

  if (enabled("card_gap")) {
    for (const gap of facts.cardGaps) {
      if (gap.gapMinor <= 0) continue;
      out.push(candidate({
        kind: "card_gap",
        dedupeKey: `card_gap:${gap.accountId}`,
        fingerprint: "short",
        title: "Card reserve is short",
        body: `${gap.name} is higher than the cash reserved to pay it.`,
        amountMinor: gap.gapMinor,
        entityType: "account",
        entityId: gap.accountId,
        href: accountHref(gap.accountId),
      }));
    }
  }

  if (enabled("large_transaction")) {
    const from = addDays(facts.asOf, -14);
    for (const txn of facts.transactions) {
      if (!LARGE_TYPES.has(txn.type) || txn.date < from || txn.date > facts.asOf) continue;
      const size = Math.abs(txn.amountMinor);
      if (size < lead.largeTransactionMinor) continue;
      out.push(candidate({
        kind: "large_transaction",
        dedupeKey: `large_transaction:${txn.id}`,
        fingerprint: `${txn.date}:${size}`,
        title: "Large transaction",
        body: `${txn.payee} on ${txn.accountName}.`,
        amountMinor: txn.amountMinor,
        entityType: "transaction",
        entityId: txn.id,
        href: transactionHref(txn.id),
      }));
    }
  }

  if (enabled("unusual_spending")) {
    const byBucket = new Map<string, { name: string; current: number; prior: number[] }>();
    for (const row of facts.spending) {
      const entry = byBucket.get(row.bucketId) ?? { name: row.name, current: 0, prior: [] };
      if (row.current) entry.current += row.spentMinor;
      else entry.prior.push(row.spentMinor);
      entry.name = row.name;
      byBucket.set(row.bucketId, entry);
    }
    for (const [bucketId, row] of byBucket) {
      if (row.prior.length < 2 || row.current <= 0) continue;
      const average = Math.floor(row.prior.reduce((sum, value) => sum + value, 0) / row.prior.length);
      if (average <= 0) continue;
      if (row.current * 10000 < average * lead.unusualSpendingRatioBps) continue;
      const period = facts.spending.find((item) => item.bucketId === bucketId && item.current)?.period ?? facts.asOf.slice(0, 7);
      out.push(candidate({
        kind: "unusual_spending",
        dedupeKey: `unusual_spending:${bucketId}:${period}`,
        fingerprint: `${row.current}:${average}:${lead.unusualSpendingRatioBps}`,
        title: "Unusual spending",
        body: `${row.name} is above its earlier monthly average. The comparison uses posted category totals only.`,
        amountMinor: row.current,
        entityType: "bucket",
        entityId: bucketId,
        href: "/plan",
      }));
    }
  }

  if (enabled("overspending")) {
    for (const bucket of facts.buckets) {
      if (bucket.availableMinor >= 0) continue;
      out.push(candidate({
        kind: "overspending",
        dedupeKey: `overspending:${bucket.id}:${bucket.period}`,
        fingerprint: "negative",
        title: "Overspending",
        body: `${bucket.name} is below zero for ${bucket.period}.`,
        amountMinor: bucket.availableMinor,
        entityType: "bucket",
        entityId: bucket.id,
        href: "/plan",
      }));
    }
  }

  for (const schedule of facts.schedules) {
    if (schedule.paused) continue;
    const upcoming = !schedule.fulfilledThrough || schedule.fulfilledThrough < schedule.nextDate;
    if (enabled("bill_due") && upcoming && (schedule.type === "bill" || schedule.type === "subscription") && schedule.direction === "outflow") {
      const until = daysBetween(facts.asOf, schedule.nextDate);
      if (until <= lead.billLeadDays && until >= -30) {
        out.push(candidate({
          kind: "bill_due",
          dedupeKey: `bill_due:${schedule.id}:${schedule.nextDate}`,
          fingerprint: `${schedule.nextDate}:${schedule.amountMinor}`,
          title: until < 0 ? "Bill overdue" : "Bill due",
          body: `${schedule.name} is scheduled for ${schedule.nextDate}.`,
          amountMinor: -Math.abs(schedule.amountMinor),
          entityType: "schedule",
          entityId: schedule.id,
          href: scheduleHref(schedule.id),
        }));
      }
    }
    if (enabled("trial_ending") && schedule.trialEnds && withinLead(facts.asOf, schedule.trialEnds, lead.trialLeadDays)) {
      out.push(candidate({
        kind: "trial_ending",
        dedupeKey: `trial_ending:${schedule.id}:${schedule.trialEnds}`,
        fingerprint: schedule.trialEnds,
        title: "Trial ending",
        body: `${schedule.name} trial ends on ${schedule.trialEnds}.`,
        amountMinor: schedule.amountMinor,
        entityType: "schedule",
        entityId: schedule.id,
        href: scheduleHref(schedule.id),
      }));
    }
    if (enabled("renewal") && schedule.renewalDate && withinLead(facts.asOf, schedule.renewalDate, lead.renewalLeadDays)) {
      out.push(candidate({
        kind: "renewal",
        dedupeKey: `renewal:${schedule.id}:${schedule.renewalDate}`,
        fingerprint: `${schedule.renewalDate}:${schedule.amountMinor}`,
        title: "Renewal",
        body: `${schedule.name} renews on ${schedule.renewalDate}.`,
        amountMinor: schedule.amountMinor,
        entityType: "schedule",
        entityId: schedule.id,
        href: scheduleHref(schedule.id),
      }));
    }
  }

  if (enabled("missing_pay")) {
    for (const pay of facts.pay) {
      if (!OPEN_PAY.has(pay.status)) continue;
      const due = addDays(pay.expectedDate, lead.missingPayGraceDays);
      if (due >= facts.asOf) continue;
      out.push(candidate({
        kind: "missing_pay",
        dedupeKey: `missing_pay:${pay.id}`,
        fingerprint: `${pay.expectedDate}:${pay.amountMinor}:${pay.status}`,
        title: "Missing expected pay",
        body: `${pay.name} was expected on ${pay.expectedDate} and is still open.`,
        amountMinor: pay.amountMinor,
        entityType: "income",
        entityId: pay.id,
        href: "/paychecks",
      }));
    }
  }

  if (enabled("underfunded_goal")) {
    for (const goal of facts.goals) {
      if (!goal.targetDate || goal.availableMinor >= goal.targetMinor) continue;
      const distance = daysBetween(facts.asOf, goal.targetDate);
      if (distance > lead.goalHorizonDays) continue;
      out.push(candidate({
        kind: "underfunded_goal",
        dedupeKey: `underfunded_goal:${goal.id}:${goal.targetDate}`,
        fingerprint: `${goal.availableMinor}:${goal.targetMinor}`,
        title: "Underfunded goal",
        body: `${goal.name} is short of its target on ${goal.targetDate}.`,
        amountMinor: goal.availableMinor - goal.targetMinor,
        entityType: "goal",
        entityId: goal.id,
        href: goalHref(goal.id),
      }));
    }
  }

  if (enabled("debt_milestone")) {
    for (const debt of facts.debts) {
      if (!debt.hadActivity || debt.balanceMinor > lead.debtMilestoneMinor) continue;
      out.push(candidate({
        kind: "debt_milestone",
        dedupeKey: `debt_milestone:${debt.id}:${lead.debtMilestoneMinor}`,
        fingerprint: `at-or-below:${lead.debtMilestoneMinor}`,
        title: debt.balanceMinor === 0 ? "Debt paid off" : "Debt milestone",
        body: debt.balanceMinor === 0 ? `${debt.name} is paid off.` : `${debt.name} is at or below the milestone you set.`,
        amountMinor: debt.balanceMinor,
        entityType: "account",
        entityId: debt.id,
        href: accountHref(debt.id),
      }));
    }
  }

  if (preferences.channels.inapp.enabled) {
    for (const event of facts.sourceEvents ?? []) {
      if (!event.id || !event.occurredOn || !event.title) continue;
      out.push(candidate({
        kind: event.kind,
        dedupeKey: `${event.kind}:${event.id}`,
        fingerprint: event.occurredOn,
        title: event.title,
        body: event.body,
        amountMinor: null,
        entityType: null,
        entityId: null,
        href: event.kind === "broken_connection" ? "/connections" : "/alerts",
      }));
    }
  }

  return out.sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));
}

/**
 * One step of delivery. Call again after applying the result.
 * The same open condition never inserts a second row. A retry from queued delivers once.
 */
export function planAlertChanges(input: { now: Date; preferences: AlertPreferences; candidates: AlertCandidate[]; existing: TrackedAlert[] }): AlertChange[] {
  const changes: AlertChange[] = [];
  const byKey = new Map<string, TrackedAlert[]>();
  for (const alert of input.existing) {
    const list = byKey.get(alert.dedupeKey) ?? [];
    list.push(alert);
    byKey.set(alert.dedupeKey, list);
  }
  const wanted = new Set(input.candidates.map((candidate) => candidate.dedupeKey));
  for (const candidate of input.candidates) {
    const history = (byKey.get(candidate.dedupeKey) ?? []).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const open = history.find((alert) => alert.status !== "resolved");
    const latest = history[0];
    if (open) {
      const patch: Partial<TrackedAlert> = {};
      if (open.fingerprint !== candidate.fingerprint) patch.fingerprint = candidate.fingerprint;
      if (open.title !== candidate.title) patch.title = candidate.title;
      if (open.body !== candidate.body) patch.body = candidate.body;
      if (open.amountMinor !== candidate.amountMinor) patch.amountMinor = candidate.amountMinor;
      if (open.href !== candidate.href) patch.href = candidate.href;
      const hold = shouldHold(input.now, new Date(open.createdAt), input.preferences);
      if (open.status === "snoozed" && open.snoozedUntil && Date.parse(open.snoozedUntil) > input.now.getTime()) {
        if (Object.keys(patch).length) changes.push({ op: "patch", id: open.id, patch, reason: "condition-updated-while-snoozed" });
        continue;
      }
      if (open.status === "snoozed") {
        patch.status = "unread";
        patch.snoozedUntil = null;
        patch.deliveryStatus = hold ? "generated" : "queued";
        changes.push({ op: "patch", id: open.id, patch, reason: "snooze-ended" });
        continue;
      }
      if (open.deliveryStatus === "generated" && !hold) patch.deliveryStatus = "queued";
      else if (open.deliveryStatus === "queued" && !hold) {
        patch.deliveryStatus = "delivered";
        if (open.status === "unread") patch.lastNotifiedAt = input.now.toISOString();
      } else if (open.deliveryStatus === "delivered" && escalationDue(input.now, open, input.preferences)) {
        patch.escalatedAt = input.now.toISOString();
      }
      if (Object.keys(patch).length) changes.push({ op: "patch", id: open.id, patch, reason: patch.deliveryStatus === "delivered" ? "in-app-delivered" : patch.escalatedAt ? "escalated" : "advance" });
      continue;
    }
    if (latest && latest.fingerprint === candidate.fingerprint) continue;
    const createdAt = input.now.toISOString();
    const hold = shouldHold(input.now, input.now, input.preferences);
    changes.push({
      op: "insert",
      reason: "condition-opened",
      alert: {
        kind: candidate.kind,
        dedupeKey: candidate.dedupeKey,
        fingerprint: candidate.fingerprint,
        title: candidate.title,
        body: candidate.body,
        status: "unread",
        deliveryStatus: hold ? "generated" : "queued",
        snoozedUntil: null,
        createdAt,
        escalatedAt: null,
        lastNotifiedAt: null,
        amountMinor: candidate.amountMinor,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        href: candidate.href,
      },
    });
  }
  for (const alert of input.existing) {
    if (alert.status === "resolved" || !isAlertKind(alert.kind)) continue;
    if (!wanted.has(alert.dedupeKey)) changes.push({ op: "resolve", id: alert.id, reason: "condition-cleared" });
  }
  return changes;
}

export function applyAlertPlan(existing: TrackedAlert[], changes: AlertChange[], ids: () => string): TrackedAlert[] {
  const next = existing.map((alert) => ({ ...alert }));
  for (const change of changes) {
    if (change.op === "insert") {
      next.push({ ...change.alert, id: ids() });
      continue;
    }
    const index = next.findIndex((alert) => alert.id === change.id);
    if (index < 0) continue;
    if (change.op === "resolve") {
      next[index] = { ...next[index], status: "resolved" };
      continue;
    }
    next[index] = { ...next[index], ...change.patch };
  }
  return next;
}

export function shouldHold(now: Date, createdAt: Date, preferences: AlertPreferences): boolean {
  if (!preferences.channels.inapp.enabled) return true;
  if (isQuietHours(now, preferences)) return true;
  if (preferences.frequency === "digest") return !digestDue(createdAt, now, preferences);
  return false;
}

function escalationDue(now: Date, alert: TrackedAlert, preferences: AlertPreferences): boolean {
  if (!preferences.escalation.enabled || alert.status !== "unread" || alert.deliveryStatus !== "delivered" || alert.escalatedAt) return false;
  if (isQuietHours(now, preferences)) return false;
  const age = now.getTime() - Date.parse(alert.createdAt);
  return age >= preferences.escalation.afterHours * 3_600_000;
}

function withinLead(asOf: string, date: string, leadDays: number): boolean {
  const distance = daysBetween(asOf, date);
  return distance >= 0 && distance <= leadDays;
}

function candidate(value: AlertCandidate): AlertCandidate {
  return value;
}

function transactionHref(id: string): string {
  return `/activity?ids=${encodeURIComponent(id)}`;
}

function scheduleHref(id: string): string {
  return `/bills?focus=${encodeURIComponent(id)}`;
}

function goalHref(id: string): string {
  return `/goals?focus=${encodeURIComponent(id)}`;
}

function accountHref(id: string): string {
  return `/accounts?focus=${encodeURIComponent(id)}`;
}

function localMinutes(now: Date, timeZone: string): number {
  const parts = zonedParts(now, timeZone);
  return parts.hour * 60 + parts.minute;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function assertTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error("Choose a valid time zone, such as America/Chicago.");
  }
}

function readTypes(value: unknown): Record<AlertKind, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose which alert types are on.");
  const raw = value as Record<string, unknown>;
  const types = {} as Record<AlertKind, boolean>;
  for (const kind of ALERT_KINDS) {
    if (raw[kind] == null) throw new Error(`Missing alert type ${ALERT_KIND_LABELS[kind]}.`);
    if (typeof raw[kind] !== "boolean") throw new Error(`${ALERT_KIND_LABELS[kind]} must be on or off.`);
    types[kind] = raw[kind] as boolean;
  }
  for (const key of Object.keys(raw)) {
    if (!isAlertKind(key)) {
      const unsupported = UNSUPPORTED_ALERTS.find((item) => item.kind === key);
      throw new Error(unsupported ? unsupported.reason : `Unknown alert type ${key}.`);
    }
  }
  return types;
}

function readThresholds(value: unknown): AlertThresholds {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Thresholds are missing.");
  const raw = value as Record<string, unknown>;
  const base = defaultAlertPreferences().thresholds;
  return {
    lowBalanceMinor: readInt(raw.lowBalanceMinor ?? base.lowBalanceMinor, "Low balance threshold", 0, 100_000_000_000_000),
    largeTransactionMinor: readInt(raw.largeTransactionMinor ?? base.largeTransactionMinor, "Large transaction threshold", 0, 100_000_000_000_000),
    unusualSpendingRatioBps: readInt(raw.unusualSpendingRatioBps ?? base.unusualSpendingRatioBps, "Unusual spending ratio", 10000, 1_000_000),
    billLeadDays: readInt(raw.billLeadDays ?? base.billLeadDays, "Bill lead days", 0, 90),
    trialLeadDays: readInt(raw.trialLeadDays ?? base.trialLeadDays, "Trial lead days", 0, 90),
    renewalLeadDays: readInt(raw.renewalLeadDays ?? base.renewalLeadDays, "Renewal lead days", 0, 90),
    missingPayGraceDays: readInt(raw.missingPayGraceDays ?? base.missingPayGraceDays, "Missing pay grace", 0, 30),
    goalHorizonDays: readInt(raw.goalHorizonDays ?? base.goalHorizonDays, "Goal horizon", 0, 3650),
    debtMilestoneMinor: readInt(raw.debtMilestoneMinor ?? base.debtMilestoneMinor, "Debt milestone", 0, 100_000_000_000_000),
  };
}

function readQuiet(value: unknown): QuietHours {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Quiet hours are missing.");
  const raw = value as Record<string, unknown>;
  const enabled = readBool(raw.enabled, "Quiet hours");
  const start = readString(raw.start, "Quiet hours start");
  const end = readString(raw.end, "Quiet hours end");
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new Error("Quiet hours use 24-hour HH:mm times.");
  if (enabled && start === end) throw new Error("Quiet hours need a start and end that are different.");
  return { enabled, start, end };
}

function readDigest(value: unknown): DigestSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Digest schedule is missing.");
  const raw = value as Record<string, unknown>;
  return {
    enabled: readBool(raw.enabled, "Digest"),
    frequency: readEnum(raw.frequency, ["daily", "weekly"] as const, "Digest frequency"),
    hour: readInt(raw.hour, "Digest hour", 0, 23),
    minute: readInt(raw.minute, "Digest minute", 0, 59),
    weekday: readInt(raw.weekday, "Digest weekday", 0, 6),
  };
}

function readEscalation(value: unknown): AlertPreferences["escalation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Escalation settings are missing.");
  const raw = value as Record<string, unknown>;
  return { enabled: readBool(raw.enabled, "Escalation"), afterHours: readInt(raw.afterHours, "Escalation hours", 1, 720) };
}

function readChannels(value: unknown): AlertPreferences["channels"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Channel settings are missing.");
  const raw = value as Record<string, unknown>;
  const inapp = raw.inapp as Record<string, unknown> | undefined;
  const push = raw.push as Record<string, unknown> | undefined;
  const email = raw.email as Record<string, unknown> | undefined;
  const sms = raw.sms as Record<string, unknown> | undefined;
  if (!inapp || !push || !email || !sms) throw new Error("Each channel needs its own setting.");
  if (push.enabled === true) throw new Error(CHANNEL_AVAILABILITY.push.reason);
  if (email.enabled === true) throw new Error(CHANNEL_AVAILABILITY.email.reason);
  if (sms.enabled === true) throw new Error(CHANNEL_AVAILABILITY.sms.reason);
  return {
    inapp: { enabled: readBool(inapp.enabled, "In-app alerts") },
    push: { consent: readBool(push.consent, "Push consent") },
    email: { consent: readBool(email.consent, "Email consent") },
    sms: { consent: readBool(sms.consent, "Text consent") },
  };
}

function readBool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be on or off.`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80) throw new Error(`${label} is not valid.`);
  return value.trim();
}

function readInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is not valid.`);
  return value as T;
}
