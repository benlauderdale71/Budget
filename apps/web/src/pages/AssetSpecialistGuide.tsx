import { useState } from "react";
import { attribute, type AssetIdentity } from "@budgetcents/domain/asset-identity";
import { api } from "../api.js";
import { scoped, useSession } from "../session.js";
import { Field, Money, Notice } from "../ui.js";
import type { AssetEstimate } from "../asset-tools.js";

export type SpecialistOptions = { watch:boolean; numista:boolean; card:boolean };

export function AssetSpecialistGuide({ options, identity, brand, onEstimate }: {
  options?:SpecialistOptions; identity:AssetIdentity; brand:string; onEstimate:(value:AssetEstimate|null)=>void;
}) {
  const {householdId} = useSession();
  const {profile,attributes} = identity;
  const provider = profile==="watch" ? "watch" : profile==="coin"||profile==="banknote" ? "numista" : profile==="sports_card" ? "card" : null;
  const [grade,setGrade] = useState("");
  const [confirmed,setConfirmed] = useState(false);
  const [quote,setQuote] = useState<{title:string;estimate:AssetEstimate}|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  if (!provider||!options?.[provider]) return null;

  const reference=attribute(attributes,"Reference number"), typeId=attribute(attributes,"Numista type ID"),
    issueId=attribute(attributes,"Numista issue ID"), productId=attribute(attributes,"SportsCardsPro ID");
  const required = provider==="watch" ? !brand||!reference : provider==="numista" ? !typeId||!issueId : !productId;
  const caption=provider==="watch"?"WatchCharts":provider==="numista"?"Numista":"SportsCardsPro";
  async function fetchQuote() {
    setBusy(true);setError("");setQuote(null);onEstimate(null);
    try {
      const input = provider==="watch" ? {provider,brand,reference,usedWithBoxAndPapers:confirmed} :
        provider==="numista" ? {provider,typeId,issueId,grade} : {provider,productId,grade};
      setQuote(await api(scoped(householdId,"/physical-assets/specialist-guide"),{method:"POST",body:JSON.stringify(input)},{queue:false}));
    } catch(error) {setError(error instanceof Error?error.message:"Guide unavailable.");}
    finally {setBusy(false);}
  }
  return <details>
    <summary>Look up {caption} guide value</summary>
    {required&&<p>{provider==="watch"?"Enter the brand and complete watch reference.":provider==="numista"?"Enter the Numista type and issue IDs under Identification details.":"Enter the exact SportsCardsPro product ID under Identification details."}</p>}
    {provider==="watch"?<label className="row"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>{setConfirmed(e.target.checked);setQuote(null);onEstimate(null);}}/>This is a used watch with the original box and papers.</label>:
      <Field label="Guide grade"><select value={grade} disabled={busy} onChange={e=>{setGrade(e.target.value);setQuote(null);onEstimate(null);}}>
        <option value="">Select the confirmed grade</option>
        {(provider==="numista" ? [["g","G"],["vg","VG"],["f","F"],["vf","VF"],["xf","XF"],["au","AU"],["unc","UNC"]]
          : [["raw","Ungraded"],["8-8.5","Grade 8 or 8.5"],["9","Grade 9"],["psa10","PSA 10"]]).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></Field>}
    <button className="btn-secondary" type="button" disabled={required||busy||(provider==="watch"?!confirmed:!grade)} onClick={()=>void fetchQuote()}>{busy?"Checking guide…":"Check "+caption}</button>
    {error&&<Notice kind="bad">{error}</Notice>}
    {quote&&<div className="research-result"><strong>{quote.title} · <Money minor={quote.estimate.amountMinor}/></strong><p>{quote.estimate.notes}</p>
      <button className="btn-secondary" type="button" onClick={()=>onEstimate(quote.estimate)}>Use this guide value</button>
    </div>}
  </details>;
}
