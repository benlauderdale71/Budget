import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
const previousLimit = process.env.BUDGETCENTS_MEMBER_LIMIT;

afterEach(async () => {
  if (previousLimit == null) delete process.env.BUDGETCENTS_MEMBER_LIMIT;
  else process.env.BUDGETCENTS_MEMBER_LIMIT = previousLimit;
  await db?.close();
});

async function app() {
  db = await openMemoryDatabase();
  return createApp(db);
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function register(api: Awaited<ReturnType<typeof app>>, email: string, householdName?: string) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: email.split("@")[0], householdName, currency: "USD" }),
  }));
  expect(registered.status).toBe(200);
  const token = registered.body.token as string;
  const homes = await json(await api.request("/api/households", { headers: auth(token) }));
  const hid = homes.body.households[0]?.id as string | undefined;
  let spaceId = "";
  if (hid) {
    const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
    spaceId = dash.body.spaceId as string;
  }
  return { token, hid, spaceId, email, userId: registered.body.user.id as string };
}

async function verify(email: string) {
  await db.query(`UPDATE users SET email_verified_at = $1 WHERE email = $2`, [new Date().toISOString(), email.toLowerCase()]);
}

async function invite(api: Awaited<ReturnType<typeof app>>, ownerToken: string, hid: string, email: string, role: string) {
  return json(await api.request(`/api/households/${hid}/invitations`, {
    method: "POST",
    headers: auth(ownerToken),
    body: JSON.stringify({ email, role }),
  }));
}

describe("invitation acceptance and access", () => {
  it("shows a disclosure without money, then accepts only a verified matching account", async () => {
    const api = await app();
    const owner = await register(api, "owner@example.com", "North");
    await verify(owner.email);
    await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Joint", kind: "checking", openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    });
    const created = await invite(api, owner.token, owner.hid!, "coach@example.com", "coach");
    expect(created.status).toBe(201);
    expect(created.body.delivery).toBe("link");
    expect(created.body.note).toMatch(/not email delivery/);
    expect(JSON.stringify(created.body)).not.toMatch(/10000|Joint/);
    const logs: string[] = [];
    const original = console.info;
    console.info = (message?: unknown) => { logs.push(String(message)); };
    const preview = await json(await api.request(`/api/invitations/${created.body.token}`));
    console.info = original;
    expect(logs.join(" ")).not.toContain(created.body.token);
    expect(logs.join(" ")).toContain("/api/invitations/:token");
    expect(preview.status).toBe(200);
    expect(preview.body.status).toBe("pending");
    expect(preview.body.householdName).toBe("North");
    expect(preview.body.role).toBe("coach");
    expect(preview.body.disclosure).toMatch(/Private accounts/);
    expect(preview.body.sharedRecords).toMatch(/shared records/i);
    expect(JSON.stringify(preview.body)).not.toMatch(/10000|balanceMinor|"members"/);
    const unknown = await json(await api.request("/api/invitations/not-a-real-token"));
    expect(unknown.body.status).toBe("unavailable");
    expect(unknown.body.householdName).toBeNull();
    const guest = await register(api, "coach@example.com");
    const early = await json(await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(guest.token) }));
    expect(early.status).toBe(403);
    expect(early.body.error).toMatch(/stays pending/);
    const still = await json(await api.request(`/api/invitations/${created.body.token}`));
    expect(still.body.status).toBe("pending");
    await verify(guest.email);
    const wrong = await register(api, "other@example.com", "Other");
    await verify(wrong.email);
    const mismatch = await json(await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(wrong.token) }));
    expect(mismatch.status).toBe(403);
    const accepted = await json(await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(guest.token) }));
    expect(accepted.status).toBe(200);
    expect(accepted.body.householdId).toBe(owner.hid);
    expect(accepted.body.role).toBe("coach");
    const again = await json(await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(guest.token) }));
    expect(again.status).toBe(200);
    expect(again.body.alreadyMember).toBe(true);
    const memberships = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`, [owner.hid, guest.userId]);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe("coach");
    const homes = await json(await api.request("/api/households", { headers: auth(guest.token) }));
    expect(homes.body.households.some((item: { id: string; role: string }) => item.id === owner.hid && item.role === "coach")).toBe(true);
  });

  it("lets someone register only to join, and does not replace an existing role", async () => {
    const api = await app();
    const owner = await register(api, "owner2@example.com", "North");
    await verify(owner.email);
    const editorInvite = await invite(api, owner.token, owner.hid!, "member@example.com", "editor");
    const joined = await register(api, "member@example.com");
    expect(joined.hid).toBeUndefined();
    await verify(joined.email);
    const accepted = await json(await api.request(`/api/invitations/${editorInvite.body.token}/accept`, { method: "POST", headers: auth(joined.token) }));
    expect(accepted.body.role).toBe("editor");
    const narrower = await invite(api, owner.token, owner.hid!, "member@example.com", "readonly");
    expect(narrower.status).toBe(409);
    const kept = await invite(api, owner.token, owner.hid!, "kept@example.com", "readonly");
    const keptUser = await register(api, "kept@example.com", "Kept");
    await verify("kept@example.com");
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'editor',$3)`, [owner.hid, keptUser.userId, new Date().toISOString()]);
    const unchanged = await json(await api.request(`/api/invitations/${kept.body.token}/accept`, { method: "POST", headers: auth(keptUser.token) }));
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.role).toBe("editor");
    expect(unchanged.body.changed).toBe(false);
    const outsider = await register(api, "already@example.com", "Own");
    await verify(outsider.email);
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)`, [owner.hid, outsider.userId, new Date().toISOString()]);
    const downgrade = await invite(api, owner.token, owner.hid!, "already@example.com", "readonly");
    expect(downgrade.status).toBe(409);
  });

  it("keeps acceptance, revocation, and a configured limit consistent", async () => {
    const api = await app();
    const owner = await register(api, "cap@example.com", "Cap");
    await verify(owner.email);
    await db.query(`UPDATE households SET member_limit = 6 WHERE id = $1`, [owner.hid]);
    for (let index = 0; index < 5; index += 1) {
      const userId = `user-${index}`;
      await db.query(`INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ($1,$2,'x',$3,$4)`, [userId, `seat${index}@example.com`, `Seat ${index}`, new Date().toISOString()]);
      await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'coach',$3)`, [owner.hid, userId, new Date().toISOString()]);
    }
    const fullInvite = await invite(api, owner.token, owner.hid!, "full@example.com", "planner");
    const fullGuest = await register(api, "full@example.com", "Full home");
    await verify(fullGuest.email);
    const blocked = await json(await api.request(`/api/invitations/${fullInvite.body.token}/accept`, { method: "POST", headers: auth(fullGuest.token) }));
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/6-person/);
    const pending = await db.query(`SELECT accepted_at FROM invitations WHERE token_hash IS NOT NULL AND email = 'full@example.com'`);
    expect(pending[0].accepted_at).toBeNull();
    await db.query(`UPDATE households SET member_limit = NULL WHERE id = $1`, [owner.hid]);
    process.env.BUDGETCENTS_MEMBER_LIMIT = "7";
    const under = await json(await api.request(`/api/invitations/${fullInvite.body.token}/accept`, { method: "POST", headers: auth(fullGuest.token) }));
    expect(under.status).toBe(200);
    const counted = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1`, [owner.hid]);
    expect(counted).toHaveLength(7);

    const ownerB = await register(api, "race-owner@example.com", "Race");
    await verify("race-owner@example.com");
    await db.query(`UPDATE households SET member_limit = 6 WHERE id = $1`, [ownerB.hid]);
    for (let index = 0; index < 4; index += 1) {
      const userId = `race-seat-${index}`;
      await db.query(`INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ($1,$2,'x',$3,$4)`, [userId, `race-seat${index}@example.com`, `Race ${index}`, new Date().toISOString()]);
      await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'planner',$3)`, [ownerB.hid, userId, new Date().toISOString()]);
    }
    const one = await invite(api, ownerB.token, ownerB.hid!, "race-a@example.com", "coach");
    const two = await invite(api, ownerB.token, ownerB.hid!, "race-b@example.com", "accountant");
    const a = await register(api, "race-a@example.com", "A");
    const b = await register(api, "race-b@example.com", "B");
    await verify("race-a@example.com");
    await verify("race-b@example.com");
    const raced = await Promise.all([
      json(await api.request(`/api/invitations/${one.body.token}/accept`, { method: "POST", headers: auth(a.token) })),
      json(await api.request(`/api/invitations/${two.body.token}/accept`, { method: "POST", headers: auth(b.token) })),
    ]);
    expect(raced.map((item) => item.status).sort()).toEqual([200, 400]);
    const raceMembers = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1`, [ownerB.hid]);
    expect(raceMembers).toHaveLength(6);

    const revokeOwner = await register(api, "revoke-owner@example.com", "Revoke");
    await verify("revoke-owner@example.com");
    const live = await invite(api, revokeOwner.token, revokeOwner.hid!, "revoke-guest@example.com", "readonly");
    const guest = await register(api, "revoke-guest@example.com", "Guest");
    await verify("revoke-guest@example.com");
    const listed = await json(await api.request(`/api/households/${revokeOwner.hid}/members`, { headers: auth(revokeOwner.token) }));
    const invitationId = listed.body.invitations[0].id as string;
    const race = await Promise.all([
      json(await api.request(`/api/invitations/${live.body.token}/accept`, { method: "POST", headers: auth(guest.token) })),
      json(await api.request(`/api/households/${revokeOwner.hid}/invitations/${invitationId}/revoke`, { method: "POST", headers: auth(revokeOwner.token) })),
    ]);
    const membership = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`, [revokeOwner.hid, guest.userId]);
    const row = await db.query(`SELECT accepted_at, revoked_at FROM invitations WHERE id = $1`, [invitationId]);
    const accepted = race.find((item) => item.status === 200 && item.body.householdId);
    const revoked = race.find((item) => item.body?.status === "revoked");
    if (membership.length) {
      expect(row[0].accepted_at).toBeTruthy();
      expect(accepted?.status).toBe(200);
    } else {
      expect(row[0].accepted_at).toBeNull();
      expect(row[0].revoked_at).toBeTruthy();
      expect(revoked?.status).toBe(200);
    }
    expect(Boolean(membership.length) && !row[0].accepted_at).toBe(false);
  });

  it("revokes, reissues, transfers, and leaves without changing the ledger", async () => {
    const api = await app();
    const owner = await register(api, "life@example.com", "Life");
    await verify(owner.email);
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Joint", kind: "checking", openingBalanceMinor: 25000, openingDate: "2026-11-01" }),
    }));
    const before = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(owner.token) }));
    const created = await invite(api, owner.token, owner.hid!, "life-guest@example.com", "editor");
    const guest = await register(api, "life-guest@example.com", "Guest");
    await verify(guest.email);
    await db.query(`UPDATE invitations SET expires_at = $1 WHERE email = $2`, ["2020-01-01T00:00:00.000Z", "life-guest@example.com"]);
    const expired = await json(await api.request(`/api/invitations/${created.body.token}`));
    expect(expired.body.status).toBe("expired");
    const expiredAccept = await json(await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(guest.token) }));
    expect(expiredAccept.status).toBe(400);
    const members = await json(await api.request(`/api/households/${owner.hid}/members`, { headers: auth(owner.token) }));
    const reissued = await json(await api.request(`/api/households/${owner.hid}/invitations/${members.body.invitations[0].id}/reissue`, { method: "POST", headers: auth(owner.token) }));
    expect(reissued.status).toBe(201);
    const oldPreview = await json(await api.request(`/api/invitations/${created.body.token}`));
    expect(oldPreview.body.status).toBe("revoked");
    const accepted = await json(await api.request(`/api/invitations/${reissued.body.token}/accept`, { method: "POST", headers: auth(guest.token) }));
    expect(accepted.status).toBe(200);
    const revokedMember = await json(await api.request(`/api/households/${owner.hid}/invitations/${reissued.body.invitationId}/revoke`, { method: "POST", headers: auth(owner.token) }));
    expect(revokedMember.status).toBe(409);
    const selfOwner = await json(await api.request(`/api/households/${owner.hid}/members/${owner.userId}`, {
      method: "PATCH", headers: auth(owner.token), body: JSON.stringify({ role: "admin" }),
    }));
    expect(selfOwner.status).toBe(403);
    const transfer = await json(await api.request(`/api/households/${owner.hid}/transfer`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ userId: guest.userId }),
    }));
    expect(transfer.status).toBe(200);
    expect(transfer.body.yourRole).toBe("admin");
    const adminPromote = await json(await api.request(`/api/households/${owner.hid}/members/${owner.userId}`, {
      method: "PATCH", headers: auth(owner.token), body: JSON.stringify({ role: "owner" }),
    }));
    expect(adminPromote.status).toBe(400);
    const left = await json(await api.request(`/api/households/${owner.hid}/leave`, { method: "POST", headers: auth(owner.token) }));
    expect(left.status).toBe(200);
    const gone = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(owner.token) }));
    expect(gone.status).toBe(404);
    const after = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(guest.token) }));
    expect(after.body.household.role).toBe("owner");
    expect(after.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor);
    expect(after.body.netWorth.netMinor).toBe(before.body.netWorth.netMinor);
    expect(after.body.budget.identityDifferenceMinor).toBe(0);
    const stillThere = await json(await api.request("/api/me", { headers: auth(owner.token) }));
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.user.email).toBe("life@example.com");
    expect(stillThere.body.households).toEqual([]);
    expect(account.body.id).toBeTruthy();
  });

  it("enforces role capabilities and hides private audit details", async () => {
    const api = await app();
    const owner = await register(api, "privacy@example.com", "Privacy");
    await verify(owner.email);
    const shared = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Joint Checking", kind: "checking", openingBalanceMinor: 8000, openingDate: "2026-11-01" }),
    }));
    const secret = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Secret Vault", kind: "cash", visibility: "private", openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const visible = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ date: "2026-11-02", accountId: shared.body.id, amountMinor: -250, type: "expense", payee: "Market", bankStatus: "posted", splits: [] }),
    }));
    const hidden = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ date: "2026-11-02", accountId: secret.body.id, amountMinor: -900, type: "expense", payee: "Hidden Payee", notes: "private note", bankStatus: "posted", splits: [] }),
    }));
    const hiddenRow = await db.query(`SELECT version FROM transactions WHERE id = $1`, [hidden.body.id]);
    await api.request(`/api/households/${owner.hid}/transactions/${hidden.body.id}`, {
      method: "PATCH", headers: auth(owner.token),
      body: JSON.stringify({ version: Number(hiddenRow[0].version), payee: "Hidden Payee", reason: "because secret drawer" }),
    });
    const holding = await json(await api.request(`/api/households/${owner.hid}/holdings`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ accountId: secret.body.id, symbol: "SECRET", name: "Hidden Fund", assetClass: "stock", quantity: "1", currency: "USD", priceMinor: 100 }),
    }));
    expect(holding.status).toBe(201);
    const before = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(owner.token) }));
    for (const role of ["coach", "planner", "accountant", "readonly"] as const) {
      const email = `${role}@example.com`;
      const created = await invite(api, owner.token, owner.hid!, email, role);
      const guest = await register(api, email, `${role} home`);
      await verify(email);
      const accepted = await json(await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(guest.token) }));
      expect(accepted.status).toBe(200);
      const dash = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(guest.token) }));
      expect(dash.body.accounts.map((account: { name: string }) => account.name)).toContain("Joint Checking");
      expect(dash.body.accounts.map((account: { name: string }) => account.name)).not.toContain("Secret Vault");
      expect(dash.body.netWorth.netMinor).toBe(7750);
      const denied = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ date: "2026-11-03", accountId: shared.body.id, amountMinor: -100, type: "expense", payee: "Nope", bankStatus: "posted", splits: [] }),
      }));
      expect(denied.status).toBe(403);
      const plan = await json(await api.request(`/api/households/${owner.hid}/assignments`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ spaceId: owner.spaceId, bucketId: "missing", periodKey: "2026-11", amountMinor: 100 }),
      }));
      expect(plan.status).toBe(403);
      const sync = await json(await api.request(`/api/households/${owner.hid}/sync`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ ops: [{ opId: `${role}-op`, transaction: { date: "2026-11-03", accountId: shared.body.id, amountMinor: -100, type: "expense", payee: "Queued", bankStatus: "posted", splits: [] } }] }),
      }));
      expect(sync.status).toBe(403);
      const direct = await api.request(`/api/households/${owner.hid}/accounts/${secret.body.id}`, { method: "PATCH", headers: auth(guest.token), body: JSON.stringify({ name: "Stolen" }) });
      expect([403, 404]).toContain(direct.status);
      const registerRows = await json(await api.request(`/api/households/${owner.hid}/transactions`, { headers: auth(guest.token) }));
      expect(JSON.stringify(registerRows.body)).not.toMatch(/Hidden Payee|Secret Vault/);
      expect(JSON.stringify(registerRows.body)).toMatch(/Market/);
      const search = await json(await api.request(`/api/search?householdId=${owner.hid}&q=Hidden%20Payee`, { headers: auth(guest.token) }));
      expect(JSON.stringify(search.body)).not.toMatch(/Hidden Payee|Secret Vault|secret drawer/);
      const csv = await api.request(`/api/households/${owner.hid}/exports/transactions.csv`, { headers: auth(guest.token) });
      expect(await csv.text()).not.toMatch(/Hidden Payee|Secret Vault/);
      const backup = await json(await api.request(`/api/households/${owner.hid}/backup`, { headers: auth(guest.token) }));
      expect(JSON.stringify(backup.body)).not.toMatch(/Secret Vault|Hidden Payee|secret drawer/);
      const report = await json(await api.request(`/api/households/${owner.hid}/reports/spending?asOf=2026-11-20`, { headers: auth(guest.token) }));
      expect(JSON.stringify(report.body)).not.toMatch(/Hidden Payee|Secret Vault/);
      const forecast = await json(await api.request(`/api/households/${owner.hid}/forecast?asOf=2026-11-20`, { headers: auth(guest.token) }));
      expect(JSON.stringify(forecast.body)).not.toMatch(/Hidden Payee|Secret Vault/);
      const widget = await json(await api.request(`/api/widgets/summary?householdId=${owner.hid}`, { headers: auth(guest.token) }));
      expect(JSON.stringify(widget.body)).not.toMatch(/Hidden Payee|Secret Vault/);
      const pdf = await api.request(`/api/households/${owner.hid}/exports/report.pdf`, { headers: auth(guest.token) });
      expect(await pdf.text()).not.toMatch(/Hidden Payee|Secret Vault/);
      const assistant = await json(await api.request(`/api/households/${owner.hid}/assistant`, {
        method: "POST", headers: auth(guest.token), body: JSON.stringify({ question: "Hidden Payee" }),
      }));
      expect(JSON.stringify(assistant.body)).not.toMatch(/Hidden Payee|Secret Vault|secret drawer/);
      const investments = await json(await api.request(`/api/households/${owner.hid}/investments`, { headers: auth(guest.token) }));
      expect(JSON.stringify(investments.body)).not.toMatch(/SECRET|Hidden Fund|Secret Vault/);
      const setup = await json(await api.request(`/api/households/${owner.hid}/onboarding`, { headers: auth(guest.token) }));
      const renamed = await json(await api.request(`/api/households/${owner.hid}/onboarding`, {
        method: "PATCH", headers: auth(guest.token),
        body: JSON.stringify({ version: setup.body.version, preferences: { householdName: "Renamed", currency: "USD", locale: "en-US", timeZone: "America/Chicago", weekStart: 0, approach: "zero" } }),
      }));
      expect(renamed.status).toBe(403);
      const audit = await json(await api.request(`/api/households/${owner.hid}/audit`, { headers: auth(guest.token) }));
      const auditText = JSON.stringify(audit.body);
      expect(auditText).not.toMatch(/Secret Vault|Hidden Payee|secret drawer|private note/);
      expect(auditText).not.toContain(secret.body.id);
      expect(auditText).not.toContain(hidden.body.id);
      expect(auditText).toMatch(/A private record changed/);
      expect(auditText).toMatch(/Joint Checking|Market/);
      const comment = await json(await api.request(`/api/households/${owner.hid}/comments`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ transactionId: visible.body.id, body: `${role} question` }),
      }));
      expect(comment.status).toBe(201);
      expect(comment.body.note).toMatch(/does not change/);
      const privateComment = await json(await api.request(`/api/households/${owner.hid}/comments`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ transactionId: hidden.body.id, body: "should fail" }),
      }));
      expect(privateComment.status).toBe(404);
      const currentVersion = await db.query(`SELECT version FROM transactions WHERE id = $1`, [visible.body.id]);
      const review = await json(await api.request(`/api/households/${owner.hid}/transactions/${visible.body.id}/review`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ reviewStatus: "reviewed", version: Number(currentVersion[0].version) }),
      }));
      expect(review.status).toBe(role === "readonly" ? 403 : 200);
      const retirement = await json(await api.request(`/api/households/${owner.hid}/retirement`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ currentAge: 40, retireAge: 65, endAge: 90, portfolioMinor: 1000, annualContributionMinor: 100, annualSpendingMinor: 100, inflationBps: 200, meanReturnBps: 500, stdevBps: 100, feeBps: 10, iterations: 1, seed: 1 }),
      }));
      expect(retirement.status).toBe(200);
      expect(retirement.body.saved).toBe(false);
      const layout = await json(await api.request("/api/me", {
        method: "PATCH", headers: auth(guest.token),
        body: JSON.stringify({ privacyMode: true }),
      }));
      expect(layout.status).toBe(200);
      const inviteDenied = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ email: `extra-${role}@example.com`, role: "editor" }),
      }));
      expect(inviteDenied.status).toBe(403);
      await api.request(`/api/households/${owner.hid}/members/${guest.userId}`, { method: "DELETE", headers: auth(owner.token) });
      const removed = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
        method: "POST", headers: auth(guest.token),
        body: JSON.stringify({ date: "2026-11-04", accountId: shared.body.id, amountMinor: -100, type: "expense", payee: "After", bankStatus: "posted", splits: [] }),
      }));
      expect(removed.status).toBe(404);
    }
    const ownerAudit = await json(await api.request(`/api/households/${owner.hid}/audit`, { headers: auth(owner.token) }));
    expect(JSON.stringify(ownerAudit.body)).toMatch(/Secret Vault|Hidden Payee|secret drawer/);
    const mid = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(owner.token) }));
    expect(mid.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor);
    expect(mid.body.netWorth.netMinor).toBe(before.body.netWorth.netMinor);
    await db.query(`DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = $1)`, [secret.body.id]);
    await db.query(`DELETE FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = $1)`, [secret.body.id]);
    await db.query(`DELETE FROM transactions WHERE account_id = $1`, [secret.body.id]);
    await db.query(`DELETE FROM accounts WHERE id = $1`, [secret.body.id]);
    const reader = await register(api, "late-reader@example.com", "Late");
    await verify(reader.email);
    const lateInvite = await invite(api, owner.token, owner.hid!, reader.email, "readonly");
    await api.request(`/api/invitations/${lateInvite.body.token}/accept`, { method: "POST", headers: auth(reader.token) });
    const afterDelete = await json(await api.request(`/api/households/${owner.hid}/audit`, { headers: auth(reader.token) }));
    expect(JSON.stringify(afterDelete.body)).not.toMatch(/Secret Vault|Hidden Payee|secret drawer/);
    expect(JSON.stringify(afterDelete.body)).toMatch(/A private record changed/);
    const token = await json(await api.request("/api/api-tokens", { method: "POST", headers: auth(reader.token), body: JSON.stringify({ name: "script" }) }));
    const forged = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(token.body.token),
      body: JSON.stringify({ date: "2026-11-05", accountId: shared.body.id, amountMinor: -100, type: "expense", payee: "Script", bankStatus: "posted", splits: [] }),
    }));
    expect(forged.status).toBe(403);
  });

  it("rejects a stale role after it changes", async () => {
    const api = await app();
    const owner = await register(api, "stale-owner@example.com", "Stale");
    await verify(owner.email);
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Cash", kind: "cash", openingBalanceMinor: 1000, openingDate: "2026-11-01" }),
    }));
    const created = await invite(api, owner.token, owner.hid!, "stale-editor@example.com", "editor");
    const editor = await register(api, "stale-editor@example.com", "Editor");
    await verify(editor.email);
    await api.request(`/api/invitations/${created.body.token}/accept`, { method: "POST", headers: auth(editor.token) });
    const posted = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(editor.token),
      body: JSON.stringify({ date: "2026-11-02", accountId: account.body.id, amountMinor: -100, type: "expense", payee: "First", bankStatus: "posted", splits: [] }),
    }));
    expect(posted.status).toBe(201);
    const changed = await json(await api.request(`/api/households/${owner.hid}/members/${editor.userId}`, {
      method: "PATCH", headers: auth(owner.token), body: JSON.stringify({ role: "readonly" }),
    }));
    expect(changed.status).toBe(200);
    const stale = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(editor.token),
      body: JSON.stringify({ date: "2026-11-03", accountId: account.body.id, amountMinor: -100, type: "expense", payee: "Second", bankStatus: "posted", splits: [] }),
    }));
    expect(stale.status).toBe(403);
    const me = await json(await api.request("/api/me", { headers: auth(editor.token) }));
    expect(me.body.households.find((item: { id: string }) => item.id === owner.hid).role).toBe("readonly");
  });
});
