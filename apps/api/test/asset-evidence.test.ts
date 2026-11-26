import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateCompletedSales } from "../src/asset-evidence.js";
import { decodeVehicle, assetExchangeRate } from "../src/asset-providers.js";
import { specialistEstimate } from "../src/asset-specialist.js";
import { readAssetFile } from "../src/asset-import.js";

afterEach(()=>vi.unstubAllEnvs());
const today="2026-11-26";
const sale = (id:number,amountMinor=10000)=>({title:"Identical graded item "+id,url:"https://example.com/auction/"+id,
  asOf:"2026-11-20",currency:"USD",amountMinor,comparison:"exact"});

describe("valuation evidence",()=>{
  it("keeps original currencies, dates, distinct sources and a mathematically correct median",async()=>{
    const convert=vi.fn(async()=>({date:"2026-11-20",rate:1.2}));
    const result=await estimateCompletedSales([
      sale(1,10000),{...sale(2,10000),currency:"EUR"},{...sale(3,11000),currency:"EUR"},
      {...sale(1),url:sale(1).url+"?ref=another"} ,{...sale(4,1),comparison:"similar"},
      {...sale(5,999999),asOf:"2025-11-01"},
    ],"USD",today,convert);
    expect(result).toMatchObject({amountMinor:12000,sourceType:"sold_comparable",evidence:{lowMinor:10000,highMinor:13200}});
    expect(result.evidence.sales).toHaveLength(3);
    expect(result.evidence.sales[1]).toMatchObject({currency:"EUR",amountMinor:10000,convertedMinor:12000,rateDate:"2026-11-20"});
    expect(convert).toHaveBeenCalledOnce();
  });
  it("rejects stale, weak, duplicated and widely divergent comparisons",async()=>{
    const old={...sale(3),asOf:"2024-11-20"};
    await expect(estimateCompletedSales([sale(1),sale(2),old],"USD",today)).rejects.toThrow("three distinct");
    await expect(estimateCompletedSales([sale(1),sale(2),sale(3,99000)],"USD",today)).rejects.toThrow("vary too widely");
    const first={...sale(1),url:"https://www.ebay.com/itm/item-name/384756239120?mkcid=1"};
    const same={...sale(2),url:"https://www.ebay.co.uk/itm/384756239120"};
    await expect(estimateCompletedSales([first,same,sale(3)],"USD",today)).rejects.toThrow("three distinct");
  });
  it("only accepts a rate reported in the expected direction and around the sale date",async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{base:"GBP",quote:"USD",date:"2026-11-20",rate:1.4}]))
      .mockResolvedValueOnce(Response.json([{base:"USD",quote:"GBP",date:"2026-11-18",rate:0.8}]));
    expect(await assetExchangeRate("GBP","USD",today,fetcher)).toMatchObject({rate:1.4,date:"2026-11-20"});
    await expect(assetExchangeRate("GBP","USD",today,fetcher)).rejects.toThrow("unavailable");
  });
  it("uses only a confirmed VIN decoding result",async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({Results:[{ErrorCode:"0",Make:"HONDA",Model:"Civic",ModelYear:"2015",Trim:"EX"}]}))
      .mockResolvedValueOnce(Response.json({Results:[{ErrorCode:"7",Make:"HONDA",Model:"Civic",ModelYear:"2015"}]}));
    expect(await decodeVehicle("19XFB2F83FE012345",fetcher)).toMatchObject({model:"Civic",attributes:[{label:"Model year",value:"2015"},{label:"Trim",value:"EX"}]});
    await expect(decodeVehicle("19XFB2F83FE012345",fetcher)).rejects.toThrow("could not verify");
  });
  it("rejects an ambiguous watch catalog entry before requesting a price",async()=>{
    vi.stubEnv("ASSET_WATCHCHARTS_API_KEY","fixture");
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({success:true,results:[
      {uuid:"7901c9d7-22f9-4783-b5ce-48ee079a62ab",model:"116500",variants:[
        {uuid:"32001967-37f9-4353-aa11-f2998c879463",model:"116500-0001"},
        {uuid:"32001967-37f9-4353-aa11-f2998c879464",model:"116500-0002"},
      ]},
    ]}));
    await expect(specialistEstimate({provider:"watch",brand:"Rolex",reference:"116500",usedWithBoxAndPapers:true},"USD",today,fetcher)).rejects.toThrow("exact details");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain("exact_match=true");
  });
  it("returns the confirmed Numista issue and grade as a guide price",async()=>{
    vi.stubEnv("ASSET_NUMISTA_API_KEY","fixture");
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({title:"16th century coin"}))
      .mockResolvedValueOnce(Response.json({currency:"USD",prices:[{grade:"f",price:60},{grade:"vf",price:95}]}));
    const result=await specialistEstimate({provider:"numista",typeId:"3124",issueId:"202",grade:"vf"},"USD",today,fetcher);
    expect(result).toMatchObject({estimate:{amountMinor:9500,sourceName:"Numista",sourceType:"price_guide"}});
    expect(String(fetcher.mock.calls[1][0])).toContain("/types/3124/issues/202/prices");
  });
  it("checks a card guide's exact ID and preserves its grade-specific denomination",async()=>{
    vi.stubEnv("ASSET_SPORTSCARDSPRO_API_KEY","fixture");
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({status:"success",id:"12345","product-name":"Example #12","console-name":"Example Set","loose-price":900,"manual-only-price":5300}));
    const result=await specialistEstimate({provider:"card",productId:"12345",grade:"psa10"},"USD",today,fetcher);
    expect(result).toMatchObject({estimate:{amountMinor:5300,sourceName:"SportsCardsPro",sourceType:"price_guide"}});
  });
  it("round-trips typed inventory details from exported JSON",async()=>{
    const file=Buffer.from(JSON.stringify({assets:[{name:"Camera",profile:"camera",attributes:[{label:"Lens mount",value:"E"}]}]}));
    const parsed=await readAssetFile(file,"inventory.json","USD");
    expect(parsed.rows[0]).toMatchObject({profile:"camera",attributes:[{label:"Lens mount",value:"E"}]});
  });
});
