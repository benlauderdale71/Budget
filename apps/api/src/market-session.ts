import type { Hono } from "hono";
import type { Database } from "./db.js";
import { sha256, nowIso } from "./crypto.js";
import { marketSameOrigin } from "./market-identity.js";
import { isStocksCryptoPath, proxyStocksCrypto } from "./stocks-crypto-proxy.js";

export const MARKET_COOKIE = "__Secure-budgethq-market-session";
const COOKIE_ATTRIBUTES = "Path=/stocks-crypto; HttpOnly; Secure; SameSite=Lax";
const clearCookie = () => `${MARKET_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

export async function marketSessionUser(db: Database, token: string): Promise<{ id: string; expiresAt: string } | null> {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) return null;
  const rows = await db.query<{ id: string; expires_at: string }>(
    `SELECT u.id, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.deleted_at IS NULL`,
    [sha256(token), nowIso()],
  );
  return rows[0] ? { id: rows[0].id, expiresAt: rows[0].expires_at } : null;
}

function readMarketCookie(request: Request): string {
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${MARKET_COOKIE}=`));
  if (values.length !== 1) return "";
  try { return decodeURIComponent(values[0].slice(MARKET_COOKIE.length + 1)); } catch { return ""; }
}

function needsDocument(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = new URL(request.url).pathname;
  if (/^\/stocks-crypto\/(?:api|assets)(?:\/|$)/.test(path)) return false;
  const destination = request.headers.get("sec-fetch-dest");
  return destination === "document" || request.headers.get("sec-fetch-mode") === "navigate" || (!destination && (request.headers.get("accept") ?? "").includes("text/html"));
}

function signInResponse(request: Request): Response {
  const headers = new Headers({ "cache-control": "no-store", "set-cookie": clearCookie(), "referrer-policy": "no-referrer" });
  if (!needsDocument(request)) {
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ error: "Sign in to BudgetCents to open Market Pulse.", loginUrl: "/login" }), { status: 401, headers });
  }
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Opening Market Pulse</title><script src="/market-login.js" defer></script></head><body><p id="market-login-status" role="status">Opening Market Pulse…</p></body></html>';
  return new Response(request.method === "HEAD" ? null : html, { headers });
}

export function mountMarketPulse(app: Hono, db: Database, upstreamFetch: typeof fetch = fetch): void {
  app.post("/api/auth/market-session", async (c) => {
    if (!marketSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin requests are not allowed." }, 403);
    const header = c.req.header("authorization") ?? "";
    const token = /^Bearer /i.test(header) ? header.slice(7).trim() : "";
    const user = await marketSessionUser(db, token);
    if (!user) { c.header("Set-Cookie", clearCookie()); return c.json({ error: "Sign in required." }, 401); }
    if (!process.env.BUDGETHQ_SSO_PRIVATE_KEY) return c.json({ error: "Market Pulse sign-in is temporarily unavailable." }, 503);
    const maxAge = Math.min(30 * 86400, Math.max(0, Math.floor((Date.parse(user.expiresAt) - Date.now()) / 1000)));
    c.header("Set-Cookie", `${MARKET_COOKIE}=${encodeURIComponent(token)}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAge}`);
    return c.json({ ok: true });
  });

  const labRequests = new Map<string, { count: number; until: number }>();
  app.use("*", async (c, next) => {
    if (!isStocksCryptoPath(c.req.path)) return next();
    const request = c.req.raw;
    const url = new URL(request.url);
    if (url.pathname === "/stocks-crypto") return c.redirect(`/stocks-crypto/${url.search}`, 308);
    const user = await marketSessionUser(db, readMarketCookie(request));
    if (!user) return signInResponse(request);
    if (request.method === "POST" && url.pathname.startsWith("/stocks-crypto/api/lab/")) {
      const now = Date.now();
      for (const [id, entry] of labRequests) if (entry.until <= now) labRequests.delete(id);
      const entry = labRequests.get(user.id) ?? { count: 0, until: now + 60_000 };
      if (++entry.count > 6) return c.json({ error: "Please wait before running another lab request." }, 429);
      labRequests.set(user.id, entry);
    }
    return proxyStocksCrypto(request, user.id, upstreamFetch);
  });
}
