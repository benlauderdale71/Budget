import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";
let db:Database;
afterEach(async()=>{await db?.close();});
type App=ReturnType<typeof createApp>;
async function json(response:Response){return {status:response.status,body:await response.json()};}
const auth=(token:string)=>({authorization:`Bearer ${token}`,"content-type":"application/json"});
async function register(app:App,email:string) {
  const registered=await json(await app.request("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:"correct-horse",displayName:email,householdName:"Bill import test"})}));
  const token=registered.body.token,userId=registered.body.user.id;
  const homes=await json(await app.request("/api/households",{headers:auth(token)})),hid=homes.body.households[0].id;
  const dashboard=await json(await app.request(`/api/households/${hid}/dashboard`,{headers:auth(token)}));
  return {token,userId,hid,spaceId:dashboard.body.spaceId};
}
type Home=Awaited<ReturnType<typeof register>>;
const csv='Date,Bill,Amount,Pay Type,Paid,Notes,Balance Owed,Income,Amount Monthly\n1st,Rent,1000,Auto,Yes,Lease note,12000,Salary,2500\n15th,Internet,49.99,Online,No,Reference only,,,\n,TOTAL,1049.99,,,,,,\n,Groceries,150,,,Weekly estimate,,,';
async function upload(app:App,home:Home,accountId="",content=csv){
  const form=new FormData();form.set("file",new Blob([content],{type:"text/csv"}),"bills.csv");form.set("spaceId",home.spaceId);form.set("month","2026-12");if(accountId)form.set("accountId",accountId);
  return json(await app.request(`/api/households/${home.hid}/bill-imports`,{method:"POST",headers:{authorization:`Bearer ${home.token}`},body:form}));
}
const selection=(preview:any,accountId="")=>({reviewed:true,rows:preview.rows.filter((r:any)=>r.kind==="bill").map((r:any)=>({...r,accountId:accountId||undefined}))});
async function confirm(app:App,home:Home,id:string,body:unknown){return json(await app.request(`/api/households/${home.hid}/bill-imports/${id}/confirm`,{method:"POST",headers:auth(home.token),body:JSON.stringify(body)}));}
async function money(){return {transactions:await db.query(`SELECT id,amount_minor FROM transactions ORDER BY id`),assignments:await db.query(`SELECT * FROM assignments ORDER BY id`),accounts:await db.query(`SELECT * FROM accounts ORDER BY id`)};}

describe("bill document imports",()=>{
  it("previews without financial writes, atomically saves selected schedules, and deduplicates retries and reuploads",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),home=await register(app,"owner@example.com");
    expect((await json(await app.request(`/api/households/${home.hid}/accounts`,{method:"POST",headers:auth(home.token),body:JSON.stringify({spaceId:home.spaceId,name:"Checking",kind:"checking",onBudget:true,openingBalanceMinor:50000,openingDate:"2026-11-01"})}))).status).toBe(201);
    const before=await money(),preview=await upload(app,home);
    expect(preview.status).toBe(201);expect(preview.body.rows).toHaveLength(5);
    expect(await db.query(`SELECT * FROM schedules`)).toHaveLength(0);expect(await money()).toEqual(before);
    const body=selection(preview.body),saved=await confirm(app,home,preview.body.id,body);
    expect(saved.status).toBe(200);expect(saved.body.created).toHaveLength(2);expect(saved.body.skipped).toHaveLength(0);
    expect(await money()).toEqual(before);
    const schedules=await db.query(`SELECT * FROM schedules ORDER BY amount_minor`);
    expect(schedules.map(r=>[r.name,r.amount_minor,r.next_date,r.cadence])).toEqual([["Internet",4999,"2026-12-15","monthly"],["Rent",100000,"2026-12-01","monthly"]]);
    const details=await json(await app.request(`/api/households/${home.hid}/schedules/${saved.body.created[0].id}/import-details`,{headers:auth(home.token)}));
    expect(details.body.details).toMatchObject({paidReference:"Yes",paymentMethod:"Auto",balanceOwedMinor:1200000,notes:"Lease note"});
    expect(details.body.details.sourceCells.some((c:any)=>c.column==="Income")).toBe(false);
    const repeated=await confirm(app,home,preview.body.id,body);expect(repeated.body.repeated).toBe(true);
    const changed=structuredClone(body);changed.rows[0].amountMinor=2;expect((await confirm(app,home,preview.body.id,changed)).status).toBe(409);
    const next=await upload(app,home);expect(next.body.rows.filter((r:any)=>r.duplicate)).toHaveLength(2);
    const second=await confirm(app,home,next.body.id,selection(next.body));expect(second.body.created).toHaveLength(0);expect(second.body.skipped).toHaveLength(2);
    expect(await db.query(`SELECT * FROM schedules`)).toHaveLength(2);expect(await money()).toEqual(before);
  });
  it("requires review, rejects invalid selections and rolls back every row if one account/category is invalid",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),home=await register(app,"invalid@example.com"),preview=await upload(app,home),body=selection(preview.body);
    expect((await confirm(app,home,preview.body.id,{...body,reviewed:false})).status).toBe(400);
    const invalid=structuredClone(body);invalid.rows[1].nextDate="2026-02-30";expect((await confirm(app,home,preview.body.id,invalid)).status).toBe(400);
    const badCategory=structuredClone(body);badCategory.rows[1].bucketId="absent";expect((await confirm(app,home,preview.body.id,badCategory)).status).toBe(404);
    expect(await db.query(`SELECT * FROM schedules`)).toHaveLength(0);expect(await db.query(`SELECT * FROM schedule_import_details`)).toHaveLength(0);
    expect((await db.query(`SELECT result_json FROM bill_import_drafts`))[0].result_json).toBeNull();
    const altered=structuredClone(body);altered.rows[0].key="outside";expect((await confirm(app,home,preview.body.id,altered)).status).toBe(400);
    const estimates=preview.body.rows.find((r:any)=>r.kind==="estimate");expect((await confirm(app,home,preview.body.id,{reviewed:true,rows:[estimates]})).status).toBe(400);
    const income=preview.body.rows.find((r:any)=>r.kind==="income");income.nextDate="2026-12-01";
    const before=await money();expect((await confirm(app,home,preview.body.id,{reviewed:true,rows:[income]})).status).toBe(200);
    expect((await db.query(`SELECT direction,type FROM schedules`))[0]).toEqual({direction:"inflow",type:"income"});expect(await money()).toEqual(before);
  });
  it("keeps drafts uploader-only, hides private references and rechecks membership before confirm",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),owner=await register(app,"private@example.com"),other=await register(app,"editor@example.com");
    await db.query(`INSERT INTO memberships (household_id,user_id,role,created_at) VALUES ($1,$2,'editor',$3)`,[owner.hid,other.userId,new Date().toISOString()]);
    const editor={...other,hid:owner.hid,spaceId:owner.spaceId};
    const account=await json(await app.request(`/api/households/${owner.hid}/accounts`,{method:"POST",headers:auth(owner.token),body:JSON.stringify({spaceId:owner.spaceId,name:"Private checking",kind:"checking",onBudget:true,visibility:"private",openingBalanceMinor:10000,openingDate:"2026-11-01"})}));
    expect(account.status).toBe(201);
    const preview=await upload(app,owner,account.body.id);
    expect((await json(await app.request(`/api/households/${owner.hid}/bill-imports/${preview.body.id}`,{headers:auth(editor.token)}))).status).toBe(404);
    expect((await upload(app,editor,account.body.id)).status).toBe(404);
    const saved=await confirm(app,owner,preview.body.id,selection(preview.body,account.body.id));expect(saved.status).toBe(200);
    expect((await json(await app.request(`/api/households/${owner.hid}/schedules/${saved.body.created[0].id}/import-details`,{headers:auth(editor.token)}))).status).toBe(404);
    const visible=await json(await app.request(`/api/households/${owner.hid}/schedules?spaceId=${owner.spaceId}`,{headers:auth(editor.token)}));expect(visible.body.schedules).toHaveLength(0);
    const draft=await upload(app,editor);await db.query(`UPDATE memberships SET role='read_only' WHERE household_id=$1 AND user_id=$2`,[owner.hid,editor.userId]);
    expect((await confirm(app,editor,draft.body.id,selection(draft.body))).status).toBe(403);
    expect((await upload(app,editor)).status).toBe(403);
    await db.query(`DELETE FROM memberships WHERE household_id=$1 AND user_id=$2`,[owner.hid,editor.userId]);
    expect((await confirm(app,editor,draft.body.id,selection(draft.body))).status).toBe(404);
  });
  it("serializes simultaneous confirmations so only one set of schedules is created",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),home=await register(app,"retry@example.com"),preview=await upload(app,home),body=selection(preview.body);
    const results=await Promise.all([confirm(app,home,preview.body.id,body),confirm(app,home,preview.body.id,body)]);
    expect(results.map(r=>r.status)).toEqual([200,200]);expect(results.map(r=>r.body.repeated).sort()).toEqual([false,true]);
    expect(await db.query(`SELECT * FROM schedules`)).toHaveLength(2);
  });
});
