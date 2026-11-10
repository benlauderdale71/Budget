import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
const store = new Map<string, string>();

afterEach(async () => {
  await db?.close();
  store.clear();
  delete (globalThis as { window?: unknown }).window;
});

function installBrowser() {
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: () => null,
    length: store.size,
  };
  Object.assign(globalThis, { localStorage: storage, window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, location: { pathname: "/" } } });
}

async function client() {
  const specifier = "../../web/src/api.ts";
  return import(specifier);
}

describe("lost response retry", () => {
  it("commits once when the response is dropped and the normal queue retries", async () => {
    db = await openMemoryDatabase();
    installBrowser();
    const app = createApp(db);
    let drop = true;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const response = await app.request(path, init);
      if (drop && path.includes("/transactions") && (init?.method ?? "GET").toUpperCase() === "POST") {
        drop = false;
        throw new TypeError("connection reset");
      }
      return response;
    };
    const registered = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "lost@example.com", password: "correct-horse", displayName: "Lost", householdName: "Lost home" }),
    });
    const session = await registered.json() as { token: string; user: { id: string } };
    const homes = await (await app.request("/api/households", { headers: { authorization: `Bearer ${session.token}` } })).json() as { households: { id: string }[] };
    const hid = homes.households[0].id;
    const dash = await (await app.request(`/api/households/${hid}/dashboard`, { headers: { authorization: `Bearer ${session.token}` } })).json() as { spaceId: string };
    const account = await (await app.request(`/api/households/${hid}/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ spaceId: dash.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 8000, openingDate: "2026-11-01" }),
    })).json() as { id: string };
    store.set("budgetcents.token", session.token);
    const { api, flushQueue, setQueueOwner } = await client();
    setQueueOwner(session.user.id);
    await expect(api(`/api/households/${hid}/transactions`, {
      method: "POST",
      body: JSON.stringify({ date: "2026-11-09", accountId: account.id, amountMinor: -450, type: "expense", payee: "Dropped", bankStatus: "posted", splits: [], opId: "drop-1" }),
    })).rejects.toThrow(/offline|did not finish/i);
    const queued = JSON.parse(store.get("budgetcents.queue") ?? "[]") as { path: string; opId: string; ownerId: string }[];
    expect(queued).toHaveLength(1);
    expect(queued[0].opId).toBe("drop-1");
    expect(queued[0].path).toContain(hid);
    const committed = await db.query(`SELECT id FROM transactions WHERE payee = 'Dropped' AND deleted = 0`);
    expect(committed).toHaveLength(1);
    const flushed = await flushQueue();
    expect(flushed.sent).toBe(1);
    expect(flushed.rejected).toBe("");
    expect(await db.query(`SELECT id FROM transactions WHERE payee = 'Dropped' AND deleted = 0`)).toHaveLength(1);
    const report = await (await app.request(`/api/households/${hid}/reports/spending?from=2026-11-01&to=2026-11-30`, { headers: { authorization: `Bearer ${session.token}` } })).json() as { totalMinor: number };
    expect(report.totalMinor).toBe(450);

    store.set("budgetcents.queue", JSON.stringify([{
      path: `/api/households/${hid}/transactions`,
      method: "POST",
      body: JSON.stringify({ date: "2026-11-09", accountId: account.id, amountMinor: 1.5, type: "expense", payee: "Bad cents", bankStatus: "posted", splits: [], opId: "bad-1" }),
      at: 1,
      ownerId: session.user.id,
      opId: "bad-1",
    }]));
    const rejected = await flushQueue();
    expect(rejected.rejected).toMatch(/integer/i);
    expect(JSON.parse(store.get("budgetcents.queue") ?? "[]")).toEqual([]);
    expect(await db.query(`SELECT id FROM transactions WHERE payee = 'Bad cents'`)).toHaveLength(0);

    store.set("budgetcents.queue", JSON.stringify([{
      path: `/api/households/${hid}/transactions`,
      method: "POST",
      body: JSON.stringify({ date: "2026-11-09", accountId: account.id, amountMinor: -100, type: "expense", payee: "Waiting", bankStatus: "posted", splits: [], opId: "wait-1" }),
      at: 2,
      ownerId: session.user.id,
      opId: "wait-1",
    }]));
    store.delete("budgetcents.token");
    const signedOut = await flushQueue();
    expect(signedOut.sent).toBe(0);
    expect(JSON.parse(store.get("budgetcents.queue") ?? "[]")).toHaveLength(1);
    store.set("budgetcents.token", session.token);
    store.set("budgetcents.household", "some-other-household");
    const stillHere = await flushQueue();
    expect(stillHere.sent).toBe(1);
    const waiting = await db.query(`SELECT household_id FROM transactions WHERE payee = 'Waiting' AND deleted = 0`);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].household_id).toBe(hid);
  });
});
