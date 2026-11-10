import { useState } from "react";
import { api } from "../api.js";
import { minorToInput, monthLabel, parseAmount, percentBpsFromInput, todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Bucket, Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

type View = "zero" | "envelope" | "flex" | "income";

export function Plan() {
  const session = useSession();
  const [view, setView] = useState<View>("zero");
  const [move, setMove] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
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
              <button className="btn-secondary" type="button" onClick={() => setEditing(row.bucketId)}>Edit</button>
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
            <BucketTable rows={rows.filter((row) => dash.buckets.find((bucket) => bucket.id === row.bucketId)?.flexRole === role)} buckets={dash.buckets} currency={dash.household.currency} hidden={!!session.user?.privacyMode} onAssign={assign} onEdit={setEditing} />
          </section>
        ))
      ) : null}
      {view === "zero" ? <BucketTable rows={rows} buckets={dash.buckets} currency={dash.household.currency} hidden={!!session.user?.privacyMode} onAssign={assign} onEdit={setEditing} /> : null}
      <ArchivedCategories buckets={dash.buckets} />
      <Fills dash={dash} />
      {editing && dash.buckets.some((bucket) => bucket.id === editing) ? <EditCategory bucket={dash.buckets.find((bucket) => bucket.id === editing) as Bucket} currency={dash.household.currency} periodKey={dash.budget.periodKey} funding={dash.funding} onClose={() => setEditing(null)} /> : null}
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

function BucketTable({ rows, buckets, currency, hidden, onAssign, onEdit }: { rows: Dashboard["budget"]["buckets"]; buckets: Bucket[]; currency: string; hidden: boolean; onAssign: (id: string, text: string) => Promise<void>; onEdit: (id: string) => void }) {
  if (!rows.length) return <p className="muted">Nothing in this group.</p>;
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <table>
        <thead><tr><th>Name</th><th className="num">Assigned</th><th className="num">Activity</th><th className="num">Available</th></tr></thead>
        <tbody>
          {rows.map((row) => {
            const bucket = buckets.find((item) => item.id === row.bucketId);
            const rule = bucket?.displayRollover ?? bucket?.rollover;
            return (
              <tr key={row.bucketId}>
                <td>{row.name}{row.creditOverspendMinor ? " · card overspend" : ""}{rule && rule !== "both" ? ` · rollover ${rule}` : ""} <button className="btn-secondary" type="button" onClick={() => onEdit(row.bucketId)}>Edit</button></td>
                <td className="num"><AssignField currency={currency} value={row.assignedMinor} disabled={hidden} onSave={(text) => onAssign(row.bucketId, text)} /></td>
                <td className="num"><Money minor={-row.activityMinor} /></td>
                <td className="num"><Money minor={row.availableMinor} /></td>
              </tr>
            );
          })}
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
          const percentBps = percentBpsFromInput(percent);
          if (percentBps == null) throw new Error("Enter a percent from 0 to 100.");
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

function EditCategory({ bucket, currency, periodKey, funding, onClose }: { bucket: Bucket; currency: string; periodKey: string; funding: Dashboard["funding"]; onClose: () => void }) {
  const session = useSession();
  const form = useFormError();
  const [effect, setEffect] = useState("");
  const progress = funding?.buckets.find((item) => item.bucketId === bucket.id);
  const rollover = bucket.displayRollover ?? bucket.rollover;
  const cap = bucket.displayRollover != null ? bucket.displayRolloverCapMinor : bucket.rolloverCapMinor;
  const percent = bucket.target?.percentBps == null ? "" : (bucket.target.percentBps / 100).toFixed(2);
  async function payload(data: FormData, preview: boolean) {
    const percentBps = percentBpsFromInput(String(data.get("percent") || ""));
    const type = String(data.get("targetType") || "none");
    const target = type === "none" ? null : {
      type,
      amountMinor: parseAmount(String(data.get("targetAmount") || "0"), currency),
      cadence: String(data.get("targetCadence") || "monthly"),
      dueDate: String(data.get("dueDate") || "") || undefined,
      pausedUntil: String(data.get("pausedUntil") || "") || undefined,
      percentBps,
    };
    return {
      version: bucket.version ?? 1,
      name: data.get("name"),
      group: data.get("group"),
      icon: String(data.get("icon") || "") || null,
      displayOrder: Number(data.get("displayOrder") || 0),
      kind: data.get("kind"),
      flexRole: data.get("flexRole"),
      envelopeStyle: data.get("style"),
      purpose: String(data.get("purpose") || "") || null,
      rollover: data.get("rollover"),
      rolloverCapMinor: String(data.get("rollover")) === "capped" ? parseAmount(String(data.get("cap") || "0"), currency) : null,
      archived: data.get("archived") === "on",
      hidden: bucket.hidden ?? false,
      target,
      effectivePeriod: String(data.get("effectivePeriod") || periodKey),
      recalculate: data.get("recalculate") === "on",
      preview,
    };
  }
  return (
    <Modal title={`Edit ${bucket.name}`} onClose={onClose}>
      <form onSubmit={(event) => form.run(event, async () => {
        const saved = await api<{ effect: string }>(scoped(session.householdId, `/buckets/${bucket.id}`), { method: "PATCH", body: JSON.stringify(await payload(new FormData(event.currentTarget), false)) });
        setEffect(saved.effect);
        session.bump();
        onClose();
      })}>
        <Field label="Name"><input name="name" required defaultValue={bucket.name} /></Field>
        <Field label="Group"><input name="group" required defaultValue={bucket.group} /></Field>
        <Field label="Icon"><input name="icon" defaultValue={bucket.icon ?? ""} maxLength={40} /></Field>
        <Field label="Display order"><input name="displayOrder" inputMode="numeric" defaultValue={bucket.displayOrder ?? 0} /></Field>
        <Field label="Kind"><select name="kind" defaultValue={bucket.kind}><option value="expense">Expense</option><option value="income">Income</option></select></Field>
        <Field label="Classification"><select name="flexRole" defaultValue={bucket.flexRole}><option value="flexible">Flexible</option><option value="fixed">Fixed</option><option value="non_monthly">Non-monthly</option><option value="income">Income</option><option value="reserve">Reserve</option></select></Field>
        <Field label="Envelope style"><select name="style" defaultValue={bucket.envelopeStyle}><option value="regular">Regular</option><option value="annual">Annual</option><option value="goal">Goal</option><option value="debt">Debt payment</option><option value="none">None</option></select></Field>
        <Field label="Purpose"><select name="purpose" defaultValue={bucket.purpose ?? ""}><option value="">General</option><option value="emergency">Emergency</option><option value="sinking">Sinking fund</option><option value="giving">Giving</option><option value="goal">Goal</option><option value="debt">Debt</option></select></Field>
        <Field label="Rollover"><select name="rollover" defaultValue={rollover}><option value="both">Keep leftovers and cover shortfalls</option><option value="positive">Keep leftovers only</option><option value="negative">Cover shortfalls only</option><option value="none">Reset each month</option><option value="capped">Keep leftovers up to a cap</option></select></Field>
        <Field label="Rollover cap"><input name="cap" inputMode="decimal" defaultValue={cap == null ? "" : minorToInput(cap, currency)} /></Field>
        <p className="muted">A rollover change applies when the selected month closes. Earlier months stay as they were unless you choose to recalculate and review the change.</p>
        <Field label="Effective month"><input name="effectivePeriod" type="month" defaultValue={bucket.rolloverEffectivePeriod ?? periodKey} /></Field>
        <label><input type="checkbox" name="recalculate" /> Recalculate earlier months with this rollover rule</label>
        <Field label="Target"><select name="targetType" defaultValue={bucket.target?.type ?? "none"}><option value="none">No target</option><option value="refill">Refill</option><option value="set_aside">Set aside</option><option value="balance_by_date">Balance by date</option><option value="maintain_balance">Maintain a balance</option><option value="debt_payment">Debt payment</option></select></Field>
        <Field label="Target amount"><input name="targetAmount" inputMode="decimal" defaultValue={bucket.target ? minorToInput(bucket.target.amountMinor, currency) : ""} /></Field>
        <Field label="Target repeats"><select name="targetCadence" defaultValue={bucket.target?.cadence ?? "monthly"}><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="twice_monthly">Twice a month</option><option value="monthly">Monthly</option><option value="every_2_months">Every two months</option><option value="every_3_months">Every three months</option><option value="every_6_months">Every six months</option><option value="annual">Annual</option><option value="custom">Custom</option></select></Field>
        <Field label="Target date"><input name="dueDate" type="date" defaultValue={bucket.target?.dueDate ?? ""} /></Field>
        <Field label="Percent of eligible posted income"><input name="percent" inputMode="decimal" defaultValue={percent} placeholder="Optional, such as 10.50" /></Field>
        <Field label="Pause until"><input name="pausedUntil" type="date" defaultValue={bucket.target?.pausedUntil ?? ""} /></Field>
        <p className="muted">Leave pause empty to resume. Saving a target does not assign money. A percent uses income that has already posted. Expected pay, transfers, refunds, loan proceeds, and opening balances are not included.</p>
        {progress && bucket.target?.percentBps != null ? (
          <p>Eligible posted income <Money minor={funding?.eligiblePostedIncomeMinor ?? 0} /> · {progress.percentLabel} · Target <Money minor={progress.targetMinor} /> · Funded <Money minor={progress.fundedMinor} /> · Still needed <Money minor={progress.shortfallMinor} /></p>
        ) : null}
        <label><input type="checkbox" name="archived" defaultChecked={!!bucket.archived} /> Archive this category</label>
        {effect ? <Notice>{effect}</Notice> : null}
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <div className="row">
          <button className="btn-secondary" type="button" onClick={async (event) => {
            const data = new FormData((event.currentTarget.form as HTMLFormElement));
            try {
              const preview = await api<{ effect: string; thisMonth: { readyDeltaMinor: number; availableDeltaMinor: number }; nextMonth: { readyDeltaMinor: number; availableDeltaMinor: number } }>(scoped(session.householdId, `/buckets/${bucket.id}`), { method: "PATCH", body: JSON.stringify(await payload(data, true)) });
              setEffect(`${preview.effect} This month's available balance changes by ${preview.thisMonth.availableDeltaMinor} minor units. Next month changes by ${preview.nextMonth.availableDeltaMinor}.`);
            } catch (caught) {
              setEffect(caught instanceof Error ? caught.message : "Could not preview.");
            }
          }}>Preview the rollover change</button>
          <button className="btn" type="submit">Save category</button>
        </div>
      </form>
    </Modal>
  );
}

function ArchivedCategories({ buckets }: { buckets: Bucket[] }) {
  const session = useSession();
  const archived = buckets.filter((bucket) => bucket.archived && !bucket.systemRole);
  if (!archived.length) return null;
  return (
    <section style={{ marginTop: 16 }}>
      <h2>Archived categories</h2>
      {archived.map((bucket) => (
        <div className="row" key={bucket.id}>
          <span>{bucket.name}</span>
          <button className="btn-secondary" type="button" onClick={async () => {
            await api(scoped(session.householdId, `/buckets/${bucket.id}`), { method: "PATCH", body: JSON.stringify({
              version: bucket.version ?? 1, name: bucket.name, group: bucket.group, icon: bucket.icon ?? null, displayOrder: bucket.displayOrder ?? 0,
              kind: bucket.kind, flexRole: bucket.flexRole, envelopeStyle: bucket.envelopeStyle, rollover: bucket.displayRollover ?? bucket.rollover,
              rolloverCapMinor: bucket.displayRolloverCapMinor ?? bucket.rolloverCapMinor ?? null, purpose: bucket.purpose ?? null, archived: false,
              target: bucket.target ?? null, effectivePeriod: new Date().toISOString().slice(0, 7),
            }) });
            session.bump();
          }}>Restore</button>
        </div>
      ))}
    </section>
  );
}

function Fills({ dash }: { dash: Dashboard }) {
  const session = useSession();
  const form = useFormError();
  const [preview, setPreview] = useState("");
  const choices = dash.buckets.filter((bucket) => !bucket.systemRole && !bucket.archived && bucket.kind === "expense");
  const state = useLoad(() => api<{ note: string; fills: FillRow[] }>(scoped(session.householdId, "/fills")), [session.householdId, session.tick]);
  async function linePayload(data: FormData) {
    const lines = [0, 1].flatMap((index) => {
      const bucketId = String(data.get(`bucket${index}`) || "");
      if (!bucketId) return [];
      const mode = String(data.get(`mode${index}`) || "add");
      return [{
        bucketId,
        mode,
        amountMinor: mode === "shortfall" || mode === "percent" ? null : parseAmount(String(data.get(`amount${index}`) || "0"), dash.household.currency),
        percentBps: mode === "percent" ? percentBpsFromInput(String(data.get(`percent${index}`) || "")) : null,
        priority: Number(data.get(`priority${index}`) || index + 1),
        sourceBucketId: String(data.get(`source${index}`) || "") || null,
      }];
    });
    return {
      spaceId: dash.spaceId,
      name: String(data.get("name") || ""),
      cadence: String(data.get("cadence") || "monthly"),
      customDays: String(data.get("cadence")) === "custom" ? Number(data.get("customDays") || 0) : null,
      startDate: String(data.get("startDate") || todayISO()),
      endDate: String(data.get("endDate") || "") || null,
      shortfallPolicy: String(data.get("policy") || "partial"),
      sweepBucketId: String(data.get("sweep") || "") || null,
      lines,
    };
  }
  return (
    <section id="fills" style={{ marginTop: 24 }}>
      <h2>Envelope fills</h2>
      <p className="muted">A fill gives a job to cash that is already in Ready to Assign. It is not a bank transfer, and a saved schedule is not an applied fill until it runs.</p>
      {state.data?.note ? <p className="muted">{state.data.note}</p> : null}
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        await api(scoped(session.householdId, "/fills"), { method: "POST", body: JSON.stringify(await linePayload(new FormData(event.currentTarget))) });
        setPreview("Saved. It is scheduled and has not moved any money.");
        session.bump();
      })}>
        <Field label="Name"><input name="name" required defaultValue="Payday fill" /></Field>
        <Field label="Schedule"><select name="cadence" defaultValue="monthly"><option value="once">Once</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="twice_monthly">Twice a month</option><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="custom">Custom</option></select></Field>
        <Field label="Custom days"><input name="customDays" inputMode="numeric" placeholder="Only for a custom schedule" /></Field>
        <Field label="Start"><input name="startDate" type="date" required defaultValue={todayISO()} /></Field>
        <Field label="End"><input name="endDate" type="date" /></Field>
        <Field label="If there is not enough cash"><select name="policy" defaultValue="partial"><option value="partial">Fund in priority order, then stop</option><option value="skip">Skip the whole occurrence</option></select></Field>
        <Field label="Sweep leftover Ready to Assign into"><select name="sweep"><option value="">Do not sweep</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        {[0, 1].map((index) => (
          <fieldset key={index}>
            <legend>{index === 0 ? "First envelope" : "Second envelope, optional"}</legend>
            <Field label="Envelope"><select name={`bucket${index}`} defaultValue={index === 0 ? choices[0]?.id ?? "" : ""}><option value="">None</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
            <Field label="What to add"><select name={`mode${index}`} defaultValue="add"><option value="add">Add a fixed amount</option><option value="top_up">Top up the available balance</option><option value="shortfall">Fund the target shortfall</option><option value="percent">Percent of eligible posted income</option></select></Field>
            <Field label="Amount or desired balance"><input name={`amount${index}`} inputMode="decimal" defaultValue={index === 0 ? "0.00" : ""} /></Field>
            <Field label="Percent"><input name={`percent${index}`} inputMode="decimal" placeholder="10.50" /></Field>
            <Field label="Priority"><input name={`priority${index}`} inputMode="numeric" defaultValue={index + 1} /></Field>
            <Field label="Take the money from"><select name={`source${index}`}><option value="">Ready to Assign</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
          </fieldset>
        ))}
        {preview ? <Notice>{preview}</Notice> : null}
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <div className="row">
          <button className="btn-secondary" type="button" onClick={async (event) => {
            try {
              const result = await api<{ note: string; policyText: string; statusLabel: string; plan: { totalAllocatedMinor: number; readyBeforeMinor: number; readyAfterMinor: number; shortfallMinor: number; explanation: string; allocations: { bucketId: string; requestedMinor: number; allocatedMinor: number }[] } | null }>(scoped(session.householdId, "/fills/preview"), { method: "POST", body: JSON.stringify(await linePayload(new FormData(event.currentTarget.form as HTMLFormElement))) });
              const plan = result.plan;
              setPreview(plan ? `${result.note} ${result.policyText} Preview is ${result.statusLabel}. Ready to Assign ${plan.readyBeforeMinor} becomes ${plan.readyAfterMinor}. Allocated ${plan.totalAllocatedMinor}. Short ${plan.shortfallMinor}. ${plan.explanation}` : result.note);
            } catch (caught) {
              setPreview(caught instanceof Error ? caught.message : "Could not preview.");
            }
          }}>Preview</button>
          <button className="btn" type="submit">Save fill</button>
        </div>
      </form>
      {(state.data?.fills ?? []).map((fill) => <FillCard key={fill.id} fill={fill} />)}
    </section>
  );
}

function FillCard({ fill }: { fill: FillRow }) {
  const session = useSession();
  const [history, setHistory] = useState<string>("");
  async function act(path: string, label: string) {
    try {
      const result = await api<{ statusLabel?: string; note?: string; explanation?: string }>(scoped(session.householdId, path), { method: "POST" });
      setHistory(`${label}: ${result.statusLabel ?? ""} ${result.explanation ?? result.note ?? ""}`.trim());
      session.bump();
    } catch (caught) {
      setHistory(caught instanceof Error ? caught.message : "Could not update the fill.");
    }
  }
  return (
    <article className="card" style={{ marginTop: 12 }}>
      <strong>{fill.name}</strong>
      <p>{fill.statusLabel} · {fill.cadence} · next {fill.nextDate ?? "none"} · {fill.shortfallPolicy === "skip" ? "Skip when cash is short" : "Fund in priority order when cash is short"}</p>
      {fill.lastOutcome ? <p>Last result: {fill.lastOutcome.statusLabel}{fill.lastOutcome.date ? ` on ${fill.lastOutcome.date}` : ""} · <Money minor={fill.lastOutcome.allocatedMinor} /></p> : <p>No occurrence has run.</p>}
      <div className="row">
        <button className="btn" type="button" onClick={() => act(`/fills/${fill.id}/run`, "Run now")}>Run now</button>
        <button className="btn-secondary" type="button" onClick={() => act(`/fills/${fill.id}/skip`, "Skip")}>Skip next date</button>
        {fill.statusLabel === "Paused"
          ? <button className="btn-secondary" type="button" onClick={() => act(`/fills/${fill.id}/resume`, "Resume")}>Resume</button>
          : <button className="btn-secondary" type="button" onClick={() => act(`/fills/${fill.id}/pause`, "Pause")}>Pause</button>}
        <button className="btn-secondary" type="button" onClick={async () => {
          const rows = await api<{ history: { date: string; statusLabel: string; allocatedMinor: number; shortfallMinor: number; detail?: { explanation?: string } }[] }>(scoped(session.householdId, `/fills/${fill.id}/history`));
          setHistory(rows.history.map((row) => `${row.date} ${row.statusLabel} allocated ${row.allocatedMinor} short ${row.shortfallMinor}. ${row.detail?.explanation ?? ""}`).join(" ") || "No history yet.");
        }}>History</button>
        <button className="btn-secondary" type="button" onClick={async () => {
          await api(scoped(session.householdId, `/fills/${fill.id}`), { method: "DELETE" });
          session.bump();
        }}>Delete</button>
      </div>
      {history ? <p>{history}</p> : null}
    </article>
  );
}

interface FillRow {
  id: string;
  name: string;
  cadence: string;
  nextDate: string | null;
  statusLabel: string;
  shortfallPolicy: string;
  lastOutcome: { statusLabel: string; allocatedMinor: number; date?: string } | null;
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
