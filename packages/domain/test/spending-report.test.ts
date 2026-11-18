import { describe, expect, it } from "vitest";
import { annualSpending, detailedSpending, spendingRangeError } from "../src/spending-report.js";
import { spendingMerchantName } from "../src/merchant-names.js";
import { spendingRows } from "../src/reports.js";
import type { EngineInput, Transaction, Bucket } from "../src/types.js";
const bucket=(id:string,group="Living"):Bucket=>({id,name:id,group,kind:"expense",flexRole:"flexible",envelopeStyle:"regular",rollover:"both"});
const txn=(id:string,patch:Partial<Transaction>={}):Transaction=>({id,date:"2026-11-05",accountId:"checking",amountMinor:-10000,currency:"USD",type:"expense",payee:"Store",bankStatus:"posted",reviewStatus:"needs_review",splits:[],...patch});
function input(transactions:Transaction[]):EngineInput {return {currency:"USD",asOf:"2026-11-14",accounts:[{id:"checking",name:"Checking",kind:"checking",currency:"USD",onBudget:true},{id:"card",name:"Card",kind:"credit",currency:"USD",onBudget:false}],buckets:[bucket("Food"),bucket("Home"),bucket("Interest","Debt")],assignments:[],transactions};}
const range={from:"2026-11-01",to:"2026-11-14"};
describe("detailed spending report",()=>{
  it("conserves split amounts, subtracts refunds once, and excludes principal, movements, pending and deleted records",()=>{
    const data=input([
      txn("split",{splits:[{bucketId:"Food",amountMinor:6000,role:"expense"},{bucketId:"Home",amountMinor:4000,role:"expense"}]}),
      txn("refund",{amountMinor:2500,type:"refund",splits:[{bucketId:"Food",amountMinor:1000,role:"refund"},{bucketId:"Food",amountMinor:1500,role:"refund"}]}),
      txn("loan",{type:"loan_payment",splits:[{bucketId:null,amountMinor:9000,role:"principal"},{bucketId:"Interest",amountMinor:1000,role:"interest"}]}),
      txn("card-expense",{accountId:"card",amountMinor:-2000}),
      ...["transfer","cc_payment","income","opening","reconciliation","buy","sell","loan_proceeds"].map(type=>txn(type,{type:type as Transaction["type"]})),
      txn("pending",{bankStatus:"pending"}),txn("deleted",{deleted:true}),txn("excluded",{excludeFromReports:true}),txn("other-currency",{currency:"EUR"}),txn("missing-account",{accountId:"private"}),
    ]);
    const original=structuredClone(data),r=detailedSpending(data,range);
    expect(r.summary).toMatchObject({grossMinor:13000,refundsMinor:2500,netMinor:10500,count:4,uncategorizedMinor:2000,uncategorizedCount:1});
    for(const rows of [r.categories,r.groups,r.merchants,r.accounts,r.daily,r.monthly]) expect(rows.reduce((s,l)=>s+l.netMinor,0)).toBe(10500);
    expect(r.lines.reduce((s,l)=>s+l.amountMinor,0)).toBe(10500);
    expect(r.categories.find(r=>r.key==="Food")?.count).toBe(2);
    expect(r.options.groups).toContain("Uncategorized");
    expect(r.excluded).toEqual({pending:1,markedExcluded:1,otherCurrency:1,nonSpending:8});expect(data).toEqual(original);
    const sameCurrency={...data,transactions:data.transactions.filter(t=>t.currency==="USD")};
    expect(spendingRows(sameCurrency,range.from,range.to,()=>"all")[0].amountMinor).toBe(r.summary.netMinor);
  });
  it("filters a split instead of charging the whole purchase and applies identical filters to the previous period",()=>{
    const data=input([txn("split",{tags:["weekly"],notes:"meal",splits:[{bucketId:"Food",amountMinor:6000,role:"expense"},{bucketId:"Home",amountMinor:4000,role:"expense"}]}),txn("previous",{date:"2026-10-18",tags:["weekly"],notes:"meal",splits:[{bucketId:"Food",amountMinor:3000,role:"expense"}]}),txn("outside",{date:"2026-10-17"}),txn("wrong-account",{accountId:"card"}),txn("wrong-tag",{tags:["other"]})]);
    const r=detailedSpending(data,{...range,bucketId:"Food",accountId:"checking",tag:"weekly",group:"Living",merchant:"Store",q:"MEAL"});
    expect(r.previousFrom).toBe("2026-10-18");expect(r.previousTo).toBe("2026-10-31");
    expect(r.summary.netMinor).toBe(6000);expect(r.previous.netMinor).toBe(3000);expect(r.changeBps).toBe(10000);expect(r.lines).toHaveLength(1);
  });
  it("handles refund-only and comparison-only categories, empty data and leap-year ranges without dividing by zero",()=>{
    const r=detailedSpending(input([txn("refund",{type:"reimbursement",amountMinor:500}),txn("old",{date:"2026-10-31",splits:[{bucketId:"Food",amountMinor:1000,role:"expense"}]})]),range);
    expect(r.summary.netMinor).toBe(-500);expect(r.categories.find(c=>c.key==="Food")).toMatchObject({netMinor:0,previousMinor:1000,changeBps:-10000});
    const empty=detailedSpending(input([]),{from:"2024-02-28",to:"2024-03-01"});expect(empty.days).toBe(3);expect(empty.daily.map(d=>d.date)).toEqual(["2024-02-28","2024-02-29","2024-03-01"]);expect(empty.changeBps).toBeNull();expect(empty.summary.dailyAverageMinor).toBe(0);
    expect(spendingRangeError("2026-02-30","2026-03-01")).toBeTruthy();expect(spendingRangeError("2026-03-02","2026-03-01")).toBeTruthy();expect(spendingRangeError("2000-01-01","2026-01-01")).toBeTruthy();
  });
});

describe("yearly, monthly and average spending",()=>{
  it("calculates all three separately for every grouping and conserves splits and refunds",()=>{
    const data=input([
      txn("jan",{date:"2026-01-31",payee:"WAL-MART #123",splits:[{bucketId:"Food",amountMinor:6000,role:"expense"},{bucketId:"Home",amountMinor:4000,role:"expense"}]}),
      txn("feb",{date:"2026-02-01",payee:"Walmart Supercenter #987",amountMinor:-20000,splits:[{bucketId:"Food",amountMinor:20000,role:"expense"}]}),
      txn("refund",{date:"2026-02-15",payee:"WALMART.COM",type:"refund",amountMinor:3000,splits:[{bucketId:"Food",amountMinor:3000,role:"refund"}]}),
      txn("amazon",{date:"2026-12-31",payee:"AMZN MKTP US*ABC",amountMinor:-1251}),
      txn("old",{date:"2025-12-31"}),txn("next",{date:"2027-01-01"}),txn("pending",{bankStatus:"pending"}),txn("transfer",{type:"transfer"}),txn("hidden",{accountId:"absent"}),
    ]);
    const before=structuredClone(data),r=annualSpending(data,2026);
    expect(r.summary).toMatchObject({yearlyMinor:28251,monthlyAverageMinor:2354,count:4,grossMinor:31251,refundsMinor:3000});
    expect(r.summary.monthlyMinor).toEqual([10000,17000,0,0,0,0,0,0,0,0,0,1251]);
    expect(r.monthly).toHaveLength(12);expect(r.monthly[1].netMinor).toBe(17000);
    for(const rows of [r.categories,r.groups,r.merchants,r.accounts]) {
      expect(rows.reduce((sum,row)=>sum+row.yearlyMinor,0)).toBe(r.summary.yearlyMinor);
      for(let month=0;month<12;month++)expect(rows.reduce((sum,row)=>sum+row.monthlyMinor[month],0)).toBe(r.summary.monthlyMinor[month]);
      for(const row of rows){expect(row.monthlyMinor.reduce((a,b)=>a+b,0)).toBe(row.yearlyMinor);expect(row.monthlyAverageMinor).toBe(Math.round(row.yearlyMinor/12));}
    }
    expect(r.merchants.find(row=>row.label==="Walmart")).toMatchObject({yearlyMinor:27000,monthlyAverageMinor:2250,count:3});
    expect(r.categories.find(row=>row.key==="Food")).toMatchObject({yearlyMinor:23000,monthlyAverageMinor:1917});
    expect(r.categories.find(row=>row.key==="Home")?.monthlyMinor[0]).toBe(4000);
    expect(data).toEqual(before);
  });
  it("groups common bank names without editing the originals, supports exact names, and drills into the same lines",()=>{
    const data=input([txn("one",{payee:"Amazon.com*123"}),txn("two",{payee:"POS PURCHASE AMZN MKTP US*456"}),txn("other",{payee:"Amazonas Cafe"})]);
    expect(annualSpending(data,2026).merchants).toHaveLength(2);
    expect(annualSpending(data,2026,{},false).merchants).toHaveLength(3);
    const filters={merchantGroup:"Amazon"};
    const annual=annualSpending(data,2026,filters),detail=detailedSpending(data,{from:"2026-01-01",to:"2026-12-31",...filters});
    expect(annual.summary.yearlyMinor).toBe(20000);expect(detail.summary.netMinor).toBe(annual.summary.yearlyMinor);
    expect(detail.lines.map(line=>line.merchant)).toEqual(["Amazon.com*123","POS PURCHASE AMZN MKTP US*456"]);
    expect(spendingMerchantName("  local store  ")).toBe(spendingMerchantName("LOCAL   STORE"));
    expect(spendingMerchantName("McDonald's #333")).toBe("McDonald's");expect(spendingMerchantName("Burger King 42")).toBe("Burger King");
    expect(spendingMerchantName("CURSOR, AI SUBSCRIPTION")).toBe("Cursor");
    expect(spendingMerchantName("Debit Card purchase MCDONALD'S F25628 5814 FLORENCE AL")).toBe("McDonald's");
    expect(spendingMerchantName("Debit Card purchase CURSOR USAGE MID NOV 5734 CURSOR.COM CA")).toBe("Cursor");
    expect(spendingMerchantName("Debit Card purchase return Adjustment WAL-MART #123 5411 FLORENCE AL")).toBe("Walmart");
    expect(spendingMerchantName("BP 1234")).toBe("BP");expect(spendingMerchantName("BPM MUSIC")).toBe("BPM MUSIC");
    expect(spendingMerchantName("The Amazon Cafe")).toBe("THE AMAZON CAFE");
  });
  it("uses all twelve months for empty years, leap years and refund-only rows, with the same account/category filters",()=>{
    const empty=annualSpending(input([]),2024);expect(empty.summary.monthlyMinor).toEqual(Array(12).fill(0));expect(empty.summary.monthlyAverageMinor).toBe(0);expect(empty.monthly[1].date).toBe("2024-02");
    const data=input([txn("refund",{date:"2024-02-29",type:"refund",amountMinor:1200,splits:[{bucketId:"Food",role:"refund",amountMinor:1200}]}),txn("different",{date:"2024-02-29",accountId:"card"})]);
    const filtered=annualSpending(data,2024,{accountId:"checking",bucketId:"Food"});
    expect(filtered.summary).toMatchObject({yearlyMinor:-1200,monthlyAverageMinor:-100});expect(filtered.summary.monthlyMinor[1]).toBe(-1200);
    for(const year of [NaN,0,1899,2201,2026.5])expect(()=>annualSpending(data,year)).toThrow("Choose a year");
  });
  it("combines Sam's Club bank variants and reconciles their yearly, monthly and drilled totals",()=>{
    const names = ["DEBIT CARD PURCHASE SAMSCLUB #8196 5300 FLORENCE AL", "DEBIT CARD PURCHASE SAMSCLUB 8196 GAS 5542 FLORENCE AL", "DEBIT CARD PURCHASE WAL SAMSCLUB #8196 ****** ***1 FLORENCE AL", "Sam's Club #4321", "SAMSCLUB.COM"];
    for(const name of names) expect(spendingMerchantName(name)).toBe("Sam's Club");
    expect(spendingMerchantName("SAMS CLUBHOUSE CAFE")).toBe("SAMS CLUBHOUSE CAFE");
    expect(spendingMerchantName("THE SAMSCLUB CAFE")).toBe("THE SAMSCLUB CAFE");
    const data=input(names.map((payee,i)=>txn(`sams-${i}`,{payee,date:i===0?"2026-10-01":"2026-11-05",amountMinor:-1000})));
    const annual=annualSpending(data,2026);
    expect(annual.merchants).toHaveLength(1);
    expect(annual.summary.yearlyMinor).toBe(5000);
    expect(annual.merchants[0].merchantNames).toHaveLength(5);
    const month=detailedSpending(data,{from:"2026-11-01",to:"2026-11-30",merchantGroup:"Sam's Club"});
    expect(month.summary.netMinor).toBe(annual.merchants[0].monthlyMinor[10]);
    expect(month.summary.netMinor).toBe(4000);
    expect(annualSpending(data,2026,{},false).merchants).toHaveLength(5);
  });
});
