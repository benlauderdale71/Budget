import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";
import { claimSimplefin, fetchSimplefin, simplefinTransactions, simplefinUrl } from "../src/providers/simplefin.js";

let db: Database;
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await db?.close(); });
const access = "https://test:secret@bridge.simplefin.org/simplefin";
const token = Buffer.from("https://bridge.simplefin.org/simplefin/claim/test").toString("base64");
const payload = { accounts: [{ id: "bank-account", name: "Test checking", currency: "USD", balance: "100.00", "balance-date": 1794528000, transactions: [{ id: "txn-1", posted: 1794528000, amount: "-2.50", description: "Market" }] }], errlist: [] };

describe("SimpleFIN adapter", () => {
  it("uses HTTPS allowlisted hosts, explicit Basic auth, timeouts and no redirects", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(access)).mockResolvedValueOnce(Response.json(payload));
    expect(await claimSimplefin(token, request)).toBe(access);
    const data = await fetchSimplefin(access, 1794500000, 1794600000, request);
    expect(simplefinTransactions(data.accounts[0])[0]).toMatchObject({ amountMinor: -250, externalId: "txn-1" });
    const [url, init] = request.mock.calls[1];
    expect(String(url)).not.toContain("secret");
    expect(url.searchParams.get("pending")).toBe("0");
    expect(init).toMatchObject({ redirect: "error", headers: { authorization: `Basic ${Buffer.from("test:secret").toString("base64")}` } });
    for (const value of ["http://bridge.simplefin.org/simplefin/claim/x", "https://127.0.0.1/simplefin/claim/x", "https://bridge.simplefin.org.attacker.test/simplefin/claim/x", "https://bridge.simplefin.org:123/simplefin/claim/x"]) expect(() => simplefinUrl(value, true)).toThrow();
    await expect(fetchSimplefin(access, 0, 91 * 86400, request)).rejects.toThrow("90 days");
  });

  it("retains provider errors and keeps pending rows out of posted imports", async () => {
    const data = await fetchSimplefin(access, 1, 100, vi.fn().mockResolvedValue(Response.json({ ...payload, errlist: [{ code: "connection", message: "Reconnect your credit union" }] })));
    expect(data.warnings).toContain("Reconnect your credit union");
    expect(simplefinTransactions({ ...payload.accounts[0], transactions: [{ ...payload.accounts[0].transactions[0], pending: true, posted: 0 }] })).toEqual([]);
    await expect(fetchSimplefin(access, 1, 100, vi.fn().mockResolvedValue(new Response("", { status: 403 })))).rejects.toThrow("revoked");
  });

  it("previews without writes, imports once, protects credentials and isolates each owner's connection", async () => {
    vi.stubEnv("BUDGETCENTS_PROVIDER_KEY", "11".repeat(32));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: URL) => url.pathname.includes("/claim/") ? new Response(access) : Response.json(payload)));
    db = await openMemoryDatabase();
    const app = createApp(db);
    const register = async (email: string) => (await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "bank-test-password", displayName: email, householdName: email }) })).json();
    const owner = await register("bank-owner@example.test");
    const editor = await register("bank-editor@example.test");
    const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const otherHeaders = { ...headers, authorization: `Bearer ${editor.token}` };
    const hid = (await (await app.request("/api/households", { headers })).json()).households[0].id;
    await db.query(`INSERT INTO memberships (household_id,user_id,role,created_at) VALUES ($1,$2,'editor',$3)`, [hid, editor.user.id, new Date().toISOString()]);
    const dash = await (await app.request(`/api/households/${hid}/dashboard`, { headers })).json();
    const account = await (await app.request(`/api/households/${hid}/accounts`, { method: "POST", headers, body: JSON.stringify({ spaceId: dash.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-01-01" }) })).json();
    const secret = await (await app.request(`/api/households/${hid}/accounts`, { method: "POST", headers, body: JSON.stringify({ spaceId: dash.spaceId, name: "Private savings", kind: "savings", visibility: "private", onBudget: true, openingBalanceMinor: 0, openingDate: "2026-01-01" }) })).json();
    const visible = await (await app.request(`/api/households/${hid}/accounts`, { headers })).json();
    expect(visible.accounts.find((a: { id: string }) => a.id === account.id)).toMatchObject({ name: "Checking", currency: "USD" });
    expect(visible.accounts.some((a: { id: string }) => a.id === secret.id)).toBe(true);
    const otherVisible = await (await app.request(`/api/households/${hid}/accounts`, { headers: otherHeaders })).json();
    expect(otherVisible.accounts.some((a: { id: string }) => a.id === secret.id)).toBe(false);
    const post = (path: string, body: unknown, h = headers) => app.request(`/api/households/${hid}/providers/simplefin${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const linked = await (await post("/connect", { setupToken: token, label: "My bank", consent: true })).json();
    const stored = await db.query(`SELECT secret FROM bank_links WHERE id = $1`, [linked.id]);
    expect(stored[0].secret).not.toContain("secret@");
    const before = await db.query(`SELECT id, amount_minor FROM transactions WHERE household_id = $1 ORDER BY id`, [hid]);
    const previewResponse = await post(`/${linked.id}/preview`, {});
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(await db.query(`SELECT id, amount_minor FROM transactions WHERE household_id = $1 ORDER BY id`, [hid])).toEqual(before);
    expect((await post(`/${linked.id}/preview`, {}, otherHeaders)).status).toBe(404);
    const body = { previewId: preview.previewId, externalAccountId: "bank-account", accountId: account.id, rows: [{ externalId: "txn-1", type: "expense" }] };
    const [a, b] = await Promise.all([post(`/${linked.id}/import`, body), post(`/${linked.id}/import`, body)]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const results = await Promise.all([a.json(), b.json()]);
    expect(results.map((r) => r.imported).sort()).toEqual([0, 1]);
    const after = await db.query(`SELECT amount_minor FROM transactions WHERE household_id = $1 AND payee = 'Market'`, [hid]);
    expect(after).toEqual([{ amount_minor: -250 }]);
    await post(`/${linked.id}/revoke`, {});
    expect((await post(`/${linked.id}/preview`, {})).status).toBe(404);
    expect((await db.query(`SELECT secret, cache_json FROM bank_links WHERE id = $1`, [linked.id]))[0]).toMatchObject({ secret: "", cache_json: null });
    const reconnected = await (await post("/connect", { setupToken: token, label: "Reconnected", consent: true })).json();
    const again = await (await post(`/${reconnected.id}/preview`, {})).json();
    expect(again.accounts[0].rows[0].status).toBe("imported");
    const repeat = await (await post(`/${reconnected.id}/import`, { ...body, previewId: again.previewId })).json();
    expect(repeat).toMatchObject({ imported: 0, duplicates: 1 });
    expect(await db.query(`SELECT amount_minor FROM transactions WHERE household_id = $1 AND payee = 'Market'`, [hid])).toEqual(after);
  });
});
