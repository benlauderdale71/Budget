import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;

afterEach(async () => {
  delete process.env.SANDBOX_WEBHOOK_SECRET;
  delete process.env.OIDC_ISSUER;
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

async function register(api: Awaited<ReturnType<typeof app>>, email: string, householdName: string) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: email.split("@")[0], householdName, currency: "USD" }),
  }));
  expect(registered.status).toBe(200);
  const token = registered.body.token as string;
  const homes = await json(await api.request("/api/households", { headers: auth(token) }));
  const hid = homes.body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
  return { token, hid, spaceId: dash.body.spaceId as string, buckets: dash.body.buckets as { id: string; name: string }[], userId: registered.body.user.id as string };
}

describe("live plan revisions and later features", () => {
  it("rejects a stale assignment without changing the amount", async () => {
    const api = await app();
    const owner = await register(api, "owner-plan@example.com", "North");
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), owner.userId]);
    const invited = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ email: "editor-plan@example.com", role: "editor" }),
    }));
    const editor = await register(api, "editor-plan@example.com", "Editor home");
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), editor.userId]);
    const accepted = await json(await api.request(`/api/invitations/${invited.body.token}/accept`, { method: "POST", headers: auth(editor.token) }));
    expect(accepted.status).toBe(200);
    const groceries = owner.buckets.find((bucket) => bucket.name === "Groceries")!;
    const first = await json(await api.request(`/api/households/${owner.hid}/assignments`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, bucketId: groceries.id, periodKey: "2026-11", amountMinor: 2500, planRevision: 0 }),
    }));
    expect(first.status).toBe(200);
    const stale = await json(await api.request(`/api/households/${owner.hid}/assignments`, {
      method: "POST", headers: auth(editor.token),
      body: JSON.stringify({ spaceId: owner.spaceId, bucketId: groceries.id, periodKey: "2026-11", amountMinor: 9000, planRevision: 0 }),
    }));
    expect(stale.status).toBe(409);
    expect(stale.body.planRevision).toBe(first.body.planRevision);
    const saved = await json(await api.request(`/api/households/${owner.hid}/assignments`, {
      method: "POST", headers: auth(editor.token),
      body: JSON.stringify({ spaceId: owner.spaceId, bucketId: groceries.id, periodKey: "2026-11", amountMinor: 2600, planRevision: stale.body.planRevision }),
    }));
    expect(saved.status).toBe(200);
    const dash = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20&evaluate=0`, { headers: auth(owner.token) }));
    expect(dash.body.budget.buckets.find((row: { bucketId: string }) => row.bucketId === groceries.id).assignedMinor).toBe(2600);
    const changes = await json(await api.request(`/api/households/${owner.hid}/changes?since=`, { headers: auth(owner.token) }));
    expect(changes.status).toBe(200);
    expect(changes.body.planRevision).toBe(saved.body.planRevision);
    expect(changes.body.role).toBe("owner");
    const alerts = await json(await api.request(`/api/households/${owner.hid}/alerts`, { headers: auth(owner.token) }));
    expect(alerts.body.alerts ?? alerts.body).toBeTruthy();
  });

  it("splits one purchase across people without changing its total", async () => {
    const api = await app();
    const owner = await register(api, "split-owner@example.com", "North");
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 50000, openingDate: "2026-11-01" }),
    }));
    const groceries = owner.buckets.find((bucket) => bucket.name === "Groceries")!;
    const purchase = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({
        date: "2026-11-04", accountId: account.body.id, amountMinor: -1000, type: "expense", payee: "Market", bankStatus: "posted",
        splits: [
          { bucketId: groceries.id, amountMinor: 600, role: "expense", ownerUserId: owner.userId },
          { bucketId: groceries.id, amountMinor: 400, role: "expense" },
        ],
      }),
    }));
    expect(purchase.status).toBe(201);
    const all = await json(await api.request(`/api/households/${owner.hid}/ownership-summary?ownership=all&asOf=2026-11-20`, { headers: auth(owner.token) }));
    const mine = await json(await api.request(`/api/households/${owner.hid}/ownership-summary?ownership=mine&asOf=2026-11-20`, { headers: auth(owner.token) }));
    const ours = await json(await api.request(`/api/households/${owner.hid}/ownership-summary?ownership=ours&asOf=2026-11-20`, { headers: auth(owner.token) }));
    expect(all.body.spendingMinor).toBe(1000);
    expect(mine.body.spendingMinor).toBe(600);
    expect(ours.body.spendingMinor).toBe(400);
    expect(mine.body.spendingMinor + ours.body.spendingMinor).toBe(all.body.spendingMinor);
    const rows = await db.query(`SELECT amount_minor FROM transactions WHERE id = $1`, [purchase.body.id]);
    expect(Number(rows[0].amount_minor)).toBe(-1000);
  });

  it("keeps lot sales, retirement models, and sandbox connections off the register", async () => {
    const api = await app();
    const owner = await register(api, "lots@example.com", "North");
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Brokerage", kind: "brokerage", onBudget: false, openingBalanceMinor: 0, openingDate: "2026-11-01" }),
    }));
    const holding = await json(await api.request(`/api/households/${owner.hid}/holdings`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ accountId: account.body.id, symbol: "FUND", name: "Fund", assetClass: "fund", quantity: "2", currency: "USD" }),
    }));
    const missing = await json(await api.request(`/api/households/${owner.hid}/lots`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ holdingId: holding.body.id, quantityMicro: 1_000_000, costBasisMinor: null, acquired: "2020-01-01" }),
    }));
    expect(missing.status).toBe(201);
    const blocked = await json(await api.request(`/api/households/${owner.hid}/lots/sell`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ holdingId: holding.body.id, quantityMicro: 1_000_000, proceedsMinor: 3000 }),
    }));
    expect(blocked.status).toBe(400);
    await json(await api.request(`/api/households/${owner.hid}/lots/${missing.body.id}`, {
      method: "PATCH", headers: auth(owner.token), body: JSON.stringify({ costBasisMinor: 2000 }),
    }));
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [owner.hid]);
    const sold = await json(await api.request(`/api/households/${owner.hid}/lots/sell`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ holdingId: holding.body.id, quantityMicro: 1_000_000, proceedsMinor: 3000 }),
    }));
    expect(sold.body.gainMinor).toBe(1000);
    const modeled = await json(await api.request(`/api/households/${owner.hid}/retirement/monthly`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ portfolioMinor: 2650000, traditionalMinor: 2650000, annualReturnBps: 0, annualSpendingMinor: 0, annualContributionMinor: 0, taxBps: 0, age: 73, months: 1 }),
    }));
    expect(modeled.body.months[0].withdrawalMinor).toBe(100000);
    expect(modeled.body.guarantee).toBe(false);
    const connected = await json(await api.request(`/api/households/${owner.hid}/providers/sandbox/connect`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ provider: "sandbox-bank" }),
    }));
    expect(connected.body.transactionsImported).toBe(0);
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [owner.hid]);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    const request = await json(await api.request(`/api/households/${owner.hid}/service-requests`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ kind: "cancellation", detail: "Please ask about this subscription." }),
    }));
    expect(request.body.completed).toBe(false);
    expect(request.body.status).toBe("authorization_recorded");
    const oidc = await json(await api.request("/api/auth/oidc/start"));
    expect(oidc.status).toBe(404);
    const look = await json(await api.request(`/api/households/${owner.hid}/look-through`, { headers: auth(owner.token) }));
    expect(look.body.available).toBe(false);
    expect(look.body.holdings).toEqual([]);
  });

  it("confirms an assistant transaction once and can undo it", async () => {
    const api = await app();
    const owner = await register(api, "assistant@example.com", "North");
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 8000, openingDate: "2026-11-01" }),
    }));
    const preview = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/preview`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ kind: "create_transaction", payload: { date: "2026-11-06", accountId: account.body.id, amountMinor: -500, type: "expense", payee: "Cafe", bankStatus: "posted", splits: [] } }),
    }));
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE payee = 'Cafe'`);
    expect(Number(before[0].n)).toBe(0);
    const confirmed = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${preview.body.id}/confirm`, { method: "POST", headers: auth(owner.token) }));
    expect(confirmed.status).toBe(200);
    const again = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${preview.body.id}/confirm`, { method: "POST", headers: auth(owner.token) }));
    expect(again.status).toBe(409);
    const rows = await db.query(`SELECT count(*) AS n FROM transactions WHERE payee = 'Cafe' AND deleted = 0`);
    expect(Number(rows[0].n)).toBe(1);
    const undone = await json(await api.request(`/api/households/${owner.hid}/assistant/actions/${preview.body.id}/undo`, { method: "POST", headers: auth(owner.token) }));
    expect(undone.status).toBe(200);
    const left = await db.query(`SELECT count(*) AS n FROM transactions WHERE payee = 'Cafe' AND deleted = 0`);
    expect(Number(left[0].n)).toBe(0);
  });

  it("stores a signed sandbox event once and does not invent a bank transaction", async () => {
    process.env.SANDBOX_WEBHOOK_SECRET = "sandbox-secret";
    const api = await app();
    const owner = await register(api, "hook@example.com", "North");
    const payload = JSON.stringify({ householdId: owner.hid, externalId: "evt-1", kind: "price_increase", title: "A subscribed price changed", body: "Open the app for details.", occurredOn: "2026-11-11" });
    const signature = createHmac("sha256", "sandbox-secret").update(payload).digest("hex");
    const bad = await json(await api.request("/api/providers/sandbox/webhook", { method: "POST", headers: { "content-type": "application/json", "x-budgetcents-signature": "nope" }, body: payload }));
    expect(bad.status).toBe(401);
    const first = await json(await api.request("/api/providers/sandbox/webhook", { method: "POST", headers: { "content-type": "application/json", "x-budgetcents-signature": signature }, body: payload }));
    const second = await json(await api.request("/api/providers/sandbox/webhook", { method: "POST", headers: { "content-type": "application/json", "x-budgetcents-signature": signature }, body: payload }));
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(first.body.transactionsImported).toBe(0);
    const events = await db.query(`SELECT count(*) AS n FROM provider_events`);
    expect(Number(events[0].n)).toBe(1);
    const txns = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1 AND type <> 'opening'`, [owner.hid]);
    expect(Number(txns[0].n)).toBe(0);
  });
});
