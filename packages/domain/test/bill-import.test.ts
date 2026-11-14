import { describe, expect, it } from "vitest";
import { billImportDate, billImportSignature, parseBillGrids, parseSingleBill } from "../src/bill-import.js";

describe("bill document interpretation",()=>{
  it("separates side-by-side bills, income, totals and estimates while keeping original cells",()=>{
    const rows=parseBillGrids([{name:"Household",rows:[
      ["Date","Bill","Amount","Pay Type","Paid","Notes","Balance Owed","Income","Amount Monthly","Amount Yearly"],
      ["1st","Mortgage","$1,118.00","Online","Yes","Keep this note","$141,500.00","Salary","$3,926.00",""],
      ["3rd","Utilities","$140.15","Auto","No","","","","",""],
      ["","Groceries","$700.00","","","Covers 2 weeks","","Total","$3,926.00",""],
      ["","TOTAL","$1,958.15","","","","","Variable","Average Amount",""],
      ["","","","","","","","Medical","$50.00",""],
      ["7th","Student loan","$0.00","Auto","","","","","",""],
    ]}],"2026-12");
    expect(rows.find(r=>r.name==="Mortgage")).toMatchObject({kind:"bill",amountMinor:111800,nextDate:"2026-12-01",cadence:"monthly",balanceOwedMinor:14150000,paidReference:"Yes",paymentMethod:"Online",notes:"Keep this note"});
    expect(rows.find(r=>r.name==="Mortgage")!.sourceCells.some(c=>c.column==="Income")).toBe(false);
    expect(rows.find(r=>r.name==="Salary")).toMatchObject({kind:"income",amountMinor:392600,cadence:"monthly",suggested:false});
    expect(rows.find(r=>r.name==="Salary")!.nextDate).toBeUndefined();
    expect(rows.filter(r=>r.kind==="ignore")).toHaveLength(2);
    expect(rows.filter(r=>r.kind==="estimate").map(r=>r.name)).toEqual(["Groceries","Medical"]);
    expect(rows.find(r=>r.name==="Student loan")!.suggested).toBe(false);
  });
  it("preserves short-month anchors and refuses ambiguous or invalid ordinal OCR",()=>{
    expect(billImportDate("31st","2027-02")).toMatchObject({date:"2027-02-28",day:31});
    for(const date of ["4st","43th","18t","23th","garbled",""]) expect(billImportDate(date,"2026-12").date).toBeUndefined();
    expect(billImportDate("12/25/2026","2027-01").date).toBe("2026-12-25");
    expect(billImportDate("02/30/2026","2026-12").date).toBeUndefined();
  });
  it("retains unknown columns and formula text without recalculating or rounding money",()=>{
    const rows=parseBillGrids([{name:"Sheet",rows:[["Bill","Due Date","Amount","Account reference"],["Electric","12/03/2026","50.00000","Keep 0012"],["Water","12/04/2026","10.005",""]],formulas:{"1:2":"SUM(A5:A8)"}}],"2026-12");
    expect(rows[0].amountMinor).toBe(5000);
    expect(rows[0].sourceCells[2].formula).toBe("SUM(A5:A8)");
    expect(rows[0].sourceCells[3].value).toBe("Keep 0012");
    expect(rows[1].amountMinor).toBeUndefined();
    expect(rows[1].suggested).toBe(false);
  });
  it("leaves every image row unselected even when recognition is complete",()=>{
    const [row]=parseBillGrids([{name:"Image",ocr:true,rows:[["Date","Bill","Amount"],["15th","Internet","$49.99"]]}],"2026-12");
    expect(row).toMatchObject({nextDate:"2026-12-15",amountMinor:4999,suggested:false});
  });
  it("can suggest a single invoice without interpreting a balance as the amount due",()=>{
    const [row]=parseSingleBill("NORTH ELECTRIC\nAccount balance $300.00\nAmount due $56.78\nDue date 12/20/2026","2026-12");
    expect(row).toMatchObject({name:"NORTH ELECTRIC",amountMinor:5678,nextDate:"2026-12-20",cadence:"once",suggested:false});
    expect(parseSingleBill("Balance owed $300.00","2026-12")).toEqual([]);
    expect(parseSingleBill("CREDIT UTILITY\nAmount due -$10.00\nDue date December 20, 2026","2026-12")[0]).toMatchObject({amountMinor:-1000,nextDate:"2026-12-20",suggested:false});
  });
  it("matches an existing monthly series after it advances, while keeping different accounts separate",()=>{
    const row={name:"Internet",kind:"bill",amountMinor:4999,cadence:"monthly",nextDate:"2026-12-15",accountId:"a"};
    expect(billImportSignature(row)).toBe(billImportSignature({...row,nextDate:"2027-01-15",name:"INTERNET"}));
    expect(billImportSignature(row)).not.toBe(billImportSignature({...row,accountId:"b"}));
    expect(billImportSignature({...row,cadence:"biweekly"})).toBe(billImportSignature({...row,cadence:"biweekly",nextDate:"2026-12-29"}));
    expect(billImportSignature({...row,cadence:"every_3_months"})).not.toBe(billImportSignature({...row,cadence:"every_3_months",nextDate:"2027-01-15"}));
    expect(billImportSignature({...row,cadence:"every_3_months"})).toBe(billImportSignature({...row,cadence:"every_3_months",nextDate:"2027-03-15"}));
  });
});
