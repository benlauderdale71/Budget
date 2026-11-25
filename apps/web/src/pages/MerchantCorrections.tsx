import { useState } from "react";
import { api } from "../api.js";
import { scoped, useSession } from "../session.js";
import type { Bucket, Txn } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, useLoad } from "../ui.js";

type Preview={token:string;rows:{id:string;date:string;payee:string;amountMinor:number;priorBucket:string|null}[]};
type Batch={id:string;merchant_key:string;bucket_id:string;account_id:string;count:number;future:number;created_at:string};

export function MerchantCorrections({source,buckets,accounts,onClose}:{source:Txn|null;buckets:Bucket[];accounts:Map<string,string>;onClose:()=>void}) {
  const s=useSession(), url=scoped(s.householdId,"/merchant-corrections",s.spaceId);
  const candidates=buckets.filter(b=>!b.systemRole && !b.hidden && !b.archived && b.kind===(source && source.amountMinor>0?"income":"expense"));
  const [category,setCategory]=useState(source?.splits[0]?.bucketId??""),[future,setFuture]=useState(true);
  const [preview,setPreview]=useState<Preview|null>(null),[message,setMessage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const history=useLoad(()=>api<{batches:Batch[]}>(url),[url,s.tick]);
  function bucketName(id:string|null){return buckets.find(b=>b.id===id)?.name??"Uncategorized";}
  async function run(fn:()=>Promise<void>){setBusy(true);setError("");setMessage("");try{await fn();}catch(e){setError(e instanceof Error?e.message:"Could not update corrections.");setPreview(null);}finally{setBusy(false);}}
  const payload={sourceId:source?.id,bucketId:category,future};
  return <Modal title={source?"Correct similar transactions":"Merchant correction history"} onClose={onClose}>
    {source && <><p><strong>{source.payee}</strong> · {accounts.get(source.accountId)} · {source.date}</p>
    <p>The preview includes this transaction and matching unverified entries in the same account. Store purchases and fuel purchases are matched separately.</p>
    <fieldset disabled={busy}><Field label="Use category"><select value={category} onChange={e=>{setCategory(e.target.value);setPreview(null);}}><option value="">Choose a category</option>{candidates.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
    <label><input type="checkbox" checked={future} onChange={e=>{setFuture(e.target.checked);setPreview(null);}}/> Apply to future matching imports</label>
    <button className="btn-secondary" disabled={!category || s.offline} onClick={()=>run(async()=>setPreview(await api<Preview>(url,{method:"POST",body:JSON.stringify(payload)})))}>Preview matches</button></fieldset>
    {preview && <><h3>{preview.rows.length} existing transaction{preview.rows.length===1?"":"s"} would change</h3>
      <div className="table-wrap" style={{maxHeight:320,overflow:"auto"}}><table><thead><tr><th>Date</th><th>Payee</th><th>Amount</th><th>Current category</th></tr></thead><tbody>{preview.rows.map(r=><tr key={r.id}><td>{r.date}</td><td>{r.payee}</td><td><Money minor={r.amountMinor} currency={source.currency}/></td><td>{bucketName(r.priorBucket)}</td></tr>)}</tbody></table></div>
      <p>New category: {bucketName(category)}. Future matching imports: {future?"included":"excluded"}.</p>
      <button className="btn" disabled={busy || s.offline || (!preview.rows.length && !future)} onClick={()=>run(async()=>{
        const result=await api<{applied?:number}>(url,{method:"POST",body:JSON.stringify({...payload,confirm:preview.token})});
        setMessage(result.applied===undefined?"Correction already applied.":"Changed "+result.applied+" existing transactions."+(future?" Future import rule saved.":""));setPreview(null);s.bump();
      })}>Apply correction</button></>}</>}
    {error && <ErrorNote message={error}/>} {message && <p role="status">{message}</p>}
    <h3>Your active corrections</h3>
    {history.error && <ErrorNote message={history.error} onRetry={s.bump}/>} {!history.data && history.loading && <Loading label="Loading corrections"/>}
    {history.data?.batches.length===0 && <p>No active corrections.</p>}
    {history.data?.batches.map(b=><article className="card" key={b.id}><strong>{b.merchant_key.split("|").slice(1).join(" · ")} → {bucketName(b.bucket_id)}</strong>
    <p>{accounts.get(b.account_id)} · {b.created_at.slice(0,10)} · {b.count} transactions · {b.future?"Includes future imports":"Past transactions only"}</p>
    <button className="btn-secondary" disabled={busy || s.offline} onClick={()=>run(async()=>{
      const r=await api<{restored:number;skipped:number}>(scoped(s.householdId,"/merchant-corrections/"+encodeURIComponent(b.id)+"/undo",s.spaceId),{method:"POST"});
      setMessage("Undid correction. Restored "+r.restored+" transactions. Preserved "+r.skipped+" later edits or locks.");setPreview(null);s.bump();
    })}>Undo this batch</button></article>)}
  </Modal>;
}
