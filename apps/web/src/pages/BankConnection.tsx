import { useState } from "react";
import { api } from "../api.js";
import { scoped, useAccess, useSession } from "../session.js";
import { Field, Money, Notice, useFormError, useLoad } from "../ui.js";

type BankRow = { externalId: string; date: string; amountMinor: number; payee: string; status: "new" | "imported" | "changed" };
type BankAccount = { externalAccountId: string; name: string; currency: string; referenceBalance: string; rows: BankRow[] };
type BankPreview = { previewId: string; accounts: BankAccount[]; warnings: string[]; note: string };

export function BankConnection() {
  const session = useSession();
  const access = useAccess();
  const [tick, setTick] = useState(0);
  const state = useLoad(() => api<{ configured: boolean; links: { id: string; label: string }[] }>(scoped(session.householdId, "/providers/simplefin")), [session.householdId, tick]);
  const [preview, setPreview] = useState<(BankPreview & { linkId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const form = useFormError();
  return <article className="card" style={{ marginBottom: 16 }}>
    <h2>SimpleFIN bank connection</h2>
    <p>Connect through <a href="https://bridge.simplefin.org/simplefin/create" target="_blank" rel="noreferrer">SimpleFIN Bridge</a>, then paste its setup token. Enter your bank login only on the provider’s connection screen.</p>
    <p>Check that America’s First Federal Credit Union (AmFirst) is supported before subscribing. Coverage has not been verified for this app.</p>
    {state.error && <Notice kind="bad">{state.error}</Notice>}
    {state.data && !state.data.configured && <Notice>Bank connections need the server encryption key configured. Manual entry and file imports remain available.</Notice>}
    {access.canWrite && state.data?.configured && <form onSubmit={(e) => form.run(e, async () => {
      const element = e.currentTarget;
      const data = new FormData(element);
      setBusy(true);
      try {
        await api(scoped(session.householdId, "/providers/simplefin/connect"), { method: "POST", body: JSON.stringify({ setupToken: data.get("token"), label: data.get("label"), consent: data.get("consent") === "on" }) });
        element.reset(); setTick((v) => v + 1); setNotice("Connected. Preview history before importing anything.");
      } finally { setBusy(false); }
    })}>
      <Field label="Connection name"><input name="label" defaultValue="My bank" maxLength={80} required /></Field>
      <Field label="SimpleFIN setup token"><input name="token" type="password" autoComplete="off" required /></Field>
      <label><input name="consent" type="checkbox" required /> Allow BudgetCents to read this connection’s account and transaction data.</label>
      <p><button className="btn" disabled={busy || session.offline}>Connect bank feed</button></p>
    </form>}
    {state.data?.links.map((link) => <div key={link.id} className="card">
      <strong>{link.label}</strong>
      <button className="btn-secondary" disabled={busy || session.offline} onClick={async () => {
        setBusy(true); form.setError("");
        try { const data = await api<BankPreview>(scoped(session.householdId, `/providers/simplefin/${link.id}/preview`), { method: "POST" }); setPreview({ ...data, linkId: link.id }); }
        catch (e) { form.setError(e instanceof Error ? e.message : "Bank preview failed."); }
        finally { setBusy(false); }
      }}>Preview posted history</button>
      <button className="btn-quiet" disabled={busy} onClick={async () => {
        if (!window.confirm("Disconnect this feed? Imported transactions will stay in your ledger.")) return;
        try { const result = await api<{ note: string }>(scoped(session.householdId, `/providers/simplefin/${link.id}/revoke`), { method: "POST" }); setNotice(result.note); setPreview(null); setTick((v) => v + 1); }
        catch (e) { form.setError(e instanceof Error ? e.message : "Could not disconnect."); }
      }}>Disconnect</button>
    </div>)}
    {notice && <Notice>{notice}</Notice>}
    {form.error && <Notice kind="bad">{form.error}</Notice>}
    {preview && <div>
      <p>{preview.note}</p>
      <p>Preview expires after 15 minutes. Refreshes are cached for one hour. Your ledger opening balance must exclude the history you import.</p>
      {preview.warnings.map((warning, i) => <Notice key={i} kind="bad">{warning}</Notice>)}
      {preview.accounts.map((account) => <ImportBankAccount key={`${preview.previewId}:${account.externalAccountId}`} preview={preview} account={account} onDone={setNotice} />)}
    </div>}
  </article>;
}

function ImportBankAccount({ preview, account, onDone }: { preview: BankPreview & { linkId: string }; account: BankAccount; onDone: (note: string) => void }) {
  const session = useSession();
  const access = useAccess();
  const accounts = useLoad(() => api<{ accounts: { id: string; name: string; currency: string }[] }>(scoped(session.householdId, "/accounts")), [session.householdId]);
  const expenses = useLoad(() => api<{ transactions: { id: string; payee: string; date: string; type: string; currency: string; amountMinor: number }[] }>(scoped(session.householdId, "/transactions?limit=500")), [session.householdId]);
  const [selected, setSelected] = useState<string[]>([]);
  const [types, setTypes] = useState<Record<string, string>>({});
  const [counters, setCounters] = useState<Record<string, string>>({});
  const [refunds, setRefunds] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useFormError();
  const [page, setPage] = useState(0);
  return <form className="card" onSubmit={(e) => form.run(e, async () => {
    const data = new FormData(e.currentTarget);
    if (!selected.length) throw new Error("Select the transactions you want to import.");
    setBusy(true);
    try {
      const result = await api<{ imported: number; duplicates: number; note: string }>(scoped(session.householdId, `/providers/simplefin/${preview.linkId}/import`), { method: "POST", body: JSON.stringify({ previewId: preview.previewId, externalAccountId: account.externalAccountId, accountId: data.get("accountId"), rows: account.rows.filter((r) => selected.includes(r.externalId)).map((r) => ({ externalId: r.externalId, type: types[r.externalId] ?? (r.amountMinor < 0 ? "expense" : "income"), counterAccountId: counters[r.externalId] || undefined, refundOfId: refunds[r.externalId] || undefined })) }) });
      setConfirmed(true); onDone(`${result.imported} imported; ${result.duplicates} already imported. ${result.note}`); session.bump();
    } finally { setBusy(false); }
  })}>
    <h3>{account.name} · {account.currency}</h3>
    {accounts.error && <Notice kind="bad">{accounts.error}</Notice>}
    <Field label="Import into ledger account"><select name="accountId" required disabled={busy || confirmed}><option value="">Choose an account</option>{accounts.data?.accounts.filter((a) => a.currency === account.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
    <p>Select only history that is not already in your register. For a transfer, import one side and choose the counter-account.</p>
    <p>{account.rows.length} posted rows; {selected.length} selected. Newest first.</p>
    {account.rows.slice(page * 20, (page + 1) * 20).map((row) => <div key={row.externalId} style={{ marginBottom: 12 }}>
      <label><input type="checkbox" checked={selected.includes(row.externalId)} disabled={busy || confirmed || row.status !== "new"} onChange={(e) => setSelected(e.target.checked ? [...selected, row.externalId] : selected.filter((id) => id !== row.externalId))} /> {row.date} · {row.payee} · <Money minor={row.amountMinor} currency={account.currency} /> · {row.status}</label>
      {selected.includes(row.externalId) && <>
        <Field label={`Type for ${row.payee}`}><select value={types[row.externalId] ?? (row.amountMinor < 0 ? "expense" : "income")} onChange={(e) => setTypes({ ...types, [row.externalId]: e.target.value })} disabled={busy || confirmed}><option value="expense">Expense</option><option value="income">Income</option><option value="refund">Refund</option><option value="transfer">Transfer</option></select></Field>
        {types[row.externalId] === "transfer" && <Field label={`Other account for ${row.payee}`}><select value={counters[row.externalId] ?? ""} onChange={(e) => setCounters({ ...counters, [row.externalId]: e.target.value })} required disabled={busy || confirmed}><option value="">Choose the other account</option>{accounts.data?.accounts.filter((a) => a.currency === account.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
        {types[row.externalId] === "refund" && <Field label={`Original expense for ${row.payee}`}><select value={refunds[row.externalId] ?? ""} onChange={(e) => setRefunds({ ...refunds, [row.externalId]: e.target.value })} required disabled={busy || confirmed}><option value="">Choose the original purchase</option>{expenses.data?.transactions.filter((t) => t.type === "expense" && t.currency === account.currency).map((t) => <option key={t.id} value={t.id}>{t.date} · {t.payee}{session.user?.privacyMode ? "" : ` · ${(Math.abs(t.amountMinor) / 100).toFixed(2)} ${t.currency}`}</option>)}</select></Field>}
      </>}
    </div>)}
    <div><button type="button" className="btn-quiet" disabled={page === 0 || busy} onClick={() => setPage((v) => v - 1)}>Previous transactions</button><button type="button" className="btn-quiet" disabled={(page + 1) * 20 >= account.rows.length || busy} onClick={() => setPage((v) => v + 1)}>Next transactions</button></div>
    {form.error && <Notice kind="bad">{form.error}</Notice>}
    <button className="btn" disabled={!access.canWrite || session.offline || busy || confirmed || !selected.length}>{confirmed ? "Imported" : busy ? "Importing…" : "Confirm selected transactions"}</button>
  </form>;
}
