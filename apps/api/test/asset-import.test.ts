import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import sharp from "sharp";
import { assetCategory, readAssetFile } from "../src/asset-import.js";
import { textPdf } from "../src/pdf.js";

describe("asset file readers",()=>{
  it.each(["csv","tsv","txt","json"])("reads %s and suggests categories",async ext=>{
    const records=ext==="json"?'[{"Name":"Laptop","Quantity":2,"Estimated value":"123.45"}]':ext==="txt"?"Laptop\nOffice desk":`Name${ext==="csv"?",":"\t"}Quantity${ext==="csv"?",":"\t"}Estimated value\nLaptop${ext==="csv"?",":"\t"}2${ext==="csv"?",":"\t"}123.45`;
    const p=await readAssetFile(Buffer.from(records),`inventory.${ext}`,"USD");expect(p.rows[0]).toMatchObject({name:"Laptop",category:"Electronics"});if(ext!=="txt")expect(p.rows[0]).toMatchObject({quantity:2,estimateMinor:12345});
    expect(assetCategory("Ford Expedition")).toBe("Vehicles");
  });
  it.each(["xls","xlsx"] as const)("reads all sheets of %s without running formulas",async ext=>{
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([["Name","Location","Value"],["Office desk","Office",125.50]]),"Home");XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([["Name","Value"],["Drill",100]]),"Garage");
    const result=await readAssetFile(XLSX.write(book,{type:"buffer",bookType:ext}),`assets.${ext}`,"USD");expect(result.rows).toHaveLength(2);expect(result.rows[0]).toMatchObject({name:"Office desk",estimateMinor:12550});expect(result.rows[1].category).toBe("Tools & equipment");
  });
  it("keeps ambiguous amounts and dates out of confirmed values and rejects oversized/unsupported files",async()=>{
    const result=await readAssetFile(Buffer.from('Name,Value,Purchase date,Quantity\nCamera,unknown,11/15/26,NaN'),"assets.csv","USD");
    expect(result.rows[0]).toMatchObject({estimateMinor:null,purchaseDate:"",quantity:1});expect(result.rows[0].issues).toHaveLength(3);
    await expect(readAssetFile(Buffer.alloc(8_000_001),"large.csv","USD")).rejects.toThrow("8 MB");
    await expect(readAssetFile(Buffer.from("bad"),"bad.exe","USD")).rejects.toThrow();
  });
  it("reads inventory columns from a real PDF",async()=>{
    const pdf=textPdf("Asset inventory",["Name                Location        Value","Office desk         Office          125.50","Drill               Garage          80.00"]);
    const result=await readAssetFile(Buffer.from(pdf),"assets.pdf","USD");expect(result.rows.map(r=>r.name)).toEqual(["Office desk","Drill"]);expect(result.rows[0].estimateMinor).toBe(12550);
  });
  it("reads photographed labels and preserves a draft for photos without text",async()=>{
    const svg='<svg width="1600" height="400"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="Arial" font-size="38"><text x="50" y="70">Name</text><text x="800" y="70">Location</text><text x="1200" y="70">Value</text><text x="50" y="160">Laptop</text><text x="800" y="160">Office</text><text x="1200" y="160">125.50</text></g></svg>';
    const bytes=await sharp(Buffer.from(svg)).png().toBuffer(),p=await readAssetFile(bytes,"assets.png","USD");expect(p.rows[0]).toMatchObject({name:"Laptop",category:"Electronics",estimateMinor:12550});
    const blank=await sharp({create:{width:200,height:200,channels:3,background:"white"}}).png().toBuffer();const draft=await readAssetFile(blank,"living-room-chair.png","USD");expect(draft.rows[0]).toMatchObject({name:"living room chair",category:"Furniture",estimateMinor:null});expect(draft.rows[0].issues.length).toBeGreaterThan(0);
  });
});
