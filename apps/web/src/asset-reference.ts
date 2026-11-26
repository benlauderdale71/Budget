import type { AssetEstimate } from "./asset-tools.js";
import { formatMoney } from "./format.js";

export interface AssetReference {
  fhfa: Record<string, [number, (number | null)[]]>;
  vehicles: [string, string, number, string][];
}
let pending: Promise<AssetReference> | undefined;
export function loadReference(): Promise<AssetReference> {
  return pending ??= fetch("/asset-reference.json").then(async response => {
    if (!response.ok) throw new Error();
    const reference = await response.json() as AssetReference;
    if (!reference.fhfa || !Array.isArray(reference.vehicles)) throw new Error();
    return reference;
  }).catch(() => { pending = undefined; throw new Error("The reference data could not be loaded."); });
}
export const priceIndexSource = "FHFA state house price index";
export const indexUrl = "https://www.fhfa.gov/data/house-price-index";
export const fleetSource = "https://uxsearch.app/research/data";
const govDeals = "https://www.govdeals.com/en/asset/";
export const states = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

export function houseEstimate(reference: AssetReference, state: string, purchaseMinor: number, purchased: string, today: string): AssetEstimate {
  const series = reference.fhfa[state];
  if (!series || !/^\d{4}-\d{2}-\d{2}$/.test(purchased) || purchased > today || !Number.isSafeInteger(purchaseMinor) || purchaseMinor <= 0)
    throw new Error("Choose a state and enter a valid purchase price and date.");
  const [start, points] = series;
  const quarter = Number(purchased.slice(0, 4)) * 4 + Math.floor((Number(purchased.slice(5, 7)) - 1) / 3);
  const initial = points[quarter - start];
  const last = start + points.length - 1;
  const current = points[points.length - 1];
  const asOf = new Date(Date.UTC(Math.floor(last / 4), 3 * (last % 4 + 1), 0)).toISOString().slice(0, 10);
  if (!initial || !current || quarter > last || asOf > today || Date.parse(today) - Date.parse(asOf) > 366 * 86400000)
    throw new Error("The published index does not cover these dates. You can enter a manual estimate.");
  const amountMinor = Math.round(purchaseMinor * current / initial);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 999999999999)
    throw new Error("The resulting amount exceeds the inventory limit.");
  return {
    amountMinor, asOf, sourceType: "manual", sourceName: priceIndexSource, sourceUrl: indexUrl,
    notes: `Estimated for ${state} from the FHFA quarterly purchase-only, non-seasonally adjusted index. ` +
      `Purchase price ${formatMoney(purchaseMinor)}, purchase quarter index ${(initial / 100).toFixed(2)}, latest index ${(current / 100).toFixed(2)}. ` +
      "A state-level trend for single-family homes. Property condition and neighborhood differences are not reflected.",
  };
}
const vehicleWords = (term: string): string[] => term.toLowerCase().replace(/(\w)-(\w)/g, "$1$2").match(/[a-z0-9]+/g) ?? [];
export function vehicleEstimate(reference: AssetReference, query: string, today: string) {
  const terms = vehicleWords(query);
  if (terms.length < 3 || !terms.some(t => /^(19|20)\d{2}$/.test(t)))
    throw new Error("Enter a model year, make and model, such as 2014 Ford Escape.");
  const cutoff = Date.parse(today) - 365 * 86400000;
  const matches = reference.vehicles.filter(([date, name]) => {
    const words = vehicleWords(name);
    return date <= today && Date.parse(date) >= cutoff && terms.includes(words[0]) && terms.includes(words[1])
      && terms.includes(words[2]) && terms.every(term => words.includes(term));
  }).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10);
  if (!matches.length) throw new Error("No recent matching U.S. fleet sales. Try the vehicle guide or enter a value.");
  const prices = matches.map(row => row[2]).sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  const amountMinor = prices.length % 2 ? prices[middle] : Math.round((prices[middle - 1] + prices[middle]) / 2);
  const nearest = matches.reduce((a, b) => Math.abs(a[2] - amountMinor) <= Math.abs(b[2] - amountMinor) ? a : b);
  const estimate: AssetEstimate = { amountMinor, asOf: matches[0][0], sourceName: "U.S. government fleet auction sales", sourceType: "sold_comparable",
    sourceUrl: govDeals + nearest[3], notes: [
      `Median of ${matches.length} U.S. government fleet sale(s) matching "${query}". Mileage and condition may differ. Source: uxsearch.app, CC BY 4.0.`,
      ...matches.map(([date, title, cents, id]) => `${date} · ${title} · ${formatMoney(cents)} · ${govDeals + id}`),
    ].join("\n") };
  return { estimate, sales: matches.map(([date, title, price, id]) => ({ date, title, price, url: govDeals + id })) };
}
