import { useState } from "react";
import { api } from "../api.js";
import { minorToInput, monthLabel, parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Bucket, Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

type View = "zero" | "envelope" | "flex" | "income";

export function Plan() {
  const session = useSession();
  const [view, setView] = useState<View>("zero");
  const [move, setMove] = useState(false);
  const [message, setMessage] = useState("");
  const state = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  if (state.loading && !state.data) return <Loading label="Loading the plan" />;
  if (!state.data) return <ErrorNote message={state.error ?? "No plan"} onRetry={session.bump} />;
  const dash = state.data;
  const rows = dash.budget.buckets.filter((row) => {
    const bucket = dash.buckets.find((item) => item.id === row.bucketId);
    return bucket && !bucket.systemRole && !bucket.archived;
  });
  const label = dash.household.labelMode === "envelopes" ? "envelope" : "category";

  async function assign(bucketId: string, text: string) {
    const amountMinor = parseAmount(text, dash.household.currency);
    await api(scoped(session.householdId, "/assignments"), {
      method: "POST",
      body: JSON.stringify({ spaceId: dash.spaceId, bucketId, periodKey: dash.budget.periodKey, amountMinor }),
    });
    session.bump();
  }

  return (
    <Page title={monthLabel(dash.budget.periodKey)} lede={`Ready to Assign is ${session.user?.privacyMode ? "hidden" : "the cash that still needs a job"}. The ${label} names are a view of the same balances.`} actions={<button className="btn-secondary" onClick={() => setMove(true)}>Move money</button>}>
      <div className="chips" aria-label="Plan view">
        {([["zero", "Zero-based"], ["envelope", "Envelopes"], ["flex", "Flex"], ["income", "Income plan"]] as const).map(([id, name]) => (
          <button key={id} className="chip" aria-pressed={view === id} onClick={() => setView(id)}>{name}</button>
        ))}
      </div>
      {message ? <Notice>{message}</Notice> : null}
      <p className="muted">Ready to Assign <Money minor={dash.budget.readyToAssignMinor} /> · Future months <Money minor={dash.budget.futureAssignedMinor} /></p>
      <div className="row" style={{ margin: "8px 0 16px" }}>
        <button className="btn-secondary" onClick={async () => {
          const preview = await api<{ explanation: string; lines: { bucketId: string; amountMinor: number }[] }>(scoped(session.householdId, "/auto-assign"), { method: "POST", body: JSON.stringify({ spaceId: dash.spaceId, strategy: "underfunded", apply: false }) });
          setMessage(preview.explanation);
          if (preview.lines.length && window.confirm("Apply this assignment? Expected income is not used.")) {
            await api(scoped(session.householdId, "/auto-assign"), { method: "POST", body: JSON.stringify({ spaceId: dash.spaceId, strategy: "underfunded", apply: true }) });
            session.bump();
          }
        }}>Preview underfunded targets</button>
        <NewBucket spaceId={dash.spaceId} />
      </div>
      {view === "income" ? <IncomePlan currency={dash.household.currency} buckets={dash.buckets} /> : null}
      {view === "envelope" ? (
        <div className="grid three">
          {rows.map((row) => (
            <article key={row.bucketId} className="envelope">
              <span className="kicker">{row.group}</span>
              <strong>{row.name}</strong>
              <Money minor={row.availableMinor} />
              <AssignField currency={dash.household.currency} value={row.assignedMinor} disabled={!!session.user?.privacyMode} onSave={(text) => assign(row.bucketId, text)} />
            </article>
          ))}
        </div>
      ) : null}
      {view === "flex" ? (
        ["fixed", "non_monthly", "flexible"].map((role) => (
          <section key={role} style={{ marginTop: 16 }}>
            <h2>{role === "non_monthly" ? "Non-monthly" : role[0].toUpperCase() + role.slice(1)}</h2>
            <BucketTable rows={rows.filter((row) => dash.buckets.find((bucket) => bucket.id === row.bucketId)?.flexRole === role)} currency={dash.household.currency} hidden={!!session.user?.privacyMode} onAssign={assign} />
          </section>
        ))
      ) : null}
      {view === "zero" ? <BucketTable rows={rows} currency={dash.household.currency} hidden={!!session.user?.privacyMode} onAssign={assign} /> : null}
      {move ? <MoveMoney buckets={dash.buckets} periodKey={dash.budget.periodKey} spaceId={dash.spaceId} currency={dash.household.currency} onClose={() => setMove(false)} /> : null}
    </Page>
  );
}

function AssignField({ value, currency, disabled, onSave }: { value: number; currency: string; disabled: boolean; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(minorToInput(value, currency));
  const [error, setError] = useState("");
  return (
    <label className="field">
      <span>Assigned</span>
      <input value={disabled ? "Hidden" : text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={async () => {
        if (disabled || text === minorToInput(value, currency)) return;
        try { setError(""); await onSave(text); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not assign."); }
      }} />
      {error ? <span role="alert">{error}</span> : null}
    </label>
  );
}

function BucketTable({ rows, currency, hidden, onAssign }: { rows: Dashboard["budget"]["buckets"]; currency: string; hidden: boolean; onAssign: (id: string, text: string) => Promise<void> }) {
  if (!rows.length) return <p className="muted">Nothing in this group.</p>;
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <table>
        <thead><tr><th>Name</th><th className="num">Assigned</th><th className="num">Activity</th><th className="num">Available</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.bucketId}>
              <td>{row.name}{row.creditOverspendMinor ? " · card overspend" : ""}</td>
              <td className="num"><AssignField currency={currency} value={row.assignedMinor} disabled={hidden} onSave={(text) => onAssign(row.bucketId, text)} /></td>
              <td className="num"><Money minor={-row.activityMinor} /></td>
              <td className="num"><Money minor={row.availableMinor} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewBucket({ spaceId }: { spaceId: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const form = useFormError();
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>New category</button>;
  return (
    <Modal title="New category" onClose={() => setOpen(false)}>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const percent = String(data.get("percent") || "").trim();
        let target: { type: string; amountMinor: number; cadence: string; percentBps: number } | undefined;
        if (percent) {
          const percentBps = Math.round(Number(percent) * 100);
          if (!Number.isInteger(percentBps) || percentBps < 0 || percentBps > 10000) throw new Error("Enter a percent from 0 to 100.");
          target = { type: "set_aside", amountMinor: 0, cadence: "monthly", percentBps };
        }
        await api(scoped(session.householdId, "/buckets"), { method: "POST", body: JSON.stringify({
          spaceId, name: data.get("name"), group: data.get("group"), flexRole: data.get("flexRole"),
          envelopeStyle: data.get("style"), purpose: data.get("purpose") || undefined, rollover: data.get("rollover") || "both",
          target,
        }) });
        setOpen(false);
        session.bump();
      })}>
        <Field label="Name"><input name="name" required /></Field>
        <Field label="Group"><input name="group" defaultValue="Spending" /></Field>
        <Field label="Flex role"><select name="flexRole"><option value="flexible">Flexible</option><option value="fixed">Fixed</option><option value="non_monthly">Non-monthly</option></select></Field>
        <Field label="Envelope style"><select name="style"><option value="regular">Regular</option><option value="annual">Annual</option><option value="goal">Goal</option><option value="debt">Debt</option></select></Field>
        <Field label="Purpose"><select name="purpose"><option value="">General</option><option value="emergency">Emergency</option><option value="sinking">Sinking fund</option><option value="giving">Giving</option><option value="goal">Goal</option><option value="debt">Debt</option></select></Field>
        <Field label="Rollover"><select name="rollover"><option value="both">Keep leftovers and cover shortfalls</option><option value="positive">Keep leftovers only</option><option value="none">Reset each month</option></select></Field>
        <Field label="Percent of posted income"><input name="percent" inputMode="decimal" placeholder="Optional, such as 10" /></Field>
        <p className="muted">A percent uses income that has already arrived. It does not assign the money and it ignores expected pay.</p>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save</button>
      </form>
    </Modal>
  );
}

function MoveMoney({ buckets, periodKey, spaceId, currency, onClose }: { buckets: Bucket[]; periodKey: string; spaceId: string; currency: string; onClose: () => void }) {
  const session = useSession();
  const form = useFormError();
  const choices = buckets.filter((bucket) => !bucket.systemRole);
  return (
    <Modal title="Move money" onClose={onClose}>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const from = String(data.get("from") || "");
        const to = String(data.get("to") || "");
        await api(scoped(session.householdId, "/move"), { method: "POST", body: JSON.stringify({
          spaceId, periodKey, fromBucketId: from || null, toBucketId: to || null, amountMinor: parseAmount(String(data.get("amount")), currency),
        }) });
        session.bump();
        onClose();
      })}>
        <Field label="From"><select name="from"><option value="">Ready to Assign</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="To"><select name="to"><option value="">Ready to Assign</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="Amount"><input name="amount" required inputMode="decimal" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Move</button>
      </form>
    </Modal>
  );
}

function IncomePlan({ currency, buckets }: { currency: string; buckets: Bucket[] }) {
  const session = useSession();
  const state = useLoad(() => api<{ plannedMinor: number; expectedIncomeMinor: number; unplannedMinor: number; balanced: boolean; note: string; lines: { bucketId: string; plannedMinor: number }[]; periodKey: string; spaceId: string }>(scoped(session.householdId, "/income-plan", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const form = useFormError();
  if (state.loading && !state.data) return <Loading label="Loading the income plan" />;
  if (!state.data) return <ErrorNote message={state.error ?? "No income plan"} />;
  const plan = state.data;
  return (
    <form className="card" onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      const lines = buckets.filter((bucket) => bucket.kind === "expense" && !bucket.systemRole).map((bucket) => ({
        bucketId: bucket.id, plannedMinor: parseAmount(String(data.get(bucket.id) || "0"), currency),
      }));
      await api(scoped(session.householdId, "/income-plan"), { method: "PUT", body: JSON.stringify({ spaceId: plan.spaceId, periodKey: plan.periodKey, lines }) });
      session.bump();
    })}>
      <p>{plan.note}</p>
      <p>Expected income <Money minor={plan.expectedIncomeMinor} /> · Planned <Money minor={plan.plannedMinor} /> · Left unplanned <Money minor={plan.unplannedMinor} /></p>
      {buckets.filter((bucket) => bucket.kind === "expense" && !bucket.systemRole).map((bucket) => (
        <Field key={bucket.id} label={bucket.name}>
          <input name={bucket.id} defaultValue={minorToInput(plan.lines.find((line) => line.bucketId === bucket.id)?.plannedMinor ?? 0, currency)} />
        </Field>
      ))}
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      <button className="btn" type="submit">Save income plan</button>
    </form>
  );
}
