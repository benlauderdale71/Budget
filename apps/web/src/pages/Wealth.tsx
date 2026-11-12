import { useState } from "react";
import { MonthlyDistribution } from "./MonthlyRetirement.js";
import { InvestmentLots } from "./InvestmentLots.js";
import { Link } from "react-router-dom";
import { api, downloadFile } from "../api.js";
import { parseAmount } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, SankeyChart, useFormError, useLoad } from "../ui.js";

export function Wealth() {
  const session = useSession();
  const state = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  if (state.loading && !state.data) return <Loading label="Loading net worth" />;
  if (!state.data) return <ErrorNote message={state.error ?? "No net worth"} onRetry={session.bump} />;
  const worth = state.data.netWorth;
  return (
    <Page title="Wealth" lede={worth.formula}>
      <div className="grid three">
        <article className="card"><p className="kicker">Net</p><p className="figure"><Money minor={worth.netMinor} /></p></article>
        <article className="card"><p className="kicker">Assets</p><p className="figure"><Money minor={worth.assetsMinor} /></p></article>
        <article className="card"><p className="kicker">Owed</p><p className="figure"><Money minor={worth.liabilitiesMinor} /></p></article>
      </div>
      <table className="card" style={{ marginTop: 16 }}>
        <thead><tr><th>Account</th><th className="num">Shown balance</th><th className="num">In net worth</th></tr></thead>
        <tbody>{worth.accounts.map((account) => <tr key={account.accountId}><td>{account.name}{account.liquid ? " · liquid" : ""}</td><td className="num"><Money minor={account.displayMinor} /></td><td className="num"><Money minor={account.contributionMinor} /></td></tr>)}</tbody>
      </table>
    </Page>
  );
}

export function Investments() {
  const session = useSession();
  const state = useLoad(() => api<{ positions: { holdingId: string; symbol: string; name: string; quantity: string; assetClass: string; currency: string; marketValueMinor: number | null; costBasisMinor: number | null; unrealizedMinor: number | null; quoteSource: string; quoteAsOf: string | null; missing: string[] }[]; allocation: { key: string; weightBps: number; valueMinor: number }[]; coverage: { holdingCount: number; pricedCount: number; complete: boolean }; note: string }>(scoped(session.householdId, "/investments")), [session.householdId, session.tick]);
  const accounts = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  const fees = useFormError();
  const drift = useFormError();
  const returns = useFormError();
  const [feeNote, setFeeNote] = useState<{ cost: number; assumptions: string[] } | null>(null);
  const [driftNote, setDriftNote] = useState("");
  const [returnNote, setReturnNote] = useState("");
  if (!state.data) return state.loading ? <Loading /> : <ErrorNote message={state.error ?? "No investments"} />;
  return (
    <Page title="Investments" lede={state.data.note}>
      <p>{state.data.coverage.pricedCount} of {state.data.coverage.holdingCount} visible holdings have a price. {state.data.coverage.complete ? "The allocation covers the whole visible portfolio." : "The allocation covers only the priced holdings."}</p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Holding</th><th>Quantity</th><th>Price</th><th className="num">Value</th><th className="num">Gain</th></tr></thead>
          <tbody>{state.data.positions.map((position) => (
            <tr key={position.holdingId}>
              <td data-label="Holding">{position.symbol} · {position.name} · {position.assetClass}<br /><span className="muted">{position.quoteSource}{position.quoteAsOf ? ` · ${position.quoteAsOf}` : ""} · {position.currency}{position.missing.map((item) => ` · ${item}`).join("")}</span></td>
              <td data-label="Quantity">{position.quantity}</td>
              <td data-label="Price">{position.marketValueMinor == null ? "No price" : position.quoteSource}</td>
              <td className="num" data-label="Value">{position.marketValueMinor == null ? "No price" : <Money minor={position.marketValueMinor} />}</td>
              <td className="num" data-label="Gain">{position.unrealizedMinor == null ? "No gain calculated" : <Money minor={position.unrealizedMinor} />}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <ul>{state.data.allocation.map((slice) => <li key={slice.key}>{slice.key}: {(slice.weightBps / 100).toFixed(1)}% · <Money minor={slice.valueMinor} /></li>)}</ul>
      <LotForm positions={state.data.positions.map((position) => ({ id: position.holdingId, symbol: position.symbol, currency: position.currency }))} />
      <InvestmentLots key={session.householdId} />
      <MarketPriceForm positions={state.data.positions.filter((position) => position.currency === "USD").map((position) => ({ id: position.holdingId, symbol: position.symbol }))} />
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/holdings"), { method: "POST", body: JSON.stringify({
          accountId: data.get("accountId"), symbol: data.get("symbol"), name: data.get("name"), assetClass: data.get("assetClass"),
          quantity: data.get("quantity"), currency: session.currency, costBasisMinor: data.get("cost") ? parseAmount(String(data.get("cost")), session.currency) : null,
          priceMinor: data.get("price") ? parseAmount(String(data.get("price")), session.currency) : undefined, priceAsOf: String(data.get("priceAsOf") || "2026-11-11"),
        }) });
        session.bump();
      })}>
        <h2>Add a holding</h2>
        <Field label="Account"><select name="accountId" required>{accounts.data?.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        <Field label="Symbol"><input name="symbol" required /></Field>
        <Field label="Name"><input name="name" required /></Field>
        <Field label="Asset class"><input name="assetClass" defaultValue="equity" /></Field>
        <Field label="Quantity"><input name="quantity" required /></Field>
        <Field label="Cost basis"><input name="cost" inputMode="decimal" /></Field>
        <Field label="Manual price per share"><input name="price" inputMode="decimal" /></Field>
        <Field label="Valuation date"><input name="priceAsOf" type="date" defaultValue="2026-11-11" /></Field>
        <p className="muted">Leave the price blank and the value stays missing. BudgetCents does not invent a quote. A price in another currency is not converted.</p>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save holding</button>
      </form>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => fees.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ compoundFeeCostMinor: number; assumptions: string[] }>(scoped(session.householdId, "/fees"), { method: "POST", body: JSON.stringify({
          balanceMinor: parseAmount(String(data.get("balance")), session.currency), expenseRatioBps: Math.round(Number(data.get("expense")) * 100),
          advisoryBps: Math.round(Number(data.get("advice") || 0) * 100), growthBps: Math.round(Number(data.get("growth")) * 100), years: Number(data.get("years")),
        }) });
        setFeeNote({ cost: result.compoundFeeCostMinor, assumptions: result.assumptions });
      })}>
        <h2>Fee drag</h2>
        <Field label="Balance"><input name="balance" required inputMode="decimal" /></Field>
        <Field label="Expense ratio percent"><input name="expense" required inputMode="decimal" /></Field>
        <Field label="Advice percent"><input name="advice" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Growth percent"><input name="growth" required inputMode="decimal" /></Field>
        <Field label="Years"><input name="years" type="number" required defaultValue={10} /></Field>
        {fees.error ? <Notice kind="bad">{fees.error}</Notice> : null}
        {feeNote ? <Notice>The fee difference over the period you entered is <Money minor={feeNote.cost} />. {feeNote.assumptions.join(" ")} This is not a prediction of what the holding will earn.</Notice> : null}
        <button className="btn" type="submit">Compare</button>
      </form>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => drift.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ drift: { key: string; actualBps: number; targetBps: number; driftBps: number }[]; note: string }>(scoped(session.householdId, "/investments/drift"), { method: "POST", body: JSON.stringify({
          targets: [
            { key: String(data.get("keyA")), targetBps: Math.round(Number(data.get("targetA")) * 100) },
            { key: String(data.get("keyB")), targetBps: Math.round(Number(data.get("targetB")) * 100) },
          ].filter((target) => target.key),
        }) });
        setDriftNote(`${result.note} ${result.drift.map((row) => `${row.key} actual ${(row.actualBps / 100).toFixed(1)}% target ${(row.targetBps / 100).toFixed(1)}% drift ${(row.driftBps / 100).toFixed(1)} points`).join(". ")}`);
      })}>
        <h2>Target allocation</h2>
        <Field label="First class"><input name="keyA" defaultValue="equity" /></Field>
        <Field label="First target percent"><input name="targetA" inputMode="decimal" defaultValue="50" /></Field>
        <Field label="Second class"><input name="keyB" defaultValue="bond" /></Field>
        <Field label="Second target percent"><input name="targetB" inputMode="decimal" defaultValue="50" /></Field>
        {drift.error ? <Notice kind="bad">{drift.error}</Notice> : null}
        {driftNote ? <Notice>{driftNote}</Notice> : null}
        <button className="btn" type="submit">Compare drift</button>
      </form>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => returns.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ timeWeighted: { rate: number | null; method: string }; moneyWeighted: { rate: number | null; method: string }; note: string }>(scoped(session.householdId, "/investments/return"), { method: "POST", body: JSON.stringify({
          startValueMinor: parseAmount(String(data.get("start")), session.currency),
          endValueMinor: parseAmount(String(data.get("end")), session.currency),
          externalFlowMinor: parseAmount(String(data.get("flow") || "0"), session.currency),
          startDate: String(data.get("startDate")),
          endDate: String(data.get("endDate")),
        }) });
        const percent = (rate: number | null) => rate == null ? "not available" : `${(rate * 100).toFixed(2)}%`;
        setReturnNote(`Time-weighted ${percent(result.timeWeighted.rate)}. ${result.timeWeighted.method} Money-weighted ${percent(result.moneyWeighted.rate)}. ${result.moneyWeighted.method} ${result.note}`);
      })}>
        <h2>Return from amounts you type</h2>
        <Field label="Start value"><input name="start" required inputMode="decimal" /></Field>
        <Field label="Start date"><input name="startDate" type="date" required defaultValue="2026-01-01" /></Field>
        <Field label="Deposit or withdrawal"><input name="flow" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="End value"><input name="end" required inputMode="decimal" /></Field>
        <Field label="End date"><input name="endDate" type="date" required defaultValue="2026-11-11" /></Field>
        <p className="muted">Enter a deposit as a positive amount. It is removed from the return so it does not look like investment growth.</p>
        {returns.error ? <Notice kind="bad">{returns.error}</Notice> : null}
        {returnNote ? <Notice>{returnNote}</Notice> : null}
        <button className="btn" type="submit">Calculate return</button>
      </form>
    </Page>
  );
}

function MarketPriceForm({ positions }: { positions: { id: string; symbol: string }[] }) {
  const session = useSession();
  const access = useAccess();
  const form = useFormError();
  const [holdingId, setHoldingId] = useState(positions[0]?.id ?? "");
  const [preview, setPreview] = useState<{ previewId: string; quote: { symbol: string; priceMinor: number; asOf: string; retrievedAt: string }; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!positions.length) return null;
  return <form className="card" onSubmit={(event) => form.run(event, async () => {
    if (busy) return;
    setBusy(true); setSaved(false);
    try {
      if (preview) {
        await api(scoped(session.householdId, `/holdings/${holdingId}/quote/confirm`), { method: "POST", body: JSON.stringify({ previewId: preview.previewId }) });
        setPreview(null); setSaved(true); session.bump();
      } else setPreview(await api(scoped(session.householdId, `/holdings/${holdingId}/quote/preview`), { method: "POST", body: "{}" }));
    } finally { setBusy(false); }
  })}>
    <h2>Market price</h2>
    <p>Fetch a U.S. stock or ETF price from Finnhub. A server key and a suitable personal-use plan are required. Manual prices remain available.</p>
    <Field label="Holding"><select value={holdingId} disabled={busy} onChange={(event) => { setHoldingId(event.target.value); setPreview(null); setSaved(false); }}>{positions.map((position) => <option key={position.id} value={position.id}>{position.symbol}</option>)}</select></Field>
    {preview ? <Notice>{preview.quote.symbol}: <Money minor={preview.quote.priceMinor} /> USD per share. Quoted {preview.quote.asOf}; retrieved {preview.quote.retrievedAt}. {preview.note}</Notice> : null}
    {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
    {saved ? <Notice>Price saved. Cash and the transaction register were unchanged.</Notice> : null}
    <button className="btn" disabled={busy || session.offline || !access.canWrite} type="submit">{busy ? "Working…" : preview ? "Confirm market price" : "Preview market price"}</button>
    {preview ? <button type="button" className="btn secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel preview</button> : null}
  </form>;
}

interface RetirementResponse {
  result: {
    successRateBps: number;
    deterministicEndingMinor: number;
    deterministicUnmetMinor: number;
    deterministicSuccess: boolean;
    p10EndingMinor: number;
    medianEndingMinor: number;
    p90EndingMinor: number;
    metric: string;
    assumptions: string[];
    yearlyDeterministic: { householdAge: number; portfolioMinor: number; contributionMinor: number; spendingMinor: number; benefitMinor: number; unmetMinor: number; people: { modeledAge: number; retired: boolean }[] }[];
  };
}

function LotForm({ positions }: { positions: { id: string; symbol: string; currency: string }[] }) {
  const session = useSession(); const access = useAccess(); const form = useFormError();
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<{ fingerprint: string; id: string } | null>(null);
  const [finished, setFinished] = useState(false);
  if (!positions.length) return <p className="muted">Add a holding before recording a lot. A missing cost basis stays missing.</p>;
  return <form className="card" onChange={() => setFinished(false)} onSubmit={(event) => form.run(event, async () => {
    if (busy || finished) return;
    const data = new FormData(event.currentTarget); const holding = positions.find((p) => p.id === data.get("holdingId"))!;
    const shares = String(data.get("shares"));
    if (!/^\d+(\.\d{1,6})?$/.test(shares)) throw new Error("Use at most six decimal places for shares.");
    const [whole, fraction = ""] = shares.split(".");
    const body = { holdingId: holding.id, quantityMicro: Number(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"))), costBasisMinor: data.get("basis") ? parseAmount(String(data.get("basis")), holding.currency) : null, acquired: String(data.get("acquired")) };
    const fingerprint = JSON.stringify(body); const opId = operation?.fingerprint === fingerprint ? operation.id : crypto.randomUUID();
    setOperation({ fingerprint, id: opId }); setBusy(true);
    try { await api(scoped(session.householdId, "/lots"), { method: "POST", body: JSON.stringify({ ...body, opId }) });
      setNote("Lot recorded. It describes shares already in this holding and does not add a cash transaction."); setFinished(true); session.bump();
    } finally { setBusy(false); }
  })}>
    <h2>Tax lot</h2>
    <Field label="Holding"><select name="holdingId">{positions.map((p) => <option key={p.id} value={p.id}>{p.symbol} · {p.currency}</option>)}</select></Field>
    <Field label="Shares"><input name="shares" required inputMode="decimal" defaultValue="1" /></Field>
    <Field label="Cost basis in the holding’s currency"><input name="basis" inputMode="decimal" /></Field>
    <Field label="Acquired"><input name="acquired" required type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
    {form.error && <Notice kind="bad">{form.error}</Notice>}{note && <Notice>{note}</Notice>}
    <button className="btn" disabled={busy || finished || session.offline || !access.canWrite}>{finished ? "Lot saved" : "Save lot"}</button>
  </form>;
}

export function Retirement() {
  const session = useSession();
  const form = useFormError();
  const [result, setResult] = useState<RetirementResponse["result"] | null>(null);
  const [partner, setPartner] = useState(false);
  return (
    <Page title="Retirement" lede="The model is a seeded simulation. Success means every modeled year was funded. A success rate is not a promise, and running it does not change your accounts.">
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const bps = (name: string) => Math.round(Number(data.get(name) || 0) * 100);
        const personA = {
          currentAge: Number(data.get("ageA")),
          retireAge: Number(data.get("retireA")),
          benefitAge: Number(data.get("benefitA")),
          socialSecurityAnnualMinor: parseAmount(String(data.get("socialA") || "0"), session.currency),
          pensionAnnualMinor: parseAmount(String(data.get("pensionA") || "0"), session.currency),
        };
        const people = [personA];
        if (partner) {
          people.push({
            currentAge: Number(data.get("ageB")),
            retireAge: Number(data.get("retireB")),
            benefitAge: Number(data.get("benefitB")),
            socialSecurityAnnualMinor: parseAmount(String(data.get("socialB") || "0"), session.currency),
            pensionAnnualMinor: parseAmount(String(data.get("pensionB") || "0"), session.currency),
          });
        }
        const events = String(data.get("eventAmount") || "").trim()
          ? [{ age: Number(data.get("eventAge")), amountMinor: parseAmount(String(data.get("eventAmount")), session.currency), label: String(data.get("eventLabel") || "Life event") }]
          : undefined;
        const response = await api<RetirementResponse>(scoped(session.householdId, "/retirement"), { method: "POST", body: JSON.stringify({
          currentAge: Number(data.get("clock")), retireAge: personA.retireAge, endAge: Number(data.get("end")),
          portfolioMinor: parseAmount(String(data.get("portfolio")), session.currency),
          annualContributionMinor: parseAmount(String(data.get("save")), session.currency),
          annualSpendingMinor: parseAmount(String(data.get("spend")), session.currency),
          inflationBps: bps("inflation"), meanReturnBps: bps("growth"), stdevBps: bps("spread"), feeBps: bps("fee"),
          iterations: Number(data.get("iterations")), seed: Number(data.get("seed")), people, events,
        }) });
        setResult(response.result);
      })}>
        <h2>Household clock</h2>
        <Field label="Planning age"><input name="clock" type="number" required defaultValue={60} /></Field>
        <Field label="Plan through"><input name="end" type="number" required defaultValue={76} /></Field>
        <h2>Person A</h2>
        <Field label="Current age"><input name="ageA" type="number" required defaultValue={60} /></Field>
        <Field label="Retirement age"><input name="retireA" type="number" required defaultValue={65} /></Field>
        <Field label="Social Security age"><input name="benefitA" type="number" required defaultValue={67} /></Field>
        <Field label="Annual Social Security"><input name="socialA" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Annual pension"><input name="pensionA" inputMode="decimal" defaultValue="0" /></Field>
        <label><input type="checkbox" checked={partner} onChange={(event) => setPartner(event.target.checked)} /> Add a second person</label>
        {partner ? (
          <>
            <h2>Person B</h2>
            <Field label="Current age"><input name="ageB" type="number" required defaultValue={50} /></Field>
            <Field label="Retirement age"><input name="retireB" type="number" required defaultValue={65} /></Field>
            <Field label="Social Security age"><input name="benefitB" type="number" required defaultValue={65} /></Field>
            <Field label="Annual Social Security"><input name="socialB" inputMode="decimal" defaultValue="0" /></Field>
            <Field label="Annual pension"><input name="pensionB" inputMode="decimal" defaultValue="0" /></Field>
          </>
        ) : null}
        <h2>Money</h2>
        <Field label="Portfolio"><input name="portfolio" required inputMode="decimal" /></Field>
        <Field label="Annual contribution"><input name="save" required inputMode="decimal" /></Field>
        <Field label="Annual spending"><input name="spend" required inputMode="decimal" /></Field>
        <Field label="Inflation percent"><input name="inflation" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Expected return percent"><input name="growth" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Return spread percent"><input name="spread" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Fee percent"><input name="fee" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Trials"><input name="iterations" type="number" defaultValue={20} /></Field>
        <Field label="Seed"><input name="seed" type="number" defaultValue={7} /></Field>
        <h2>Life event on the household clock</h2>
        <Field label="Household age"><input name="eventAge" type="number" /></Field>
        <Field label="Amount"><input name="eventAmount" inputMode="decimal" /></Field>
        <Field label="Label"><input name="eventLabel" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Run model</button>
      </form>
      {result ? (
        <>
          <article className="card" style={{ marginTop: 16 }}>
            <h2>Deterministic result</h2>
            <p>Ending portfolio <Money minor={result.deterministicEndingMinor} />. Unmet spending <Money minor={result.deterministicUnmetMinor} />. {result.deterministicSuccess ? "Every deterministic year was funded." : "An earlier year was not funded. A later balance does not erase that."}</p>
          </article>
          <article className="card" style={{ marginTop: 16 }}>
            <h2>Simulated range</h2>
            <p>{(result.successRateBps / 100).toFixed(1)}% of the seeded trials funded every year. {result.metric}</p>
            <p>Low <Money minor={result.p10EndingMinor} />. Middle <Money minor={result.medianEndingMinor} />. High <Money minor={result.p90EndingMinor} />.</p>
          </article>
          <article className="card" style={{ marginTop: 16 }}>
            <h2>Assumptions</h2>
            <ul>{result.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
          <div className="table-scroll" style={{ marginTop: 16 }}>
            <table className="schedule-table">
              <thead><tr><th>Clock</th><th>Ages</th><th className="num">Contribution</th><th className="num">Spending</th><th className="num">Portfolio</th></tr></thead>
              <tbody>{result.yearlyDeterministic.map((year) => (
                <tr key={year.householdAge}>
                  <td data-label="Clock">{year.householdAge}</td>
                  <td data-label="Ages">{year.people.map((person) => `${person.modeledAge}${person.retired ? " retired" : ""}`).join(", ")}</td>
                  <td className="num" data-label="Contribution"><Money minor={year.contributionMinor} /></td>
                  <td className="num" data-label="Spending"><Money minor={year.spendingMinor} /></td>
                  <td className="num" data-label="Portfolio"><Money minor={year.portfolioMinor} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ) : null}
      <MonthlyDistribution />
    </Page>
  );
}

export function Reports() {
  const session = useSession();
  const [by, setBy] = useState("bucket");
  const [payee, setPayee] = useState("");
  const spending = useLoad(() => api<{ rows: { key: string; label: string; amountMinor: number; transactionIds: string[] }[]; totalMinor: number; formula: string; from: string; to: string }>(scoped(session.householdId, `/reports/spending?by=${by}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, by]);
  const rate = useLoad(() => api<{ rateBps: number | null; formula: string; incomeMinor: number; spendingMinor: number }>(scoped(session.householdId, "/reports/savings-rate", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const watch = useLoad(() => payee ? api<{ actualMinor: number; formula: string }>(scoped(session.householdId, `/reports/watchlist?payee=${encodeURIComponent(payee)}`, session.spaceId)) : Promise.resolve(null), [payee, session.householdId, session.spaceId]);
  const flow = useLoad(() => api<{ links: { source: string; target: string; amountMinor: number }[] }>(scoped(session.householdId, "/reports/sankey", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  if (!spending.data || !rate.data) return <Loading label="Loading reports" />;
  const max = Math.max(1, ...spending.data.rows.map((row) => Math.abs(row.amountMinor)));
  return (
    <Page title="Reports" lede={spending.data.formula} actions={<div className="row">
      <button className="btn-secondary" onClick={() => downloadFile(scoped(session.householdId, "/exports/transactions.csv", session.spaceId), "budgetcents-transactions.csv")}>CSV</button>
      <button className="btn-secondary" onClick={() => downloadFile(scoped(session.householdId, "/exports/report.pdf", session.spaceId), "budgetcents-report.pdf")}>PDF</button>
    </div>}>
      <div className="chips">
        {["bucket", "payee", "tag"].map((item) => <button key={item} className="chip" aria-pressed={by === item} onClick={() => setBy(item)}>{item}</button>)}
      </div>
      <p>Total <Money minor={spending.data.totalMinor} /> from {spending.data.from} to {spending.data.to}.</p>
      <ul className="list">{spending.data.rows.map((row) => (
        <li key={row.key || row.label}><span style={{ flex: 1 }}>{row.transactionIds.length ? <Link to={`/activity?ids=${encodeURIComponent(row.transactionIds.join(","))}`}>{row.label}</Link> : row.label}<span className="bar" style={{ marginTop: 6 }}><span style={{ width: `${Math.abs(row.amountMinor) / max * 100}%` }} /></span></span><Money minor={row.amountMinor} /></li>
      ))}</ul>
      <article className="card"><h2>Savings rate</h2><p>{rate.data.rateBps == null ? "Needs income in the period." : `${(rate.data.rateBps / 100).toFixed(1)}%`}</p><p className="formula">{rate.data.formula}</p></article>
      <article className="card"><h2>Cash flow</h2><p className="muted">Income flows into spending, then into category groups. Transfers and card payments are not a second expense.</p>{flow.data ? <SankeyChart links={flow.data.links} /> : <p className="muted">{flow.error ?? "Loading cash flow…"}</p>}</article>
      <form className="card" onSubmit={(event) => { event.preventDefault(); setPayee(String(new FormData(event.currentTarget).get("payee") || "")); }}>
        <h2>Watchlist</h2>
        <Field label="Payee contains"><input name="payee" /></Field>
        <button className="btn" type="submit">Check</button>
        {watch.error ? <Notice kind="bad">{watch.error}</Notice> : null}
        {watch.data ? <p>{watch.data.formula} Total <Money minor={watch.data.actualMinor} />.</p> : null}
      </form>
    </Page>
  );
}
