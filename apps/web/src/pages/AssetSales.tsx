import { useState } from "react";
import type { AssetProfile } from "@budgetcents/domain/asset-identity";
import { api } from "../api.js";
import { formatMoney, parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { Field, Money, Notice } from "../ui.js";
import type { AssetEstimate, SaleEvidence } from "../asset-tools.js";

interface Entry {
  key:number; title:string; url:string; asOf:string; currency:string; amount:string; exact:boolean;
}

function entry(key:number,currency:string):Entry {
  return {key,title:"",url:"",asOf:"",currency,amount:"",exact:false};
}

export function SaleDetails({ estimate }: { estimate: AssetEstimate }) {
  const {user} = useSession();
  if (!estimate.evidence || user?.privacyMode) return null;
  const { currency, lowMinor, highMinor, sales } = estimate.evidence;
  return <details>
    <summary>{sales.length} reviewed completed sales · {formatMoney(lowMinor,currency)} to {formatMoney(highMinor,currency)}</summary>
    {sales.map((sale:SaleEvidence)=><p key={sale.url}><a href={sale.url} target="_blank" rel="noreferrer">{sale.title}</a><br/>
      {sale.asOf} · {formatMoney(sale.amountMinor,sale.currency)}{sale.currency!==currency&&
        <> · {formatMoney(sale.convertedMinor,currency)} at the {sale.rateDate} exchange rate</>}
    </p>)}
  </details>;
}

export function AssetSales({profile,description,onEstimate}:{profile:AssetProfile;description:string;onEstimate:(value:AssetEstimate|null)=>void}) {
  const {householdId,currency} = useSession();
  const [sales,setSales] = useState(()=>[entry(1,currency)]);
  const [next,setNext] = useState(2);
  const [result,setResult] = useState<AssetEstimate|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  function change(key:number,data:Partial<Entry>) {
    setSales(items=>items.map(item=>item.key===key?{...item,...data}:item));
    setResult(null);onEstimate(null);setError("");
  }
  async function calculate() {
    setBusy(true);setError("");setResult(null);onEstimate(null);
    try {
      const payload=sales.filter(item=>item.exact).map(item=>{
        if (!/^[A-Z]{3}$/.test(item.currency)) throw Error("Use a three-letter currency code for each completed sale.");
        return {title:item.title,url:item.url,asOf:item.asOf,currency:item.currency,
          comparison:"exact",amountMinor:parseAmount(item.amount,item.currency)};
      });
      const amount = await api<AssetEstimate>(scoped(householdId,"/physical-assets/completed-sales"),{
        method:"POST",body:JSON.stringify({profile,description,sales:payload}),
      },{queue:false});
      setResult(amount);onEstimate(amount);
    } catch (error) {setError(error instanceof Error?error.message:"This estimate could not be calculated.");}
    finally {setBusy(false);}
  }
  return <details>
    <summary>Calculate from completed sales</summary>
    <p>Enter at least three distinct completed sales from the past year. Use the same version, comparable condition or grade, and the same convention for fees. Asking prices and dealer quotes belong in separate estimates.</p>
    <fieldset disabled={busy}>
      {sales.map((sale,index)=><div className="card" key={sale.key}><h4>Completed sale {index+1}</h4><div className="asset-fields">
        <Field label="Sale description"><input value={sale.title} maxLength={180} onChange={e=>change(sale.key,{title:e.target.value})}/></Field>
        <Field label="Completed sale link"><input type="url" value={sale.url} maxLength={2000} onChange={e=>change(sale.key,{url:e.target.value})}/></Field>
        <Field label="Sale date"><input type="date" max={todayISO()} value={sale.asOf} onChange={e=>change(sale.key,{asOf:e.target.value})}/></Field>
        <Field label="Sale currency"><input value={sale.currency} maxLength={3} onChange={e=>change(sale.key,{currency:e.target.value.toUpperCase()})}/></Field>
        <Field label="Amount paid"><input inputMode="decimal" value={sale.amount} onChange={e=>change(sale.key,{amount:e.target.value})}/></Field>
        <label className="row"><input type="checkbox" checked={sale.exact} onChange={e=>change(sale.key,{exact:e.target.checked})}/>I checked the exact variant and comparable condition.</label>
        <button className="btn-quiet" type="button" disabled={sales.length===1} onClick={()=>{setSales(all=>all.filter(item=>item.key!==sale.key));setResult(null);onEstimate(null);}}>Remove sale</button>
      </div></div>)}
      <div className="row">
        <button type="button" className="btn-secondary" disabled={sales.length>=12} onClick={()=>{setSales(all=>[...all,entry(next,currency)]);setNext(next+1);}}>Add a completed sale</button>
        <button type="button" className="btn-secondary" disabled={sales.filter(item=>item.exact&&item.amount&&item.asOf&&item.title&&item.url).length<3} onClick={()=>void calculate()}>Calculate sold estimate</button>
      </div>
    </fieldset>
    {busy&&<p role="status">Comparing completed sales.</p>}
    {error&&<Notice kind="bad">{error}</Notice>}
    {result&&<div className="research-result"><strong>User-reviewed sold estimate · <Money minor={result.amountMinor}/></strong><SaleDetails estimate={result}/></div>}
  </details>;
}
