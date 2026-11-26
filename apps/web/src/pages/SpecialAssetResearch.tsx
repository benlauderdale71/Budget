import { useEffect, useRef, useState } from "react";
import type { AssetEstimate } from "../asset-tools.js";
import { fleetSource, houseEstimate, indexUrl, loadReference, states, vehicleEstimate } from "../asset-reference.js";
import { minorToInput, parseAmount, todayISO } from "../format.js";
import { useSession } from "../session.js";
import { Field, Money, Notice } from "../ui.js";

interface Props {
  category: string; description: string; purchased: string; purchaseMinor: number | null;
  onEstimate: (estimate: AssetEstimate | null) => void;
}
export function SpecialAssetResearch({category, description, purchased, purchaseMinor, onEstimate}: Props) {
  const { currency } = useSession();
  const home = category === "Real estate";
  const [state, setState] = useState(""), [price, setPrice] = useState(purchaseMinor === null ? "" : minorToInput(purchaseMinor, currency));
  const [date, setDate] = useState(purchased), [model, setModel] = useState(description);
  const [result, setResult] = useState<AssetEstimate | null>(null), [sales, setSales] = useState<ReturnType<typeof vehicleEstimate>["sales"]>([]);
  const [error, setError] = useState(""), [working, setWorking] = useState(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  function reset() {
    revision.current++; setResult(null); setSales([]); setWorking(false); setError(""); onEstimate(null);
  }
  async function research() {
    reset(); const current = revision.current; setWorking(true);
    try {
      const reference = await loadReference();
      if (current !== revision.current) return;
      const comparison = home ? { estimate: houseEstimate(reference, state, parseAmount(price, currency), date, todayISO()), sales: [] }
        : vehicleEstimate(reference, model.trim(), todayISO());
      setResult(comparison.estimate); setSales(comparison.sales); onEstimate(comparison.estimate);
    } catch (err) { if (revision.current === current) setError(err instanceof Error ? err.message : "Lookup unavailable."); }
    finally { if (revision.current === current) setWorking(false); }
  }
  if (currency !== "USD") return <p>These U.S. reference sources report values in USD. You can enter a value in {currency} using a guide below.</p>;
  return <div>
    {home ? <>
      <p>Estimate how a U.S. single-family home's purchase price has changed using its state's house price index.</p>
      <div className="asset-fields">
        <Field label="U.S. state or DC"><select value={state} onChange={e => {reset(); setState(e.target.value);}}><option value="">Choose state</option>{states.map(s => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Original price (USD)"><input inputMode="decimal" value={price} onChange={e => {reset(); setPrice(e.target.value);}} /></Field>
        <Field label="Original purchase date"><input type="date" max={todayISO()} value={date} onChange={e => {reset(); setDate(e.target.value);}} /></Field>
      </div></> : <>
      <Field label="Model year, make and model"><input value={model} maxLength={120} onChange={e => {reset(); setModel(e.target.value);}} placeholder="2014 Ford Escape"/></Field>
      <p>Compare recent U.S. government fleet auction sales. Mileage, condition and local retail prices may differ.</p></>}
    <button className="btn-secondary" type="button" disabled={working || (home ? !(state && price && date) : !model.trim())} onClick={() => void research()}>{working ? "Checking reference data…" : "Research value"}</button>
    <div aria-live="polite">{error && <Notice>{error}</Notice>}{result && <div className="research-result">
      <p className="kicker">{home ? "State index estimate" : "Fleet auction estimate"}</p><p className="figure"><Money minor={result.amountMinor}/></p>
      <p>{home ? "Index through " : "Most recent matched sale "}{result.asOf}</p>
      {home ? <p>{state} statewide index · <a href={indexUrl} target="_blank" rel="noreferrer">FHFA house price data</a></p> :
        <details><summary>View {sales.length} comparable {sales.length === 1 ? "sale" : "sales"}</summary>{sales.map(s => <p key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a><br/>{s.date} · <Money minor={s.price}/></p>)}</details>}
    </div>}</div>
    {!home && <small>Sale records adapted from <a href={fleetSource} target="_blank" rel="noreferrer">UXSearch</a> under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>.</small>}
  </div>;
}
