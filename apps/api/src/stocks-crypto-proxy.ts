import { createMarketAssertion, marketSameOrigin } from "./market-identity.js";

const PREFIX = "/stocks-crypto";
const UPSTREAM = "https://market-pulse-test-test.up.railway.app";
const REQUEST_HEADERS = ["accept", "accept-language", "content-type", "range", "if-range", "if-none-match", "if-modified-since"];
const STRIP_RESPONSE_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length", "set-cookie", "access-control-allow-origin", "access-control-allow-credentials"];

export function isStocksCryptoPath(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/** Keep Market Pulse's API, authentication and data separate from the ledger. */
export async function proxyStocksCrypto(request: Request, userId: string, upstreamFetch: typeof fetch = fetch): Promise<Response> {
  const incoming = new URL(request.url);
  if (!isStocksCryptoPath(incoming.pathname)) return new Response("Not found", { status: 404 });
  if (incoming.pathname === PREFIX) {
    return new Response(null, { status: 308, headers: { location: `${PREFIX}/${incoming.search}`, "cache-control": "no-store" } });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (!marketSameOrigin(request)) {
      return new Response("Cross-origin requests are not allowed.", { status: 403, headers: { "cache-control": "no-store" } });
    }
  }
  const target = new URL(UPSTREAM);
  const apiPath = incoming.pathname.slice(PREFIX.length);
  target.pathname = /^\/api(?:\/|$)/.test(apiPath) ? apiPath : incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The upstream sees only a short-lived signed principal, never a password,
  // Budget cookie, bearer token, or caller-supplied identity header.
  try { headers.set("x-budgethq-assertion", createMarketAssertion(userId, request.method, `${target.pathname}${target.search}`)); }
  catch { return new Response("Market Pulse sign-in is temporarily unavailable.", { status: 503, headers: { "cache-control": "no-store" } }); }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  try {
    const upstream = await upstreamFetch(target, init);
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      return new Response(JSON.stringify({ error: "Market Pulse could not verify the shared sign-in. Please try again shortly." }), {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    const responseHeaders = new Headers(upstream.headers);
    const connectionHeaders = (responseHeaders.get("connection") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    for (const name of [...STRIP_RESPONSE_HEADERS, ...connectionHeaders]) responseHeaders.delete(name);
    responseHeaders.delete("www-authenticate");
    const location = responseHeaders.get("location");
    if (location) {
      const resolved = new URL(location, target);
      if (resolved.origin === target.origin) {
        const pathname = isStocksCryptoPath(resolved.pathname) ? resolved.pathname : `${PREFIX}${resolved.pathname}`;
        responseHeaders.set("location", `${pathname}${resolved.search}${resolved.hash}`);
      }
    }
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("referrer-policy", "no-referrer");
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch {
    return new Response("Stocks & Crypto is temporarily unavailable. Please try again shortly.", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
