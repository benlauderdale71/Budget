import { inventoryCategories, type AssetIdentity } from "@budgetcents/domain/asset-identity";

export const ASSET_CATEGORIES = inventoryCategories;
export type SaleEvidence = { title:string; url:string; asOf:string; currency:string; amountMinor:number; convertedMinor:number; rate:number; rateDate:string };
export type EstimateEvidence = { currency:string; lowMinor:number; highMinor:number; sales:SaleEvidence[] };
export const SOURCE_TYPES = { manual: "Personal estimate", sold_comparable: "Sold comparable", asking_price: "Asking price", appraisal: "Appraisal", replacement_cost: "Replacement cost", price_guide:"Specialist price guide" };
export interface AssetEstimate { id?:string; amountMinor:number; asOf:string; sourceName:string; sourceUrl:string; sourceType:keyof typeof SOURCE_TYPES; notes:string; recordedAt?:string; evidence?:EstimateEvidence }
export interface PhysicalAsset extends AssetIdentity {
  cropDocumentId?:string;
  id:string; name:string; category:string; location:string; brand:string; model:string; serialNumber:string;
  condition:string; quantity:number; tags:string[]; notes:string; purchaseDate:string; purchaseMinor:number|null;
  visibility:"shared"|"private"; archived:boolean; version:number; canChangeVisibility:boolean;
  estimate:AssetEstimate|null; estimates:AssetEstimate[]; documents:{id:string;filename:string}[];
}
export function valueSearchLinks(query:string,category:string) {
  const q=encodeURIComponent(query.trim());
  const links=[{name:"Search web values",url:`https://www.google.com/search?q=${encodeURIComponent(query.trim()+" used value")}`},
    {name:"eBay sold listings",url:`https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`},
    {name:"eBay asking prices",url:`https://www.ebay.com/sch/i.html?_nkw=${q}`}];
  if(category==="Vehicles") links.unshift({name:"Kelley Blue Book",url:"https://www.kbb.com/whats-my-car-worth/"});
  if(category==="Real estate") links.unshift({name:"Zillow home values",url:"https://www.zillow.com/how-much-is-my-home-worth/"});
  return links;
}
export function inventorySummary(assets:PhysicalAsset[]) {
  const sum=assets.reduce((sum,a)=>({records:sum.records+1,items:sum.items+a.quantity,valued:sum.valued+(a.estimate?1:0),value:sum.value+(a.estimate?BigInt(a.estimate.amountMinor)*BigInt(a.quantity):0n)}),{records:0,items:0,valued:0,value:0n});
  return {...sum,value:sum.value>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(sum.value)};
}
