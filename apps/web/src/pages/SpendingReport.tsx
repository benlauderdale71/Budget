import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { DetailedSpendingReport, SpendingBreakdown, SpendingFilters, SpendingLine } from "@budgetcents/domain";
import { addDays, addMonths, periodFromDate } from "@budgetcents/domain/dates";
import { api, downloadFile } from "../api.js";
import { formatMoney, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";

const filterKeys = ["accountId","bucketId","group","merchant","tag","q"] as const;
const PAGE_SIZE = 25;
function presetRange(preset:string) {
  const today=todayISO(), month=periodFromDate(today);
  if(preset==="last-month") {const last=periodFromDate(addMonths(month.start,-1));return {from:last.start,to:last.end};}
  if(preset==="90-days") return {from:addDays(today,-89),to:today};
  if(preset==="year") return {from:`${today.slice(0,4)}-01-01`,to:today};
  if(preset==="last-year") return {from:`${Number(today.slice(0,4))-1}-01-01`,to:`${Number(today.slice(0,4))-1}-12-31`};
  return {from:month.start,to:today};
}
function filtersFrom(params:URLSearchParams):SpendingFilters {
  return {...presetRange("month"),...Object.fromEntries(["from","to",...filterKeys].flatMap(key=>params.get(key)?[[key,params.get(key)!]]:[]))};
}
function queryFor(filters:SpendingFilters) {return new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v)).toString();}

export function SpendingReport() {
  const session=useSession();
  return <SpendingReportBody key={`${session.user?.id}:${session.householdId}:${session.spaceId??""}`}/>;
}
function SpendingReportBody() {
  const session=useSession(), hidden=!!session.user?.privacyMode;
  const [params,setParams]=useSearchParams(), query=queryFor(filtersFrom(params));
  const [draft,setDraft]=useState<SpendingFilters>(()=>filtersFrom(params));
  const [page,setPage]=useState(0),[sort,setSort]=useState("date"),[exporting,setExporting]=useState(false),[error,setError]=useState("");
  const report=useLoad(async()=>({query,value:await api<DetailedSpendingReport>(scoped(session.householdId,`/reports/spending-detail?${query}`,session.spaceId))}),[session.householdId,session.spaceId,session.tick,query]);
  useEffect(()=>{setDraft(filtersFrom(params));setPage(0);setError("");},[query]);
  const data=!report.loading&&report.data?.query===query?report.data.value:undefined, options=report.data?.value.options;
  const changed=queryFor(draft)!==query;
  function apply(next:SpendingFilters){setParams(queryFor(next));setPage(0);}
  function drill(key:typeof filterKeys[number],value:string){apply({...filtersFrom(params),[key]:value});}
  const sorted=data?[...data.lines].sort((a,b)=>sort==="largest"?b.amountMinor-a.amountMinor||b.date.localeCompare(a.date):sort==="merchant"?a.merchant.localeCompare(b.merchant)||b.date.localeCompare(a.date):b.date.localeCompare(a.date)||a.key.localeCompare(b.key)):[];
  const pages=Math.max(1,Math.ceil(sorted.length/PAGE_SIZE));
  useEffect(()=>setPage(p=>Math.min(p,pages-1)),[pages]);
  const household=session.households.find(h=>h.id===session.householdId);
  return <div className="spending-report"><Page title="Spending report" lede="See where your money went, compare periods, and inspect every category and purchase." actions={<div className="row report-no-print">
    <button className="btn-secondary" disabled={!data||!data.lines.length||hidden||session.offline||exporting} onClick={async()=>{setExporting(true);setError("");try{await downloadFile(scoped(session.householdId,`/reports/spending-detail?${query}&format=csv`,session.spaceId),`spending-${data!.from}-to-${data!.to}.csv`);}catch(e){setError(e instanceof Error?e.message:"Could not export report.");}finally{setExporting(false);}}}>{exporting?"Exporting…":"Export full CSV"}</button>
    <button className="btn-secondary" disabled={!data} onClick={()=>window.print()}>Print / save PDF</button>
  </div>}>
    {error?<ErrorNote message={error}/>:null}
    {session.offline?<Notice>This report may use previously loaded data while you are offline. Connect to refresh or export.</Notice>:null}
    <form className="card report-no-print" onSubmit={event=>{event.preventDefault();apply(draft);}}>
      <div className="report-filters">
        <Field label="Date shortcut"><select defaultValue="" onChange={event=>{if(event.target.value)setDraft(current=>({...current,...presetRange(event.target.value)}));event.target.value="";}}><option value="">Choose dates…</option><option value="month">This month to date</option><option value="last-month">Last month</option><option value="90-days">Last 90 days</option><option value="year">This year to date</option><option value="last-year">Last year</option></select></Field>
        <Field label="From"><input type="date" min="1900-01-01" max="2200-12-31" required value={draft.from} onChange={e=>setDraft({...draft,from:e.target.value})}/></Field>
        <Field label="Through"><input type="date" min="1900-01-01" max="2200-12-31" required value={draft.to} onChange={e=>setDraft({...draft,to:e.target.value})}/></Field>
      </div>
      <details className="report-filter-details"><summary>Filter by account, category, merchant or tag</summary><div className="report-filters">
        <Field label="Account"><select value={draft.accountId??""} onChange={e=>setDraft({...draft,accountId:e.target.value})}><option value="">All visible accounts</option>{options?.accounts.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Category group"><select value={draft.group??""} onChange={e=>setDraft({...draft,group:e.target.value,bucketId:""})}><option value="">All groups</option>{options?.groups.map(g=><option key={g}>{g}</option>)}</select></Field>
        <Field label="Category"><select value={draft.bucketId??""} onChange={e=>setDraft({...draft,bucketId:e.target.value})}><option value="">All categories</option><option value="uncategorized">Uncategorized</option>{options?.categories.filter(c=>!draft.group||c.group===draft.group).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Merchant"><select value={draft.merchant??""} onChange={e=>setDraft({...draft,merchant:e.target.value})}><option value="">All merchants</option>{options?.merchants.map(m=><option key={m}>{m}</option>)}</select></Field>
        <Field label="Tag"><select value={draft.tag??""} onChange={e=>setDraft({...draft,tag:e.target.value})}><option value="">All tags</option>{options?.tags.map(t=><option key={t}>{t}</option>)}</select></Field>
        <Field label="Search merchant or notes"><input type="search" maxLength={200} value={draft.q??""} onChange={e=>setDraft({...draft,q:e.target.value})}/></Field>
      </div></details>
      <div className="row"><button type="submit" className="btn">Apply filters</button><button type="button" className="btn-quiet" onClick={()=>apply(presetRange("month"))}>Reset report</button>{changed?<span className="muted">Apply to update the report below.</span>:null}</div>
    </form>
    {report.loading?<Loading label="Building your spending report"/>:report.error?<ErrorNote message={report.error} onRetry={session.bump}/>:null}
    {data?<>
      <p className="report-period"><strong>{household?.name}</strong> · {data.from} through {data.to} · {data.currency}<br/><span className="muted">Compared with {data.previousFrom} through {data.previousTo} ({data.days} days each), using the same filters.</span></p>
      <div className="chips report-no-print">{filterKeys.filter(k=>params.get(k)).map(k=><button key={k} className="chip" onClick={()=>drill(k,"")}>Clear {k==="bucketId"?"category":k==="accountId"?"account":k==="q"?"search":k} ×</button>)}</div>
      <p className="report-print-only">Filters: {filterKeys.filter(k=>params.get(k)).map(k=>`${k==="accountId"?"Account":k==="bucketId"?"Category":k}: ${k==="accountId"?options?.accounts.find(a=>a.id===params.get(k))?.name:k==="bucketId"?options?.categories.find(c=>c.id===params.get(k))?.name??"Uncategorized":params.get(k)}`).join("; ")||"All visible spending"}</p>
      <div className="report-metrics">
        <article className="card report-total"><h2>Net spending</h2><p className="report-value"><Money minor={data.summary.netMinor}/></p><p>Spending minus refunds</p><p><Money minor={Math.abs(data.changeMinor)}/> {data.changeMinor<0?"less":data.changeMinor>0?"more":"change"} than the previous period{hidden||data.changeBps==null?"":` (${Math.abs(data.changeBps/100).toFixed(1)}%)`}</p></article>
        <article className="card"><h2>Before refunds</h2><p className="report-value"><Money minor={data.summary.grossMinor}/></p><p>Refunds & reimbursements <Money minor={data.summary.refundsMinor}/></p></article>
        <article className="card"><h2>Daily average</h2><p className="report-value"><Money minor={data.summary.dailyAverageMinor}/></p><p>Across all {data.days} calendar days, including days without spending.</p></article>
        <article className="card"><h2>Transactions</h2><p className="report-value">{data.summary.count}</p><p>Average net <Money minor={data.summary.averageTransactionMinor}/> per transaction. Splits are counted once.</p></article>
      </div>
      {data.summary.uncategorizedCount?<Notice>{data.summary.uncategorizedCount} transactions have uncategorized spending totaling <Money minor={data.summary.uncategorizedMinor}/>. <button className="btn-quiet report-no-print" onClick={()=>apply({...filtersFrom(params),group:"",bucketId:"uncategorized"})}>Review uncategorized</button></Notice>:null}
      {!data.lines.length?<Notice>No posted spending matches this date range and these filters. <Link to="/import">Import transactions</Link> or choose a different range. Bill schedules appear here after payments are recorded.</Notice>:null}
      <section className="card report-section"><h2>Spending over time</h2><p className="muted">Net spending after refunds. Days without activity are included. Negative values mean refunds exceeded purchases.</p><Trend data={data} hidden={hidden}/></section>
      <section className="card report-section"><h2>Category groups</h2><Breakdown rows={data.groups} label="Group" hidden={hidden} onSelect={key=>apply({...filtersFrom(params),group:key,bucketId:""})}/></section>
      <section className="card report-section"><h2>Detailed categories</h2><p className="muted">Each split stays in its own category. Share is the percentage of spending before refunds. Categories with activity only in the comparison period are also shown.</p><Breakdown rows={data.categories} label="Category" hidden={hidden} showGroup onSelect={key=>drill("bucketId",key)}/></section>
      <div className="report-pair">
        <section className="card report-section"><h2>Merchants & payees</h2><Breakdown rows={data.merchants} label="Merchant" hidden={hidden} compact onSelect={key=>drill("merchant",key)}/></section>
        <section className="card report-section"><h2>Spending by account</h2><Breakdown rows={data.accounts} label="Account" hidden={hidden} compact onSelect={key=>drill("accountId",key)}/></section>
      </div>
      <section className="card report-section"><h2>Transaction detail</h2><p>{data.lines.length} spending lines from {data.summary.count} transactions. Split purchases use separate lines; the line amounts add up to the report total.</p>
        <div className="row report-no-print"><Field label="Sort transactions"><select value={sort} onChange={e=>{setSort(e.target.value);setPage(0);}}><option value="date">Newest first</option><option value="largest">Largest spending first</option><option value="merchant">Merchant A–Z</option></select></Field><span role="status">Page {page+1} of {pages} · {sorted.length?Math.min(page*PAGE_SIZE+1,sorted.length):0}–{Math.min((page+1)*PAGE_SIZE,sorted.length)} of {sorted.length} lines</span></div>
        <div className="report-no-print"><DetailTable lines={sorted.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE)} hidden={hidden}/></div>
        <div className="report-print-only"><DetailTable lines={sorted} hidden={hidden}/></div>
        <div className="row report-no-print"><button className="btn-secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous page</button><button className="btn-secondary" disabled={page>=pages-1} onClick={()=>setPage(p=>p+1)}>Next page</button></div>
        <p><strong>Total net spending: <Money minor={data.summary.netMinor}/></strong></p>
      </section>
      <section className="card report-section"><h2>What this report includes</h2><p>Only records you can currently access in this budget space. Posted purchases, fees, interest expenses and the expense portions of loan payments count as spending. Refunds and reimbursements reduce spending on the date they post.</p><p>Transfers, credit-card payments, loan principal, opening balances, reconciliation adjustments, investments, income and scheduled future bills are not spending. Different currencies are excluded; this report does not invent exchange rates.</p><p>Excluded in the selected account/date range, before category, merchant, tag or search filters: {data.excluded.pending} pending transactions; {data.excluded.markedExcluded} marked excluded; {data.excluded.nonSpending} without a spending portion; {data.excluded.otherCurrency} in another currency.</p><p>Comparison: the immediately preceding {data.days} days, with the same filters. A percentage change is shown only when the previous net spending is positive. Refunds can make net spending negative. Transaction counts in different categories may overlap because a purchase can have several splits.</p>{hidden?<p>Amounts, percentages, charts and transaction notes are hidden. Show amounts to export the CSV.</p>:null}</section>
    </>:null}
  </Page></div>;
}
function Breakdown({rows,label,hidden,onSelect,showGroup=false,compact=false}:{rows:SpendingBreakdown[];label:string;hidden:boolean;onSelect:(key:string)=>void;showGroup?:boolean;compact?:boolean}) {
  return rows.length?<div className="table-wrap report-table" tabIndex={0} role="region" aria-label={`${label} spending breakdown`}><table><thead><tr><th scope="col">{label}</th><th scope="col">Spending</th>{!compact?<th scope="col">Refunds</th>:null}<th scope="col">Net</th><th scope="col">Previous</th><th scope="col">Change</th>{!compact?<th scope="col">Share</th>:null}<th scope="col">Transactions</th></tr></thead><tbody>{rows.map(row=><tr key={row.key}><th scope="row"><button className="report-drill" onClick={()=>onSelect(row.key)}>{row.label}</button>{showGroup?<small>{row.group}</small>:null}</th><td><Money minor={row.grossMinor}/></td>{!compact?<td><Money minor={row.refundsMinor}/></td>:null}<td><strong><Money minor={row.netMinor}/></strong></td><td><Money minor={row.previousMinor}/></td><td><Money minor={row.changeMinor}/><small>{hidden?"••••":row.changeBps==null?"No positive baseline":`${row.changeBps>0?"+":""}${(row.changeBps/100).toFixed(1)}%`}</small></td>{!compact?<td>{hidden?"••••":<>{(row.shareBps/100).toFixed(1)}%<span className="bar" aria-hidden="true"><span style={{width:`${row.shareBps/100}%`}}/></span></>}</td>:null}<td>{row.count}</td></tr>)}</tbody></table></div>:<p className="muted">No spending in either period.</p>;
}
function DetailTable({lines,hidden}:{lines:SpendingLine[];hidden:boolean}) {
  return <div className="table-wrap report-table" tabIndex={0} role="region" aria-label="Spending transactions"><table><thead><tr><th scope="col">Date</th><th scope="col">Merchant / notes</th><th scope="col">Category</th><th scope="col">Account</th><th scope="col">Net spending</th><th scope="col">Status</th></tr></thead><tbody>{lines.map(line=><tr key={line.key}><td>{line.date}</td><th scope="row"><Link to={`/activity?ids=${encodeURIComponent(line.transactionId)}`}>{line.merchant}</Link><small>{line.type.replaceAll("_"," ")}{line.tags.length?` · ${line.tags.join(", ")}`:""}</small>{!hidden&&line.notes?<small>{line.notes}</small>:null}{!hidden&&line.memo?<small>Split: {line.memo}</small>:null}</th><td>{line.category}<small>{line.group}</small></td><td>{line.account}</td><td><Money minor={line.amountMinor}/>{!hidden&&line.amountMinor<0?<small>Refund</small>:null}</td><td>{line.reviewStatus==="reviewed"?"Reviewed":"Needs review"}<small>{line.reconciled?"Reconciled":line.cleared?"Cleared":"Uncleared"}</small></td></tr>)}</tbody></table></div>;
}
function Trend({data,hidden}:{data:DetailedSpendingReport;hidden:boolean}) {
  const [monthly,setMonthly]=useState(data.days>62);
  const rows=monthly?data.monthly:data.daily;
  const max=Math.max(1,...rows.map(r=>r.netMinor)),min=Math.min(0,...rows.map(r=>r.netMinor));
  const y=(value:number)=>180-(value-min)/(max-min)*150;
  const x=(index:number)=>45+index/Math.max(1,rows.length-1)*680;
  return <><div className="chips report-no-print"><button className="chip" aria-pressed={!monthly} onClick={()=>setMonthly(false)}>Daily</button><button className="chip" aria-pressed={monthly} onClick={()=>setMonthly(true)}>Monthly</button></div>{hidden?<p>Chart hidden with amounts.</p>:<svg className="spending-trend" viewBox="0 0 770 230" role="img" aria-label={`${monthly?"Monthly":"Daily"} net spending. Exact values are in the trend table below.`}><title>Net spending over time</title><line x1="45" x2="725" y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".4"/><polyline points={rows.map((r,i)=>`${x(i)},${y(r.netMinor)}`).join(" ")} fill="none" stroke="var(--teal)" strokeWidth="3"/>{rows.length<=93?rows.map((row,i)=><circle key={row.date} cx={x(i)} cy={y(row.netMinor)} r="3" fill="var(--teal)"><title>{row.date}: {formatMoney(row.netMinor,data.currency)}</title></circle>):null}<text x="45" y="18">High: {formatMoney(Math.max(...rows.map(r=>r.netMinor)),data.currency)}</text><text x="725" y="18" textAnchor="end">Low: {formatMoney(Math.min(...rows.map(r=>r.netMinor)),data.currency)}</text><text x="45" y="215">{rows[0]?.date}</text><text x="725" y="215" textAnchor="end">{rows.at(-1)?.date}</text></svg>}
    <details className="report-no-print"><summary>View exact {monthly?"monthly":"daily"} totals</summary><div className="table-wrap report-table" tabIndex={0} role="region" aria-label="Spending trend totals"><table><thead><tr><th>Date</th><th>Spending</th><th>Refunds</th><th>Net spending</th><th>Transactions</th></tr></thead><tbody>{rows.map(row=><tr key={row.date}><th scope="row">{row.date}</th><td><Money minor={row.grossMinor}/></td><td><Money minor={row.refundsMinor}/></td><td><Money minor={row.netMinor}/></td><td>{row.count}</td></tr>)}</tbody></table></div></details></>;
}
