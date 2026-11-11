import { useState } from "react";
import { api, downloadFile } from "../api.js";
import { minorToInput, parseAmount, percentBpsFromInput, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, Spark, useLoad } from "../ui.js";

interface LoanChoice {
  id: string;
  name: string;
  balanceMinor: number;
  aprBps: number;
  paymentMinor: number;
  balanceDate: string;
}

interface ScenarioSummary {
  id: string;
  name: string;
  kind: string;
  accountName: string;
  archived: boolean;
  version: number;
}

interface MonthRow {
  date: string;
  paymentMinor: number;
  interestMinor: number;
  principalMinor: number;
  extraMinor: number;
  balanceMinor: number;
  holiday: boolean;
}

interface Schedule {
  payoffDate: string | null;
  payoffMonths: number | null;
  totalInterestMinor: number;
  totalPaidMinor: number;
  paidOff: boolean;
  negativeAmortization: boolean;
  months: MonthRow[];
  assumptions: string[];
}

interface Comparison {
  incomplete: boolean;
  interestSavedMinor: number | null;
  monthsSaved: number | null;
  note: string;
}

interface Refinance {
  comparable: boolean;
  paymentDifferenceMinor: number;
  upfrontFeeMinor: number;
  financedFeeMinor: number;
  netBenefitMinor: number | null;
  currentPayoffDate: string | null;
  proposedPayoffDate: string | null;
  currentTotalCostMinor: number | null;
  proposedTotalCostMinor: number | null;
  breakEvenMonth: number | null;
  lowerPaymentCostsMore: boolean;
  assumptions: string[];
  proposedPaymentMinor: number;
}

interface PlanView {
  id?: string;
  name: string;
  kind: "extra" | "refinance";
  version?: number;
  accountId: string;
  balanceMinor: number;
  balanceDate: string;
  aprBps: number;
  paymentMinor: number;
  extraMinor: number;
  startDate: string;
  events: { monthIndex: number; extraOneTimeMinor?: number; aprBps?: number; paymentMinor?: number; holiday?: boolean }[];
  refinance?: { mode: "payment" | "term"; newAprBps: number; newPaymentMinor?: number; newTermMonths?: number; upfrontFeeMinor: number; financedFeeMinor: number } | null;
  baseline: Schedule;
  scenario: Schedule;
  comparison: Comparison | null;
  refinanceResult?: Refinance | null;
  snapshot?: { stale: boolean; ledgerBalanceMinor: number; ledgerAsOf: string; note: string };
  audit?: { action: string; detail: string; version: number; createdAt: string }[];
  planningNote: string;
  modelNote: string;
}

interface EventDraft {
  month: string;
  kind: "extra" | "rate" | "payment" | "holiday";
  amount: string;
}

interface Draft {
  id?: string;
  version?: number;
  kind: "extra" | "refinance";
  accountId: string;
  name: string;
  balance: string;
  balanceDate: string;
  apr: string;
  payment: string;
  extra: string;
  startDate: string;
  events: EventDraft[];
  refiMode: "payment" | "term";
  newApr: string;
  newPayment: string;
  newTerm: string;
  upfront: string;
  financed: string;
}

function blank(kind: Draft["kind"], loan: LoanChoice | undefined, currency: string): Draft {
  return {
    kind,
    accountId: loan?.id ?? "",
    name: "",
    balance: loan ? minorToInput(loan.balanceMinor, currency) : "",
    balanceDate: loan?.balanceDate ?? todayISO(),
    apr: loan ? (loan.aprBps / 100).toFixed(2) : "",
    payment: loan ? minorToInput(loan.paymentMinor, currency) : "",
    extra: "0.00",
    startDate: loan?.balanceDate ?? todayISO(),
    events: [],
    refiMode: "payment",
    newApr: "",
    newPayment: "",
    newTerm: "",
    upfront: "0.00",
    financed: "0.00",
  };
}

function moneyOrZero(text: string, currency: string): number {
  return text.trim() ? parseAmount(text, currency) : 0;
}

export function LoanPlans() {
  const session = useSession();
  const hidden = !!session.user?.privacyMode;
  const currency = session.currency;
  const [reload, setReload] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const list = useLoad(
    () => api<{ scenarios: ScenarioSummary[]; loans: LoanChoice[]; cashAccounts: { id: string; name: string }[]; planningNote: string; modelNote: string }>(
      scoped(session.householdId, `/loan-scenarios${showArchived ? "?archived=1" : ""}`, session.spaceId),
    ),
    [session.householdId, session.spaceId, session.tick, reload, showArchived],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<PlanView | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tableSide, setTableSide] = useState<"plan" | "baseline">("plan");
  const [showAll, setShowAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [payment, setPayment] = useState({ accountId: "", date: todayISO(), principal: "", interest: "", fee: "" });

  async function run(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  function start(kind: Draft["kind"]) {
    const loan = list.data?.loans[0];
    setDraft(blank(kind, loan, currency));
    setView(null);
    setStatus("");
    setError("");
    setConfirmDelete(false);
    setTableSide("plan");
  }

  function applyLoan(accountId: string) {
    const loan = list.data?.loans.find((item) => item.id === accountId);
    setDraft((current) => {
      if (!current) return current;
      if (current.id || !loan) return { ...current, accountId };
      return { ...current, ...blank(current.kind, loan, currency), name: current.name, kind: current.kind };
    });
  }

  async function openPlan(id: string) {
    await run(async () => {
      const detail = await api<PlanView>(scoped(session.householdId, `/loan-scenarios/${id}`, session.spaceId));
      setView(detail);
      setDraft(draftFrom(detail, currency));
      setStatus("");
      setConfirmDelete(false);
      setShowAll(false);
      setTableSide("plan");
    });
  }

  function payload(current: Draft) {
    if (!current.accountId) throw new Error("Choose a loan.");
    if (!current.name.trim()) throw new Error("Name the plan.");
    const apr = percentBpsFromInput(current.apr);
    if (apr == null) throw new Error("Enter the APR.");
    const events = current.kind === "extra"
      ? current.events.map((event) => {
          const month = Number(event.month);
          if (!Number.isInteger(month) || month < 1) throw new Error("Event months start at 1.");
          const monthIndex = month - 1;
          if (event.kind === "holiday") return { monthIndex, holiday: true };
          if (event.kind === "extra") return { monthIndex, extraOneTimeMinor: parseAmount(event.amount, currency) };
          if (event.kind === "rate") {
            const rate = percentBpsFromInput(event.amount);
            if (rate == null) throw new Error("Enter the new rate.");
            return { monthIndex, aprBps: rate };
          }
          return { monthIndex, paymentMinor: parseAmount(event.amount, currency) };
        })
      : [];
    const refinance = current.kind === "refinance"
      ? {
          mode: current.refiMode,
          newAprBps: percentBpsFromInput(current.newApr) ?? (() => { throw new Error("Enter the proposed APR."); })(),
          newPaymentMinor: current.refiMode === "payment" ? parseAmount(current.newPayment, currency) : undefined,
          newTermMonths: current.refiMode === "term" ? Number(current.newTerm) : undefined,
          upfrontFeeMinor: moneyOrZero(current.upfront, currency),
          financedFeeMinor: moneyOrZero(current.financed, currency),
        }
      : undefined;
    if (refinance?.mode === "term" && (!Number.isInteger(refinance.newTermMonths) || (refinance.newTermMonths ?? 0) < 1)) {
      throw new Error("Enter the term in whole months.");
    }
    return {
      accountId: current.accountId,
      name: current.name.trim(),
      kind: current.kind,
      balanceMinor: parseAmount(current.balance, currency),
      balanceDate: current.balanceDate,
      aprBps: apr,
      paymentMinor: parseAmount(current.payment, currency),
      extraMinor: current.kind === "extra" ? moneyOrZero(current.extra, currency) : 0,
      startDate: current.startDate,
      frequency: "monthly",
      interestMethod: "monthly_nominal",
      events,
      refinance,
      version: current.version,
    };
  }

  if (list.loading && !list.data) return <Loading label="Loading loan plans" />;
  if (!list.data) return <ErrorNote message={list.error ?? "Loan plans did not load."} onRetry={() => setReload((item) => item + 1)} />;
  const loans = list.data.loans;
  const schedule = view ? (tableSide === "baseline" ? view.baseline : view.scenario) : null;
  const shown = schedule ? (showAll ? schedule.months : schedule.months.slice(0, 36)) : [];

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Loan plans</h2>
      <p>{list.data.planningNote}</p>
      <p className="muted">{list.data.modelNote} The model uses a monthly payment. A weekly or biweekly schedule is not converted into a monthly amount.</p>
      <div className="row">
        <button className="btn" type="button" onClick={() => start("extra")}>New extra-payment plan</button>
        <button className="btn-secondary" type="button" onClick={() => start("refinance")}>New refinance comparison</button>
        <button className="btn-quiet" type="button" onClick={() => setShowArchived((item) => !item)}>{showArchived ? "Hide archived plans" : "Show archived plans"}</button>
      </div>
      {!loans.length ? <p>Add a loan account before saving a plan.</p> : null}
      {list.data.scenarios.length ? (
        <ul className="list">
          {list.data.scenarios.map((scenario) => (
            <li key={scenario.id}>
              <button className="btn-quiet" type="button" onClick={() => void openPlan(scenario.id)}>{scenario.name}</button>
              <span className="muted">{scenario.kind === "refinance" ? "Refinance" : "Extra payment"} · {scenario.accountName}{scenario.archived ? " · Archived" : ""}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No saved plans yet.</p>}

      {draft ? (
        <div style={{ marginTop: 16 }}>
          <h3>{draft.id ? "Edit plan" : draft.kind === "refinance" ? "New refinance comparison" : "New extra-payment plan"}</h3>
          {hidden ? <Notice>Amounts are hidden. Show amounts before editing a plan.</Notice> : null}
          <Field label="Loan">
            <select name="loan" value={draft.accountId} disabled={hidden} onChange={(event) => applyLoan(event.target.value)}>
              <option value="">Choose a loan</option>
              {loans.map((loan) => <option key={loan.id} value={loan.id}>{loan.name}</option>)}
            </select>
          </Field>
          <Field label="Plan name"><input value={hidden ? "" : draft.name} disabled={hidden} placeholder={hidden ? "••••" : "Name this plan"} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <div className="grid two">
            <Field label="Balance"><input inputMode="decimal" value={hidden ? "" : draft.balance} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, balance: event.target.value })} /></Field>
            <Field label="Balance date"><input type="date" value={draft.balanceDate} disabled={hidden} onChange={(event) => setDraft({ ...draft, balanceDate: event.target.value })} /></Field>
            <Field label="APR percent"><input inputMode="decimal" value={hidden ? "" : draft.apr} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, apr: event.target.value })} /></Field>
            <Field label="Payment"><input inputMode="decimal" value={hidden ? "" : draft.payment} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, payment: event.target.value })} /></Field>
            <Field label="Start date"><input type="date" value={draft.startDate} disabled={hidden} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></Field>
            {draft.kind === "extra" ? <Field label="Recurring extra"><input inputMode="decimal" value={hidden ? "" : draft.extra} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, extra: event.target.value })} /></Field> : null}
          </div>
          {draft.kind === "extra" ? (
            <div>
              <h3>Dated events</h3>
              <p className="muted">Month 1 is the first payment. Extras in the same month are added. Two different rates, or a holiday plus a payment, are rejected.</p>
              {draft.events.map((event, index) => (
                <div className="grid three" key={index}>
                  <Field label="Event month"><input inputMode="numeric" value={event.month} disabled={hidden} onChange={(change) => setDraft({ ...draft, events: draft.events.map((item, itemIndex) => itemIndex === index ? { ...item, month: change.target.value } : item) })} /></Field>
                  <Field label="Event">
                    <select value={event.kind} disabled={hidden} onChange={(change) => setDraft({ ...draft, events: draft.events.map((item, itemIndex) => itemIndex === index ? { ...item, kind: change.target.value as EventDraft["kind"] } : item) })}>
                      <option value="extra">One-time extra</option>
                      <option value="payment">Payment change</option>
                      <option value="rate">Rate change</option>
                      <option value="holiday">Payment holiday</option>
                    </select>
                  </Field>
                  {event.kind === "holiday" ? <p className="muted">No payment this month.</p> : (
                    <Field label={event.kind === "rate" ? "Event rate" : "Event amount"}>
                      <input inputMode="decimal" value={hidden ? "" : event.amount} disabled={hidden} placeholder={hidden ? "••••" : ""} onChange={(change) => setDraft({ ...draft, events: draft.events.map((item, itemIndex) => itemIndex === index ? { ...item, amount: change.target.value } : item) })} />
                    </Field>
                  )}
                </div>
              ))}
              <button className="btn-secondary" type="button" disabled={hidden} onClick={() => setDraft({ ...draft, events: [...draft.events, { month: "1", kind: "extra", amount: "" }] })}>Add an event</button>
            </div>
          ) : (
            <div>
              <Field label="Input mode">
                <select value={draft.refiMode} disabled={hidden} onChange={(event) => setDraft({ ...draft, refiMode: event.target.value as Draft["refiMode"] })}>
                  <option value="payment">Set the new payment</option>
                  <option value="term">Set the term in months</option>
                </select>
              </Field>
              <div className="grid two">
                <Field label="Proposed APR"><input inputMode="decimal" value={hidden ? "" : draft.newApr} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, newApr: event.target.value })} /></Field>
                {draft.refiMode === "payment"
                  ? <Field label="Proposed payment"><input inputMode="decimal" value={hidden ? "" : draft.newPayment} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, newPayment: event.target.value })} /></Field>
                  : <Field label="Term in months"><input inputMode="numeric" value={hidden ? "" : draft.newTerm} disabled={hidden} onChange={(event) => setDraft({ ...draft, newTerm: event.target.value })} /></Field>}
                <Field label="Upfront fee"><input inputMode="decimal" value={hidden ? "" : draft.upfront} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, upfront: event.target.value })} /></Field>
                <Field label="Financed fee"><input inputMode="decimal" value={hidden ? "" : draft.financed} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setDraft({ ...draft, financed: event.target.value })} /></Field>
              </div>
              <p className="muted">The upfront fee is paid now and is not added to the new principal. The financed fee is added to the new principal once.</p>
            </div>
          )}
          {error ? <Notice kind="bad">{error}{error.includes("Reload") && draft.id ? <button className="btn-secondary" type="button" onClick={() => void openPlan(draft.id!)}>Reload plan</button> : null}</Notice> : null}
          {status ? <Notice>{status}</Notice> : null}
          <div className="row">
            <button className="btn-secondary" type="button" disabled={busy || hidden} onClick={() => void run(async () => {
              const result = await api<PlanView>(scoped(session.householdId, "/loan-scenarios/preview", session.spaceId), { method: "POST", body: JSON.stringify(payload(draft)) });
              setView(result);
              setStatus("Calculated. Nothing was saved.");
              setTableSide("plan");
            })}>Calculate</button>
            <button className="btn" type="button" disabled={busy || hidden} onClick={() => void run(async () => {
              const body = JSON.stringify(payload(draft));
              const path = draft.id ? `/loan-scenarios/${draft.id}` : "/loan-scenarios";
              const saved = await api<PlanView>(scoped(session.householdId, path, session.spaceId), { method: draft.id ? "PATCH" : "POST", body });
              setView(saved);
              setDraft(draftFrom(saved, currency));
              setStatus("Plan saved.");
              setReload((item) => item + 1);
            })}>Save plan</button>
            {draft.id ? <button className="btn-secondary" type="button" disabled={busy} onClick={() => void run(async () => {
              await downloadFile(scoped(session.householdId, `/loan-scenarios/${draft.id}/export`, session.spaceId), "loan-plan.csv");
              setStatus("Schedule exported.");
            })}>Export schedule</button> : null}
            {draft.id ? <button className="btn-quiet" type="button" disabled={busy || hidden} onClick={() => void run(async () => {
              const copy = await api<PlanView>(scoped(session.householdId, `/loan-scenarios/${draft.id}/duplicate`, session.spaceId), { method: "POST" });
              setView(copy);
              setDraft(draftFrom(copy, currency));
              setStatus("Plan copied.");
              setReload((item) => item + 1);
            })}>Duplicate plan</button> : null}
            {draft.id ? <button className="btn-quiet" type="button" disabled={busy || hidden} onClick={() => void run(async () => {
              const next = await api<PlanView>(scoped(session.householdId, `/loan-scenarios/${draft.id}/archive`, session.spaceId), { method: "POST", body: JSON.stringify({ version: draft.version, archived: true }) });
              setView(next);
              setDraft(draftFrom(next, currency));
              setStatus("Plan archived.");
              setReload((item) => item + 1);
            })}>Archive plan</button> : null}
            {draft.id && !confirmDelete ? <button className="btn-quiet" type="button" onClick={() => setConfirmDelete(true)}>Delete plan</button> : null}
            {draft.id && confirmDelete ? <button className="btn-quiet" type="button" disabled={busy} onClick={() => void run(async () => {
              await api(scoped(session.householdId, `/loan-scenarios/${draft.id}`, session.spaceId), { method: "DELETE", body: JSON.stringify({ version: draft.version }) });
              setDraft(null);
              setView(null);
              setStatus("Plan deleted.");
              setConfirmDelete(false);
              setReload((item) => item + 1);
            })}>Confirm delete</button> : null}
          </div>
        </div>
      ) : null}

      {view ? <PlanResult view={view} tableSide={tableSide} setTableSide={setTableSide} shown={shown} showAll={showAll} setShowAll={setShowAll} schedule={schedule} onRefresh={draft?.id ? () => void run(async () => {
        const next = await api<PlanView>(scoped(session.householdId, `/loan-scenarios/${draft.id}/refresh`, session.spaceId), { method: "POST", body: JSON.stringify({ version: draft.version }) });
        setView(next);
        setDraft(draftFrom(next, currency));
        setStatus("Ledger balance copied into the plan.");
      }) : undefined} /> : null}

      {draft?.id ? (
        <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (!payment.accountId) throw new Error("Choose the cash account.");
            await api(scoped(session.householdId, `/loan-scenarios/${draft.id}/record-payment`, session.spaceId), {
              method: "POST",
              body: JSON.stringify({
                cashAccountId: payment.accountId,
                date: payment.date,
                principalMinor: moneyOrZero(payment.principal, currency),
                interestMinor: moneyOrZero(payment.interest, currency),
                feeMinor: moneyOrZero(payment.fee, currency),
                opId: crypto.randomUUID(),
              }),
            });
            setStatus("Payment posted.");
            session.bump();
            if (draft.id) await openPlan(draft.id);
          });
        }}>
          <h3>Record an actual payment</h3>
          <p>Posting a payment is separate from this plan. It uses cash you already have. It does not reserve cash, submit a loan application, or mark a refinance complete. Interest and fees are the cost. Principal is not a second expense.</p>
          <Field label="Cash account">
            <select value={payment.accountId} disabled={hidden} onChange={(event) => setPayment({ ...payment, accountId: event.target.value })}>
              <option value="">Choose cash</option>
              {list.data.cashAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </Field>
          <div className="grid two">
            <Field label="Payment date"><input type="date" value={payment.date} disabled={hidden} onChange={(event) => setPayment({ ...payment, date: event.target.value })} /></Field>
            <Field label="Principal"><input inputMode="decimal" value={hidden ? "" : payment.principal} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setPayment({ ...payment, principal: event.target.value })} /></Field>
            <Field label="Interest"><input inputMode="decimal" value={hidden ? "" : payment.interest} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setPayment({ ...payment, interest: event.target.value })} /></Field>
            <Field label="Fee"><input inputMode="decimal" value={hidden ? "" : payment.fee} disabled={hidden} placeholder={hidden ? "••••" : "0.00"} onChange={(event) => setPayment({ ...payment, fee: event.target.value })} /></Field>
          </div>
          <button className="btn-secondary" type="submit" disabled={busy || hidden}>Post payment</button>
        </form>
      ) : null}
      {view?.audit?.length ? (
        <div style={{ marginTop: 16 }}>
          <h3>History</h3>
          <ul className="list">{view.audit.map((item) => <li key={`${item.createdAt}-${item.version}`}><span>{item.detail}</span><span className="muted">{item.createdAt.slice(0, 10)}</span></li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function PlanResult({ view, tableSide, setTableSide, shown, showAll, setShowAll, schedule, onRefresh }: {
  view: PlanView;
  tableSide: "plan" | "baseline";
  setTableSide: (side: "plan" | "baseline") => void;
  shown: MonthRow[];
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  schedule: Schedule | null;
  onRefresh?: () => void;
}) {
  const points = samples(view.scenario.months);
  return (
    <div style={{ marginTop: 16 }}>
      {view.snapshot?.stale ? (
        <Notice kind="demo">
          {view.snapshot.note} Ledger balance <Money minor={view.snapshot.ledgerBalanceMinor} /> as of {view.snapshot.ledgerAsOf}. Saved snapshot <Money minor={view.balanceMinor} /> from {view.balanceDate}.
          {onRefresh ? <button className="btn-secondary" type="button" onClick={onRefresh}>Use the ledger balance</button> : null}
        </Notice>
      ) : view.snapshot ? <p className="muted">{view.snapshot.note}</p> : null}
      <div className="loan-grid">
        <article>
          <h3>Baseline</h3>
          <Payoff schedule={view.baseline} />
        </article>
        <article>
          <h3>{view.kind === "refinance" ? "Proposed loan" : "This plan"}</h3>
          <Payoff schedule={view.scenario} />
        </article>
      </div>
      {view.comparison ? (
        view.comparison.incomplete
          ? <p>{view.comparison.note}</p>
          : <p>Interest saved <Money minor={view.comparison.interestSavedMinor ?? 0} />. Time saved {view.comparison.monthsSaved ?? 0} {view.comparison.monthsSaved === 1 ? "month" : "months"}. {view.comparison.note}</p>
      ) : null}
      {view.refinanceResult ? <RefinanceSummary refinance={view.refinanceResult} /> : null}
      {points.length >= 2 ? <Spark points={points} label="Remaining balance in this plan" /> : null}
      <div className="row">
        <button className="chip" type="button" aria-pressed={tableSide === "baseline"} onClick={() => setTableSide("baseline")}>Baseline schedule</button>
        <button className="chip" type="button" aria-pressed={tableSide === "plan"} onClick={() => setTableSide("plan")}>{view.kind === "refinance" ? "Proposed schedule" : "Plan schedule"}</button>
      </div>
      {schedule && !schedule.paidOff ? <p>This is not a finished payoff. The rows are only the months the model could show.</p> : null}
      <div className="table-scroll">
        <table className="schedule-table">
          <thead><tr><th>Date</th><th className="num">Payment</th><th className="num">Interest</th><th className="num">Principal</th><th className="num">Extra</th><th className="num">Remaining</th></tr></thead>
          <tbody>
            {shown.map((month) => (
              <tr key={`${tableSide}-${month.date}-${month.balanceMinor}`}>
                <td data-label="Date">{month.date}{month.holiday ? " · holiday" : ""}</td>
                <td className="num" data-label="Payment"><Money minor={month.paymentMinor} /></td>
                <td className="num" data-label="Interest"><Money minor={month.interestMinor} /></td>
                <td className="num" data-label="Principal"><Money minor={month.principalMinor} /></td>
                <td className="num" data-label="Extra"><Money minor={month.extraMinor} /></td>
                <td className="num" data-label="Remaining"><Money minor={month.balanceMinor} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {schedule && schedule.months.length > shown.length ? <button className="btn-secondary" type="button" onClick={() => setShowAll(true)}>Show the whole schedule</button> : null}
    </div>
  );
}

function Payoff({ schedule }: { schedule: Schedule }) {
  return (
    <div>
      <p>{schedule.paidOff ? `Payoff ${schedule.payoffDate}` : "Not paid off within 100 years"}</p>
      <p>{schedule.payoffMonths ?? "—"} payments · Interest {schedule.paidOff ? <Money minor={schedule.totalInterestMinor} /> : "not a lifetime total"} · Total paid {schedule.paidOff ? <Money minor={schedule.totalPaidMinor} /> : "not a lifetime total"}</p>
      {schedule.negativeAmortization ? <p>A payment does not cover the interest, so the balance grows in at least one month.</p> : null}
    </div>
  );
}

function RefinanceSummary({ refinance }: { refinance: Refinance }) {
  return (
    <div>
      <p>Payment difference <Money minor={refinance.paymentDifferenceMinor} />. Current payoff {refinance.currentPayoffDate ?? "not paid off"}. Proposed payoff {refinance.proposedPayoffDate ?? "not paid off"}.</p>
      <p>Upfront fee <Money minor={refinance.upfrontFeeMinor} />. Financed fee <Money minor={refinance.financedFeeMinor} />.</p>
      {refinance.comparable && refinance.netBenefitMinor != null ? (
        <p>{refinance.netBenefitMinor >= 0 ? "Net modeled benefit" : "Net modeled additional cost"} <Money minor={Math.abs(refinance.netBenefitMinor)} />. Current future cost <Money minor={refinance.currentTotalCostMinor ?? 0} />. Proposed future cost <Money minor={refinance.proposedTotalCostMinor ?? 0} />.</p>
      ) : <p>The interest totals are not compared because one side does not pay off within 100 years.</p>}
      {refinance.lowerPaymentCostsMore ? <p>The lower payment is not savings. The longer loan costs more overall.</p> : null}
      {refinance.breakEvenMonth ? <p>Break-even is month {refinance.breakEvenMonth} in this model.</p> : null}
      <p>This comparison does not submit a loan application or refinance the loan.</p>
    </div>
  );
}

function samples(months: MonthRow[]) {
  if (months.length < 2) return [];
  const step = Math.max(1, Math.ceil(months.length / 24));
  return months.filter((_, index) => index % step === 0 || index === months.length - 1).map((month) => ({ date: month.date, balanceMinor: month.balanceMinor }));
}

function draftFrom(detail: PlanView, currency: string): Draft {
  const refinance = detail.refinance ?? undefined;
  return {
    id: detail.id,
    version: detail.version,
    kind: detail.kind,
    accountId: detail.accountId,
    name: detail.name,
    balance: minorToInput(detail.balanceMinor, currency),
    balanceDate: detail.balanceDate,
    apr: (detail.aprBps / 100).toFixed(2),
    payment: minorToInput(detail.paymentMinor, currency),
    extra: minorToInput(detail.extraMinor, currency),
    startDate: detail.startDate,
    events: (detail.events ?? []).map((event) => {
      const month = String(event.monthIndex + 1);
      if (event.holiday) return { month, kind: "holiday" as const, amount: "" };
      if (event.aprBps != null) return { month, kind: "rate" as const, amount: (event.aprBps / 100).toFixed(2) };
      if (event.paymentMinor != null) return { month, kind: "payment" as const, amount: minorToInput(event.paymentMinor, currency) };
      return { month, kind: "extra" as const, amount: minorToInput(event.extraOneTimeMinor ?? 0, currency) };
    }),
    refiMode: refinance?.mode ?? "payment",
    newApr: refinance ? (refinance.newAprBps / 100).toFixed(2) : "",
    newPayment: refinance?.newPaymentMinor != null ? minorToInput(refinance.newPaymentMinor, currency) : "",
    newTerm: refinance?.newTermMonths != null ? String(refinance.newTermMonths) : "",
    upfront: minorToInput(refinance?.upfrontFeeMinor ?? 0, currency),
    financed: minorToInput(refinance?.financedFeeMinor ?? 0, currency),
  };
}
