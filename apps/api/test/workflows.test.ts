import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { totp } from "../src/crypto.js";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;

afterEach(async () => {
  delete process.env.SANDBOX_WEBHOOK_SECRET;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.OIDC_TEST_MODE;
  await db?.close();
});

async function app() {
  db = await openMemoryDatabase();
  return createApp(db);
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function register(api: Awaited<ReturnType<typeof app>>, email: string, householdName = "North") {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: "Owner", householdName, currency: "USD" }),
  }));
  expect(registered.status).toBe(200);
  const token = registered.body.token as string;
  const homes = await json(await api.request("/api/households", { headers: auth(token) }));
  const hid = homes.body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
  return { token, hid, spaceId: dash.body.spaceId as string, userId: registered.body.user.id as string, buckets: dash.body.buckets as { id: string; name: string }[], planRevision: dash.body.household.planRevision as number };
}

function enableOidc() {
  process.env.OIDC_TEST_MODE = "1";
  process.env.OIDC_ISSUER = "http://127.0.0.1/oidc-test";
  process.env.OIDC_CLIENT_ID = "budgetcents-test";
  process.env.OIDC_CLIENT_SECRET = "test-secret";
  process.env.OIDC_REDIRECT_URI = "http://127.0.0.1/api/auth/oidc/callback";
}

async function oidcCallback(api: Awaited<ReturnType<typeof app>>, email: string, next = "/", verified = true) {
  const start = await json(await api.request(`/api/auth/oidc/start?next=${encodeURIComponent(next)}`));
  expect(start.status).toBe(200);
  const authorization = new URL(start.body.authorizationUrl as string);
  authorization.searchParams.set("login_hint", email);
  if (!verified) authorization.searchParams.set("email_verified", "0");
  const redirected = await api.request(`${authorization.pathname}?${authorization.searchParams.toString()}`);
  expect(redirected.status).toBe(302);
  const location = new URL(redirected.headers.get("location") ?? "");
  return json(await api.request(`${location.pathname}?${location.searchParams.toString()}`));
}

describe("sandbox transaction sync", () => {
  it("imports fixture history, settles pending lines, and ignores duplicate activity", async () => {
    process.env.SANDBOX_WEBHOOK_SECRET = "sandbox-secret";
    const api = await app();
    const owner = await register(api, "sandbox@example.com");
    const connected = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/connect`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ provider: "sandbox-bank", spaceId: owner.spaceId }),
    }));
    expect(connected.body.transactionsImported).toBe(2);
    const pending = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND payee = 'Sandbox Market' AND bank_status = 'pending' AND deleted = 0`, [owner.hid]);
    expect(Number(pending[0].n)).toBe(1);
    const synced = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/sync`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ spaceId: owner.spaceId }),
    }));
    expect(synced.body.imported).toBe(1);
    expect(synced.body.settled).toBe(1);
    const market = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND payee = 'Sandbox Market' AND deleted = 0`, [owner.hid]);
    expect(Number(market[0].n)).toBe(1);
    const posted = await db.query(`SELECT bank_status FROM transactions WHERE household_id = $1 AND payee = 'Sandbox Market'`, [owner.hid]);
    expect(posted[0].bank_status).toBe("posted");
    const again = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/sync`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ spaceId: owner.spaceId }),
    }));
    expect(again.body.imported).toBe(0);
    expect(again.body.settled).toBe(0);
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND deleted = 0`, [owner.hid]);
    const activity = JSON.stringify({
      householdId: owner.hid, spaceId: owner.spaceId,
      activity: { externalId: "sbx-fuel", postedOn: "2026-11-05", payee: "Sandbox Fuel", amountMinor: -4100, bankStatus: "posted" },
    });
    const signature = createHmac("sha256", "sandbox-secret").update(activity).digest("hex");
    const duplicate = await json(await api.request("/api/providers/sandbox/activity", {
      method: "POST", headers: { "content-type": "application/json", "x-budgetcents-signature": signature }, body: activity,
    }));
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.imported).toBe(0);
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND deleted = 0`, [owner.hid]);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    const revoked = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/revoke`, { method: "POST", headers: auth(owner.token) }));
    expect(revoked.body.status).toBe("revoked");
    const blocked = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/sync`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ spaceId: owner.spaceId }),
    }));
    expect(blocked.status).toBe(409);
    const reconnected = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/reconnect`, { method: "POST", headers: auth(owner.token) }));
    expect(reconnected.body.status).toBe("sandbox");
    const fresh = JSON.stringify({
      householdId: owner.hid, spaceId: owner.spaceId,
      activity: { externalId: "sbx-cafe", postedOn: "2026-11-06", payee: "Sandbox Cafe", amountMinor: -450, bankStatus: "posted" },
    });
    const freshSignature = createHmac("sha256", "sandbox-secret").update(fresh).digest("hex");
    const imported = await json(await api.request("/api/providers/sandbox/activity", {
      method: "POST", headers: { "content-type": "application/json", "x-budgetcents-signature": freshSignature }, body: fresh,
    }));
    expect(imported.body.imported).toBe(1);
    const repeated = await json(await api.request("/api/providers/sandbox/activity", {
      method: "POST", headers: { "content-type": "application/json", "x-budgetcents-signature": freshSignature }, body: fresh,
    }));
    expect(repeated.body.duplicate).toBe(true);
    const cafe = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND payee = 'Sandbox Cafe' AND deleted = 0`, [owner.hid]);
    expect(Number(cafe[0].n)).toBe(1);
  });
});

describe("federated sign-in", () => {
  it("creates an account from the local test provider without a household or an invitation", async () => {
    enableOidc();
    const api = await app();
    const owner = await register(api, "owner@example.com");
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), owner.userId]);
    const invited = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ email: "new-person@example.com", role: "editor" }),
    }));
    expect(invited.status).toBe(201);
    const done = await oidcCallback(api, "new-person@example.com", `/invite/${invited.body.token}`);
    expect(done.status).toBe(200);
    expect(done.body.token).toBeTruthy();
    expect(done.body.invitationAccepted).toBe(false);
    expect(done.body.created).toBe(true);
    expect(done.body.returnPath).toBe(`/invite/${invited.body.token}`);
    const memberships = await db.query(`SELECT count(*) AS n FROM memberships WHERE user_id = $1`, [done.body.userId]);
    expect(Number(memberships[0].n)).toBe(0);
    const pending = await db.query(`SELECT accepted_at FROM invitations WHERE household_id = $1`, [owner.hid]);
    expect(pending[0].accepted_at).toBeNull();
    const homes = await json(await api.request("/api/households", { headers: auth(done.body.token) }));
    expect(homes.body.households).toEqual([]);
    const reused = await oidcCallback(api, "new-person@example.com", "/");
    expect(reused.body.created).toBe(false);
    expect(reused.body.invitationAccepted).toBe(false);
  });

  it("links an existing password account and still requires an authentication code", async () => {
    enableOidc();
    const api = await app();
    const existing = await register(api, "linked@example.com");
    const unverified = await oidcCallback(api, "fresh@example.com", "/", false);
    expect(unverified.status).toBe(400);
    const freshUsers = await db.query(`SELECT count(*) AS n FROM users WHERE email = 'fresh@example.com'`);
    expect(Number(freshUsers[0].n)).toBe(0);
    const link = await oidcCallback(api, "linked@example.com", "/invite/not-accepted");
    expect(link.body.status).toBe("link-required");
    expect(link.body.token).toBeUndefined();
    const linked = await json(await api.request("/api/auth/oidc/link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingToken: link.body.pendingToken, password: "correct-horse" }),
    }));
    expect(linked.status).toBe(200);
    expect(linked.body.invitationAccepted).toBe(false);
    expect(linked.body.token).toBeTruthy();
    const secret = "JBSWY3DPEHPK3PXP";
    await db.query(`UPDATE users SET mfa_enabled = 1, mfa_secret = $1 WHERE id = $2`, [secret, existing.userId]);
    const mfa = await oidcCallback(api, "linked@example.com");
    expect(mfa.body.mfaRequired).toBe(true);
    expect(mfa.body.token).toBeUndefined();
    const session = await json(await api.request("/api/auth/oidc/mfa", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingToken: mfa.body.pendingToken, code: totp(secret) }),
    }));
    expect(session.status).toBe(200);
    expect(session.body.token).toBeTruthy();
    expect(session.body.invitationAccepted).toBe(false);
  });
});

describe("assistant, learning, and test delivery", () => {
  it("confirms category, tag, and plan changes and can undo them", async () => {
    const api = await app();
    const owner = await register(api, "actions@example.com");
    const groceries = owner.buckets.find((bucket) => bucket.name === "Groceries");
    expect(groceries).toBeTruthy();
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const txn = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ date: "2026-11-06", accountId: account.body.id, amountMinor: -500, type: "expense", payee: "Market", bankStatus: "posted", splits: [] }),
    }));
    const before = await json(await api.request(`/api/households/${owner.hid}/dashboard?evaluate=0`, { headers: auth(owner.token) }));
    const preview = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/preview`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ kind: "set_category", payload: { transactionId: txn.body.id, version: 1, bucketId: groceries!.id } }),
    }));
    expect(preview.body.status).toBe("preview");
    const still = await db.query(`SELECT count(*) AS n FROM splits WHERE transaction_id = $1`, [txn.body.id]);
    expect(Number(still[0].n)).toBe(0);
    const confirmed = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${preview.body.id}/confirm`, { method: "POST", headers: auth(owner.token) }));
    expect(confirmed.status).toBe(200);
    expect((await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${preview.body.id}/undo`, { method: "POST", headers: auth(owner.token) }))).status).toBe(200);
    const version = await db.query(`SELECT version FROM transactions WHERE id = $1`, [txn.body.id]);
    const tagged = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/preview`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ kind: "set_tags", payload: { transactionId: txn.body.id, version: Number(version[0].version), tags: ["food"] } }),
    }));
    expect((await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${tagged.body.id}/confirm`, { method: "POST", headers: auth(owner.token) }))).status).toBe(200);
    const planned = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/preview`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ kind: "adjust_plan", payload: { spaceId: owner.spaceId, bucketId: groceries!.id, periodKey: "2026-11", amountMinor: 2000, planRevision: before.body.household.planRevision } }),
    }));
    const savedPlan = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${planned.body.id}/confirm`, { method: "POST", headers: auth(owner.token) }));
    expect(savedPlan.status).toBe(200);
    const mid = await json(await api.request(`/api/households/${owner.hid}/dashboard?evaluate=0`, { headers: auth(owner.token) }));
    expect(mid.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor - 2000);
    await db.query(`UPDATE memberships SET role = 'readonly' WHERE user_id = $1`, [owner.userId]);
    const denied = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${preview.body.id}/undo`, { method: "POST", headers: auth(owner.token) }));
    expect(denied.status).toBe(403);
    await db.query(`UPDATE memberships SET role = 'owner' WHERE user_id = $1`, [owner.userId]);
    expect((await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${planned.body.id}/undo`, { method: "POST", headers: auth(owner.token) }))).status).toBe(200);
    expect((await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${tagged.body.id}/undo`, { method: "POST", headers: auth(owner.token) }))).status).toBe(200);
    const restored = await json(await api.request(`/api/households/${owner.hid}/dashboard?evaluate=0`, { headers: auth(owner.token) }));
    expect(restored.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor);
    const tags = await db.query(`SELECT count(*) AS n FROM transaction_tags WHERE transaction_id = $1`, [txn.body.id]);
    expect(Number(tags[0].n)).toBe(0);
  });

  it("saves practice and tour progress without posting, and stores a support file", async () => {
    const api = await app();
    const owner = await register(api, "learn@example.com");
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [owner.hid]);
    const wrong = await json(await api.request("/api/learn/practice", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ itemId: "give-dollars-a-job", answerMinor: 1 }) }));
    expect(wrong.body.correct).toBe(false);
    const right = await json(await api.request("/api/learn/practice", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ itemId: "give-dollars-a-job", answerMinor: 1500 }) }));
    expect(right.body.correct).toBe(true);
    const tour = await json(await api.request("/api/learn/tours", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ itemId: "plan-tour", step: 2 }) }));
    expect(tour.body.step).toBe(2);
    const learn = await json(await api.request("/api/learn", { headers: auth(owner.token) }));
    expect(learn.body.progress.length).toBe(2);
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [owner.hid]);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    const ticket = await json(await api.request("/api/support", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ subject: "A question", body: "The plan looks odd." }) }));
    const html = await json(await api.request(`/api/support/${ticket.body.id}/attachments`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ filename: "note.txt", contentType: "text/plain", dataBase64: Buffer.from("<html><script>no</script></html>").toString("base64") }),
    }));
    expect(html.status).toBe(400);
    const file = await json(await api.request(`/api/support/${ticket.body.id}/attachments`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ filename: "note.txt", contentType: "text/plain", dataBase64: Buffer.from("A screenshot description").toString("base64") }),
    }));
    expect(file.status).toBe(201);
    const closed = await json(await api.request(`/api/support/${ticket.body.id}/status`, { method: "POST", headers: auth(owner.token), body: JSON.stringify({ status: "closed" }) }));
    expect(closed.body.status).toBe("closed");
    const detail = await json(await api.request(`/api/support/${ticket.body.id}`, { headers: auth(owner.token) }));
    expect(detail.body.attachments).toHaveLength(1);
    expect(detail.body.note).toMatch(/not a reply/);
  });

  it("enrolls a channel and records test-sink status without calling it delivered", async () => {
    const api = await app();
    const owner = await register(api, "delivery@example.com");
    const missing = await json(await api.request("/api/notifications/test", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "email" }) }));
    expect(missing.body.status).toBe("refused");
    expect(missing.body.provenDelivered).toBe(false);
    const enrolled = await json(await api.request("/api/messages/enrollment", {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "email", destinationLabel: "inbox", consent: true }),
    }));
    expect(enrolled.body.delivered).toBe(false);
    const accepted = await json(await api.request("/api/notifications/test", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "email", outcome: "accepted" }) }));
    expect(accepted.body.status).toBe("accepted");
    expect(accepted.body.provenDelivered).toBe(false);
    expect(accepted.body.note).toMatch(/not proof/);
    const rejected = await json(await api.request("/api/notifications/test", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "email", outcome: "rejected" }) }));
    expect(rejected.body.status).toBe("failed");
    const retried = await json(await api.request(`/api/notifications/test/${rejected.body.id}/retry`, { method: "POST", headers: auth(owner.token) }));
    expect(retried.body.status).toBe("accepted");
    expect(retried.body.provenDelivered).toBe(false);
    await json(await api.request("/api/messages/opt-out", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "email" }) }));
    const opted = await json(await api.request("/api/notifications/test", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "email" }) }));
    expect(opted.body.status).toBe("refused");
    await json(await api.request("/api/messages/enrollment", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "sms", destinationLabel: "test handset", consent: true }) }));
    await db.query(`UPDATE users SET alert_settings = $1 WHERE id = $2`, [JSON.stringify({ quietHours: { enabled: true, start: "00:00", end: "23:59" }, timezone: "America/Chicago" }), owner.userId]);
    const quiet = await json(await api.request("/api/notifications/test", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "sms" }) }));
    expect(quiet.body.status).toBe("queued");
    expect(quiet.body.provenDelivered).toBe(false);
    const device = await json(await api.request("/api/devices", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ name: "Phone", platform: "android" }) }));
    await json(await api.request(`/api/devices/${device.body.id}/push-token`, { method: "POST", headers: auth(owner.token), body: JSON.stringify({ token: "test-token" }) }));
    await json(await api.request("/api/messages/enrollment", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "push", destinationLabel: "phone", consent: true }) }));
    await db.query(`UPDATE users SET alert_settings = '{}' WHERE id = $1`, [owner.userId]);
    const push = await json(await api.request("/api/notifications/test", { method: "POST", headers: auth(owner.token), body: JSON.stringify({ channel: "push" }) }));
    expect(push.body.status).toBe("accepted");
    expect(push.body.provenDelivered).toBe(false);
  });

  it("previews a rule without writing a transaction", async () => {
    const api = await app();
    const owner = await register(api, "rules@example.com");
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [owner.hid]);
    await json(await api.request(`/api/households/${owner.hid}/rules`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ name: "Review groceries", matchMode: "all", conditions: [{ field: "payee", op: "contains", value: "market" }], actions: [{ type: "set_reviewer" }] }),
    }));
    const preview = await json(await api.request(`/api/households/${owner.hid}/rules/suggest`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ payee: "Sandbox Market", amountMinor: -2540 }),
    }));
    expect(preview.body.missing).toEqual(["category"]);
    expect(preview.body.note).toMatch(/did not save/);
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [owner.hid]);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });
});
