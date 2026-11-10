import { useState } from "react";
import { api, downloadFile } from "../api.js";
import { parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

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
  const state = useLoad(() => api<{ positions: { holdingId: string; symbol: string; marketValueMinor: number | null; quoteSource: string; missing: string[] }[]; allocation: { key: string; weightBps: number; valueMinor: number }[]; note: string }>(scoped(session.householdId, "/investments")), [session.householdId, session.tick]);
  const accounts = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  const fees = useFormError();
  const [feeNote, setFeeNote] = useState("");
  if (!state.data) return state.loading ? <Loading /> : <ErrorNote message={state.error ?? "No investments"} />;
  return (
    <Page title="Investments" lede={state.data.note}>
      <ul className="list">{state.data.positions.map((position) => <li key={position.holdingId}><span>{position.symbol} · {position.quoteSource}{position.missing[0] ? ` · ${position.missing[0]}` : ""}</span><span>{position.marketValueMinor == null ? "No price" : <Money minor={position.marketValueMinor} />}</span></li>)}</ul>
      <ul>{state.data.allocation.map((slice) => <li key={slice.key}>{slice.key}: {(slice.weightBps / 100).toFixed(1)}%</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/holdings"), { method: "POST", body: JSON.stringify({
          accountId: data.get("accountId"), symbol: data.get("symbol"), name: data.get("name"), assetClass: data.get("assetClass"),
          quantity: data.get("quantity"), currency: session.currency, costBasisMinor: data.get("cost") ? parseAmount(String(data.get("cost")), session.currency) : null,
          priceMinor: data.get("price") ? parseAmount(String(data.get("price")), session.currency) : undefined, priceAsOf: todayISO(),
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
        <p className="muted">Leave the price blank and the value stays missing. BudgetCents does not invent a quote.</p>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save holding</button>
      </form>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => fees.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ compoundFeeCostMinor: number; assumptions: string[] }>(scoped(session.householdId, "/fees"), { method: "POST", body: JSON.stringify({
          balanceMinor: parseAmount(String(data.get("balance")), session.currency), expenseRatioBps: Math.round(Number(data.get("expense")) * 100),
          advisoryBps: Math.round(Number(data.get("advice") || 0) * 100), growthBps: Math.round(Number(data.get("growth")) * 100), years: Number(data.get("years")),
        }) });
        setFeeNote(`${result.assumptions[0]} Compound cost ${result.compoundFeeCostMinor} minor units.`);
      })}>
        <h2>Fee drag</h2>
        <Field label="Balance"><input name="balance" required inputMode="decimal" /></Field>
        <Field label="Expense ratio percent"><input name="expense" required inputMode="decimal" /></Field>
        <Field label="Advice percent"><input name="advice" inputMode="decimal" defaultValue="0" /></Field>
        <Field label="Growth percent"><input name="growth" required inputMode="decimal" /></Field>
        <Field label="Years"><input name="years" type="number" required defaultValue={10} /></Field>
        {fees.error ? <Notice kind="bad">{fees.error}</Notice> : null}
        {feeNote ? <Notice>{feeNote}</Notice> : null}
        <button className="btn" type="submit">Compare</button>
      </form>
    </Page>
  );
}

export function Retirement() {
  const session = useSession();
  const form = useFormError();
  const [result, setResult] = useState("");
  return (
    <Page title="Retirement" lede="The model is a seeded simulation. A success rate is not a promise, and it does not use live market data.">
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const response = await api<{ result: { successRateBps: number; assumptions: string[] }; contributionGap: { annualMinor: number } | null }>(scoped(session.householdId, "/retirement"), { method: "POST", body: JSON.stringify({
          currentAge: Number(data.get("age")), retireAge: Number(data.get("retire")), endAge: Number(data.get("end")),
          portfolioMinor: parseAmount(String(data.get("portfolio")), session.currency), annualContributionMinor: parseAmount(String(data.get("save")), session.currency),
          annualSpendingMinor: parseAmount(String(data.get("spend")), session.currency), inflationBps: 250, meanReturnBps: 500, stdevBps: 1200, feeBps: 10, iterations: 200, seed: 7,
        }) });
        setResult(`${(response.result.successRateBps / 100).toFixed(1)}% of the seeded paths stayed above zero. ${response.result.assumptions.join(" ")}`);
      })}>
        <Field label="Age"><input name="age" type="number" required defaultValue={35} /></Field>
        <Field label="Retire"><input name="retire" type="number" required defaultValue={65} /></Field>
        <Field label="Plan through"><input name="end" type="number" required defaultValue={90} /></Field>
        <Field label="Portfolio"><input name="portfolio" required inputMode="decimal" /></Field>
        <Field label="Annual contribution"><input name="save" required inputMode="decimal" /></Field>
        <Field label="Annual spending"><input name="spend" required inputMode="decimal" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {result ? <Notice>{result}</Notice> : null}
        <button className="btn" type="submit">Run model</button>
      </form>
    </Page>
  );
}

export function Reports() {
  const session = useSession();
  const [by, setBy] = useState("bucket");
  const [payee, setPayee] = useState("");
  const spending = useLoad(() => api<{ rows: { label: string; amountMinor: number }[]; totalMinor: number; formula: string; from: string; to: string }>(scoped(session.householdId, `/reports/spending?by=${by}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, by]);
  const rate = useLoad(() => api<{ rateBps: number | null; formula: string; incomeMinor: number; spendingMinor: number }>(scoped(session.householdId, "/reports/savings-rate", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const watch = useLoad(() => payee ? api<{ totalMinor: number; formula: string }>(scoped(session.householdId, `/reports/watchlist?payee=${encodeURIComponent(payee)}`, session.spaceId)) : Promise.resolve(null), [payee, session.householdId, session.spaceId]);
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
        <li key={row.label}><span style={{ flex: 1 }}>{row.label}<span className="bar" style={{ marginTop: 6 }}><span style={{ width: `${Math.abs(row.amountMinor) / max * 100}%` }} /></span></span><Money minor={row.amountMinor} /></li>
      ))}</ul>
      <article className="card"><h2>Savings rate</h2><p>{rate.data.rateBps == null ? "Needs income in the period." : `${(rate.data.rateBps / 100).toFixed(1)}%`}</p><p className="formula">{rate.data.formula}</p></article>
      <form className="card" onSubmit={(event) => { event.preventDefault(); setPayee(String(new FormData(event.currentTarget).get("payee") || "")); }}>
        <h2>Watchlist</h2>
        <Field label="Payee contains"><input name="payee" /></Field>
        <button className="btn" type="submit">Check</button>
        {watch.data ? <p>{watch.data.formula} Total <Money minor={watch.data.totalMinor} />.</p> : null}
      </form>
    </Page>
  );
}
