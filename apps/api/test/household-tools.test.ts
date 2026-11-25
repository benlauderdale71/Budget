import { expect, it } from "vitest";
import { catchUpProjection } from "@budgetcents/domain";
import { textPdf } from "../src/pdf.js";
import { statementDraft } from "../src/statement-pdf.js";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";



it("reconciles whole months, uses their actual spending, and previews, remembers and undoes merchant corrections",async({onTestFinished})=>{
  const db:Database=await openMemoryDatabase();
  onTestFinished(()=>db.close());
  const app=createApp(db);
  async function request(path:string,token:string,body?:unknown,status=200) {
    const response=await app.request(path,{method:body===undefined?"GET":"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();expect(response.status,path+" "+(result.error??"")).toBe(status);return result;
  }
  async function register(email:string){
    const {token,user}=await request("/api/auth/register","",{email,password:"correct-horse",displayName:"Test user",householdName:"House"});
    const homes=await request("/api/households",token);
    return {token,user,base:"/api/households/"+homes.households[0].id};
  }
  const {token,user,base}=await register("tools@example.com");
  const {spaceId,buckets}=await request(base+"/dashboard",token);
  const [catA,catB]=buckets.filter((b:{kind:string;systemRole?:string})=>b.kind==="expense"&&!b.systemRole);
  const account=(await request(base+"/accounts",token,{spaceId,name:"Bank",kind:"checking",onBudget:true,visibility:"private"},201)).id;
  const q="?year=2025&accountId="+account;
  const statement=textPdf("Bank statement January 2025",["01/14/2025 Cafe -12.00","01/18/2025 Payroll +45.00","01/19/2025 Missing direction 10.00"]);
  const extraction=await request(base+"/import/statement-pdf",token,{accountId:account,year:2025,data:statement.toString("base64")});
  expect(extraction.rows.map((r:{amount:string})=>r.amount)).toEqual(["-12.00","45.00",""]);
  expect(extraction.rows[2].issue).not.toBe("");
  expect(await db.query("SELECT id FROM transactions WHERE account_id=$1",[account])).toEqual([]);
  const txn=async(payee:string,key:string,patch={})=>(await request(base+"/transactions",token,{accountId:account,spaceId,date:"2025-01-12",type:"expense",amountMinor:-1000,payee,providerTransactionId:key,...patch},201)).id;
  const source=await txn("SAMS CLUB #1234 FUEL","one");
  const second=await txn("Sam’s Club GAS 3456","two",{tags:["category-estimate"],splits:[{bucketId:catB.id,amountMinor:1000,role:"expense"}]});
  const store=await txn("SAM'S CLUB #1234","three");
  const reviewed=await txn("SAMS CLUB FUEL","four",{reviewStatus:"reviewed"});
  const balanced={accountId:account,start:"2025-01-01",end:"2025-01-31",closingMinor:-4000,depositsMinor:0,withdrawalsMinor:4000,transactionCount:4,previous:null};
  const coverage=()=>request(base+"/statement-coverage"+q,token);
  expect((await coverage()).accounts[0].months[0]).toMatchObject({status:"Partial",imported:4});
  await request(base+"/statement-coverage",token,{...balanced,start:"2025-01-10"});
  expect((await coverage()).accounts[0].months[0]).toMatchObject({status:"Partial",gaps:[{start:"2025-01-01",end:"2025-01-09"}]});
  await request(base+"/statement-coverage",token,{...balanced,previous:{...balanced,start:"2025-01-10"}});
  await request(base+"/statement-coverage",token,{...balanced,start:"2025-02-01",end:"2025-02-28",withdrawalsMinor:0,transactionCount:0});
  expect((await coverage()).completeMonths).toEqual([0,1]);
  await request(base+"/statement-coverage",token,{...balanced,depositsMinor:5000,withdrawalsMinor:9000,previous:balanced});
  expect((await coverage()).accounts[0].months[0].status).toBe("Activity mismatch");
  await request(base+"/statement-coverage",token,{...balanced,depositsMinor:null,withdrawalsMinor:null,previous:{...balanced,depositsMinor:5000,withdrawalsMinor:9000}});
  expect((await coverage()).accounts[0].months[0].status).toBe("Balance only");
  await request(base+"/statement-coverage",token,{...balanced,previous:{...balanced,depositsMinor:null,withdrawalsMinor:null}});
  const seasonal=(await request(base+"/accounts",token,{spaceId,name:"Seasonal",kind:"checking",onBudget:true},201)).id;
  await request(base+"/account-lifetime",token,{accountId:seasonal,opened:"2025-07-01",closed:null,previous:{opened:null,closed:null}});
  expect((await request(base+"/statement-coverage?year=2025",token)).completeMonths).toEqual([0,1]);
  await txn("Different vendor","mar",{date:"2025-03-04",amountMinor:-2000});
  const annual=await request(base+"/reports/spending-year"+q,token);
  expect(annual.summary).toMatchObject({yearlyMinor:6000,monthlyAverageMinor:500,completeMonthAverageMinor:2000});
  const rule={sourceId:source,bucketId:catA.id,future:true};
  const preview=()=>request(base+"/merchant-corrections",token,rule);
  const first=await preview();
  expect(first.rows.map((r:{id:string})=>r.id).sort()).toEqual([source,second].sort());
  await db.query("UPDATE transactions SET version=version+1 WHERE id=$1",[second]);
  await request(base+"/merchant-corrections",token,{...rule,confirm:first.token},409);
  const apply={...rule,confirm:(await preview()).token};
  const batch=await request(base+"/merchant-corrections",token,apply);
  expect(batch.applied).toBe(2);
  const tags=()=>db.query("SELECT tag FROM transaction_tags WHERE transaction_id=$1",[second]);
  expect(await tags()).toEqual([]);
  expect((await request(base+"/merchant-corrections",token,apply)).batchId).toBe(batch.batchId);
  const incoming=await txn("SAMSCLUBGAS #5050","five",{bankStatus:"pending"});
  await txn("SAMSCLUBGAS #5050","five");
  async function category(id:string){return (await db.query("SELECT bucket_id FROM splits WHERE transaction_id=$1",[id]))[0]?.bucket_id;}
  expect(await category(incoming)).toBe(catA.id);
  expect(await category(store)).toBeUndefined();
  expect(await category(reviewed)).toBeUndefined();
  await db.query("UPDATE transactions SET reconciled=1 WHERE id=$1",[incoming]);
  expect(await request(base+"/merchant-corrections/"+batch.batchId+"/undo",token,{})).toMatchObject({restored:2,skipped:1});
  expect(await category(incoming)).toBe(catA.id);
  expect(await category(second)).toBe(catB.id);
  expect(await tags()).toEqual([{tag:"category-estimate"}]);
  expect(await category(source)).toBeUndefined();
  expect(await category(await txn("SAMS CLUB FUEL","six"))).toBeUndefined();
  expect((await coverage()).accounts[0].months[0].status).toBe("Balance mismatch");
  expect((await request(base+"/reports/spending-year"+q,token)).summary.completeMonthAverageMinor).toBe(null);

  const reader=await register("other@example.com");
  await db.query("INSERT INTO memberships(household_id,user_id,role,created_at) VALUES($1,$2,'read_only',$3)",[base.split("/").pop(),reader.user.id,new Date().toISOString()]);
  await request(base+"/statement-coverage"+q,reader.token,undefined,404);
  await request(base+"/merchant-corrections",reader.token,rule,403);
  expect(user.id).toBeTruthy();
  const forecast={name:"Power bill",pastDueMinor:5000,bufferMinor:1000,essentialsPerPayMinor:300,asOf:"2025-04-01",days:30,regular:null,agreements:[]};
  await request(base+"/income-sources",token,{spaceId,accountId:account,name:"Pay",kind:"irregular",cadence:"irregular",amountMinor:0,startDate:"2025-04-01",dates:[{date:"2025-04-04",amountMinor:20000}]},201);
  const plan=await request(base+"/catch-up",token,{accountId:account,terms:forecast,save:true,version:0});
  expect(plan.rows[0]).toMatchObject({date:"2025-04-04",payMinor:20000,extraMinor:5000,essentialsMinor:300});
  expect((await request(base+"/catch-up?accountId="+account,token)).terms).toEqual(forecast);
  await request(base+"/catch-up",token,{accountId:account,terms:{...forecast,name:"Stale draft"},save:true,version:0},409);
  await request(base+"/catch-up?accountId="+account,reader.token,undefined,404);

  const groupPlan={...forecast,additionalBills:[{name:"Phone",pastDueMinor:3200,regular:null,agreements:[{date:"2025-04-06",amountMinor:1200}]}]};
  const groupResult=await request(base+"/catch-up",token,{accountId:account,terms:groupPlan,save:true,version:1});
  const correction=await request(base+"/merchant-corrections",token,{...rule,confirm:(await preview()).token});
  const asset=(await request(base+"/physical-assets",token,{name:"Camera",estimate:{amountMinor:12500,asOf:"2025-11-17",sourceName:"Personal estimate",sourceType:"manual"}},201)).asset;
  const photo=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHmoAAAAASUVORK5CYII=","base64");
  const attachment=new FormData();attachment.set("file",new Blob([photo]),"camera.png");
  expect((await app.request(base+"/physical-assets/"+asset.id+"/files",{method:"POST",headers:{authorization:"Bearer "+token},body:attachment})).status).toBe(201);
  const backup=await request(base+"/backup",token);
  const privateView=await request(base+"/backup",reader.token);
  expect(privateView.physical_asset_documents).toEqual([]);expect(privateView.catch_up_plans).toEqual([]);
  expect(backup.version).toBe(3);
  const copy="/api/households/recovery-test";
  await db.query("INSERT INTO households(id,name,kind,currency,budget_approach,created_at) SELECT 'recovery-test','Recovered',kind,currency,budget_approach,created_at FROM households WHERE id=$1",[base.split("/").pop()]);
  await db.query("INSERT INTO memberships(household_id,user_id,role,created_at) VALUES('recovery-test',$1,'owner',$2)",[user.id,new Date().toISOString()]);
  const before=await request(copy+"/restore",token,{mode:"preview",backup});
  expect(before.adds).toMatchObject({statement_periods:2,physical_asset_files:1,physical_asset_estimates:1,catch_up_plans:1,account_lifetimes:1});
  expect(await db.query("SELECT id FROM accounts WHERE household_id='recovery-test'")).toEqual([]);
  await request(copy+"/restore",token,{mode:"add-missing",backup});
  const restored=await request(copy+"/backup",token);
  const recoveredAccount=restored.accounts.find((r:{name:string})=>r.name==="Bank").id;
  expect(recoveredAccount).not.toBe(account);
  expect(restored.transactions.map((r:{amount_minor:number})=>r.amount_minor).sort()).toEqual(backup.transactions.map((r:{amount_minor:number})=>r.amount_minor).sort());
  const coverageCopy=await request(copy+"/statement-coverage?year=2025&accountId="+recoveredAccount,token);
  expect(coverageCopy.accounts[0].statements.map((r:{differenceMinor:number})=>r.differenceMinor)).toEqual((await coverage()).accounts[0].statements.map((r:{differenceMinor:number})=>r.differenceMinor));
  expect((await request(copy+"/catch-up?accountId="+recoveredAccount,token)).terms).toEqual(groupPlan);
  expect((await request(copy+"/catch-up",token,{accountId:recoveredAccount,terms:groupPlan,version:2})).rows).toEqual(groupResult.rows);
  const restoredAsset=(await request(copy+"/physical-assets",token)).assets[0];
  expect(restoredAsset.estimate.amountMinor).toBe(12500);
  const file=await app.request(copy+"/physical-assets/documents/"+restored.physical_asset_documents[0].id,{headers:{authorization:"Bearer "+token}});
  expect(Buffer.from(await file.arrayBuffer())).toEqual(photo);
  const repeat=await request(copy+"/restore",token,{mode:"add-missing",backup});
  expect(Object.values(repeat.added).every(n=>n===0)).toBe(true);
  const undo=restored.merchant_corrections.find((r:{undone:number})=>!r.undone);
  expect(undo.id).not.toBe(correction.batchId);
  expect((await request(copy+"/merchant-corrections/"+undo.id+"/undo",token,{})).restored).toBeGreaterThan(0);
});

it("reserves later bills and promised installments before suggesting extra on each payday",()=>{
  const terms={name:"Rent",asOf:"2025-03-01",days:20,pastDueMinor:700,bufferMinor:100,essentialsPerPayMinor:100,
    regular:{date:"2025-03-06",amountMinor:400},agreements:[{date:"2025-03-07",amountMinor:200}]};
  const pay=(date:string,amountMinor:number)=>({date,amountMinor,id:date,kind:"income" as const,label:"Paycheck"});
  const r=catchUpProjection(terms,100,[pay("2025-03-03",750),pay("2025-03-10",600)]);
  expect(r.rows.map(d=>[d.date,d.extraMinor])).toEqual([["2025-03-03",50],["2025-03-06",0],["2025-03-07",0],["2025-03-10",450]]);
  expect(r).toMatchObject({lowestMinor:100,payoffDate:"2025-03-10",remainingMinor:0,firstShortfall:null});
  expect(catchUpProjection(terms,0,[])).toMatchObject({payoffDate:null,firstShortfall:"2025-03-06",remainingMinor:500});
});

it("protects both creditors' promises and reserves each paycheck's essentials once",()=>{
  const agreement={date:"2025-03-05",amountMinor:300};
  const terms={name:"Power",asOf:"2025-03-01",days:10,pastDueMinor:800,bufferMinor:100,essentialsPerPayMinor:100,
    regular:null,agreements:[agreement],additionalBills:[{name:"Phone",pastDueMinor:600,regular:null,agreements:[agreement]}]};
  const pay={id:"pay",kind:"income" as const,label:"Pay",date:"2025-03-02",amountMinor:1200};
  const result=catchUpProjection(terms,0,[pay]);
  expect(result.rows[0]).toMatchObject({essentialsMinor:100,extraMinor:400});
  expect(result.creditors.map(c=>c.remainingMinor)).toEqual([100,300]);
  const short=catchUpProjection(terms,0,[{...pay,amountMinor:450}]);
  expect(short.creditors[1]).toMatchObject({unfundedMinor:250,firstUnfundedDate:"2025-03-05"});
  expect(short.payoffDate).toBeNull();
});
it("uses deposit and withdrawal columns and keeps an unrecognized PDF page visible",()=>{
  const draft=statementDraft(["Date    Description         Withdrawals   Deposits   Balance\n01/04   Grocery                 75.00                 425.00\n01/05   Weekly pay                         125.00     550.00","Unreadable"],2025);
  expect(draft.rows.map(r=>r.amount)).toEqual(["-75.00","125.00"]);
  expect(draft.warnings[0]).toContain("Page 2");
});
