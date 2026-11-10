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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function household(api: Awaited<ReturnType<typeof app>>, email: string) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: email, householdName: email }),
  }));
  const token = registered.body.token as string;
  const userId = registered.body.user.id as string;
  const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
  return { token, userId, hid, spaceId: dash.body.spaceId as string };
}

describe("transaction workflow", () => {
  it("matches one copy, keeps notes and the receipt, then restores both amounts", async () => {
    const api = await app();
    const home = await household(api, "match@example.com");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 20000, openingDate: "2026-11-01" }),
    }));
    const keeper = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: account.body.id, amountMinor: -2500, type: "expense", payee: "Market", notes: "keep this", tags: ["groceries"], reviewStatus: "reviewed", bankStatus: "posted", splits: [] }),
    }));
    const incoming = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: account.body.id, amountMinor: -2500, type: "expense", payee: "Market bank", bankStatus: "posted", splits: [], providerTransactionId: "bank-2500" }),
    }));
    await db.query(
      `INSERT INTO attachments (id, household_id, transaction_id, filename, mime, size_bytes, storage_key, created_by, created_at) VALUES ($1,$2,$3,'receipt.jpg','image/jpeg',10,'key',$4,$5)`,
      ["att-1", home.hid, incoming.body.id, home.userId, "2026-11-04T00:00:00.000Z"],
    );
    const before = await json(await api.request(`/api/households/${home.hid}/reports/spending?asOf=2026-11-20&from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    expect(before.body.totalMinor).toBe(5000);
    const matched = await json(await api.request(`/api/households/${home.hid}/transactions/${keeper.body.id}/match`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ otherId: incoming.body.id }),
    }));
    expect(matched.status).toBe(200);
    const after = await json(await api.request(`/api/households/${home.hid}/reports/spending?asOf=2026-11-20&from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    expect(after.body.totalMinor).toBe(2500);
    const list = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-20`, { headers: auth(home.token) }));
    const kept = list.body.transactions.find((txn: { id: string }) => txn.id === keeper.body.id);
    expect(kept.notes).toBe("keep this");
    expect(kept.tags).toEqual(["groceries"]);
    expect(kept.reviewStatus).toBe("reviewed");
    expect(kept.providerTransactionId).toBe("bank-2500");
    expect(kept.matchedArchivedId).toBe(incoming.body.id);
    expect(list.body.transactions.some((txn: { id: string }) => txn.id === incoming.body.id)).toBe(false);
    const attachment = await db.query(`SELECT transaction_id FROM attachments WHERE id = 'att-1'`);
    expect(attachment[0].transaction_id).toBe(keeper.body.id);
    const restored = await json(await api.request(`/api/households/${home.hid}/transactions/${keeper.body.id}/unmatch`, { method: "POST", headers: auth(home.token) }));
    expect(restored.status).toBe(200);
    const again = await json(await api.request(`/api/households/${home.hid}/reports/spending?asOf=2026-11-20&from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    expect(again.body.totalMinor).toBe(5000);
    const both = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-20`, { headers: auth(home.token) }));
    expect(both.body.transactions.filter((txn: { payee: string }) => txn.payee.startsWith("Market"))).toHaveLength(2);
    const returned = await db.query(`SELECT transaction_id FROM attachments WHERE id = 'att-1'`);
    expect(returned[0].transaction_id).toBe(incoming.body.id);
  });

  it("rejects another household's transaction, category, and backup id", async () => {
    const api = await app();
    const ada = await household(api, "ada-flow@example.com");
    const bea = await household(api, "bea-flow@example.com");
    const account = await json(await api.request(`/api/households/${ada.hid}/accounts`, {
      method: "POST", headers: auth(ada.token),
      body: JSON.stringify({ spaceId: ada.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const txn = await json(await api.request(`/api/households/${ada.hid}/transactions`, {
      method: "POST", headers: auth(ada.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: account.body.id, amountMinor: -1000, type: "expense", payee: "Cafe", bankStatus: "posted", splits: [] }),
    }));
    const otherAccount = await json(await api.request(`/api/households/${bea.hid}/accounts`, {
      method: "POST", headers: auth(bea.token),
      body: JSON.stringify({ spaceId: bea.spaceId, name: "Bea", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const cross = await json(await api.request(`/api/households/${bea.hid}/transactions`, {
      method: "POST", headers: auth(bea.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: account.body.id, amountMinor: -1000, type: "expense", payee: "Cafe", bankStatus: "posted", splits: [] }),
    }));
    expect(cross.status).toBe(404);
    const groceries = (await json(await api.request(`/api/households/${ada.hid}/dashboard`, { headers: auth(ada.token) }))).body.buckets.find((bucket: { name: string }) => bucket.name === "Groceries").id;
    const foreignCategory = await json(await api.request(`/api/households/${bea.hid}/transactions`, {
      method: "POST", headers: auth(bea.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: otherAccount.body.id, amountMinor: -1000, type: "expense", payee: "Cafe", bankStatus: "posted", splits: [{ bucketId: groceries, amountMinor: 1000, role: "expense" }] }),
    }));
    expect(foreignCategory.status).toBe(404);
    const match = await json(await api.request(`/api/households/${bea.hid}/transactions/${txn.body.id}/match`, {
      method: "POST", headers: auth(bea.token), body: JSON.stringify({ otherId: txn.body.id }),
    }));
    expect(match.status).toBe(404);
    const backup = await json(await api.request(`/api/households/${ada.hid}/backup`, { headers: auth(ada.token) }));
    const before = await db.query(`SELECT id FROM accounts WHERE household_id = $1`, [bea.hid]);
    const stolen = await json(await api.request(`/api/households/${bea.hid}/restore`, {
      method: "POST", headers: auth(bea.token), body: JSON.stringify({ mode: "add-missing", backup: backup.body }),
    }));
    expect(stolen.status).toBe(400);
    expect(stolen.body.error).toMatch(/different household/);
    const after = await db.query(`SELECT id FROM accounts WHERE household_id = $1`, [bea.hid]);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });

  it("duplicates without the provider id and explains a version conflict", async () => {
    const api = await app();
    const home = await household(api, "dup@example.com");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const created = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: account.body.id, amountMinor: -800, type: "expense", payee: "Diner", notes: "original", bankStatus: "posted", splits: [], providerTransactionId: "prov-diner" }),
    }));
    const copy = await json(await api.request(`/api/households/${home.hid}/transactions/${created.body.id}/duplicate`, { method: "POST", headers: auth(home.token) }));
    expect(copy.status).toBe(201);
    const list = await json(await api.request(`/api/households/${home.hid}/transactions`, { headers: auth(home.token) }));
    const original = list.body.transactions.find((txn: { id: string }) => txn.id === created.body.id);
    const duplicated = list.body.transactions.find((txn: { id: string }) => txn.id === copy.body.id);
    expect(original.providerTransactionId).toBe("prov-diner");
    expect(original.notes).toBe("original");
    expect(duplicated.providerTransactionId ?? null).toBeNull();
    expect(duplicated.reviewStatus).toBe("needs_review");
    expect(duplicated.notes).toBe("original");
    const stale = await json(await api.request(`/api/households/${home.hid}/transactions/${created.body.id}`, {
      method: "PATCH", headers: auth(home.token), body: JSON.stringify({ payee: "Changed", version: 99 }),
    }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/Reload/);
    expect((await json(await api.request(`/api/households/${home.hid}/transactions`, { headers: auth(home.token) }))).body.transactions.find((txn: { id: string }) => txn.id === created.body.id).payee).toBe("Diner");
  });

  it("keeps a saved view private and pages the register", async () => {
    const api = await app();
    const home = await household(api, "views@example.com");
    const saved = await json(await api.request(`/api/households/${home.hid}/views`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ name: "November", query: { from: "2026-11-01", to: "2026-11-30" } }),
    }));
    expect(saved.status).toBe(201);
    const mine = await json(await api.request(`/api/households/${home.hid}/views`, { headers: auth(home.token) }));
    expect(mine.body.views).toHaveLength(1);
    const other = await household(api, "views-other@example.com");
    const hidden = await json(await api.request(`/api/households/${home.hid}/views`, { headers: auth(other.token) }));
    expect(hidden.status).toBe(404);
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 50000, openingDate: "2026-11-01" }),
    }));
    for (let index = 0; index < 3; index += 1) {
      await api.request(`/api/households/${home.hid}/transactions`, {
        method: "POST", headers: auth(home.token),
        body: JSON.stringify({ date: `2026-11-0${index + 1}`, accountId: account.body.id, amountMinor: -100, type: "expense", payee: `Stop ${index}`, bankStatus: "posted", splits: [] }),
      });
    }
    const page = await json(await api.request(`/api/households/${home.hid}/transactions?limit=2&offset=0`, { headers: auth(home.token) }));
    expect(page.body.transactions).toHaveLength(2);
    expect(page.body.total).toBeGreaterThanOrEqual(3);
    expect(page.body.nextOffset).toBe(2);
  });

  it("links a refund and refuses a reconciliation id from another account", async () => {
    const api = await app();
    const home = await household(api, "refund@example.com");
    const checking = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const cash = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Cash", kind: "cash", onBudget: true, openingBalanceMinor: 0, openingDate: "2026-11-01" }),
    }));
    const expense = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-04", accountId: checking.body.id, amountMinor: -4000, type: "expense", payee: "Store", bankStatus: "posted", splits: [] }),
    }));
    const refund = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-06", accountId: checking.body.id, amountMinor: 1500, type: "refund", payee: "Store refund", bankStatus: "posted", splits: [], refundOfId: expense.body.id }),
    }));
    expect(refund.status).toBe(201);
    const spending = await json(await api.request(`/api/households/${home.hid}/reports/spending?from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    expect(spending.body.totalMinor).toBe(2500);
    expect(spending.body.formula).toMatch(/Refunds/);
    const self = await json(await api.request(`/api/households/${home.hid}/transactions/${expense.body.id}`, {
      method: "PATCH", headers: auth(home.token), body: JSON.stringify({ refundOfId: expense.body.id, type: "refund", version: 1 }),
    }));
    expect(self.status).toBe(400);
    const foreign = await json(await api.request(`/api/households/${home.hid}/reconcile`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: cash.body.id, statementDate: "2026-11-30", statementBalanceMinor: 0, clearedIds: [expense.body.id], lock: false }),
    }));
    expect(foreign.status).toBe(404);
  });

  it("previews a restore without writing, then adds only missing rows", async () => {
    const api = await app();
    const home = await household(api, "restore@example.com");
    const backup = {
      version: 2,
      accounts: [{ id: "acct-new", household_id: "someone-else", space_id: home.spaceId, name: "Imported", kind: "checking", currency: "USD", on_budget: 1, created_at: "2026-11-01T00:00:00.000Z" }],
      transactions: [],
    };
    const before = await db.query(`SELECT id FROM accounts WHERE id = 'acct-new'`);
    const preview = await json(await api.request(`/api/households/${home.hid}/restore`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ mode: "preview", backup }),
    }));
    expect(preview.status).toBe(200);
    expect(preview.body.adds.accounts).toBe(1);
    expect(await db.query(`SELECT id FROM accounts WHERE id = 'acct-new'`)).toEqual(before);
    const applied = await json(await api.request(`/api/households/${home.hid}/restore`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ mode: "add-missing", backup }),
    }));
    expect(applied.status).toBe(200);
    const row = await db.query(`SELECT household_id, name FROM accounts WHERE id = 'acct-new'`);
    expect(row[0].household_id).toBe(home.hid);
    expect(row[0].name).toBe("Imported");
    const again = await json(await api.request(`/api/households/${home.hid}/restore`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ mode: "preview", backup }),
    }));
    expect(again.body.adds.accounts).toBe(0);
    const bad = await json(await api.request(`/api/households/${home.hid}/restore`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ mode: "preview", backup: { version: 9 } }),
    }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/version/);
  });

  it("applies one transaction when the same operation is submitted twice", async () => {
    const api = await app();
    const home = await household(api, "retry@example.com");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const body = { date: "2026-11-08", accountId: account.body.id, amountMinor: -325, type: "expense", payee: "Lost response", bankStatus: "posted", splits: [], opId: "lost-response-1" };
    const first = await json(await api.request(`/api/households/${home.hid}/transactions`, { method: "POST", headers: auth(home.token), body: JSON.stringify(body) }));
    const spending = await json(await api.request(`/api/households/${home.hid}/reports/spending?from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    const retry = await json(await api.request(`/api/households/${home.hid}/transactions`, { method: "POST", headers: auth(home.token), body: JSON.stringify(body) }));
    const after = await json(await api.request(`/api/households/${home.hid}/reports/spending?from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    const list = await json(await api.request(`/api/households/${home.hid}/transactions`, { headers: auth(home.token) }));
    expect(first.status).toBe(201);
    expect(retry.body.duplicate).toBe(true);
    expect(list.body.transactions.filter((txn: { payee: string }) => txn.payee === "Lost response")).toHaveLength(1);
    expect(after.body.totalMinor).toBe(spending.body.totalMinor);
  });

  it("saves a dashboard layout on the user", async () => {
    const api = await app();
    const home = await household(api, "layout@example.com");
    const saved = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token),
      body: JSON.stringify({ dashboardLayout: [{ id: "goals", hidden: true }, { id: "safe", hidden: false }], onboardingStep: "family" }),
    }));
    expect(saved.body.user.dashboardLayout).toEqual([{ id: "goals", hidden: true }, { id: "safe", hidden: false }]);
    expect(saved.body.user.onboardingStep).toBe("family");
    const reset = await json(await api.request("/api/me", { method: "PATCH", headers: auth(home.token), body: JSON.stringify({ dashboardLayout: [] }) }));
    expect(reset.body.user.dashboardLayout).toEqual([]);
  });
});
