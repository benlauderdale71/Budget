import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { parseBillGrids, parseSingleBill } from "@budgetcents/domain";
import { readBillDocument } from "../src/bill-document-reader.js";
import { textPdf } from "../src/pdf.js";
const root=mkdtempSync(join(tmpdir(),"bill-reader-tests-"));
beforeAll(()=>{
  execFileSync(process.env.BUDGETCENTS_TEST_PYTHON||(process.platform==="win32"?"python":"python3"),["-c",`
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
out=Path(${JSON.stringify(root)})
font=ImageFont.truetype(${JSON.stringify(process.env.BUDGETCENTS_TEST_FONT||(process.platform==="win32"?"C:/Windows/Fonts/arial.ttf":"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))}, 30)
def invoice(name, amount):
    img=Image.new("RGB",(1000,400),"white")
    pen=ImageDraw.Draw(img)
    for i,line in enumerate([name,"Amount due $"+amount,"Due date 12/20/2026"]):
        pen.text((40,40+i*70),line,font=font,fill="black")
    return img
a=invoice("NORTH ELECTRIC","56.78")
b=invoice("SOUTH WATER","23.45")
for ext in ["png","jpg","webp"]: a.save(out/('invoice.'+ext))
a.save(out/'scanned.pdf',save_all=True,append_images=[b],resolution=150.0)
a.save(out/'too-many.pdf',save_all=True,append_images=[b]*8,resolution=80.0)
`],{stdio:"inherit"});
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
describe("bill file readers",()=>{
  it("reads every CSV cell including quoted commas and line breaks",async()=>{
    const read=await readBillDocument(Buffer.from('Date,Bill,Amount,Notes\r\n1st,"Electric, home",56.78,"Line one\nLine two"'),"bills.csv");
    const [row]=parseBillGrids(read.grids,"2026-12");expect(row).toMatchObject({name:"Electric, home",amountMinor:5678,nextDate:"2026-12-01",notes:"Line one\nLine two"});
  });
  it.each(["xls","xlsx"] as const)("reads real %s cells, dates, formulas and every sheet",async format=>{
    const workbook=XLSX.utils.book_new();
    const sheet=XLSX.utils.aoa_to_sheet([["Bill","Due Date","Amount","Notes"],["Electric","",56.78,"Keep this"]]);
    sheet.B2={t:"n",v:(Date.UTC(2026,11,20)-Date.UTC(1899,11,30))/86400000,z:"m/d/yyyy"};
    sheet.C2={t:"n",v:56.78,f:"50+6.78"};XLSX.utils.book_append_sheet(workbook,sheet,"Bills");
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([["Bill","Date","Amount"],["Water","15th",23.45]]),"More");
    const read=await readBillDocument(XLSX.write(workbook,{type:"buffer",bookType:format}),`bills.${format}`);
    const rows=parseBillGrids(read.grids,"2026-12");expect(read.pages).toBe(2);expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({name:"Electric",amountMinor:5678,nextDate:"2026-12-20"});
    // The fixture writer emits formulas in XLSX, but only their values in XLS.
    if(format==="xlsx") expect(rows[0].sourceCells[2].formula).toBe("50+6.78");
    expect(rows[1].nextDate).toBe("2026-12-15");
  });
  it.each(["png","jpg","webp"])("reads a %s invoice without selecting or posting it",async ext=>{
    const read=await readBillDocument(readFileSync(join(root,`invoice.${ext}`)),`invoice.${ext}`);
    expect(parseSingleBill(read.text,"2026-12")[0]).toMatchObject({name:"NORTH ELECTRIC",amountMinor:5678,nextDate:"2026-12-20",suggested:false});
  });
  it("reads both scanned PDF pages and a text PDF",async()=>{
    const scan=await readBillDocument(readFileSync(join(root,"scanned.pdf")),"scanned.pdf");
    expect(scan.pages).toBe(2);expect(scan.grids).toHaveLength(2);
    const invoices=scan.grids.map(grid=>parseSingleBill(grid.rows.map(row=>row.join("\t")).join("\n"),"2026-12")[0]);
    expect(invoices.map(row=>row.amountMinor)).toEqual([5678,2345]);
    const text=await readBillDocument(textPdf("NORTH ELECTRIC",["Amount due $56.78","Due date 12/20/2026"]),"text.pdf");
    expect(parseSingleBill(text.text,"2026-12")[0]).toMatchObject({amountMinor:5678,nextDate:"2026-12-20"});
  });
  it("rejects oversized files, excessive pages, fake Excel files and excessive workbook ranges",async()=>{
    await expect(readBillDocument(Buffer.alloc(8000001),"bills.csv")).rejects.toThrow(/8 MB/);
    await expect(readBillDocument(Buffer.from("not Excel"),"bills.xls")).rejects.toThrow(/Excel workbook/);
    await expect(readBillDocument(readFileSync(join(root,"too-many.pdf")),"pages.pdf")).rejects.toThrow(/8 pages/);
    const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([["Bill","Amount"]]);sheet["!ref"]="A1:B2000";XLSX.utils.book_append_sheet(book,sheet,"Bills");
    await expect(readBillDocument(XLSX.write(book,{type:"buffer",bookType:"xlsx"}),"bills.xlsx")).rejects.toThrow(/1,000/);
  });
});
