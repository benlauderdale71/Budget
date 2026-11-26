import { sessionToken, saveTextFile } from "../device-suite.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { profileForCategory, privateAppraisalOnly, type AssetIdentity, type PhotoRegion } from "@budgetcents/domain/asset-identity";
import { AssetIdentifyPanel, AssetIdentityFields } from "./AssetIdentityFields.js";
import { SaleDetails } from "./AssetSales.js";
import type { SpecialistOptions } from "./AssetSpecialistGuide.js";
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
const emptyAsset=():PhysicalAsset=>({id:"",name:"",category:"Other",profile:"general",attributes:[],location:"",brand:"",model:"",serialNumber:"",condition:"unknown",quantity:1,tags:[],notes:"",purchaseDate:"",purchaseMinor:null,visibility:"private",archived:false,version:1,canChangeVisibility:true,estimate:null,estimates:[],documents:[]});
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
  const options = useLoad(()=>api<{vision:boolean;marketplace:boolean;specialists?:SpecialistOptions}>(base+"/research-options"),[session.householdId]).data;
  const [query,setQuery]=useState(""),[category,setCategory]=useState(""),[location,setLocation]=useState(""),[status,setStatus]=useState("active"),[sort,setSort]=useState("name"),[group,setGroup]=useState("category"),[page,setPage]=useState(0);
  const [editing,setEditing]=useState<PhysicalAsset|null>(null),[selected,setSelected]=useState<PhysicalAsset|null>(null),[importing,setImporting]=useState<"file"|"photo"|null>(null),[message,setMessage]=useState("");
  useEffect(()=>setPage(0),[query,category,location,status,sort,group]);
  if(!state.data) return state.loading?<Loading label="Loading your physical assets"/>:<ErrorNote message={state.error||"Inventory unavailable"} onRetry={session.bump}/>;
  const assets=state.data.assets;
  const categories=[...new Set([...ASSET_CATEGORIES,...assets.map(a=>a.category)])].sort();
  const locations=[...new Set(assets.map(a=>a.location).filter(Boolean))].sort();
  const filtered=assets.filter(a=>(status==="all"||(status==="archived"?a.archived:!a.archived))&&(!category||a.category===category)&&(!location||a.location===location)&&(!query||[a.name,a.category,a.location,a.brand,a.model,a.serialNumber,a.notes,...a.tags,...(a.attributes??[]).flatMap(item=>[item.label,item.value])].join(" ").toLowerCase().includes(query.toLowerCase())));
  filtered.sort((a,b)=>(group!=="none"?(group==="category"?a.category.localeCompare(b.category):a.location.localeCompare(b.location)):0)||(sort==="value"?(b.estimate?.amountMinor??-1)*b.quantity-(a.estimate?.amountMinor??-1)*a.quantity:a.name.localeCompare(b.name)));
  const summary=inventorySummary(filtered),pageCount=Math.max(1,Math.ceil(filtered.length/48)),currentPage=Math.min(page,pageCount-1),visible=filtered.slice(currentPage*48,currentPage*48+48);
  const groups=new Map<string,PhysicalAsset[]>();for(const a of visible){const key=group==="category"?a.category:group==="location"?a.location||"No location":"All assets";groups.set(key,[...(groups.get(key)||[]),a]);}
  return <Page title="Physical assets" lede="A home for the things you own. Organize belongings, keep records, and track researched values." actions={<>{access.canWrite&&<><button className="btn-secondary" onClick={()=>setImporting("photo")}>Add from photo</button><button className="btn-secondary" onClick={()=>setImporting("file")}>Import files</button><button className="btn" onClick={()=>setEditing(emptyAsset())}>Add asset</button></>}</>}>
    {message&&<Notice>{message}</Notice>}{action.error&&<Notice kind="bad">{action.error}</Notice>}{state.error&&<Notice kind="bad">{state.error}</Notice>}
    <div className="grid three"><article className="card"><p className="kicker">Inventory shown</p><p className="figure">{summary.items}</p><p className="muted">items across {summary.records} records</p></article><article className="card"><p className="kicker">Estimated value shown</p><p className="figure">{summary.value===null?"Total exceeds display limit":<Money minor={summary.value}/>}</p><p className="muted">{summary.valued} of {summary.records} records valued</p></article><article className="card"><p className="kicker">Your records</p><p>Categories, locations, photos and source history.</p><p className="muted">Inventory estimates are separate from account balances and net worth, avoiding double counting.</p></article></div>
    <div className="card asset-toolbar"><Field label="Search assets"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name, model, serial, tag…"/></Field><Field label="Category"><select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select></Field><Field label="Location"><select value={location} onChange={e=>setLocation(e.target.value)}><option value="">All locations</option>{locations.map(l=><option key={l}>{l}</option>)}</select></Field><Field label="Show"><select value={status} onChange={e=>setStatus(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All assets</option></select></Field><Field label="Group by"><select value={group} onChange={e=>setGroup(e.target.value)}><option value="category">Category</option><option value="location">Location</option><option value="none">No groups</option></select></Field><Field label="Sort by"><select value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="value">Highest value</option></select></Field></div>
    <div className="row asset-export"><span className="muted">{filtered.length} matching records</span><button className="btn-quiet" disabled={!!session.user?.privacyMode||action.busy} onClick={()=>action.run(()=>downloadFile(`${base}/export?format=csv`,"physical-assets.csv"))}>Export all to CSV</button><button className="btn-quiet" disabled={!!session.user?.privacyMode||action.busy} onClick={()=>action.run(()=>downloadFile(`${base}/export`,"physical-assets.json"))}>Export all to JSON</button></div>
    {!filtered.length&&<div className="card"><h2>{assets.length?"No matching assets":"Start your inventory"}</h2><p>{assets.length?"Try another category, location, or search.":"Add a vehicle, furniture, electronics, tools, jewelry, property, or another belonging. You can also import a list or upload a photo."}</p></div>}
    {[...groups].map(([label,items])=><section className="asset-group" key={label}><h2>{label}</h2><div className="asset-grid">{items.map(a=><article className="card asset-card" key={a.id}><div className="row"><span className="kicker">{a.category}</span><span className="muted">{a.visibility==="private"?"Only me":"Shared"}{a.archived?" · Archived":""}</span></div><h3><button className="asset-title" onClick={()=>setSelected(a)}>{a.name}</button></h3><p className="muted">{[a.brand,a.model].filter(Boolean).join(" ")||"Add make and model for better value searches"}</p><p>{a.location||"No location"} · Qty {a.quantity} · {a.condition}</p><p className="asset-value">{a.estimate?<Money minor={a.estimate.amountMinor*a.quantity}/>:"No estimate yet"}</p>{a.estimate&&<p className="muted">{SOURCE_TYPES[a.estimate.sourceType]} · {a.estimate.asOf}</p>}<div className="asset-tags">{a.tags.map(tag=><button className="btn-quiet" key={tag} onClick={()=>setQuery(tag)}>#{tag}</button>)}</div><button className="btn-secondary" onClick={()=>setSelected(a)}>View asset & value</button></article>)}</div></section>)}
    {pageCount>1&&<div className="row"><button className="btn-secondary" disabled={currentPage===0} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button className="btn-secondary" disabled={currentPage+1===pageCount} onClick={()=>setPage(p=>p+1)}>Next</button></div>}
    {editing&&<AssetEditor key={editing.id} asset={editing} categories={categories} vision={!!options?.vision} marketplace={!!options?.marketplace} specialists={options?.specialists} close={()=>setEditing(null)} saved={()=>{setEditing(null);setMessage("Asset saved.");session.bump();}}/>}
    {selected&&<AssetDetails key={selected.id} initial={selected} marketplace={!!options?.marketplace} specialists={options?.specialists} close={()=>setSelected(null)} edit={a=>{setSelected(null);setEditing(a);}}/>}
    {importing&&<AssetImport mode={importing} vision={!!options?.vision} marketplace={!!options?.marketplace} specialists={options?.specialists} categories={categories} close={()=>setImporting(null)} saved={message=>{setImporting(null);setMessage(message);session.bump();}}/>}
  </Page>;
}
function AssetEditor({asset,categories,vision,marketplace,specialists,close,saved}:{asset:PhysicalAsset;categories:string[];vision:boolean;marketplace:boolean;specialists?:SpecialistOptions;close:()=>void;saved:()=>void}) {
  const session=useSession(),action=useAction();
  const [mode,setMode]=useState("none"),[researched,setResearched]=useState<AssetEstimate|null>(null);
  const [identity,setIdentity]=useState({name:asset.name,brand:asset.brand,model:asset.model,category:asset.category,condition:asset.condition});
  const [purchase,setPurchase]=useState({date:asset.purchaseDate,amount:asset.purchaseMinor});
  const [draft,setDraft] = useState(asset);
  const [revision,setRevision] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const [details,setDetails] = useState<AssetIdentity>({profile:asset.profile??profileForCategory(asset.category),attributes:asset.attributes??[]});
  function changeDetails(value:AssetIdentity) { setDetails(value);setResearched(null); }
  function applyIdentification(result:Partial<PhysicalAsset>) {
    if (!formRef.current) return;
    const updated = {...draft,...assetForm(new FormData(formRef.current),draft,session.currency),...result} as PhysicalAsset;
    updated.attributes = [...details.attributes.filter(item=>!result.attributes?.some(a=>a.label.toLowerCase()===item.label.toLowerCase())),...result.attributes??[]];
    setDraft(updated);setRevision(value=>value+1);
    setIdentity({name:updated.name,brand:updated.brand,model:updated.model,category:updated.category,condition:updated.condition});
    changeDetails({profile:updated.profile,attributes:updated.attributes});
  }
  const identityKey=JSON.stringify([identity,purchase,details]);
  return <Dialog title={asset.id?"Edit asset":"Add physical asset"} onClose={close}><form ref={formRef} onChange={e=>{
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
      setIdentity(current=>({...current,[name]:value}));
      if (name==="category") {
        const profile = profileForCategory(value);
        if (profile!=="general") setDetails(current=>({...current,profile}));
      }
      setResearched(null);
    }
  }} onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{
    const data=new FormData(form),body={...assetForm(data,asset,session.currency),profile:details.profile,attributes:details.attributes.map(item=>({...item,value:item.value.trim()}))};
    const estimate=mode==="manual"?estimateForm(data,session.currency):mode==="research"?researched:null;
    await api(scoped(session.householdId,`/physical-assets${asset.id?`/${asset.id}`:""}`),{method:asset.id?"PUT":"POST",body:JSON.stringify({...body,...(!asset.id&&estimate?{estimate}:{})})});saved();
  },e);}}>
    <AssetFields key={revision} asset={draft} categories={categories}/>
    <AssetIdentityFields identity={details} change={changeDetails}/>
    <AssetIdentifyPanel vision={vision} profile={details.profile} apply={applyIdentification}/>
    {!asset.id&&<fieldset className="asset-value-choice"><legend>Current value</legend>
      <div className="chips">{[["none","Add later"],["manual","Enter value"],["research","Look up value"]].map(([v,label])=><button className="chip" type="button" key={v} aria-pressed={v===mode} onClick={()=>{setMode(v);setResearched(null);}}>{label}</button>)}</div>
      {mode==="manual"&&<EstimateFields/>}
      {mode==="research"&&<AssetResearch key={identityKey} purchased={purchase.date} purchaseMinor={purchase.amount} description={searchDescription(identity)} identity={details} brand={identity.brand} marketplace={marketplace} specialists={specialists} category={identity.category} condition={identity.condition} onEstimate={setResearched}/>}
    </fieldset>}
    {action.error&&<Notice kind="bad">{action.error}</Notice>}<button className="btn" disabled={action.busy}>{action.busy?"Saving…":researched?"Save asset and estimate":"Save asset"}</button>
  </form></Dialog>;
}
function AssetDetails({initial,marketplace,specialists,close,edit}:{initial:PhysicalAsset;marketplace:boolean;specialists?:SpecialistOptions;close:()=>void;edit:(a:PhysicalAsset)=>void}) {
  const session=useSession(),access=useAccess(),action=useAction();const [asset,setAsset]=useState(initial),[researched,setResearched]=useState<AssetEstimate|null>(null),[valuing,setValuing]=useState(false);
  const base=scoped(session.householdId,`/physical-assets/${asset.id}`);
  const update=(a:PhysicalAsset)=>{setAsset(a);session.bump();};
  return <Dialog title={asset.name} onClose={close}><p>{asset.category} · {asset.location||"No location"} · {asset.visibility==="private"?"Only you":"Shared with household"}</p><p>{[asset.brand,asset.model].filter(Boolean).join(" ")} · {asset.condition} · Quantity {asset.quantity}</p>{asset.serialNumber&&<p>Serial / VIN: {asset.serialNumber}</p>}{asset.purchaseDate&&<p>Purchased {asset.purchaseDate}</p>}{asset.purchaseMinor!==null&&<p>Purchase price per item: <Money minor={asset.purchaseMinor}/></p>}{asset.notes&&<p className="asset-notes">{asset.notes}</p>}
    {!!asset.attributes?.length&&<dl className="asset-attributes">{asset.attributes.map(item=><div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
    <div className="card"><h3>Latest dated estimate</h3>{asset.estimate?<><p className="figure"><Money minor={asset.estimate.amountMinor*asset.quantity}/></p><p><Money minor={asset.estimate.amountMinor}/> per item · {asset.estimate.asOf} · {estimateBasis(asset.estimate)}</p><Source estimate={asset.estimate}/><SaleDetails estimate={asset.estimate}/></>:<p>No value has been recorded.</p>}</div>
    <h3>Research the current value</h3>
    <AssetResearch purchased={asset.purchaseDate} purchaseMinor={asset.purchaseMinor} description={searchDescription(asset)} identity={asset} brand={asset.brand} marketplace={marketplace} specialists={specialists} category={asset.category} condition={asset.condition} onEstimate={setResearched}/>
    {access.canWrite&&researched&&<button className="btn" disabled={action.busy} onClick={()=>void action.run(async()=>{
      const {asset:updated}=await api<{asset:PhysicalAsset}>(`${base}/estimates`,{method:"POST",body:JSON.stringify({...researched,version:asset.version})});update(updated);setResearched(null);
    })}>Save researched estimate</button>}
    {access.canWrite&&<button className="btn" onClick={()=>setValuing(v=>!v)}>{valuing?"Cancel estimate":"Enter value manually"}</button>}
    {valuing&&<form onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{const result=await api<{asset:PhysicalAsset}>(`${base}/estimates`,{method:"POST",body:JSON.stringify({...estimateForm(new FormData(form),session.currency),version:asset.version})});update(result.asset);setValuing(false);},e);}}><EstimateFields/><button className="btn" disabled={action.busy}>Save estimate</button></form>}
    {!!asset.estimates.length&&<details><summary>Value history ({asset.estimates.length})</summary>{asset.estimates.map((estimate,i)=><article className="asset-history" key={estimate.id||i}><p><Money minor={estimate.amountMinor}/> per item · {estimate.asOf} · {estimateBasis(estimate)}</p><Source estimate={estimate}/><SaleDetails estimate={estimate}/>{estimate.notes&&!session.user?.privacyMode&&<p>{estimate.notes}</p>}</article>)}</details>}
    <h3>Photos & documents</h3><p className="muted">Original files are visible only to the person who uploaded them, even when the asset is shared.</p>{asset.documents.map(doc=><div key={doc.id}>{/\.(png|jpe?g|webp)$/i.test(doc.filename)&&<AssetPhoto document={doc} cropAsset={asset.cropDocumentId===doc.id?asset.id:undefined}/>}<div className="row"><button className="btn-quiet" disabled={action.busy} onClick={()=>action.run(()=>downloadFile(scoped(session.householdId,`/physical-assets/documents/${doc.id}`),doc.filename))}>{doc.filename}</button>{access.canWrite&&<button className="btn-quiet" disabled={action.busy} onClick={()=>action.run(async()=>{await api(`${base}/files/${doc.id}`,{method:"DELETE"});update({...asset,documents:asset.documents.filter(d=>d.id!==doc.id)});})}>Remove attachment</button>}</div></div>)}
    {access.canWrite&&<form onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{const data=new FormData(form);const result=await api<{asset:PhysicalAsset}>(`${base}/files`,{method:"POST",body:data});update(result.asset);form.reset();},e);}}><Field label="Attach a photo or document (up to 8 MB)"><input type="file" name="file" accept={ACCEPT} required/></Field><button className="btn-secondary" disabled={action.busy}>Attach file</button></form>}
    {action.error&&<Notice kind="bad">{action.error}</Notice>}{access.canWrite&&<div className="row"><button className="btn-secondary" onClick={()=>edit(asset)}>Edit details</button><button className="btn-quiet" disabled={action.busy} onClick={()=>action.run(async()=>{const result=await api<{asset:PhysicalAsset}>(base,{method:"PUT",body:JSON.stringify({...asset,archived:!asset.archived})});update(result.asset);})}>{asset.archived?"Restore to inventory":"Archive asset"}</button></div>}
  </Dialog>;
}
function Source({estimate}:{estimate:AssetEstimate}) {return <p>{estimate.sourceUrl?<a href={estimate.sourceUrl} target="_blank" rel="noopener noreferrer">{estimate.sourceName}</a>:estimate.sourceName}</p>;}
function AssetPhoto({document,cropAsset,region}:{document:{id:string;filename:string};cropAsset?:string;region?:PhotoRegion|null}) {
  const session=useSession(),[url,setUrl]=useState(""),[error,setError]=useState("");
  useEffect(()=>{
    const controller=new AbortController();let objectUrl="";
    const params = new URLSearchParams({preview:"image",...(cropAsset?{asset:cropAsset}:{})});
    fetch(scoped(session.householdId,`/physical-assets/documents/${document.id}?${params}`),{headers:{authorization:`Bearer ${sessionToken()||""}`},signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error("Photo preview unavailable. Download the original file below.");return r.blob();})
      .then(blob=>{if(controller.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[session.householdId,document.id,cropAsset]);
  return url?<div className={region?"asset-photo-region":undefined}><img className="asset-photo" src={url} alt={document.filename}/>
    {region&&<span aria-hidden="true" style={{left:(region.x*100)+"%",top:(region.y*100)+"%",width:(region.width*100)+"%",height:(region.height*100)+"%"}}/>}
  </div>:<p className="muted">{error||"Loading photo…"}</p>;
}

interface ImportRow extends AssetIdentity {
  region?:PhotoRegion|null; identification?:{strength:string;observation:string;questions:string[]}; researched?:AssetEstimate|null;
  key:string;name:string;category:string;location:string;brand:string;model:string;serialNumber:string;condition:string;quantity:number;tags:string[];notes:string;purchaseDate:string;purchaseMinor:number|null;estimateMinor:number|null;sourceName:string;sourceUrl:string;asOf:string;sourceType:AssetEstimate["sourceType"];issues:string[];sourceCells:{column:string;value:string}[];duplicate?:boolean;selected:boolean;reviewed:boolean}
interface ImportPreview {id:string;filename:string;text:string;warnings:string[];rows:ImportRow[];documentId?:string;photo?:boolean}
function AssetImport({mode,vision,marketplace,specialists,categories,close,saved}:{
  mode:"file"|"photo";vision:boolean;marketplace:boolean;specialists?:SpecialistOptions;categories:string[];close:()=>void;saved:(s:string)=>void;
}) {
  const session=useSession(),action=useAction();const [preview,setPreview]=useState<ImportPreview|null>(null),[rows,setRows]=useState<ImportRow[]>([]),[editing,setEditing]=useState<ImportRow|null>(null),[reviewed,setReviewed]=useState(false),[visibility,setVisibility]=useState("private");
  const base=scoped(session.householdId,"/physical-assets");
  const [consent,setConsent]=useState(false);
  const isPhoto=mode==="photo";
  const selected=rows.filter(r=>r.selected),unreviewed=selected.filter(r=>!r.reviewed).length;
  const setRow=(key:string,patch:Partial<ImportRow>)=>setRows(all=>all.map(r=>r.key===key?{...r,...patch}:r));
  function addItem(split?:ImportRow) {
    const item:ImportRow = {...emptyAsset(),key:"manual:"+crypto.randomUUID(),sourceUrl:"",sourceName:"Personal estimate",
      asOf:today(),sourceType:"manual",estimateMinor:null,issues:[],sourceCells:[],selected:true,reviewed:false,
      ...(split?{category:split.category,profile:split.profile,region:split.region}:{}),
    };
    setRows(current=>[...current,item]);setEditing(item);setReviewed(false);
  }
  function estimateFor(row:ImportRow):AssetEstimate|undefined {
    return row.researched ?? (row.estimateMinor===null ? undefined : {amountMinor:row.estimateMinor,
      asOf:row.asOf||today(),sourceName:row.sourceName||preview!.filename,sourceUrl:row.sourceUrl,
      sourceType:row.sourceType,notes:"Reviewed during inventory import."});
  }
  return <Dialog title={isPhoto?"Add assets from a photo":"Import physical assets"} onClose={close}>
    {editing?<ReviewAssetRow key={editing.key} row={editing} preview={preview!} marketplace={marketplace} specialists={specialists} vision={vision} categories={categories}
      close={()=>setEditing(null)} save={patch=>{setRow(editing.key,patch);setEditing(null);setReviewed(false);}}/>:<>
      <p>{isPhoto?"Upload one photo, then review and save each item separately. JPEG, PNG or WebP up to 8 MB.":"Upload photos, PDFs, Excel workbooks, CSV, TSV, TXT or JSON. Up to 8 MB, 8 PDF pages, or 500 assets per file."}</p>
      {!isPhoto&&<p className="muted">Document import extracts readable text and tables. Use Add from photo to review separate objects.</p>}
      <form onSubmit={e=>{const form=e.currentTarget;void action.run(async()=>{
        const body = new FormData(form);
        if (isPhoto) { body.set("mode","photo");if(consent&&vision) body.set("consent","yes"); }
        const result=await api<ImportPreview>(`${base}/imports`,{method:"POST",body},{queue:false});
        setPreview(result);setRows(result.rows.map(r=>({...r,selected:!r.duplicate,reviewed:false})));setReviewed(false);
      },e);}}>
        <Field label={isPhoto?"Inventory photo":"Asset file"}><input name="file" type="file" accept={isPhoto?".png,.jpg,.jpeg,.webp":ACCEPT} required/></Field>
        {isPhoto&&vision&&<>
          <label className="row"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Send the resized photo to OpenAI for item suggestions. Keep faces, personal documents and identifiers out of the photo.</label>
          {consent&&<Field label="Visible details or context to help identify these items"><textarea name="context" maxLength={800}/></Field>}
        </>}
        {isPhoto&&!vision&&<p className="muted">AI identification is unavailable here. You can add individual items from the photo manually.</p>}
        <button className="btn-secondary" disabled={action.busy}>{action.busy?"Preparing preview…":isPhoto?(consent&&vision?"Identify items":"Open photo for manual review"):"Read file & preview"}</button>
      </form>
      {!isPhoto&&<details><summary>File layout & template</summary><p>Spreadsheet columns: Name, Category, Location, Brand, Model, Serial number, Condition, Quantity, Purchase price, Purchase date, Estimated value, Source, Source URL, As of, Tags, Notes. Only Name is required. Dates use YYYY-MM-DD; values are per item in {session.currency}. Each Excel sheet is read.</p><button className="btn-quiet" onClick={()=>{saveTextFile('Name,Category,Location,Brand,Model,Condition,Quantity,Purchase price,Purchase date,Estimated value,Source,Source URL,As of,Tags,Notes\nOffice desk,Furniture,Office,,,good,1,,,,,,,work,\n',"asset-import-template.csv","text/csv");}}>Download CSV template</button></details>}
      {preview&&<><h3>{preview.filename}</h3><ul>{preview.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>{!isPhoto&&<details><summary>Extracted text</summary><pre className="asset-extracted">{preview.text||"No readable text. The original file is attached to the saved asset."}</pre></details>}
        {isPhoto&&<button type="button" className="btn-secondary" disabled={action.busy||rows.length>=48} onClick={()=>addItem()}>Add missing item</button>}
        <div className="row"><button className="btn-quiet" onClick={()=>setRows(all=>all.map(r=>({...r,selected:!r.duplicate})))}>Select available rows</button><button className="btn-quiet" onClick={()=>setRows(all=>all.map(r=>({...r,selected:false})))}>Clear selection</button>{!isPhoto&&<button className="btn-quiet" onClick={()=>setRows(all=>all.map(r=>r.selected&&!r.issues.length?{...r,reviewed:true}:r))}>Mark rows without warnings reviewed</button>}</div>
        <div className="asset-import-list">{rows.map(row=><article className="card" key={row.key}><div className="row"><label className="row"><input type="checkbox" checked={row.selected} disabled={row.duplicate} onChange={e=>setRow(row.key,{selected:e.target.checked})}/><b>{row.name||"Unnamed asset"}</b></label><span>{row.duplicate?"Already imported":row.reviewed?"Reviewed":"Needs review"}</span></div><p>{row.category} · {row.location||"No location"} · Qty {row.quantity} · {row.estimateMinor===null?"No estimate":<Money minor={row.estimateMinor}/>}</p>{row.issues.length>0&&<p className="muted">{row.issues.join(" ")}</p>}{row.identification?.observation&&<p>{row.identification.observation}</p>}<button className="btn-secondary" disabled={row.duplicate} onClick={()=>setEditing(row)}>Review {isPhoto?"item":"row"}</button>
          {isPhoto&&<button className="btn-quiet" type="button" disabled={row.duplicate||rows.length>=48} onClick={()=>addItem(row)}>Split out another item</button>}
          {row.key.startsWith("manual:")&&<button type="button" className="btn-quiet" onClick={()=>{setRows(all=>all.filter(item=>item.key!==row.key));setReviewed(false);}}>Remove draft</button>}</article>)}</div>
        {isPhoto&&<p className="muted">If two detections refer to the same item, select one and leave the other unchecked.</p>}
        <Field label="Visibility for imported assets"><select value={visibility} onChange={e=>setVisibility(e.target.value)}><option value="private">Only me</option><option value="shared">Household members</option></select></Field><p className="muted">The original import document stays private to you.</p>
        <label className="row"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>I have checked the selected names, quantities and values.</label>
        <p>{selected.length} selected. {unreviewed>0?`${unreviewed} still need individual review.`:"All selected rows reviewed."}</p><button className="btn" disabled={action.busy||!selected.length||!reviewed||unreviewed>0} onClick={()=>action.run(async()=>{const result=await api<{created:string[];skipped:string[]}>(`${base}/imports/${preview.id}/confirm`,{method:"POST",body:JSON.stringify({reviewed:true,rows:selected.map(r=>({...r,visibility:privateAppraisalOnly(r.profile,[r.name,r.category,r.brand,r.model].join(" "))?"private":visibility,estimate:estimateFor(r)}))})});saved(`${result.created.length} assets imported.${result.skipped.length?` ${result.skipped.length} duplicates skipped.`:""}`);})}>Import {selected.length} reviewed assets</button>
      </>}{action.error&&<Notice kind="bad">{action.error}</Notice>}
    </>}
  </Dialog>;
}
function ReviewAssetRow({row,preview,marketplace,specialists,vision,categories,save,close}:{
  row:ImportRow;preview:ImportPreview;marketplace:boolean;specialists?:SpecialistOptions;vision:boolean;categories:string[];save:(patch:Partial<ImportRow>)=>void;close:()=>void;
}) {
  const {currency}=useSession(), action=useAction();
  const [identity,setIdentity] = useState<AssetIdentity>({profile:row.profile??profileForCategory(row.category),attributes:row.attributes??[]});
  const [draft,setDraft]=useState<PhysicalAsset>({...emptyAsset(),...row});
  const [revision,setRevision]=useState(0);
  const formRef=useRef<HTMLFormElement>(null);
  const [details,setDetails] = useState({name:row.name,brand:row.brand,model:row.model,category:row.category,condition:row.condition});
  const [researched,setResearched] = useState(row.researched??null);
  const [research,setResearch] = useState(false);
  const [region,setRegion] = useState(row.region??null);
  function applyIdentification(result:Partial<PhysicalAsset>) {
    if (!formRef.current) return;
    const input=assetForm(new FormData(formRef.current),draft,currency);
    const updated={...draft,...input,...result} as PhysicalAsset;
    const nextAttributes=[...identity.attributes.filter(item=>!result.attributes?.some(a=>a.label.toLowerCase()===item.label.toLowerCase())),...result.attributes??[]];
    setDraft(updated);setRevision(value=>value+1);
    setDetails({name:updated.name,brand:updated.brand,model:updated.model,category:updated.category,condition:updated.condition});
    setIdentity({profile:updated.profile,attributes:nextAttributes});setResearched(null);
  }
  return <form ref={formRef} onChange={e=>{
    const field = e.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement) || !["name","brand","model","category","condition"].includes(field.name)) return;
    setDetails(current=>({...current,[field.name]:field.value}));
    if(field.name==="category" && profileForCategory(field.value)!=="general") setIdentity(current=>({...current,profile:profileForCategory(field.value)}));
    setResearched(null);
  }} onSubmit={e=>{
    const form=e.currentTarget;
    void action.run(async()=>{
      const data = new FormData(form);
      const input = assetForm(data,{...emptyAsset(),...row},currency);
      const estimate = researched ?? (data.get("value") ? estimateForm(data,currency) : null);
      save({...input,profile:identity.profile,attributes:identity.attributes.map(item=>({...item,value:item.value.trim()})),...(preview.photo?{region}:{}),researched:estimate,estimateMinor:estimate?.amountMinor??null,reviewed:true} as Partial<ImportRow>);
    },e);
  }}>
    <h3>Review {row.name||"unnamed asset"}</h3>
    {preview.photo&&preview.documentId&&<AssetPhoto document={{id:preview.documentId,filename:preview.filename}} region={region}/>}
    {preview.photo&&<details>
      <summary>Adjust this item’s photo crop</summary>
      <p className="muted">The outline shows the portion saved for this item. Keep the full photo if the crop would omit useful context.</p>
      {region?<div className="asset-fields">
        {([["x","Left"],["y","Top"],["width","Width"],["height","Height"]] as const).map(([key,label])=>
          <Field label={label+" (%)"} key={key}><input type="number" min={key==="width"||key==="height"?1:0} max={100} value={Math.round(region[key]*100)} onChange={event=>{
            const value = Math.max(0,Math.min(1,Number(event.target.value)/100));
            const next = {...region,[key]:value};
            next.x=Math.min(.99,next.x);next.y=Math.min(.99,next.y);
            next.width=Math.max(.01,Math.min(1-next.x,next.width));
            next.height=Math.max(.01,Math.min(1-next.y,next.height));
            setRegion(next);
          }}/></Field>)}
        <button type="button" className="btn-quiet" onClick={()=>setRegion(null)}>Use full photo</button>
      </div>:<button type="button" className="btn-secondary" onClick={()=>setRegion({x:.1,y:.1,width:.8,height:.8})}>Set a crop</button>}
    </details>}
    {row.identification&&<div className="card">
      <p>{row.identification.strength==="visible_label"?"A visible label may support this identification. Check it before saving.":"The exact identity needs your confirmation."}</p>
      {row.identification.observation&&<p>{row.identification.observation}</p>}
      {row.identification.questions.length>0&&<ul>{row.identification.questions.map(question=><li key={question}>{question}</li>)}</ul>}
    </div>}
    <AssetFields key={revision} asset={draft} categories={categories}/>
    <AssetIdentifyPanel vision={vision} profile={identity.profile} apply={applyIdentification}/>
    <AssetIdentityFields identity={identity} change={next=>{setIdentity(next);setResearched(null);}}/>
    {row.sourceCells.length>0&&<details><summary>Extracted fields</summary>{row.sourceCells.map((cell,i)=><p key={i}><b>{cell.column}:</b> {cell.value}</p>)}</details>}
    <button className="btn-secondary" type="button" onClick={()=>setResearch(value=>!value)}>{research?"Hide value research":"Look up value"}</button>
    {research&&<AssetResearch key={JSON.stringify([details,identity])} description={searchDescription(details)} category={details.category}
      condition={details.condition} purchased={row.purchaseDate} purchaseMinor={row.purchaseMinor} identity={identity} brand={details.brand} marketplace={marketplace} specialists={specialists} onEstimate={setResearched}/>}
    {researched&&<div className="row"><p>Selected estimate · <Money minor={researched.amountMinor}/> · {researched.sourceName}</p>
      <button className="btn-quiet" type="button" onClick={()=>setResearched(null)}>Clear selected estimate</button></div>}
    <details><summary>Enter an estimate manually</summary><ImportEstimateFields row={{...row,estimateMinor:row.researched?null:row.estimateMinor}}/></details>
    {action.error&&<Notice kind="bad">{action.error}</Notice>}
    <div className="row"><button className="btn">Keep reviewed item</button><button className="btn-secondary" type="button" onClick={close}>Back</button></div>
  </form>;
}

function ImportEstimateFields({row}:{row:ImportRow}) {
  const session=useSession();
  return <div className="asset-fields"><Field label={`Estimated unit value (${session.currency}, optional)`}><input name="value" inputMode="decimal" defaultValue={row.estimateMinor===null?"":minorToInput(row.estimateMinor,session.currency)}/></Field><Field label="Value as of"><input name="asOf" type="date" defaultValue={row.asOf||today()}/></Field><Field label="Source name"><input name="sourceName" defaultValue={row.sourceName} maxLength={200}/></Field><Field label="Source link"><input name="sourceUrl" type="url" defaultValue={row.sourceUrl} maxLength={2000}/></Field><Field label="Value basis"><select name="sourceType" defaultValue={row.sourceType}>{Object.entries(SOURCE_TYPES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></Field></div>;
}
