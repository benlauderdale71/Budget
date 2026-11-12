import { useEffect, useState } from "react";
import { api } from "../api.js";
import { parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import { Field, Money, Notice, useFormError } from "../ui.js";

type Result = { assumptions: string[]; comparison: { strategy: string; endingMinor: number; taxMinor: number; unmetSpendingMinor: number }[]; months: { month: number; portfolioMinor: number; traditionalMinor: number; otherMinor: number; withdrawalMinor: number; rmdMinor: number; taxMinor: number; fundedSpendingMinor: number; unmetSpendingMinor: number; unmetRmdMinor: number }[] };
export function MonthlyDistribution() {
  const session = useSession(); const form = useFormError();
  const [result, setResult] = useState<Result | null>(null); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  useEffect(() => dirty ? session.holdDraft() : undefined, [dirty]);
  return <section className="card" style={{ marginTop: 16 }}>
    <form onChange={() => { setDirty(true); setResult(null); }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      const amount = (name: string) => parseAmount(String(data.get(name) || "0"), session.currency);
      setBusy(true);
      try { setResult(await api<Result>(scoped(session.householdId, "/retirement/monthly"), { method: "POST", body: JSON.stringify({
        portfolioMinor: amount("portfolio"), traditionalMinor: amount("traditional"), priorYearTraditionalMinor: data.get("prior") ? amount("prior") : undefined,
        annualSpendingMinor: amount("spending"), annualContributionMinor: amount("contribution"), annualReturnBps: Math.round(Number(data.get("return")) * 100), taxBps: Math.round(Number(data.get("tax")) * 100), age: Number(data.get("age")), birthYear: Number(data.get("birth")), months: Number(data.get("months")), strategy: data.get("strategy"), inheritedAccount: data.get("inherited") === "on", youngerSpouseSoleBeneficiary: data.get("spouse") === "on",
      }) })); } finally { setBusy(false); }
    })}>
      <h2>Monthly retirement and withdrawal comparison</h2>
      <p>This starts January 1 and compares two withdrawal orders using your assumptions. It does not change your accounts. Traditional withdrawals fund both spending and the assumed tax; unused required distributions remain in other funds.</p>
      <div className="grid two">
        <Field label="Total portfolio"><input name="portfolio" required inputMode="decimal" defaultValue="100000.00" /></Field>
        <Field label="Traditional portion"><input name="traditional" required inputMode="decimal" defaultValue="70000.00" /></Field>
        <Field label="Prior December 31 traditional balance (optional)"><input name="prior" inputMode="decimal" /></Field>
        <Field label="Annual spending after tax"><input name="spending" required inputMode="decimal" defaultValue="12000.00" /></Field>
        <Field label="Annual traditional contributions"><input name="contribution" required inputMode="decimal" defaultValue="0.00" /></Field>
        <Field label="Assumed annual return percent"><input name="return" required inputMode="decimal" defaultValue="4" /></Field>
        <Field label="Assumed tax percent on traditional withdrawals"><input name="tax" required inputMode="decimal" defaultValue="22" /></Field>
        <Field label="Age at December 31 of the starting year"><input name="age" type="number" min="0" max="120" required defaultValue={73} /></Field>
        <Field label="Birth year"><input name="birth" type="number" required defaultValue={1953} /></Field>
        <Field label="Months"><input name="months" type="number" min="1" max="600" required defaultValue={12} /></Field>
        <Field label="Order for monthly details"><select name="strategy"><option value="other_first">Other funds first</option><option value="traditional_first">Traditional first</option></select></Field>
      </div>
      <label><input name="inherited" type="checkbox" /> This is an inherited account.</label><br />
      <label><input name="spouse" type="checkbox" /> My spouse is the sole beneficiary and more than ten years younger.</label>
      <p>Those two cases require a different distribution table and cannot be calculated here. Other funds have no modeled tax. This is a simplified comparison, with no tax brackets, inflation, contribution limits, or early withdrawal penalties.</p>
      {form.error && <Notice kind="bad">{form.error}</Notice>}
      <button className="btn" type="submit" disabled={busy || session.offline}>{busy ? "Calculating…" : "Compare withdrawal orders"}</button>
    </form>
    {result && <>
      <div className="table-scroll"><table><thead><tr><th>Order</th><th>Ending portfolio</th><th>Tax paid</th><th>Unfunded spending</th></tr></thead><tbody>{result.comparison.map((r) => <tr key={r.strategy}><td>{r.strategy === "other_first" ? "Other funds first" : "Traditional first"}</td><td><Money minor={r.endingMinor} /></td><td><Money minor={r.taxMinor} /></td><td><Money minor={r.unmetSpendingMinor} /></td></tr>)}</tbody></table></div>
      <details><summary>Monthly amounts</summary><div className="table-scroll"><table><thead><tr><th>Month</th><th>Traditional withdrawal</th><th>Required distribution</th><th>Tax</th><th>Spending funded</th><th>Spending shortfall</th><th>RMD shortfall</th><th>Portfolio left</th></tr></thead><tbody>{result.months.map((r) => <tr key={r.month}><td>{r.month}</td><td><Money minor={r.withdrawalMinor} /></td><td><Money minor={r.rmdMinor} /></td><td><Money minor={r.taxMinor} /></td><td><Money minor={r.fundedSpendingMinor} /></td><td><Money minor={r.unmetSpendingMinor} /></td><td><Money minor={r.unmetRmdMinor} /></td><td><Money minor={r.portfolioMinor} /></td></tr>)}</tbody></table></div></details>
      <details><summary>Calculation assumptions and source</summary><ul>{result.assumptions.map((a) => <li key={a}>{a}</li>)}</ul><a href="https://www.irs.gov/publications/p590b" target="_blank" rel="noreferrer">IRS Publication 590-B</a></details>
    </>}
  </section>;
}
