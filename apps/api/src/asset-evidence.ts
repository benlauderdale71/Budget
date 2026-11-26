import { z } from "zod";
import { isIsoDate, minorFactor } from "@budgetcents/domain";
import { assetExchangeRate } from "./asset-providers.js";
import { ApiError } from "./finance.js";

const date = z.string().refine(isIsoDate);
const currency = z.string().regex(/^[A-Z]{3}$/);
const sourceUrl = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use the HTTPS link to the completed sale.");

export const saleInputSchema = z.object({
  title: z.string().trim().min(1).max(180), url: sourceUrl,
  asOf: date, currency, amountMinor: z.number().int().min(1).max(999999999999),
  comparison: z.enum(["exact", "similar"]),
});
export const saleEvidenceSchema = saleInputSchema.extend({
  convertedMinor: z.number().int().min(1).max(999999999999), rate: z.number().positive(), rateDate: date,
});
const salesSchema = z.array(saleInputSchema).max(12);
export const evidenceSchema = z.object({
  currency, lowMinor: z.number().int().min(1).max(999999999999), highMinor: z.number().int().min(1).max(999999999999),
  sales: z.array(saleEvidenceSchema).min(3).max(12),
}).refine(e => e.lowMinor <= e.highMinor);

function listingKey(link: string) {
  const u = new URL(link);
  const ebay = u.hostname.match(/(?:^|\.)ebay\.(?:com|co\.uk|de|ca|fr|it|com\.au)$/i) && u.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
  if (ebay) return "ebay:" + ebay[1];
  // Navigation and tracking parameters do not create a second comparable.
  return u.hostname.replace(/^www\./i, "").toLowerCase() + u.pathname.replace(/\/+$/, "").toLowerCase();
}

export async function estimateCompletedSales(input: unknown, householdCurrency: string, today: string, convert = assetExchangeRate) {
  const sales = salesSchema.parse(input);
  const oneYear = Date.parse(today) - 365 * 86400000;
  const used = new Set<string>();
  const compared = sales.filter(item => {
    if (item.comparison !== "exact" || item.asOf > today || Date.parse(item.asOf) < oneYear) return false;
    const key = listingKey(item.url);
    if (used.has(key)) return false;
    used.add(key);
    return true;
  });
  if (compared.length < 3) throw new ApiError(422, "Add at least three distinct completed sales from the past year for the same variant and comparable condition.");
  const rates = new Map<string, ReturnType<typeof assetExchangeRate>>();
  const converted = await Promise.all(compared.map(async item => {
    const key = item.currency + item.asOf;
    let exchange = rates.get(key);
    if (!exchange) {
      exchange = item.currency === householdCurrency ? Promise.resolve({ date: item.asOf, rate: 1 }) : convert(item.currency, householdCurrency, item.asOf);
      rates.set(key, exchange);
    }
    const { rate, date: rateDate } = await exchange;
    const convertedMinor = Math.round(item.amountMinor * rate * minorFactor(householdCurrency) / minorFactor(item.currency));
    return saleEvidenceSchema.parse({ ...item, convertedMinor, rate, rateDate });
  }));
  const values = converted.map(item => item.convertedMinor).sort((a,b)=>a-b);
  const lowMinor = values[0], highMinor = values[values.length - 1];
  const mid = Math.floor(values.length / 2);
  const amountMinor = values.length % 2 ? values[mid] : Math.round((values[mid] + values[mid-1]) / 2);
  if (highMinor > lowMinor * 2) throw new ApiError(422, "The sale prices vary too widely. Review the grade, condition, variants and whether any sale included a bundle.");
  const recent = [...converted].sort((a,b) => b.asOf.localeCompare(a.asOf))[0];
  return {
    amountMinor, asOf:recent.asOf, sourceName:"Median of reviewed completed sales", sourceUrl:recent.url,
    sourceType:"sold_comparable" as const, notes:"Completed sales entered and matched by the user. Converted at dated Frankfurter rates when applicable.",
    evidence: { currency:householdCurrency, lowMinor, highMinor, sales:converted },
  };
}
