import { Link } from "react-router-dom";
import { useEffect } from "react";
import { api } from "../api.js";
import { monthLabel } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Loading, Money, useLoad } from "../ui.js";

export function Home() {
  const session = useSession();
  const state = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  useEffect(() => { if (state.data) session.adoptSpace(state.data.spaceId); }, [state.data?.spaceId]);
  if (state.loading && !state.data) return <Loading label="Loading the household" />;
  if (state.error || !state.data) return <ErrorNote message={state.error ?? "No dashboard"} onRetry={session.bump} />;
  const dash = state.data;
  const short = dash.guidance.primaryFigure === "shortage";
  const unread = dash.alerts.filter((alert) => !alert.read_at);
  return (
    <section>
      <header className="page-head">
        <div>
          <p className="kicker">{monthLabel(dash.budget.periodKey)}</p>
          <h1>{dash.household.name}</h1>
          <p className="lede">{dash.household.budgetApproach === "envelope" ? "Envelope view of the same cash." : "The plan and the register use the same transactions."}</p>
        </div>
        <div className="page-actions">
          {dash.spaces.length > 1 ? (
            <select aria-label="Space" value={session.spaceId ?? dash.spaceId} onChange={(event) => session.chooseSpace(event.target.value)}>
              {dash.spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
            </select>
          ) : null}
          <Link className="btn" to="/activity">Add transaction</Link>
        </div>
      </header>
      {dash.budget.identityDifferenceMinor !== 0 ? <div className="banner bad" role="alert">The plan does not match on-budget cash by <Money minor={dash.budget.identityDifferenceMinor} />. Review recent edits before relying on Ready to Assign.</div> : null}
      {dash.budget.warnings.filter((warning) => !warning.includes("identity")).map((warning) => <div key={warning} className="banner bad">{warning}</div>)}
      <div className="grid stats">
        <article className="card">
          <p className="kicker">{short ? "Short before upcoming bills" : "Safe to spend"}</p>
          <p className={`figure ${short ? "shortage" : ""}`}><Money minor={short ? dash.guidance.shortageMinor : dash.guidance.cashSafeMinor} tone={!short} /></p>
          <p className="formula">{dash.guidance.formula}</p>
          {dash.guidance.projectedUsesExpectedIncome ? <p className="muted">Projected allowance, including expected income that is not cash: <Money minor={dash.guidance.projectedAllowanceMinor} />. Daily cash figure: <Money minor={dash.guidance.dailyCashMinor} />.</p> : null}
        </article>
        <article className="card">
          <p className="kicker">Ready to Assign</p>
          <p className="figure"><Money minor={dash.budget.readyToAssignMinor} /></p>
          <p className="formula">{dash.explain.formula}</p>
        </article>
        <article className="card">
          <p className="kicker">Net worth</p>
          <p className="figure"><Money minor={dash.netWorth.netMinor} /></p>
          <p className="muted">Liquid <Money minor={dash.netWorth.liquidMinor} /></p>
        </article>
        <article className="card">
          <p className="kicker">Age of money</p>
          <p className="figure">{dash.ageOfMoney.days == null ? "—" : `${dash.ageOfMoney.days}d`}</p>
          <p className="formula">{dash.ageOfMoney.formula}</p>
        </article>
      </div>
      <div className="grid two" style={{ marginTop: 16 }}>
        <article className="card">
          <h2>This month</h2>
          <ul className="list">
            {dash.budget.buckets.filter((row) => !["Credit card payments", "Borrowed funds"].includes(row.name) && dash.buckets.find((bucket) => bucket.id === row.bucketId)?.kind === "expense").slice(0, 8).map((row) => {
              const width = Math.min(100, Math.abs(row.activityMinor) / Math.max(1, row.assignedMinor + row.activityMinor) * 100);
              return (
                <li key={row.bucketId}>
                  <div style={{ flex: 1 }}>
                    <div className="link-row"><span>{row.name}</span><Money minor={row.availableMinor} /></div>
                    <div className="bar" aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
                  </div>
                </li>
              );
            })}
          </ul>
          <p><Link to="/plan">Open the plan</Link></p>
        </article>
        <div className="grid">
          <article className="card">
            <div className="link-row"><h2>Upcoming</h2><Link to="/bills">Bills</Link></div>
            {dash.upcoming.length === 0 ? <p className="muted">Nothing scheduled in the next month.</p> : (
              <ul className="list">
                {dash.upcoming.slice(0, 6).map((item) => (
                  <li key={`${item.id}-${item.date}`}><span>{item.date} · {item.label}{item.expectedIncome ? " · expected" : ""}</span><Money minor={item.amountMinor} /></li>
                ))}
              </ul>
            )}
          </article>
          <article className="card">
            <div className="link-row">
              <h2>Alerts</h2>
              {unread.length ? <button className="btn-quiet" onClick={async () => { await api(scoped(session.householdId, "/alerts/read"), { method: "POST" }); session.bump(); }}>Mark read</button> : null}
            </div>
            {dash.alerts.length === 0 ? <p className="muted">No alerts.</p> : (
              <ul className="list">{dash.alerts.slice(0, 4).map((alert) => <li key={alert.id}><span><strong>{alert.title}</strong><br /><span className="muted">{alert.body}</span></span></li>)}</ul>
            )}
          </article>
        </div>
      </div>
      {dash.budget.cardGaps.some((gap) => gap.gapMinor > 0) ? (
        <div className="banner" style={{ marginTop: 16 }}>A card balance is larger than the payment reserve. That gap is debt, not missing cash in another category.</div>
      ) : null}
      <article className="card" style={{ marginTop: 16 }}>
        <h2>Recent</h2>
        {dash.recent.length === 0 ? <p className="muted">No transactions yet. Add an account, then record what happened.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Payee</th><th>Type</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {dash.recent.map((txn) => <tr key={txn.id}><td>{txn.date}</td><td>{txn.payee}</td><td>{txn.type.replaceAll("_", " ")}</td><td className="num"><Money minor={txn.amountMinor} /></td></tr>)}
            </tbody>
          </table>
        )}
      </article>
    </section>
  );
}
