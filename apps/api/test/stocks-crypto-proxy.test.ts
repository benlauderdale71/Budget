import { expect, it } from "vitest";
import { isStocksCryptoPath, proxyStocksCrypto } from "../src/stocks-crypto-proxy.js";

it("canonicalizes the section before authentication without touching unrelated routes", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response("unexpected"); };
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto?q=BTC"), fake);
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe("/stocks-crypto/?q=BTC");
  expect(calls).toBe(0);
  expect(isStocksCryptoPath("/stocks-crypto/analysis")).toBe(true);
  expect(isStocksCryptoPath("/stocks-cryptocurrency")).toBe(false);
  expect((await proxyStocksCrypto(new Request("https://budgethqpro.com/api/me"), fake)).status).toBe(404);
  expect(calls).toBe(0);
});

it("routes full pages, assets, deep links, queries and API calls to the fixed origin", async () => {
  for (const [path, target] of [
    ["/stocks-crypto/", "/stocks-crypto/"],
    ["/stocks-crypto/asset/BRK.B", "/stocks-crypto/asset/BRK.B"],
    ["/stocks-crypto/assets/app.js", "/stocks-crypto/assets/app.js"],
    ["/stocks-crypto/analysis?tab=metrics", "/stocks-crypto/analysis?tab=metrics"],
    ["/stocks-crypto/api/markets?search=A%26B", "/api/markets?search=A%26B"],
    ["/stocks-crypto//example.invalid/api/me", "/stocks-crypto//example.invalid/api/me"],
  ]) {
    const fake: typeof fetch = async (input) => {
      expect(String(input)).toBe(`https://market-pulse-test-test.up.railway.app${target}`);
      return new Response("market-pulse");
    };
    expect(await (await proxyStocksCrypto(new Request(`https://budgethqpro.com${path}`), fake)).text()).toBe("market-pulse");
  }
});

it("preserves the existing login challenge and excludes Budget credentials and upstream cookies", async () => {
  for (const auth of ["Basic dGVzdDpwYXNzd29yZA==", "Bearer budget-session"]) {
    const fake: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(auth.startsWith("Basic") ? auth : null);
      for (const name of ["cookie", "host", "origin", "x-forwarded-host", "connection", "transfer-encoding"]) expect(headers.has(name)).toBe(false);
      expect(init?.redirect).toBe("manual");
      return new Response("Sign in", { status: 401, headers: {
        "www-authenticate": 'Basic realm="Market Pulse test"',
        "set-cookie": "private=secret; Path=/",
        "content-encoding": "gzip", "content-length": "999", "connection": "x-private", "x-private": "secret",
      } });
    };
    const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/api/paper", {
      headers: { authorization: auth, cookie: "budget-session=private", origin: "https://budgethqpro.com", "x-forwarded-host": "evil.invalid" },
    }), fake);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const name of ["set-cookie", "content-encoding", "content-length", "connection", "x-private"]) expect(response.headers.has(name)).toBe(false);
  }
});

it("streams original mutation bodies and response bytes without changing their content", async () => {
  const fake: typeof fetch = async (input, init) => {
    expect(String(input).endsWith("/api/paper/orders?account=sample")).toBe(true);
    expect(init?.method).toBe("POST");
    expect(await new Response(init?.body).text()).toBe('{"symbol":"BTC","quantity":1}');
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); controller.close(); } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/api/paper/orders?account=sample", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://budgethqpro.com" }, body: '{"symbol":"BTC","quantity":1}',
  }), fake);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ok: true });
});

it("rejects cross-origin mutations before contacting the service", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response("unexpected"); };
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/api/paper/orders", {
    method: "POST", headers: { origin: "https://other.invalid" }, body: "test",
  }), fake);
  expect(response.status).toBe(403);
  expect(calls).toBe(0);
});

it("keeps internal redirects under the section and handles HEAD and upstream outages", async () => {
  const fake: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "/api/export?type=json#download" } });
  const response = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/sources"), fake);
  expect(response.headers.get("location")).toBe("/stocks-crypto/api/export?type=json#download");
  const head: typeof fetch = async () => new Response("must not be returned", { headers: { "content-type": "text/html" } });
  expect(await (await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/", { method: "HEAD" }), head)).text()).toBe("");
  const failing: typeof fetch = async () => { throw new Error("private transport detail"); };
  const error = await proxyStocksCrypto(new Request("https://budgethqpro.com/stocks-crypto/"), failing);
  expect(error.status).toBe(502);
  expect(await error.text()).not.toContain("private transport detail");
});
