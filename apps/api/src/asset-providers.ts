import { z } from "zod";
import { ApiError } from "./finance.js";

const safeRequest = () => ({ redirect: "error" as const, signal: AbortSignal.timeout(10_000) });

export async function decodeVehicle(vin: string, fetcher = fetch) {
  const response = await fetcher("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/" + vin + "?format=json", safeRequest());
  const record = response.ok ? (await response.json()).Results?.[0] : null;
  if (!record || record.ErrorCode !== "0" || !record.Make || !record.Model || !record.ModelYear) {
    throw new ApiError(422, "NHTSA could not verify the complete VIN. Check the characters or enter the vehicle manually.");
  }
  const values = z.object({ Make: z.string().max(100), Model: z.string().max(100), ModelYear: z.string().regex(/^\d{4}$/),
    Trim: z.string().max(200).optional(), DriveType: z.string().max(200).optional() }).parse(record);
  return { brand: values.Make, model: values.Model, attributes: [
    {label:"Model year", value: values.ModelYear}, {label:"Trim", value: values.Trim ?? ""}, {label:"Drivetrain", value: values.DriveType ?? ""},
  ].filter(item => item.value) };
}

export async function assetExchangeRate(from: string, to: string, date: string, fetcher = fetch) {
  if (from === to) return { date, rate: 1 };
  const url = new URL("https://api.frankfurter.dev/v2/rates");
  const weekStart = new Date(Date.parse(date)-6*86400000).toISOString().slice(0,10);
  url.search = new URLSearchParams({ from:weekStart, to:date, base: from, quotes: to }).toString();
  const response = await fetcher(url, safeRequest());
  if (!response.ok) throw new ApiError(422, "An exchange rate was unavailable for that sale date and currency.");
  const rows = z.array(z.object({ base: z.string(), quote: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rate: z.number().positive() }))
    .parse(await response.json());
  const result = rows.sort((a,b)=>b.date.localeCompare(a.date)).find(row => row.base === from && row.quote === to && row.date <= date && Date.parse(date) - Date.parse(row.date) < 7 * 86400000);
  if (!result) throw new ApiError(422, "An exchange rate was unavailable for that sale date and currency.");
  return { date:result.date, rate:result.rate };
}

export function marketplaceAvailable() {
  return Boolean(process.env.ASSET_EBAY_CLIENT_ID && process.env.ASSET_EBAY_CLIENT_SECRET);
}
let tokenRequest: Promise<{ token: string; expires: number }> | undefined;
async function requestToken(fetcher: typeof fetch) {
  const credential = Buffer.from(process.env.ASSET_EBAY_CLIENT_ID + ":" + process.env.ASSET_EBAY_CLIENT_SECRET).toString("base64");
  const response = await fetcher("https://api.ebay.com/identity/v1/oauth2/token", {
    ...safeRequest(), method: "POST", headers: { authorization:"Basic " + credential, "content-type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type:"client_credentials", scope:"https://api.ebay.com/oauth/api_scope" }),
  });
  if (!response.ok) throw new Error("Marketplace authentication failed");
  const data = z.object({ access_token: z.string().min(1), expires_in: z.number().int().min(60) }).parse(await response.json());
  return { token: data.access_token, expires: Date.now() + (data.expires_in - 45) * 1000 };
}

export async function ebayAskingPrices(query: string, fetcher = fetch) {
  if (!marketplaceAvailable()) throw new ApiError(503, "Marketplace listings are not configured.");
  try {
    tokenRequest ??= requestToken(fetcher);
    let auth = await tokenRequest;
    if (auth.expires <= Date.now()) {
      if ((await tokenRequest).expires <= Date.now()) tokenRequest = requestToken(fetcher);
      auth = await tokenRequest;
    }
    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    url.search = new URLSearchParams({ q: query, limit:"25", filter:"buyingOptions:{FIXED_PRICE}" }).toString();
    const response = await fetcher(url, { ...safeRequest(), headers: {
      authorization:"Bearer " + auth.token, "X-EBAY-C-MARKETPLACE-ID":"EBAY_US",
    } });
    if (!response.ok) throw new Error("Marketplace unavailable");
    const json = z.object({ itemSummaries: z.array(z.object({
      title:z.string().max(250), itemWebUrl:z.string().max(2000), condition:z.string().max(150).optional(),
      price:z.object({ value:z.string(), currency:z.string() }),
    })).max(25).optional() }).parse(await response.json());
    return json.itemSummaries ?? [];
  } catch {
    tokenRequest = undefined;
    throw new ApiError(502, "Marketplace listings are temporarily unavailable.");
  }
}
