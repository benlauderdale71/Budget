import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BillImportRow } from "@budgetcents/domain/bill-import";
import { parseAmount } from "@budgetcents/domain/importers";
import { isIsoDate } from "@budgetcents/domain/dates";
import { api } from "../api.js";
import { minorToInput, todayISO } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";

interface Preview { id: string; filename: string; format: string; pages: number; rows: BillImportRow[]; warnings: string[]; extractedText: string }
interface ReviewRow extends BillImportRow { selected: boolean; amount: string; balance: string; accountId: string; bucketId: string }
interface Result { created: {id:string;name:string}[]; skipped: {name:string}[]; note: string }
const CADENCES = [["once","One time"],["weekly","Weekly"],["biweekly","Every two weeks"],["monthly","Monthly"],["every_2_months","Every two months"],["every_3_months","Every three months"],["every_6_months","Every six months"],["annual","Yearly"]];
const schedulable = (row: ReviewRow) => ["bill","subscription","income"].includes(row.kind);
function problem(row: ReviewRow): string {
  if (!row.name.trim() || row.name.length > 120) return "Enter a name of up to 120 characters.";
  const amount = parseAmount(row.amount);
  if (amount == null || amount < 0 || amount > 999999999999) return "Enter a valid amount, zero or more.";
  if (!row.nextDate || !isIsoDate(row.nextDate)) return "Choose the first due date.";
  if (row.balance && parseAmount(row.balance) == null) return "Check the balance owed, or leave it blank.";
  return "";
}

export function BillImport() {
  const session = useSession();
  return <BillImportForm key={`${session.user?.id}:${session.householdId}:${session.spaceId ?? ""}`} />;
}
function BillImportForm() {
  const session=useSession(), access=useAccess();
  const dash=useLoad(()=>api<{spaceId:string;accounts:{id:string;name:string;visibility?:string}[];buckets:{id:string;name:string;systemRole?:string}[]}>(scoped(session.householdId,"/dashboard",session.spaceId)),[session.householdId,session.spaceId,session.tick]);
  const [preview,setPreview]=useState<Preview|null>(null),[rows,setRows]=useState<ReviewRow[]>([]),[result,setResult]=useState<Result|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[reviewed,setReviewed]=useState(false),[page,setPage]=useState(0),[filter,setFilter]=useState("all");
  const holdDraft=useRef(session.holdDraft);
  useEffect(()=>preview&&!result?holdDraft.current():undefined,[preview?.id,!!result]);
  const hidden=!!session.user?.privacyMode, unavailable=busy||session.offline||!access.canBudget;
  function change(key:string,patch:Partial<ReviewRow>) { setRows(items=>items.map(row=>row.key===key?{...row,...patch}:row));setReviewed(false);setError(""); }
  const selected=rows.filter(row=>row.selected&&schedulable(row));
  const invalid=selected.filter(row=>problem(row));
  const shown=rows.filter(row=>filter==="all"||filter==="selected"&&row.selected||filter===row.kind);
  const pages=Math.max(1,Math.ceil(shown.length/15));
  useEffect(()=>setPage(current=>Math.min(current,pages-1)),[pages]);
  const visible=shown.slice(page*15,(page+1)*15);
  const sum=selected.filter(row=>row.kind!=="income").reduce((value,row)=>value+(parseAmount(row.amount)??0),0);
  return <Page title="Import bills" lede="Upload a bill list or statement, review what was read, then add the schedules you choose." actions={<Link className="btn-secondary" to="/bills">Back to bills</Link>}>
    <Notice>Nothing is added until you confirm. Income stays expected income. Paid flags, payment methods and balances owed stay reference notes; this does not record payments or change your account balances.</Notice>
    {!access.canBudget?<Notice kind="bad">Your household role cannot add bill schedules.</Notice>:null}
    {error?<ErrorNote message={error}/>:null}
    {!preview?<form className="card" onSubmit={async event=>{
      event.preventDefault(); if(unavailable||!dash.data)return;
      const body=new FormData(event.currentTarget);body.set("spaceId",dash.data.spaceId);
      setBusy(true);setError("");
      try {
        const data=await api<Preview>(scoped(session.householdId,"/bill-imports"),{method:"POST",body},{queue:false});
        setPreview(data);setRows(data.rows.map(row=>({...row,selected:row.suggested&&!row.duplicate,amount:row.amountMinor==null?"":minorToInput(row.amountMinor,session.currency),balance:row.balanceOwedMinor==null?"":minorToInput(row.balanceOwedMinor,session.currency),accountId:String(body.get("accountId")||""),bucketId:""})));setPage(0);setReviewed(false);
      } catch(e) {setError(e instanceof Error?e.message:"The file could not be read.");}finally{setBusy(false);}
    }}>
      <Field label="Bill file"><input name="file" type="file" accept=".png,.jpg,.jpeg,.webp,.pdf,.csv,.xls,.xlsx" required disabled={unavailable}/></Field>
      <p className="muted">PNG, JPG, WebP, PDF, CSV, XLS or XLSX. Up to 8 MB; PDFs up to 8 pages; spreadsheets up to 10 sheets and 1,000 rows per sheet. A clear spreadsheet or PDF usually reads better than a screenshot.</p>
      <Field label="Starting month for dates such as 1st or 15th"><input name="month" type="month" defaultValue={todayISO().slice(0,7)} min="1900-01" max="2200-12" required disabled={unavailable}/></Field>
      <Field label="Default payment account"><select name="accountId" disabled={unavailable}><option value="">No account — shared schedule</option>{dash.data?.accounts.map(account=><option key={account.id} value={account.id}>{account.name}{account.visibility==="private"?" (private)":""}</option>)}</select></Field>
      <p className="muted">Your preview is private to you. Saved schedules and their reference notes follow the selected account’s visibility. A schedule without an account is shared with the household. Amounts use {session.currency}; currency is not converted.</p>
      <button disabled={unavailable||!dash.data}>{busy?"Reading your file…":"Read file"}</button>
    </form>:null}
    {busy?<Loading label={preview?"Saving reviewed schedules":"Reading all pages and sheets"}/>:null}
    {result?<div className="card" role="status"><h2>{result.created.length} schedules added</h2><p>{result.note}</p>{result.skipped.length?<p>{result.skipped.length} matching schedules were skipped to prevent duplicates.</p>:null}<Link className="btn" to="/bills">View bills</Link> <Link className="btn-secondary" to="/calendar">View calendar</Link><button className="btn-quiet" onClick={()=>{setPreview(null);setRows([]);setResult(null);setReviewed(false);setError("");}}>Upload another file</button></div>:null}
    {preview&&!result?<>
      <div className="card"><h2>Review {hidden?"your document":preview.filename}</h2><p>{rows.length} items found across {preview.pages} {preview.format==="xls"||preview.format==="xlsx"?"sheet(s)":"page(s)"}. Image readings need your selection and review. Unselected rows are not saved.</p>
        {preview.warnings.map((warning,i)=><p className="muted" key={i}>{warning}</p>)}
        {!rows.length?<Notice kind="bad">No bill rows were recognized. Check the extracted text below, add items manually, or try a clearer file with columns named Bill, Amount and Due Date.</Notice>:null}
        <p>Totals are excluded. Spending estimates need an explicit change to a bill and a due date. For two payments in a month, keep separate rows with their actual dates.</p>
        <button className="btn-quiet" disabled={busy} onClick={()=>{setPreview(null);setRows([]);setReviewed(false);setError("");}}>Discard preview</button>
      </div>
      {hidden?<Notice>Amounts and document details are hidden. Use “Show amounts” to review this import.</Notice>:<>
        <div className="row" style={{marginBlock:16}}><Field label="Show items"><select value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}><option value="all">All items</option><option value="selected">Selected items</option><option value="bill">Bills</option><option value="subscription">Subscriptions</option><option value="income">Income</option><option value="estimate">Spending estimates</option><option value="ignore">Excluded totals</option></select></Field><button className="btn-secondary" disabled={unavailable} onClick={()=>{setRows(items=>[...items,{key:`manual:${crypto.randomUUID()}`,location:"Added during review",name:"",kind:"bill",cadence:"monthly",paymentMethod:"",paidReference:"",notes:"",sourceCells:[],warnings:[],suggested:false,selected:true,amount:"",balance:"",accountId:"",bucketId:""}]);setFilter("all");setPage(Math.floor(rows.length/15));setReviewed(false);}}>Add missing item</button></div>
        {visible.map(row=><article className="card bill-import-item" key={row.key}>
          <div className="row"><h3>{row.name||"New item"}</h3><label><input type="checkbox" checked={row.selected} disabled={unavailable||!schedulable(row)} onChange={event=>change(row.key,{selected:event.target.checked})}/> Add this schedule</label></div>
          <p className="muted">{row.location}{row.duplicate?" · A matching schedule already exists; confirmation checks again.":""}</p>
          <div className="bill-import-fields">
            <Field label="Item type"><select value={row.kind} disabled={unavailable} onChange={event=>change(row.key,{kind:event.target.value as ReviewRow["kind"],selected:false})}><option value="bill">Bill</option><option value="subscription">Subscription</option><option value="income">Expected income</option><option value="estimate">Spending estimate — do not schedule</option><option value="ignore">Exclude / total</option></select></Field>
            <Field label="Name"><input value={row.name} maxLength={120} disabled={unavailable} onChange={event=>change(row.key,{name:event.target.value})}/></Field>
            <Field label={`Amount (${session.currency})`}><input inputMode="decimal" value={row.amount} disabled={unavailable} onChange={event=>change(row.key,{amount:event.target.value})}/></Field>
            <Field label="First due date"><input type="date" value={row.nextDate??""} disabled={unavailable} onChange={event=>change(row.key,{nextDate:event.target.value,anchorDay:event.target.value?Number(event.target.value.slice(8)):undefined})}/></Field>
            <Field label="Repeats"><select value={row.cadence} disabled={unavailable} onChange={event=>change(row.key,{cadence:event.target.value})}>{CADENCES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field>
            <Field label="Payment account"><select value={row.accountId} disabled={unavailable} onChange={event=>change(row.key,{accountId:event.target.value})}><option value="">No account — shared schedule</option>{dash.data?.accounts.map(account=><option key={account.id} value={account.id}>{account.name}{account.visibility==="private"?" (private)":""}</option>)}</select></Field>
            <Field label="Category"><select value={row.bucketId} disabled={unavailable} onChange={event=>change(row.key,{bucketId:event.target.value})}><option value="">Unassigned</option>{dash.data?.buckets.filter(bucket=>!bucket.systemRole).map(bucket=><option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
          </div>
          {row.selected&&problem(row)?<p className="neg">Needs attention: {problem(row)}</p>:null}
          {row.warnings.length?<details><summary>Reading notes ({row.warnings.length})</summary><ul>{row.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>:null}
          <details><summary>Reference notes and original cells</summary><p className="muted">These are notes from the file, not payment instructions. “Paid” does not settle a bill. Balance owed does not create a debt.</p><div className="bill-import-fields">
            <Field label="Payment method (reference)"><input value={row.paymentMethod} maxLength={300} disabled={unavailable} onChange={event=>change(row.key,{paymentMethod:event.target.value})}/></Field>
            <Field label="Paid status (reference)"><input value={row.paidReference} maxLength={300} disabled={unavailable} onChange={event=>change(row.key,{paidReference:event.target.value})}/></Field>
            <Field label="Balance owed (reference)"><input inputMode="decimal" value={row.balance} disabled={unavailable} onChange={event=>change(row.key,{balance:event.target.value})}/></Field>
            <Field label="Notes"><textarea value={row.notes} maxLength={4000} disabled={unavailable} onChange={event=>change(row.key,{notes:event.target.value})}/></Field>
          </div><dl className="bill-source-cells">{row.sourceCells.map((cell,i)=><div key={i}><dt>{cell.column}</dt><dd>{cell.value||"(blank)"}{cell.formula?<span> · Formula: {cell.formula}</span>:null}</dd></div>)}</dl></details>
        </article>)}
        <div className="row" aria-label="Import pages"><button className="btn-secondary" disabled={page===0} onClick={()=>setPage(page-1)}>Previous items</button><span>Page {page+1} of {pages}</span><button className="btn-secondary" disabled={page+1>=pages} onClick={()=>setPage(page+1)}>Next items</button></div>
        <details className="card" style={{marginBlock:16}}><summary>Full extracted text</summary><p className="muted">Check for rows the reader missed. This private preview expires after seven days. Original files are not kept.</p><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:360,overflow:"auto"}}>{preview.extractedText||"No text was recognized."}</pre></details>
      </>}
      <div className="card"><h2>{selected.length} schedules selected</h2><p>Selected bill amounts: <Money minor={sum}/> (a sum of these rows, not a monthly total).</p>{invalid.length?<p>{invalid.length} selected items still need a name, amount or date.</p>:null}<label><input type="checkbox" checked={reviewed} disabled={unavailable||hidden} onChange={event=>setReviewed(event.target.checked)}/> I checked the selected names, amounts, dates, repeats, notes and account visibility against my file.</label><p><button disabled={unavailable||hidden||!reviewed||!selected.length||!!invalid.length} onClick={async()=>{
        setBusy(true);setError("");
        try {
          const body={reviewed:true,rows:selected.map(row=>({key:row.key,name:row.name,kind:row.kind,amountMinor:parseAmount(row.amount),nextDate:row.nextDate,cadence:row.cadence,anchorDay:row.anchorDay,accountId:row.accountId||undefined,bucketId:row.bucketId||undefined,paymentMethod:row.paymentMethod,paidReference:row.paidReference,notes:row.notes,balanceOwedMinor:row.balance?parseAmount(row.balance):undefined}))};
          setResult(await api<Result>(scoped(session.householdId,`/bill-imports/${preview.id}/confirm`),{method:"POST",body:JSON.stringify(body)},{queue:false}));session.bump();
        }catch(e){setError(e instanceof Error?e.message:"The schedules were not saved. Your review is still here.");}finally{setBusy(false);}
      }}>Confirm and add schedules</button></p></div>
    </>:null}
  </Page>;
}

export function BillImportDetails({scheduleId}:{scheduleId:string}) {
  const session=useSession();
  const [loaded,setLoaded]=useState(false),[details,setDetails]=useState<{paymentMethod:string;paidReference:string;notes:string;balanceOwedMinor?:number;sourceCells:{column:string;value:string;formula?:string}[]}|null>(null),[error,setError]=useState("");
  useEffect(()=>{setLoaded(false);setDetails(null);setError("");},[scheduleId,session.householdId]);
  if(session.user?.privacyMode)return null;
  return <details className="bill-import-details" onToggle={async event=>{if(!event.currentTarget.open||loaded)return;try{const response=await api<{details:typeof details}>(scoped(session.householdId,`/schedules/${scheduleId}/import-details`));setDetails(response.details);setLoaded(true);}catch(e){setError(e instanceof Error?e.message:"Could not read import notes.");}}}><summary>Import notes</summary>{error?<p>{error}</p>:!loaded?<p>Loading…</p>:!details?<p>This schedule was not imported from a bill file.</p>:<><p>Reference only; no payment was recorded.</p><p>Payment method: {details.paymentMethod||"Not supplied"} · Paid in file: {details.paidReference||"Not supplied"}</p>{details.notes?<p>{details.notes}</p>:null}{details.balanceOwedMinor!=null?<p>Balance owed in file: <Money minor={details.balanceOwedMinor}/></p>:null}<dl className="bill-source-cells">{details.sourceCells.map((cell,i)=><div key={i}><dt>{cell.column}</dt><dd>{cell.value||"(blank)"}{cell.formula?` · Formula: ${cell.formula}`:""}</dd></div>)}</dl></>}</details>;
}
