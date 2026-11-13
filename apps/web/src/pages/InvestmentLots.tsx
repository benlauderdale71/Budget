import { realizeFifo } from "@budgetcents/domain/lots";
import { useState } from "react";
import { api } from "../api.js";
import { minorToInput, parseAmount } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import { Field, Money, Notice, useFormError, useLoad } from "../ui.js";

type Lot = { id: string; holdingId: string; symbol: string; currency: string; quantityMicro: number; costBasisMinor: number | null; acquired: string; revision: number };
type Sale = { id: string; symbol: string; currency: string; soldOn: string; quantityMicro: number; proceedsMinor: number; basisMinor: number; gainMinor: number };
type Payload = { holdingId: string; quantityMicro: number; proceedsMinor: number; expectedRevision: number; soldOn: string; opId: string };

export function InvestmentLots() {
  const session = useSession(); const access = useAccess(); const form = useFormError();
  const [tick, setTick] = useState(0);
  const state = useLoad(() => api<{ lots: Lot[]; revisions: Record<string, number>; sales: Sale[]; note: string }>(scoped(session.householdId, "/lots")), [session.householdId, session.tick, tick]);
  const [preview, setPreview] = useState<{ body: Payload; gainMinor: number; basisMinor: number; currency: string } | null>(null);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState("");
  const holdings = [...new Map(state.data?.lots.map((l) => [l.holdingId, l.symbol]) ?? []).entries()];
  return <section className="card">
    <h2>Lots and realized gains</h2>
    <p>{state.data?.note}</p>
    {state.error && <Notice kind="bad">{state.error}</Notice>}
    <div className="table-scroll"><table><thead><tr><th>Holding</th><th>Acquired</th><th>Shares</th><th>Remaining basis</th><th>Change</th></tr></thead><tbody>{state.data?.lots.map((lot) => <tr key={lot.id}>
      <td>{lot.symbol}</td><td>{lot.acquired}</td><td>{lot.quantityMicro / 1_000_000}</td><td>{lot.costBasisMinor == null ? "Missing" : <Money minor={lot.costBasisMinor} currency={lot.currency} />}</td>
      <td><button className="btn-quiet" disabled={busy || session.offline || !access.canWrite} onClick={async () => {
        const raw = window.prompt("Enter this lot's total remaining cost basis. Leave blank to mark it missing.", lot.costBasisMinor == null ? "" : minorToInput(lot.costBasisMinor, lot.currency));
        if (raw == null) return;
        setBusy(true); form.setError("");
        try { await api(scoped(session.householdId, `/lots/${lot.id}`), { method: "PATCH", body: JSON.stringify({ expectedRevision: lot.revision, costBasisMinor: raw.trim() ? parseAmount(raw, lot.currency) : null }) }); setTick((n) => n + 1); setPreview(null); }
        catch (e) { form.setError(e instanceof Error ? e.message : "Basis could not be saved."); }
        finally { setBusy(false); }
      }}>Edit basis</button></td>
    </tr>)}</tbody></table></div>
    {holdings.length > 0 && <form onChange={() => { setPreview(null); setNote(""); }} onSubmit={(event) => form.run(event, async () => {
      if (busy || !state.data) return;
      if (!preview) {
        const data = new FormData(event.currentTarget); const holdingId = String(data.get("holdingId"));
        const shares = String(data.get("shares"));
        if (!/^\d+(\.\d{1,6})?$/.test(shares)) throw new Error("Use at most six decimal places for shares.");
        const [whole, fraction = ""] = shares.split(".");
        const quantityMicro = Number(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")));
        const lots = state.data.lots.filter((l) => l.holdingId === holdingId);
        if (lots.some((l) => l.costBasisMinor == null)) throw new Error("Add the missing basis before recording a sale.");
        const currency = lots[0].currency;
        const body = { holdingId, quantityMicro, proceedsMinor: parseAmount(String(data.get("proceeds")), currency), expectedRevision: state.data.revisions[holdingId], soldOn: String(data.get("soldOn")), opId: crypto.randomUUID() };
        const result = realizeFifo(lots.map((l) => ({ ...l, costBasisMinor: l.costBasisMinor! })), quantityMicro, body.proceedsMinor);
        setPreview({ body, currency, gainMinor: result.gainMinor, basisMinor: result.sales.reduce((sum, s) => sum + s.basisMinor, 0) });
      } else {
        setBusy(true);
        try { const saved = await api<{ note: string }>(scoped(session.householdId, "/lots/sell"), { method: "POST", body: JSON.stringify(preview.body) }); setNote(saved.note); setPreview(null); setTick((n) => n + 1); session.bump(); }
        finally { setBusy(false); }
      }
    })}>
      <h3>Record a FIFO sale</h3>
      <Field label="Holding"><select name="holdingId">{holdings.map(([id, symbol]) => <option key={id} value={id}>{symbol}</option>)}</select></Field>
      <Field label="Shares sold"><input name="shares" required inputMode="decimal" /></Field>
      <Field label="Net proceeds after fees"><input name="proceeds" required inputMode="decimal" /></Field>
      <Field label="Sale date"><input name="soldOn" required type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
      {preview && <Notice>FIFO basis <Money minor={preview.basisMinor} currency={preview.currency} />; realized gain <Money minor={preview.gainMinor} currency={preview.currency} />. Confirming reduces the holding and saves sale history. It does not add cash proceeds to the ledger.</Notice>}
      <button className="btn" disabled={busy || session.offline || !access.canWrite}>{preview ? "Confirm lot sale" : "Preview lot sale"}</button>
      {preview && <button type="button" className="btn-quiet" onClick={() => setPreview(null)}>Cancel preview</button>}
    </form>}
    {form.error && <Notice kind="bad">{form.error}</Notice>}{note && <Notice>{note}</Notice>}
    <h3>Saved sales</h3>
    {!state.data?.sales.length ? <p>No recorded sales.</p> : <div className="table-scroll"><table><thead><tr><th>Sold</th><th>Holding</th><th>Shares</th><th>Proceeds</th><th>Basis</th><th>Realized gain</th></tr></thead><tbody>{state.data.sales.map((sale) => <tr key={sale.id}><td>{sale.soldOn}</td><td>{sale.symbol}</td><td>{sale.quantityMicro / 1_000_000}</td><td><Money minor={sale.proceedsMinor} currency={sale.currency} /></td><td><Money minor={sale.basisMinor} currency={sale.currency} /></td><td><Money minor={sale.gainMinor} currency={sale.currency} /></td></tr>)}</tbody></table></div>}
  </section>;
}
