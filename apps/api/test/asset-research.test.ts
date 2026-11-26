import { describe, expect, it, vi } from "vitest";
import { readAssetCatalog } from "../src/asset-catalog.js";
import { researchAsset, searchDescription } from "../../web/src/asset-valuation.js";
import { houseEstimate, vehicleEstimate, type AssetReference } from "../../web/src/asset-reference.js";

const shop = (nodes: unknown[]) => ({data: {search: {nodes}}});
function phone(id: string, title: string, prices: [string, string, string][], host = "buy.gazelle.com") {
  return {title, vendor:"Apple",onlineStoreUrl:"https://"+host+"/products/"+id, availableForSale:true,
    variants:{nodes:prices.map(([title,amount,currencyCode])=>({title,availableForSale:true,price:{amount,currencyCode}}))}};
}
const query = "iPhone 13 128GB";
describe("inventory price research", () => {
  it("prices each distinct matching product once in the household currency and retains real source links", async () => {
    const a=phone("one",query,[["Good","200","USD"],["Fair","100","USD"],["Good","15","CAD"]]);
    const b=phone("two",query,[["Good","300","USD"]]);
    const raw=shop([a,a,b,phone("case",query+" case",[["Good","5","USD"]]),
      phone("pro","iPhone 13 Pro 128GB",[["Good","420","USD"]]),phone("other",query,[["Good","7","USD"]],"elsewhere.example"),
      phone("bad-amount",query,[["Good","free","USD"]]),{...b, availableForSale:false}]);
    const report=await researchAsset(query,"Electronics","good","USD",async source=>source==="gazelle"?raw:Promise.reject(new Error("offline")));
    expect(report.matches).toHaveLength(2);
    expect(report.estimate).toMatchObject({sourceType:"asking_price",amountMinor:25000,sourceUrl:a.onlineStoreUrl});
    expect(report.estimate?.notes).toContain(b.onlineStoreUrl);
    expect([report.low,report.high,report.reached]).toEqual([20000,30000,1]);
  });
  it("keeps no-match distinct from a source outage and does not convert foreign prices", async () => {
    const load=async (id:string)=>id==="gazelle"?shop([phone("x",query,[["Good","100","CAD"]])]):Promise.reject();
    expect(await researchAsset(query,"Electronics","good","USD",load)).toMatchObject({estimate:null,reached:1});
    expect(await researchAsset(query,"Electronics","good","USD",async()=>{throw Error();})).toMatchObject({estimate:null,reached:0});
  });
  it("sends only a description to the fixed retailer API and rejects unknown retailers", async () => {
    const request=vi.fn(async (_u:URL|string|Request,_i?:RequestInit)=>Response.json(shop([])));
    await readAssetCatalog("gazelle","iPhone 13",request);
    const [url,init]=request.mock.calls[0];
    expect(new URL(String(url)).hostname).toBe("buy.gazelle.com");
    expect(JSON.parse(String(init?.body)).variables).toEqual({term:"iPhone 13"});
    await expect(readAssetCatalog("unknown","phone",request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  const reference:AssetReference={fhfa:{CA:[2024*4,[10000,10500,11000,12000]]},vehicles:[
    ["2025-04-10","2014 Ford Escape",100000,"22/8"],["2025-03-10","2014 Ford Escape AWD",200000,"26/8"],
    ["2025-04-15","2015 Ford Escape",900000,"28/8"],["2022-02-10","2014 Ford Escape",1,"3/9"]]};
  it("scales the purchase price using the applicable state quarters and dates the result to the series", () => {
    expect(houseEstimate(reference,"CA",20000000,"2024-02-10","2025-05-01")).toMatchObject({amountMinor:24000000,asOf:"2024-12-31"});
    expect(()=>houseEstimate(reference,"CA",20000000,"2025-04-01","2025-05-01")).toThrow();
    expect(()=>houseEstimate(reference,"CA",20000000,"2024-02-10","2026-09-01")).toThrow();
  });
  it("requires a matching vehicle year, make and model and drops old sales", () => {
    const r=vehicleEstimate(reference,"2014 Ford Escape","2025-05-01");
    expect(r.sales).toHaveLength(2);
    expect(r.estimate).toMatchObject({amountMinor:150000,sourceType:"sold_comparable",asOf:"2025-04-10"});
    expect(()=>vehicleEstimate(reference,"2014 Ford","2025-05-01")).toThrow();
    expect(()=>vehicleEstimate(reference,"2014 Escape AWD","2025-05-01")).toThrow();
    expect(searchDescription({name:"2014 household vehicle",brand:"Ford",model:"Escape"})).toContain("2014");
  });
});
