import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";
import { randomToken, sha256 } from "../src/crypto.js";
import { MARKET_COOKIE, marketSessionUser, mountMarketPulse } from "../src/market-session.js";
import { marketSameOrigin } from "../src/market-identity.js";

let db: Database | undefined;
const keys = generateKeyPairSync("ed25519");
afterEach(async () => { await db?.close(); db = undefined; vi.unstubAllEnvs(); });

async function fixture() {
  vi.stubEnv("BUDGETHQ_SSO_PRIVATE_KEY", keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  db = await openMemoryDatabase();
  const userId = randomUUID(), token = randomToken(), sessionId = randomUUID();
  const now = new Date().toISOString(), expires = new Date(Date.now() + 5 * 60_000).toISOString();
  await db.query(`INSERT INTO users (id,email,password_hash,display_name,created_at) VALUES ($1,$2,$3,$4,$5)`, [userId, `${userId}@example.invalid`, "test-fixture-only", "Fixture", now]);
  await db.query(`INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, [sessionId, userId, sha256(token), now, expires]);
  const calls: { url: string; headers: Headers; method?: string }[] = [];
  const upstream: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), headers, method: init?.method });
    return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  };
  const app = createApp(db);
  mountMarketPulse(app, db, upstream);
  const cookie = `${MARKET_COOKIE}=${token}`;
  const bearer = { authorization: `Bearer ${token}`, origin: "https://budgethqpro.com" };
  return { app, userId, token, sessionId, cookie, bearer, calls, expires };
}

it("mints only an HttpOnly section cookie from a valid Budget session and signs the validated user", async () => {
  const f = await fixture();
  const response = await f.app.request("http://budgethqpro.com/api/auth/market-session", { method: "POST", headers: f.bearer });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const cookie = response.headers.get("set-cookie") ?? "";
  for (const flag of [`${MARKET_COOKIE}=${f.token}`, "Path=/stocks-crypto", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(flag);
  expect(cookie).not.toContain("Domain=");
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
  expect(maxAge).toBeGreaterThan(290); expect(maxAge).toBeLessThanOrEqual(300);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const market = await f.app.request("http://budgethqpro.com/stocks-crypto/api/auth/session?check=1", { headers: { cookie: f.cookie, authorization: "Basic arbitrary", "x-budgethq-assertion": "forged" } });
  expect(market.status).toBe(200);
  const forwarded = f.calls[0];
  expect(forwarded.url).toBe("https://market-pulse-test-test.up.railway.app/api/auth/session?check=1");
  expect(forwarded.headers.has("authorization")).toBe(false); expect(forwarded.headers.has("cookie")).toBe(false);
  const [payload, signature] = (forwarded.headers.get("x-budgethq-assertion") ?? "").split(".");
  expect(verify(null, Buffer.from(payload), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({ sub: f.userId, aud: "market-pulse", method: "GET", path: "/api/auth/session?check=1" });
});

it("rejects absent, malformed and duplicate cookies and never accepts Basic or bearer as a market cookie", async () => {
  const f = await fixture();
  const attempts: Record<string, string>[] = [
    {}, { authorization: "Basic dGVzdGVyOnNlY3JldA==" }, { authorization: `Bearer ${f.token}` },
    { cookie: `${MARKET_COOKIE}=%broken` }, { cookie: `${f.cookie}; ${f.cookie}` }, { cookie: `${MARKET_COOKIE}=unknown-token-with-a-long-but-invalid-session-value` },
  ];
  for (const headers of attempts) {
    const denied = await f.app.request("https://budgethqpro.com/stocks-crypto/api/market/holdings", { headers });
    expect(denied.status).toBe(401);
    expect(denied.headers.has("www-authenticate")).toBe(false);
    expect(denied.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(denied.headers.get("cache-control")).toBe("no-store");
  }
  expect(f.calls).toHaveLength(0);
});

it("serves an anonymous document handoff but protects assets and API responses", async () => {
  const f = await fixture();
  const response = await f.app.request("https://budgethqpro.com/stocks-crypto/analysis?symbol=BTC", { headers: { accept: "text/html", "sec-fetch-dest": "document" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  const html = await response.text();
  expect(html).toContain('src="/market-login.js"');
  expect(html).not.toContain(f.token); expect(html).not.toContain(f.userId);
  for (const path of ["/stocks-crypto/assets/index.js", "/stocks-crypto/api/market/paper"]) {
    const asset = await f.app.request(`https://budgethqpro.com${path}`, { headers: { accept: "text/html", "sec-fetch-dest": "script" } });
    expect(asset.status).toBe(401);
    expect(asset.headers.get("content-type")).toContain("application/json");
  }
  const canonical = await f.app.request("https://budgethqpro.com/stocks-crypto?tab=quotes");
  expect(canonical.status).toBe(308);
  expect(canonical.headers.get("location")).toBe("/stocks-crypto/?tab=quotes");
  expect(f.calls).toHaveLength(0);
});

it("rejects expired, revoked and deleted-user sessions both at minting and on every proxy request", async () => {
  const f = await fixture();
  const mint = () => f.app.request("https://budgethqpro.com/api/auth/market-session", { method: "POST", headers: f.bearer });
  const view = () => f.app.request("https://budgethqpro.com/stocks-crypto/api/auth/session", { headers: { cookie: f.cookie } });
  expect((await view()).status).toBe(200);
  for (const state of ["expired", "revoked", "deleted"] as const) {
    await db!.query(`UPDATE sessions SET expires_at=$1, revoked_at=$2 WHERE id=$3`, [state === "expired" ? "2000-01-01T00:00:00.000Z" : f.expires, state === "revoked" ? new Date().toISOString() : null, f.sessionId]);
    await db!.query(`UPDATE users SET deleted_at=$1 WHERE id=$2`, [state === "deleted" ? new Date().toISOString() : null, f.userId]);
    expect(await marketSessionUser(db!, f.token)).toBeNull();
    expect((await mint()).status, state).toBe(401);
    expect((await view()).status, state).toBe(401);
  }
  expect(f.calls).toHaveLength(1);
});

it("refuses long-lived API tokens even when the normal ledger API accepts them", async () => {
  const f = await fixture();
  const token = randomToken();
  await db!.query(`INSERT INTO api_tokens (id,user_id,name,token_hash,created_at) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), f.userId, "fixture API", sha256(token), new Date().toISOString()]);
  expect((await f.app.request("https://budgethqpro.com/api/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  const mint = await f.app.request("https://budgethqpro.com/api/auth/market-session", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(mint.status).toBe(401);
  expect((await f.app.request("https://budgethqpro.com/stocks-crypto/api/auth/session", { headers: { cookie: `${MARKET_COOKIE}=${token}` } })).status).toBe(401);
  expect(f.calls).toHaveLength(0);
});

it("honors actual Budget logout and does not turn the cookie into ledger API authorization", async () => {
  const f = await fixture();
  expect((await f.app.request("https://budgethqpro.com/stocks-crypto/api/auth/session", { headers: { cookie: f.cookie } })).status).toBe(200);
  expect((await f.app.request("https://budgethqpro.com/api/me", { headers: { cookie: f.cookie } })).status).toBe(401);
  const logout = await f.app.request("https://budgethqpro.com/api/auth/logout", { method: "POST", headers: f.bearer });
  expect(logout.status).toBe(200);
  expect((await f.app.request("https://budgethqpro.com/stocks-crypto/api/auth/session", { headers: { cookie: f.cookie } })).status).toBe(401);
  expect((await f.app.request("https://budgethqpro.com/api/auth/market-session", { method: "POST", headers: f.bearer })).status).toBe(401);
  expect(f.calls).toHaveLength(1);
});

it("blocks cross-origin cookie issuance and mutations while supporting TLS termination", async () => {
  const f = await fixture();
  const attempts: Record<string, string>[] = [{ origin: "https://attacker.invalid" }, { origin: "https://budgethqpro.com", "sec-fetch-site": "cross-site" }];
  for (const headers of attempts) {
    expect((await f.app.request("http://budgethqpro.com/api/auth/market-session", { method: "POST", headers: { ...f.bearer, ...headers } })).status).toBe(403);
    expect((await f.app.request("http://budgethqpro.com/stocks-crypto/api/market/paper/orders", { method: "POST", headers: { cookie: f.cookie, ...headers }, body: "{}" })).status).toBe(403);
  }
  expect((await f.app.request("http://budgethqpro.com/stocks-crypto/api/market/paper/orders", { method: "POST", headers: { cookie: f.cookie, origin: "https://budgethqpro.com" }, body: "{}" })).status).toBe(200);
  expect(marketSameOrigin(new Request("http://www.budgethqpro.com/stocks-crypto/", { headers: { origin: "https://www.budgethqpro.com" } }))).toBe(true);
  expect(marketSameOrigin(new Request("http://budgethqpro.com/stocks-crypto/", { headers: { origin: "http://budgethqpro.com" } }))).toBe(false);
  expect(f.calls).toHaveLength(1);
});

it("keeps unavailable signing configuration closed and bounds potentially paid lab requests", async () => {
  const f = await fixture();
  vi.stubEnv("BUDGETHQ_SSO_PRIVATE_KEY", "");
  expect((await f.app.request("https://budgethqpro.com/api/auth/market-session", { method: "POST", headers: f.bearer })).status).toBe(503);
  expect((await f.app.request("https://budgethqpro.com/stocks-crypto/api/auth/session", { headers: { cookie: f.cookie } })).status).toBe(503);
  expect(f.calls).toHaveLength(0);
  vi.stubEnv("BUDGETHQ_SSO_PRIVATE_KEY", keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await f.app.request("https://budgethqpro.com/stocks-crypto/api/lab/forecast", { method: "POST", headers: { cookie: f.cookie, origin: "https://budgethqpro.com" }, body: "{}" });
    expect(response.status).toBe(attempt < 6 ? 200 : 429);
  }
  expect(f.calls).toHaveLength(6);
});
