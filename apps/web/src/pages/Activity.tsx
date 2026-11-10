import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Account, Dashboard, Txn } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

export function Activity() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [limit, setLimit] = useState(50);
  const [matchId, setMatchId] = useState("");
  const [note, setNote] = useState("");
  const query = params.get("q") ?? "";
  const review = params.get("review") ?? "";
  const accountId = params.get("accountId") ?? "";
  const dash = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const views = useLoad(() => api<{ views: { id: string; name: string; query: Record<string, string> }[] }>(scoped(session.householdId, "/views")), [session.householdId, session.tick]);
  const list = useLoad(() => api<{ total: number; transactions: Txn[]; nextOffset: number | null }>(scoped(session.householdId, `/transactions?limit=${limit}&offset=0${query ? `&q=${encodeURIComponent(query)}` : ""}${review ? `&review=${encodeURIComponent(review)}` : ""}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, query, review, accountId, limit]);
  if ((dash.loading || list.loading) && !list.data) return <Loading label="Loading activity" />;
  if (!dash.data || !list.data) return <ErrorNote message={dash.error || list.error || "Could not load activity"} onRetry={session.bump} />;
  const names = new Map(dash.data.accounts.map((account) => [account.id, account.name]));
  const visible = list.data.transactions;
  return (
    <Page title="Activity" lede={query ? `Matches for “${query}”.` : review === "needs_review" ? "These still need a person to confirm the category." : "Splits, refunds, and transfers stay attached to the original money."} actions={<button className="btn" onClick={() => { setEditing(null); setOpen(true); }}>Add</button>}>
      <div className="row">
        <label className="field">Account
          <select value={accountId} onChange={(event) => { setLimit(50); const next = new URLSearchParams(params); if (event.target.value) next.set("accountId", event.target.value); else next.delete("accountId"); setParams(next); }}>
            <option value="">All accounts</option>
            {dash.data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <button className="btn-secondary" onClick={async () => {
          const name = window.prompt("Name this view");
          if (!name) return;
          await api(scoped(session.householdId, "/views"), { method: "POST", body: JSON.stringify({ name, query: { q: query, review, accountId } }) });
          session.bump();
        }}>Save this view</button>
        {views.data?.views.map((view) => (
          <button key={view.id} className="chip" onClick={() => { setLimit(50); setParams(new URLSearchParams(Object.entries(view.query).filter(([, value]) => value))); }}>{view.name}</button>
        ))}
      </div>
      <p className="muted">{list.data?.total ?? visible.length} in this view. Showing {visible.length}.</p>
      {note ? <Notice>{note}</Notice> : null}
      {visible.length === 0 ? <p className="muted">No transactions match.</p> : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Date</th><th>Payee</th><th>Account</th><th>Review</th><th className="num">Amount</th><th></th></tr></thead>
            <tbody>
              {visible.map((txn) => (
                <tr key={txn.id}>
                  <td>{txn.date}</td>
                  <td>{txn.payee}{txn.notes ? <div className="muted">{txn.notes}</div> : null}{txn.matchedArchivedId ? <div className="muted">Matched. The other copy is hidden.</div> : null}</td>
                  <td>{names.get(txn.accountId) ?? "Account"}</td>
                  <td>{txn.reviewStatus === "needs_review" ? "Needs review" : txn.reconciled ? "Reconciled" : "Reviewed"}</td>
                  <td className="num"><Money minor={txn.amountMinor} /></td>
                  <td>
                    <button className="btn-quiet" onClick={() => { setEditing(txn); setOpen(true); }}>Edit</button>
                    <button className="btn-quiet" onClick={async () => {
                      await api(scoped(session.householdId, `/transactions/${txn.id}/duplicate`), { method: "POST" });
                      setNote("A copy was added and marked for review. The original was not changed.");
                      session.bump();
                    }}>Duplicate</button>
                    <button className="btn-quiet" onClick={() => setMatchId(matchId === txn.id ? "" : txn.id)}>{matchId === txn.id ? "Selected to match" : "Match"}</button>
                    {matchId && matchId !== txn.id ? <button className="btn-quiet" onClick={async () => {
                      await api(scoped(session.householdId, `/transactions/${matchId}/match`), { method: "POST", body: JSON.stringify({ otherId: txn.id }) });
                      setMatchId(""); setNote("Matched. Notes stayed on the first transaction, and the second copy is no longer in the totals."); session.bump();
                    }}>Match with selected</button> : null}
                    {txn.matchedArchivedId ? <button className="btn-quiet" onClick={async () => {
                      await api(scoped(session.householdId, `/transactions/${txn.id}/unmatch`), { method: "POST" });
                      setNote("The hidden record is back in the register."); session.bump();
                    }}>Unmatch</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data.nextOffset != null ? <button className="btn-secondary" onClick={() => setLimit((current) => Math.min(200, current + 50))}>Load more</button> : null}
      {open ? <TxnForm accounts={dash.data.accounts} buckets={dash.data.buckets} currency={dash.data.household.currency} spaceId={dash.data.spaceId} existing={editing} onClose={() => { setOpen(false); setEditing(null); }} /> : null}
    </Page>
  );
}

function TxnForm({ accounts, buckets, currency, spaceId, existing, onClose }: { accounts: Account[]; buckets: Dashboard["buckets"]; currency: string; spaceId: string; existing: Txn | null; onClose: () => void }) {
  const session = useSession();
  const form = useFormError();
  const [type, setType] = useState(existing?.type ?? "expense");
  const [splits, setSplits] = useState(existing?.splits.length ? existing.splits.map((split) => ({ bucketId: split.bucketId ?? "", amount: (split.amountMinor / 100).toFixed(2) })) : [{ bucketId: "", amount: "" }]);
  const spendBuckets = buckets.filter((bucket) => !bucket.systemRole && bucket.kind === (type === "income" ? "income" : "expense"));
  return (
    <Modal title={existing ? "Edit transaction" : "New transaction"} onClose={onClose}>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const magnitude = Math.abs(parseAmount(String(data.get("amount")), currency));
        const signed = type === "income" || type === "refund" ? magnitude : -magnitude;
        const splitRows = splits.filter((split) => split.amount).map((split) => ({
          bucketId: split.bucketId || null, amountMinor: Math.abs(parseAmount(split.amount, currency)), role: type === "income" ? "income" as const : type === "refund" ? "refund" as const : "expense" as const,
        }));
        if (splitRows.length) {
          const sum = splitRows.reduce((total, split) => total + split.amountMinor, 0);
          if (sum !== magnitude) throw new Error("Split amounts have to add up to the transaction total. Nothing was saved.");
        }
        const payload = {
          spaceId, date: data.get("date"), accountId: data.get("accountId"), counterAccountId: data.get("counterAccountId") || undefined,
          amountMinor: signed, type, payee: data.get("payee"), notes: data.get("notes") || undefined,
          tags: String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
          splits: splitRows, bankStatus: "posted", categoryLocked: true,
          refundOfId: type === "refund" || type === "reimbursement" ? String(data.get("refundOfId") || "") || undefined : undefined,
          version: existing?.version,
          reason: data.get("reason") || undefined,
        };
        const created = existing
          ? await api<{ id?: string }>(scoped(session.householdId, `/transactions/${existing.id}`), { method: "PATCH", body: JSON.stringify(payload) }).then(() => ({ id: existing.id }))
          : await api<{ id: string }>(scoped(session.householdId, "/transactions"), { method: "POST", body: JSON.stringify(payload) });
        const file = (data.get("receipt") as File | null);
        if (file && file.size && created.id) {
          const body = new FormData();
          body.set("file", file);
          body.set("transactionId", created.id!);
          const token = localStorage.getItem("budgetcents.token");
          const response = await fetch(scoped(session.householdId, "/attachments"), { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });
          if (!response.ok) throw new Error("The transaction was saved. The receipt was not accepted.");
        }
        session.bump();
        onClose();
      })}>
        <Field label="Type"><select name="type" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="expense">Expense</option><option value="income">Income</option><option value="refund">Refund</option>
          <option value="transfer">Transfer</option><option value="cc_payment">Card payment</option>
        </select></Field>
        <Field label="Date"><input name="date" type="date" required defaultValue={existing?.date ?? todayISO()} /></Field>
        <Field label="Payee"><input name="payee" required defaultValue={existing?.payee ?? ""} /></Field>
        <Field label="Amount"><input name="amount" required inputMode="decimal" defaultValue={existing ? (Math.abs(existing.amountMinor) / 100).toFixed(2) : ""} /></Field>
        <Field label="Account"><select name="accountId" required defaultValue={existing?.accountId ?? ""}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        {type === "transfer" || type === "cc_payment" ? <Field label="Other account"><select name="counterAccountId" required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field> : null}
        {type !== "transfer" && type !== "cc_payment" ? (
          <fieldset>
            <legend>Splits</legend>
            {splits.map((split, index) => (
              <div className="split-row" key={index}>
                <select aria-label="Category" value={split.bucketId} onChange={(event) => setSplits(splits.map((item, itemIndex) => itemIndex === index ? { ...item, bucketId: event.target.value } : item))}>
                  <option value="">Uncategorized</option>
                  {spendBuckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}
                </select>
                <input aria-label="Split amount" value={split.amount} onChange={(event) => setSplits(splits.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} />
                <button type="button" className="btn-quiet" onClick={() => setSplits(splits.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn-secondary" onClick={() => setSplits([...splits, { bucketId: "", amount: "" }])}>Add split</button>
          </fieldset>
        ) : null}
        {type === "refund" || type === "reimbursement" ? <Field label="Refund of transaction id"><input name="refundOfId" defaultValue={existing?.refundOfId ?? ""} placeholder="The original expense id" /></Field> : null}
        <Field label="Tags"><input name="tags" placeholder="trip, reimbursable" defaultValue={existing?.tags?.join(", ") ?? ""} /></Field>
        <Field label="Note"><textarea name="notes" defaultValue={existing?.notes ?? ""} /></Field>
        {existing?.reconciled ? <Field label="Reason for changing a reconciled amount"><input name="reason" /></Field> : null}
        <Field label="Receipt (JPEG, PNG, or PDF)"><input name="receipt" type="file" accept="image/jpeg,image/png,application/pdf" /></Field>
        <p className="muted">Receipt text is not read automatically. Confirm the merchant and total yourself. A reconciled transaction is not overwritten.</p>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save</button>
      </form>
    </Modal>
  );
}
