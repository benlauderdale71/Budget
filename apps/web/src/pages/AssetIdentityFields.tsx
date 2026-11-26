import { useId, useState } from "react";
import { assetProfiles, assetProfileKeys, attribute, profileForCategory, type AssetAttribute, type AssetIdentity, type AssetProfile } from "@budgetcents/domain/asset-identity";
import { api } from "../api.js";
import { scoped, useSession } from "../session.js";
import { Field, Notice } from "../ui.js";
import type { PhysicalAsset } from "../asset-tools.js";

export interface AssetSuggestion extends AssetIdentity {
  name: string; brand: string; model: string; category: string; observation: string; questions: string[];
}

export function AssetIdentityFields({ identity, change }: { identity:AssetIdentity; change:(identity:AssetIdentity)=>void }) {
  const labels = assetProfiles[identity.profile].fields as readonly string[];
  const [customLabel,setCustomLabel] = useState("");
  const [customValue,setCustomValue] = useState("");
  const extra = identity.attributes.filter(item => !labels.some(label => label.toLowerCase() === item.label.toLowerCase()));
  const isNew = customLabel.trim() && customValue.trim() && identity.attributes.length < 32 &&
    ![...labels,...identity.attributes.map(item=>item.label)].some(label=>label.toLowerCase()===customLabel.trim().toLowerCase());
  function setField(label:string,value:string) {
    const existing = identity.attributes.findIndex(item => item.label.toLowerCase() === label.toLowerCase());
    if (existing < 0 && identity.attributes.length >= 32) return;
    const attributes = existing < 0 ? [...identity.attributes,{label,value}] :
      identity.attributes.flatMap((item,index)=>index!==existing?[item]:value.trim()?[{label,value}]:[]);
    change({...identity,attributes});
  }
  const count = identity.attributes.filter(item=>item.value.trim()).length;
  return <div className="asset-extra">
    <Field label="Asset type"><select value={identity.profile} onChange={e=>change({...identity,profile:e.target.value as AssetProfile})}>
      {assetProfileKeys.map(key=><option key={key} value={key}>{assetProfiles[key].label}</option>)}
    </select></Field>
    <details open={identity.profile !== "general" || undefined}>
      <summary>Identification details{count > 0 ? " (" + count + ")" : ""}</summary>
      <div className="asset-fields">
        {labels.map(label=><Field key={label} label={label}><input value={attribute(identity.attributes,label)} maxLength={200} onChange={e=>setField(label,e.target.value)}/></Field>)}
        {extra.map(item=><div key={item.label}><Field label={item.label}><input value={item.value} maxLength={200} onChange={event=>setField(item.label,event.target.value)}/></Field>
          <button className="btn-quiet" type="button" onClick={()=>setField(item.label,"")}>Remove {item.label}</button></div>)}
        <Field label="Custom detail name"><input value={customLabel} maxLength={60} onChange={e=>setCustomLabel(e.target.value)} placeholder="e.g. Lens serial label"/></Field>
        <Field label="Custom detail value"><input value={customValue} maxLength={200} onChange={e=>setCustomValue(e.target.value)}/></Field>
        <button className="btn-secondary" type="button" disabled={!isNew} onClick={()=>{setField(customLabel.trim(),customValue.trim());setCustomLabel("");setCustomValue("");}}>Add detail</button>
      </div>
    </details>
  </div>;
}

export function AssetIdentifyPanel({ vision, profile, apply }: {
  vision: boolean; profile:AssetProfile; apply:(result:Partial<PhysicalAsset>)=>void;
}) {
  const session = useSession();
  const label = useId();
  const [description,setDescription] = useState("");
  const [vin,setVin] = useState("");
  const [closeup,setCloseup] = useState<File|null>(null);
  const [consent,setConsent] = useState(false);
  const [suggestion,setSuggestion] = useState<AssetSuggestion|null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const vehicle = ["car","motorcycle","atv"].includes(profile);
  if (!vision && !vehicle) return null;
  const base = scoped(session.householdId,"/physical-assets");
  async function identify(kind:"vision"|"vin") {
    setBusy(true);setError("");setSuggestion(null);
    try {
      if (kind==="vin") {
        const result = await api<{brand:string;model:string;attributes:AssetAttribute[]}>(base+"/decode-vin",{method:"POST",body:JSON.stringify({vin})},{queue:false});
        setSuggestion({...result, category:"", profile, name:[result.brand,result.model].join(" "), observation:"Verify trim and mileage before valuing this vehicle.",questions:[]});
      } else {
        const endpoint = closeup ? "/identify-photo" : "/identify";
        const body = closeup ? new FormData() : JSON.stringify({notes:description,consent});
        if (body instanceof FormData && closeup) {
          body.set("file",closeup);body.set("context",description);if(consent) body.set("consent","yes");
        }
        const result = await api<{items:AssetSuggestion[]}>(base+endpoint,{method:"POST",body},{queue:false});
        if (result.items.length!==1) throw Error("A single item could not be confirmed. Try a close-up showing only that item and its identifying marks.");
        setSuggestion(result.items[0]);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Identification is unavailable."); }
    finally { setBusy(false); }
  }
  return <details className="asset-extra">
    <summary>Help identify this item</summary>
    {vision&&<>
      <Field label="What can you read or observe?"><textarea value={description} maxLength={800} onChange={e=>setDescription(e.target.value)} placeholder="Model markings, label text, or distinguishing details"/></Field>
      <Field label="Optional close-up photo"><input type="file" accept=".jpg,.jpeg,.png,.webp" onChange={e=>setCloseup(e.target.files?.[0]??null)}/></Field>
      <label className="row" htmlFor={label}><input id={label} type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Send this description and any selected close-up to OpenAI for identification. Leave out serial numbers and personal information.</label>
      <button className="btn-secondary" type="button" disabled={busy||!consent||(!closeup&&description.trim().length<3)} onClick={()=>void identify("vision")}>Suggest identity</button>
    </>}
    {vehicle&&<>
      <Field label="VIN for NHTSA lookup"><input maxLength={17} value={vin} onChange={e=>setVin(e.target.value.toUpperCase().trim())}/></Field>
      <button className="btn-secondary" type="button" disabled={busy||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)} onClick={()=>void identify("vin")}>Send VIN to NHTSA</button>
    </>}
    {busy&&<p role="status">Checking identification.</p>}
    {error&&<Notice kind="bad">{error}</Notice>}
    {suggestion&&<div className="card">
      <strong>{[suggestion.name,suggestion.brand,suggestion.model].filter(Boolean).join(" · ")}</strong>
      {suggestion.attributes.length>0&&<ul>{suggestion.attributes.map(item=><li key={item.label}>{item.label} · {item.value}</li>)}</ul>}
      {suggestion.observation&&<p>{suggestion.observation}</p>}
      {suggestion.questions.length>0&&<ul>{suggestion.questions.map(question=><li key={question}>{question}</li>)}</ul>}
      <button className="btn-secondary" type="button" onClick={()=>{
        const {name,brand,model,category,attributes} = suggestion;
        apply({name,brand,model,...(category?{category}:{}),
          profile:suggestion.profile==="general"&&category?profileForCategory(category):suggestion.profile,attributes});
        setSuggestion(null);
      }}>Use these details</button>
    </div>}
  </details>;
}
