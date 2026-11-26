import { z } from "zod";
import { isIsoDate, minorFactor, multiplyDecimalByMinor } from "@budgetcents/domain";
import { ApiError } from "./finance.js";

const unavailable = () => new ApiError(422,"The guide has no verified value for these exact details. Check the reference, edition and grade.");
const short = z.string().trim().min(1).max(100);
const positive = z.number().positive().max(1_000_000_000);
const identifier = z.string().regex(/^\d{1,10}$/);
const numistaGrades = ["g","vg","f","vf","xf","au","unc"] as const;
const cardGrades = { raw:"loose-price", "8-8.5":"new-price", "9":"graded-price", psa10:"manual-only-price" } as const;
export const specialistQuery = z.discriminatedUnion("provider", [
  z.object({provider:z.literal("watch"),brand:short,reference:short,usedWithBoxAndPapers:z.literal(true)}),
  z.object({provider:z.literal("numista"),typeId:identifier,issueId:identifier,grade:z.enum(numistaGrades)}),
  z.object({provider:z.literal("card"),productId:identifier,grade:z.enum(["raw","8-8.5","9","psa10"])}),
]);
type SpecialistQuery = z.infer<typeof specialistQuery>;
export function specialistOptions() {
  return {
    watch: Boolean(process.env.ASSET_WATCHCHARTS_API_KEY),
    numista: Boolean(process.env.ASSET_NUMISTA_API_KEY),
    card: Boolean(process.env.ASSET_SPORTSCARDSPRO_API_KEY),
  };
}
function get(url:URL,fetcher:typeof fetch,headers?:Record<string,string>) {
  return fetcher(url,{redirect:"error",signal:AbortSignal.timeout(9_000),headers}).then(response=>{
    if(response.status===404) throw unavailable();
    if(!response.ok) throw Error("Guide request failed");
    return response.json() as Promise<unknown>;
  });
}
function endpoint(location:string, params:Record<string,string>) {
  const url = new URL(location);url.search = new URLSearchParams(params).toString();return url;
}
const pause = (milliseconds:number) => new Promise(resolve=>setTimeout(resolve,milliseconds));
let nextWatchRequest = 0;
async function watchGet(path:string, params:Record<string,string>,fetcher:typeof fetch) {
  const start = Math.max(Date.now(),nextWatchRequest);
  if (start-Date.now()>4500) throw new ApiError(429,"Watch guide requests are busy. Try again shortly.");
  nextWatchRequest = start+1100;
  await pause(Math.max(0,start-Date.now()));
  return get(endpoint("https://api.watchcharts.com/v3/"+path,params),fetcher,{"x-api-key":process.env.ASSET_WATCHCHARTS_API_KEY!});
}
const normalize = (value:string) => value.toLowerCase().replace(/[^a-z0-9]/g,"");
const watchResult = z.object({uuid:z.uuid(),model:short});
async function watchGuide(input:Extract<SpecialistQuery,{provider:"watch"}>,currency:string,today:string,fetcher:typeof fetch) {
  const response = z.object({success:z.literal(true),results:z.array(watchResult.extend({variants:z.array(watchResult).optional()}))}).parse(
    await watchGet("search/watch",{brand_name:input.brand,reference:input.reference,exact_match:"true"},fetcher),
  );
  const possible = response.results.flatMap(result=>
    result.variants?.length ? result.variants : [result]).filter(item=>normalize(item.model)===normalize(input.reference));
  const candidates = [...new Map(possible.map(item=>[item.uuid,item])).values()];
  if(candidates.length!==1) throw unavailable();
  const info = z.object({brand:short,model:short,market_price:positive,updated:z.string().refine(isIsoDate)}).parse(
    await watchGet("watch/info",{uuid:candidates[0].uuid,currency},fetcher),
  );
  if (normalize(info.brand)!==normalize(input.brand)||normalize(info.model)!==normalize(input.reference)||info.updated>today||Date.parse(today)-Date.parse(info.updated)>90*86400000) throw unavailable();
  return {
    title:info.brand+" "+info.model, asOf:info.updated, amount:info.market_price, sourceName:"WatchCharts",
    sourceUrl:"https://watchcharts.com/watches", notes:"WatchCharts global private-party market guide for a used watch with box and papers.",
  };
}
async function numistaGuide(input:Extract<SpecialistQuery,{provider:"numista"}>,currency:string,today:string,fetcher:typeof fetch) {
  const root = "https://api.numista.com/v3/types/"+input.typeId;
  const headers = {"Numista-API-Key":process.env.ASSET_NUMISTA_API_KEY!};
  const [detail, pricing] = await Promise.all([
    get(endpoint(root,{lang:"en"}),fetcher,headers),
    get(endpoint(root+"/issues/"+input.issueId+"/prices",{currency,lang:"en"}),fetcher,headers),
  ]);
  const type = z.object({title:z.string().min(1).max(250)}).parse(detail);
  const data = z.object({currency:z.string(),prices:z.array(z.object({grade:z.string(),price:positive}))}).parse(pricing);
  const price = data.prices.find(row=>row.grade===input.grade);
  if (data.currency!==currency||!price) throw unavailable();
  return {
    title:type.title, asOf:today, amount:price.price, sourceName:"Numista",
    sourceUrl:"https://en.numista.com/catalogue/index.php?r="+encodeURIComponent("N# "+input.typeId),
    notes:"Numista issue "+input.issueId+", grade "+input.grade.toUpperCase()+". Guide checked on this date. Confirm the catalog issue matches your item.",
  };
}
async function cardGuide(input:Extract<SpecialistQuery,{provider:"card"}>,currency:string,today:string,fetcher:typeof fetch) {
  if (currency!=="USD") throw new ApiError(422,"This card guide reports USD. Use completed sales for dated conversion into your household currency.");
  const result = z.object({status:z.literal("success"),id:z.coerce.string(), "product-name":short,"console-name":short})
    .loose().parse(await get(endpoint("https://www.sportscardspro.com/api/product",{t:process.env.ASSET_SPORTSCARDSPRO_API_KEY!,id:input.productId}),fetcher));
  const cents=z.number().int().positive().max(999999999999).safeParse(result[cardGrades[input.grade]]);
  if(result.id!==input.productId||!cents.success) throw unavailable();
  return {
    title:result["console-name"]+" · "+result["product-name"], asOf:today, amount:cents.data/100, sourceName:"SportsCardsPro",
    sourceUrl:endpoint("https://www.sportscardspro.com/search-products",{q:result["console-name"]+" "+result["product-name"]}).href,
    notes:"SportsCardsPro guide for "+input.grade+". Checked on this date. Verify the exact card and parallel before saving.",
  };
}
export async function specialistEstimate(input:SpecialistQuery,currency:string,today:string,fetcher=fetch) {
  if (!specialistOptions()[input.provider]) throw new ApiError(503,"This specialist guide is not configured.");
  try {
    const guide = input.provider==="watch" ? await watchGuide(input,currency,today,fetcher) :
      input.provider==="numista" ? await numistaGuide(input,currency,today,fetcher) : await cardGuide(input,currency,today,fetcher);
    const amountMinor = multiplyDecimalByMinor(String(guide.amount),minorFactor(currency));
    if(!Number.isSafeInteger(amountMinor)||amountMinor<1||amountMinor>999999999999) throw unavailable();
    const {title,amount,...source}=guide;
    return {title,estimate:{...source,amountMinor,sourceType:"price_guide" as const}};
  } catch (error) {
    if(error instanceof ApiError) throw error;
    throw new ApiError(502,"The specialist guide did not return a usable quote. Verify the exact details or use completed sales.");
  }
}
