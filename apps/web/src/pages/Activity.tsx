import { useEffect, useId, useRef, useState } from "react";
import { CsvSourceDetails, type SourceCell } from "../CsvSourceDetails.js";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { allows } from "@budgetcents/domain/access";
import { OwnershipFilter, useHouseholdPeople } from "../ownership.js";
import { parseAmount, todayISO } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import type { Account, Dashboard, Txn } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

const PAGE = 25;

export function Activity() {
  const session = useSession();
  const access = useAccess();
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const pageChanged = useRef(false);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [offset, setOffset] = useState(0);
  const [matchId, setMatchId] = useState("");
  const [commentFor, setCommentFor] = useState<Txn | null>(null);
  const [sourceFor, setSourceFor] = useState<Txn | null>(null);
  const [peopleFor, setPeopleFor] = useState<Txn | null>(null);
  const [note, setNote] = useState("");
  const [noteBad, setNoteBad] = useState(false);
  const [viewName, setViewName] = useState("");
  const [renaming, setRenaming] = useState("");
  const people = useHouseholdPeople();
  const query = params.get("q") ?? "";
  const review = params.get("review") ?? "";
  const accountId = params.get("accountId") ?? "";
  const bucketId = params.get("bucketId") ?? "";
  const tag = params.get("tag") ?? "";
  const ids = params.get("ids") ?? "";
  const sort = params.get("sort") === "payee" ? "payee" : "date";
  const ownership = params.get("ownership") ?? "all";
  const personId = params.get("personId") ?? "";
  const reviewer = params.get("reviewer") ?? "";
  const collaborationQuery = new URLSearchParams({ ownership, ...(personId ? { personId } : {}), ...(reviewer ? { reviewer } : {}) }).toString();
  useEffect(() => { setOffset(0); }, [query, review, accountId, bucketId, tag, ids, sort, ownership, personId, reviewer]);
  useEffect(() => {
    if (!pageChanged.current) return;
    summaryRef.current?.focus();
  }, [offset]);
  const dash = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const views = useLoad(() => api<{ views: { id: string; name: string; query: Record<string, string> }[] }>(scoped(session.householdId, "/views")), [session.householdId, session.tick]);
  const list = useLoad(() => api<{ total: number; offset: number; transactions: Txn[]; nextOffset: number | null }>(scoped(session.householdId, `/transactions?${collaborationQuery}&limit=${PAGE}&offset=${offset}&sort=${sort}${query ? `&q=${encodeURIComponent(query)}` : ""}${review ? `&review=${encodeURIComponent(review)}` : ""}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}${bucketId ? `&bucketId=${encodeURIComponent(bucketId)}` : ""}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}${ids ? `&ids=${encodeURIComponent(ids)}` : ""}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, query, review, accountId, bucketId, tag, ids, sort, offset, collaborationQuery]);
  const purchases = useLoad(() => api<{ transactions: Txn[] }>(scoped(session.householdId, "/transactions?limit=200", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  if ((dash.loading || list.loading) && !list.data) return <Loading label="Loading activity" />;
  if (!dash.data || !list.data) return <ErrorNote message={dash.error || list.error || "Could not load activity"} onRetry={session.bump} />;
  const names = new Map(dash.data.accounts.map((account) => [account.id, account.name]));
  const payees = new Map((purchases.data?.transactions ?? list.data.transactions).map((txn) => [txn.id, txn.payee]));
  const visible = list.data.transactions;
  const currentQuery = { q: query, review, accountId, bucketId, tag, ids, sort, ownership, personId, reviewer };
  const personNames = new Map((people.data?.people ?? []).map((person) => [person.id, person.displayName]));
  function replaceFilters(next: URLSearchParams) {
    setOffset(0);
    setParams(next);
  }
  async function act(label: string, run: () => Promise<void>) {
    try {
      await run();
      setNoteBad(false);
      setNote(label);
      session.bump();
    } catch (caught) {
      setNoteBad(true);
      setNote(caught instanceof Error ? caught.message : "That change was not saved.");
    }
  }
  return (
    <Page title="Activity" lede={ids ? "These are the transactions behind that report row. The total on the report is their spending after refunds, not a second copy of the money." : query ? `Matches for “${query}”.` : review === "needs_review" ? "These still need a person to confirm the category." : "Splits, refunds, and transfers stay attached to the original money."} actions={<button className="btn" type="button" disabled={!access.canWrite} onClick={() => { setEditing(null); setOpen(true); }}>Add</button>}>
      {ids ? <p><button className="btn-quiet" type="button" onClick={() => { const next = new URLSearchParams(params); next.delete("ids"); replaceFilters(next); }}>Show the whole register</button></p> : null}
      <div className="row">
        <OwnershipFilter people={people.data?.people ?? []} />
        <label className="field">Review queue
          <select aria-label="Review queue" value={reviewer} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) { next.set("reviewer", event.target.value); next.set("review", "needs_review"); } else { next.delete("reviewer"); next.delete("review"); } replaceFilters(next); }}>
            <option value="">All reviews</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned reviews</option>
          </select>
        </label>
        <label className="field">Account
          <select value={accountId} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set("accountId", event.target.value); else next.delete("accountId"); replaceFilters(next); }}>
            <option value="">All accounts</option>
            {dash.data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <label className="field">Sort
          <select value={sort} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value === "payee") next.set("sort", "payee"); else next.delete("sort"); replaceFilters(next); }}>
            <option value="date">Date</option>
            <option value="payee">Payee</option>
          </select>
        </label>
        <label className="field">View name
          <input name="viewName" value={viewName} onChange={(event) => setViewName(event.target.value)} />
        </label>
        <button className="btn-secondary" onClick={() => act("Saved this view for your sign-in.", async () => {
          if (!viewName.trim()) throw new Error("Name the view.");
          await api(scoped(session.householdId, "/views"), { method: "POST", body: JSON.stringify({ name: viewName.trim(), query: currentQuery }) });
          setViewName("");
        })}>Save this view</button>
      </div>
      <div className="row">
        {views.data?.views.map((view) => (
          <span key={view.id} className="chip">
            <button type="button" onClick={() => { setOffset(0); setParams(new URLSearchParams(Object.entries(view.query).filter(([, value]) => value))); }}>{view.name}</button>
            <button type="button" aria-label={`Rename ${view.name}`} onClick={() => setRenaming(renaming === view.id ? "" : view.id)}>Rename</button>
            <button type="button" aria-label={`Delete ${view.name}`} onClick={() => act("Deleted that view.", () => api(scoped(session.householdId, `/views/${view.id}`), { method: "DELETE" }).then(() => undefined))}>Delete</button>
            {renaming === view.id ? (
              <form onSubmit={(event) => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name") || ""); void act("Renamed that view.", async () => { await api(scoped(session.householdId, `/views/${view.id}`), { method: "PATCH", body: JSON.stringify({ name, query: view.query }) }); setRenaming(""); }); }}>
                <input name="name" defaultValue={view.name} aria-label="New view name" />
                <button type="submit">Save name</button>
              </form>
            ) : null}
          </span>
        ))}
      </div>
      <p className="muted" ref={summaryRef} tabIndex={-1}>{list.loading ? "Loading this view." : list.error ? "This view could not be loaded." : <>{list.data.total} in this view. Showing {visible.length === 0 ? "0" : `${(list.data.offset ?? offset) + 1}–${(list.data.offset ?? offset) + visible.length}`}.</>}</p>
      {note ? <Notice kind={noteBad ? "bad" : "ok"}>{note}</Notice> : null}
      {list.loading ? <Loading label="Loading this activity view" /> : list.error ? <ErrorNote message={list.error} onRetry={session.bump} /> : visible.length === 0 ? <p className="muted">No transactions match.</p> : (
        <div className="card table-wrap">
          <table className="activity-register">
            <caption>Transactions in this view</caption>
            <thead><tr><th>Date</th><th>Payee</th><th>Account</th><th>Review</th><th className="num">Amount</th><th>Actions</th></tr></thead>
            <tbody>
              {visible.map((txn) => (
                <tr key={txn.id}>
                  <td data-label="Date">{txn.date}</td>
                  <td data-label="Payee">
                    {txn.payee}
                    {txn.notes ? <div className="muted">{txn.notes}</div> : null}
                    {txn.tags?.length ? <div className="muted">Tags {txn.tags.join(", ")}</div> : null}
                    {txn.providerTransactionId ? <div className="muted">Bank id {txn.providerTransactionId}</div> : null}
                    {txn.attachmentCount ? <div className="muted">Receipt attached</div> : null}
                    {txn.refundOfId ? <div className="muted">Refund of {payees.get(txn.refundOfId) ?? "a purchase"}</div> : null}
                    {txn.matchedArchivedId ? <div className="muted">Matched. The other copy is hidden.</div> : null}
                  </td>
                  <td data-label="Account">{names.get(txn.accountId) ?? "Account"}</td>
                  <td data-label="Review">{txn.reviewStatus === "needs_review" ? "Needs review" : txn.reconciled ? "Reconciled" : "Reviewed"}
                    <div className="muted">Owner: {txn.ownerUserId ? personNames.get(txn.ownerUserId) ?? "Former member" : "Ours"}</div>
                    {txn.reviewerUserId ? <div className="muted">Reviewer: {personNames.get(txn.reviewerUserId) ?? "Former member"}</div> : null}
                    {txn.reviewResolvedAt ? <div className="muted">Resolved by {personNames.get(txn.reviewResolvedBy ?? "") ?? "Former member"} on {txn.reviewResolvedAt.slice(0, 10)}</div> : null}
                  </td>
                  <td className="num" data-label="Amount"><Money minor={txn.amountMinor} /></td>
                  <td data-label="Actions">
                    <button className="btn-quiet" type="button" disabled={!access.canWrite} aria-label={`Edit ${txn.payee} on ${txn.date}`} onClick={() => { setEditing(txn); setOpen(true); }}>Edit</button>
                    <button className="btn-quiet" type="button" disabled={!access.canWrite} aria-label={`Duplicate ${txn.payee} on ${txn.date}`} onClick={() => act("A copy was added and marked for review. The original was not changed, and its bank id was not copied.", () => api(scoped(session.householdId, `/transactions/${txn.id}/duplicate`), { method: "POST" }).then(() => undefined))}>Duplicate</button>
                    <button className="btn-quiet" type="button" disabled={!access.canWrite} aria-pressed={matchId === txn.id} aria-label={matchId === txn.id ? `${txn.payee} on ${txn.date} is selected to match` : `Match ${txn.payee} on ${txn.date}`} onClick={() => setMatchId(matchId === txn.id ? "" : txn.id)}>{matchId === txn.id ? "Selected to match" : "Match"}</button>
                    {matchId && matchId !== txn.id ? <button className="btn-quiet" type="button" disabled={!access.canWrite} aria-label={`Match ${txn.payee} on ${txn.date} with the selected transaction`} onClick={() => act("Matched. Notes, tags, and review stayed on the first transaction. A bank id was copied only when the first record did not have one, and the second copy is no longer in the totals.", async () => {
                      await api(scoped(session.householdId, `/transactions/${matchId}/match`), { method: "POST", body: JSON.stringify({ otherId: txn.id }) });
                      setMatchId("");
                    })}>Match with selected</button> : null}
                    {txn.matchedArchivedId ? <button className="btn-quiet" type="button" disabled={!access.canWrite} aria-label={`Unmatch ${txn.payee} on ${txn.date}`} onClick={() => act("The hidden record is back in the register, and a receipt that moved comes back with it.", () => api(scoped(session.householdId, `/transactions/${txn.id}/unmatch`), { method: "POST" }).then(() => undefined))}>Unmatch</button> : null}
                    <button className="btn-quiet" type="button" aria-label={`Comment on ${txn.payee} on ${txn.date}`} onClick={() => setCommentFor(txn)}>Comment</button>
                    {txn.importBatchId ? <button className="btn-quiet" type="button" onClick={() => setSourceFor(txn)}>Bank file details</button> : null}
                    {access.canWrite ? <button className="btn-quiet" type="button" aria-label={`Manage people for ${txn.payee} on ${txn.date}`} onClick={() => setPeopleFor(txn)}>Manage people</button> : null}
                    {access.canReview && (access.canWrite || !txn.reviewerUserId || txn.reviewerUserId === session.user?.id) ? <button className="btn-quiet" type="button" aria-label={`${txn.reviewStatus === "reviewed" ? "Reopen review for" : "Mark reviewed:"} ${txn.payee} on ${txn.date}`} onClick={() => act("Review updated. The amount, category, and balance did not change.", () => api(scoped(session.householdId, `/transactions/${txn.id}/review`), { method: "POST", body: JSON.stringify({ reviewStatus: txn.reviewStatus === "reviewed" ? "needs_review" : "reviewed", version: txn.version ?? 1 }) }).then(() => undefined))}>{txn.reviewStatus === "reviewed" ? "Reopen review" : "Mark reviewed"}</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        {offset > 0 ? <button className="btn-secondary" type="button" onClick={() => { pageChanged.current = true; setOffset(Math.max(0, offset - PAGE)); }}>Previous page</button> : null}
        {list.data.nextOffset != null ? <button className="btn-secondary" type="button" onClick={() => { pageChanged.current = true; setOffset(list.data?.nextOffset ?? offset); }}>Next page</button> : null}
      </div>
      {peopleFor ? <PeopleForm txn={peopleFor} onClose={() => setPeopleFor(null)} /> : null}
      {sourceFor ? <ImportSource txn={sourceFor} onClose={() => setSourceFor(null)} /> : null}
      {commentFor ? <CommentForm txn={commentFor} onClose={() => setCommentFor(null)} onSaved={(message) => { setNoteBad(false); setNote(message); setCommentFor(null); }} /> : null}
      {open ? <TxnForm accounts={dash.data.accounts} buckets={dash.data.buckets} expenses={(purchases.data?.transactions ?? list.data.transactions).filter((txn) => txn.type === "expense")} currency={dash.data.household.currency} spaceId={dash.data.spaceId} existing={editing} onClose={() => { setOpen(false); setEditing(null); }} /> : null}
    </Page>
  );
}

function ImportSource({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const session = useSession();
  const source = useLoad(() => api<{ rows: { rowNumber: number; cells: SourceCell[] }[] }>(scoped(session.householdId, `/transactions/${txn.id}/import-source`)), [session.householdId, txn.id, session.tick]);
  return <Modal title="Bank file details" onClose={onClose}>
    <p>Original bank values are kept separately from any edits you make. A running balance does not change the account balance.</p>
    {source.loading ? <Loading /> : source.error ? <Notice kind="bad">{source.error}</Notice> : source.data?.rows.map((row) => <div key={row.rowNumber}><h3>File row {row.rowNumber}</h3><CsvSourceDetails cells={row.cells} /></div>)}
  </Modal>;
}

function PeopleForm({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const session = useSession();
  const people = useHouseholdPeople();
  const form = useFormError();
  useEffect(() => session.holdDraft(), [session]);
  const [kind, setKind] = useState("ownership");
  const [personId, setPersonId] = useState(txn.ownerUserId ?? "");
  const choices = (people.data?.people ?? []).filter((person) => kind === "ownership" || allows(person.role, "review"));
  return <Modal title={`People for ${txn.payee}`} onClose={onClose}>
    <p>Ownership labels filter views. Assigning a reviewer requests a new review. Neither changes money or grants access to private records.</p>
    <form onSubmit={(event) => form.run(event, async () => {
      await api(scoped(session.householdId, `/transactions/${txn.id}/${kind}`), { method: "POST", body: JSON.stringify({ version: txn.version ?? 1, ...(kind === "ownership" ? { ownerUserId: personId || null } : { reviewerUserId: personId || null }) }) });
      session.bump(); onClose();
    })}>
      <Field label="Change"><select aria-label="Change" value={kind} onChange={(event) => { setKind(event.target.value); setPersonId(event.target.value === "ownership" ? txn.ownerUserId ?? "" : txn.reviewerUserId ?? ""); }}><option value="ownership">Ownership label</option><option value="review-assignment">Reviewer</option></select></Field>
      <Field label={kind === "ownership" ? "Owner" : "Assign review to"}><select aria-label={kind === "ownership" ? "Owner" : "Assign review to"} value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">{kind === "ownership" ? "Ours — shared ownership" : "Unassigned"}</option>{choices.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></Field>
      {people.error ? <Notice kind="bad">{people.error}</Notice> : null}
      {form.error ? <Notice kind="bad">{form.error} Close this dialog and refresh Activity if someone else changed this record.</Notice> : null}
      <button type="submit" className="btn" disabled={people.loading || !!people.error}>Save {kind === "ownership" ? "ownership" : "reviewer"}</button>
    </form>
  </Modal>;
}

function CommentForm({ txn, onClose, onSaved }: { txn: Txn; onClose: () => void; onSaved: (message: string) => void }) {
  const session = useSession();
  const form = useFormError();
  const [comments, setComments] = useState<{ id: string; body: string; display_name: string }[]>([]);
  useEffect(() => session.holdDraft(), []);
  useEffect(() => {
    api<{ comments: { id: string; body: string; display_name: string }[]; note: string }>(scoped(session.householdId, `/comments?transactionId=${encodeURIComponent(txn.id)}`))
      .then((result) => setComments(result.comments))
      .catch((caught: unknown) => form.setError(caught instanceof Error ? caught.message : "Comments could not be loaded."));
  }, [session.householdId, txn.id, session.draftEpoch]);
  return (
    <Modal title={`Comment on ${txn.payee}`} onClose={onClose}>
      <p>A comment does not change the transaction, category, or balance.</p>
      <ul>{comments.map((comment) => <li key={comment.id}>{comment.display_name}: {comment.body}</li>)}</ul>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ note: string }>(scoped(session.householdId, "/comments"), { method: "POST", body: JSON.stringify({ transactionId: txn.id, body: data.get("body") }) });
        onSaved(result.note);
      })}>
        <Field label="Comment"><textarea name="body" required maxLength={2000} /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save comment</button>
      </form>
    </Modal>
  );
}

function TxnForm({ accounts, buckets, expenses, currency, spaceId, existing, onClose }: { accounts: Account[]; buckets: Dashboard["buckets"]; expenses: Txn[]; currency: string; spaceId: string; existing: Txn | null; onClose: () => void }) {
  const session = useSession();
  const form = useFormError();
  const amountHelp = useId();
  const addSplitRef = useRef<HTMLButtonElement>(null);
  const splitsRef = useRef<HTMLFieldSetElement>(null);
  const [type, setType] = useState(existing?.type ?? "expense");
  const people = useHouseholdPeople();
  const [splits, setSplits] = useState(existing?.splits.length ? existing.splits.map((split) => ({ bucketId: split.bucketId ?? "", amount: (split.amountMinor / 100).toFixed(2), ownerUserId: split.ownerUserId ?? "" })) : [{ bucketId: "", amount: "", ownerUserId: "" }]);
  useEffect(() => session.holdDraft(), []);
  const spendBuckets = buckets.filter((bucket) => !bucket.systemRole && bucket.kind === (type === "income" ? "income" : "expense"));
  return (
    <Modal title={existing ? "Edit transaction" : "New transaction"} onClose={onClose}>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const magnitude = Math.abs(parseAmount(String(data.get("amount")), currency));
        const signed = type === "income" || type === "refund" ? magnitude : -magnitude;
        const splitRows = splits.filter((split) => split.amount).map((split) => ({
          bucketId: split.bucketId || null, amountMinor: Math.abs(parseAmount(split.amount, currency)), role: type === "income" ? "income" as const : type === "refund" ? "refund" as const : "expense" as const, ownerUserId: split.ownerUserId || null,
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
          reviewStatus: data.get("reviewStatus") || undefined,
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
        <Field label="Amount"><input name="amount" required inputMode="decimal" aria-describedby={amountHelp} defaultValue={existing ? (Math.abs(existing.amountMinor) / 100).toFixed(2) : ""} /></Field>
        <p id={amountHelp} className="muted">Dollars and cents, such as 12.34. The type chooses income or spending.</p>
        <Field label="Account"><select name="accountId" required defaultValue={existing?.accountId ?? ""}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        {type === "transfer" || type === "cc_payment" ? <Field label="Other account"><select name="counterAccountId" required defaultValue={existing?.counterAccountId ?? ""}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field> : null}
        {type !== "transfer" && type !== "cc_payment" ? (
          <fieldset ref={splitsRef}>
            <legend>Splits</legend>
            {splits.map((split, index) => (
              <div className="split-row" key={index}>
                <select aria-label={`Category for split ${index + 1}`} value={split.bucketId} onChange={(event) => setSplits(splits.map((item, itemIndex) => itemIndex === index ? { ...item, bucketId: event.target.value } : item))}>
                  <option value="">Uncategorized</option>
                  {spendBuckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}
                </select>
                <input aria-label={`Amount for split ${index + 1}`} inputMode="decimal" value={split.amount} onChange={(event) => setSplits(splits.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} />
                <select aria-label={`Owner for split ${index + 1}`} value={split.ownerUserId} onChange={(event) => setSplits(splits.map((item, itemIndex) => itemIndex === index ? { ...item, ownerUserId: event.target.value } : item))}>
                  <option value="">Ours</option>
                  {(people.data?.people ?? []).map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
                </select>
                <button type="button" className="btn-quiet" aria-label={`Remove split ${index + 1}`} onClick={() => {
                  setSplits(splits.filter((_, itemIndex) => itemIndex !== index));
                  addSplitRef.current?.focus();
                }}>Remove</button>
              </div>
            ))}
            <button ref={addSplitRef} type="button" className="btn-secondary" onClick={() => {
              setSplits([...splits, { bucketId: "", amount: "", ownerUserId: "" }]);
              requestAnimationFrame(() => {
                const rows = splitsRef.current?.querySelectorAll("select");
                rows?.[rows.length - 1]?.focus();
              });
            }}>Add split</button>
          </fieldset>
        ) : null}
        {type === "refund" || type === "reimbursement" ? (
          <Field label="Refund of">
            <select name="refundOfId" defaultValue={existing?.refundOfId ?? ""}>
              <option value="">Not linked</option>
              {expenses.map((txn) => <option key={txn.id} value={txn.id}>{txn.date} {txn.payee}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="Review"><select name="reviewStatus" defaultValue={existing?.reviewStatus ?? "needs_review"}><option value="needs_review">Needs review</option><option value="reviewed">Reviewed</option></select></Field>
        <Field label="Tags"><input name="tags" placeholder="trip, reimbursable" defaultValue={existing?.tags?.join(", ") ?? ""} /></Field>
        <Field label="Note"><textarea name="notes" defaultValue={existing?.notes ?? ""} /></Field>
        {existing?.reconciled ? <Field label="Reason for changing a reconciled amount"><input name="reason" /></Field> : null}
        <Field label="Receipt (JPEG, PNG, or PDF)"><input name="receipt" type="file" accept="image/jpeg,image/png,application/pdf" /></Field>
        <p className="muted">The receipt is stored with this transaction and does not change it. Open Receipts to read the file. A reconciled transaction is not overwritten.</p>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save</button>
      </form>
    </Modal>
  );
}
