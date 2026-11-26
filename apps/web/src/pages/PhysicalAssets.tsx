import { sessionToken, saveTextFile } from "../device-suite.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, downloadFile } from "../api.js";
import { minorToInput, parseAmount, todayISO } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import { Modal as Dialog, ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";
import { ASSET_CATEGORIES, SOURCE_TYPES, inventorySummary, type PhysicalAsset, type AssetEstimate } from "../asset-tools.js";

import { AssetResearch } from "./AssetResearch.js";
import { priceIndexSource } from "../asset-reference.js";
import { searchDescription } from "../asset-valuation.js";
const ACCEPT=".png,.jpg,.jpeg,.webp,.pdf,.csv,.xls,.xlsx,.tsv,.txt,.json";
const today=todayISO;
function estimateBasis(estimate: AssetEstimate) {
  return estimate.sourceType === "manual" && estimate.sourceName === priceIndexSource ? "State price index" : SOURCE_TYPES[estimate.sourceType];
}
const emptyAsset=():PhysicalAsset=>({id:"",name:"",category:"Other",location:"",brand:"",model:"",serialNumber:"",condition:"unknown",quantity:1,tags:[],notes:"",purchaseDate:"",purchaseMinor:null,visibility:"private",archived:false,version:1,canChangeVisibility:true,estimate:null,estimates:[],documents:[]});
function useAction() {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");const lock=useRef(false);
  async function run(fn:()=>Promise<void>,event?:FormEvent) {event?.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError("");try{await fn();}catch(e){setError(e instanceof Error?e.message:"This could not be saved.");}finally{lock.current=false;setBusy(false);}}
  return {busy,error,run};
}
function AssetFields({asset,categories}: {asset:PhysicalAsset;categories:string[]}) {
  const {currency}=useSession();
  return <div className="asset-fields">
    <Field label="Asset name"><input name="name" required maxLength={160} defaultValue={asset.name} placeholder="e.g. Living room television" /></Field>
    <Field label="Category"><input name="category" required list="asset-categories" maxLength={80} defaultValue={asset.category}/><datalist id="asset-categories">{categories.map(c=><option key={c} value={c}/>)}</datalist></Field>
    <Field label="Location / room"><input name="location" maxLength={120} defaultValue={asset.location} placeholder="Garage, office, storage…" /></Field>
    <Field label="Quantity"><input name="quantity" type="number" required min={1} max={10000} defaultValue={asset.quantity}/></Field>
    <Field label="Brand / make"><input name="brand" maxLength={100} defaultValue={asset.brand}/></Field>
    <Field label="Model"><input name="model" maxLength={100} defaultValue={asset.model}/></Field>
    <Field label="Condition"><select name="condition" defaultValue={asset.condition}>{["unknown","new","excellent","good","fair","poor"].map(s=><option key={s}>{s}</option>)}</select></Field>
    <Field label="Who can see this asset?"><select name="visibility" defaultValue={asset.visibility} disabled={!asset.canChangeVisibility}><option value="private">Only me</option><option value="shared">Household members</option></select></Field>
    <details className="asset-extra"><summary>Purchase details, serial number and notes</summary><div className="asset-fields">
    <Field label="Serial number / VIN"><input name="serialNumber" maxLength={160} defaultValue={asset.serialNumber}/></Field>
    <Field label={`Purchase price per item (${currency})`}><input name="purchase" inputMode="decimal" defaultValue={asset.purchaseMinor===null?"":minorToInput(asset.purchaseMinor,currency)}/></Field>
    <Field label="Purchase date"><input name="purchaseDate" type="date" defaultValue={asset.purchaseDate}/></Field>
    <Field label="Tags (comma separated)"><input name="tags" defaultValue={asset.tags.join(", ")} placeholder="Insured, warranty, heirloom…"/></Field>
    <Field label="Notes"><textarea name="notes" maxLength={4000} defaultValue={asset.notes}/></Field>
    </div></details>
  </div>;
}
function assetForm(data:FormData,asset:PhysicalAsset,currency:string) {
  return {name:String(data.get("name")||""),category:String(data.get("category")||"Other"),location:String(data.get("location")||""),brand:String(data.get("brand")||""),model:String(data.get("model")||""),serialNumber:String(data.get("serialNumber")||""),condition:String(data.get("condition")||"unknown"),quantity:Number(data.get("quantity")||1),tags:String(data.get("tags")||"").split(",").map(s=>s.trim()).filter(Boolean),notes:String(data.get("notes")||""),purchaseDate:String(data.get("purchaseDate")||""),purchaseMinor:data.get("purchase")?parseAmount(String(data.get("purchase")),currency):null,visibility:data.get("visibility")||asset.visibility,archived:asset.archived,version:asset.version};
}
function EstimateFields({estimate}: {estimate?:AssetEstimate|null}) {
  const {currency}=useSession();
  return <div className="asset-fields">
    <Field label={`Estimated value per item (${currency})`}><input name="value" inputMode="decimal" required defaultValue={estimate?minorToInput(estimate.amountMinor,currency):""}/></Field>
    <Field label="Value as of"><input name="asOf" type="date" required defaultValue={estimate?.asOf||today()}/></Field>
    <Field label="Source name"><input name="sourceName" maxLength={200} required defaultValue={estimate?.sourceName||"Personal estimate"} placeholder="e.g. eBay sold listing or Smith Appraisals"/></Field>
    <Field label="Source link (optional)"><input name="sourceUrl" type="url" maxLength={2000} defaultValue={estimate?.sourceUrl||""} placeholder="https://…"/></Field>
    <Field label="Value basis"><select name="sourceType" defaultValue={estimate?.sourceType||"manual"}>{Object.entries(SOURCE_TYPES).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></Field>
    <Field label="Estimate notes"><textarea name="estimateNotes" maxLength={4000} defaultValue={estimate?.notes||""} placeholder="Comparable condition, mileage, size, sale date…"/></Field>
  </div>;
}
function estimateForm(data:FormData,currency:string):AssetEstimate {return {amountMinor:parseAmount(String(data.get("value")),currency),asOf:String(data.get("asOf")),sourceName:String(data.get("sourceName")),sourceUrl:String(data.get("sourceUrl")||""),sourceType:String(data.get("sourceType")) as AssetEstimate["sourceType"],notes:String(data.get("estimateNotes")||"")};}

export function PhysicalAssets() {
  const session=useSession();
  return <Inventory key={session.householdId+session.user?.id}/>;
}
function Inventory() {
  const session=useSession(),access=useAccess(),action=useAction();
  const base=scoped(session.householdId,"/physical-assets");
  const state=useLoad(()=>api<{assets:PhysicalAsset[];categories:string[]}>(base),[session.householdId,session.tick]);
  const [query,setQuery]=useState(""),[category,setCategory]=useState(""),[location,setLocation]=useState(""),[status,setStatus]=useState("active"),[sort,setSort]=useState("name"),[group,setGroup]=useState("category"),[page,setPage]=useState(0);
  const [editing,setEditing]=useState<PhysicalAsset|null>(null),[selected,setSelected]=useState<PhysicalAsset|null>(null),[importing,setImporting]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>setPage(0),[query,category,location,status,sort,group]);
  if(!state.data) return state.loading?<Loading label="Loading your physical assets"/>:<ErrorNote message={state.error||"Inventory unavailable"} onRetry={session.bump}/>;
  const assets=state.data.assets;
  const categories=[...new Set([...ASSET_CATEGORIES,...assets.map(a=>a.category)])].sort();
  const locations=[...new Set(assets.map(a=>a.location).filter(Boolean))].sort();
  const filtered=assets.filter(a=>(status==="all"||(status==="archived"?a.archived:!a.archived))&&(!category||a.category===category)&&(!location||a.location===location)&&(!query||[a.name,a.category,a.location,a.brand,a.model,a.serialNumber,a.notes,...a.tags].join(" ").toLowerCase().includes(query.toLowerCase())));
  filtered.sort((a,b)=>(group!=="none"?(group==="category"?a.category.localeCompare(b.category):a.location.localeCompare(b.location)):0)||(sort==="value"?(b.estimate?.amountMinor??-1)*b.quantity-(a.estimate?.amountMinor??-1)*a.quantity:a.name.localeCompare(b.name)));
  const summary=inventorySummary(filtered),pageCount=Math.max(1,Math.ceil(filtered.length/48)),currentPage=Math.min(page,pageCount-1),visible=filtered.slice(currentPage*48,currentPage*48+48);
  const groups=new Map<string,PhysicalAsset[]>();for(const a of visible){const key=group==="category"?a.category:group==="location"?a.location||"No location":"All assets";groups.set(key,[...(groups.get(key)||[]),a]);}
  return <Page title="Physical assets" lede="A home for the things you own. Organize belongings, keep records, and track researched values." actions={<>{access.canWrite&&<><button className="btn-secondary" onClick={()=>setImporting(true)}>Import files</button><button className="btn" onClick={()=>setEditing(emptyAsset())}>Add asset</button></>}</>}>
    {message&&<Notice>{message}</Notice>}{action.error&&<Notice kind="bad">{action.error}</Notice>}{state.error&&<Notice kind="bad">{state.error}</Notice>}
    <div className="grid three"><article className="card"><p className="kicker">Inventory shown</p><p className="figure">{summary.items}</p><p className="muted">items across {summary.records} records</p></article><article className="card"><p className="kicker">Estimated value shown</p><p className="figure">{summary.value===null?"Total exceeds display limit":<Money minor={summary.value}/>}</p><p className="muted">{summary.valued} of {summary.records} records valued</p></article><article className="card"><p className="kicker">Your records</p><p>Categories, locations, photos and source history.</p><p className="muted">Inventory estimates are separate from account balances and net worth, avoiding double counting.</p></article></div>
    <div className="card asset-toolbar"><Field label="Search assets"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name, model, serial, tag…"/></Field><Field label="Category"><select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select></Field><Field label="Location"><select value={location} onChange={e=>setLocation(e.target.value)}><option value="">All locations</option>{locations.map(l=><option key={l}>{l}</option>)}</select></Field><Field label="Show"><select value={status} onChange={e=>setStatus(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All assets</option></select></Field><Field label="Group by"><select value={group} onChange={e=>setGroup(e.target.value)}><option value="category">Category</option><option value="location">Location</option><option value="none">No groups</option></select></Field><Field label="Sort by"><select value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="value">Highest value</option></select></Field></div>
    <div className="row asset-export"><span className="muted">{filtered.length} matching records</span><button className="btn-quiet" disabled={!!session.user?.privacyMode||action.busy} onClick={()=>action.run(()=>downloadFile(`${base}/export?format=csv`,"physical-assets.csv"))}>Export all to CSV</button><button className="btn-quiet" disabled={!!session.user?.privacyMode||action.busy} onClick={()=>action.run(()=>downloadFile(`${base}/export`,"physical-assets.json"))}>Export all to JSON</button></div>
    {!filtered.length&&<div className="card"><h2>{assets.length?"No matching assets":"Start your inventory"}</h2><p>{assets.length?"Try another category, location, or search.":"Add a vehicle, furniture, electronics, tools, jewelry, property, or another belonging. You can also import a list or upload a photo."}</p></div>}
    {[...groups].map(([label,items])=><section className="asset-group" key={label}><h2>{label}</h2><div className="asset-grid">{items.map(a=><article className="card asset-card" key={a.id}><div className="row"><span className="kicker">{a.category}</span><span className="muted">{a.visibility==="private"?"Only me":"Shared"}{a.archived?" · Archived":""}</span></div><h3><button className="asset-title" onClick={()=>setSelected(a)}>{a.name}</button></h3><p className="muted">{[a.brand,a.model].filter(Boolean).join(" ")||"Add make and model for better value searches"}</p><p>{a.location||"No location"} · Qty {a.quantity} · {a.condition}</p><p className="asset-value">{a.estimate?<Money minor={a.estimate.amountMinor*a.quantity}/>:"No estimate yet"}</p>{a.estimate&&<p className="muted">{SOURCE_TYPES[a.estimate.sourceType]} · {a.estimate.asOf}</p>}<div className="asset-tags">{a.tags.map(tag=><button className="btn-quiet" key={tag} onClick={()=>setQuery(tag)}>#{tag}</button>)}</div><button className="btn-secondary" onClick={()=>setSelected(a)}>View asset & value</button></article>)}</div></section>)}
    {pageCount>1&&<div className="row"><button className="btn-secondary" disabled={currentPage===0} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button className="btn-secondary" disabled={currentPage+1===pageCount} onClick={()=>setPage(p=>p+1)}>Next</button></div>}
    {editing&&<AssetEditor key={editing.id} asset={editing} categories={categories} close={()=>setEditing(null)} saved={()=>{setEditing(null);setMessage("Asset saved.");session.bump();}}/>}
    {selected&&<AssetDetails key={selected.id} initial={selected} close={()=>setSelected(null)} edit={a=>{setSelected(null);setEditing(a);}}/>}
    {importing&&<AssetImport categories={categories} close={()=>setImporting(false)} saved={message=>{setImporting(false);setMessage(message);session.bump();}}/>}
  </Page>;
}
function AssetEditor({asset,categories,close,saved}:{asset:PhysicalAsset;categories:string[];close:()=>void;saved:()=>void}) {
  const session=useSession(),action=useAction();
  const [mode,setMode]=useState("none"),[researched,setResearched]=useState<AssetEstimate|null>(null);
  const [identity,setIdentity]=useState({name:asset.name,brand:asset.brand,model:asset.model,category:asset.category,condition:asset.condition});
  const [purchase,setPurchase]=useState({date:asset.purchaseDate,amount:asset.purchaseMinor});
  const identityKey=JSON.stringify([identity,purchase]);
  return <Dialog title={asset.id?"Edit asset":"Add physical asset"} onClose={close}><form onChange={e=>{
    const field: EventTarget = e.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
    const name=field.name;
    if (name==="purchaseDate" || name==="purchase") {
      const value=field.value;
      if (name==="purchaseDate") setPurchase(current=>({...current,date:value}));
      else {
        let amount:number|null=null;
        try { if(value) amount=parseAmount(value,session.currency); } catch { /* edited amount is incomplete */ }
        setPurchase(current=>({...current,amount}));
      }
      setResearched(null);
    }
    if (["name","brand","model","category","condition"].includes(name)) {
      const value=field.value;
      setIdentity(current=>({...current,[name]:value}));setResearched(null);
    }
  }} onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{
    const data=new FormData(form),body=assetForm(data,asset,session.currency);
    const estimate=mode==="manual"?estimateForm(data,session.currency):mode==="research"?researched:null;
    await api(scoped(session.householdId,`/physical-assets${asset.id?`/${asset.id}`:""}`),{method:asset.id?"PUT":"POST",body:JSON.stringify({...body,...(!asset.id&&estimate?{estimate}:{})})});saved();
  },e);}}>
    <AssetFields asset={asset} categories={categories}/>
    {!asset.id&&<fieldset className="asset-value-choice"><legend>Current value</legend>
      <div className="chips">{[["none","Add later"],["manual","Enter value"],["research","Look up value"]].map(([v,label])=><button className="chip" type="button" key={v} aria-pressed={v===mode} onClick={()=>{setMode(v);setResearched(null);}}>{label}</button>)}</div>
      {mode==="manual"&&<EstimateFields/>}
      {mode==="research"&&<AssetResearch key={identityKey} purchased={purchase.date} purchaseMinor={purchase.amount} description={searchDescription(identity)} category={identity.category} condition={identity.condition} onEstimate={setResearched}/>}
    </fieldset>}
    {action.error&&<Notice kind="bad">{action.error}</Notice>}<button className="btn" disabled={action.busy}>{action.busy?"Saving…":researched?"Save asset and estimate":"Save asset"}</button>
  </form></Dialog>;
}
function AssetDetails({initial,close,edit}:{initial:PhysicalAsset;close:()=>void;edit:(a:PhysicalAsset)=>void}) {
  const session=useSession(),access=useAccess(),action=useAction();const [asset,setAsset]=useState(initial),[researched,setResearched]=useState<AssetEstimate|null>(null),[valuing,setValuing]=useState(false);
  const base=scoped(session.householdId,`/physical-assets/${asset.id}`);
  const update=(a:PhysicalAsset)=>{setAsset(a);session.bump();};
  return <Dialog title={asset.name} onClose={close}><p>{asset.category} · {asset.location||"No location"} · {asset.visibility==="private"?"Only you":"Shared with household"}</p><p>{[asset.brand,asset.model].filter(Boolean).join(" ")} · {asset.condition} · Quantity {asset.quantity}</p>{asset.serialNumber&&<p>Serial / VIN: {asset.serialNumber}</p>}{asset.purchaseDate&&<p>Purchased {asset.purchaseDate}</p>}{asset.purchaseMinor!==null&&<p>Purchase price per item: <Money minor={asset.purchaseMinor}/></p>}{asset.notes&&<p className="asset-notes">{asset.notes}</p>}
    <div className="card"><h3>Latest dated estimate</h3>{asset.estimate?<><p className="figure"><Money minor={asset.estimate.amountMinor*asset.quantity}/></p><p><Money minor={asset.estimate.amountMinor}/> per item · {asset.estimate.asOf} · {estimateBasis(asset.estimate)}</p><Source estimate={asset.estimate}/></>:<p>No value has been recorded.</p>}</div>
    <h3>Research the current value</h3>
    <AssetResearch purchased={asset.purchaseDate} purchaseMinor={asset.purchaseMinor} description={searchDescription(asset)} category={asset.category} condition={asset.condition} onEstimate={setResearched}/>
    {access.canWrite&&researched&&<button className="btn" disabled={action.busy} onClick={()=>void action.run(async()=>{
      const {asset:updated}=await api<{asset:PhysicalAsset}>(`${base}/estimates`,{method:"POST",body:JSON.stringify({...researched,version:asset.version})});update(updated);setResearched(null);
    })}>Save researched estimate</button>}
    {access.canWrite&&<button className="btn" onClick={()=>setValuing(v=>!v)}>{valuing?"Cancel estimate":"Enter value manually"}</button>}
    {valuing&&<form onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{const result=await api<{asset:PhysicalAsset}>(`${base}/estimates`,{method:"POST",body:JSON.stringify({...estimateForm(new FormData(form),session.currency),version:asset.version})});update(result.asset);setValuing(false);},e);}}><EstimateFields/><button className="btn" disabled={action.busy}>Save estimate</button></form>}
    {!!asset.estimates.length&&<details><summary>Value history ({asset.estimates.length})</summary>{asset.estimates.map((estimate,i)=><article className="asset-history" key={estimate.id||i}><p><Money minor={estimate.amountMinor}/> per item · {estimate.asOf} · {estimateBasis(estimate)}</p><Source estimate={estimate}/>{estimate.notes&&!session.user?.privacyMode&&<p>{estimate.notes}</p>}</article>)}</details>}
    <h3>Photos & documents</h3><p className="muted">Original files are visible only to the person who uploaded them, even when the asset is shared.</p>{asset.documents.map(doc=><div key={doc.id}>{/\.(png|jpe?g|webp)$/i.test(doc.filename)&&<AssetPhoto document={doc}/>}<div className="row"><button className="btn-quiet" disabled={action.busy} onClick={()=>action.run(()=>downloadFile(scoped(session.householdId,`/physical-assets/documents/${doc.id}`),doc.filename))}>{doc.filename}</button>{access.canWrite&&<button className="btn-quiet" disabled={action.busy} onClick={()=>action.run(async()=>{await api(`${base}/files/${doc.id}`,{method:"DELETE"});update({...asset,documents:asset.documents.filter(d=>d.id!==doc.id)});})}>Remove attachment</button>}</div></div>)}
    {access.canWrite&&<form onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{const data=new FormData(form);const result=await api<{asset:PhysicalAsset}>(`${base}/files`,{method:"POST",body:data});update(result.asset);form.reset();},e);}}><Field label="Attach a photo or document (up to 8 MB)"><input type="file" name="file" accept={ACCEPT} required/></Field><button className="btn-secondary" disabled={action.busy}>Attach file</button></form>}
    {action.error&&<Notice kind="bad">{action.error}</Notice>}{access.canWrite&&<div className="row"><button className="btn-secondary" onClick={()=>edit(asset)}>Edit details</button><button className="btn-quiet" disabled={action.busy} onClick={()=>action.run(async()=>{const result=await api<{asset:PhysicalAsset}>(base,{method:"PUT",body:JSON.stringify({...asset,archived:!asset.archived})});update(result.asset);})}>{asset.archived?"Restore to inventory":"Archive asset"}</button></div>}
  </Dialog>;
}
function Source({estimate}:{estimate:AssetEstimate}) {return <p>{estimate.sourceUrl?<a href={estimate.sourceUrl} target="_blank" rel="noopener noreferrer">{estimate.sourceName}</a>:estimate.sourceName}</p>;}
function AssetPhoto({document}:{document:{id:string;filename:string}}) {
  const session=useSession(),[url,setUrl]=useState(""),[error,setError]=useState("");
  useEffect(()=>{
    const controller=new AbortController();let objectUrl="";
    fetch(scoped(session.householdId,`/physical-assets/documents/${document.id}?preview=image`),{headers:{authorization:`Bearer ${sessionToken()||""}`},signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error("Photo preview unavailable. Download the original file below.");return r.blob();})
      .then(blob=>{if(controller.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[session.householdId,document.id]);
  return url?<img className="asset-photo" src={url} alt={document.filename}/>:<p className="muted">{error||"Loading photo…"}</p>;
}

interface ImportRow {key:string;name:string;category:string;location:string;brand:string;model:string;serialNumber:string;condition:string;quantity:number;tags:string[];notes:string;purchaseDate:string;purchaseMinor:number|null;estimateMinor:number|null;sourceName:string;sourceUrl:string;asOf:string;sourceType:AssetEstimate["sourceType"];issues:string[];sourceCells:{column:string;value:string}[];duplicate?:boolean;selected:boolean;reviewed:boolean}
interface ImportPreview {id:string;filename:string;text:string;warnings:string[];rows:ImportRow[]}
function AssetImport({categories,close,saved}:{categories:string[];close:()=>void;saved:(s:string)=>void}) {
  const session=useSession(),action=useAction();const [preview,setPreview]=useState<ImportPreview|null>(null),[rows,setRows]=useState<ImportRow[]>([]),[editing,setEditing]=useState<ImportRow|null>(null),[reviewed,setReviewed]=useState(false),[visibility,setVisibility]=useState("private");
  const base=scoped(session.householdId,"/physical-assets");
  const selected=rows.filter(r=>r.selected),unreviewed=selected.filter(r=>!r.reviewed).length;
  const setRow=(key:string,patch:Partial<ImportRow>)=>setRows(all=>all.map(r=>r.key===key?{...r,...patch}:r));
  return <Dialog title="Import physical assets" onClose={close}>
    {editing?<form key={editing.key} onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{const data=new FormData(form),input=assetForm(data,{...emptyAsset(),...editing},session.currency),estimate=data.get("value")?estimateForm(data,session.currency):null;setRow(editing.key,{...input,...(estimate?{estimateMinor:estimate.amountMinor,asOf:estimate.asOf,sourceName:estimate.sourceName,sourceUrl:estimate.sourceUrl,sourceType:estimate.sourceType}:{estimateMinor:null}),reviewed:true} as Partial<ImportRow>);setEditing(null);},e);}}>
      <h3>Review {editing.name||"unnamed asset"}</h3><AssetFields asset={{...emptyAsset(),...editing}} categories={categories}/><details><summary>Extracted fields</summary>{editing.sourceCells.map((cell,i)=><p key={i}><b>{cell.column}:</b> {cell.value}</p>)}</details>
      <p className="muted">Optional estimate. Leave the value blank to save without a value.</p><ImportEstimateFields row={editing}/>{action.error&&<Notice kind="bad">{action.error}</Notice>}<div className="row"><button className="btn">Keep reviewed row</button><button className="btn-secondary" type="button" onClick={()=>setEditing(null)}>Back</button></div>
    </form>:<>
      <p>Upload photos, PDFs, Excel workbooks, CSV, TSV, TXT or JSON. Up to 8 MB, 8 PDF pages, or 500 assets per file. Categories are suggested from names; you can edit them.</p>
      <p className="muted">Photos and scans use text recognition. If an object has no readable label, name it in the preview. No value is inferred from the picture.</p>
      <form onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{const result=await api<ImportPreview>(`${base}/imports`,{method:"POST",body:new FormData(form)});setPreview(result);setRows(result.rows.map(r=>({...r,selected:!r.duplicate,reviewed:false})));setReviewed(false);},e);}}><Field label="Asset file"><input name="file" type="file" accept={ACCEPT} required/></Field><button className="btn-secondary" disabled={action.busy}>{action.busy?"Reading file…":"Read file & preview"}</button></form>
      <details><summary>File layout & template</summary><p>Spreadsheet columns: Name, Category, Location, Brand, Model, Serial number, Condition, Quantity, Purchase price, Purchase date, Estimated value, Source, Source URL, As of, Tags, Notes. Only Name is required. Dates use YYYY-MM-DD; values are per item in {session.currency}. Each Excel sheet is read.</p><button className="btn-quiet" onClick={()=>{saveTextFile('Name,Category,Location,Brand,Model,Condition,Quantity,Purchase price,Purchase date,Estimated value,Source,Source URL,As of,Tags,Notes\nOffice desk,Furniture,Office,,,good,1,,,,,,,work,\n',"asset-import-template.csv","text/csv");}}>Download CSV template</button></details>
      {preview&&<><h3>{preview.filename}</h3><ul>{preview.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul><details><summary>Extracted text</summary><pre className="asset-extracted">{preview.text||"No readable text. The original file is attached to the saved asset."}</pre></details>
        <div className="row"><button className="btn-quiet" onClick={()=>setRows(all=>all.map(r=>({...r,selected:!r.duplicate})))}>Select available rows</button><button className="btn-quiet" onClick={()=>setRows(all=>all.map(r=>({...r,selected:false})))}>Clear selection</button><button className="btn-quiet" onClick={()=>setRows(all=>all.map(r=>r.selected&&!r.issues.length?{...r,reviewed:true}:r))}>Mark rows without warnings reviewed</button></div>
        <div className="asset-import-list">{rows.map(row=><article className="card" key={row.key}><div className="row"><label className="row"><input type="checkbox" checked={row.selected} disabled={row.duplicate} onChange={e=>setRow(row.key,{selected:e.target.checked})}/><b>{row.name||"Unnamed asset"}</b></label><span>{row.duplicate?"Already imported":row.reviewed?"Reviewed":"Needs review"}</span></div><p>{row.category} · {row.location||"No location"} · Qty {row.quantity} · {row.estimateMinor===null?"No estimate":<Money minor={row.estimateMinor}/>}</p>{row.issues.length>0&&<p className="muted">{row.issues.join(" ")}</p>}<button className="btn-secondary" disabled={row.duplicate} onClick={()=>setEditing(row)}>Review / edit row</button></article>)}</div>
        <Field label="Visibility for imported assets"><select value={visibility} onChange={e=>setVisibility(e.target.value)}><option value="private">Only me</option><option value="shared">Household members</option></select></Field><p className="muted">The original import document stays private to you.</p>
        <label className="row"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>I have checked the selected names, quantities and values.</label>
        <p>{selected.length} selected. {unreviewed>0?`${unreviewed} still need individual review.`:"All selected rows reviewed."}</p><button className="btn" disabled={action.busy||!selected.length||!reviewed||unreviewed>0} onClick={()=>action.run(async()=>{const result=await api<{created:string[];skipped:string[]}>(`${base}/imports/${preview.id}/confirm`,{method:"POST",body:JSON.stringify({reviewed:true,rows:selected.map(r=>({...r,visibility,estimate:r.estimateMinor===null?undefined:{amountMinor:r.estimateMinor,asOf:r.asOf||today(),sourceName:r.sourceName||preview.filename,sourceUrl:r.sourceUrl,sourceType:r.sourceType,notes:`Imported from ${preview.filename}`}}))})});saved(`${result.created.length} assets imported.${result.skipped.length?` ${result.skipped.length} duplicates skipped.`:""}`);})}>Import {selected.length} reviewed assets</button>
      </>}{action.error&&<Notice kind="bad">{action.error}</Notice>}
    </>}
  </Dialog>;
}
function ImportEstimateFields({row}:{row:ImportRow}) {
  const session=useSession();
  return <div className="asset-fields"><Field label={`Estimated unit value (${session.currency}, optional)`}><input name="value" inputMode="decimal" defaultValue={row.estimateMinor===null?"":minorToInput(row.estimateMinor,session.currency)}/></Field><Field label="Value as of"><input name="asOf" type="date" defaultValue={row.asOf||today()}/></Field><Field label="Source name"><input name="sourceName" defaultValue={row.sourceName} maxLength={200}/></Field><Field label="Source link"><input name="sourceUrl" type="url" defaultValue={row.sourceUrl} maxLength={2000}/></Field><Field label="Value basis"><select name="sourceType" defaultValue={row.sourceType}>{Object.entries(SOURCE_TYPES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></Field></div>;
}
