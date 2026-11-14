import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";
let db:Database;
afterEach(async()=>{await db?.close();});
const auth=(token:string)=>({authorization:`Bearer ${token}`,"content-type":"application/json"});
describe("detailed spending API",()=>{
  it("reads and exports the same authorized splits, compares periods, rejects inaccessible filters and never writes financial records",async()=>{
    db=await openMemoryDatabase();const app=createApp(db);
    async function request(path:string,token:string,body?:unknown) {
      const response=await app.request(path,{method:body?"POST":"GET",headers:auth(token),body:body?JSON.stringify(body):undefined});
      return {status:response.status,body:await response.json()};
    }
    async function register(email:string) {
      const registered=await request("/api/auth/register","",{email,password:"correct-horse",displayName:email,householdName:"Report test"});
      const token=registered.body.token,userId=registered.body.user.id;
      const homes=await request("/api/households",token),hid=homes.body.households[0].id;
      const dash=await request(`/api/households/${hid}/dashboard`,token);
      return {token,userId,hid,spaceId:dash.body.spaceId,buckets:dash.body.buckets};
    }
    const owner=await register("report-owner@example.com"),reader=await register("report-reader@example.com");
    const base=`/api/households/${owner.hid}`;
    await db.query(`INSERT INTO memberships (household_id,user_id,role,created_at) VALUES ($1,$2,'read_only',$3)`,[owner.hid,reader.userId,new Date().toISOString()]);
    async function account(name:string,visibility="shared") {const response=await request(`${base}/accounts`,owner.token,{spaceId:owner.spaceId,name,kind:"checking",visibility,onBudget:true});expect(response.status).toBe(201);return response.body.id as string;}
    const shared=await account("Joint Checking"),secret=await account("Secret Vault","private");
    const categories=owner.buckets.filter((b:any)=>b.kind==="expense"&&!b.systemRole),food=categories[0].id,home=categories[1].id;
    async function transaction(accountId:string,patch:Record<string,unknown>) {
      const response=await request(`${base}/transactions`,owner.token,{spaceId:owner.spaceId,accountId,date:"2026-11-05",amountMinor:-10000,type:"expense",payee:"Market",...patch});
      expect(response.status,JSON.stringify(response.body)).toBe(201);return response.body.id;
    }
    const split=await transaction(shared,{tags:["weekly"],notes:"Grocery and home purchase",splits:[{bucketId:food,amountMinor:6000,role:"expense"},{bucketId:home,amountMinor:4000,role:"expense"}]});
    await transaction(shared,{date:"2026-10-22",amountMinor:-3000,splits:[{bucketId:food,amountMinor:3000,role:"expense"}]});
    await transaction(shared,{type:"refund",amountMinor:1000,splits:[{bucketId:food,amountMinor:1000,role:"refund"}]});
    await transaction(shared,{payee:"Pending store",bankStatus:"pending",amountMinor:-2000});
    await transaction(secret,{payee:"Hidden Payee",notes:"Private amount 654.32",amountMinor:-65432,tags:["secret-tag"]});
    await request(`${base}/dashboard`,owner.token);
    const financial=async()=>({transactions:await db.query(`SELECT * FROM transactions ORDER BY id`),splits:await db.query(`SELECT * FROM splits ORDER BY id`),accounts:await db.query(`SELECT * FROM accounts ORDER BY id`),assignments:await db.query(`SELECT * FROM assignments ORDER BY id`)});
    const before=await financial();
    const url=`${base}/reports/spending-detail?from=2026-11-01&to=2026-11-14&spaceId=${owner.spaceId}`;
    const report=await request(url,reader.token);expect(report.status).toBe(200);
    expect(report.body.summary).toMatchObject({grossMinor:10000,refundsMinor:1000,netMinor:9000,count:2});expect(report.body.previous.netMinor).toBe(3000);
    expect(report.body.lines.filter((l:any)=>l.transactionId===split)).toHaveLength(2);
    expect(JSON.stringify(report.body)).not.toMatch(/Secret Vault|Hidden Payee|65432|secret-tag/);
    expect((await request(url,owner.token)).body.summary.netMinor).toBe(74432);
    const filtered=await request(`${url}&bucketId=${food}`,reader.token);expect(filtered.body.summary.netMinor).toBe(5000);expect(filtered.body.previous.netMinor).toBe(3000);
    const csv=await app.request(`${url}&format=csv`,{headers:auth(reader.token)});expect(csv.status).toBe(200);const csvText=await csv.text();
    expect(csvText).toContain("Net spending");expect(csvText).toContain("Grocery and home purchase");expect(csvText).toContain("Joint Checking");expect(csvText).not.toMatch(/Secret Vault|Hidden Payee|654\.32/);expect(csvText.split("\n")).toHaveLength(4);
    expect((await request(`${url}&accountId=${secret}`,reader.token)).status).toBe(404);
    expect((await request(`${url}&bucketId=absent`,reader.token)).status).toBe(404);
    for(const range of ["from=2026-02-30&to=2026-03-01","from=2026-11-02&to=2026-11-01","from=2000-01-01&to=2026-01-01"]) expect((await request(`${base}/reports/spending-detail?${range}`,reader.token)).status).toBe(400);
    expect(await financial()).toEqual(before);
    await db.query(`DELETE FROM memberships WHERE household_id=$1 AND user_id=$2`,[owner.hid,reader.userId]);
    expect((await request(url,reader.token)).status).toBe(404);
    expect((await app.request(`${url}&format=csv`,{headers:auth(reader.token)})).status).toBe(404);
  });
});
