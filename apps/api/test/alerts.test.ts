import { afterEach, describe, expect, it } from "vitest";
import { syncAlerts } from "../src/alerts.js";
import { createApp } from "../src/http.js";
import { migrate, openMemoryDatabase, type Database } from "../src/db.js";
import { loadSpace, type Actor } from "../src/finance.js";

let db: Database;
afterEach(async () => { await db?.close(); });

function actor(id: string, email: string): Actor {
  return { id, email, displayName: email, privacyMode: false, aiEnabled: true, locale: "en-US", timeZone: "America/Chicago", theme: "system", weekStart: 0 };
}

async function fixture() {
  db = await openMemoryDatabase();
  await migrate(db);
  const app = createApp(db);
  async function call(path: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function register(name: string, householdName?: string) {
    const result = await call("/api/auth/register", "", { email: `${name}@example.com`, password: "correct-horse", displayName: name, householdName });
    expect(result.status).toBe(200);
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), result.body.user.id]);
    return { id: result.body.user.id as string, token: result.body.token as string, email: `${name}@example.com` };
  }
  const owner = await register("Owner", "Alert household");
  const homes = await call("/api/households", owner.token);
  const hid = homes.body.households[0].id as string;
  const base = `/api/households/${hid}`;
  const dash = await call(`${base}/dashboard?asOf=2026-11-11`, owner.token);
  const spaceId = dash.body.spaceId as string;
  const bucket = (dash.body.buckets as { id: string; kind: string; systemRole?: string | null }[]).find((item) => item.kind === "expense" && !item.systemRole);
  expect(bucket).toBeTruthy();
  const coach = await register("Coach");
  const invitation = await call(`${base}/invitations`, owner.token, { email: coach.email, role: "coach" });
  expect((await call(`/api/invitations/${invitation.body.token}/accept`, coach.token, {})).status).toBe(200);
  const joint = await call(`${base}/accounts`, owner.token, { spaceId, name: "Joint", kind: "checking", openingBalanceMinor: 20000000, openingDate: "2026-09-01" });
  const secret = await call(`${base}/accounts`, owner.token, { spaceId, name: "Secret Vault", kind: "checking", visibility: "private", openingBalanceMinor: 5000000, openingDate: "2026-09-01" });
  async function spend(payee: string, date: string, amountMinor: number, accountId = joint.body.id) {
    const saved = await call(`${base}/transactions`, owner.token, {
      spaceId, accountId, date, amountMinor, type: "expense", payee, splits: [{ bucketId: bucket!.id, amountMinor: Math.abs(amountMinor), role: "expense" }],
    });
    expect(saved.status).toBe(201);
    return saved.body.id as string;
  }
  await spend("Old groceries", "2026-09-15", -1000);
  await spend("Older groceries", "2026-10-15", -1000);
  const sharedExpense = await spend("Market", "2026-11-10", -30000);
  const privateExpense = await spend("Hidden Payee", "2026-11-10", -77777, secret.body.id);
  const bill = await call(`${base}/schedules`, owner.token, { spaceId, name: "Rent", cadence: "monthly", nextDate: "2026-11-12", amountMinor: 1000, direction: "outflow", type: "subscription", accountId: joint.body.id });
  expect(bill.status).toBe(201);
  await db.query(`UPDATE schedules SET next_date = '2026-11-12', trial_ends = '2026-11-16', renewal_date = '2026-11-18' WHERE id = $1`, [bill.body.id]);
  const secretBill = await call(`${base}/schedules`, owner.token, { spaceId, name: "Secret Bill", cadence: "monthly", nextDate: "2026-11-12", amountMinor: 4000, direction: "outflow", type: "bill", accountId: secret.body.id });
  expect(secretBill.status).toBe(201);
  await db.query(`UPDATE schedules SET next_date = '2026-11-12' WHERE id = $1`, [secretBill.body.id]);
  const goal = await call(`${base}/goals`, owner.token, { spaceId, name: "Trip", bucketId: bucket!.id, targetMinor: 500000, targetDate: "2026-11-20" });
  expect(goal.status).toBe(201);
  const stamp = new Date().toISOString();
  const sourceId = "income-shared";
  const secretSource = "income-secret";
  await db.query(
    `INSERT INTO income_sources (id, household_id, space_id, name, kind, account_id, amount_minor, cadence, start_date, paused, archived, version, created_at, updated_at) VALUES ($1,$2,$3,'Payday','salary',$4,500000,'monthly','2026-11-01',0,0,1,$5,$5)`,
    [sourceId, hid, spaceId, joint.body.id, stamp],
  );
  await db.query(
    `INSERT INTO income_occurrences (id, household_id, source_id, occurrence_key, expected_date, status, expected_amount_minor, created_at, updated_at) VALUES ($1,$2,$3,'pay-shared','2026-11-01','expected',500000,$4,$4)`,
    ["occ-shared", hid, sourceId, stamp],
  );
  await db.query(
    `INSERT INTO income_sources (id, household_id, space_id, name, kind, account_id, amount_minor, cadence, start_date, paused, archived, version, created_at, updated_at) VALUES ($1,$2,$3,'Hidden Pay','salary',$4,900000,'monthly','2026-11-01',0,0,1,$5,$5)`,
    [secretSource, hid, spaceId, secret.body.id, stamp],
  );
  await db.query(
    `INSERT INTO income_occurrences (id, household_id, source_id, occurrence_key, expected_date, status, expected_amount_minor, created_at, updated_at) VALUES ($1,$2,$3,'pay-secret','2026-11-01','expected',900000,$4,$4)`,
    ["occ-secret", hid, secretSource, stamp],
  );
  async function sums() {
    const txns = await db.query<{ total: number }>(`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM transactions WHERE household_id = $1 AND deleted = 0`, [hid]);
    const assigned = await db.query<{ total: number }>(`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM assignments WHERE space_id = $1`, [spaceId]);
    return [Number(txns[0].total), Number(assigned[0].total)];
  }
  async function money(token = owner.token) {
    const result = await call(`${base}/dashboard?asOf=2026-11-11`, token);
    expect(result.status).toBe(200);
    return [result.body.budget.readyToAssignMinor, result.body.budget.spendingMinor, result.body.budget.incomeMinor, result.body.netWorth.netMinor, result.body.budget.identityDifferenceMinor];
  }
  async function settings(token = owner.token) {
    const result = await call(`${base}/alert-settings`, token);
    expect(result.status).toBe(200);
    return result.body;
  }
  async function save(token: string, version: number, value: unknown) {
    return call(`${base}/alert-settings`, token, { version, settings: value }, "PUT");
  }
  async function run(person: { id: string; email: string }, now: Date) {
    const loaded = await loadSpace(db, actor(person.id, person.email), hid, spaceId, "2026-11-11");
    await syncAlerts(db, actor(person.id, person.email), loaded, now);
  }
  return { call, base, hid, spaceId, owner, coach, bucket: bucket!, joint, secret, sharedExpense, privateExpense, bill, secretBill, goal, sums, money, settings, save, run };
}

describe("household alerts", () => {
  it("evaluates visible records once, honors quiet hours, digests, snooze, and retries", async () => {
    const f = await fixture();
    const before = await f.sums();
    const outbox = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM outbox`);
    const current = await f.settings();
    const quiet = await f.save(f.owner.token, current.version, {
      ...current.settings,
      timezone: "America/Chicago",
      frequency: "immediate",
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
    });
    expect(quiet.status).toBe(200);
    const night = new Date("2026-11-12T05:30:00.000Z");
    await f.run(f.owner, night);
    const held = await db.query<{ id: string; delivery_status: string; dedupe_key: string }>(`SELECT id, delivery_status, dedupe_key FROM alerts WHERE user_id = $1 AND kind = 'bill_due'`, [f.owner.id]);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((row) => row.delivery_status === "generated")).toBe(true);
    const heldIds = held.map((row) => row.id).sort();
    await f.run(f.owner, night);
    const stillHeld = await db.query<{ id: string }>(`SELECT id FROM alerts WHERE user_id = $1 AND kind = 'bill_due' ORDER BY id`, [f.owner.id]);
    expect(stillHeld.map((row) => row.id).sort()).toEqual(heldIds);

    const morning = new Date("2026-11-12T15:00:00.000Z");
    await f.run(f.owner, morning);
    await f.run(f.owner, morning);
    const delivered = await db.query<{ id: string; delivery_status: string }>(`SELECT id, delivery_status FROM alerts WHERE user_id = $1 AND kind = 'bill_due'`, [f.owner.id]);
    expect(delivered.map((row) => row.id).sort()).toEqual(heldIds);
    expect(delivered.every((row) => row.delivery_status === "delivered")).toBe(true);

    const digestSettings = await f.settings();
    const digest = await f.save(f.owner.token, digestSettings.version, {
      ...digestSettings.settings,
      frequency: "digest",
      quietHours: { ...digestSettings.settings.quietHours, enabled: false },
      digest: { enabled: true, frequency: "daily", hour: 8, minute: 0, weekday: 1 },
    });
    expect(digest.status).toBe(200);
    const extra = await f.call(`${f.base}/schedules`, f.owner.token, { spaceId: f.spaceId, name: "Internet", cadence: "monthly", nextDate: "2026-11-12", amountMinor: 800, direction: "outflow", type: "bill", accountId: f.joint.body.id });
    expect(extra.status).toBe(201);
    await db.query(`UPDATE schedules SET next_date = '2026-11-12' WHERE id = $1`, [extra.body.id]);
    await f.run(f.owner, new Date("2026-11-11T13:30:00.000Z"));
    const waiting = await db.query<{ id: string; delivery_status: string }>(`SELECT id, delivery_status FROM alerts WHERE user_id = $1 AND dedupe_key LIKE $2`, [f.owner.id, `%${extra.body.id}%`]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].delivery_status).toBe("generated");
    await f.run(f.owner, new Date("2026-11-11T14:00:00.000Z"));
    await f.run(f.owner, new Date("2026-11-11T14:05:00.000Z"));
    const sent = await db.query<{ id: string; delivery_status: string; channel_status: string }>(`SELECT id, delivery_status, channel_status FROM alerts WHERE user_id = $1 AND dedupe_key LIKE $2`, [f.owner.id, `%${extra.body.id}%`]);
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe(waiting[0].id);
    expect(sent[0].delivery_status).toBe("delivered");
    expect(JSON.parse(sent[0].channel_status).email).toBe("unavailable");
    expect(JSON.parse(sent[0].channel_status).push).toBe("unavailable");
    expect(JSON.parse(sent[0].channel_status).sms).toBe("unavailable");

    const snooze = await f.call(`${f.base}/alerts/${sent[0].id}/snooze`, f.owner.token, { hours: 1 });
    expect(snooze.status).toBe(200);
    await f.run(f.owner, new Date());
    const snoozed = await db.query<{ status: string }>(`SELECT status FROM alerts WHERE id = $1`, [sent[0].id]);
    expect(snoozed[0].status).toBe("snoozed");
    const countWhileSnoozed = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM alerts WHERE user_id = $1 AND dedupe_key LIKE $2`, [f.owner.id, `%${extra.body.id}%`]);
    expect(Number(countWhileSnoozed[0].count)).toBe(1);
    await f.run(f.owner, new Date(Date.now() + 2 * 3_600_000));
    const woken = await db.query<{ id: string; status: string; delivery_status: string }>(`SELECT id, status, delivery_status FROM alerts WHERE user_id = $1 AND dedupe_key LIKE $2`, [f.owner.id, `%${extra.body.id}%`]);
    expect(woken).toHaveLength(1);
    expect(woken[0].status).toBe("unread");
    expect(woken[0].delivery_status).toBe("delivered");

    await db.query(`UPDATE alerts SET delivery_status = 'queued', last_notified_at = NULL WHERE id = $1`, [woken[0].id]);
    await f.run(f.owner, new Date("2026-11-12T15:00:00.000Z"));
    const retried = await db.query<{ delivery_status: string }>(`SELECT delivery_status FROM alerts WHERE id = $1`, [woken[0].id]);
    expect(retried[0].delivery_status).toBe("delivered");
    await db.query(`UPDATE alerts SET delivery_status = 'attempted' WHERE id = $1`, [woken[0].id]);
    await f.run(f.owner, new Date("2026-11-12T16:00:00.000Z"));
    await f.run(f.owner, new Date("2026-11-12T17:00:00.000Z"));
    const attempted = await db.query<{ count: number; delivery_status: string }>(`SELECT COUNT(*) AS count, MAX(delivery_status) AS delivery_status FROM alerts WHERE user_id = $1 AND dedupe_key LIKE $2`, [f.owner.id, `%${extra.body.id}%`]);
    expect(Number(attempted[0].count)).toBe(1);
    expect(attempted[0].delivery_status).toBe("attempted");

    const listed = await f.call(`${f.base}/alerts?asOf=2026-11-11`, f.owner.token);
    expect(listed.status).toBe(200);
    expect(listed.body.alerts.length).toBeGreaterThan(0);
    const again = await f.call(`${f.base}/alerts?asOf=2026-11-11`, f.owner.token);
    expect(again.body.alerts.map((alert: { id: string }) => alert.id).sort()).toEqual(listed.body.alerts.map((alert: { id: string }) => alert.id).sort());
    const after = await f.sums();
    expect(after).toEqual(before);
    const laterOutbox = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM outbox`);
    expect(Number(laterOutbox[0].count)).toBe(Number(outbox[0].count));
    const firstMoney = await f.money();
    expect((await f.call(`${f.base}/alerts/${sent[0].id}/read`, f.owner.token, {})).status).toBe(200);
    expect((await f.call(`${f.base}/alerts/${sent[0].id}/resolve`, f.owner.token, {})).status).toBe(200);
    expect(await f.money()).toEqual(firstMoney);
  });

  it("keeps private records out of another member's alerts and drops access when membership ends", async () => {
    const f = await fixture();
    const before = await f.sums();
    const current = await f.settings();
    expect((await f.save(f.owner.token, current.version, { ...current.settings, timezone: "America/Chicago", quietHours: { ...current.settings.quietHours, enabled: false } })).status).toBe(200);
    const coachSettings = await f.settings(f.coach.token);
    expect((await f.save(f.coach.token, coachSettings.version, { ...coachSettings.settings, timezone: "America/Chicago", quietHours: { ...coachSettings.settings.quietHours, enabled: false } })).status).toBe(200);
    await f.run(f.owner, new Date("2026-11-11T15:00:00.000Z"));
    await f.run(f.coach, new Date("2026-11-11T15:00:00.000Z"));
    const ownerList = await f.call(`${f.base}/alerts?asOf=2026-11-11`, f.owner.token);
    const coachList = await f.call(`${f.base}/alerts?asOf=2026-11-11`, f.coach.token);
    const ownerText = JSON.stringify(ownerList.body);
    const coachText = JSON.stringify(coachList.body);
    expect(ownerText).toContain("Hidden Payee");
    expect(ownerText).toContain("Secret Bill");
    expect(ownerText).toContain("Hidden Pay");
    expect(coachText).not.toContain("Hidden Payee");
    expect(coachText).not.toContain("Secret Bill");
    expect(coachText).not.toContain("Secret Vault");
    expect(coachText).not.toContain("Hidden Pay");
    expect(coachText).not.toContain(f.privateExpense);
    expect(coachText).not.toContain(f.secret.body.id);
    expect(coachText).not.toContain("77777");
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "large_transaction")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "bill_due")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "trial_ending")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "renewal")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "missing_pay")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "underfunded_goal")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "overspending")).toBe(true);
    expect(ownerList.body.alerts.some((alert: { kind: string }) => alert.kind === "unusual_spending")).toBe(true);
    expect(coachList.body.alerts.some((alert: { kind: string; body: string }) => alert.kind === "large_transaction" && alert.body.includes("Market"))).toBe(true);
    const privateAlert = ownerList.body.alerts.find((alert: { body: string }) => alert.body.includes("Hidden Payee"));
    expect((await f.call(`${f.base}/alerts/${privateAlert.id}?asOf=2026-11-11`, f.coach.token)).status).toBe(404);
    const ownerOpen = await f.call(`${f.base}/alerts/${privateAlert.id}?asOf=2026-11-11`, f.owner.token);
    expect(ownerOpen.status).toBe(200);
    expect(ownerOpen.body.alert.href).toContain(f.privateExpense);
    await db.query(
      `INSERT INTO alerts (id, household_id, user_id, kind, dedupe_key, fingerprint, title, body, entity_type, entity_id, href, amount_minor, status, created_at, updated_at, delivery_status, channel_status, channel)
       VALUES ('planted','${f.hid}','${f.coach.id}','large_transaction','planted-private','x','Large transaction','Hidden Payee on Secret Vault','transaction','${f.privateExpense}','/activity?ids=${f.privateExpense}',-77777,'unread',$1,$1,'delivered','{}','inapp')`,
      [new Date().toISOString()],
    );
    const redacted = await f.call(`${f.base}/alerts?asOf=2026-11-11`, f.coach.token);
    const planted = redacted.body.alerts.find((alert: { id: string }) => alert.id === "planted");
    expect(planted.body).toBe("That record is no longer available to you.");
    expect(planted.href).toBeNull();
    expect(planted.amountMinor).toBeNull();
    expect(JSON.stringify(planted)).not.toContain("Hidden Payee");
    expect(JSON.stringify(planted)).not.toContain(f.privateExpense);
    const activity = await f.call(`${f.base}/transactions?asOf=2026-11-11&ids=${f.privateExpense}`, f.coach.token);
    expect(JSON.stringify(activity.body)).not.toContain("Hidden Payee");
    const ownerMoney = await f.money();
    const coachMoney = await f.money(f.coach.token);
    expect((await f.call(`${f.base}/members/${f.coach.id}`, f.owner.token, undefined, "DELETE")).status).toBe(200);
    expect((await f.call(`${f.base}/alerts?asOf=2026-11-11`, f.coach.token)).status).toBe(404);
    expect((await f.call(`${f.base}/alert-settings`, f.coach.token)).status).toBe(404);
    expect(await f.sums()).toEqual(before);
    expect(await f.money()).toEqual(ownerMoney);
    expect(coachMoney[0]).not.toBe(ownerMoney[0]);
  });

  it("validates channel consent and refuses a stale settings save", async () => {
    const f = await fixture();
    const current = await f.settings();
    const unsupported = await f.save(f.owner.token, current.version, { ...current.settings, types: { ...current.settings.types, credit_change: true } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error).toMatch(/credit-bureau/i);
    const push = await f.save(f.owner.token, current.version, { ...current.settings, channels: { ...current.settings.channels, push: { enabled: true, consent: true } } });
    expect(push.status).toBe(400);
    expect(push.body.error).toMatch(/remote push/i);
    const email = await f.save(f.owner.token, current.version, { ...current.settings, channels: { ...current.settings.channels, email: { consent: true }, sms: { consent: true } } });
    expect(email.status).toBe(200);
    expect(email.body.channels.find((channel: { id: string }) => channel.id === "email")).toMatchObject({ available: false, enabled: false, consent: true });
    expect(email.body.channels.find((channel: { id: string }) => channel.id === "sms").available).toBe(false);
    expect(email.body.channels.find((channel: { id: string }) => channel.id === "inapp")).toMatchObject({ available: true, enabled: true });
    expect(email.body.unsupported.map((item: { kind: string }) => item.kind)).toEqual(["price_increase", "credit_change", "broken_connection"]);
    const stale = await f.save(f.owner.token, current.version, { ...email.body.settings, snoozeHours: 4 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/saved somewhere else/i);
    expect(stale.body.settings.snoozeHours).toBe(email.body.settings.snoozeHours);
    const latest = await f.settings();
    expect(latest.version).toBe(email.body.version);
    expect(latest.settings.snoozeHours).not.toBe(4);
  });
});
