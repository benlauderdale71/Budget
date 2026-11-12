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

async function markVerified(email: string) {
  await db.query(`UPDATE users SET email_verified_at = $1 WHERE email = $2`, [new Date().toISOString(), email.toLowerCase()]);
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
    let planRevision = 0;
    for (const [bucketId, amountMinor] of [[groceries, 6000], [household, 4000]] as const) {
      const assigned = await json(await api.request(`/api/households/${hid}/assignments`, {
        method: "POST", headers: auth(token),
        body: JSON.stringify({ spaceId, bucketId, periodKey: "2026-11", amountMinor, planRevision }),
      }));
      expect(assigned.status).toBe(200);
      planRevision = assigned.body.planRevision;
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
    await markVerified("owner@example.com");
    const invite = await json(await api.request(`/api/households/${hid}/invitations`, {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ email: "guest@example.com", role: "editor" }),
    }));
    expect(invite.body.summary).toMatch(/Private accounts stay hidden|Private accounts and personal spaces stay/);
    const guest = await json(await api.request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", password: "correct-horse", displayName: "Guest", householdName: "Guest own" }),
    }));
    await markVerified("guest@example.com");
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
    const roadmap = await json(await api.request(`/api/households/${hid}/roadmap?asOf=2026-11-10`, { headers: auth(token) }));
    expect(roadmap.status).toBe(200);
    expect(roadmap.body.essential.amountMinor).toBe(212_000);
    expect(roadmap.body.essential.sources.map((source: { name: string }) => source.name)).toEqual(expect.arrayContaining(["Rent", "Car loan minimum"]));
  });
});

describe("authorization, validation, and idempotency", () => {
  async function household(api: Awaited<ReturnType<typeof app>>, email: string) {
    const registered = await json(await api.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse", displayName: email, householdName: email }),
    }));
    const token = registered.body.token as string;
    const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
    const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-10`, { headers: auth(token) }));
    return { token, hid, spaceId: dash.body.spaceId as string, buckets: dash.body.buckets as { id: string; name: string }[] };
  }

  it("does not let an admin reset another household or a private space, and keeps transactions", async () => {
    const api = await app();
    const owner = await household(api, "owner-reset@example.com");
    const other = await household(api, "other-reset@example.com");
    const groceries = owner.buckets.find((bucket) => bucket.name === "Groceries")!;
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Cash", kind: "cash", openingBalanceMinor: 8000, openingDate: "2026-11-01" }),
    }));
    await api.request(`/api/households/${owner.hid}/assignments`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, bucketId: groceries.id, periodKey: "2026-11", amountMinor: 3000, planRevision: 0 }),
    });
    const expense = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ date: "2026-11-02", accountId: account.body.id, amountMinor: -500, type: "expense", payee: "Cafe", bankStatus: "posted", splits: [{ bucketId: groceries.id, amountMinor: 500, role: "expense" }], categoryLocked: true }),
    }));
    expect(expense.status).toBe(201);
    const otherGroceries = other.buckets.find((bucket) => bucket.name === "Groceries")!;
    await api.request(`/api/households/${other.hid}/assignments`, {
      method: "POST", headers: auth(other.token),
      body: JSON.stringify({ spaceId: other.spaceId, bucketId: otherGroceries.id, periodKey: "2026-11", amountMinor: 4000, planRevision: 0 }),
    });
    const cross = await json(await api.request(`/api/households/${owner.hid}/fresh-start`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: other.spaceId, keepTargets: false }),
    }));
    expect(cross.status).toBe(404);
    const otherDash = await json(await api.request(`/api/households/${other.hid}/dashboard?asOf=2026-11-10`, { headers: auth(other.token) }));
    expect(otherDash.body.budget.buckets.find((row: { bucketId: string }) => row.bucketId === otherGroceries.id).assignedMinor).toBe(4000);

    const personal = await json(await api.request(`/api/households/${owner.hid}/spaces`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ name: "Private plan", kind: "personal" }),
    }));
    const privateBucket = await json(await api.request(`/api/households/${owner.hid}/buckets`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: personal.body.id, name: "Secret", group: "Spending" }),
    }));
    await api.request(`/api/households/${owner.hid}/assignments`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: personal.body.id, bucketId: privateBucket.body.id, periodKey: "2026-11", amountMinor: 1200, planRevision: 1 }),
    });
    await markVerified("owner-reset@example.com");
    const invite = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ email: "admin-reset@example.com", role: "admin" }),
    }));
    const admin = await json(await api.request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin-reset@example.com", password: "correct-horse", displayName: "Admin", householdName: "Admin home" }),
    }));
    await markVerified("admin-reset@example.com");
    await api.request(`/api/invitations/${invite.body.token}/accept`, { method: "POST", headers: auth(admin.body.token) });
    const stolen = await json(await api.request(`/api/households/${owner.hid}/fresh-start`, {
      method: "POST", headers: auth(admin.body.token),
      body: JSON.stringify({ spaceId: personal.body.id, keepTargets: false }),
    }));
    expect(stolen.status).toBe(404);
    const editorInvite = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ email: "editor-reset@example.com", role: "editor" }),
    }));
    const editor = await json(await api.request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "editor-reset@example.com", password: "correct-horse", displayName: "Editor", householdName: "Editor home" }),
    }));
    await markVerified("editor-reset@example.com");
    await api.request(`/api/invitations/${editorInvite.body.token}/accept`, { method: "POST", headers: auth(editor.body.token) });
    const memberReset = await json(await api.request(`/api/households/${owner.hid}/fresh-start`, {
      method: "POST", headers: auth(editor.body.token),
      body: JSON.stringify({ spaceId: owner.spaceId, keepTargets: false }),
    }));
    expect(memberReset.status).toBe(403);

    const before = await json(await api.request(`/api/households/${owner.hid}/transactions?asOf=2026-11-10`, { headers: auth(owner.token) }));
    const reset = await json(await api.request(`/api/households/${owner.hid}/fresh-start`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, keepTargets: false }),
    }));
    expect(reset.status).toBe(200);
    const after = await json(await api.request(`/api/households/${owner.hid}/transactions?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(after.body.transactions).toHaveLength(before.body.transactions.length);
    expect(after.body.transactions.some((txn: { payee: string }) => txn.payee === "Cafe")).toBe(true);
    const cleared = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(cleared.body.budget.buckets.find((row: { bucketId: string }) => row.bucketId === groceries.id).assignedMinor).toBe(0);
    const audit = await json(await api.request(`/api/households/${owner.hid}/audit`, { headers: auth(owner.token) }));
    expect(audit.body.events.some((event: { action: string }) => event.action === "plan.reset")).toBe(true);
    const privateStill = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-10&spaceId=${personal.body.id}`, { headers: auth(owner.token) }));
    expect(privateStill.body.budget.buckets.find((row: { bucketId: string }) => row.bucketId === privateBucket.body.id).assignedMinor).toBe(1200);
  });

  it("rejects a split that does not match and leaves the register readable", async () => {
    const api = await app();
    const owner = await household(api, "splits@example.com");
    const groceries = owner.buckets.find((bucket) => bucket.name === "Groceries")!;
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Cash", kind: "cash", openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const bad = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({
        date: "2026-11-03", accountId: account.body.id, amountMinor: -1000, type: "expense", payee: "Market", bankStatus: "posted", categoryLocked: true,
        splits: [{ bucketId: groceries.id, amountMinor: 400, role: "expense" }],
      }),
    }));
    expect(bad.status).toBe(400);
    const dash = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(dash.status).toBe(200);
    const list = await json(await api.request(`/api/households/${owner.hid}/transactions?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(list.body.transactions.some((txn: { payee: string }) => txn.payee === "Market")).toBe(false);
    const report = await json(await api.request(`/api/households/${owner.hid}/reports/spending?asOf=2026-11-10&from=2026-11-01&to=2026-11-30`, { headers: auth(owner.token) }));
    expect(report.status).toBe(200);

    const good = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({
        date: "2026-11-03", accountId: account.body.id, amountMinor: -1000, type: "expense", payee: "Market", bankStatus: "posted", categoryLocked: true,
        splits: [{ bucketId: groceries.id, amountMinor: 1000, role: "expense" }],
      }),
    }));
    expect(good.status).toBe(201);
    const edited = await json(await api.request(`/api/households/${owner.hid}/transactions/${good.body.id}`, {
      method: "PATCH", headers: auth(owner.token),
      body: JSON.stringify({ version: 1, splits: [{ bucketId: groceries.id, amountMinor: 250, role: "expense" }] }),
    }));
    expect(edited.status).toBe(400);
    const still = await json(await api.request(`/api/households/${owner.hid}/transactions?asOf=2026-11-10`, { headers: auth(owner.token) }));
    const market = still.body.transactions.find((txn: { payee: string }) => txn.payee === "Market");
    expect(market.splits[0].amountMinor).toBe(1000);
    const readable = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(readable.status).toBe(200);

    await api.request(`/api/households/${owner.hid}/rules`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({
        name: "Bad cafe splits", priority: 1, matchMode: "all",
        conditions: [{ field: "payee", op: "contains", value: "cafe" }],
        actions: [{ type: "set_splits", splits: [{ bucketId: groceries.id, amountMinor: 1, role: "expense" }] }],
      }),
    });
    const ruled = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: account.body.id, amountMinor: -700, type: "expense", payee: "Cafe", bankStatus: "posted", splits: [] }),
    }));
    expect(ruled.status).toBe(400);
    const afterRule = await json(await api.request(`/api/households/${owner.hid}/transactions?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(afterRule.body.transactions.some((txn: { payee: string }) => txn.payee === "Cafe")).toBe(false);

    const posted = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({
        date: "2026-11-05", accountId: account.body.id, amountMinor: -800, type: "expense", payee: "Books", bankStatus: "posted", categoryLocked: true,
        splits: [{ bucketId: groceries.id, amountMinor: 800, role: "expense" }], providerTransactionId: "prov-1",
      }),
    }));
    expect(posted.status).toBe(201);
    const mismatch = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({
        date: "2026-11-05", accountId: account.body.id, amountMinor: -900, type: "expense", payee: "Books posted", bankStatus: "posted",
        splits: [{ bucketId: groceries.id, amountMinor: 900, role: "expense" }], providerTransactionId: "prov-1",
      }),
    }));
    expect(mismatch.status).toBe(400);
    const books = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(books.status).toBe(200);
    expect(books.body.budget.spendingMinor).toBe(1800);
  });

  it("records one transaction when the same operation id is retried, including concurrently", async () => {
    const api = await app();
    const owner = await household(api, "retry@example.com");
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Cash", kind: "cash", openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const body = { date: "2026-11-06", accountId: account.body.id, amountMinor: -250, type: "expense", payee: "Bus", bankStatus: "posted", splits: [], opId: "phone-op-1" };
    const [first, second] = await Promise.all([
      json(await api.request(`/api/households/${owner.hid}/transactions`, { method: "POST", headers: auth(owner.token), body: JSON.stringify(body) })),
      json(await api.request(`/api/households/${owner.hid}/transactions`, { method: "POST", headers: auth(owner.token), body: JSON.stringify(body) })),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const ids = [first.body.id, second.body.id].filter(Boolean);
    expect(new Set(ids).size).toBe(1);
    expect(first.body.duplicate === true || second.body.duplicate === true).toBe(true);
    const third = await json(await api.request(`/api/households/${owner.hid}/transactions`, { method: "POST", headers: auth(owner.token), body: JSON.stringify(body) }));
    expect(third.body.duplicate).toBe(true);
    expect(third.body.id).toBe(ids[0]);
    const list = await json(await api.request(`/api/households/${owner.hid}/transactions?asOf=2026-11-10`, { headers: auth(owner.token) }));
    expect(list.body.transactions.filter((txn: { payee: string }) => txn.payee === "Bus")).toHaveLength(1);
  });
});
