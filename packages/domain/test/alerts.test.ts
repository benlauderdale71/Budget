import { describe, expect, it } from "vitest";
import {
  applyAlertPlan,
  channelCatalog,
  defaultAlertPreferences,
  digestDue,
  evaluateAlerts,
  isQuietHours,
  nextDigestUtc,
  parseAlertPreferences,
  planAlertChanges,
  type AlertFacts,
  type AlertPreferences,
  type TrackedAlert,
} from "../src/alerts.js";

const zone = "America/Chicago";

function prefs(patch: Partial<AlertPreferences> = {}): AlertPreferences {
  return { ...defaultAlertPreferences(zone), ...patch, thresholds: { ...defaultAlertPreferences(zone).thresholds, ...patch.thresholds }, channels: { ...defaultAlertPreferences(zone).channels, ...patch.channels } };
}

function facts(patch: Partial<AlertFacts> = {}): AlertFacts {
  return {
    asOf: "2026-11-11",
    cashMinor: 50000,
    overdraftDate: null,
    cardGaps: [],
    transactions: [],
    spending: [],
    buckets: [],
    schedules: [],
    pay: [],
    goals: [],
    debts: [],
    ...patch,
  };
}

function tracked(patch: Partial<TrackedAlert> & Pick<TrackedAlert, "dedupeKey" | "fingerprint" | "kind">): TrackedAlert {
  return {
    id: patch.id ?? "a1",
    title: "Alert",
    body: "Body",
    status: "unread",
    deliveryStatus: "queued",
    snoozedUntil: null,
    createdAt: "2026-11-11T15:00:00.000Z",
    escalatedAt: null,
    lastNotifiedAt: null,
    amountMinor: null,
    entityType: null,
    entityId: null,
    href: null,
    ...patch,
  };
}

describe("alert thresholds and unsupported types", () => {
  it("uses the threshold exactly and does not invent provider events", () => {
    const settings = prefs({ thresholds: { ...prefs().thresholds, largeTransactionMinor: 20000, lowBalanceMinor: 0 } });
    const below = evaluateAlerts(facts({
      cashMinor: 1,
      transactions: [{ id: "small", date: "2026-11-11", amountMinor: -19999, payee: "Cafe", accountName: "Joint", type: "expense" }],
    }), settings);
    expect(below.map((item) => item.kind)).not.toContain("large_transaction");
    expect(below.map((item) => item.kind)).not.toContain("low_balance");
    const hit = evaluateAlerts(facts({
      cashMinor: 0,
      transactions: [{ id: "big", date: "2026-11-11", amountMinor: -20000, payee: "Market", accountName: "Joint", type: "expense" }],
    }), settings);
    expect(hit.find((item) => item.kind === "large_transaction")?.dedupeKey).toBe("large_transaction:big");
    expect(hit.find((item) => item.kind === "low_balance")?.amountMinor).toBe(0);
    const kinds = hit.map((item) => item.kind as string);
    expect(kinds).not.toContain("price_increase");
    expect(kinds).not.toContain("credit_change");
    expect(kinds).not.toContain("broken_connection");
    const rejected = parseAlertPreferences({ ...settings, types: { ...settings.types, price_increase: true } });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toMatch(/price history/i);
  });

  it("needs two earlier months before calling spending unusual", () => {
    const settings = prefs();
    const thin = evaluateAlerts(facts({
      spending: [
        { bucketId: "groceries", name: "Groceries", period: "2026-10", spentMinor: 100, current: false },
        { bucketId: "groceries", name: "Groceries", period: "2026-11", spentMinor: 500, current: true },
      ],
    }), settings);
    expect(thin.some((item) => item.kind === "unusual_spending")).toBe(false);
    const enough = evaluateAlerts(facts({
      spending: [
        { bucketId: "groceries", name: "Groceries", period: "2026-09", spentMinor: 100, current: false },
        { bucketId: "groceries", name: "Groceries", period: "2026-10", spentMinor: 100, current: false },
        { bucketId: "groceries", name: "Groceries", period: "2026-11", spentMinor: 200, current: true },
      ],
    }), settings);
    expect(enough.find((item) => item.kind === "unusual_spending")?.amountMinor).toBe(200);
    const under = evaluateAlerts(facts({
      spending: [
        { bucketId: "groceries", name: "Groceries", period: "2026-09", spentMinor: 100, current: false },
        { bucketId: "groceries", name: "Groceries", period: "2026-10", spentMinor: 100, current: false },
        { bucketId: "groceries", name: "Groceries", period: "2026-11", spentMinor: 199, current: true },
      ],
    }), settings);
    expect(under.some((item) => item.kind === "unusual_spending")).toBe(false);
  });

  it("covers bills, trials, renewals, pay, goals, and debt only from supplied records", () => {
    const settings = prefs();
    const rows = evaluateAlerts(facts({
      schedules: [{
        id: "rent", name: "Rent", nextDate: "2026-11-13", amountMinor: 1000, type: "bill", direction: "outflow", paused: false,
        trialEnds: "2026-11-16", renewalDate: "2026-11-18", fulfilledThrough: null,
      }],
      pay: [
        { id: "soon", name: "Payday", expectedDate: "2026-11-11", amountMinor: 5000, status: "expected" },
        { id: "late", name: "Late pay", expectedDate: "2026-11-09", amountMinor: 5000, status: "expected" },
      ],
      goals: [
        { id: "open", name: "No date", availableMinor: 0, targetMinor: 100, targetDate: null },
        { id: "trip", name: "Trip", availableMinor: 10, targetMinor: 100, targetDate: "2026-11-20" },
      ],
      debts: [
        { id: "new", name: "New loan", balanceMinor: 0, hadActivity: false },
        { id: "old", name: "Old loan", balanceMinor: 0, hadActivity: true },
      ],
    }), settings);
    expect(rows.map((item) => item.kind).sort()).toEqual(["bill_due", "debt_milestone", "missing_pay", "renewal", "trial_ending", "underfunded_goal"]);
    expect(rows.find((item) => item.kind === "missing_pay")?.entityId).toBe("late");
    expect(rows.find((item) => item.kind === "underfunded_goal")?.entityId).toBe("trip");
    expect(rows.find((item) => item.kind === "debt_milestone")?.entityId).toBe("old");
  });
});

describe("quiet hours, time zones, and digests", () => {
  const quiet = prefs({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });

  it("treats a window that crosses midnight as quiet on both sides", () => {
    expect(isQuietHours(new Date("2026-11-12T05:30:00.000Z"), quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-11-12T12:30:00.000Z"), quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-11-12T13:00:00.000Z"), quiet)).toBe(false);
    const daytime = prefs({ quietHours: { enabled: true, start: "09:00", end: "17:00" } });
    expect(isQuietHours(new Date("2026-11-12T15:00:00.000Z"), daytime)).toBe(true);
    expect(isQuietHours(new Date("2026-11-12T22:59:00.000Z"), daytime)).toBe(true);
    expect(isQuietHours(new Date("2026-11-12T23:00:00.000Z"), daytime)).toBe(false);
    expect(isQuietHours(new Date("2026-11-12T04:30:00.000Z"), daytime)).toBe(false);
  });

  it("follows America/Chicago through the 2026 DST changes", () => {
    expect(isQuietHours(new Date("2026-03-08T07:30:00.000Z"), quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-03-08T08:30:00.000Z"), quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-03-08T12:00:00.000Z"), quiet)).toBe(false);
    expect(isQuietHours(new Date("2026-11-01T06:30:00.000Z"), quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-11-01T07:30:00.000Z"), quiet)).toBe(true);
    expect(isQuietHours(new Date("2026-11-01T13:00:00.000Z"), quiet)).toBe(false);
  });

  it("holds a digest until the next local slot and skips a missing DST hour", () => {
    const daily = prefs({ frequency: "digest", digest: { enabled: true, frequency: "daily", hour: 8, minute: 0, weekday: 1 } });
    const created = new Date("2026-11-11T13:00:00.000Z");
    expect(digestDue(created, new Date("2026-11-11T13:59:00.000Z"), daily)).toBe(false);
    expect(digestDue(created, new Date("2026-11-11T14:00:00.000Z"), daily)).toBe(true);
    const afterEight = new Date("2026-11-11T15:00:00.000Z");
    expect(nextDigestUtc(afterEight, daily)?.toISOString()).toBe("2026-11-12T14:00:00.000Z");
    const weekly = prefs({ frequency: "digest", digest: { enabled: true, frequency: "weekly", hour: 8, minute: 0, weekday: 1 } });
    expect(nextDigestUtc(created, weekly)?.toISOString()).toBe("2026-11-16T14:00:00.000Z");
    const gap = prefs({ frequency: "digest", digest: { enabled: true, frequency: "daily", hour: 2, minute: 30, weekday: 1 } });
    const spring = new Date("2026-03-08T07:00:00.000Z");
    const next = nextDigestUtc(spring, gap);
    expect(next?.toISOString()).toBe("2026-03-09T07:30:00.000Z");
  });
});

describe("dedupe, snooze, retries, and consent", () => {
  it("does not create or deliver a second copy of an unchanged condition", () => {
    const settings = prefs();
    const now = new Date("2026-11-11T15:00:00.000Z");
    const [candidate] = evaluateAlerts(facts({ cashMinor: 0, }), settings).filter((item) => item.kind === "low_balance");
    expect(candidate).toBeTruthy();
    const first = planAlertChanges({ now, preferences: settings, candidates: [candidate], existing: [] });
    expect(first.map((change) => change.op)).toEqual(["insert"]);
    let rows = applyAlertPlan([], first, () => "alert-1");
    const queued = planAlertChanges({ now, preferences: settings, candidates: [candidate], existing: rows });
    expect(queued).toEqual([expect.objectContaining({ op: "patch", id: "alert-1", patch: expect.objectContaining({ deliveryStatus: "delivered" }) })]);
    rows = applyAlertPlan(rows, queued, () => "unused");
    const again = planAlertChanges({ now, preferences: settings, candidates: [candidate], existing: rows });
    expect(again).toEqual([]);
    const restarted = planAlertChanges({ now: new Date("2026-11-11T16:00:00.000Z"), preferences: settings, candidates: [candidate], existing: rows });
    expect(restarted).toEqual([]);
  });

  it("delivers a queued alert once when a retry or restart continues", () => {
    const settings = prefs();
    const now = new Date("2026-11-11T15:00:00.000Z");
    const existing = [tracked({ kind: "low_balance", dedupeKey: "low_balance:cash", fingerprint: "at-or-below:0", deliveryStatus: "queued" })];
    const [candidate] = evaluateAlerts(facts({ cashMinor: 0 }), settings).filter((item) => item.kind === "low_balance");
    const first = planAlertChanges({ now, preferences: settings, candidates: [candidate], existing });
    expect(first).toHaveLength(1);
    const delivered = applyAlertPlan(existing, first, () => "nope");
    expect(delivered[0].deliveryStatus).toBe("delivered");
    expect(planAlertChanges({ now, preferences: settings, candidates: [candidate], existing: delivered })).toEqual([]);
  });

  it("keeps quiet-hour and digest alerts generated, then releases the same row", () => {
    const quiet = prefs({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    const night = new Date("2026-11-12T05:30:00.000Z");
    const [candidate] = evaluateAlerts(facts({ cashMinor: -1 }), quiet).filter((item) => item.kind === "low_balance");
    const held = planAlertChanges({ now: night, preferences: quiet, candidates: [candidate], existing: [] });
    expect(held[0]).toMatchObject({ op: "insert", alert: { deliveryStatus: "generated", dedupeKey: "low_balance:cash" } });
    const rows = applyAlertPlan([], held, () => "quiet-1");
    expect(planAlertChanges({ now: night, preferences: quiet, candidates: [candidate], existing: rows })).toEqual([]);
    const morning = new Date("2026-11-12T15:00:00.000Z");
    const released = applyAlertPlan(rows, planAlertChanges({ now: morning, preferences: quiet, candidates: [candidate], existing: rows }), () => "nope");
    const done = applyAlertPlan(released, planAlertChanges({ now: morning, preferences: quiet, candidates: [candidate], existing: released }), () => "nope");
    expect(done).toHaveLength(1);
    expect(done[0].deliveryStatus).toBe("delivered");

    const digest = prefs({ frequency: "digest", digest: { enabled: true, frequency: "daily", hour: 8, minute: 0, weekday: 1 } });
    const early = new Date("2026-11-11T13:00:00.000Z");
    const waiting = applyAlertPlan([], planAlertChanges({ now: early, preferences: digest, candidates: [candidate], existing: [] }), () => "digest-1");
    expect(waiting[0].deliveryStatus).toBe("generated");
    expect(planAlertChanges({ now: early, preferences: digest, candidates: [candidate], existing: waiting })).toEqual([]);
    const due = new Date("2026-11-11T14:00:00.000Z");
    const queued = applyAlertPlan(waiting, planAlertChanges({ now: due, preferences: digest, candidates: [candidate], existing: waiting }), () => "nope");
    const sent = applyAlertPlan(queued, planAlertChanges({ now: due, preferences: digest, candidates: [candidate], existing: queued }), () => "nope");
    expect(sent[0].id).toBe("digest-1");
    expect(sent[0].deliveryStatus).toBe("delivered");
  });

  it("snoozes without a second alert and wakes the same one once", () => {
    const settings = prefs();
    const candidate = evaluateAlerts(facts({ cashMinor: 0 }), settings).find((item) => item.kind === "low_balance")!;
    const snoozed = tracked({
      kind: "low_balance",
      dedupeKey: candidate.dedupeKey,
      fingerprint: candidate.fingerprint,
      title: candidate.title,
      body: candidate.body,
      amountMinor: candidate.amountMinor,
      href: candidate.href,
      status: "snoozed",
      deliveryStatus: "delivered",
      snoozedUntil: "2026-11-12T15:00:00.000Z",
      lastNotifiedAt: "2026-11-11T15:00:00.000Z",
    });
    const during = new Date("2026-11-11T18:00:00.000Z");
    expect(planAlertChanges({ now: during, preferences: settings, candidates: [candidate], existing: [snoozed] })).toEqual([]);
    const after = new Date("2026-11-12T15:00:00.000Z");
    const woken = applyAlertPlan([snoozed], planAlertChanges({ now: after, preferences: settings, candidates: [candidate], existing: [snoozed] }), () => "extra");
    expect(woken).toHaveLength(1);
    expect(woken[0].status).toBe("unread");
    expect(woken[0].deliveryStatus).toBe("queued");
    const reminded = applyAlertPlan(woken, planAlertChanges({ now: after, preferences: settings, candidates: [candidate], existing: woken }), () => "extra");
    expect(reminded[0].deliveryStatus).toBe("delivered");
    expect(reminded[0].lastNotifiedAt).toBe(after.toISOString());
    expect(planAlertChanges({ now: after, preferences: settings, candidates: [candidate], existing: reminded })).toEqual([]);
  });

  it("resolves a cleared condition and does not reopen the same fingerprint", () => {
    const settings = prefs();
    const now = new Date("2026-11-11T15:00:00.000Z");
    const open = tracked({ kind: "low_balance", dedupeKey: "low_balance:cash", fingerprint: "at-or-below:0", deliveryStatus: "delivered" });
    const cleared = planAlertChanges({ now, preferences: settings, candidates: [], existing: [open] });
    expect(cleared).toEqual([{ op: "resolve", id: "a1", reason: "condition-cleared" }]);
    const resolved = applyAlertPlan([open], cleared, () => "nope");
    resolved[0].status = "resolved";
    const back = evaluateAlerts(facts({ cashMinor: 0 }), settings).find((item) => item.kind === "low_balance")!;
    expect(planAlertChanges({ now, preferences: settings, candidates: [back], existing: resolved })).toEqual([]);
    const changed = { ...back, fingerprint: "at-or-below:100" };
    const reopened = planAlertChanges({ now, preferences: settings, candidates: [changed], existing: resolved });
    expect(reopened.map((change) => change.op)).toEqual(["insert"]);
  });

  it("escalates an unread in-app alert once and rejects unavailable channel delivery", () => {
    const settings = prefs({ escalation: { enabled: true, afterHours: 48 } });
    const candidate = evaluateAlerts(facts({ cashMinor: 0 }), settings).find((item) => item.kind === "low_balance")!;
    const open = tracked({
      kind: "low_balance",
      dedupeKey: candidate.dedupeKey,
      fingerprint: candidate.fingerprint,
      title: candidate.title,
      body: candidate.body,
      amountMinor: candidate.amountMinor,
      href: candidate.href,
      deliveryStatus: "delivered",
      createdAt: "2026-11-09T15:00:00.000Z",
    });
    const tooSoon = planAlertChanges({ now: new Date("2026-11-11T14:00:00.000Z"), preferences: settings, candidates: [candidate], existing: [open] });
    expect(tooSoon).toEqual([]);
    const due = new Date("2026-11-11T15:00:00.000Z");
    const once = planAlertChanges({ now: due, preferences: settings, candidates: [candidate], existing: [open] });
    expect(once[0]).toMatchObject({ op: "patch", patch: { escalatedAt: due.toISOString() } });
    const marked = applyAlertPlan([open], once, () => "nope");
    expect(planAlertChanges({ now: due, preferences: settings, candidates: [candidate], existing: marked })).toEqual([]);
    const pushed = parseAlertPreferences({ ...settings, channels: { ...settings.channels, push: { enabled: true, consent: true } } });
    expect(pushed.ok).toBe(false);
    const consented = parseAlertPreferences({ ...settings, channels: { ...settings.channels, email: { consent: true }, sms: { consent: true } } });
    expect(consented.ok).toBe(true);
    if (consented.ok) {
      const catalog = channelCatalog(consented.value);
      expect(catalog.find((item) => item.id === "inapp")).toMatchObject({ available: true, enabled: true });
      expect(catalog.find((item) => item.id === "email")).toMatchObject({ available: false, enabled: false, consent: true });
      expect(catalog.find((item) => item.id === "sms")?.available).toBe(false);
      expect(catalog.find((item) => item.id === "push")?.available).toBe(false);
    }
  });
});
