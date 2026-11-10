import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Account, Dashboard, Txn } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

export function Activity() {
  const session = useSession();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  const query = params.get("q") ?? "";
  const dash = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const list = useLoad(() => api<{ total: number; transactions: Txn[] }>(scoped(session.householdId, `/transactions?limit=80${query ? `&q=${encodeURIComponent(query)}` : ""}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, query]);
  if ((dash.loading || list.loading) && !list.data) return <Loading label="Loading activity" />;
  if (!dash.data || !list.data) return <ErrorNote message={dash.error || list.error || "Could not load activity"} onRetry={session.bump} />;
  const names = new Map(dash.data.accounts.map((account) => [account.id, account.name]));
  return (
    <Page title="Activity" lede={query ? `Matches for “${query}”.` : "Splits, refunds, and transfers stay attached to the original money."} actions={<button className="btn" onClick={() => setOpen(true)}>Add</button>}>
      <p className="muted">{list.data.total} in this view</p>
      {list.data.transactions.length === 0 ? <p className="muted">No transactions match.</p> : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Date</th><th>Payee</th><th>Account</th><th>Review</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {list.data.transactions.map((txn) => (
                <tr key={txn.id}>
                  <td>{txn.date}</td>
                  <td>{txn.payee}{txn.notes ? <div className="muted">{txn.notes}</div> : null}</td>
                  <td>{names.get(txn.accountId) ?? "Account"}</td>
                  <td>{txn.reviewStatus === "needs_review" ? "Needs review" : txn.reconciled ? "Reconciled" : "Reviewed"}</td>
                  <td className="num"><Money minor={txn.amountMinor} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? <TxnForm accounts={dash.data.accounts} buckets={dash.data.buckets} currency={dash.data.household.currency} spaceId={dash.data.spaceId} onClose={() => setOpen(false)} /> : null}
    </Page>
  );
}

function TxnForm({ accounts, buckets, currency, spaceId, onClose }: { accounts: Account[]; buckets: Dashboard["buckets"]; currency: string; spaceId: string; onClose: () => void }) {
  const session = useSession();
  const form = useFormError();
  const [type, setType] = useState("expense");
  const [splits, setSplits] = useState([{ bucketId: "", amount: "" }]);
  const spendBuckets = buckets.filter((bucket) => !bucket.systemRole && bucket.kind === (type === "income" ? "income" : "expense"));
  return (
    <Modal title="New transaction" onClose={onClose}>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const magnitude = Math.abs(parseAmount(String(data.get("amount")), currency));
        const signed = type === "income" || type === "refund" ? magnitude : -magnitude;
        const splitRows = splits.filter((split) => split.bucketId && split.amount).map((split) => ({
          bucketId: split.bucketId, amountMinor: Math.abs(parseAmount(split.amount, currency)), role: type === "income" ? "income" : type === "refund" ? "refund" : "expense",
        }));
        const created = await api<{ id: string }>(scoped(session.householdId, "/transactions"), { method: "POST", body: JSON.stringify({
          spaceId, date: data.get("date"), accountId: data.get("accountId"), counterAccountId: data.get("counterAccountId") || undefined,
          amountMinor: signed, type, payee: data.get("payee"), notes: data.get("notes") || undefined,
          tags: String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
          splits: splitRows, bankStatus: "posted", categoryLocked: true,
        }) });
        const file = (data.get("receipt") as File | null);
        if (file && file.size) {
          const body = new FormData();
          body.set("file", file);
          body.set("transactionId", created.id);
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
        <Field label="Date"><input name="date" type="date" required defaultValue={todayISO()} /></Field>
        <Field label="Payee"><input name="payee" required /></Field>
        <Field label="Amount"><input name="amount" required inputMode="decimal" /></Field>
        <Field label="Account"><select name="accountId" required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
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
        <Field label="Tags"><input name="tags" placeholder="trip, reimbursable" /></Field>
        <Field label="Note"><textarea name="notes" /></Field>
        <Field label="Receipt (JPEG, PNG, or PDF)"><input name="receipt" type="file" accept="image/jpeg,image/png,application/pdf" /></Field>
        <p className="muted">Receipt text is not read automatically. Confirm the merchant and total yourself. A reconciled transaction is not overwritten.</p>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save</button>
      </form>
    </Modal>
  );
}
