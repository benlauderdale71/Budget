import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { minorToInput, parseAmount, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { Empty, ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

const KINDS = [
  ["salary", "Salary"],
  ["hourly", "Hourly"],
  ["freelance", "Freelance or contract"],
  ["commission", "Commission"],
  ["bonus", "Bonus"],
  ["seasonal", "Seasonal"],
  ["benefit", "Benefits"],
  ["other", "Other recurring receipt"],
  ["irregular", "Irregular or one-time"],
] as const;

const CADENCES = [
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
  ["irregular", "Irregular dates"],
] as const;

interface Source {
  id: string;
  name: string;
  kind: string;
  ownerUserId: string | null;
  accountId: string;
  amountMinor: number;
  amountMaxMinor: number | null;
  cadence: string;
  customInterval: number | null;
  anchorDay: number | null;
  twiceDays: number[] | null;
  startDate: string;
  endDate: string | null;
  paused: boolean;
  archived: boolean;
  notes: string | null;
  version: number;
  dates: { date: string; amountMinor: number }[];
  exceptions: string[];
}

interface Plan {
  note: string;
  explanation: string;
  assumptions: string[];
  timeZone: string;
  scenario: string;
  actual: { cashMinor: number; readyToAssignMinor: number; netWorthMinor: number; incomeMinor: number; eligiblePostedIncomeMinor: number };
  receivedSoFarMinor: number;
  next: { date: string; amountMinor: number; name: string } | null;
  billsBeforeNext: { id: string; name: string; date: string; uncoveredMinor: number }[];
  committedMinor: number;
  shortfallMinor: number;
  projectedCashMinor: number;
  projectedWithExpectedMinor: number;
  states: { empty: boolean; overdue: number; delayed: number; missing: boolean };
  expectedReceipts: { sourceId: string; name: string; date: string; expectedDate: string; amountMinor: number; status: string }[];
  sources: Source[];
  spaceId: string;
}

interface Detail {
  source: Source;
  history: { id: string; expectedDate: string; status: string; expectedAmountMinor: number; receivedAmountMinor: number | null; receivedDate: string | null; remainingMinor: number | null; delayedUntil: string | null; transactionId: string | null; updatedAt: string }[];
  linkCandidates: { id: string; date: string; payee: string; amountMinor: number }[];
  explanation: string;
}

export function Paychecks() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const scenario = params.get("scenario") === "conservative" || params.get("scenario") === "optimistic" ? params.get("scenario")! : "expected";
  const plan = useLoad(() => api<Plan>(scoped(session.householdId, `/paychecks?scenario=${scenario}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, scenario]);
  const people = useLoad(() => api<{ members: { id: string; displayName: string }[] }>(scoped(session.householdId, "/members")), [session.householdId, session.tick]);
  const dash = useLoad(() => api<{ accounts: { id: string; name: string; kind: string }[] }>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const archived = useLoad(() => api<{ archived: Source[] }>(scoped(session.householdId, "/income-sources?archived=1", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const [editing, setEditing] = useState<Source | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const form = useFormError();
  if (plan.loading && !plan.data) return <Loading label="Loading paychecks" />;
  if (!plan.data) return <ErrorNote message={plan.error ?? "Paychecks did not load"} onRetry={session.bump} />;
  const data = plan.data;
  const accounts = (dash.data?.accounts ?? []).filter((account) => ["checking", "savings", "cash"].includes(account.kind));
  return (
    <Page
      title="Paychecks"
      lede={data.note}
      actions={<div className="chips" role="group" aria-label="Planning scenario">
        {(["conservative", "expected", "optimistic"] as const).map((choice) => (
          <button key={choice} className="chip" aria-pressed={scenario === choice} onClick={() => setParams({ scenario: choice })}>{choice[0].toUpperCase() + choice.slice(1)}</button>
        ))}
      </div>}
    >
      <div className="grid stats">
        <article className="card"><p className="kicker">Cash on hand</p><p className="figure"><Money minor={data.actual.cashMinor} /></p><p className="muted">Actual cash. Expected pay is not included.</p></article>
        <article className="card"><p className="kicker">Ready to Assign</p><p className="figure"><Money minor={data.actual.readyToAssignMinor} /></p></article>
        <article className="card"><p className="kicker">Received so far</p><p className="figure"><Money minor={data.receivedSoFarMinor} /></p><p className="muted">Posted income only.</p></article>
        <article className="card"><p className="kicker">Next expected</p>{data.next ? <p className="figure"><Money minor={data.next.amountMinor} /></p> : <p>None scheduled.</p>}{data.next ? <p className="muted">{data.next.date} {data.next.name}. This is not cash.</p> : null}</article>
      </div>
      <div className="grid two" style={{ marginTop: 16 }}>
        <article className="card">
          <h2>Bills due before the next paycheck</h2>
          {!data.billsBeforeNext.length ? <p>No bills are due before the next paycheck.</p> : <ul className="list">{data.billsBeforeNext.map((bill) => <li key={bill.id}><span>{bill.date} {bill.name}</span><Money minor={bill.uncoveredMinor} /></li>)}</ul>}
          <p>Already committed <Money minor={data.committedMinor} />. {data.shortfallMinor > 0 ? <>Shortfall <Money minor={data.shortfallMinor} />.</> : "Cash already here covers those bills."}</p>
        </article>
        <article className="card">
          <h2>Two balances</h2>
          <p>Projected cash, without expected pay: <Money minor={data.projectedCashMinor} />.</p>
          <p>If expected pay arrives: <Money minor={data.projectedWithExpectedMinor} />. That second figure is a forecast, not money you can assign.</p>
          <p className="muted">Household time zone: {data.timeZone}.</p>
        </article>
      </div>
      {data.states.empty ? <p>No income sources yet.</p> : null}
      {data.states.missing && !data.states.empty ? <p>No paycheck is expected in this window.</p> : null}
      {data.states.overdue > 0 ? <p>Overdue expected pay is still not cash. Record it, delay it, or cancel it.</p> : null}
      {data.states.delayed > 0 ? <p>{data.states.delayed} delayed paycheck{data.states.delayed === 1 ? "" : "s"}.</p> : null}
      <details className="card"><summary>Assumptions</summary><ul>{data.assumptions.map((item) => <li key={item}>{item}</li>)}</ul><p>{data.explanation}</p></details>
      <ul className="list card">
        {data.sources.map((source) => (
          <li key={source.id}>
            <span>{source.name} · {labelOf(CADENCES, source.cadence)}{source.paused ? " · Paused" : ""}</span>
            <span className="row">
              {source.cadence === "irregular" && source.amountMinor === 0 ? <span className="muted">Amounts are on the dates</span> : <Money minor={source.amountMinor} />}
              <button className="btn-quiet" type="button" aria-label={`Open ${source.name}`} onClick={() => { setOpenId(source.id); setEditing(null); }}>Open</button>
              <button className="btn-quiet" type="button" aria-label={`Edit ${source.name}`} onClick={() => { setEditing(source); setOpenId(null); }}>Edit</button>
              <button className="btn-quiet" type="button" aria-label={source.paused ? `Resume ${source.name}` : `Pause ${source.name}`} onClick={() => flag(session, source, source.paused ? "resume" : "pause").then(session.bump).catch((error: unknown) => form.setError(error instanceof Error ? error.message : "That did not save."))}>{source.paused ? "Resume" : "Pause"}</button>
              <button className="btn-quiet" type="button" aria-label={`Archive ${source.name}`} onClick={() => {
                if (!window.confirm(`Archive ${source.name}? Recorded pay stays in the register. Expected dates that were not recorded are no longer shown.`)) return;
                flag(session, source, "archive").then(session.bump).catch((error: unknown) => form.setError(error instanceof Error ? error.message : "That did not save."));
              }}>Archive</button>
            </span>
          </li>
        ))}
      </ul>
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      {archived.data?.archived.length ? <section className="card"><h2>Archived</h2><ul className="list">{archived.data.archived.map((source) => <li key={source.id}><span>{source.name}</span><button className="btn-quiet" onClick={() => flag(session, source, "restore").then(session.bump).catch((error: unknown) => form.setError(error instanceof Error ? error.message : "That did not save."))}>Restore</button></li>)}</ul></section> : null}
      <IncomeForm key={editing?.id ?? "new"} source={editing} accounts={accounts} members={people.data?.members ?? []} spaceId={data.spaceId} onCancel={() => setEditing(null)} />
      {openId ? <ReceiptPanel sourceId={openId} receipts={data.expectedReceipts.filter((item) => item.sourceId === openId)} onClose={() => setOpenId(null)} /> : null}
    </Page>
  );
}

function labelOf(options: readonly (readonly [string, string])[], value: string) {
  return options.find((item) => item[0] === value)?.[1] ?? value;
}

async function flag(session: ReturnType<typeof useSession>, source: Source, action: "pause" | "resume" | "archive" | "restore") {
  await api(scoped(session.householdId, `/income-sources/${source.id}/${action}`), { method: "POST", body: JSON.stringify({ version: source.version }) });
}

function IncomeForm({ source, accounts, members, spaceId, onCancel }: { source: Source | null; accounts: { id: string; name: string }[]; members: { id: string; displayName: string }[]; spaceId: string; onCancel: () => void }) {
  const session = useSession();
  const form = useFormError();
  const [cadence, setCadence] = useState(source?.cadence ?? "irregular");
  const [accountId, setAccountId] = useState(source?.accountId ?? "");
  const [rows, setRows] = useState(source?.dates.length ? source.dates.map((row) => ({ date: row.date, amount: minorToInput(row.amountMinor, session.currency) })) : [{ date: "", amount: "" }, { date: "", amount: "" }]);
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts]);
  return (
    <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      const amount = parseAmount(String(data.get("amount") || "0"), session.currency);
      const high = String(data.get("high") || "").trim();
      const body = {
        spaceId,
        name: data.get("name"),
        kind: data.get("kind"),
        ownerUserId: data.get("owner") || null,
        accountId,
        amountMinor: Math.abs(amount),
        amountMaxMinor: high ? Math.abs(parseAmount(high, session.currency)) : null,
        cadence,
        customInterval: data.get("interval") ? Number(data.get("interval")) : null,
        anchorDay: data.get("anchor") ? Number(data.get("anchor")) : null,
        twiceDays: cadence === "twice_monthly" ? [Number(data.get("dayA")), Number(data.get("dayB"))] : null,
        startDate: data.get("start"),
        endDate: data.get("end") || null,
        notes: data.get("notes") || null,
        exceptions: String(data.get("exceptions") || "").split(",").map((item) => item.trim()).filter(Boolean),
        dates: cadence === "irregular" ? rows.filter((row) => row.date).map((row) => ({ date: row.date, amountMinor: Math.abs(parseAmount(row.amount || "0", session.currency)) })) : undefined,
        version: source?.version,
      };
      await api(scoped(session.householdId, source ? `/income-sources/${source.id}` : "/income-sources"), { method: source ? "PATCH" : "POST", body: JSON.stringify(body) });
      onCancel();
      session.bump();
    })}>
      <h2>{source ? `Edit ${source.name}` : "New income source"}</h2>
      <p className="muted">Saving an expected paycheck does not change the account balance, Ready to Assign, or net worth. A short month uses the last real day, then the next month returns to the anchored day. Twice a month is not every two weeks. Irregular dates are only the rows you enter.</p>
      <Field label="Name"><input name="name" required defaultValue={source?.name ?? ""} /></Field>
      <Field label="Kind"><select name="kind" defaultValue={source?.kind ?? "salary"}>{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Earner"><select name="owner" defaultValue={source?.ownerUserId ?? ""}><option value="">Household</option>{members.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></Field>
      <Field label="Deposit account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
      <Field label="Schedule"><select value={cadence} onChange={(event) => setCadence(event.target.value)}>{CADENCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      {cadence === "every_n_days" || cadence === "every_n_weeks" ? <Field label={cadence === "every_n_weeks" ? "Number of weeks" : "Number of days"}><input name="interval" type="number" min={1} required defaultValue={source?.customInterval ?? ""} /></Field> : null}
      {cadence === "monthly" || cadence.endsWith("months") || cadence === "annual" ? <Field label="Anchored day"><input name="anchor" type="number" min={1} max={31} defaultValue={source?.anchorDay ?? ""} /></Field> : null}
      {cadence === "twice_monthly" ? <div className="row"><Field label="First day"><input name="dayA" type="number" min={1} max={31} required defaultValue={source?.twiceDays?.[0] ?? 1} /></Field><Field label="Second day"><input name="dayB" type="number" min={1} max={31} required defaultValue={source?.twiceDays?.[1] ?? 15} /></Field></div> : null}
      <Field label="Planning amount"><input name="amount" inputMode="decimal" required={cadence !== "irregular"} defaultValue={source ? minorToInput(source.amountMinor, session.currency) : ""} /></Field>
      <Field label="High end, optional"><input name="high" inputMode="decimal" defaultValue={source?.amountMaxMinor != null ? minorToInput(source.amountMaxMinor, session.currency) : ""} /></Field>
      <Field label="Start date"><input name="start" type="date" required defaultValue={source?.startDate ?? todayISO()} /></Field>
      <Field label="End date"><input name="end" type="date" defaultValue={source?.endDate ?? ""} /></Field>
      <Field label="Skip these dates"><input name="exceptions" placeholder="YYYY-MM-DD, YYYY-MM-DD" defaultValue={source?.exceptions.join(", ") ?? ""} /></Field>
      <Field label="Notes"><input name="notes" defaultValue={source?.notes ?? ""} /></Field>
      {cadence === "irregular" ? <fieldset><legend>Irregular dates</legend>{rows.map((row, index) => (
        <div className="row" key={index}>
          <Field label={`Expected date ${index + 1}`}><input type="date" value={row.date} onChange={(event) => setRows(rows.map((item, itemIndex) => itemIndex === index ? { ...item, date: event.target.value } : item))} /></Field>
          <Field label={`Amount ${index + 1}`}><input inputMode="decimal" value={row.amount} onChange={(event) => setRows(rows.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} /></Field>
        </div>
      ))}<button className="btn-secondary" type="button" onClick={() => setRows([...rows, { date: "", amount: "" }])}>Add date</button></fieldset> : null}
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      <div className="row"><button className="btn" type="submit">Save income source</button>{source ? <button className="btn-quiet" type="button" onClick={onCancel}>Close editor</button> : null}</div>
    </form>
  );
}

function ReceiptPanel({ sourceId, receipts, onClose }: { sourceId: string; receipts: Plan["expectedReceipts"]; onClose: () => void }) {
  const session = useSession();
  const form = useFormError();
  const op = useRef("");
  const detail = useLoad(() => api<Detail>(scoped(session.householdId, `/income-sources/${sourceId}`)), [session.householdId, sourceId, session.tick]);
  const operation = () => {
    if (!op.current) op.current = crypto.randomUUID();
    return op.current;
  };
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}><h2>This paycheck</h2><button className="btn-quiet" onClick={onClose}>Close</button></div>
      {!detail.data ? <Loading label="Loading paycheck" /> : <>
        <p className="muted">{detail.data.explanation}</p>
        {!receipts.length ? <p>Nothing in this window is still expected.</p> : null}
        {receipts.map((item) => <p key={`${item.expectedDate}-${item.date}`}>{item.date} · {item.status} · <Money minor={item.amountMinor} /></p>)}
        <form onSubmit={(event) => form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          const mode = String(data.get("mode"));
          await api(scoped(session.householdId, `/income-sources/${sourceId}/receive`), { method: "POST", body: JSON.stringify({
            expectedDate: data.get("expectedDate"),
            opId: operation(),
            mode,
            amountMinor: mode === "link" ? undefined : Math.abs(parseAmount(String(data.get("amount")), session.currency)),
            receivedDate: data.get("receivedDate"),
            transactionId: mode === "link" ? data.get("transactionId") : undefined,
          }) });
          op.current = "";
          session.bump();
        })}>
          <Field label="Expected date"><input name="expectedDate" type="date" required defaultValue={receipts[0]?.expectedDate ?? ""} /></Field>
          <Field label="How it arrived"><select name="mode" defaultValue="full"><option value="full">Fully received</option><option value="partial">Partially received</option><option value="link">Link an existing deposit</option></select></Field>
          <Field label="Amount received"><input name="amount" inputMode="decimal" defaultValue={receipts[0] ? minorToInput(receipts[0].amountMinor, session.currency) : ""} /></Field>
          <Field label="Received date"><input name="receivedDate" type="date" defaultValue={todayISO()} /></Field>
          <Field label="Existing deposit"><select name="transactionId"><option value="">None</option>{(detail.data.linkCandidates ?? []).map((txn) => <option key={txn.id} value={txn.id}>{txn.date} {txn.payee}</option>)}</select></Field>
          {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
          <button className="btn" type="submit">Record received</button>
        </form>
        <form onSubmit={(event) => form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          await api(scoped(session.householdId, `/income-sources/${sourceId}/delay`), { method: "POST", body: JSON.stringify({ expectedDate: data.get("delayFrom"), delayedUntil: data.get("delayedUntil") }) });
          session.bump();
        })}>
          <Field label="Date to delay"><input name="delayFrom" type="date" required defaultValue={receipts[0]?.expectedDate ?? ""} /></Field>
          <Field label="Delayed until"><input name="delayedUntil" type="date" required /></Field>
          <button className="btn-secondary" type="submit">Mark delayed</button>
        </form>
        <form onSubmit={(event) => form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          await api(scoped(session.householdId, `/income-sources/${sourceId}/cancel`), { method: "POST", body: JSON.stringify({ expectedDate: data.get("cancelDate") }) });
          session.bump();
        })}>
          <Field label="Date to cancel"><input name="cancelDate" type="date" required defaultValue={receipts[0]?.expectedDate ?? ""} /></Field>
          <button className="btn-secondary" type="submit">Cancel this date</button>
        </form>
        <form onSubmit={(event) => form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          const scope = String(data.get("scope"));
          const amountText = String(data.get("reviseAmount") || "").trim();
          const nextDate = String(data.get("reviseDate") || "");
          await api(scoped(session.householdId, `/income-sources/${sourceId}/revise`), { method: "POST", body: JSON.stringify({
            expectedDate: data.get("reviseFrom"),
            scope,
            date: nextDate || undefined,
            amountMinor: amountText ? Math.abs(parseAmount(amountText, session.currency)) : undefined,
            version: scope === "future" ? detail.data?.source.version : undefined,
          }) });
          session.bump();
        })}>
          <Field label="Date to change"><input name="reviseFrom" type="date" required defaultValue={receipts[0]?.expectedDate ?? ""} /></Field>
          <Field label="New date"><input name="reviseDate" type="date" /></Field>
          <Field label="New amount"><input name="reviseAmount" inputMode="decimal" /></Field>
          <Field label="What changes"><select name="scope" defaultValue="one"><option value="one">This date only</option><option value="future">This date and future dates</option></select></Field>
          <button className="btn-secondary" type="submit">Save schedule change</button>
        </form>
        <h3>History</h3>
        {!detail.data.history.length ? <p>No receipts or revisions yet.</p> : <ul className="list">{detail.data.history.map((row) => <li key={row.id}><span>{row.expectedDate} · {row.status}{row.receivedDate ? ` · received ${row.receivedDate}` : ""}</span><span>{row.receivedAmountMinor != null ? <Money minor={row.receivedAmountMinor} /> : <Money minor={row.expectedAmountMinor} />}</span></li>)}</ul>}
      </>}
    </section>
  );
}

interface CalendarItem {
  id: string;
  kind: string;
  name: string;
  date: string;
  amountMinor: number;
  status: string;
  estimate: boolean;
}

export function CalendarPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : todayISO().slice(0, 7);
  const [yearText, monthText] = month.split("-");
  const from = `${month}-01`;
  const last = new Date(Date.UTC(Number(yearText), Number(monthText), 0)).getUTCDate();
  const to = `${month}-${String(last).padStart(2, "0")}`;
  const focus = params.get("focus");
  const state = useLoad(() => api<{ items: CalendarItem[]; days: { date: string; projectedMinor: number; withExpectedMinor: number }[]; note: string; explanation: string; actualCashMinor: number; timeZone: string }>(scoped(session.householdId, `/calendar?from=${from}&to=${to}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, month]);
  const focused = state.data?.items.find((item) => item.id === focus) ?? null;
  const shift = (delta: number) => {
    const next = new Date(Date.UTC(Number(yearText), Number(monthText) - 1 + delta, 1));
    const value = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextParams = new URLSearchParams(params);
    nextParams.set("month", value);
    nextParams.delete("focus");
    setParams(nextParams);
  };
  return (
    <Page title="Calendar" lede={state.data?.note ?? "Expected pay, bills, and fills. Estimated amounts are not posted transactions."} actions={<div className="row"><button className="btn-secondary" onClick={() => shift(-1)}>Previous month</button><strong>{month}</strong><button className="btn-secondary" onClick={() => shift(1)}>Next month</button></div>}>
      {state.loading && !state.data ? <Loading label="Loading the calendar" /> : null}
      {state.error ? <ErrorNote message={state.error} onRetry={session.bump} /> : null}
      {state.data ? <>
        <p>Cash on hand <Money minor={state.data.actualCashMinor} />. Household time zone {state.data.timeZone}.</p>
        <div className="calendar-grid" aria-label="Month">
          {Array.from({ length: last }, (_, index) => {
            const date = `${month}-${String(index + 1).padStart(2, "0")}`;
            const items = state.data!.items.filter((item) => item.date === date);
            const day = state.data!.days.find((item) => item.date === date);
            return (
              <div className="calendar-day" key={date}>
                <strong>{index + 1}</strong>
                {day ? <p className="muted">Cash <Money minor={day.projectedMinor} /></p> : <p className="muted">No estimated balance before today.</p>}
                {day && day.withExpectedMinor !== day.projectedMinor ? <p className="muted">With expected pay <Money minor={day.withExpectedMinor} /></p> : null}
                {items.map((item) => <button key={item.id} onClick={() => setParams({ month, focus: item.id })}>{item.name}</button>)}
              </div>
            );
          })}
        </div>
        <h2>List</h2>
        {!state.data.items.length ? <Empty title="Nothing scheduled" body="Paychecks and bills you add will show up here." /> : (
          <ul className="list card">{state.data.items.map((item) => (
            <li key={item.id}><button className="btn-quiet" onClick={() => setParams({ month, focus: item.id })}>{item.date} {item.name} · {item.kind} · {item.status}{item.estimate ? " · estimate" : ""}</button><Money minor={item.kind === "income" ? item.amountMinor : -item.amountMinor} /></li>
          ))}</ul>
        )}
        {focused ? <Modal title={`${focused.name}`} onClose={() => setParams({ month })}>
          <p>{focused.date} · {focused.kind} · {focused.status}{focused.estimate ? " · estimated, not posted" : " · confirmed"}</p>
          <p><Money minor={focused.amountMinor} /></p>
          <p className="muted">Closing this returns to {month}.</p>
        </Modal> : null}
      </> : null}
    </Page>
  );
}
