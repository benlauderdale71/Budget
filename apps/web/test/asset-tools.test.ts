import { test } from "node:test";
import assert from "node:assert/strict";
import { inventorySummary, valueSearchLinks, type PhysicalAsset } from "../src/asset-tools.ts";
test("inventory values respect quantity, keep unknown values distinct from zero",()=>{
  const assets=[{quantity:2,estimate:{amountMinor:12345}},{quantity:3,estimate:null},{quantity:1,estimate:{amountMinor:0}}] as PhysicalAsset[];
  assert.deepEqual(inventorySummary(assets),{records:3,items:6,valued:2,value:24690});
});
test("value search sends only the chosen description and distinguishes sold listings",()=>{
  const links=valueSearchLinks('Camera & lens #1',"Electronics"),sold=new URL(links.find(l=>l.name==="eBay sold listings")!.url);
  assert.equal(sold.searchParams.get("_nkw"),'Camera & lens #1');assert.equal(sold.searchParams.get("LH_Sold"),"1");
  assert.equal(valueSearchLinks("Ford Expedition","Vehicles")[0].name,"Kelley Blue Book");
  assert.equal(valueSearchLinks("House","Real estate")[0].name,"Zillow home values");
});
