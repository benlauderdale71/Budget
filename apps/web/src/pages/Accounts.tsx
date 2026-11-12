import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Dashboard, Txn } from "../types.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

export function Accounts() {
  const session = useSession();
  const state = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  const [accountId, setAccountId] = useState("");
  const [params] = useSearchParams();
  const focus = params.get("focus");
  useEffect(() => {
    if (!focus || !state.data) return;
    document.getElementById(`account-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, state.data]);
  if (state.loading && !state.data) return <Loading label="Loading accounts" />;
  if (!state.data) return <ErrorNote message={state.error ?? "No accounts"} onRetry={session.bump} />;
  const dash = state.data;
  const worth = new Map(dash.netWorth.accounts.map((account) => [account.accountId, account]));
  return (
    <Page title="Accounts" lede="On-budget cash is what the plan can assign. Loans and investments stay visible in net worth without becoming spending money.">
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Visibility</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {focus && !dash.accounts.some((account) => account.id === focus) ? <tr><td colSpan={4}>That account is not available in this view.</td></tr> : null}
            {dash.accounts.map((account) => (
              <tr key={account.id} id={`account-${account.id}`}>
                <td>{account.name}{account.mask ? ` · ${account.mask}` : ""}{account.onBudget ? "" : " · off budget"}</td>
                <td>{account.kind.replaceAll("_", " ")}</td>
                <td>{account.visibility}</td>
                <td className="num">{worth.has(account.id) ? <Money minor={worth.get(account.id)!.displayMinor} currency={account.currency} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => {
        const formEl = event.currentTarget;
        return form.run(event, async () => {
        const data = new FormData(formEl);
        const kind = String(data.get("kind"));
        const liability = ["credit", "loan", "student_loan", "mortgage", "other_liability"].includes(kind);
        await api(scoped(session.householdId, "/accounts"), { method: "POST", body: JSON.stringify({
          spaceId: dash.spaceId, name: data.get("name"), kind, visibility: data.get("visibility"),
          onBudget: data.get("onBudget") === "yes",
          openingBalanceMinor: data.get("opening") ? parseAmount(String(data.get("opening")), dash.household.currency) : undefined,
          openingDate: data.get("opening") ? todayISO() : undefined,
          aprBps: data.get("apr") ? Math.round(Number(data.get("apr")) * 100) : undefined,
          minimumPaymentMinor: data.get("minimum") ? parseAmount(String(data.get("minimum")), dash.household.currency) : undefined,
          creditLimitMinor: data.get("limit") ? parseAmount(String(data.get("limit")), dash.household.currency) : undefined,
        }) });
        formEl.reset();
        session.bump();
        if (liability) setAccountId("");
      });
      }}>
        <h2>Add account</h2>
        <div className="grid two">
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Kind"><select name="kind"><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit card</option><option value="loan">Loan</option><option value="mortgage">Mortgage</option><option value="brokerage">Brokerage</option><option value="retirement">Retirement</option><option value="property">Property</option><option value="vehicle">Vehicle</option><option value="other_asset">Other asset</option><option value="other_liability">Other liability</option></select></Field>
          <Field label="Opening balance"><input name="opening" inputMode="decimal" /></Field>
          <Field label="In the plan"><select name="onBudget"><option value="yes">On budget</option><option value="no">Tracking only</option></select></Field>
          <Field label="Who can see it"><select name="visibility"><option value="shared">Household</option><option value="private">Only me</option></select></Field>
          <Field label="APR percent, if it borrows"><input name="apr" inputMode="decimal" /></Field>
          <Field label="Minimum payment"><input name="minimum" inputMode="decimal" /></Field>
          <Field label="Credit limit"><input name="limit" inputMode="decimal" /></Field>
        </div>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save account</button>
      </form>
      <Reconcile accounts={dash.accounts} currency={dash.household.currency} selected={accountId} onSelect={setAccountId} />
    </Page>
  );
}

function Reconcile({ accounts, currency, selected, onSelect }: { accounts: Dashboard["accounts"]; currency: string; selected: string; onSelect: (id: string) => void }) {
  const session = useSession();
  const [result, setResult] = useState<{ differenceMinor: number; locked: boolean; wrote: boolean; formula: string; clearedBalanceMinor: number; canLock: boolean } | null>(null);
  const [adjustNote, setAdjustNote] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [adjustDate, setAdjustDate] = useState(todayISO());
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustPayee, setAdjustPayee] = useState("Reconciliation adjustment");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustPreview, setAdjustPreview] = useState<{ fingerprint: string; note: string } | null>(null);
  const [adjustOp, setAdjustOp] = useState("");
  const [unlockReason, setUnlockReason] = useState("");
  const txns = useLoad(() => selected ? api<{ transactions: Txn[] }>(scoped(session.householdId, `/transactions?accountId=${selected}&limit=100`, session.spaceId)) : Promise.resolve({ transactions: [] as Txn[] }), [selected, session.tick, session.householdId]);
  const form = useFormError();
  const adjust = useFormError();
  const unlock = useFormError();
  const correct = useFormError();
  const reconciled = txns.data?.transactions.filter((txn) => txn.reconciled) ?? [];
  const adjustFingerprint = `${adjustDate}|${adjustAmount}|${adjustPayee}|${adjustReason}`;
  async function refreshHistory() {
    const audit = await api<{ events: { action: string; summary: string }[] }>(scoped(session.householdId, "/audit"));
    setHistory(audit.events.filter((event) => event.action.startsWith("reconcile")).slice(0, 4).map((event) => event.summary));
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <form onSubmit={(event) => {
        const intent = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "preview";
        return form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          const chosen = txns.data?.transactions.filter((txn) => data.get(`clear-${txn.id}`) === "on") ?? [];
          const response = await api<{ differenceMinor: number; locked: boolean; wrote: boolean; formula: string; clearedBalanceMinor: number; canLock: boolean }>(scoped(session.householdId, "/reconcile"), { method: "POST", body: JSON.stringify({
            accountId: data.get("accountId"),
            statementDate: data.get("date"),
            statementBalanceMinor: parseAmount(String(data.get("balance")), currency),
            clearedIds: chosen.map((txn) => txn.id),
            lock: intent === "lock",
            mode: intent === "lock" ? "commit" : "preview",
            versions: chosen.map((txn) => ({ id: txn.id, version: txn.version ?? 1 })),
          }) });
          setResult(response);
          setAdjustNote(intent === "lock" ? "The statement was locked." : "Nothing was changed.");
          if (response.differenceMinor !== 0) setAdjustAmount((response.differenceMinor / 100).toFixed(2));
          if (intent === "lock") {
            await refreshHistory();
            session.bump();
          }
        });
      }}>
        <h2>Reconcile</h2>
        <p className="muted">Compare does not clear, lock, or post anything. A reconciled transaction stays in the balance until you unlock it. Locking is allowed only when the difference is zero. Cancelling leaves the register as it was.</p>
        <Field label="Account"><select name="accountId" value={selected} onChange={(event) => { onSelect(event.target.value); setResult(null); }} required><option value="">Choose</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        <Field label="Statement date"><input name="date" type="date" required defaultValue={todayISO()} /></Field>
        <Field label="Statement balance"><input name="balance" required inputMode="decimal" /></Field>
        {txns.data?.transactions.map((txn) => (
          <label key={txn.id} className="link-row"><span><input type="checkbox" name={`clear-${txn.id}`} defaultChecked={txn.cleared || txn.reconciled} /> {txn.date} {txn.payee} · {txn.reconciled ? "Reconciled" : txn.cleared ? "Cleared" : "Not cleared"}</span><Money minor={txn.amountMinor} /></label>
        ))}
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {result ? <Notice>{result.formula} Cleared balance <Money minor={result.clearedBalanceMinor} />. Difference <Money minor={result.differenceMinor} />. {result.locked ? "Locked." : "Not locked."} {result.wrote ? "" : "Nothing was written."}</Notice> : null}
        <button className="btn" type="submit" value="preview" disabled={!selected}>Compare</button>
        <button className="btn" type="submit" value="lock" disabled={!selected || !result?.canLock}>Lock statement</button>
        <button className="btn-secondary" type="button" onClick={() => { setResult(null); setAdjustPreview(null); setAdjustNote("Cancelled. Nothing was changed."); }}>Cancel</button>
      </form>
      {result && result.differenceMinor !== 0 ? (
        <form style={{ marginTop: 12 }} onSubmit={(event) => event.preventDefault()}>
          <h3>Correct the difference</h3>
          <p className="muted">Preview shows the register entry and posts nothing. Confirm adds that entry once. A repeated confirm does not add it again.</p>
          <Field label="Date"><input name="date" type="date" required value={adjustDate} onChange={(event) => setAdjustDate(event.target.value)} /></Field>
          <Field label="Adjustment amount"><input name="amount" required inputMode="decimal" value={adjustAmount} onChange={(event) => setAdjustAmount(event.target.value)} /></Field>
          <Field label="Payee"><input name="payee" value={adjustPayee} onChange={(event) => setAdjustPayee(event.target.value)} /></Field>
          <Field label="Reason"><input name="reason" required minLength={3} value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} /></Field>
          {adjust.error ? <Notice kind="bad">{adjust.error}</Notice> : null}
          {adjustPreview ? <Notice>{adjustPreview.note} {adjustPreview.fingerprint === adjustFingerprint ? "This preview matches the fields above." : "The fields changed. Preview again. Nothing was posted."}</Notice> : null}
          <button className="btn-secondary" type="button" onClick={() => {
            adjust.setError("");
            void (async () => {
              try {
                const response = await api<{ note: string; wrote: boolean }>(scoped(session.householdId, "/reconcile/adjustment"), { method: "POST", body: JSON.stringify({
                  accountId: selected, date: adjustDate, amountMinor: parseAmount(adjustAmount, currency), payee: adjustPayee, preview: true,
                }) });
                setAdjustOp(crypto.randomUUID());
                setAdjustPreview({ fingerprint: `${adjustDate}|${adjustAmount}|${adjustPayee}|${adjustReason}`, note: response.note });
                setAdjustNote(response.note);
              } catch (caught) { adjust.setError(caught instanceof Error ? caught.message : "That did not save."); }
            })();
          }}>Preview adjustment</button>
          <button className="btn" type="button" disabled={!adjustPreview || adjustPreview.fingerprint !== adjustFingerprint || adjustReason.trim().length < 3} onClick={() => {
            adjust.setError("");
            void (async () => {
              try {
                const response = await api<{ note: string; duplicate?: boolean }>(scoped(session.householdId, "/reconcile/adjustment"), { method: "POST", body: JSON.stringify({
                  accountId: selected, date: adjustDate, amountMinor: parseAmount(adjustAmount, currency), payee: adjustPayee, reason: adjustReason, opId: adjustOp,
                }) });
                setAdjustNote(response.note);
                setAdjustPreview(null);
                setResult(null);
                await refreshHistory();
                session.bump();
              } catch (caught) { adjust.setError(caught instanceof Error ? caught.message : "That did not save."); }
            })();
          }}>Confirm adjustment</button>
        </form>
      ) : null}
      {adjustNote ? <Notice>{adjustNote}</Notice> : null}
      {reconciled.length ? (
        <form style={{ marginTop: 12 }} onSubmit={(event) => unlock.run(event, async () => {
          await api(scoped(session.householdId, "/reconcile/unlock"), { method: "POST", body: JSON.stringify({
            accountId: selected,
            transactionIds: reconciled.map((txn) => txn.id),
            reason: unlockReason,
            versions: reconciled.map((txn) => ({ id: txn.id, version: txn.version ?? 1 })),
          }) });
          setAdjustNote("Those transactions can be edited again. The amounts stayed the same.");
          await refreshHistory();
          session.bump();
        })}>
          <h3>Unlock</h3>
          <p className="muted">Unlocking asks for a reason and records it. It does not change the balance.</p>
          <Field label="Reason for unlocking"><input value={unlockReason} onChange={(event) => setUnlockReason(event.target.value)} required minLength={3} /></Field>
          {unlock.error ? <Notice kind="bad">{unlock.error}</Notice> : null}
          <button className="btn-secondary" type="submit">Unlock reconciled transactions</button>
        </form>
      ) : null}
      {reconciled.map((txn) => (
        <form key={txn.id} style={{ marginTop: 12 }} onSubmit={(event) => correct.run(event, async () => {
          const data = new FormData(event.currentTarget);
          await api(scoped(session.householdId, `/transactions/${txn.id}`), { method: "PATCH", body: JSON.stringify({
            amountMinor: parseAmount(String(data.get("amount")), currency),
            version: txn.version ?? 1,
            reason: data.get("reason"),
          }) });
          setAdjustNote(`Corrected ${txn.payee}. The change is in the register.`);
          session.bump();
        })}>
          <h3>Correct {txn.payee}</h3>
          <Field label="Amount"><input name="amount" required inputMode="decimal" defaultValue={(txn.amountMinor / 100).toFixed(2)} /></Field>
          <Field label="Reason"><input name="reason" required minLength={3} /></Field>
          {correct.error ? <Notice kind="bad">{correct.error}</Notice> : null}
          <button className="btn-secondary" type="submit">Save correction</button>
        </form>
      ))}
      {history.length ? <ul>{history.map((line) => <li key={line}>{line}</li>)}</ul> : null}
    </div>
  );
}
