import { parseAmount, todayISO } from "./format.js";
import type { AssetEstimate } from "./asset-tools.js";
import type { Comparable } from "./asset-valuation.js";
import { comparableListing } from "./asset-valuation.js";

export interface MarketplaceListing {
  title: string; itemWebUrl: string; condition?: string; price: { value: string; currency: string };
}

export function marketplaceMatches(listings: MarketplaceListing[], description: string, currency: string, condition: string) {
  const matches = new Map<string, Comparable>();
  for (const item of listings) {
    try {
      const url = new URL(item.itemWebUrl);
      if (url.protocol !== "https:" || url.hostname !== "www.ebay.com" || url.username || url.password || item.price.currency !== currency) continue;
      const id = url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)\/?$/)?.[1];
      if (!id || !comparableListing(description, item.title, "")) continue;
      if (condition === "new" && item.condition?.toLowerCase() !== "new") continue;
      if (["excellent","good","fair","poor"].includes(condition) && !item.condition?.toLowerCase().includes(condition)) continue;
      const amount = parseAmount(item.price.value,currency);
      if (amount < 1 || amount > 999999999999) continue;
      matches.set(id,{name:item.title,source:"eBay active listing",url:"https://www.ebay.com/itm/"+id,price:amount,low:amount,high:amount});
    } catch { /* Ignore incomplete or malformed listings. */ }
  }
  return [...matches.values()];
}

export function marketplaceEstimate(listings: Comparable[]): AssetEstimate|null {
  if (listings.length < 3) return null;
  const ordered = [...listings].sort((a,b)=>a.price-b.price);
  if (ordered.at(-1)!.price > ordered[0].price * 2) return null;
  const middle = Math.floor(ordered.length/2);
  const amountMinor = ordered.length%2 ? ordered[middle].price : Math.round((ordered[middle-1].price+ordered[middle].price)/2);
  return { amountMinor, asOf:todayISO(), sourceName:"Median of eBay active listings",sourceUrl:ordered[middle].url,sourceType:"asking_price",
    notes:ordered.map(item=>item.name+" · "+item.url).join("\n").slice(0,4000) };
}
