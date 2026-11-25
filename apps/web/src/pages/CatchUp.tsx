import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { CatchUpTerms, catchUpProjection } from "@budgetcents/domain";
import { api } from "../api.js";
import { minorToInput, parseAmount, todayISO } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";

type Saved = {terms:CatchUpTerms|null; version:number};
type Projection = ReturnType<typeof catchUpProjection> & {version:number;end:string};

export function CatchUp() {
  const session=useSession();
  const [choice,setChoice]=useState("");
  const url=scoped(session.householdId,"/dashboard",session.spaceId);
  const dash=useLoad(async()=>({url,data:await api<Dashboard>(url)}),[url,session.tick]);
  const data=dash.data?.url===url?dash.data.data:undefined;
  const accounts=data?.accounts.filter(a=>a.onBudget && !a.archived && ["checking","savings","cash"].includes(a.kind) && a.currency===data.household.currency) ?? [];
  const account=accounts.find(a=>a.id===choice) ?? accounts[0];
  return <Page title="Paycheck catch-up plan" lede="Plan how to catch up on a past-due bill while covering upcoming bills and everyday expenses.">
    {dash.error && <ErrorNote message={dash.error} onRetry={session.bump}/>}
    {!data && dash.loading && <Loading label="Loading accounts"/>}
    {account ? <><Field label="Account to pay from"><select value={account.id} onChange={e=>setChoice(e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      {session.user?.privacyMode ? <Notice>Show amounts to open your plan.</Notice> : <AccountPlan key={url+account.id} accountId={account.id} currency={account.currency}/>}</> :
      data && <Notice>Add an on-budget cash account to build a plan.</Notice>}
    <p><Link to="/paychecks">Manage expected paychecks</Link> · <Link to="/bills">Manage scheduled bills</Link></p>
  </Page>;
}

function AccountPlan({accountId,currency}:{accountId:string;currency:string}) {
  const s=useSession(), url=scoped(s.householdId,"/catch-up?accountId="+encodeURIComponent(accountId),s.spaceId);
  const saved=useLoad(()=>api<Saved>(url),[url]);
  return saved.error ? <ErrorNote message={saved.error} onRetry={()=>window.location.reload()}/> : saved.data
    ? <PlanForm accountId={accountId} currency={currency} saved={saved.data}/> : <Loading label="Opening plan"/>;
}

function PlanForm({accountId,currency,saved}:{accountId:string;currency:string;saved:Saved}) {
  const s=useSession(), access=useAccess(), terms=saved.terms;
  const [version,setVersion]=useState(saved.version),[regular,setRegular]=useState(!!terms?.regular);
  const [agreements,setAgreements]=useState((terms?.agreements??[]).map((p,i)=>({...p,key:i})));
  const [bills,setBills]=useState((terms?.additionalBills??[]).map((b,i)=>({...b,key:i,agreements:b.agreements.map((p,j)=>({...p,key:j}))})));
  const [billKey,setBillKey]=useState(bills.length);
  const [nextKey,setNextKey]=useState(agreements.length);
  const [result,setResult]=useState<Projection|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[savedMessage,setSavedMessage]=useState("");
  const fmt=(minor:number|undefined)=>minor===undefined?"":minorToInput(minor,currency);
  function invalidate(){setResult(null);setSavedMessage("");setError("");}
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();const values=new FormData(e.currentTarget);
    const save=((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)?.value==="save";
    const field=(name:string)=>String(values.get(name)??"");
    const amount=(name:string)=>parseAmount(field(name),currency);
    setBusy(true);invalidate();
    try {
      const plan:CatchUpTerms={name:field("name"),asOf:field("asOf"),days:Number(field("days")),pastDueMinor:amount("pastDue"),bufferMinor:amount("buffer"),essentialsPerPayMinor:amount("essentials"),
        additionalBills:bills.map(b=>{
          const prefix="bill"+b.key+"-";
          const regularDate=field(prefix+"regularDate"), regularAmount=field(prefix+"regularAmount");
          if(Boolean(regularDate)!==Boolean(regularAmount)) throw new Error("Enter both a regular date and payment for "+field(prefix+"name"));
          return {name:field(prefix+"name"),pastDueMinor:amount(prefix+"debt"),regular:regularDate?{date:regularDate,amountMinor:amount(prefix+"regularAmount")}:null,
            agreements:b.agreements.map(p=>({date:field(prefix+"date"+p.key),amountMinor:amount(prefix+"amt"+p.key)}))};
        }), regular:regular?{date:field("regularDate"),amountMinor:amount("regularAmount")}:null,
        agreements:agreements.map(p=>({date:field("date"+p.key),amountMinor:amount("amount"+p.key)}))};
      const r=await api<Projection>(scoped(s.householdId,"/catch-up",s.spaceId),{method:"POST",body:JSON.stringify({accountId,terms:plan,version,save})});
      setResult(r);setVersion(r.version);if(save)setSavedMessage("Plan saved for this account.");
    } catch(err){setError(err instanceof Error?err.message:"Could not calculate the plan.");} finally {setBusy(false);}
  }
  return <><form className="card" onSubmit={submit} onChange={invalidate}><fieldset disabled={busy}><legend>Payment plan</legend>
    <div className="row"><Field label="Bill or creditor"><input name="name" required maxLength={100} defaultValue={terms?.name}/></Field>
    <Field label="Past-due balance"><input inputMode="decimal" name="pastDue" required defaultValue={fmt(terms?.pastDueMinor)}/></Field>
    <Field label="Plan starts"><input type="date" name="asOf" required defaultValue={terms?.asOf??todayISO()}/></Field>
    <Field label="Days to forecast"><input type="number" min={1} max={366} name="days" required defaultValue={terms?.days??90}/></Field></div>
    <div className="row"><Field label="Essentials to reserve each payday"><input inputMode="decimal" name="essentials" required defaultValue={fmt(terms?.essentialsPerPayMinor??0)}/></Field>
    <Field label="Cash buffer to keep"><input inputMode="decimal" name="buffer" required defaultValue={fmt(terms?.bufferMinor??0)}/></Field></div>
    <p>Scheduled bills and expected paychecks for this account are included automatically.</p>
    <label><input type="checkbox" checked={regular} onChange={e=>setRegular(e.target.checked)}/> Include a regular bill payment missing from the schedule</label>
    {regular && <div className="row"><Field label="Regular due date"><input type="date" name="regularDate" required defaultValue={terms?.regular?.date}/></Field><Field label="Regular payment"><input inputMode="decimal" name="regularAmount" required defaultValue={fmt(terms?.regular?.amountMinor)}/></Field></div>}
    <h3>Agreed catch-up payments</h3><p>Enter installments promised to the creditor that are separate from scheduled bills.</p>
    {agreements.map((p,i)=><div className="row" key={p.key}><Field label={"Installment "+(i+1)+" date"}><input required type="date" name={"date"+p.key} defaultValue={p.date}/></Field><Field label="Amount"><input required inputMode="decimal" name={"amount"+p.key} defaultValue={p.amountMinor?fmt(p.amountMinor):""}/></Field>
    <button type="button" className="btn-quiet" onClick={()=>{invalidate();setAgreements(agreements.filter(a=>a.key!==p.key));}}>Remove</button></div>)}
    <button type="button" className="btn-secondary" onClick={()=>{invalidate();setAgreements([...agreements,{key:nextKey,date:"",amountMinor:0}]);setNextKey(nextKey+1);}}>Add agreed installment</button>
    <h3>Other past-due bills</h3><p>Promised payments take priority. Extra money goes to bills in the order shown. The cash buffer and essentials are reserved once.</p>
    {bills.map((b,index)=>{const prefix="bill"+b.key+"-";return <fieldset key={b.key}><legend>Bill {index+2}</legend>
      <Field label="Creditor"><input required name={prefix+"name"} defaultValue={b.name}/></Field><Field label="Past due"><input required name={prefix+"debt"} inputMode="decimal" defaultValue={b.pastDueMinor?fmt(b.pastDueMinor):""}/></Field>
      <Field label="Additional regular due date"><input type="date" name={prefix+"regularDate"} defaultValue={b.regular?.date}/></Field><Field label="Additional regular payment"><input name={prefix+"regularAmount"} defaultValue={fmt(b.regular?.amountMinor)}/></Field>
      {b.agreements.map(p=><div className="row" key={p.key}><Field label="Promised date"><input type="date" name={prefix+"date"+p.key} required defaultValue={p.date}/></Field><Field label="Promised amount"><input name={prefix+"amt"+p.key} required defaultValue={p.amountMinor?fmt(p.amountMinor):""}/></Field><button type="button" onClick={()=>{invalidate();setBills(bills.map(row=>row===b?{...b,agreements:b.agreements.filter(a=>a!==p)}:row));}}>Remove installment</button></div>)}
      <button type="button" onClick={()=>{invalidate();setBills(bills.map(row=>row===b?{...b,agreements:[...b.agreements,{key:Math.max(-1,...b.agreements.map(a=>a.key))+1,date:"",amountMinor:0}]}:row));}}>Add installment for this bill</button>
      <button type="button" onClick={()=>{invalidate();setBills(bills.filter(row=>row!==b));}}>Remove bill</button></fieldset>;})}
    <button type="button" onClick={()=>{invalidate();setBills([...bills,{key:billKey,name:"",pastDueMinor:0,regular:null,agreements:[]}]);setBillKey(billKey+1);}}>Add another past-due bill</button>
    <div className="row"><button className="btn" type="submit" disabled={s.offline}>Calculate plan</button>{access.canWrite && <button className="btn-secondary" type="submit" value="save" disabled={s.offline}>Save and calculate</button>}</div>
  </fieldset></form>
  {error && <ErrorNote message={error}/>} {savedMessage && <p role="status">{savedMessage}</p>}
  {result && <section className="card" aria-live="polite"><h2>Paycheck projection</h2>
    <p>Starting balance <Money minor={result.startingMinor}/> · Lowest projected balance <Money minor={result.lowestMinor}/> on {result.lowestDate}.</p>
    {result.firstShortfall && <Notice kind="bad">The planned payments would put this account below zero on {result.firstShortfall}.</Notice>}
    <p>{result.payoffDate?"Projected catch-up date "+result.payoffDate:"No funded payoff date in this forecast."} Remaining after planned payments through {result.end}: <Money minor={result.remainingMinor}/>.</p>
    {result.creditors.map((b,i)=><p key={i}><strong>{b.name}</strong> · Extra payments <Money minor={b.extraMinor}/> · Remaining after planned payments <Money minor={b.remainingMinor}/>{b.firstUnfundedDate && <> · Unfunded <Money minor={b.unfundedMinor}/> starting {b.firstUnfundedDate}</>}</p>)}
    {!result.rows.some(r=>r.payMinor) && <Notice>No expected paychecks for this account within these dates.</Notice>}
    <div className="table-wrap"><table><thead><tr>{["Date","Expected pay","Bills","Essentials","Agreed","Extra catch-up","Account balance","Past due left"].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>
    {result.rows.map(r=><tr key={r.date}><td>{r.date}{r.payments.map((p,i)=><small key={i}>{p.name} · <Money minor={p.agreed+p.extra}/></small>)}</td>{[r.payMinor,r.billsMinor,r.essentialsMinor,r.agreedMinor,r.extraMinor,r.balanceMinor,r.remainingMinor].map((v,i)=><td key={i}><Money minor={v}/></td>)}</tr>)}</tbody></table></div>
    <p className="muted">Extra payments use expected income and reserve the expenses entered through {result.end}. Saving a plan does not send payments.</p>
  </section>}</>;
}
