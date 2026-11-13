import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";
import { fetchFinnhubQuote } from "../src/providers/market.js";

let db: Database;
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db?.close(); });

it("rejects unsupported, empty, future and rate-limited quotes without exposing the key", async () => {
  vi.stubEnv("FINNHUB_API_KEY", "test-key");
  const request = vi.fn().mockResolvedValue(Response.json({ c: 123.456, t: 1735689600 }));
  expect(await fetchFinnhubQuote("ABC", request)).toMatchObject({ priceMinor: 12346, currency: "USD", source: "Finnhub" });
  expect(String(request.mock.calls[0][0])).not.toContain("test-key");
  expect(request.mock.calls[0][1]).toMatchObject({ headers: { "X-Finnhub-Token": "test-key" }, redirect: "error" });
  await expect(fetchFinnhubQuote("NOT:US", request)).rejects.toThrow("U.S.");
  for (const value of [{ c: 0, t: 0 }, { c: 10, t: Math.floor(Date.now() / 1000) + 600 }]) await expect(fetchFinnhubQuote("ABC", vi.fn().mockResolvedValue(Response.json(value)))).rejects.toThrow("valid price");
  await expect(fetchFinnhubQuote("ABC", vi.fn().mockResolvedValue(new Response("", { status: 429 })))).rejects.toThrow("rate limit");
});

it("requires explicit confirmation, preserves the cash ledger, rejects stale previews and rechecks access", async () => {
  vi.stubEnv("FINNHUB_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ c: 12.34, t: Math.floor(Date.now() / 1000) - 60 }))));
  db = await openMemoryDatabase(); const app = createApp(db);
  const owner = await (await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "prices@example.test", password: "test-password-quotes", displayName: "Owner", householdName: "Prices" }) })).json();
  const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
  const hid = (await (await app.request("/api/households", { headers })).json()).households[0].id;
  const base = `/api/households/${hid}`;
  const post = (path: string, body: unknown) => app.request(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const dash = await (await app.request(`${base}/dashboard`, { headers })).json();
  const account = await (await post("/accounts", { spaceId: dash.spaceId, name: "Brokerage", kind: "investment", onBudget: false, openingBalanceMinor: 0, openingDate: "2026-01-01" })).json();
  const holding = await (await post("/holdings", { accountId: account.id, symbol: "ABC", name: "Example", assetClass: "equity", currency: "USD", quantity: "2", priceMinor: 1000, priceAsOf: "2025-01-01" })).json();
  const root = `/holdings/${holding.id}/quote`;
  const before = await db.query(`SELECT * FROM transactions WHERE household_id = $1 ORDER BY id`, [hid]);
  const preview = await (await post(`${root}/preview`, {})).json();
  expect(preview.quote.priceMinor).toBe(1234);
  expect((await db.query(`SELECT * FROM quotes WHERE household_id = $1`, [hid])).length).toBe(1);
  const responses = await Promise.all([post(`${root}/confirm`, { previewId: preview.previewId }), post(`${root}/confirm`, { previewId: preview.previewId })]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect((await db.query(`SELECT * FROM quotes WHERE household_id = $1`, [hid])).length).toBe(2);
  const priced = await (await app.request(`${base}/investments`, { headers })).json();
  expect(priced.positions[0].marketValueMinor).toBe(2468);
  await db.query(`UPDATE provider_rate_limits SET next_at = 0`);
  const stale = await (await post(`${root}/preview`, {})).json();
  await db.query(`INSERT INTO quotes (id, household_id, symbol, price_minor, as_of, source, currency) VALUES ('newer',$1,'ABC',2000,$2,'manual','USD')`, [hid, new Date().toISOString()]);
  expect((await post(`${root}/confirm`, { previewId: stale.previewId })).status).toBe(409);
  await db.query(`UPDATE memberships SET role = 'read_only' WHERE household_id = $1 AND user_id = $2`, [hid, owner.user.id]);
  expect((await post(`${root}/confirm`, { previewId: preview.previewId })).status).toBe(403);
  expect(await db.query(`SELECT * FROM transactions WHERE household_id = $1 ORDER BY id`, [hid])).toEqual(before);
});
