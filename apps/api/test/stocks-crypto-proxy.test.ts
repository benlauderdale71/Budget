import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isStocksCryptoPath, proxyStocksCrypto } from "../src/stocks-crypto-proxy.js";

const USER_ID = "ea1fc39f-ce54-4fc8-bdd7-b27511f3ed75";
const keys = generateKeyPairSync("ed25519");
beforeEach(() => vi.stubEnv("BUDGETHQ_SSO_PRIVATE_KEY", keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")));
afterEach(() => vi.unstubAllEnvs());

function claims(headers: Headers, method: string, path: string) {
  const [payload, signature] = (headers.get("x-budgethq-assertion") ?? "").split(".");
  expect(verify(null, Buffer.from(payload), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  expect(value).toMatchObject({ iss: "https://budgethqpro.com", aud: "market-pulse", sub: USER_ID, method, path });
  expect(value.exp - value.iat).toBe(30);
  expect(Math.abs(value.iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
}

it("canonicalizes the section without contacting the upstream or touching unrelated routes", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response("unexpected"); };
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto?q=BTC"), USER_ID, fake);
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe("/stocks-crypto/?q=BTC");
  expect(calls).toBe(0);
  expect(isStocksCryptoPath("/stocks-crypto/analysis")).toBe(true);
  expect(isStocksCryptoPath("/stocks-cryptocurrency")).toBe(false);
  expect((await proxyStocksCrypto(new Request("https://budgethqpro.com/api/me"), USER_ID, fake)).status).toBe(404);
  expect(calls).toBe(0);
});

it("signs the server principal, exact upstream method and path for pages, assets and API queries", async () => {
  for (const [path, target] of [
    ["/stocks-crypto/", "/stocks-crypto/"],
    ["/stocks-crypto/asset/BRK.B", "/stocks-crypto/asset/BRK.B"],
    ["/stocks-crypto/assets/app.js", "/stocks-crypto/assets/app.js"],
    ["/stocks-crypto/analysis?tab=metrics", "/stocks-crypto/analysis?tab=metrics"],
    ["/stocks-crypto/api/markets?search=A%26B", "/api/markets?search=A%26B"],
    ["/stocks-crypto//example.invalid/api/me", "/stocks-crypto//example.invalid/api/me"],
  ]) {
    const fake: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`https://market-pulse-test-test.up.railway.app${target}`);
      claims(new Headers(init?.headers), "GET", target);
      return new Response("market-pulse");
    };
    expect(await (await proxyStocksCrypto(new Request(`https://budgethqpro.com${path}`), USER_ID, fake)).text()).toBe("market-pulse");
  }
});

it("replaces caller identity and excludes all credentials, upstream cookies and Basic challenges", async () => {
  for (const auth of ["Basic dGVzdDpwYXNzd29yZA==", "Bearer budget-session"]) {
    const fake: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      for (const name of ["authorization", "cookie", "host", "origin", "x-forwarded-host", "connection", "transfer-encoding"]) expect(headers.has(name)).toBe(false);
      expect(headers.get("x-budgethq-assertion")).not.toBe("attacker-identity");
      claims(headers, "GET", "/api/paper");
      expect(init?.redirect).toBe("manual");
      return new Response("Sign in", { status: auth.startsWith("Basic") ? 200 : 401, headers: {
        "www-authenticate": 'Basic realm="Market Pulse test"', "set-cookie": "private=secret; Path=/",
        "content-encoding": "gzip", "content-length": "999", "connection": "x-private", "x-private": "secret",
      } });
    };
    const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/api/paper", {
      headers: { authorization: auth, cookie: "budget-session=private", origin: "https://budgethqpro.com", "x-forwarded-host": "evil.invalid", "x-budgethq-assertion": "attacker-identity" },
    }), USER_ID, fake);
    expect(response.status).toBe(auth.startsWith("Basic") ? 200 : 503);
    if (response.status === 503) expect(await response.json()).toMatchObject({ error: expect.stringContaining("shared sign-in") });
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const name of ["www-authenticate", "set-cookie", "content-encoding", "content-length", "connection", "x-private"]) expect(response.headers.has(name)).toBe(false);
  }
});

it("streams mutation bodies and response bytes without changing content", async () => {
  const fake: typeof fetch = async (input, init) => {
    expect(String(input).endsWith("/api/paper/orders?account=sample")).toBe(true);
    expect(init?.method).toBe("POST");
    claims(new Headers(init?.headers), "POST", "/api/paper/orders?account=sample");
    expect(await new Response(init?.body).text()).toBe('{"symbol":"BTC","quantity":1}');
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); controller.close(); } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/api/paper/orders?account=sample", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://budgethqpro.com" }, body: '{"symbol":"BTC","quantity":1}',
  }), USER_ID, fake);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ok: true });
});

it("rejects cross-origin mutations and missing signing configuration before contacting the service", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response("unexpected"); };
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/api/paper/orders", {
    method: "POST", headers: { origin: "https://other.invalid" }, body: "test",
  }), USER_ID, fake);
  expect(response.status).toBe(403);
  vi.stubEnv("BUDGETHQ_SSO_PRIVATE_KEY", "");
  expect((await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/"), USER_ID, fake)).status).toBe(503);
  expect(calls).toBe(0);
});

it("keeps internal redirects under the section and handles HEAD and upstream outages", async () => {
  const fake: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "/api/export?type=json#download" } });
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/sources"), USER_ID, fake);
  expect(response.headers.get("location")).toBe("/stocks-crypto/api/export?type=json#download");
  const head: typeof fetch = async () => new Response("must not be returned", { headers: { "content-type": "text/html" } });
  expect(await (await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/", { method: "HEAD" }), USER_ID, head)).text()).toBe("");
  const failing: typeof fetch = async () => { throw new Error("private transport detail"); };
  const error = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/"), USER_ID, failing);
  expect(error.status).toBe(502);
  expect(await error.text()).not.toContain("private transport detail");
});
