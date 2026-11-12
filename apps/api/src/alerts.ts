import {
  addMonths,
  ALERT_KIND_LABELS,
  channelCatalog,
  defaultAlertPreferences,
  displayBalance,
  evaluateAlerts,
  isLiability,
  isOnBudgetCash,
  isQuietHours,
  parseAlertPreferences,
  periodFromDate,
  planAlertChanges,
  projectCash,
  spendingRows,
  type AlertChange,
  type AlertPreferences,
  type DeliveryStatus,
  type TrackedAlert,
} from "@budgetcents/domain";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, forecastEventsFromSchedules, loadSpace, lockHousehold, requireMember, type Actor, type Loaded } from "./finance.js";
import { smtpConfigured } from "./providers/smtp.js";
import { fcmConfigured } from "./providers/fcm.js";
import { sendOwnMessage } from "./providers/live-messages.js";

const REDACTED = "That record is no longer available to you.";

async function withRemoteStatus(db: Database, alert: PublicAlert, userId: string) {
  const rows = await db.query(`SELECT channel, status FROM remote_messages WHERE user_id = $1 AND alert_id = $2`, [userId, alert.id]);
  if (smtpConfigured()) alert.channels.email = "not_requested";
  if (fcmConfigured()) alert.channels.push = "not_requested";
  for (const row of rows) alert.channels[String(row.channel)] = String(row.status);
  return alert;
}

async function queueRemoteAlerts(db: Database, actor: Actor, loaded: Loaded, preferences: AlertPreferences, now: Date) {
  if ((!smtpConfigured() && !fcmConfigured()) || isQuietHours(now, preferences)) return;
  const access = await accessIndex(db, loaded);
  const alerts = await db.query(`SELECT * FROM alerts WHERE user_id = $1 AND household_id = $2 AND status = 'unread' AND delivery_status = 'delivered'`, [actor.id, loaded.member.householdId]);
  for (const channel of ["email", "push"] as const) {
    if (!preferences.channels[channel].consent || (channel === "email" ? !smtpConfigured() : !fcmConfigured())) continue;
    const enrollment = (await db.query(`SELECT consented_at, opted_out_at FROM message_enrollments WHERE user_id = $1 AND channel = $2`, [actor.id, channel]))[0];
    if (!enrollment?.consented_at || enrollment.opted_out_at) continue;
    for (const row of alerts) {
      if (!presentAlert(row, access).targetAvailable || String(row.created_at) < String(enrollment.consented_at)) continue;
      await db.query(`INSERT INTO remote_messages (id,user_id,op_id,channel,status,detail,created_at,household_id,alert_id) VALUES ($1,$2,$3,$4,'queued','Generic notification waiting for delivery',$5,$6,$7) ON CONFLICT (user_id,op_id) DO NOTHING`, [id(), actor.id, `alert:${row.id}:${channel}`, channel, now.toISOString(), loaded.member.householdId, row.id]);
    }
  }
}

/** Evaluate for current members, then recheck access and consent immediately before each send. */
export async function runRemoteAlerts(db: Database) {
  if (!smtpConfigured() && !fcmConfigured()) return;
  const rows = await db.query(`SELECT u.*, p.household_id, p.settings_json FROM alert_preferences p JOIN users u ON u.id = p.user_id JOIN memberships m ON m.user_id = p.user_id AND m.household_id = p.household_id WHERE u.deleted_at IS NULL`);
  for (const row of rows) {
    const prefs = parseAlertPreferences(JSON.parse(String(row.settings_json)), String(row.time_zone));
    if (!prefs.ok || (!prefs.value.channels.email.consent && !prefs.value.channels.push.consent)) continue;
    const actor: Actor = { id: String(row.id), email: String(row.email), displayName: String(row.display_name), privacyMode: num(row.privacy_mode) === 1, aiEnabled: num(row.ai_enabled) === 1, locale: String(row.locale), timeZone: String(row.time_zone), theme: String(row.theme), weekStart: num(row.week_start) };
    try {
      const loaded = await loadSpace(db, actor, String(row.household_id));
      await syncAlerts(db, actor, loaded);
    } catch { /* A removed member or unavailable household must not abort other recipients. */ }
  }
  const pending = await db.query(`SELECT id, household_id FROM remote_messages WHERE status = 'queued' AND alert_id IS NOT NULL ORDER BY created_at LIMIT 30`);
  for (const item of pending) {
    const claimed = await db.tx(async () => {
      await lockHousehold(db, String(item.household_id));
      const message = (await db.query(`SELECT * FROM remote_messages WHERE id = $1 AND status = 'queued' FOR UPDATE`, [item.id]))[0];
      if (!message) return null;
      const channel = String(message.channel) as "email" | "push";
      if (channel === "email" ? !smtpConfigured() : !fcmConfigured()) return null;
      try {
        const member = await requireMember(db, String(message.user_id), String(message.household_id));
        const settings = await ensurePreferences(db, String(message.user_id), member.householdId, member.timeZone);
        const consent = (await db.query(`SELECT consented_at, opted_out_at FROM message_enrollments WHERE user_id = $1 AND channel = $2`, [message.user_id, channel]))[0];
        const alert = (await db.query(`SELECT * FROM alerts WHERE id = $1 AND user_id = $2 AND household_id = $3`, [message.alert_id, message.user_id, message.household_id]))[0];
        if (!consent?.consented_at || consent.opted_out_at || !settings.settings.channels[channel].consent || !settings.settings.channels.inapp.enabled || !alert || ["read", "resolved"].includes(String(alert.status))) throw new Error("cancelled");
        const user = (await db.query(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [message.user_id]))[0];
        if (!user) throw new Error("cancelled");
        const recipient: Actor = { id: String(user.id), email: String(user.email), displayName: String(user.display_name), privacyMode: num(user.privacy_mode) === 1, aiEnabled: num(user.ai_enabled) === 1, locale: String(user.locale), timeZone: String(user.time_zone), theme: String(user.theme), weekStart: num(user.week_start) };
        const loaded = await loadSpace(db, recipient, member.householdId);
        if (!presentAlert(alert, await accessIndex(db, loaded)).targetAvailable) throw new Error("cancelled");
        if (alert.status === "snoozed" || isQuietHours(new Date(), settings.settings)) return null;
        await db.query(`UPDATE remote_messages SET status = 'attempted', detail = 'Provider acceptance pending' WHERE id = $1`, [message.id]);
        return message;
      } catch {
        await db.query(`UPDATE remote_messages SET status = 'cancelled', detail = 'Access, consent, or alert state changed before sending' WHERE id = $1`, [message.id]);
        return null;
      }
    });
    if (!claimed) continue;
    try {
      const result = await sendOwnMessage(db, String(claimed.user_id), String(claimed.channel) as "email" | "push", String(claimed.id));
      await db.query(`UPDATE remote_messages SET status = CASE WHEN received_at IS NULL THEN 'accepted' ELSE 'delivered' END, detail = $1 WHERE id = $2`, [result.note, claimed.id]);
    } catch {
      await db.query(`UPDATE remote_messages SET status = CASE WHEN received_at IS NULL THEN 'failed' ELSE 'delivered' END, detail = 'Acceptance was not confirmed. This message will not be resent automatically.' WHERE id = $1`, [claimed.id]);
    }
  }
}

export interface PublicAlert {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  deliveryStatus: string;
  delivery_status: string;
  deliveryDetail: string | null;
  channels: Record<string, string>;
  amountMinor: number | null;
  href: string | null;
  targetAvailable: boolean;
  targetNote: string | null;
  createdAt: string;
  created_at: string;
  readAt: string | null;
  read_at: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolvedReason: string | null;
  escalatedAt: string | null;
  escalated: boolean;
}

export async function readAlertSettings(db: Database, userId: string, householdId: string, timezone: string) {
  const row = await ensurePreferences(db, userId, householdId, timezone);
  return settingsPayload(row.version, row.settings);
}

export async function saveAlertSettings(db: Database, userId: string, householdId: string, version: unknown, raw: unknown, timezone: string) {
  if (typeof version !== "number" || !Number.isInteger(version)) throw new ApiError(400, "Alert settings need the version you last loaded.");
  const current = await ensurePreferences(db, userId, householdId, timezone);
  const parsed = parseAlertPreferences(raw, timezone);
  if (!parsed.ok) throw new ApiError(400, parsed.error);
  const updated = await db.query<{ version: number }>(
    `UPDATE alert_preferences SET settings_json = $1, version = version + 1, updated_at = $2 WHERE user_id = $3 AND household_id = $4 AND version = $5 RETURNING version`,
    [JSON.stringify(parsed.value), nowIso(), userId, householdId, version],
  );
  if (!updated.length) {
    const latest = await ensurePreferences(db, userId, householdId, timezone);
    throw new ApiError(409, "These alert settings were saved somewhere else. Your unsaved changes are still on this page. Reload the saved settings before saving again.");
  }
  void current;
  return settingsPayload(num(updated[0].version), parsed.value);
}

export async function syncAlerts(db: Database, actor: Actor, loaded: Loaded, now = new Date()): Promise<void> {
  await db.tx(async () => {
    const preferences = await ensurePreferences(db, actor.id, loaded.member.householdId, loaded.member.timeZone);
    const candidates = evaluateAlerts(await collectFacts(db, loaded), preferences.settings);
    let existing = await loadTracked(db, actor.id, loaded.member.householdId);
    for (let step = 0; step < 4; step++) {
      const changes = planAlertChanges({ now, preferences: preferences.settings, candidates, existing });
      if (!changes.length) break;
      await persistChanges(db, actor.id, loaded.member.householdId, changes, now, preferences.settings);
      existing = await loadTracked(db, actor.id, loaded.member.householdId);
    }
    await queueRemoteAlerts(db, actor, loaded, preferences.settings, now);
  });
}

export async function listAlerts(db: Database, actor: Actor, loaded: Loaded): Promise<PublicAlert[]> {
  const rows = await db.query(
    `SELECT * FROM alerts WHERE user_id = $1 AND household_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [actor.id, loaded.member.householdId],
  );
  const access = await accessIndex(db, loaded);
  return Promise.all(rows.map(async (row) => withRemoteStatus(db, presentAlert(row, access), actor.id)));
}

export async function getAlert(db: Database, actor: Actor, loaded: Loaded, alertId: string): Promise<PublicAlert> {
  const rows = await db.query(`SELECT * FROM alerts WHERE id = $1 AND user_id = $2 AND household_id = $3`, [alertId, actor.id, loaded.member.householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  return withRemoteStatus(db, presentAlert(rows[0], await accessIndex(db, loaded)), actor.id);
}

export async function markAlertRead(db: Database, actor: Actor, householdId: string, alertId: string) {
  const stamp = nowIso();
  const rows = await db.query(
    `UPDATE alerts SET status = 'read', read_at = $1, snoozed_until = NULL, updated_at = $1 WHERE id = $2 AND user_id = $3 AND household_id = $4 AND status <> 'resolved' RETURNING id`,
    [stamp, alertId, actor.id, householdId],
  );
  if (!rows.length) {
    const found = await db.query(`SELECT id FROM alerts WHERE id = $1 AND user_id = $2 AND household_id = $3`, [alertId, actor.id, householdId]);
    if (!found.length) throw new ApiError(404, "Not found");
  }
  return { ok: true };
}

export async function markAlertsRead(db: Database, actor: Actor, householdId: string) {
  await db.query(
    `UPDATE alerts SET status = 'read', read_at = $1, updated_at = $1 WHERE user_id = $2 AND household_id = $3 AND status = 'unread'`,
    [nowIso(), actor.id, householdId],
  );
  return { ok: true };
}

export async function snoozeAlert(db: Database, actor: Actor, householdId: string, alertId: string, hours: number | undefined, timezone: string) {
  const preferences = await ensurePreferences(db, actor.id, householdId, timezone);
  const span = hours ?? preferences.settings.snoozeHours;
  if (!Number.isInteger(span) || span < 1 || span > 168) throw new ApiError(400, "Snooze hours must be a whole number from 1 to 168.");
  const until = new Date(Date.now() + span * 3_600_000).toISOString();
  const rows = await db.query(
    `UPDATE alerts SET status = 'snoozed', snoozed_until = $1, updated_at = $2 WHERE id = $3 AND user_id = $4 AND household_id = $5 AND status <> 'resolved' RETURNING id`,
    [until, nowIso(), alertId, actor.id, householdId],
  );
  if (!rows.length) throw new ApiError(404, "Not found");
  return { ok: true, snoozedUntil: until };
}

export async function resolveAlert(db: Database, actor: Actor, householdId: string, alertId: string) {
  const stamp = nowIso();
  const rows = await db.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = COALESCE(resolved_at, $1), resolved_reason = COALESCE(resolved_reason, 'user'), updated_at = $1 WHERE id = $2 AND user_id = $3 AND household_id = $4 RETURNING id`,
    [stamp, alertId, actor.id, householdId],
  );
  if (!rows.length) throw new ApiError(404, "Not found");
  return { ok: true };
}

async function ensurePreferences(db: Database, userId: string, householdId: string, timezone: string) {
  const settings = defaultAlertPreferences(validTimezone(timezone));
  await db.query(
    `INSERT INTO alert_preferences (user_id, household_id, version, settings_json, updated_at) VALUES ($1,$2,1,$3,$4) ON CONFLICT (user_id, household_id) DO NOTHING`,
    [userId, householdId, JSON.stringify(settings), nowIso()],
  );
  const rows = await db.query(`SELECT version, settings_json FROM alert_preferences WHERE user_id = $1 AND household_id = $2`, [userId, householdId]);
  const parsed = parseAlertPreferences(JSON.parse(String(rows[0].settings_json)), timezone);
  if (!parsed.ok) return { version: num(rows[0].version, 1), settings };
  return { version: num(rows[0].version, 1), settings: parsed.value };
}

function settingsPayload(version: number, settings: AlertPreferences) {
  return {
    version,
    settings,
    channels: channelCatalog(settings).map((channel) => {
      const configured = channel.id === "email" ? smtpConfigured() : channel.id === "push" ? fcmConfigured() : false;
      return configured ? { ...channel, available: true, enabled: channel.consent, reason: "Provider configured. Also save message consent in Connections. New in-app alerts can send a generic notification; acceptance is not proof of delivery." } : channel;
    }),
    unsupported: [
      { kind: "price_increase", reason: "No price history or bill-data provider is connected. A bill amount range is not a detected price increase." },
      { kind: "credit_change", reason: "No credit-bureau connection is configured. A score entered by hand is not a bureau change." },
      { kind: "broken_connection", reason: "SimpleFIN errors appear in the bank preview. Automated connection-status alert events are not implemented." },
    ],
    kinds: Object.entries(settings.types).map(([id, enabled]) => ({ id, label: ALERT_KIND_LABELS[id as keyof typeof ALERT_KIND_LABELS], enabled })),
  };
}

async function collectFacts(db: Database, loaded: Loaded) {
  const asOf = loaded.input.asOf;
  const names = new Map(loaded.accounts.map((account) => [account.id, account.name]));
  let cashMinor = 0;
  for (const account of loaded.input.accounts) {
    if (!isOnBudgetCash(account) || !names.has(account.id)) continue;
    cashMinor += displayBalance(account, loaded.balanceTransactions, asOf, false);
  }
  const events = forecastEventsFromSchedules(loaded.input.schedules ?? [], asOf, 35, loaded.input.transactions).map((event) => ({
    id: event.id,
    date: event.date,
    amountMinor: event.amountMinor,
    label: event.label,
    kind: event.kind,
    expectedIncome: event.expectedIncome,
    scheduleId: event.scheduleId,
  }));
  const forecast = projectCash({ startingMinor: cashMinor, startDate: asOf, days: 35, events, includeExpectedIncome: false });
  const current = periodFromDate(asOf);
  const spending = [];
  for (let back = 0; back < 4; back++) {
    const period = periodFromDate(addMonths(current.start, -back));
    for (const row of spendingRows(loaded.input, period.start, period.end, (_txn, bucketId) => bucketId ?? "")) {
      if (!row.key) continue;
      const bucket = loaded.input.buckets.find((item) => item.id === row.key);
      if (!bucket || bucket.kind !== "expense" || bucket.systemRole) continue;
      spending.push({ bucketId: bucket.id, name: bucket.name, period: period.key, spentMinor: row.amountMinor, current: back === 0 });
    }
  }
  const buckets = [];
  for (const row of loaded.budget.buckets) {
    if (row.availableMinor >= 0) continue;
    const bucket = loaded.input.buckets.find((item) => item.id === row.bucketId);
    if (!bucket || bucket.kind !== "expense" || bucket.systemRole) continue;
    buckets.push({ id: bucket.id, name: bucket.name, availableMinor: row.availableMinor, period: current.key });
  }
  const schedules = (loaded.input.schedules ?? []).filter((schedule) => !schedule.archived).map((schedule) => ({
    id: schedule.id,
    name: schedule.name,
    nextDate: schedule.nextDate,
    amountMinor: schedule.amountMinor,
    type: schedule.type,
    direction: schedule.direction,
    paused: schedule.paused === true,
    trialEnds: schedule.trialEnds ?? null,
    renewalDate: schedule.renewalDate ?? null,
    fulfilledThrough: schedule.fulfilledThrough ?? null,
  }));
  const pay = [];
  for (const schedule of schedules) {
    if (schedule.type !== "income" || schedule.paused || schedule.direction !== "inflow") continue;
    if (schedule.fulfilledThrough && schedule.fulfilledThrough >= schedule.nextDate) continue;
    pay.push({ id: `schedule:${schedule.id}`, name: schedule.name, expectedDate: schedule.nextDate, amountMinor: schedule.amountMinor, status: "expected" });
  }
  const occurrences = await db.query(
    `SELECT o.id, o.expected_date, o.status, o.expected_amount_minor, o.revised_amount_minor, o.remaining_minor, o.delayed_until, s.name, s.account_id
     FROM income_occurrences o JOIN income_sources s ON s.id = o.source_id
     WHERE o.household_id = $1 AND s.archived = 0 AND s.paused = 0`,
    [loaded.member.householdId],
  );
  for (const row of occurrences) {
    if (!names.has(String(row.account_id))) continue;
    if (str(row.delayed_until) && String(row.delayed_until) > asOf) continue;
    if (row.remaining_minor != null && num(row.remaining_minor) <= 0 && String(row.status) === "partial") continue;
    const amount = row.revised_amount_minor == null ? num(row.expected_amount_minor) : num(row.revised_amount_minor);
    pay.push({ id: String(row.id), name: String(row.name), expectedDate: String(row.expected_date), amountMinor: amount, status: String(row.status) });
  }
  const goalRows = await db.query(`SELECT * FROM goals WHERE space_id = $1 AND archived = 0`, [loaded.spaceId]);
  const visibleBuckets = new Set(loaded.input.buckets.map((bucket) => bucket.id));
  const goals = goalRows.flatMap((goal) => {
    const bucketId = str(goal.bucket_id);
    if (bucketId && !visibleBuckets.has(bucketId)) return [];
    return [{
      id: String(goal.id),
      name: String(goal.name),
      availableMinor: loaded.budget.buckets.find((row) => row.bucketId === bucketId)?.availableMinor ?? 0,
      targetMinor: num(goal.target_minor),
      targetDate: str(goal.target_date) ?? null,
    }];
  });
  const debts = [];
  for (const account of loaded.input.accounts) {
    if (!isLiability(account) || !names.has(account.id)) continue;
    const balanceMinor = displayBalance(account, loaded.balanceTransactions, asOf, false);
    const hadActivity = loaded.balanceTransactions.some((txn) => (txn.accountId === account.id || txn.counterAccountId === account.id) && txn.type !== "opening" && !txn.deleted);
    debts.push({ id: account.id, name: names.get(account.id) ?? account.name, balanceMinor, hadActivity });
  }
  return {
    asOf,
    cashMinor,
    overdraftDate: forecast.overdraftDate,
    cardGaps: loaded.budget.cardGaps.filter((gap) => names.has(gap.accountId) && gap.gapMinor > 0).map((gap) => ({
      accountId: gap.accountId,
      name: names.get(gap.accountId) ?? "Card",
      gapMinor: gap.gapMinor,
    })),
    transactions: loaded.input.transactions.flatMap((txn) => {
      if (!names.has(txn.accountId) || txn.deleted || txn.bankStatus === "pending" || txn.payee === "Private transfer") return [];
      return [{ id: txn.id, date: txn.date, amountMinor: txn.amountMinor, payee: txn.payee, accountName: names.get(txn.accountId) ?? "Account", type: txn.type }];
    }),
    spending,
    buckets,
    schedules,
    pay,
    goals,
    debts,
    sourceEvents: (await db.query(
      `SELECT id, kind, title, body, occurred_on FROM provider_events WHERE household_id = $1 AND kind IN ('price_increase', 'credit_change', 'broken_connection')`,
      [loaded.member.householdId],
    )).map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as "price_increase" | "credit_change" | "broken_connection",
      title: String(row.title),
      body: String(row.body),
      occurredOn: String(row.occurred_on),
    })),
  };
}

async function loadTracked(db: Database, userId: string, householdId: string): Promise<TrackedAlert[]> {
  const rows = await db.query(
    `SELECT DISTINCT ON (dedupe_key) * FROM alerts WHERE user_id = $1 AND household_id = $2 ORDER BY dedupe_key, created_at DESC`,
    [userId, householdId],
  );
  return rows.map(toTracked);
}

function toTracked(row: Record<string, unknown>): TrackedAlert {
  return {
    id: String(row.id),
    kind: String(row.kind),
    dedupeKey: String(row.dedupe_key),
    fingerprint: String(row.fingerprint ?? ""),
    title: String(row.title),
    body: String(row.body),
    status: String(row.status ?? "unread") as TrackedAlert["status"],
    deliveryStatus: String(row.delivery_status ?? "generated") as TrackedAlert["deliveryStatus"],
    snoozedUntil: str(row.snoozed_until) ?? null,
    createdAt: String(row.created_at),
    escalatedAt: str(row.escalated_at) ?? null,
    lastNotifiedAt: str(row.last_notified_at) ?? null,
    amountMinor: row.amount_minor == null ? null : num(row.amount_minor),
    entityType: str(row.entity_type) ?? null,
    entityId: str(row.entity_id) ?? null,
    href: str(row.href) ?? null,
  };
}

async function persistChanges(db: Database, userId: string, householdId: string, changes: AlertChange[], now: Date, preferences: AlertPreferences) {
  for (const change of changes) {
    if (change.op === "insert") {
      const delivery = change.alert.deliveryStatus;
      await db.query(
        `INSERT INTO alerts (
          id, household_id, user_id, kind, dedupe_key, fingerprint, title, body, entity_type, entity_id, href, amount_minor,
          status, created_at, updated_at, delivery_status, delivery_detail, channel_status, channel
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,'inapp')`,
        [
          id(), householdId, userId, change.alert.kind, change.alert.dedupeKey, change.alert.fingerprint, change.alert.title, change.alert.body,
          change.alert.entityType, change.alert.entityId, change.alert.href, change.alert.amountMinor, change.alert.status, change.alert.createdAt,
          delivery, detailFor(delivery, preferences), channelJson(delivery),
        ],
      );
      continue;
    }
    if (change.op === "resolve") {
      await db.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = $1, resolved_reason = 'condition_cleared', updated_at = $1 WHERE id = $2 AND user_id = $3 AND household_id = $4 AND status <> 'resolved'`,
        [now.toISOString(), change.id, userId, householdId],
      );
      continue;
    }
    const sets: string[] = ["updated_at = $1"];
    const params: unknown[] = [now.toISOString()];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    const patch = change.patch;
    if (patch.fingerprint != null) add("fingerprint", patch.fingerprint);
    if (patch.title != null) add("title", patch.title);
    if (patch.body != null) add("body", patch.body);
    if ("amountMinor" in patch) add("amount_minor", patch.amountMinor ?? null);
    if ("href" in patch) add("href", patch.href ?? null);
    if (patch.status) {
      add("status", patch.status);
      if (patch.status === "unread") add("read_at", null);
    }
    if ("snoozedUntil" in patch) add("snoozed_until", patch.snoozedUntil ?? null);
    if (patch.deliveryStatus) {
      add("delivery_status", patch.deliveryStatus);
      add("delivery_detail", detailFor(patch.deliveryStatus, preferences));
      add("channel_status", channelJson(patch.deliveryStatus));
    }
    if ("lastNotifiedAt" in patch) add("last_notified_at", patch.lastNotifiedAt ?? null);
    if ("escalatedAt" in patch) add("escalated_at", patch.escalatedAt ?? null);
    params.push(change.id, userId, householdId);
    await db.query(`UPDATE alerts SET ${sets.join(", ")} WHERE id = $${params.length - 2} AND user_id = $${params.length - 1} AND household_id = $${params.length}`, params);
  }
}

function detailFor(delivery: DeliveryStatus, preferences: AlertPreferences): string {
  if (delivery === "delivered") return preferences.frequency === "digest" ? "Delivered in the app with the digest." : "Delivered in the app.";
  if (delivery === "queued") return "Queued for the in-app list.";
  if (delivery === "attempted") return "A delivery attempt did not confirm. It was not marked delivered.";
  if (!preferences.channels.inapp.enabled) return "In-app alerts are off, so this was not delivered.";
  if (preferences.frequency === "digest") return "Waiting for the digest.";
  return "Waiting until quiet hours end.";
}

function channelJson(delivery: DeliveryStatus): string {
  return JSON.stringify({ inapp: delivery, push: "unavailable", email: "unavailable", sms: "unavailable" });
}

interface AccessIndex {
  transactions: Set<string>;
  schedules: Set<string>;
  accounts: Set<string>;
  buckets: Set<string>;
  goals: Set<string>;
  income: Set<string>;
}

async function accessIndex(db: Database, loaded: Loaded): Promise<AccessIndex> {
  const transactions = new Set(loaded.input.transactions.filter((txn) => loaded.visibleAccountIds.has(txn.accountId)).map((txn) => txn.id));
  const buckets = new Set(loaded.input.buckets.map((bucket) => bucket.id));
  const goalRows = await db.query(`SELECT id, bucket_id FROM goals WHERE space_id = $1 AND archived = 0`, [loaded.spaceId]);
  const goals = new Set(goalRows.filter((goal) => !goal.bucket_id || buckets.has(String(goal.bucket_id))).map((goal) => String(goal.id)));
  const incomeRows = await db.query(
    `SELECT o.id, s.account_id FROM income_occurrences o JOIN income_sources s ON s.id = o.source_id WHERE o.household_id = $1`,
    [loaded.member.householdId],
  );
  const income = new Set<string>();
  for (const row of incomeRows) {
    if (loaded.visibleAccountIds.has(String(row.account_id))) income.add(String(row.id));
  }
  for (const schedule of loaded.input.schedules ?? []) income.add(`schedule:${schedule.id}`);
  return {
    transactions,
    schedules: new Set((loaded.input.schedules ?? []).map((schedule) => schedule.id)),
    accounts: new Set(loaded.visibleAccountIds),
    buckets,
    goals,
    income,
  };
}

function presentAlert(row: Record<string, unknown>, access: AccessIndex): PublicAlert {
  const entityType = str(row.entity_type);
  const entityId = str(row.entity_id);
  const visible = entityVisible(entityType, entityId, access);
  const createdAt = String(row.created_at);
  const readAt = str(row.read_at);
  let channels: Record<string, string> = { inapp: String(row.delivery_status ?? "generated"), push: "unavailable", email: "unavailable", sms: "unavailable" };
  try {
    const parsed = JSON.parse(String(row.channel_status ?? "{}")) as Record<string, string>;
    channels = { ...channels, ...parsed, push: "unavailable", email: "unavailable", sms: "unavailable" };
  } catch {
    channels = channels;
  }
  const hidden = entityType != null && entityId != null && !visible;
  return {
    id: String(row.id),
    kind: hidden ? "unavailable" : String(row.kind),
    title: hidden ? "Alert" : String(row.title),
    body: hidden ? REDACTED : String(row.body),
    status: String(row.status ?? (readAt ? "read" : "unread")),
    deliveryStatus: String(row.delivery_status ?? "generated"),
    delivery_status: String(row.delivery_status ?? "generated"),
    deliveryDetail: str(row.delivery_detail) ?? null,
    channels,
    amountMinor: hidden || row.amount_minor == null ? null : num(row.amount_minor),
    href: hidden ? null : str(row.href) ?? null,
    targetAvailable: !hidden && !!str(row.href),
    targetNote: hidden ? REDACTED : null,
    createdAt,
    created_at: createdAt,
    readAt: readAt ?? null,
    read_at: readAt ?? null,
    snoozedUntil: str(row.snoozed_until) ?? null,
    resolvedAt: str(row.resolved_at) ?? null,
    resolvedReason: str(row.resolved_reason) ?? null,
    escalatedAt: str(row.escalated_at) ?? null,
    escalated: !!str(row.escalated_at),
  };
}

function entityVisible(entityType: string | null | undefined, entityId: string | null | undefined, access: AccessIndex): boolean {
  if (!entityType || !entityId) return true;
  if (entityType === "transaction") return access.transactions.has(entityId);
  if (entityType === "schedule") return access.schedules.has(entityId);
  if (entityType === "account") return access.accounts.has(entityId);
  if (entityType === "bucket") return access.buckets.has(entityId);
  if (entityType === "goal") return access.goals.has(entityId);
  if (entityType === "income") return access.income.has(entityId);
  return false;
}

function validTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}
