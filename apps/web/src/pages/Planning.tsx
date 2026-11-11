import { useState } from "react";
import { api } from "../api.js";
import { minorToInput, parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { LoanPlans } from "./LoanPlans.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, Spark, useFormError, useLoad } from "../ui.js";

export function Forecast() {
  const session = useSession();
  const state = useLoad(() => api<{
    cash: { points: { date: string; balanceMinor: number }[]; endingMinor: number; minimumMinor: number; overdraftDate: string | null; formula: string };
    plan: { endingMinor: number };
    paycheck: { note: string; paychecks: { beforeNext: { shortageMinor: number; uncoveredMinor: number; obligations: { name: string; date: string; uncoveredMinor: number }[]; paycheckDate: string | null }; formula: string } };
    note: string;
    spaceId: string;
  }>(scoped(session.householdId, "/forecast?days=45", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  const [scenario, setScenario] = useState("");
  if (state.loading && !state.data) return <Loading label="Building the forecast" />;
  if (!state.data) return <ErrorNote message={state.error ?? "No forecast"} onRetry={session.bump} />;
  const data = state.data;
  return (
    <Page title="Forecast" lede={data.note}>
      <div className="grid two">
        <article className="card">
          <p className="kicker">Cash on hand</p>
          <Spark points={data.cash.points} label="Cash projection without expected income" />
          <p>Lowest point <Money minor={data.cash.minimumMinor} />{data.cash.overdraftDate ? ` on ${data.cash.overdraftDate}` : ""}.</p>
          <p className="formula">{data.cash.formula}</p>
        </article>
        <article className="card">
          <h2>Before the next paycheck</h2>
          <p>{data.paycheck.note}</p>
          {data.paycheck.paychecks.beforeNext.shortageMinor > 0 ? <p className="figure shortage"><Money minor={data.paycheck.paychecks.beforeNext.shortageMinor} /></p> : <p>Covered by cash already here.</p>}
          <ul className="list">{data.paycheck.paychecks.beforeNext.obligations.map((item) => <li key={`${item.name}-${item.date}`}><span>{item.date} {item.name}</span><Money minor={item.uncoveredMinor} /></li>)}</ul>
          <p className="muted">A separate plan that includes expected income ends at <Money minor={data.plan.endingMinor} />. That figure is not cash.</p>
        </article>
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
        const body = new FormData(event.currentTarget);
        const amount = -Math.abs(parseAmount(String(body.get("amount")), session.currency));
        const result = await api<{ note: string; projection: { endingMinor: number; overdraftDate: string | null } }>(scoped(session.householdId, "/scenarios"), { method: "POST", body: JSON.stringify({
          spaceId: data.spaceId, name: body.get("name"), days: 45, save: true,
          adjustments: [{ id: "what-if", label: String(body.get("name")), date: body.get("date"), amountMinor: amount, kind: "expense" }],
        }) });
        setScenario(`${result.note} The copy ends at ${result.projection.endingMinor} minor units.${result.projection.overdraftDate ? ` It would cross zero on ${result.projection.overdraftDate}.` : " It stays at or above zero."}`);
      })}>
        <h2>What-if</h2>
        <p className="muted">This copies the forecast. It does not post a transaction.</p>
        <Field label="Name"><input name="name" required defaultValue="Extra expense" /></Field>
        <Field label="Date"><input name="date" type="date" required defaultValue={todayISO()} /></Field>
        <Field label="Amount"><input name="amount" required inputMode="decimal" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {scenario ? <Notice>{scenario}</Notice> : null}
        <button className="btn" type="submit">Run scenario</button>
      </form>
    </Page>
  );
}

const BILL_CADENCES = [
  ["weekly", "Weekly"],
  ["biweekly", "Every two weeks"],
  ["twice_monthly", "Twice a month"],
  ["monthly", "Monthly"],
  ["every_2_months", "Every two months"],
  ["every_3_months", "Every three months"],
  ["every_6_months", "Every six months"],
  ["annual", "Yearly"],
  ["every_n_days", "Every N days"],
  ["every_n_weeks", "Every N weeks"],
  ["once", "One time"],
] as const;

interface BillSchedule {
  id: string;
  name: string;
  cadence: string;
  nextDate: string;
  amountMinor: number;
  direction: string;
  type: string;
  accountId?: string;
  bucketId?: string;
  paused?: boolean;
  interval?: number;
  anchorDay?: number;
  twiceDayA?: number;
  twiceDayB?: number;
  endDate?: string;
  scheduleMode?: string;
}

export function Bills() {
  const session = useSession();
  const state = useLoad(() => api<{ schedules: BillSchedule[] }>(scoped(session.householdId, "/schedules", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const dash = useLoad(() => api<{ spaceId: string; accounts: { id: string; name: string }[]; buckets: { id: string; name: string; systemRole?: string | null }[] }>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  const [editing, setEditing] = useState<BillSchedule | null>(null);
  const [cadence, setCadence] = useState("monthly");
  if (!state.data || !dash.data) return state.error ? <ErrorNote message={state.error} /> : <Loading label="Loading bills" />;
  const shownCadence = editing ? (editing.scheduleMode ?? editing.cadence) : cadence;
  return (
    <Page title="Bills and subscriptions" lede="A bill schedule is an estimate until it is paid. Skipping one date does not delete the series. Irregular pay belongs on Paychecks and does not add cash.">
      <ul className="list card">
        {state.data.schedules.map((item) => (
          <li key={item.id}>
            <span>{item.name} · {item.scheduleMode ?? item.cadence} · next {item.nextDate}{item.paused ? " · Paused" : ""}</span>
            <span className="row">
              <Money minor={item.direction === "inflow" ? item.amountMinor : -item.amountMinor} />
              <button className="btn-quiet" onClick={() => { setEditing(item); setCadence(item.scheduleMode ?? item.cadence); }}>Edit</button>
              <button className="btn-quiet" onClick={async () => { await api(scoped(session.householdId, `/schedules/${item.id}/skip`), { method: "POST" }); session.bump(); }}>Skip next</button>
              {item.direction === "outflow" && item.bucketId ? <button className="btn-quiet" onClick={async () => { await api(scoped(session.householdId, `/schedules/${item.id}/reserve`), { method: "POST" }); session.bump(); }}>Reserve from cash</button> : null}
            </span>
          </li>
        ))}
      </ul>
      <form key={editing?.id ?? "new"} className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const body = {
          spaceId: dash.data!.spaceId,
          name: data.get("name"),
          cadence: shownCadence,
          nextDate: data.get("date"),
          amountMinor: Math.abs(parseAmount(String(data.get("amount")), session.currency)),
          direction: data.get("direction"),
          type: data.get("direction") === "inflow" ? "income" : data.get("subscription") === "on" ? "subscription" : "bill",
          accountId: data.get("accountId") || undefined,
          bucketId: data.get("bucketId") || undefined,
          customInterval: data.get("interval") ? Number(data.get("interval")) : null,
          anchorDay: data.get("anchor") ? Number(data.get("anchor")) : null,
          twiceDays: shownCadence === "twice_monthly" ? [Number(data.get("dayA")), Number(data.get("dayB"))] : null,
          endDate: data.get("end") || null,
          paused: data.get("paused") === "on",
        };
        await api(scoped(session.householdId, editing ? `/schedules/${editing.id}` : "/schedules"), { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
        setEditing(null);
        session.bump();
      })}>
        <h2>{editing ? `Edit ${editing.name}` : "Add schedule"}</h2>
        <p className="muted">An anchored day stays the anchor after a short month. Every N days is rejected when the number is missing. It is not replaced with 30. Twice a month uses the two days below and is not every two weeks.</p>
        <Field label="Name"><input name="name" required defaultValue={editing?.name ?? ""} /></Field>
        <Field label="Direction"><select name="direction" defaultValue={editing?.direction ?? "outflow"}><option value="outflow">Bill</option><option value="inflow">Income schedule</option></select></Field>
        <Field label="Cadence"><select value={shownCadence} onChange={(event) => { setCadence(event.target.value); if (editing) setEditing({ ...editing, cadence: event.target.value, scheduleMode: undefined }); }}>{BILL_CADENCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        {shownCadence === "every_n_days" || shownCadence === "every_n_weeks" ? <Field label={shownCadence === "every_n_weeks" ? "Number of weeks" : "Number of days"}><input name="interval" type="number" min={1} required defaultValue={editing?.interval ?? ""} /></Field> : null}
        {shownCadence === "twice_monthly" ? <div className="row"><Field label="First day"><input name="dayA" type="number" min={1} max={31} required defaultValue={editing?.twiceDayA ?? 1} /></Field><Field label="Second day"><input name="dayB" type="number" min={1} max={31} required defaultValue={editing?.twiceDayB ?? 15} /></Field></div> : null}
        {shownCadence === "monthly" || shownCadence.endsWith("months") || shownCadence === "annual" ? <Field label="Anchored day"><input name="anchor" type="number" min={1} max={31} defaultValue={editing?.anchorDay ?? ""} /></Field> : null}
        <Field label="Next date"><input name="date" type="date" required defaultValue={editing?.nextDate ?? todayISO()} /></Field>
        <Field label="End date"><input name="end" type="date" defaultValue={editing?.endDate ?? ""} /></Field>
        <Field label="Amount"><input name="amount" required inputMode="decimal" defaultValue={editing ? minorToInput(editing.amountMinor, session.currency) : ""} /></Field>
        <Field label="Account"><select name="accountId" defaultValue={editing?.accountId ?? ""}><option value="">Later</option>{dash.data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        <Field label="Category"><select name="bucketId" defaultValue={editing?.bucketId ?? ""}><option value="">None</option>{dash.data.buckets.filter((bucket) => !bucket.systemRole).map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <label className="row"><input name="subscription" type="checkbox" defaultChecked={editing?.type === "subscription"} /> Subscription</label>
        <label className="row"><input name="paused" type="checkbox" defaultChecked={editing?.paused ?? false} /> Paused</label>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">{editing ? "Save bill" : "Save schedule"}</button>
      </form>
    </Page>
  );
}

export function Debts() {
  const session = useSession();
  const [strategy, setStrategy] = useState("snowball");
  const state = useLoad(() => api<{ debts: { id: string; name: string; balanceMinor: number; aprBps: number; minPaymentMinor: number }[]; plan: { months: number | null; totalInterestMinor: number; debtFreeDate: string | null; order: string[]; assumptions: string[] } | null; assumptions?: string[] }>(scoped(session.householdId, `/debts?strategy=${strategy}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, strategy]);
  if (state.loading && !state.data) return <Loading />;
  if (!state.data) return <ErrorNote message={state.error ?? "No debts"} />;
  return (
    <Page title="Debts" lede="Snowball clears the smallest balance first. Avalanche clears the highest APR first. A paid-off minimum stays in the monthly budget. Saving a loan plan does not move money." actions={<div className="chips"><button className="chip" aria-pressed={strategy === "snowball"} onClick={() => setStrategy("snowball")}>Snowball</button><button className="chip" aria-pressed={strategy === "avalanche"} onClick={() => setStrategy("avalanche")}>Avalanche</button></div>}>
      {!state.data.debts.length ? <p>{state.data.assumptions?.[0]}</p> : (
        <table className="card"><thead><tr><th>Debt</th><th className="num">Balance</th><th className="num">APR</th><th className="num">Minimum</th></tr></thead>
          <tbody>{state.data.debts.map((debt) => <tr key={debt.id}><td>{debt.name}</td><td className="num"><Money minor={debt.balanceMinor} /></td><td className="num">{(debt.aprBps / 100).toFixed(2)}%</td><td className="num"><Money minor={debt.minPaymentMinor} /></td></tr>)}</tbody>
        </table>
      )}
      {state.data.plan ? <p>Order: {state.data.plan.order.map((id) => state.data?.debts.find((debt) => debt.id === id)?.name ?? "Debt").join(", ") || "balances"}. Interest <Money minor={state.data.plan.totalInterestMinor} />. {state.data.plan.debtFreeDate ? `Clear around ${state.data.plan.debtFreeDate}.` : "No payoff date with these payments."}</p> : null}
      <ul>{state.data.plan?.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
      <LoanPlans />
    </Page>
  );
}

export function Goals() {
  const session = useSession();
  const state = useLoad(() => api<{ goals: { id: string; name: string; target_minor: number; availableMinor: number; target_date: string | null }[]; spaceId: string; buckets: { id: string; name: string; systemRole?: string | null }[]; budget: { buckets: { bucketId: string; availableMinor: number }[] } }>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const roadmap = useLoad(() => api<{ milestones: { id: string; label: string; complete: boolean; detail: string }[]; emergency: { gapMinor: number; formula: string }; essential: { amountMinor: number; formula: string; sources: { name: string; monthlyMinor: number }[] } }>(scoped(session.householdId, "/roadmap", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  if (!state.data) return state.loading ? <Loading /> : <ErrorNote message={state.error ?? "No goals"} />;
  return (
    <Page title="Goals" lede="A goal points at one envelope. The available balance is the progress, so those dollars are not also free to spend.">
      <ul className="list">{state.data.goals.map((goal) => (
        <li key={goal.id}><span>{goal.name}{goal.target_date ? ` · ${goal.target_date}` : ""}</span><span><Money minor={goal.availableMinor} /> / <Money minor={Number(goal.target_minor)} /></span></li>
      ))}</ul>
      {roadmap.data ? <article className="card"><h2>Roadmap</h2><ul>{roadmap.data.milestones.map((item) => <li key={item.id}>{item.complete ? "Done" : "Open"} · {item.label} · {item.detail}</li>)}</ul><p>Essential monthly spending <Money minor={roadmap.data.essential.amountMinor} />.</p><p className="muted">{roadmap.data.essential.formula}</p>{roadmap.data.essential.sources.length ? <ul className="list">{roadmap.data.essential.sources.map((source) => <li key={source.name}><span>{source.name}</span><Money minor={source.monthlyMinor} /></li>)}</ul> : null}<p className="muted">{roadmap.data.emergency.formula} Gap <Money minor={roadmap.data.emergency.gapMinor} />.</p></article> : null}
      <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/goals"), { method: "POST", body: JSON.stringify({ spaceId: state.data!.spaceId, name: data.get("name"), bucketId: data.get("bucketId"), targetMinor: parseAmount(String(data.get("target")), session.currency), targetDate: data.get("date") || undefined, purpose: "goal" }) });
        session.bump();
      })}>
        <h2>Attach a goal</h2>
        <Field label="Name"><input name="name" required /></Field>
        <Field label="Envelope"><select name="bucketId" required>{state.data.buckets.filter((bucket) => !bucket.systemRole).map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="Target"><input name="target" required inputMode="decimal" /></Field>
        <Field label="Date"><input name="date" type="date" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save goal</button>
      </form>
    </Page>
  );
}
