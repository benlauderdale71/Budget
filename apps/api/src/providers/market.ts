import type { Context, Hono } from "hono";
import { z } from "zod";
import { multiplyDecimalByMinor } from "@budgetcents/domain";
import { id, nowIso } from "../crypto.js";
import type { Database } from "../db.js";
import { ApiError, type Actor, assertWrite, audit, canSeeAccount, lockHousehold, requireMember } from "../finance.js";

export async function fetchFinnhubQuote(symbol: string, request: typeof fetch = fetch) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) throw new ApiError(503, "Finnhub is not connected. Add the server API key first.");
  if (!/^[A-Z][A-Z0-9.\-]{0,19}$/.test(symbol)) throw new ApiError(400, "Choose a U.S. stock or ETF ticker.");
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", symbol);
  const response = await request(url, { headers: { "X-Finnhub-Token": token }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (response.status === 429) throw new ApiError(429, "Finnhub's rate limit was reached. Try later.");
  if (!response.ok) throw new ApiError(502, "Finnhub could not provide this quote. Check the server key and plan coverage.");
  const result = z.object({ c: z.number().positive().finite(), t: z.number().int().positive() }).safeParse(await response.json());
  if (!result.success || result.data.t > Date.now() / 1000 + 300) throw new ApiError(502, "Finnhub did not return a valid price and date. The saved price was kept.");
  const priceMinor = multiplyDecimalByMinor(String(result.data.c), 100);
  if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0) throw new ApiError(502, "This quote cannot be represented in cents.");
  return { symbol, priceMinor, currency: "USD", asOf: new Date(result.data.t * 1000).toISOString(), source: "Finnhub", retrievedAt: nowIso() };
}

export function mountMarketRoutes(app: Hono, db: Database, actor: (c: Context) => Promise<Actor>) {
  async function holding(userId: string, hid: string, holdingId: string) {
    assertWrite(await requireMember(db, userId, hid));
    const rows = await db.query(`SELECT h.*, a.visibility, a.owner_user_id, s.kind AS space_kind, s.owner_user_id AS space_owner FROM holdings h JOIN accounts a ON a.id = h.account_id JOIN spaces s ON s.id = a.space_id WHERE h.id = $1 AND h.household_id = $2 AND a.household_id = $2 AND a.archived = 0`, [holdingId, hid]);
    const row = rows[0];
    if (!row || !canSeeAccount(userId, { visibility: String(row.visibility), owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id) }) || (row.space_kind === "personal" && row.space_owner && row.space_owner !== userId)) throw new ApiError(404, "Holding not found.");
    if (row.currency !== "USD") throw new ApiError(400, "This connection prices U.S. stocks and ETFs in USD. Other holdings keep their manual prices.");
    return row;
  }
  const latest = async (hid: string, symbol: string) => (await db.query(`SELECT id, as_of FROM quotes WHERE household_id = $1 AND symbol = $2 AND currency = 'USD' ORDER BY as_of DESC, saved_sequence DESC LIMIT 1`, [hid, symbol]))[0];
  app.post("/api/households/:hid/holdings/:id/quote/preview", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const before = await holding(me.id, hid, c.req.param("id"));
    const previous = await latest(hid, String(before.symbol));
    // One server key is shared by callers; reserve capacity across processes before HTTP.
    await db.tx(async () => {
      await db.query(`INSERT INTO provider_rate_limits (provider, next_at) VALUES ('finnhub',0) ON CONFLICT DO NOTHING`);
      const row = (await db.query(`SELECT next_at FROM provider_rate_limits WHERE provider = 'finnhub' FOR UPDATE`))[0];
      if (Number(row.next_at) > Date.now()) throw new ApiError(429, "Wait two seconds before requesting another price.");
      await db.query(`UPDATE provider_rate_limits SET next_at = $1 WHERE provider = 'finnhub'`, [Date.now() + 2000]);
    });
    const quote = await fetchFinnhubQuote(String(before.symbol));
    const previewId = id();
    await db.tx(async () => {
      await lockHousehold(db, hid);
      await holding(me.id, hid, String(before.id));
      await db.query(`INSERT INTO quote_previews (id, household_id, user_id, holding_id, previous_id, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [previewId, hid, me.id, before.id, previous?.id ?? null, JSON.stringify(quote), nowIso()]);
    });
    return c.json({ previewId, quote, note: "Review this price and its date. Confirming updates investment valuations, including net worth, but does not post a transaction or change cash or Ready to Assign. Prices may be delayed. This feed is for personal use under your provider plan." });
  });
  app.post("/api/households/:hid/holdings/:id/quote/confirm", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const body = z.object({ previewId: z.string() }).parse(await c.req.json());
    return c.json(await db.tx(async () => {
      await lockHousehold(db, hid);
      const current = await holding(me.id, hid, c.req.param("id"));
      const row = (await db.query(`SELECT * FROM quote_previews WHERE id = $1 AND household_id = $2 AND user_id = $3 AND holding_id = $4`, [body.previewId, hid, me.id, current.id]))[0];
      if (!row) throw new ApiError(404, "Price preview not found.");
      if (row.applied_at) return { saved: true, duplicate: true };
      if (Date.now() - Date.parse(String(row.created_at)) > 15 * 60000) throw new ApiError(409, "This preview expired. Fetch a new quote.");
      const quote = JSON.parse(String(row.payload)) as Awaited<ReturnType<typeof fetchFinnhubQuote>>;
      const prior = await latest(hid, String(current.symbol));
      if (quote.symbol !== current.symbol || (prior?.id ?? null) !== row.previous_id || (prior && Date.parse(String(prior.as_of)) > Date.parse(quote.asOf))) throw new ApiError(409, "The saved holding or price changed, or is newer. Fetch a new quote before replacing it.");
      await db.query(`INSERT INTO quotes (id, household_id, symbol, price_minor, as_of, source, delayed, currency) VALUES ($1,$2,$3,$4,$5,'Finnhub',1,'USD')`, [id(), hid, quote.symbol, quote.priceMinor, quote.asOf]);
      await db.query(`UPDATE quote_previews SET applied_at = $1 WHERE id = $2`, [nowIso(), row.id]);
      await audit(db, hid, me.id, "quote.save", "Saved a market price. Cash and the register were unchanged.", "account", String(current.account_id));
      return { saved: true, duplicate: false };
    }));
  });
}
