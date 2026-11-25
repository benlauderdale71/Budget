import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { StatementCoverage as Coverage } from "@budgetcents/domain";
import { api } from "../api.js";
import { monthLabel, parseAmount, todayISO } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";

type CoverageAccount = Coverage["accounts"][number];

export function StatementCoverage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const year = params.get("year") || todayISO().slice(0,4);
  const selected = params.get("accountId") || "";
  const url = scoped(session.householdId,"/statement-coverage?year="+encodeURIComponent(year),session.spaceId);
  const result = useLoad(async () => ({url, coverage:await api<Coverage>(url)}),[url, session.tick]);
  const data = result.data?.url === url ? result.data.coverage : undefined;
  const accounts = data?.accounts.filter(a=>!selected || a.accountId===selected) ?? [];
  function change(key:string, value:string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key,value); else next.delete(key);
    setParams(next);
  }
  return <Page title="Statement coverage" lede="Compare each account’s posted ledger with the dates and closing balance on your statement.">
    <div className="row"><form className="row" key={year} onSubmit={e=>{e.preventDefault();change("year",String(new FormData(e.currentTarget).get("year")));}}>
      <Field label="Year"><input type="number" name="year" min="1900" max="2200" defaultValue={year} required/></Field><button className="btn-secondary">Show year</button>
    </form><Field label="Account"><select value={selected} onChange={e=>change("accountId",e.target.value)}><option value="">All accounts</option>{data?.accounts.map(a=><option key={a.accountId} value={a.accountId}>{a.name}</option>)}</select></Field></div>
    {result.error && <ErrorNote message={result.error} onRetry={session.bump}/>}
    {!data && result.loading && <Loading label="Loading statement coverage"/>}
    {data && !accounts.length && <Notice>No matching accounts in this space.</Notice>}
    {accounts.map(account=><AccountCoverage key={[url,account.accountId].join("/")} account={account} year={year}/>)}
    <Link to={"/spending?from="+year+"-01-01&to="+year+"-12-31"+(selected?"&accountId="+encodeURIComponent(selected):"")}>See yearly spending</Link>
  </Page>;
}

function AccountCoverage({account,year}:{account:CoverageAccount;year:string}) {
  const session=useSession(), access=useAccess();
  const [error,setError]=useState(""), [message,setMessage]=useState(""), [busy,setBusy]=useState(false);
  const canRecord=access.canWrite && !session.offline && !session.user?.privacyMode;
  return <section className="card"><h2>{account.name}</h2>
    <p>{account.months.filter(m=>m.status==="Reconciled").length} of 12 months reconciled · {account.currency}</p>
    <div className="annual-month-grid">{account.months.map(m=><article key={m.month}><h4>{monthLabel(m.month)}</h4><strong>{m.status}</strong><small>{m.imported} imported transaction{m.imported===1?"":"s"}</small>{(m.imported>0 || m.status==="Partial" || m.status==="Balance mismatch") && <details><summary>Dates and gaps</summary>{m.firstImport && <p>Imports dated {m.firstImport} through {m.lastImport}.</p>}{m.gaps.map(g=><p key={g.start}>Missing statement coverage {g.start} through {g.end}.</p>)}</details>}</article>)}</div>
    {account.statements.length>0 && <div className="table-wrap"><table><caption>Statement balances compared with posted balances</caption><thead><tr><th>Starts</th><th>Ends</th><th>Closing balance</th><th>Difference</th><th>Posted ledger activity</th><th>Statement activity</th></tr></thead><tbody>{account.statements.map(p=><tr key={p.end}><td>{p.start}</td><td>{p.end}</td><td><Money minor={p.closingMinor} currency={account.currency}/></td><td><Money minor={p.differenceMinor} currency={account.currency}/></td><td><Money minor={p.ledgerDeposits} currency={account.currency}/> in · <Money minor={p.ledgerWithdrawals} currency={account.currency}/> out · {p.ledgerCount} transactions</td><td>{p.depositsMinor!=null && <Money minor={p.depositsMinor} currency={account.currency}/>} in · {p.withdrawalsMinor!=null && <Money minor={p.withdrawalsMinor} currency={account.currency}/>} out · {p.transactionCount??"—"} transactions</td></tr>)}</tbody></table></div>}
    {canRecord && <details><summary>Account opening and closing dates</summary><form key={JSON.stringify(account.lifetime)} onSubmit={async e=>{
      e.preventDefault();const v=new FormData(e.currentTarget);setBusy(true);setError("");
      try {await api(scoped(session.householdId,"/account-lifetime",session.spaceId),{method:"POST",body:JSON.stringify({accountId:account.accountId,
        opened:v.get("opened")||null,closed:v.get("closed")||null,previous:account.lifetime})});session.bump();setMessage("Account dates saved.");}
      catch(err){setError(err instanceof Error?err.message:"Could not save account dates.");}finally{setBusy(false);}
    }}><Field label="Account opened"><input type="date" name="opened" defaultValue={account.lifetime.opened??""}/></Field><Field label="Account closed"><input type="date" name="closed" defaultValue={account.lifetime.closed??""}/></Field><button disabled={busy}>Save dates</button></form></details>}
    {canRecord && <details><summary>Record or update a statement</summary><form className="row" onSubmit={async e=>{
      e.preventDefault(); const values=new FormData(e.currentTarget), end=String(values.get("end"));
      const previous=account.statements.find(p=>p.end===end);
      setError("");setMessage("");setBusy(true);
      try {
        await api(scoped(session.householdId,"/statement-coverage",session.spaceId),{method:"POST",body:JSON.stringify({
          accountId:account.accountId,start:String(values.get("start")),end,closingMinor:parseAmount(String(values.get("closing")),account.currency),
          depositsMinor:values.get("credits") ? parseAmount(String(values.get("credits")),account.currency) : previous?.depositsMinor??null,
          withdrawalsMinor:values.get("debits") ? parseAmount(String(values.get("debits")),account.currency) : previous?.withdrawalsMinor??null,
          transactionCount:values.get("count") ? Number(values.get("count")) : previous?.transactionCount??null, previous:previous??null
        })}); setMessage("Statement saved.");session.bump();
      } catch(e){setError(e instanceof Error?e.message:"Could not save the statement.");} finally {setBusy(false);}
    }}>
      <Field label="Statement starts"><input name="start" type="date" required/></Field>
      <Field label="Statement ends"><input name="end" type="date" min={year+"-01-01"} max={todayISO()<year+"-12-31"?todayISO():year+"-12-31"} required/></Field>
      <Field label={"Closing balance ("+account.currency+")"}><input name="closing" inputMode="decimal" required/></Field>
      <Field label="Statement credits / deposits"><input name="credits" inputMode="decimal"/></Field>
      <Field label="Statement debits / withdrawals"><input name="debits" inputMode="decimal"/></Field>
      <Field label="Posted transaction count (optional)"><input name="count" type="number" min="0"/></Field>
      <p>Enter both activity totals, including zero, to verify the period. A closing balance alone records a balance check. Blank activity fields keep existing evidence when updating a statement.</p>
      <button className="btn-secondary" disabled={busy}>Save statement</button>
    </form><p className="muted">Use the amount owed for a credit card. A statement with the same ending date replaces the previously recorded balance.</p></details>}
    {error && <ErrorNote message={error}/>} {message && <p role="status">{message}</p>}
  </section>;
}
