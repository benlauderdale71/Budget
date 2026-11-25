import { expect, it } from "vitest";
import { catchUpProjection } from "@budgetcents/domain";
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
  const txn=async(payee:string,key:string,patch={})=>(await request(base+"/transactions",token,{accountId:account,spaceId,date:"2025-01-12",type:"expense",amountMinor:-1000,payee,providerTransactionId:key,...patch},201)).id;
  const source=await txn("SAMS CLUB #1234 FUEL","one");
  const second=await txn("Sam’s Club GAS 3456","two",{tags:["category-estimate"],splits:[{bucketId:catB.id,amountMinor:1000,role:"expense"}]});
  const store=await txn("SAM'S CLUB #1234","three");
  const reviewed=await txn("SAMS CLUB FUEL","four",{reviewStatus:"reviewed"});
  const balanced={accountId:account,start:"2025-01-01",end:"2025-01-31",closingMinor:-4000,previous:null};
  const coverage=()=>request(base+"/statement-coverage"+q,token);
  expect((await coverage()).accounts[0].months[0]).toMatchObject({status:"Partial",imported:4});
  await request(base+"/statement-coverage",token,{...balanced,start:"2025-01-10"});
  expect((await coverage()).accounts[0].months[0]).toMatchObject({status:"Partial",gaps:[{start:"2025-01-01",end:"2025-01-09"}]});
  await request(base+"/statement-coverage",token,{...balanced,previous:{start:"2025-01-10",closingMinor:-4000}});
  await request(base+"/statement-coverage",token,{...balanced,start:"2025-02-01",end:"2025-02-28"});
  expect((await coverage()).completeMonths).toEqual([0,1]);
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
