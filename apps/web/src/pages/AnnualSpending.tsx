import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AnnualSpendingReport, AnnualSpendingRow, SpendingFilters } from "@budgetcents/domain";
import { api, downloadFile } from "../api.js";
import { todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, useLoad } from "../ui.js";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const PAGE_SIZE = 20;
type Drill = (filters: Partial<SpendingFilters>, year: number, month?: number) => void;

export function AnnualSpending({filters,onDrill}:{filters:SpendingFilters;onDrill:Drill}) {
  const session=useSession(),hidden=!!session.user?.privacyMode;
  const [params,setParams]=useSearchParams();
  const currentYear=Number(todayISO().slice(0,4)),year=Number(params.get("year")??currentYear);
  const groupMerchants=params.get("merchantGrouping")!=="exact";
  const [yearDraft,setYearDraft]=useState(String(year)),[month,setMonth]=useState(Number(todayISO().slice(5,7))-1);
  const [exporting,setExporting]=useState(false),[error,setError]=useState("");
  useEffect(()=>{setYearDraft(String(year));},[year]);
  const {from:_from,to:_to,...sharedFilters}=filters;
  const query=new URLSearchParams(Object.entries({...sharedFilters,year:String(year),merchantGrouping:groupMerchants?"common":"exact"}).filter(([,value])=>!!value)).toString();
  const result=useLoad(async()=>({query,value:await api<AnnualSpendingReport>(scoped(session.householdId,`/reports/spending-year?${query}`,session.spaceId))}),[session.householdId,session.spaceId,session.tick,query]);
  const data=!result.loading&&result.data?.query===query?result.data.value:undefined;
  function change(key:string,value:string) { const next=new URLSearchParams(params);next.set(key,value);setParams(next);setError(""); }
  return <section className="card report-section annual-spending" aria-labelledby="annual-spending-title">
    <h2 id="annual-spending-title">Yearly, monthly & average spending</h2>
    <p>Three separate calculations for your categories, merchants and accounts. The year below is independent of the selected-period dates; account, category, merchant, tag and search filters apply to both.</p>
    <form className="row report-no-print" onSubmit={event=>{event.preventDefault();change("year",yearDraft);}}>
      <Field label="Spending year"><input type="number" min="1900" max="2200" step="1" required value={yearDraft} onChange={event=>setYearDraft(event.target.value)}/></Field>
      <button className="btn-secondary" type="submit">Show year</button>
      <Field label="Month to compare"><select value={month} onChange={event=>setMonth(Number(event.target.value))}>{MONTHS.map((label,index)=><option key={label} value={index}>{label}</option>)}</select></Field>
      <button type="button" className="btn-secondary" disabled={!data||!data.summary.count||hidden||session.offline||exporting} onClick={async()=>{setExporting(true);setError("");try{await downloadFile(scoped(session.householdId,`/reports/spending-year?${query}&format=csv`,session.spaceId),`spending-year-${year}.csv`);}catch(e){setError(e instanceof Error?e.message:"Could not export the year.");}finally{setExporting(false);}}}>{exporting?"Exporting…":"Export yearly & monthly CSV"}</button>
    </form>
    <label className="annual-grouping report-no-print"><input type="checkbox" checked={groupMerchants} onChange={event=>change("merchantGrouping",event.target.checked?"common":"exact")}/> Group common merchant names (for example, Walmart store numbers and Amazon / AMZN)</label>
    <p className="muted">Monthly average = year total ÷ 12, rounded for your currency. Every calendar month counts, including months with no recorded spending. This is based on recorded transactions; missing bank history is not estimated, and the current year is not projected.</p>
    {error?<ErrorNote message={error}/>:null}
    {result.loading?<Loading label="Calculating yearly and monthly spending"/>:result.error?<ErrorNote message={result.error} onRetry={session.bump}/>:null}
    {data?<>
      <p><strong>{data.year}: January 1 – December 31</strong> · {data.currency} · Spending after refunds · {data.summary.count} {data.summary.count===1?"transaction":"transactions"}</p>
      <div className="report-metrics annual-metrics">
        <article><h3>Year total</h3><p className="report-value"><Money minor={data.summary.yearlyMinor}/></p><p>Purchases <Money minor={data.summary.grossMinor}/> minus refunds <Money minor={data.summary.refundsMinor}/>.</p></article>
        <article><h3>{MONTHS[month]} total</h3><p className="report-value"><Money minor={data.summary.monthlyMinor[month]}/></p><button className="report-drill report-no-print" onClick={()=>onDrill({},year,month)}>View this month’s transactions</button></article>
        <article><h3>Monthly average</h3><p className="report-value"><Money minor={data.summary.monthlyAverageMinor}/></p><p>{data.year} total divided by 12 months.</p></article>
      </div>
      {!data.summary.count?<Notice>No posted spending is recorded for this year and these filters. Import the bank history for the months you want to include, or choose another year.</Notice>:null}
      <h3>Month-by-month totals</h3>
      <div className="annual-month-grid">{data.monthly.map((row,index)=><article key={row.date}><h4><button className="report-drill" onClick={()=>onDrill({},year,index)}>{MONTHS[index]}</button></h4><strong><Money minor={row.netMinor}/></strong><small>{row.count} {row.count===1?"transaction":"transactions"}</small></article>)}</div>
      <AnnualBreakdown title="Categories — year, month & average" label="Category" rows={data.categories} month={month} year={year} showGroup onSelect={key=>onDrill({bucketId:key},year)}/>
      <AnnualBreakdown title="Merchants — year, month & average" label="Merchant" rows={data.merchants} month={month} year={year} merchantNames onSelect={key=>onDrill(groupMerchants?{merchant:"",merchantGroup:key}:{merchant:key,merchantGroup:""},year)}/>
      <p className="muted">{groupMerchants?"Common merchant descriptions are combined for this report only. Expand a merchant to inspect the original bank names, or turn grouping off to keep them separate.":"Merchant names are shown exactly as recorded by the bank."} Other merchants remain separate. Gas spending follows your assigned categories; a gas-station purchase is not automatically categorized as fuel.</p>
      <details className="annual-extra"><summary>Category groups — year, month & average</summary><AnnualBreakdown title="Category group totals" label="Group" rows={data.groups} month={month} year={year} onSelect={key=>onDrill({group:key,bucketId:""},year)}/></details>
      <details className="annual-extra"><summary>Accounts — year, month & average</summary><AnnualBreakdown title="Account totals" label="Account" rows={data.accounts} month={month} year={year} onSelect={key=>onDrill({accountId:key},year)}/></details>
      {hidden?<p>All amounts are hidden. Show amounts to export this report.</p>:null}
    </>:null}
  </section>;
}

function AnnualBreakdown({title,label,rows,year,month,onSelect,showGroup=false,merchantNames=false}:{title:string;label:string;rows:AnnualSpendingRow[];year:number;month:number;onSelect:(key:string)=>void;showGroup?:boolean;merchantNames?:boolean}) {
  const [page,setPage]=useState(0),[search,setSearch]=useState("");
  const matching=rows.filter(row=>[row.label,...(merchantNames?row.merchantNames:[])].some(name=>name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const pages=Math.max(1,Math.ceil(matching.length/PAGE_SIZE)),safePage=Math.min(page,pages-1);
  useEffect(()=>setPage(0),[search,year]);
  function table(items:AnnualSpendingRow[],print=false) { return <div className="table-wrap report-table" tabIndex={0} role="region" aria-label={`${label} yearly monthly and average spending`}><table>
    <thead><tr><th scope="col">{label}</th><th scope="col">{year} year total</th><th scope="col">{MONTHS[month]} total</th><th scope="col">Monthly average</th></tr></thead>
    <tbody>{items.map(row=><tr key={row.key}>
      <th scope="row"><button className="report-drill" onClick={()=>onSelect(row.key)}>{row.label}</button>{showGroup?<small>{row.group}</small>:null}<small>{row.count} {row.count===1?"transaction":"transactions"} · <Money minor={row.grossMinor}/> before refunds · <Money minor={row.refundsMinor}/> refunded</small>
        <details className="annual-row-months" open={print||undefined}><summary>All 12 months{merchantNames?" & original names":""}</summary><dl>{MONTHS.map((name,index)=><div key={name}><dt>{name}</dt><dd><Money minor={row.monthlyMinor[index]}/></dd></div>)}</dl>{merchantNames?<p className="annual-original-names">Original names: {row.merchantNames.join("; ")}</p>:null}</details>
      </th><td><strong><Money minor={row.yearlyMinor}/></strong></td><td><Money minor={row.monthlyMinor[month]}/></td><td><Money minor={row.monthlyAverageMinor}/><small>Year total ÷ 12</small></td>
    </tr>)}</tbody>
  </table></div>; }
  return <section className="annual-breakdown"><h3>{title}</h3><p className="muted">Choose a name to inspect its transactions. Expand “All 12 months” for that row’s complete monthly breakdown.</p>
    <div className="row report-no-print"><Field label={`Find ${label.toLowerCase()}`}><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={`Search ${label.toLowerCase()} names`}/></Field><span role="status">{matching.length} of {rows.length} {label.toLowerCase()} entries · page {safePage+1} of {pages}</span></div>
    {matching.length?<><div className="report-no-print">{table(matching.slice(safePage*PAGE_SIZE,(safePage+1)*PAGE_SIZE))}</div><div className="report-print-only">{table(matching,true)}</div>
      {pages>1?<div className="row report-no-print"><button className="btn-secondary" disabled={!safePage} onClick={()=>setPage(safePage-1)}>Previous {label.toLowerCase()} page</button><button className="btn-secondary" disabled={safePage>=pages-1} onClick={()=>setPage(safePage+1)}>Next {label.toLowerCase()} page</button></div>:null}
    </>:<p className="muted">No matching {label.toLowerCase()} entries.</p>}
  </section>;
}
