import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { defaultAlertPreferences } from "@budgetcents/domain";
import { sendFcm } from "../src/providers/fcm.js";
import { sendOwnMessage } from "../src/providers/live-messages.js";
import { runRemoteAlerts } from "../src/alerts.js";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

vi.mock("../src/providers/live-messages.js", async (original) => ({ ...await original<typeof import("../src/providers/live-messages.js")>(), sendOwnMessage: vi.fn() }));
let db: Database;
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await db?.close(); });

it("signs a scoped OAuth assertion and sends a generic data-only FCM message without claiming delivery", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("BUDGETCENTS_PUSH_ENABLED", "true");
  vi.stubEnv("FCM_SERVICE_ACCOUNT_JSON", JSON.stringify({ project_id: "budgetcents-test", client_email: "test@budgetcents-test.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }));
  const request = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "test-access", expires_in: 3600 })).mockResolvedValueOnce(Response.json({ name: "projects/budgetcents-test/messages/123" }));
  const result = await sendFcm("phone-token", "event-123", request);
  expect(result).toMatchObject({ status: "accepted", provenDelivered: false });
  const assertion = (request.mock.calls[0][1].body as URLSearchParams).get("assertion")!;
  const [header, body, signature] = assertion.split(".");
  expect(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({ aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/firebase.messaging" });
  const message = JSON.parse(String(request.mock.calls[1][1].body));
  expect(message.message).toEqual({ token: "phone-token", data: { kind: "budgetcents_alert", eventId: "event-123" }, android: { priority: "normal", ttl: "3600s" } });
  await expect(sendFcm("expired", "event-456", vi.fn().mockResolvedValue(Response.json({ error: { details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 })))).rejects.toThrow("expired");
});

it("delivers each eligible condition once, isolates its owner, and cancels queued delivery when access is removed", async () => {
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "true"); vi.stubEnv("SMTP_URL", "smtp://not-contacted.invalid"); vi.stubEnv("SMTP_FROM", "test@example.test");
  vi.mocked(sendOwnMessage).mockResolvedValue({ status: "accepted", provenDelivered: false, note: "Provider accepted" });
  db = await openMemoryDatabase(); const app = createApp(db);
  const user = await (await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "remote@example.test", password: "remote-test-password", displayName: "Owner", householdName: "Remote" }) })).json();
  const headers = { authorization: `Bearer ${user.token}`, "content-type": "application/json" };
  const hid = (await (await app.request("/api/households", { headers })).json()).households[0].id;
  const prefs = defaultAlertPreferences("UTC");
  for (const kind of Object.keys(prefs.types) as (keyof typeof prefs.types)[]) prefs.types[kind] = kind === "low_balance";
  prefs.channels.email.consent = true; prefs.quietHours.enabled = false; prefs.frequency = "immediate";
  await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), user.user.id]);
  await db.query(`INSERT INTO alert_preferences (user_id, household_id, settings_json, version, updated_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT (user_id, household_id) DO UPDATE SET settings_json = EXCLUDED.settings_json`, [user.user.id, hid, JSON.stringify(prefs), new Date().toISOString()]);
  await app.request("/api/messages/enrollment", { method: "POST", headers, body: JSON.stringify({ channel: "email", destinationLabel: "My email", consent: true }) });
  const before = await db.query(`SELECT * FROM transactions ORDER BY id`);
  await runRemoteAlerts(db); await runRemoteAlerts(db);
  expect(sendOwnMessage).toHaveBeenCalledTimes(1);
  const history = await (await app.request("/api/notifications/remote-history", { headers })).json();
  expect(history.messages).toHaveLength(1);
  expect(history.messages[0]).toMatchObject({ status: "accepted", provenDelivered: false });
  await db.query(`UPDATE remote_messages SET status = 'queued' WHERE user_id = $1`, [user.user.id]);
  await db.query(`UPDATE alerts SET entity_type = 'account', entity_id = 'no-longer-visible' WHERE user_id = $1`, [user.user.id]);
  await runRemoteAlerts(db);
  expect(sendOwnMessage).toHaveBeenCalledTimes(1);
  expect((await db.query(`SELECT status FROM remote_messages WHERE user_id = $1`, [user.user.id]))[0].status).toBe("cancelled");
  await db.query(`UPDATE remote_messages SET status = 'queued' WHERE user_id = $1`, [user.user.id]);
  await db.query(`DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`, [hid, user.user.id]);
  await runRemoteAlerts(db);
  expect(sendOwnMessage).toHaveBeenCalledTimes(1);
  expect((await db.query(`SELECT status FROM remote_messages WHERE user_id = $1`, [user.user.id]))[0].status).toBe("cancelled");
  expect(await db.query(`SELECT * FROM transactions ORDER BY id`)).toEqual(before);
});

it("accepts only the recipient's push receipt and distinguishes it from provider acceptance", async () => {
  db = await openMemoryDatabase(); const app = createApp(db);
  const register = async (email: string) => (await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "receipt-password", displayName: "Member", householdName: "Home" }) })).json();
  const owner = await register("push-owner@example.test"); const other = await register("push-other@example.test");
  const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
  await db.query(`INSERT INTO remote_messages (id,user_id,op_id,channel,status,detail,created_at) VALUES ('push-receipt',$1,'test-op','push','accepted','Provider accepted',$2)`, [owner.user.id, new Date().toISOString()]);
  const endpoint = "/api/notifications/remote/push-receipt/received";
  expect((await app.request(endpoint, { method: "POST", headers: { ...headers, authorization: `Bearer ${other.token}` } })).status).toBe(404);
  expect((await app.request(endpoint, { method: "POST", headers })).status).toBe(200);
  const history = await (await app.request("/api/notifications/remote-history", { headers })).json();
  expect(history.messages[0]).toMatchObject({ status: "delivered", provenDelivered: true });
  expect(history.messages[0].deliveryEvidence).toContain("does not prove it was read");
  expect((await (await app.request("/api/notifications/remote-history", { headers: { authorization: `Bearer ${other.token}` } })).json()).messages).toEqual([]);
});
