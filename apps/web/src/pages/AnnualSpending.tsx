import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AnnualSpendingReport, AnnualSpendingRow, SpendingFilters } from "@budgetcents/domain";
import { api, downloadFile } from "../api.js";
import { todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, useLoad } from "../ui.js";
import { spendingCalendar, spendingMonthRange, spendingYearRange } from "../spending-filters.js";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const PAGE_SIZE = 20;
type Drill = (filters: Partial<SpendingFilters>) => void;

export function AnnualSpending({filters,onDrill,onRangeChange}:{filters:SpendingFilters;onDrill:Drill;onRangeChange:(range:Pick<SpendingFilters,"from"|"to">)=>void}) {
  const session=useSession(),hidden=!!session.user?.privacyMode;
  const [params,setParams]=useSearchParams();
  const {year,month}=spendingCalendar(filters,todayISO());
  const groupMerchants=params.get("merchantGrouping")!=="exact";
  const [yearDraft,setYearDraft]=useState(String(year));
  const [exporting,setExporting]=useState(false),[error,setError]=useState("");
  useEffect(()=>{setYearDraft(String(year));},[year,filters.from,filters.to]);
  const {from:_from,to:_to,...sharedFilters}=filters;
  const query=new URLSearchParams(Object.entries({...sharedFilters,year:String(year),merchantGrouping:groupMerchants?"common":"exact"}).filter(([,value])=>!!value)).toString();
  const result=useLoad(async()=>({query,value:await api<AnnualSpendingReport>(scoped(session.householdId,`/reports/spending-year?${query}`,session.spaceId))}),[session.householdId,session.spaceId,session.tick,query]);
  const data=!result.loading&&result.data?.query===query?result.data.value:undefined;
  function change(key:string,value:string) { const next=new URLSearchParams(params);next.set(key,value);setParams(next);setError(""); }
  return <section className="card report-section annual-spending" aria-labelledby="annual-spending-title">
    <h2 id="annual-spending-title">Yearly, monthly & average spending</h2>
    <p>The year and month follow the Through date above. Choosing a year or month here also updates the dates and detailed calculations below. Account, category, merchant, tag and search filters apply throughout the report.</p>
    {filters.from.slice(0,4)!==filters.to.slice(0,4)?<Notice>Your selected period spans multiple years. The annual overview shows {year}, the year of the Through date; selected-period details include the entire date range.</Notice>:null}
    <form className="row report-no-print" onSubmit={event=>{event.preventDefault();const nextYear=Number(yearDraft);if(Number.isInteger(nextYear)&&nextYear>=1900&&nextYear<=2200){onRangeChange(spendingYearRange(nextYear));setError("");}}}>
      <Field label="Spending year"><input type="number" min="1900" max="2200" step="1" required value={yearDraft} onChange={event=>setYearDraft(event.target.value)}/></Field>
      <button className="btn-secondary" type="submit">Show full year</button>
      <Field label="Month to view"><select value={month} onChange={event=>onRangeChange(spendingMonthRange(year,Number(event.target.value)))}>{MONTHS.map((label,index)=><option key={label} value={index}>{label}</option>)}</select></Field>
      <button type="button" className="btn-secondary" disabled={!data||!data.summary.count||hidden||session.offline||exporting} onClick={async()=>{setExporting(true);setError("");try{await downloadFile(scoped(session.householdId,`/reports/spending-year?${query}&format=csv`,session.spaceId),`spending-year-${year}.csv`);}catch(e){setError(e instanceof Error?e.message:"Could not export the year.");}finally{setExporting(false);}}}>{exporting?"Exporting…":"Export yearly & monthly CSV"}</button>
    </form>
    <label className="annual-grouping report-no-print"><input type="checkbox" checked={groupMerchants} onChange={event=>change("merchantGrouping",event.target.checked?"common":"exact")}/> Group common merchant names (for example, Walmart store numbers and Amazon / AMZN)</label>
    <p className="muted">Year total ÷ 12 spreads recorded spending across all twelve months. The complete-month average uses only months covered by matching statements across the selected accounts, including months with zero spending.</p>
    {error?<ErrorNote message={error}/>:null}
    {result.loading?<Loading label="Calculating yearly and monthly spending"/>:result.error?<ErrorNote message={result.error} onRetry={session.bump}/>:null}
    {data?<>
      <p><strong>{data.year}: January 1 – December 31</strong> · {data.currency} · Spending after refunds · {data.summary.count} {data.summary.count===1?"transaction":"transactions"}</p>
      <p>{data.completeMonths.length} verified months · <button className="report-drill" onClick={()=>onDrill({...spendingYearRange(year),review:"needs_review"})}>{data.review.unresolvedCount} spending transactions awaiting review</button> · {data.review.uncategorizedCount} with uncategorized spending.</p>
      <p><button className="report-drill" onClick={()=>onDrill({...spendingYearRange(year),tag:"category-estimate",review:"needs_review"})}>Estimated categories</button>: <Money minor={data.review.estimatedMinor}/> across {data.review.estimatedCount} unverified spending transactions. <button className="report-drill" onClick={()=>onDrill({...spendingYearRange(year),review:"reviewed"})}>Reviewed spending</button> · <Money minor={data.review.confirmedMinor}/> across {data.review.confirmedCount} transactions.</p>
      <div className="report-metrics annual-metrics">
        <article><h3>{year} year total</h3><p className="report-value"><Money minor={data.summary.yearlyMinor}/></p><p>Purchases <Money minor={data.summary.grossMinor}/> minus refunds <Money minor={data.summary.refundsMinor}/>.</p><button className="report-drill report-no-print" onClick={()=>onDrill(spendingYearRange(year))}>View full year's transactions</button></article>
        <article><h3>{MONTHS[month]} {year} total</h3><p className="report-value"><Money minor={data.summary.monthlyMinor[month]}/></p><p>{data.completeMonths.includes(month) ? "Covered by reconciled statements." : "Statement coverage is incomplete."}</p><button className="report-drill report-no-print" onClick={()=>onDrill(spendingMonthRange(year,month))}>View this month's transactions</button></article>
        <article><h3>Year total ÷ 12</h3><p className="report-value"><Money minor={data.summary.monthlyAverageMinor}/></p><p>{data.year} total divided by 12 months.</p></article>
        <article><h3>Average per complete month</h3><p className="report-value">{data.summary.completeMonthAverageMinor === null ? "Unavailable" : <Money minor={data.summary.completeMonthAverageMinor}/>}</p><p>{data.completeMonths.length} of 12 months reconciled{data.completeMonths.length ? " · "+data.completeMonths.map(i=>MONTHS[i]).join(", ") : ""}.</p><Link to={"/statement-coverage?year="+year+(filters.accountId?"&accountId="+encodeURIComponent(filters.accountId):"")}>View statement coverage</Link></article>
      </div>
      {!data.summary.count?<Notice>No posted spending is recorded for this year and these filters. Import the bank history for the months you want to include, or choose another year.</Notice>:null}
      <h3>Month-by-month totals</h3>
      <div className="annual-month-grid">{data.monthly.map((row,index)=><article key={row.date}><h4><button className="report-drill" onClick={()=>onDrill(spendingMonthRange(year,index))}>{MONTHS[index]}</button></h4><strong><Money minor={row.netMinor}/></strong><small>{row.count} {row.count===1?"transaction":"transactions"}</small></article>)}</div>
      {data.categories.some(row=>row.key==="uncategorized")?<Notice>Uncategorized purchases are included in the totals. They cannot appear under specific categories until you assign categories to their transactions. <button className="btn-quiet report-no-print" onClick={()=>onDrill({...spendingYearRange(year),bucketId:"uncategorized",group:""})}>Review uncategorized transactions</button></Notice>:null}
      <AnnualBreakdown title="Categories - year, month & average" label="Category" completeMonths={data.completeMonths} rows={data.categories} month={month} year={year} showGroup onSelect={key=>onDrill({bucketId:key})}/>
      <AnnualBreakdown title="Merchants - year, month & average" label="Merchant" completeMonths={data.completeMonths} rows={data.merchants} month={month} year={year} merchantNames onSelect={key=>onDrill(groupMerchants?{merchant:"",merchantGroup:key}:{merchant:key,merchantGroup:""})}/>
      <p className="muted">{groupMerchants?"Common merchant descriptions are combined for this report only. Expand a merchant to inspect the original bank names, or turn grouping off to keep them separate.":"Merchant names are shown exactly as recorded by the bank."} Other merchants remain separate. Gas spending follows your assigned categories; a gas-station purchase is not automatically categorized as fuel.</p>
      <details className="annual-extra"><summary>Category groups - year, month & average</summary><AnnualBreakdown title="Category group totals" label="Group" completeMonths={data.completeMonths} rows={data.groups} month={month} year={year} onSelect={key=>onDrill({group:key})}/></details>
      <details className="annual-extra"><summary>Accounts - year, month & average</summary><AnnualBreakdown title="Account totals" label="Account" completeMonths={data.completeMonths} rows={data.accounts} month={month} year={year} onSelect={key=>onDrill({accountId:key})}/></details>
      {hidden?<p>All amounts are hidden. Show amounts to export this report.</p>:null}
    </>:null}
  </section>;
}

function AnnualBreakdown({title,label,rows,year,month,completeMonths,onSelect,showGroup=false,merchantNames=false}:{title:string;label:string;rows:AnnualSpendingRow[];completeMonths:number[];year:number;month:number;onSelect:(key:string)=>void;showGroup?:boolean;merchantNames?:boolean}) {
  const [page,setPage]=useState(0),[search,setSearch]=useState("");
  const matching=rows.filter(row=>[row.label,...(merchantNames?row.merchantNames:[])].some(name=>name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const matchingYear=matching.reduce((sum,row)=>sum+row.yearlyMinor,0),matchingMonth=matching.reduce((sum,row)=>sum+row.monthlyMinor[month],0);
  const pages=Math.max(1,Math.ceil(matching.length/PAGE_SIZE)),safePage=Math.min(page,pages-1);
  useEffect(()=>setPage(0),[search,year]);
  function table(items:AnnualSpendingRow[],print=false) { return <div className="table-wrap report-table" tabIndex={0} role="region" aria-label={`${label} yearly monthly and average spending`}><table>
    <thead><tr><th scope="col">{label}</th><th scope="col">{year} year total</th><th scope="col">{MONTHS[month]} total</th><th scope="col">Year total ÷ 12</th><th scope="col">Avg. per complete month</th></tr></thead>
    <tbody>{items.map(row=><tr key={row.key}>
      <th scope="row"><button className="report-drill" onClick={()=>onSelect(row.key)}>{row.label}</button>{showGroup?<small>{row.group}</small>:null}<small>{row.count} {row.count===1?"transaction":"transactions"} · <Money minor={row.grossMinor}/> before refunds · <Money minor={row.refundsMinor}/> refunded</small>
        <details className="annual-row-months" open={print||undefined}><summary>All 12 months{merchantNames?" & original names":""}</summary><dl>{MONTHS.map((name,index)=><div key={name}><dt>{name}</dt><dd><Money minor={row.monthlyMinor[index]}/></dd></div>)}</dl>{merchantNames?<p className="annual-original-names">Original names: {row.merchantNames.join("; ")}</p>:null}</details>
      </th><td><strong><Money minor={row.yearlyMinor}/></strong></td><td><Money minor={row.monthlyMinor[month]}/></td><td><Money minor={row.monthlyAverageMinor}/></td><td>{row.completeMonthAverageMinor===null ? "—" : <Money minor={row.completeMonthAverageMinor}/>}</td>
    </tr>)}</tbody><tfoot><tr><th scope="row">{search.trim()?"Matching rows total":"Total"}</th><td><Money minor={matchingYear}/></td><td><Money minor={matchingMonth}/></td><td><Money minor={Math.round(matchingYear/12)}/></td><td>{completeMonths.length ? <Money minor={Math.round(matching.reduce((total,row)=>total+completeMonths.reduce((sum,i)=>sum+row.monthlyMinor[i],0),0)/completeMonths.length)}/> : "—"}</td></tr></tfoot>
  </table></div>; }
  return <section className="annual-breakdown"><h3>{title}</h3><p className="muted">Choose a name to filter the report while keeping the selected dates. Expand "All 12 months" for that row's monthly breakdown. Find searches this table only; the total below includes every matching row across all pages.</p>
    <div className="row report-no-print"><Field label={`Find ${label.toLowerCase()}`}><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={`Search ${label.toLowerCase()} names`}/></Field><span role="status">{matching.length} of {rows.length} {label.toLowerCase()} entries · page {safePage+1} of {pages}</span></div>
    {matching.length?<><div className="report-no-print">{table(matching.slice(safePage*PAGE_SIZE,(safePage+1)*PAGE_SIZE))}</div><div className="report-print-only">{table(matching,true)}</div>
      {pages>1?<div className="row report-no-print"><button className="btn-secondary" disabled={!safePage} onClick={()=>setPage(safePage-1)}>Previous {label.toLowerCase()} page</button><button className="btn-secondary" disabled={safePage>=pages-1} onClick={()=>setPage(safePage+1)}>Next {label.toLowerCase()} page</button></div>:null}
    </>:<p className="muted">No matching {label.toLowerCase()} entries.</p>}
  </section>;
}
