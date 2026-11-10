import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;

afterEach(async () => {
  await db?.close();
});

async function app() {
  db = await openMemoryDatabase();
  return createApp(db);
}

async function json(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

function auth(token: string, extra?: Record<string, string>) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

describe("BudgetCents API", () => {
  it("keeps a card split and its payment as one purchase", async () => {
    const api = await app();
    const registered = await json(await api.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct-horse", displayName: "Ada", householdName: "Ada home", currency: "USD" }),
    }));
    expect(registered.status).toBe(200);
    const token = registered.body.token as string;
    const homes = await json(await api.request("/api/households", { headers: auth(token) }));
    const hid = homes.body.households[0].id as string;
    const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
    const spaceId = dash.body.spaceId as string;
    const groceries = dash.body.buckets.find((bucket: { name: string }) => bucket.name === "Groceries").id;
    const household = dash.body.buckets.find((bucket: { name: string }) => bucket.name === "Household").id;
    const checking = await json(await api.request(`/api/households/${hid}/accounts`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 100000, openingDate: "2026-11-01" }),
    }));
    const card = await json(await api.request(`/api/households/${hid}/accounts`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ spaceId, name: "Card", kind: "credit", onBudget: true, aprBps: 1999, minimumPaymentMinor: 2500, creditLimitMinor: 200000 }),
    }));
    expect(checking.status).toBe(201);
    expect(card.status).toBe(201);
    for (const [bucketId, amountMinor] of [[groceries, 6000], [household, 4000]] as const) {
      const assigned = await json(await api.request(`/api/households/${hid}/assignments`, {
        method: "POST", headers: auth(token),
        body: JSON.stringify({ spaceId, bucketId, periodKey: "2026-11", amountMinor }),
      }));
      expect(assigned.status).toBe(200);
    }
    const purchase = await json(await api.request(`/api/households/${hid}/transactions`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({
        date: "2026-11-05", accountId: card.body.id, amountMinor: -10000, type: "expense", payee: "Market", bankStatus: "posted",
        splits: [
          { bucketId: groceries, amountMinor: 6000, role: "expense" },
          { bucketId: household, amountMinor: 4000, role: "expense" },
        ],
        providerTransactionId: "fit-100",
      }),
    }));
    expect(purchase.status).toBe(201);
    const replay = await json(await api.request(`/api/households/${hid}/transactions`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({
        date: "2026-11-05", accountId: card.body.id, amountMinor: -10000, type: "expense", payee: "Market posted", bankStatus: "posted",
        splits: [{ bucketId: groceries, amountMinor: 10000, role: "expense" }],
        providerTransactionId: "fit-100",
      }),
    }));
    expect(replay.body.updated).toBe(true);
    const payment = await json(await api.request(`/api/households/${hid}/transactions`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ date: "2026-11-06", accountId: checking.body.id, counterAccountId: card.body.id, amountMinor: -10000, type: "cc_payment", payee: "Card payment", bankStatus: "posted", splits: [] }),
    }));
    expect(payment.status).toBe(201);
    const after = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
    expect(after.body.budget.identityDifferenceMinor).toBe(0);
    expect(after.body.budget.spendingMinor).toBe(10000);
    expect(after.body.budget.incomeMinor).toBe(0);
    const report = await json(await api.request(`/api/households/${hid}/reports/spending?asOf=2026-11-20&from=2026-11-01&to=2026-11-30`, { headers: auth(token) }));
    expect(report.body.totalMinor).toBe(10000);
    const list = await json(await api.request(`/api/households/${hid}/transactions?asOf=2026-11-20`, { headers: auth(token) }));
    expect(list.body.transactions.filter((txn: { providerTransactionId?: string }) => txn.providerTransactionId === "fit-100")).toHaveLength(1);
  });

  it("hides a private account from another member, including net worth and backup", async () => {
    const api = await app();
    const owner = await json(await api.request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "correct-horse", displayName: "Owner", householdName: "Shared" }),
    }));
    const token = owner.body.token as string;
    const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
    const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
    const spaceId = dash.body.spaceId as string;
    await api.request(`/api/households/${hid}/accounts`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ spaceId, name: "Joint", kind: "checking", openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    });
    const secret = await json(await api.request(`/api/households/${hid}/accounts`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ spaceId, name: "Private", kind: "cash", visibility: "private", openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const invite = await json(await api.request(`/api/households/${hid}/invitations`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ email: "guest@example.com", role: "editor" }),
    }));
    expect(invite.body.summary).toMatch(/Private accounts stay hidden/);
    const guest = await json(await api.request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", password: "correct-horse", displayName: "Guest", householdName: "Guest own" }),
    }));
    const accepted = await json(await api.request(`/api/invitations/${invite.body.token}/accept`, { method: "POST", headers: auth(guest.body.token) }));
    expect(accepted.status).toBe(200);
    const guestDash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(guest.body.token) }));
    expect(guestDash.body.accounts.some((account: { name: string }) => account.name === "Private")).toBe(false);
    expect(guestDash.body.netWorth.netMinor).toBe(10000);
    const denied = await json(await api.request(`/api/households/${hid}/accounts/${secret.body.id}`, { method: "PATCH", headers: auth(guest.body.token), body: JSON.stringify({ name: "Stolen" }) }));
    expect(denied.status).toBe(404);
    const backup = await json(await api.request(`/api/households/${hid}/backup`, { headers: auth(guest.body.token) }));
    expect(backup.body.accounts.map((account: { name: string }) => account.name)).not.toContain("Private");
    expect(backup.body.note).toMatch(/omitted/);
    const ownerDash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
    expect(ownerDash.body.netWorth.netMinor).toBe(15000);
  });

  it("rejects a second sync of the same operation and deletes an account", async () => {
    const api = await app();
    const registered = await json(await api.request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sam@example.com", password: "correct-horse", displayName: "Sam", householdName: "Sam" }),
    }));
    const token = registered.body.token as string;
    const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
    const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
    const account = await json(await api.request(`/api/households/${hid}/accounts`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ spaceId: dash.body.spaceId, name: "Cash", kind: "cash", openingBalanceMinor: 2000, openingDate: "2026-11-01" }),
    }));
    const op = { opId: "device-1", transaction: { date: "2026-11-02", accountId: account.body.id, amountMinor: -500, type: "expense", payee: "Coffee", bankStatus: "posted", splits: [] } };
    const once = await json(await api.request(`/api/households/${hid}/sync`, { method: "POST", headers: auth(token), body: JSON.stringify({ ops: [op] }) }));
    const twice = await json(await api.request(`/api/households/${hid}/sync`, { method: "POST", headers: auth(token), body: JSON.stringify({ ops: [op] }) }));
    expect(once.body.results[0].status).toBe("applied");
    expect(twice.body.results[0].status).toBe("duplicate");
    const removed = await json(await api.request("/api/me", { method: "DELETE", headers: auth(token), body: JSON.stringify({ password: "correct-horse", confirm: "DELETE" }) }));
    expect(removed.body.deleted).toBe(true);
    const again = await json(await api.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "sam@example.com", password: "correct-horse" }) }));
    expect(again.status).toBe(401);
  });

  it("loads the sample household with a balanced plan and manual credit", async () => {
    process.env.DEMO_LOGIN = "true";
    const api = await app();
    const demo = await json(await api.request("/api/auth/demo", { method: "POST" }));
    expect(demo.body.demo).toBe(true);
    const token = demo.body.token as string;
    const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
    const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-10`, { headers: auth(token) }));
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.body.budget.identityDifferenceMinor).toBe(0);
    expect(dash.body.household.isDemo).toBe(true);
    const credit = await json(await api.request(`/api/households/${hid}/credit`, { headers: auth(token) }));
    expect(credit.body.entries[0].source).toBe("manual");
    expect(credit.body.liveReport).toBeNull();
    const assistant = await json(await api.request(`/api/households/${hid}/assistant`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ question: "what can I safely spend?" }),
    }));
    expect(assistant.body.facts[0].formula).toMatch(/Expected income|expected income|shortage|Cash safe/i);
  });
});
