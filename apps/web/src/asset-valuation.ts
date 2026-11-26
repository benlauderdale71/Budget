import catalog from "../../../packages/domain/catalogs/resale-catalogs.json";
import { exponent, parseAmount, formatMoney, todayISO } from "./format.js";
import type { AssetEstimate } from "./asset-tools.js";

export interface Comparable { name: string; source: string; url: string; price: number; low: number; high: number }
export interface Valuation { matches: Comparable[]; reached: number; searched: number; estimate: AssetEstimate | null; low: number; high: number }
type Source = typeof catalog.sources[number];
type Price = { amount: string; currencyCode: string };
type Product = {title: string; vendor: string; onlineStoreUrl: string; availableForSale: boolean; variants:{nodes:{title:string;availableForSale:boolean;price:Price}[]}};
type WooItem = {name:string; permalink:string; is_in_stock:boolean; prices:{currency_code:string;currency_minor_unit:number;price:string;price_range?:unknown}};

const normalize = (s: string) => (s || "").normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/(\d)\s+(gb|tb|mm|inch)\b/g, "$1$2").replace(/[^a-z0-9]+/g," ").trim();
const unimportant = new Set(["my","the","a","an","used","new","good","excellent","fair","black","white","blue","red","for","with","and","by","in","of"]);
const extras = new Set(["case","cover","protector","strap","adapter","cable","charger","manual","replacement","parts","broken","repair","bundle","lot","pack","replica","mini","ultra","plus","pro","max","lite","oled"]);
const words = (s:string) => normalize(s).split(/\s+/).filter(Boolean);
const median = (v:number[]) => { const mid=Math.floor(v.length/2); return v.length%2?v[mid]:Math.round((v[mid-1]+v[mid])/2); };

export function searchDescription(asset: {name:string;brand:string;model:string}) {
  return [...new Map((asset.model ? [asset.brand,asset.model,...(asset.name.match(/\b(?:19|20)\d{2}\b/g) ?? []),...(asset.brand ? [] : [asset.name])] : [asset.brand,asset.name])
    .join(" ").trim().split(/\s+/).filter(Boolean).map(word=>[word.toLowerCase(),word])).values()].join(" ").slice(0,120);
}
function relevant(query:string, title:string, vendor:string) {
  const terms=words(query).filter(s=>!unimportant.has(s)), item=words(title), available=new Set([...item,...words(vendor)]);
  if (!terms.length || !terms.every(t=>available.has(t))) return false;
  if (item.some(t=>extras.has(t) && !terms.includes(t))) return false;
  if (/\b(?:for|compatible with|game for)\b/i.test(title) && !/\bfor\b/i.test(query)) return false;
  return true;
}
function sourceLink(raw:string, host:string) {
  try { const u=new URL(raw); return u.protocol==="https:" && u.hostname.replace(/^www\./,"")===host.replace(/^www\./,"") && !u.username && !u.password ? u.href : ""; }
  catch { return ""; }
}
function catalogMatches(source:Source, raw:unknown, term:string, currency:string, condition:string):Comparable[] {
  if (source.kind==="woo") {
    if (!Array.isArray(raw)) throw new Error("Catalog unavailable");
    return (raw as WooItem[]).flatMap(p=>{
      const url=sourceLink(p.permalink,source.host), n=Number(p.prices?.price);
      if (!url || !p.is_in_stock || p.prices?.currency_code!==currency || p.prices.currency_minor_unit!==exponent(currency) || p.prices.price_range || !Number.isSafeInteger(n) || n<=0 || n>999999999999 || !relevant(term,p.name,"")) return [];
      return [{name:p.name.replace(/&amp;/g,"&"),source:source.name,url,price:n,low:n,high:n}];
    });
  }
  const items=(raw as {data?:{search?:{nodes?:Product[]}}})?.data?.search?.nodes;
  if (!Array.isArray(items)) throw new Error("Catalog unavailable");
  return items.flatMap(p=>{
    const url=sourceLink(p.onlineStoreUrl,source.host);
    if (!url || !p.availableForSale || !relevant(term,p.title,p.vendor)) return [];
    const variants=(p.variants?.nodes ?? []).filter(v=>v.availableForSale && v.price?.currencyCode===currency);
    const conditionMatches=variants.filter(v=>condition!=="unknown" && words(v.title).includes(condition));
    const prices=(conditionMatches.length?conditionMatches:variants).map(v=>{try { return parseAmount(v.price.amount,currency); } catch { return 0; }})
      .filter(n=>n>0 && n<=999999999999).sort((a,b)=>a-b);
    return prices.length?[{name:p.title,source:source.name,url,price:median(prices),low:prices[0],high:prices[prices.length-1]}]:[];
  });
}
export async function researchAsset(term:string, category:string, condition:string, currency:string, load:(id:string,term:string)=>Promise<unknown>):Promise<Valuation> {
  const musical=/guitar|bass|keyboard|synth|stratocaster|les paul|amplifier|violin|drum/i.test(term);
  const sources=["Real estate","Vehicles"].includes(category)?[]:catalog.sources.filter(s=>s.categories.includes("*") || s.categories.some(c=>c.toLowerCase()===category.trim().toLowerCase()) || (s.id==="music" && musical));
  const reports=await Promise.allSettled(sources.map(async s=>catalogMatches(s,await load(s.id,term),term,currency,condition)));
  const reached=reports.filter(r=>r.status==="fulfilled");
  const matches=[...new Map(reached.flatMap(r=>r.value).map(m=>[m.url,m])).values()].sort((a,b)=>a.price-b.price);
  const low=matches.length?Math.min(...matches.map(m=>m.low)):0, high=matches.length?Math.max(...matches.map(m=>m.high)):0;
  let estimate:AssetEstimate|null=null;
  if (matches.length) {
    const amountMinor=median(matches.map(m=>m.price));
    const primary=matches.reduce((a,b)=>Math.abs(a.price-amountMinor)<=Math.abs(b.price-amountMinor)?a:b);
    estimate={amountMinor,asOf:todayISO(),sourceType:"asking_price",sourceName:matches.length===1?primary.source:`Median of ${matches.length} resale listings`,sourceUrl:primary.url,
      notes:[`Asking prices per item · ${formatMoney(low,currency)} to ${formatMoney(high,currency)}. Search: ${term}.`,...matches.map(m=>`${m.source} · ${m.name} · ${formatMoney(m.price,currency)} · ${m.url}`)].join("\n").slice(0,4000)};
  }
  return {matches,reached:reached.length,searched:sources.length,estimate,low,high};
}
