import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { type AssetEstimate, valueSearchLinks } from "../asset-tools.js";
import { researchAsset, type Valuation } from "../asset-valuation.js";
import { isDeviceSuite } from "../device-suite.js";
import { scoped, useSession } from "../session.js";
import { SpecialAssetResearch } from "./SpecialAssetResearch.js";
import { Field, Money, Notice } from "../ui.js";
import { comparableTerms, privateAppraisalOnly, profileForCategory, requiredComparableDetails, type AssetIdentity } from "@budgetcents/domain/asset-identity";
import { assetGuides } from "../asset-guides.js";
import { marketplaceEstimate, marketplaceMatches, type MarketplaceListing } from "../asset-listings.js";
import { AssetSales } from "./AssetSales.js";
import { AssetSpecialistGuide, type SpecialistOptions } from "./AssetSpecialistGuide.js";

interface Props { description:string; category:string; condition:string; purchased:string; purchaseMinor:number|null; identity?:AssetIdentity; brand?:string; marketplace?:boolean; specialists?:SpecialistOptions; onEstimate:(value:AssetEstimate|null)=>void; }
export function AssetResearch({description,category,condition,purchased,purchaseMinor,identity,brand="",marketplace,specialists,onEstimate}:Props) {
  const {currency,householdId}=useSession();
  const profile = identity?.profile ?? profileForCategory(category);
  const details = identity?.attributes ?? [];
  const terms = comparableTerms(profile,details);
  const search = [description,...terms.filter(value=>!description.toLowerCase().includes(value.toLowerCase()))].join(" ").trim();
  const [query,setQuery]=useState(description),[result,setResult]=useState<Valuation|null>(null);
  const [working,setWorking]=useState(false),[error,setError]=useState("");
  const sequence=useRef(0);
  useEffect(()=>()=>{sequence.current++;},[]);
  const specialCategory = category.trim().toLowerCase()==="real estate" ? "Real estate" : profile==="car" ? "Vehicles" : undefined;
  const special = Boolean(specialCategory);
  const gaps = requiredComparableDetails(profile, details);
  const privateItem = privateAppraisalOnly(profile,[description,category,query].join(" "));
  if (privateItem) return <p>Record a private estimate or attach an existing appraisal for this item.</p>;
  function change(value:string) { sequence.current++;setQuery(value);setResult(null);setWorking(false);setError("");onEstimate(null); }
  async function lookup() {
    const request=++sequence.current;
    setWorking(true);setError("");setResult(null);onEstimate(null);
    try {
      const searchQuery = [query.trim(),...terms.filter(value=>!query.toLowerCase().includes(value.toLowerCase()))].join(" ").trim();
      if(searchQuery.length>120) throw new Error("Shorten the search wording. The saved variant and grade are included automatically.");
      const market = marketplace ? api<{listings:MarketplaceListing[]}>(scoped(householdId,"/physical-assets/marketplace?"+new URLSearchParams({q:searchQuery,profile}))).catch(()=>null) : Promise.resolve(null);
      const found=await researchAsset(searchQuery,category,condition,currency,async (source,term)=>{
        const params=new URLSearchParams({source,q:term});
        if (isDeviceSuite()) {
          try {
            const response = await fetch(`/_device/catalog?${params}`, {credentials:"omit"});
            if (response.ok) return await response.json();
          } catch { /* A phone network can block a retailer. Try the household API. */ }
        }
        return api(scoped(householdId,`/physical-assets/catalog?${params}`));
      });
      const listed = await market;
      if(request!==sequence.current) return;
      // Do not blend prices from different listing markets into a sold estimate.
      const matches = listed ? marketplaceMatches(listed.listings,searchQuery,currency,condition).sort((a,b)=>a.price-b.price) : [];
      const chosen = found.matches.length >= 2 ? found : matches.length ? {
        matches, low:matches[0].price, high:matches[matches.length-1].price,
        reached:found.reached+1, searched:found.searched+1, estimate:marketplaceEstimate(matches),
      } : {...found,reached:found.reached+Number(Boolean(listed)),searched:found.searched+Number(Boolean(marketplace))};
      setResult(chosen);onEstimate(chosen.estimate);
    } catch (error) { if(request===sequence.current)setError(error instanceof Error ? error.message : "Price research is temporarily unavailable."); }
    finally { if(request===sequence.current)setWorking(false); }
  }
  return <section className="asset-research" aria-label="Research value">
    {special?<SpecialAssetResearch category={specialCategory!} {...{description:search, purchased, purchaseMinor, onEstimate}}/>:<>
      <Field label="Item to look up"><input value={query} maxLength={120} onChange={e=>change(e.target.value)} placeholder="Brand, model and size"/></Field>
      <p className="muted">Only this search description is sent to resale catalogs. Prices are per item in {currency}.</p>
      {!!gaps.length && <p className="muted">Add these details for an automatic match: {gaps.join(", ")}.</p>}
      <button type="button" className="btn-secondary" disabled={working || query.trim().length<2 || gaps.length>0} onClick={()=>void lookup()}>{working?"Checking listings…":"Research value"}</button>
      <div aria-live="polite">{result?.estimate?<div className="research-result"><p className="kicker">Resale asking estimate</p><p className="figure"><Money minor={result.estimate.amountMinor}/></p>
        <p>{result.matches.length===1?"One matching listing":`Median of ${result.matches.length} matching listings`} · {result.estimate.asOf}</p>
        {result.high!==result.low&&<p>Listed range <Money minor={result.low}/> – <Money minor={result.high}/></p>}
        <details><summary>View sources ({result.matches.length})</summary>{result.matches.map(m=><p key={m.url}><a href={m.url} target="_blank" rel="noreferrer">{m.name}</a><br/>{m.source} · <Money minor={m.price}/></p>)}</details>
        <small>Listed prices can differ from the final sale price. Check condition and included accessories.</small></div>:
        result&&<div>
          <Notice>{result.matches.length?"The listings are too sparse or varied for an automatic estimate.":result.reached?"No matching listing in this currency. Try a more specific model or record your own estimate.":"The resale catalogs could not be reached. Try again or enter a manual value."}</Notice>
          {result.matches.length>0&&<details><summary>View asking prices</summary>{result.matches.map(match=>
            <p key={match.url}><a href={match.url} target="_blank" rel="noreferrer">{match.name}</a> · <Money minor={match.price}/></p>
          )}</details>}
        </div>}
        {result && result.reached>0 && result.reached<result.searched && <small>Some catalogs were unavailable.</small>}{error&&<Notice kind="bad">{error}</Notice>}</div>
    </>}
    <details><summary>Valuation guides and source searches</summary><div className="row asset-searches">{[...(assetGuides[profile]??[]),...valueSearchLinks(query,specialCategory==="Vehicles"?"":category)].map(l=><a key={l.name} href={l.url} target="_blank" rel="noreferrer">{l.name}</a>)}</div></details>
    <AssetSpecialistGuide options={specialists} identity={{profile,attributes:details}} brand={brand} onEstimate={onEstimate}/>
    {!gaps.length && <AssetSales key={search} profile={profile} description={(search || query).slice(0,160)} onEstimate={onEstimate}/>}
  </section>;
}
