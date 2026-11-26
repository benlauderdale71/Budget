import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import sharp from "sharp";
import { isIsoDate, minorFactor, toCsv } from "@budgetcents/domain";
import { id, nowIso, sha256 } from "./crypto.js";
import type { Database } from "./db.js";
import { ApiError, assertWrite, audit, lockHousehold, requireMember, type Actor } from "./finance.js";
import { readAssetCatalog } from "./asset-catalog.js";
import { ASSET_CATEGORIES, readAssetFile } from "./asset-import.js";

const text = (max: number) => z.string().trim().max(max).default("");
const money = z.number().int().min(0).max(999999999999);
const date = z.string().refine(isIsoDate, "Use a valid date (YYYY-MM-DD).");
const url = z.string().max(2000).refine(s => {
  if (!s) return true;
  try { const u = new URL(s); return ["https:","http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, "Use an http or https source link.");
const estimateSchema = z.object({
  amountMinor: money, asOf: date, sourceName: z.string().trim().min(1).max(200), sourceUrl: url.default(""),
  sourceType: z.enum(["manual","sold_comparable","asking_price","appraisal","replacement_cost"]).default("manual"),
  notes: text(4000),
});
const assetSchema = z.object({
  name: z.string().trim().min(1).max(160), category: z.string().trim().min(1).max(80).default("Other"),
  location: text(120), brand: text(100), model: text(100), serialNumber: text(160),
  condition: z.enum(["new","excellent","good","fair","poor","unknown"]).default("unknown"),
  quantity: z.number().int().min(1).max(10000).default(1), tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  notes: text(4000), purchaseDate: z.union([date,z.literal("")]).default(""), purchaseMinor: money.nullable().default(null),
  visibility: z.enum(["shared","private"]).default("private"), archived: z.boolean().default(false),
});
type Asset = z.infer<typeof assetSchema>;
type Estimate = z.infer<typeof estimateSchema>;
type Row = { id: string; household_id: string; owner_user_id: string; payload_json: string; version: number; created_at: string; updated_at: string; source_key: string | null; document_id: string | null };
type Document = { id:string; household_id:string; owner_user_id:string; filename:string; data_base64:string; fingerprint:string; created_at:string };
type Draft = {id:string; household_id:string; user_id:string; document_id:string; preview_json:string; result_json:string|null; confirm_hash:string|null; expires_at:string};

export function mountPhysicalAssets(app: Hono, db: Database, actor: (c: Context) => Promise<Actor>, limit: (key: string, maximum: number) => void) {
  const base = "/api/households/:hid/physical-assets";
  app.use(`${base}/*`, bodyLimit({maxSize:9_000_000,onError:c=>c.json({error:"Choose a file no larger than 8 MB."},413)}));
  app.use(base, bodyLimit({maxSize:100_000,onError:c=>c.json({error:"This asset record is too large."},413)}));
  async function member(c: Context, write = false) {
    const me = await actor(c), hid = c.req.param("hid")!;
    const membership = await requireMember(db,me.id,hid);
    if (write) assertWrite(membership);
    return {me,hid,membership};
  }
  app.get(`${base}/catalog`, async c => {
    const {me} = await member(c);
    limit("asset-catalog:" + me.id, 60);
    c.header("Cache-Control", "no-store");
    return c.json(await readAssetCatalog(c.req.query("source") ?? "", (c.req.query("q") ?? "").trim()));
  });
  function visible(row: Row, userId: string) { return row.owner_user_id===userId || JSON.parse(row.payload_json).visibility==="shared"; }
  async function visibleImportKeys(hid: string, userId: string, fingerprint: string) {
    const records = await db.query<{source_key: string}>(`SELECT source_key FROM physical_assets
      WHERE household_id=$1 AND source_key LIKE $3 AND (owner_user_id=$2 OR payload_json::jsonb->>'visibility'='shared')`,
      [hid, userId, fingerprint + ":%"]);
    return new Set(records.map(record => record.source_key));
  }
  async function get(hid: string, userId: string, assetId: string) {
    const [row] = await db.query<Row>(`SELECT * FROM physical_assets WHERE id=$1 AND household_id=$2`,[assetId,hid]);
    if (!row || !visible(row,userId)) throw new ApiError(404,"Asset not found.");
    return row;
  }
  async function views(rows: Row[], userId: string) {
    if(!rows.length) return [];
    const ids=rows.map(r=>r.id);
    const history = await db.query<{id:string;asset_id:string;payload_json:string;created_at:string}>(`SELECT id,asset_id,payload_json,created_at FROM physical_asset_estimates WHERE asset_id=ANY($1::text[]) ORDER BY created_at DESC,id DESC`,[ids]);
    const files = await db.query<{id:string;asset_id:string;filename:string}>(`SELECT d.id,f.asset_id,d.filename FROM physical_asset_documents d JOIN physical_asset_files f ON f.document_id=d.id WHERE f.asset_id=ANY($1::text[]) AND d.owner_user_id=$2 ORDER BY d.created_at`,[ids,userId]);
    return rows.map(row=>{
      const estimates=history.filter(e=>e.asset_id===row.id).map(e=>({id:e.id,...JSON.parse(e.payload_json) as Estimate,recordedAt:e.created_at}));
      estimates.sort((a,b)=>b.asOf.localeCompare(a.asOf)||b.recordedAt.localeCompare(a.recordedAt)||b.id.localeCompare(a.id));
      const documents=files.filter(f=>f.asset_id===row.id).map(({id,filename})=>({id,filename}));
      return {id:row.id,...JSON.parse(row.payload_json) as Asset,version:row.version,ownerUserId:row.owner_user_id,canChangeVisibility:row.owner_user_id===userId,
        createdAt:row.created_at,updatedAt:row.updated_at,estimate:estimates[0]??null,estimates,documents};
    });
  }
  async function view(row:Row,userId:string) {return (await views([row],userId))[0];}
  async function recordEstimate(assetId:string, me:Actor, estimate:Estimate) {
    const estimateId=id();
    await db.query(`INSERT INTO physical_asset_estimates (id,asset_id,user_id,payload_json,created_at) VALUES ($1,$2,$3,$4,$5)`,[estimateId,assetId,me.id,JSON.stringify(estimate),nowIso()]);
  }
  async function create(hid:string, me:Actor, payload:Asset, estimate?:Estimate, sourceKey?:string, documentId?:string) {
    if(estimate&&!Number.isSafeInteger(estimate.amountMinor*payload.quantity)) throw new ApiError(400,"The combined value is too large. Reduce the quantity or unit value.");
    const assetId=id(), now=nowIso();
    await db.query(`INSERT INTO physical_assets (id,household_id,owner_user_id,payload_json,version,source_key,document_id,created_at,updated_at) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$7)`,[assetId,hid,me.id,JSON.stringify(payload),sourceKey??null,documentId??null,now]);
    if(documentId) await db.query(`INSERT INTO physical_asset_files (asset_id,document_id) VALUES ($1,$2)`,[assetId,documentId]);
    if(estimate) await recordEstimate(assetId,me,estimate);
    await audit(db,hid,me.id,"asset.create","Added physical asset","physical_asset",assetId,{visibility:payload.visibility,ownerUserId:me.id});
    return assetId;
  }
  async function storeFile(hid:string,me:Actor,file:File,bytes:Buffer) {
    const fingerprint=sha256(bytes.toString("base64"));
    const [existing]=await db.query<Document>(`SELECT * FROM physical_asset_documents WHERE household_id=$1 AND owner_user_id=$2 AND fingerprint=$3`,[hid,me.id,fingerprint]);
    if(existing) return existing;
    const [usage]=await db.query(`SELECT COALESCE(SUM(size_bytes),0) AS total FROM physical_asset_documents WHERE household_id=$1`,[hid]);
    if(Number(usage.total)+bytes.length>100_000_000) throw new ApiError(400,"This household has reached 100 MB of asset files. Remove unused attachments before uploading more.");
    const documentId=id(),filename=file.name.replace(/[\x00-\x1f\x7f/\\]/g,"_").slice(0,180)||"asset-file";
    await db.query(`INSERT INTO physical_asset_documents (id,household_id,owner_user_id,filename,data_base64,fingerprint,size_bytes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[documentId,hid,me.id,filename,bytes.toString("base64"),fingerprint,bytes.length,nowIso()]);
    return {id:documentId,household_id:hid,owner_user_id:me.id,filename,data_base64:bytes.toString("base64"),fingerprint,created_at:nowIso()};
  }
  function fileFrom(form: Record<string,unknown>): File {
    const file=form.file;
    if(!file || typeof file!=="object" || !("arrayBuffer" in file) || !("name" in file)) throw new ApiError(400,"Choose a file.");
    const f=file as File;
    if(!f.size||f.size>8_000_000) throw new ApiError(400,"Choose a file no larger than 8 MB.");
    if(!/\.(png|jpe?g|webp|pdf|csv|xls|xlsx|tsv|txt|json)$/i.test(f.name)) throw new ApiError(400,"Use PNG, JPG, WebP, PDF, CSV, XLS, XLSX, TSV, TXT or JSON.");
    return f;
  }
  app.get(base,async c=>{
    const {me,hid}=await member(c);
    const all=await db.query<Row>(`SELECT * FROM physical_assets WHERE household_id=$1 ORDER BY created_at DESC,id`,[hid]);
    const assets=await views(all.filter(row=>visible(row,me.id)),me.id);
    return c.json({assets,categories:ASSET_CATEGORIES});
  });
  app.get(`${base}/export`,async c=>{
    const {me,hid,membership}=await member(c);
    if(me.privacyMode) throw new ApiError(403,"Show amounts before exporting your inventory.");
    const all=await db.query<Row>(`SELECT * FROM physical_assets WHERE household_id=$1 ORDER BY created_at,id`,[hid]), assets=[];
    for(const a of await views(all.filter(row=>visible(row,me.id)),me.id)) {
      const factor=minorFactor(membership.currency);
      assets.push({name:a.name,category:a.category,location:a.location,brand:a.brand,model:a.model,serialNumber:a.serialNumber,condition:a.condition,quantity:a.quantity,tags:a.tags.join(", "),notes:a.notes,purchaseDate:a.purchaseDate,purchasePrice:a.purchaseMinor==null?"":a.purchaseMinor/factor,estimatedValue:a.estimate?.amountMinor==null?"":a.estimate.amountMinor/factor,asOf:a.estimate?.asOf||"",sourceName:a.estimate?.sourceName||"",sourceUrl:a.estimate?.sourceUrl||"",sourceType:a.estimate?.sourceType||"",currency:membership.currency,archived:a.archived,visibility:a.visibility,estimates:a.estimates});
    }
    c.header("Cache-Control","no-store");
    if(c.req.query("format")==="csv") {
      const columns=["name","category","location","brand","model","serialNumber","condition","quantity","tags","notes","purchaseDate","purchasePrice","estimatedValue","asOf","sourceName","sourceUrl","sourceType","currency","archived","visibility"];
      c.header("Content-Type","text/csv; charset=utf-8");c.header("Content-Disposition",'attachment; filename="physical-assets.csv"');
      return c.body(toCsv(assets.map(a=>Object.fromEntries(columns.map(k=>[k,String((a as Record<string,unknown>)[k]??"")])))));
    }
    c.header("Content-Disposition",'attachment; filename="physical-assets.json"');
    return c.json({version:1,currency:membership.currency,exportedAt:nowIso(),note:"Estimates and original file references are included. File contents are downloaded separately. Reimport reviews the latest estimate; history remains in this export.",assets});
  });
  app.post(base,async c=>{
    const {me,hid}=await member(c,true),raw=await c.req.json();
    const payload=assetSchema.parse(raw),estimate=raw.estimate?estimateSchema.parse(raw.estimate):undefined;
    const assetId=await db.tx(async()=>{await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));return create(hid,me,payload,estimate);});
    return c.json({asset:await view(await get(hid,me.id,assetId),me.id)},201);
  });
  app.post(`${base}/imports`,async c=>{
    const {me,hid,membership}=await member(c,true);
    const recent=await db.query(`SELECT id FROM physical_asset_imports WHERE user_id=$1 AND created_at>$2`,[me.id,new Date(Date.now()-3600000).toISOString()]);
    if(recent.length>=20) throw new ApiError(429,"The hourly asset-upload limit was reached. Try again later.");
    const file=fileFrom(await c.req.parseBody()),bytes=Buffer.from(await file.arrayBuffer());
    let preview: Awaited<ReturnType<typeof readAssetFile>> & {documentId?:string};
    try {preview=await readAssetFile(bytes,file.name,membership.currency);} catch(error) {throw new ApiError(400,error instanceof Error?error.message:"The asset file could not be read.");}
    const draftId=id();
    await db.tx(async()=>{
      await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));
      await db.query(`DELETE FROM physical_asset_imports WHERE household_id=$1 AND expires_at<$2`,[hid,nowIso()]);
      await db.query(`DELETE FROM physical_asset_documents d WHERE household_id=$1 AND NOT EXISTS (SELECT 1 FROM physical_asset_files f WHERE f.document_id=d.id) AND NOT EXISTS (SELECT 1 FROM physical_asset_imports i WHERE i.document_id=d.id)`,[hid]);
      const document=await storeFile(hid,me,file,bytes);
      const keys=await visibleImportKeys(hid,me.id,document.fingerprint);
      preview={...preview,rows:preview.rows.map(r=>({...r,duplicate:keys.has(`${document.fingerprint}:${r.key}`)})),documentId:document.id};
      await db.query(`INSERT INTO physical_asset_imports (id,household_id,user_id,document_id,preview_json,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[draftId,hid,me.id,document.id,JSON.stringify(preview),nowIso(),new Date(Date.now()+86400000).toISOString()]);
    });
    return c.json({id:draftId,...preview},201);
  });
  app.post(`${base}/imports/:draftId/confirm`,async c=>{
    const {me,hid}=await member(c,true);
    const input=z.object({reviewed:z.literal(true),rows:z.array(assetSchema.extend({key:z.string().max(100),estimate:estimateSchema.optional()})).min(1).max(500)}).parse(await c.req.json());
    const hash=sha256(JSON.stringify(input));
    return c.json(await db.tx(async()=>{
      await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));
      const [draft]=await db.query<Draft>(`SELECT * FROM physical_asset_imports WHERE id=$1 AND household_id=$2 AND user_id=$3`,[c.req.param("draftId"),hid,me.id]);
      if(!draft||draft.expires_at<nowIso()) throw new ApiError(404,"This import preview expired. Upload the file again.");
      if(draft.result_json) {if(draft.confirm_hash!==hash) throw new ApiError(409,"This preview was already imported with different selections.");return {...JSON.parse(draft.result_json),repeated:true};}
      const preview=JSON.parse(draft.preview_json),allowed=new Set(preview.rows.map((r:{key:string})=>r.key));
      if(new Set(input.rows.map(r=>r.key)).size!==input.rows.length||input.rows.some(r=>!allowed.has(r.key))) throw new ApiError(400,"Choose each row from this preview once.");
      const [document]=await db.query<Document>(`SELECT * FROM physical_asset_documents WHERE id=$1`,[draft.document_id]);
      const created:string[]=[],skipped:string[]=[];
      const keys=await visibleImportKeys(hid,me.id,document.fingerprint);
      for(const row of input.rows) {
        const key=`${document.fingerprint}:${row.key}`;
        if(keys.has(key)) {skipped.push(row.name);continue;}
        created.push(await create(hid,me,assetSchema.parse(row),row.estimate,key,document.id));
      }
      const result={created,skipped,repeated:false};
      await db.query(`UPDATE physical_asset_imports SET result_json=$1,confirm_hash=$2 WHERE id=$3`,[JSON.stringify(result),hash,draft.id]);
      return result;
    }));
  });
  app.get(`${base}/documents/:documentId`,async c=>{
    const {me,hid}=await member(c);
    const [document]=await db.query<Document>(`SELECT * FROM physical_asset_documents WHERE id=$1 AND household_id=$2 AND owner_user_id=$3`,[c.req.param("documentId"),hid,me.id]);
    if(!document) throw new ApiError(404,"File not found. Original files are private to their uploader.");
    if(c.req.query("preview")==="image") {
      if(!/\.(png|jpe?g|webp)$/i.test(document.filename)) throw new ApiError(400,"This file has no image preview.");
      try {
        const image=await sharp(Buffer.from(document.data_base64,"base64"),{limitInputPixels:12_000_000}).rotate().resize(1000,800,{fit:"inside",withoutEnlargement:true}).webp().toBuffer();
        return c.body(new Uint8Array(image),200,{"Content-Type":"image/webp","Cache-Control":"no-store"});
      } catch {throw new ApiError(400,"This photo could not be previewed.");}
    }
    c.header("Cache-Control","no-store");c.header("Content-Type","application/octet-stream");
    c.header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
    return c.body(new Uint8Array(Buffer.from(document.data_base64,"base64")));
  });
  app.put(`${base}/:assetId`,async c=>{
    const {me,hid}=await member(c,true),raw=await c.req.json(),payload=assetSchema.parse(raw),version=z.number().int().positive().parse(raw.version);
    await db.tx(async()=>{
      await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));
      const row=await get(hid,me.id,c.req.param("assetId"));
      if(row.version!==version) throw new ApiError(409,"This asset changed. Close the editor and reopen it before saving.");
      if(row.owner_user_id!==me.id && payload.visibility!==JSON.parse(row.payload_json).visibility) throw new ApiError(403,"Only the asset owner can change its visibility.");
      const current=await view(row,me.id);
      if(current.estimates.some(e=>!Number.isSafeInteger(e.amountMinor*payload.quantity))) throw new ApiError(400,"The combined value is too large. Reduce the quantity.");
      await db.query(`UPDATE physical_assets SET payload_json=$1,version=version+1,updated_at=$2 WHERE id=$3`,[JSON.stringify(payload),nowIso(),row.id]);
      await audit(db,hid,me.id,"asset.update","Updated physical asset","physical_asset",row.id,{visibility:payload.visibility,ownerUserId:row.owner_user_id});
    });
    return c.json({asset:await view(await get(hid,me.id,c.req.param("assetId")),me.id)});
  });
  app.post(`${base}/:assetId/estimates`,async c=>{
    const {me,hid}=await member(c,true),raw=await c.req.json(),estimate=estimateSchema.parse(raw),version=z.number().int().positive().parse(raw.version);
    await db.tx(async()=>{
      await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));
      const row=await get(hid,me.id,c.req.param("assetId"));
      if(row.version!==version) throw new ApiError(409,"This asset changed. Reopen it before adding an estimate.");
      if(!Number.isSafeInteger(estimate.amountMinor*JSON.parse(row.payload_json).quantity)) throw new ApiError(400,"The combined value is too large. Reduce the unit value.");
      await recordEstimate(row.id,me,estimate);
      await db.query(`UPDATE physical_assets SET version=version+1,updated_at=$1 WHERE id=$2`,[nowIso(),row.id]);
      await audit(db,hid,me.id,"asset.estimate","Recorded physical asset estimate","physical_asset",row.id,{visibility:JSON.parse(row.payload_json).visibility,ownerUserId:row.owner_user_id});
    });
    return c.json({asset:await view(await get(hid,me.id,c.req.param("assetId")),me.id)},201);
  });
  app.post(`${base}/:assetId/files`,async c=>{
    const {me,hid}=await member(c,true),file=fileFrom(await c.req.parseBody()),bytes=Buffer.from(await file.arrayBuffer());
    await db.tx(async()=>{
      await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));
      const row=await get(hid,me.id,c.req.param("assetId")),document=await storeFile(hid,me,file,bytes);
      await db.query(`INSERT INTO physical_asset_files (asset_id,document_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[row.id,document.id]);
    });
    return c.json({asset:await view(await get(hid,me.id,c.req.param("assetId")),me.id)},201);
  });
  app.delete(`${base}/:assetId/files/:documentId`,async c=>{
    const {me,hid}=await member(c,true);
    await db.tx(async()=>{
      await lockHousehold(db,hid);assertWrite(await requireMember(db,me.id,hid));await get(hid,me.id,c.req.param("assetId"));
      const [doc]=await db.query<Document>(`SELECT * FROM physical_asset_documents WHERE id=$1 AND household_id=$2 AND owner_user_id=$3`,[c.req.param("documentId"),hid,me.id]);
      if(!doc) throw new ApiError(404,"File not found.");
      await db.query(`DELETE FROM physical_asset_files WHERE asset_id=$1 AND document_id=$2`,[c.req.param("assetId"),doc.id]);
      await db.query(`DELETE FROM physical_asset_imports WHERE document_id=$1 AND result_json IS NOT NULL`,[doc.id]);
      await db.query(`DELETE FROM physical_asset_documents d WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM physical_asset_files f WHERE f.document_id=d.id) AND NOT EXISTS (SELECT 1 FROM physical_asset_imports i WHERE i.document_id=d.id)`,[doc.id]);
    });
    return c.json({ok:true});
  });
}
