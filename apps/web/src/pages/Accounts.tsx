import { useState } from "react";
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
            {dash.accounts.map((account) => (
              <tr key={account.id}>
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
  const [result, setResult] = useState<{ differenceMinor: number; locked: boolean; formula: string; clearedBalanceMinor: number } | null>(null);
  const [adjustNote, setAdjustNote] = useState("");
  const txns = useLoad(() => selected ? api<{ transactions: Txn[] }>(scoped(session.householdId, `/transactions?accountId=${selected}&limit=100`, session.spaceId)) : Promise.resolve({ transactions: [] as Txn[] }), [selected, session.tick, session.householdId]);
  const form = useFormError();
  const adjust = useFormError();
  const reconciled = txns.data?.transactions.filter((txn) => txn.reconciled) ?? [];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const clearedIds = txns.data?.transactions.filter((txn) => data.get(`clear-${txn.id}`) === "on").map((txn) => txn.id) ?? [];
        const response = await api<{ differenceMinor: number; locked: boolean; formula: string; clearedBalanceMinor: number }>(scoped(session.householdId, "/reconcile"), { method: "POST", body: JSON.stringify({
          accountId: data.get("accountId"), statementDate: data.get("date"), statementBalanceMinor: parseAmount(String(data.get("balance")), currency), clearedIds, lock: data.get("lock") === "on",
        }) });
        setResult(response);
        setAdjustNote("");
        session.bump();
      })}>
        <h2>Reconcile</h2>
        <p className="muted">A transaction from another account is rejected. Locking is allowed only when the difference is zero. Changing a locked amount later asks for a reason.</p>
        <Field label="Account"><select name="accountId" value={selected} onChange={(event) => onSelect(event.target.value)} required><option value="">Choose</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        <Field label="Statement date"><input name="date" type="date" required defaultValue={todayISO()} /></Field>
        <Field label="Statement balance"><input name="balance" required inputMode="decimal" /></Field>
        {txns.data?.transactions.map((txn) => (
          <label key={txn.id} className="link-row"><span><input type="checkbox" name={`clear-${txn.id}`} defaultChecked={txn.cleared || txn.reconciled} /> {txn.date} {txn.payee} · {txn.reconciled ? "Reconciled" : txn.cleared ? "Cleared" : "Not cleared"}</span><Money minor={txn.amountMinor} /></label>
        ))}
        <label className="field"><span><input type="checkbox" name="lock" /> Lock when the difference is zero</span></label>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {result ? <Notice>{result.formula} Cleared balance <Money minor={result.clearedBalanceMinor} />. Difference <Money minor={result.differenceMinor} />. {result.locked ? "Locked." : "Not locked."}</Notice> : null}
        <button className="btn" type="submit" disabled={!selected}>Compare</button>
      </form>
      {result && result.differenceMinor !== 0 ? (
        <form style={{ marginTop: 12 }} onSubmit={(event) => adjust.run(event, async () => {
          const data = new FormData(event.currentTarget);
          const response = await api<{ note: string }>(scoped(session.householdId, "/reconcile/adjustment"), { method: "POST", body: JSON.stringify({
            accountId: selected, date: data.get("date"), amountMinor: parseAmount(String(data.get("amount")), currency), payee: data.get("payee") || "Reconciliation adjustment",
          }) });
          setAdjustNote(response.note);
          setResult(null);
          session.bump();
        })}>
          <h3>Correct the difference</h3>
          <p className="muted">This adds a visible register entry for the difference. It does not hide the gap inside the reconciliation.</p>
          <Field label="Date"><input name="date" type="date" required defaultValue={todayISO()} /></Field>
          <Field label="Adjustment amount"><input name="amount" required inputMode="decimal" defaultValue={(result.differenceMinor / 100).toFixed(2)} /></Field>
          <Field label="Payee"><input name="payee" defaultValue="Reconciliation adjustment" /></Field>
          {adjust.error ? <Notice kind="bad">{adjust.error}</Notice> : null}
          <button className="btn-secondary" type="submit">Add adjustment</button>
        </form>
      ) : null}
      {adjustNote ? <Notice>{adjustNote}</Notice> : null}
      {reconciled.length ? (
        <div style={{ marginTop: 12 }}>
          <h3>Unlock</h3>
          <p className="muted">Unlocking lets those amounts be edited again. It does not change the balance.</p>
          <button className="btn-secondary" type="button" onClick={async () => {
            await api(scoped(session.householdId, "/reconcile/unlock"), { method: "POST", body: JSON.stringify({ accountId: selected, transactionIds: reconciled.map((txn) => txn.id) }) });
            setAdjustNote("Those transactions can be edited again.");
            session.bump();
          }}>Unlock reconciled transactions</button>
        </div>
      ) : null}
    </div>
  );
}
