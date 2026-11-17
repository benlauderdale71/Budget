import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";
import sharp from "sharp";
let db:Database;
afterEach(async()=>{await db?.close();});
type App=ReturnType<typeof createApp>;
const json=async(r:Response)=>({status:r.status,body:await r.json()});
const auth=(token:string)=>({authorization:`Bearer ${token}`,"content-type":"application/json"});
async function home(app:App,email="owner@example.com") {
  const r=await json(await app.request("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:"asset-test-passphrase",displayName:email,householdName:"Asset QA"})}));
  const h=await json(await app.request("/api/households",{headers:auth(r.body.token)}));
  return {token:r.body.token as string,userId:r.body.user.id as string,hid:h.body.households[0].id as string};
}
type Home=Awaited<ReturnType<typeof home>>;
const path=(h:Home,s="")=>`/api/households/${h.hid}/physical-assets${s}`;
const request=async(app:App,h:Home,s="",body?:unknown,method=body?"POST":"GET")=>json(await app.request(path(h,s),{method,headers:auth(h.token),body:body===undefined?undefined:JSON.stringify(body)}));
const estimate={amountMinor:12500,asOf:"2026-11-17",sourceName:"Comparable sale",sourceUrl:"https://example.com/sold/1",sourceType:"sold_comparable"};
const csv="Name,Category,Location,Quantity,Estimated value,Source,As of\nLaptop,Electronics,Office,1,125.00,Comparable sale,2026-11-17\nDesk,Furniture,Office,2,80.00,Personal estimate,2026-11-17";
async function upload(app:App,h:Home,data=csv,name="assets.csv") {
  const form=new FormData();form.set("file",new Blob([data]),name);
  return json(await app.request(path(h,"/imports"),{method:"POST",headers:{authorization:`Bearer ${h.token}`},body:form}));
}
const selected=(p:any)=>({reviewed:true,rows:p.rows.map((r:any)=>({...r,estimate:r.estimateMinor===null?undefined:{...estimate,amountMinor:r.estimateMinor}}))});
async function money() {return {accounts:await db.query("SELECT * FROM accounts ORDER BY id"),transactions:await db.query("SELECT * FROM transactions ORDER BY id"),assignments:await db.query("SELECT * FROM assignments ORDER BY id")};}
describe("physical asset inventory",()=>{
  it("stores and previews private photos, removes attachments and preserves the asset",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),h=await home(app),a=(await request(app,h,"",{name:"Desk photo"})).body.asset;
    const bytes=await sharp({create:{width:100,height:100,channels:3,background:"teal"}}).png().toBuffer();
    const form=new FormData();form.set("file",new Blob([new Uint8Array(bytes)]),"desk.png");
    const added=await json(await app.request(path(h,`/${a.id}/files`),{method:"POST",headers:{authorization:`Bearer ${h.token}`},body:form}));expect(added.status).toBe(201);
    const doc=added.body.asset.documents[0];
    const preview=await app.request(path(h,`/documents/${doc.id}?preview=image`),{headers:auth(h.token)});expect(preview.status).toBe(200);expect(preview.headers.get("content-type")).toBe("image/webp");expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await request(app,h,`/${a.id}/files/${doc.id}`,undefined,"DELETE")).status).toBe(200);
    expect((await request(app,h)).body.assets[0].documents).toEqual([]);expect(await db.query("SELECT * FROM physical_asset_documents")).toHaveLength(0);
  });
  it("stores editable assets and dated source history without changing the ledger; protects stale edits",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),h=await home(app),before=await money();
    const created=await request(app,h,"",{name:"Laptop",quantity:2,category:"Electronics",estimate});expect(created.status).toBe(201);
    const a=created.body.asset;expect(a).toMatchObject({name:"Laptop",quantity:2,visibility:"private",version:1,estimate:{amountMinor:12500,sourceUrl:estimate.sourceUrl}});
    const saved=await request(app,h,`/${a.id}`,{...a,location:"Home office",tags:["Warranty"]},"PUT");expect(saved.status).toBe(200);
    expect((await request(app,h,`/${a.id}`,{...a,name:"Stale"},"PUT")).status).toBe(409);
    const older=await request(app,h,`/${a.id}/estimates`,{...estimate,amountMinor:18000,asOf:"2025-01-01",version:2});expect(older.status).toBe(201);expect(older.body.asset.estimate.amountMinor).toBe(12500);expect(older.body.asset.estimates).toHaveLength(2);
    const newer=await request(app,h,`/${a.id}/estimates`,{...estimate,amountMinor:11000,asOf:"2026-11-18",version:3});expect(newer.status).toBe(201);expect(newer.body.asset.estimate.amountMinor).toBe(11000);
    expect((await request(app,h,`/${a.id}/estimates`,{...estimate,sourceUrl:"javascript:alert(1)",version:4})).status).toBe(400);
    expect((await request(app,h,"",{name:"Invalid",quantity:0})).status).toBe(400);
    expect((await request(app,h,`/${a.id}`,{...newer.body.asset,archived:true},"PUT")).body.asset.archived).toBe(true);
    expect(await money()).toEqual(before);
    const list=await request(app,h);expect(list.body.assets).toHaveLength(1);
  });
  it("previews privately, requires review, deduplicates concurrent confirmation and reupload, and retains the original",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),h=await home(app),before=await money(),p=await upload(app,h);
    expect(p.status).toBe(201);expect(p.body.rows).toHaveLength(2);expect((await request(app,h)).body.assets).toHaveLength(0);
    expect((await request(app,h,`/imports/${p.body.id}/confirm`,{...selected(p.body),reviewed:false})).status).toBe(400);
    const results=await Promise.all([request(app,h,`/imports/${p.body.id}/confirm`,selected(p.body)),request(app,h,`/imports/${p.body.id}/confirm`,selected(p.body))]);
    expect(results.map(r=>r.status)).toEqual([200,200]);expect(results.map(r=>r.body.repeated).sort()).toEqual([false,true]);
    expect((await request(app,h)).body.assets).toHaveLength(2);
    const p2=await upload(app,h);expect(p2.body.rows.every((r:any)=>r.duplicate)).toBe(true);
    expect((await request(app,h,`/imports/${p2.body.id}/confirm`,selected(p2.body))).body.skipped).toHaveLength(2);
    const document=await app.request(path(h,`/documents/${p.body.documentId}`),{headers:auth(h.token)});expect(document.status).toBe(200);expect(await document.text()).toBe(csv);
    const invalid=structuredClone(selected(p.body));invalid.rows[0].name="Changed";expect((await request(app,h,`/imports/${p.body.id}/confirm`,invalid)).status).toBe(409);
    expect(await money()).toEqual(before);
  });
  it("enforces membership, private/shared ownership, uploader-only files, and role changes",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),owner=await home(app),other=await home(app,"other@example.com");
    const asset=(await request(app,owner,"",{name:"Private camera"})).body.asset;
    expect((await request(app,{...other,hid:owner.hid})).status).toBe(404);
    await db.query(`INSERT INTO memberships (household_id,user_id,role,created_at) VALUES ($1,$2,'editor',$3)`,[owner.hid,other.userId,new Date().toISOString()]);
    const editor={...other,hid:owner.hid};expect((await request(app,editor)).body.assets).toHaveLength(0);
    expect((await request(app,editor,`/${asset.id}`,{...asset,name:"Steal"},"PUT")).status).toBe(404);
    const shared=(await request(app,owner,`/${asset.id}`,{...asset,visibility:"shared"},"PUT")).body.asset;
    expect((await request(app,editor)).body.assets).toHaveLength(1);
    expect((await request(app,editor,`/${asset.id}`,{...shared,visibility:"private"},"PUT")).status).toBe(403);
    const p=await upload(app,owner);
    expect((await request(app,editor,`/documents/${p.body.documentId}`)).status).toBe(404);
    expect((await request(app,editor,`/imports/${p.body.id}/confirm`,selected(p.body))).status).toBe(404);
    const editorDraft=await upload(app,editor);
    await db.query(`UPDATE memberships SET role='read_only' WHERE household_id=$1 AND user_id=$2`,[owner.hid,other.userId]);
    expect((await request(app,editor,`/imports/${editorDraft.body.id}/confirm`,selected(editorDraft.body))).status).toBe(403);
    expect((await request(app,editor,`/${asset.id}/estimates`,{...estimate,version:shared.version})).status).toBe(403);
    expect((await request(app,editor,"",{name:"Unauthorized"})).status).toBe(403);
  });
  it("exports safely, rejects invalid batches atomically, and cascades household deletion",async()=>{
    db=await openMemoryDatabase();const app=createApp(db),h=await home(app),p=await upload(app,h);
    const bad=selected(p.body);bad.rows[1].quantity=-2;expect((await request(app,h,`/imports/${p.body.id}/confirm`,bad)).status).toBe(400);expect((await request(app,h)).body.assets).toHaveLength(0);
    await request(app,h,"",{name:'=HYPERLINK("evil")',estimate});
    const exported=await app.request(path(h,"/export?format=csv"),{headers:auth(h.token)});expect(exported.status).toBe(200);expect(await exported.text()).toContain("'=HYPERLINK");
    const backup=await request(app,h,"/export");expect(backup.body.assets[0].estimatedValue).toBe(125);expect(backup.body.assets[0].estimates).toHaveLength(1);
    const reimport=await upload(app,h,JSON.stringify(backup.body),"export.json");expect(reimport.status).toBe(201);expect(reimport.body.rows[0].estimateMinor).toBe(12500);
    await db.query("UPDATE users SET privacy_mode=1 WHERE id=$1",[h.userId]);expect((await request(app,h,"/export")).status).toBe(403);
    await db.query("DELETE FROM households WHERE id=$1",[h.hid]);
    for(const table of ["physical_assets","physical_asset_estimates","physical_asset_files","physical_asset_documents","physical_asset_imports"]) expect(await db.query(`SELECT * FROM ${table}`)).toHaveLength(0);
  });
});
