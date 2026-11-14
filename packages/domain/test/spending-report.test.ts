import { describe, expect, it } from "vitest";
import { detailedSpending, spendingRangeError } from "../src/spending-report.js";
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
