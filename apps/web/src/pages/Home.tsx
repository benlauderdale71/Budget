import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { monthLabel } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Loading, Money, useLoad } from "../ui.js";

const HOME_CARDS = [
  ["safe", "Safe to spend"],
  ["ready", "Ready to Assign"],
  ["worth", "Net worth"],
  ["age", "Age of money"],
  ["committed", "Already given a job"],
  ["bill", "Next bill"],
  ["review", "Needs review"],
  ["goals", "Goals"],
  ["month", "This month"],
  ["upcoming", "Upcoming"],
  ["alerts", "Alerts"],
  ["recent", "Recent"],
] as const;

function useHomeCards() {
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("budgetcents.homeCards") ?? "[]");
      return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  });
  function toggle(id: string) {
    setHidden((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      localStorage.setItem("budgetcents.homeCards", JSON.stringify(next));
      return next;
    });
  }
  return { show: (id: string) => !hidden.includes(id), toggle };
}

export function Home() {
  const session = useSession();
  const cards = useHomeCards();
  const state = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  useEffect(() => { if (state.data) session.adoptSpace(state.data.spaceId); }, [state.data?.spaceId]);
  if (state.loading && !state.data) return <Loading label="Loading the household" />;
  if (state.error || !state.data) return <ErrorNote message={state.error ?? "No dashboard"} onRetry={session.bump} />;
  const dash = state.data;
  const short = dash.guidance.primaryFigure === "shortage";
  const unread = dash.alerts.filter((alert) => !alert.read_at);
  const committed = dash.budget.claimsMinor - dash.budget.readyToAssignMinor - dash.budget.futureAssignedMinor;
  const nextBill = dash.upcoming.find((item) => item.amountMinor < 0);
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
      <details className="card">
        <summary>Choose dashboard cards</summary>
        <div className="chips" style={{ marginTop: 12 }}>
          {HOME_CARDS.map(([id, label]) => (
            <button key={id} type="button" className="chip" aria-pressed={cards.show(id)} onClick={() => cards.toggle(id)}>{label}</button>
          ))}
        </div>
        <p className="muted">Hidden cards stay on this browser. The figures are unchanged.</p>
      </details>
      {dash.budget.identityDifferenceMinor !== 0 ? <div className="banner bad" role="alert">The plan does not match on-budget cash by <Money minor={dash.budget.identityDifferenceMinor} />. Review recent edits before relying on Ready to Assign.</div> : null}
      {dash.budget.warnings.filter((warning) => !warning.includes("identity")).map((warning) => <div key={warning} className="banner bad">{warning}</div>)}
      <div className="grid stats">
        {cards.show("safe") ? <article className="card">
          <p className="kicker">{short ? "Short before upcoming bills" : "Safe to spend"}</p>
          <p className={`figure ${short ? "shortage" : ""}`}><Money minor={short ? dash.guidance.shortageMinor : dash.guidance.cashSafeMinor} tone={!short} /></p>
          <p className="formula">{dash.guidance.formula}</p>
          {dash.guidance.projectedUsesExpectedIncome ? <p className="muted">Projected allowance, including expected income that is not cash: <Money minor={dash.guidance.projectedAllowanceMinor} />. Daily cash figure: <Money minor={dash.guidance.dailyCashMinor} />.</p> : null}
        </article> : null}
        {cards.show("ready") ? <article className="card">
          <p className="kicker">Ready to Assign</p>
          <p className="figure"><Money minor={dash.budget.readyToAssignMinor} /></p>
          <p className="formula">{dash.explain.formula}</p>
        </article> : null}
        {cards.show("worth") ? <article className="card">
          <p className="kicker">Net worth</p>
          <p className="figure"><Money minor={dash.netWorth.netMinor} /></p>
          <p className="muted">Liquid <Money minor={dash.netWorth.liquidMinor} /></p>
        </article> : null}
        {cards.show("age") ? <article className="card">
          <p className="kicker">Age of money</p>
          <p className="figure">{dash.ageOfMoney.days == null ? "—" : `${dash.ageOfMoney.days}d`}</p>
          <p className="formula">{dash.ageOfMoney.formula}</p>
        </article> : null}
      </div>
      <div className="grid stats" style={{ marginTop: 16 }}>
        {cards.show("committed") ? <article className="card">
          <p className="kicker">Already given a job</p>
          <p className="figure"><Money minor={committed} /></p>
          <p className="muted">Cash sitting in categories, envelopes, and reserves. It is not also free to spend.</p>
        </article> : null}
        {cards.show("bill") ? <article className="card">
          <p className="kicker">Next bill</p>
          {nextBill ? <p className="figure"><Money minor={nextBill.amountMinor} /></p> : <p className="figure">None</p>}
          <p className="muted">{nextBill ? `${nextBill.date} · ${nextBill.label}` : "No outflow is scheduled in the next month."}</p>
        </article> : null}
        {cards.show("review") ? <article className="card">
          <p className="kicker">Needs review</p>
          <p className="figure">{dash.reviewCount}</p>
          <p>{dash.reviewCount ? <Link to="/activity?review=needs_review">Open the queue</Link> : "Nothing is waiting for a category check."}</p>
        </article> : null}
        {cards.show("goals") ? <article className="card">
          <p className="kicker">Goals</p>
          {dash.goals.length === 0 ? <p className="muted">No goal is using an envelope yet.</p> : (
            <ul className="list">
              {dash.goals.slice(0, 3).map((goal) => (
                <li key={goal.id}><span>{goal.name}</span><span><Money minor={goal.availableMinor} /> / <Money minor={goal.target_minor} /></span></li>
              ))}
            </ul>
          )}
          <p><Link to="/goals">Open goals</Link></p>
        </article> : null}
      </div>
      <div className="grid two" style={{ marginTop: 16 }}>
        {cards.show("month") ? <article className="card">
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
        </article> : null}
        <div className="grid">
          {cards.show("upcoming") ? <article className="card">
            <div className="link-row"><h2>Upcoming</h2><Link to="/bills">Bills</Link></div>
            {dash.upcoming.length === 0 ? <p className="muted">Nothing scheduled in the next month.</p> : (
              <ul className="list">
                {dash.upcoming.slice(0, 6).map((item) => (
                  <li key={`${item.id}-${item.date}`}><span>{item.date} · {item.label}{item.expectedIncome ? " · expected" : ""}</span><Money minor={item.amountMinor} /></li>
                ))}
              </ul>
            )}
          </article> : null}
          {cards.show("alerts") ? <article className="card">
            <div className="link-row">
              <h2>Alerts</h2>
              {unread.length ? <button className="btn-quiet" onClick={async () => { await api(scoped(session.householdId, "/alerts/read"), { method: "POST" }); session.bump(); }}>Mark read</button> : null}
            </div>
            {dash.alerts.length === 0 ? <p className="muted">No alerts.</p> : (
              <ul className="list">{dash.alerts.slice(0, 4).map((alert) => <li key={alert.id}><span><strong>{alert.title}</strong><br /><span className="muted">{alert.body}</span></span></li>)}</ul>
            )}
          </article> : null}
        </div>
      </div>
      {dash.budget.cardGaps.some((gap) => gap.gapMinor > 0) ? (
        <div className="banner" style={{ marginTop: 16 }}>A card balance is larger than the payment reserve. That gap is debt, not missing cash in another category.</div>
      ) : null}
      {cards.show("recent") ? <article className="card" style={{ marginTop: 16 }}>
        <h2>Recent</h2>
        {dash.recent.length === 0 ? <p className="muted">No transactions yet. Add an account, then record what happened.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Payee</th><th>Type</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {dash.recent.map((txn) => <tr key={txn.id}><td>{txn.date}</td><td>{txn.payee}</td><td>{txn.type.replaceAll("_", " ")}</td><td className="num"><Money minor={txn.amountMinor} /></td></tr>)}
            </tbody>
          </table>
        )}
      </article> : null}
    </section>
  );
}
