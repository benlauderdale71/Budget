import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { type AssetEstimate, valueSearchLinks } from "../asset-tools.js";
import { researchAsset, type Valuation } from "../asset-valuation.js";
import { isDeviceSuite } from "../device-suite.js";
import { scoped, useSession } from "../session.js";
import { SpecialAssetResearch } from "./SpecialAssetResearch.js";
import { Field, Money, Notice } from "../ui.js";

interface Props { description:string; category:string; condition:string; purchased:string; purchaseMinor:number|null; onEstimate:(value:AssetEstimate|null)=>void; }
export function AssetResearch({description,category,condition,purchased,purchaseMinor,onEstimate}:Props) {
  const {currency,householdId}=useSession();
  const [query,setQuery]=useState(description),[result,setResult]=useState<Valuation|null>(null);
  const [working,setWorking]=useState(false),[error,setError]=useState("");
  const sequence=useRef(0);
  useEffect(()=>()=>{sequence.current++;},[]);
  const specialCategory = ["Real estate", "Vehicles"].find(item => item.toLowerCase() === category.trim().toLowerCase());
  const special = Boolean(specialCategory);
  function change(value:string) { sequence.current++;setQuery(value);setResult(null);setWorking(false);setError("");onEstimate(null); }
  async function lookup() {
    const request=++sequence.current;
    setWorking(true);setError("");setResult(null);onEstimate(null);
    try {
      const found=await researchAsset(query.trim(),category,condition,currency,async (source,term)=>{
        const params=new URLSearchParams({source,q:term});
        if (isDeviceSuite()) {
          try {
            const response = await fetch(`/_device/catalog?${params}`, {credentials:"omit"});
            if (response.ok) return await response.json();
          } catch { /* A phone network can block a retailer. Try the household API. */ }
        }
        return api(scoped(householdId,`/physical-assets/catalog?${params}`));
      });
      if(request!==sequence.current) return;
      setResult(found);onEstimate(found.estimate);
    } catch { if(request===sequence.current)setError("Price research is temporarily unavailable."); }
    finally { if(request===sequence.current)setWorking(false); }
  }
  return <section className="asset-research" aria-label="Research value">
    {special?<SpecialAssetResearch category={specialCategory!} {...{description, purchased, purchaseMinor, onEstimate}}/>:<>
      <Field label="Item to look up"><input value={query} maxLength={120} onChange={e=>change(e.target.value)} placeholder="Brand, model and size"/></Field>
      <p className="muted">Only this search description is sent to resale catalogs. Prices are per item in {currency}.</p>
      <button type="button" className="btn-secondary" disabled={working || query.trim().length<2} onClick={()=>void lookup()}>{working?"Checking listings…":"Research value"}</button>
      <div aria-live="polite">{result?.estimate?<div className="research-result"><p className="kicker">Resale asking estimate</p><p className="figure"><Money minor={result.estimate.amountMinor}/></p>
        <p>{result.matches.length===1?"One matching listing":`Median of ${result.matches.length} matching listings`} · {result.estimate.asOf}</p>
        {result.high!==result.low&&<p>Listed range <Money minor={result.low}/> – <Money minor={result.high}/></p>}
        <details><summary>View sources ({result.matches.length})</summary>{result.matches.map(m=><p key={m.url}><a href={m.url} target="_blank" rel="noreferrer">{m.name}</a><br/>{m.source} · <Money minor={m.price}/></p>)}</details>
        <small>Listed prices can differ from the final sale price. Check condition and included accessories.</small></div>:
        result&&<Notice>{result.reached?"No matching listing in this currency. Try a more specific model or record your own estimate.":"The resale catalogs could not be reached. Try again or enter a manual value."}</Notice>}
        {result && result.reached>0 && result.reached<result.searched && <small>Some catalogs were unavailable.</small>}{error&&<Notice kind="bad">{error}</Notice>}</div>
    </>}
    <details><summary>{special?"Open valuation guides":"Search additional sources"}</summary><div className="row asset-searches">{valueSearchLinks(query,specialCategory ?? category).map(l=><a key={l.name} href={l.url} target="_blank" rel="noreferrer">{l.name}</a>)}</div></details>
  </section>;
}
