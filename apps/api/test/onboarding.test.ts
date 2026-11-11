import { afterEach, describe, expect, it } from "vitest";
import { totp } from "../src/crypto.js";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
const previousEnv = { NODE_ENV: process.env.NODE_ENV, ALLOW_DEV_MAILSINK: process.env.ALLOW_DEV_MAILSINK };

afterEach(async () => {
  process.env.NODE_ENV = previousEnv.NODE_ENV;
  if (previousEnv.ALLOW_DEV_MAILSINK == null) delete process.env.ALLOW_DEV_MAILSINK;
  else process.env.ALLOW_DEV_MAILSINK = previousEnv.ALLOW_DEV_MAILSINK;
  await db?.close();
});

async function app() {
  db = await openMemoryDatabase();
  return createApp(db);
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : null };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function register(api: Awaited<ReturnType<typeof app>>, email: string) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: email, householdName: "Start household" }),
  }));
  expect(registered.status).toBe(200);
  expect(registered.body).not.toHaveProperty("devVerificationToken");
  const token = String(registered.body?.token);
  const hid = String((await json(await api.request("/api/households", { headers: auth(token) }))).body?.households?.[0]?.id);
  return { token, hid, email };
}

async function mailbox(api: Awaited<ReturnType<typeof app>>, email: string, token?: string) {
  const headers = token ? auth(token) : undefined;
  return json(await api.request(`/api/dev/outbox?email=${encodeURIComponent(email)}`, { headers }));
}

function tokenFrom(body: string) {
  const match = body.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("The message had no token.");
  return match[1];
}

describe("resumable setup and account security", () => {
  it("keeps setup progress, refuses duplicate resources, and leaves expected income outside cash", async () => {
    const api = await app();
    const home = await register(api, "setup@example.com");
    const other = await register(api, "other-setup@example.com");
    const hidden = await json(await api.request(`/api/households/${home.hid}/onboarding`, { headers: auth(other.token) }));
    expect(hidden.status).toBe(404);

    const first = await json(await api.request(`/api/households/${home.hid}/onboarding`, { headers: auth(home.token) }));
    expect(first.body?.step).toBe("who");
    expect(first.body?.emailVerified).toBe(false);
    const spoofed = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ version: first.body?.version, complete: "verify" }),
    }));
    expect(spoofed.status).toBe(400);
    expect(spoofed.body?.error).toMatch(/verification link/i);

    const who = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({
        version: first.body?.version,
        who: { kind: "mixed" },
        step: "preferences",
        draft: { password: "correct-horse", secret: "nope", householdName: "Start household" },
      }),
    }));
    expect(who.status).toBe(200);
    expect(who.body?.draft).toEqual({ who: { kind: "mixed" }, householdName: "Start household" });
    expect(JSON.stringify(who.body?.draft)).not.toMatch(/correct-horse/);

    const before = await db.query(`SELECT count(*)::int AS n, coalesce(sum(amount_minor), 0) AS total FROM transactions WHERE household_id = $1`, [home.hid]);
    const preferences = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({
        version: who.body?.version,
        preferences: {
          householdName: "North household",
          currency: "USD",
          locale: "en-US",
          timeZone: "America/Chicago",
          weekStart: 1,
          approach: "zero",
        },
        step: "accounts",
      }),
    }));
    expect(preferences.status).toBe(200);
    const after = await db.query(`SELECT count(*)::int AS n, coalesce(sum(amount_minor), 0) AS total FROM transactions WHERE household_id = $1`, [home.hid]);
    expect(after).toEqual(before);
    const spaces = await db.query(`SELECT name FROM spaces WHERE household_id = $1 AND kind = 'business'`, [home.hid]);
    expect(spaces).toHaveLength(1);
    const again = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({
        version: preferences.body?.version,
        preferences: {
          householdName: "North household",
          currency: "USD",
          locale: "en-US",
          timeZone: "America/Chicago",
          weekStart: 1,
          approach: "zero",
        },
      }),
    }));
    expect(again.status).toBe(200);
    expect(await db.query(`SELECT id FROM spaces WHERE household_id = $1 AND kind = 'business'`, [home.hid])).toHaveLength(1);

    const stale = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ version: preferences.body?.version, step: "accounts" }),
    }));
    expect(stale.status).toBe(409);

    const spaceId = String(again.body?.spaceId);
    const accountBody = {
      version: again.body?.version,
      kind: "account",
      setupKey: "checking-1",
      payload: { spaceId, name: "Checking", kind: "checking", openingBalanceMinor: 100_000, openingDate: "2026-11-01" },
    };
    const [created, retried] = await Promise.all([
      json(await api.request(`/api/households/${home.hid}/onboarding/resources`, { method: "POST", headers: auth(home.token), body: JSON.stringify(accountBody) })),
      json(await api.request(`/api/households/${home.hid}/onboarding/resources`, { method: "POST", headers: auth(home.token), body: JSON.stringify(accountBody) })),
    ]);
    expect([created.status, retried.status].sort()).toEqual([200, 201]);
    expect(created.body?.id).toBe(retried.body?.id);
    const accounts = await db.query(`SELECT id FROM accounts WHERE household_id = $1 AND name = 'Checking'`, [home.hid]);
    expect(accounts).toHaveLength(1);

    const failed = await json(await api.request(`/api/households/${home.hid}/onboarding/resources`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ version: created.body?.version ?? retried.body?.version, kind: "category", setupKey: "bad-category", payload: { spaceId, name: "" } }),
    }));
    expect(failed.status).toBe(400);
    const still = await json(await api.request(`/api/households/${home.hid}/onboarding`, { headers: auth(home.token) }));
    expect(still.body?.step).toBe("accounts");
    expect(await db.query(`SELECT id FROM buckets WHERE household_id = $1 AND name = ''`, [home.hid])).toHaveLength(0);

    const version = Number(still.body?.version);
    const income = await json(await api.request(`/api/households/${home.hid}/onboarding/resources`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        version,
        kind: "income",
        setupKey: "salary-1",
        payload: { spaceId, name: "Salary", kind: "salary", accountId: created.body?.id, amountMinor: 250_000, cadence: "monthly", startDate: "2026-11-15" },
      }),
    }));
    expect(income.status).toBe(201);
    const replay = await json(await api.request(`/api/households/${home.hid}/onboarding/resources`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        version,
        kind: "income",
        setupKey: "salary-1",
        payload: { spaceId, name: "Salary", kind: "salary", accountId: created.body?.id, amountMinor: 250_000, cadence: "monthly", startDate: "2026-11-15" },
      }),
    }));
    expect(replay.status).toBe(200);
    expect(replay.body?.duplicate).toBe(true);
    expect(await db.query(`SELECT id FROM income_sources WHERE household_id = $1`, [home.hid])).toHaveLength(1);

    const review = await json(await api.request(`/api/households/${home.hid}/onboarding`, { headers: auth(home.token) }));
    const balances = review.body?.review as { actualBalances: { name: string; balanceMinor: number }[]; expectedIncome: { amountMinor: number; note: string }[]; allocations: { readyToAssignMinor: number } };
    expect(balances.actualBalances.find((row) => row.name === "Checking")?.balanceMinor).toBe(100_000);
    expect(balances.expectedIncome[0].amountMinor).toBe(250_000);
    expect(balances.expectedIncome[0].note).toMatch(/not cash/i);
    expect(balances.allocations.readyToAssignMinor).toBe(100_000);
    const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(dash.body?.budget.readyToAssignMinor).toBe(100_000);
    expect(dash.body?.netWorth.netMinor).toBe(100_000);
    expect(dash.body?.budget.incomeMinor).toBe(0);

    const reloaded = await json(await api.request(`/api/households/${home.hid}/onboarding`, { headers: auth(home.token) }));
    expect(reloaded.body?.step).toBe("accounts");
    const finishedEarly = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ version: 1, finish: true }),
    }));
    expect(finishedEarly.status).toBe(409);
    const finished = await json(await api.request(`/api/households/${home.hid}/onboarding`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ version: reloaded.body?.version, finish: true }),
    }));
    expect(finished.status).toBe(200);
    expect(finished.body?.finished).toBe(true);
    expect((finished.body?.review as { notFinished: string[] }).notFinished).toContain("Email not verified");

    const cleared = await json(await api.request("/api/me", {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ onboardingStep: null }),
    }));
    expect(cleared.body?.user.onboardingStep).toBeNull();
    const kept = await json(await api.request("/api/me", {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ displayName: "Setup person" }),
    }));
    expect(kept.body?.user.onboardingStep).toBeNull();
    expect(kept.body?.user.displayName).toBe("Setup person");
  });

  it("verifies and resets through the development outbox without returning tokens", async () => {
    const api = await app();
    process.env.ALLOW_DEV_MAILSINK = "true";
    const home = await register(api, "mail@example.com");
    const mail = await mailbox(api, home.email);
    expect(mail.status).toBe(200);
    const verifyToken = tokenFrom(String((mail.body?.messages as { body: string }[])[0].body));
    expect(String((mail.body?.messages as { body: string }[])[0].body)).toMatch(/\/verify\?token=/);
    expect(String((mail.body?.messages as { body: string }[])[0].body)).toMatch(/budgetcents:\/\/verify\?token=/);
    const stranger = await mailbox(api, home.email, (await register(api, "reader@example.com")).token);
    expect(stranger.status).toBe(404);

    const missing = await json(await api.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-token" }),
    }));
    expect(missing.body?.error).toMatch(/invalid/i);
    await db.query(`UPDATE email_tokens SET expires_at = $1 WHERE purpose = 'verify' AND user_id = (SELECT id FROM users WHERE email = $2)`, ["2000-01-01T00:00:00.000Z", home.email]);
    const expired = await json(await api.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: verifyToken }),
    }));
    expect(expired.body?.error).toMatch(/expired/i);
    const resent = await json(await api.request("/api/auth/verify-email/resend", { method: "POST", headers: auth(home.token) }));
    expect(resent.status).toBe(200);
    const freshMail = await mailbox(api, home.email, home.token);
    const freshToken = tokenFrom(String((freshMail.body?.messages as { body: string }[])[0].body));
    const verified = await json(await api.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: freshToken }),
    }));
    expect(verified.status).toBe(200);
    expect(verified.body?.onboardingStep).toBe("who");
    const used = await json(await api.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: freshToken }),
    }));
    expect(used.body?.error).toMatch(/already used/i);

    const unknown = await json(await api.request("/api/auth/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }));
    const known = await json(await api.request("/api/auth/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email }),
    }));
    expect(unknown.body).toEqual(known.body);
    expect(known.body).not.toHaveProperty("devResetToken");
    const resetMail = await mailbox(api, home.email);
    const resetToken = tokenFrom(String((resetMail.body?.messages as { body: string; subject: string }[]).find((item) => item.subject.includes("Reset"))?.body));
    const setup = await json(await api.request("/api/auth/mfa/setup", {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ password: "correct-horse" }),
    }));
    expect(setup.body).not.toHaveProperty("sample");
    const code = totp(String(setup.body?.secret));
    const enabled = await json(await api.request("/api/auth/mfa/enable", {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ password: "correct-horse", code }),
    }));
    expect(enabled.status).toBe(200);
    const recovery = String((enabled.body?.recoveryCodes as string[])[0]);
    const stolen = await json(await api.request("/api/auth/mfa/setup", { method: "POST", headers: auth(home.token), body: JSON.stringify({}) }));
    expect(stolen.status).toBe(400);

    const resetBody = { token: resetToken, password: "correct-horse-2" };
    const [firstReset, secondReset] = await Promise.all([
      json(await api.request("/api/auth/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(resetBody) })),
      json(await api.request("/api/auth/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(resetBody) })),
    ]);
    expect([firstReset.status, secondReset.status].sort()).toEqual([200, 400]);
    expect([firstReset.body?.error, secondReset.body?.error].join(" ")).toMatch(/already used/i);
    const oldSession = await json(await api.request("/api/me", { headers: auth(home.token) }));
    expect(oldSession.status).toBe(401);
    const oldPassword = await json(await api.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email, password: "correct-horse", code }),
    }));
    expect(oldPassword.status).toBe(401);
    const needsCode = await json(await api.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email, password: "correct-horse-2" }),
    }));
    expect(needsCode.body?.mfaRequired).toBe(true);
    expect(needsCode.body).not.toHaveProperty("token");
    const signedIn = await json(await api.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email, password: "correct-horse-2", code: totp(String(setup.body?.secret)) }),
    }));
    expect(signedIn.status).toBe(200);
    expect(signedIn.body?.user.onboardingStep).toBe("who");
    const consumed = await json(await api.request("/api/auth/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resetBody),
    }));
    expect(consumed.body?.error).toMatch(/already used/i);

    const withRecovery = await json(await api.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email, password: "correct-horse-2", code: recovery }),
    }));
    const reused = await json(await api.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email, password: "correct-horse-2", code: recovery }),
    }));
    expect(withRecovery.status).toBe(200);
    expect(reused.status).toBe(401);
    const secondCode = String((enabled.body?.recoveryCodes as string[])[1]);
    const [raceA, raceB] = await Promise.all([
      json(await api.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: home.email, password: "correct-horse-2", code: secondCode }),
      })),
      json(await api.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: home.email, password: "correct-horse-2", code: secondCode }),
      })),
    ]);
    expect([raceA.status, raceB.status].sort()).toEqual([200, 401]);

    const currentToken = String(signedIn.body?.token);
    const second = await json(await api.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Other device" },
      body: JSON.stringify({ email: home.email, password: "correct-horse-2", code: totp(String(setup.body?.secret)) }),
    }));
    const sessions = await json(await api.request("/api/auth/sessions", { headers: auth(currentToken) }));
    const active = (sessions.body?.sessions as { id: string; current: boolean; revoked_at: string | null }[]).filter((item) => !item.revoked_at);
    const otherSession = active.find((item) => !item.current);
    expect(otherSession).toBeTruthy();
    const revoked = await json(await api.request(`/api/auth/sessions/${otherSession?.id}`, { method: "DELETE", headers: auth(currentToken) }));
    expect(revoked.body?.current).toBe(false);
    const dead = await json(await api.request("/api/me", { headers: auth(String(second.body?.token)) }));
    expect(dead.status).toBe(401);
    const self = active.find((item) => item.current);
    const signedOut = await json(await api.request(`/api/auth/sessions/${self?.id}`, { method: "DELETE", headers: auth(currentToken) }));
    expect(signedOut.body?.current).toBe(true);
    expect((await json(await api.request("/api/me", { headers: auth(currentToken) }))).status).toBe(401);

    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_MAILSINK = "true";
    const closed = await mailbox(api, home.email);
    expect(closed.status).toBe(404);
    const productionForgot = await json(await api.request("/api/auth/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: home.email }),
    }));
    expect(productionForgot.body).not.toHaveProperty("devResetToken");
    expect(productionForgot.body?.message).toMatch(/If that email has an account/);
  });

  it("deletes a sole owner, blocks a shared owner, and retires old links", async () => {
    const api = await app();
    const owner = await register(api, "owner-delete@example.com");
    const member = await register(api, "member-delete@example.com");
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE email = $2`, [new Date().toISOString(), owner.email]);
    const invite = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ email: member.email, role: "editor" }),
    }));
    expect(invite.status).toBe(201);
    await api.request(`/api/invitations/${invite.body?.token}/accept`, { method: "POST", headers: auth(member.token) });
    const blocked = await json(await api.request("/api/me", {
      method: "DELETE",
      headers: auth(owner.token),
      body: JSON.stringify({ password: "correct-horse", confirm: "DELETE" }),
    }));
    expect(blocked.status).toBe(409);
    const memberGone = await json(await api.request("/api/me", {
      method: "DELETE",
      headers: auth(member.token),
      body: JSON.stringify({ password: "correct-horse", confirm: "DELETE" }),
    }));
    expect(memberGone.status).toBe(200);
    const stillThere = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(stillThere.status).toBe(200);
    expect((await json(await api.request("/api/me", { headers: auth(member.token) }))).status).toBe(401);

    await json(await api.request("/api/auth/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: owner.email }),
    }));
    const mail = await mailbox(api, owner.email);
    const resetToken = tokenFrom(String((mail.body?.messages as { body: string; subject: string }[]).find((item) => item.subject.includes("Reset"))?.body));
    const removed = await json(await api.request("/api/me", {
      method: "DELETE",
      headers: auth(owner.token),
      body: JSON.stringify({ password: "wrong-password", confirm: "DELETE" }),
    }));
    expect(removed.status).toBe(401);
    const deleted = await json(await api.request("/api/me", {
      method: "DELETE",
      headers: auth(owner.token),
      body: JSON.stringify({ password: "correct-horse", confirm: "DELETE" }),
    }));
    expect(deleted.status).toBe(200);
    expect(await db.query(`SELECT id FROM households WHERE id = $1`, [owner.hid])).toHaveLength(0);
    expect((await json(await api.request("/api/me", { headers: auth(owner.token) }))).status).toBe(401);
    const retired = await json(await api.request("/api/auth/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resetToken, password: "correct-horse-2" }),
    }));
    expect(retired.status).toBe(400);
  });
});
