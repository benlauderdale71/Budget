import { useId, useState } from "react";
import { api } from "../api.js";
import { formatMoney, minorToInput, monthLabel, parseAmount, percentBpsFromInput, todayISO } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import type { Bucket, Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Modal, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

type View = "zero" | "envelope" | "flex" | "income";

export function Plan() {
  const session = useSession();
  const access = useAccess();
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
    <Page title={monthLabel(dash.budget.periodKey)} lede={`Ready to Assign is ${session.user?.privacyMode ? "hidden" : "the cash that still needs a job"}. The ${label} names are a view of the same balances.`} actions={<button className="btn-secondary" type="button" disabled={!access.canBudget} onClick={() => setMove(true)}>Move money</button>}>
      <div className="chips" role="group" aria-label="Plan view">
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
        <NewBucket spaceId={dash.spaceId} locked={!access.canBudget} />
      </div>
      {view === "income" ? <IncomePlan currency={dash.household.currency} buckets={dash.buckets} /> : null}
      {view === "envelope" ? (
        <div className="grid three">
          {rows.map((row) => (
            <article key={row.bucketId} className="envelope">
              <span className="kicker">{row.group}</span>
              <strong>{row.name}</strong>
              <button className="btn-secondary" type="button" disabled={!access.canBudget} aria-label={`Edit ${row.name}`} onClick={() => setEditing(row.bucketId)}>Edit</button>
              <Money minor={row.availableMinor} />
              <AssignField name={row.name} currency={dash.household.currency} value={row.assignedMinor} privacy={!!session.user?.privacyMode} locked={!access.canBudget} onSave={(text) => assign(row.bucketId, text)} />
            </article>
          ))}
        </div>
      ) : null}
      {view === "flex" ? (
        ["fixed", "non_monthly", "flexible"].map((role) => (
          <section key={role} style={{ marginTop: 16 }}>
            <h2>{role === "non_monthly" ? "Non-monthly" : role[0].toUpperCase() + role.slice(1)}</h2>
            <BucketTable rows={rows.filter((row) => dash.buckets.find((bucket) => bucket.id === row.bucketId)?.flexRole === role)} buckets={dash.buckets} currency={dash.household.currency} privacy={!!session.user?.privacyMode} locked={!access.canBudget} onAssign={assign} onEdit={setEditing} />
          </section>
        ))
      ) : null}
      {view === "zero" ? <BucketTable rows={rows} buckets={dash.buckets} currency={dash.household.currency} privacy={!!session.user?.privacyMode} locked={!access.canBudget} onAssign={assign} onEdit={setEditing} /> : null}
      <ArchivedCategories buckets={dash.buckets} />
      <Fills dash={dash} />
      {editing && dash.buckets.some((bucket) => bucket.id === editing) ? <EditCategory bucket={dash.buckets.find((bucket) => bucket.id === editing) as Bucket} currency={dash.household.currency} periodKey={dash.budget.periodKey} funding={dash.funding} onClose={() => setEditing(null)} /> : null}
      {move ? <MoveMoney buckets={dash.buckets} periodKey={dash.budget.periodKey} spaceId={dash.spaceId} currency={dash.household.currency} onClose={() => setMove(false)} /> : null}
    </Page>
  );
}

function AssignField({ name, value, currency, privacy, locked, onSave }: { name: string; value: number; currency: string; privacy: boolean; locked: boolean; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(minorToInput(value, currency));
  const [error, setError] = useState("");
  const errorId = useId();
  return (
    <label className="field">
      <span>Assigned</span>
      <input aria-label={`Assigned to ${name}`} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} value={privacy ? "Hidden" : text} disabled={privacy || locked} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }} onBlur={async () => {
        if (privacy || locked || text === minorToInput(value, currency)) return;
        try { setError(""); await onSave(text); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not assign."); }
      }} />
      {error ? <span id={errorId} role="alert">{error}</span> : null}
    </label>
  );
}

function BucketTable({ rows, buckets, currency, privacy, locked, onAssign, onEdit }: { rows: Dashboard["budget"]["buckets"]; buckets: Bucket[]; currency: string; privacy: boolean; locked: boolean; onAssign: (id: string, text: string) => Promise<void>; onEdit: (id: string) => void }) {
  if (!rows.length) return <p className="muted">Nothing in this group.</p>;
  return (
    <div className="card table-wrap">
      <table>
        <caption>Categories this month</caption>
        <thead><tr><th>Name</th><th className="num">Assigned</th><th className="num">Activity</th><th className="num">Available</th></tr></thead>
        <tbody>
          {rows.map((row) => {
            const bucket = buckets.find((item) => item.id === row.bucketId);
            const rule = bucket?.displayRollover ?? bucket?.rollover;
            return (
              <tr key={row.bucketId}>
                <td>{row.name}{row.creditOverspendMinor ? " · card overspend" : ""}{rule && rule !== "both" ? ` · rollover ${rule}` : ""} <button className="btn-secondary" type="button" disabled={locked} aria-label={`Edit ${row.name}`} onClick={() => onEdit(row.bucketId)}>Edit</button></td>
                <td className="num"><AssignField name={row.name} currency={currency} value={row.assignedMinor} privacy={privacy} locked={locked} onSave={(text) => onAssign(row.bucketId, text)} /></td>
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

function NewBucket({ spaceId, locked }: { spaceId: string; locked: boolean }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const form = useFormError();
  if (!open) return <button className="btn" type="button" disabled={locked} onClick={() => setOpen(true)}>New category</button>;
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
          }}>Restore {bucket.name}</button>
        </div>
      ))}
    </section>
  );
}

const FILL_CADENCES: [string, string][] = [
  ["once", "Once"],
  ["weekly", "Weekly"],
  ["biweekly", "Every two weeks"],
  ["twice_monthly", "Twice a month"],
  ["monthly", "Monthly"],
  ["every_2_months", "Every two months"],
  ["every_3_months", "Every three months"],
  ["every_6_months", "Every six months"],
  ["annual", "Annual"],
  ["custom", "Custom"],
];

function Fills({ dash }: { dash: Dashboard }) {
  const session = useSession();
  const access = useAccess();
  const [editing, setEditing] = useState<FillRow | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const choices = dash.buckets.filter((bucket) => !bucket.systemRole && !bucket.archived && bucket.kind === "expense");
  const state = useLoad(() => api<{ note: string; fills: FillRow[] }>(scoped(session.householdId, "/fills")), [session.householdId, session.tick]);
  return (
    <section id="fills" style={{ marginTop: 24 }}>
      <h2>Envelope fills</h2>
      <p className="muted">A fill gives a job to cash that is already in Ready to Assign. It is not a bank transfer. Saved and Scheduled are not applied fills.</p>
      {state.data?.note ? <p className="muted">{state.data.note}</p> : null}
      <FillEditor key={editing?.id ?? `new-${draftKey}`} dash={dash} choices={choices} existing={editing} locked={!access.canBudget} onDone={() => { setEditing(null); setDraftKey((value) => value + 1); }} />
      {(state.data?.fills ?? []).map((fill) => <FillCard key={fill.id} fill={fill} onEdit={() => setEditing(fill)} />)}
    </section>
  );
}

function FillEditor({ dash, choices, existing, locked, onDone }: { dash: Dashboard; choices: Bucket[]; existing: FillRow | null; locked: boolean; onDone: () => void }) {
  const session = useSession();
  const form = useFormError();
  const [preview, setPreview] = useState("");
  const [name, setName] = useState(existing?.name ?? "Payday fill");
  const [cadence, setCadence] = useState(existing?.cadence ?? "monthly");
  const [customDays, setCustomDays] = useState(existing?.customDays ? String(existing.customDays) : "");
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayISO());
  const [endDate, setEndDate] = useState(existing?.endDate ?? "");
  const [policy, setPolicy] = useState(existing?.shortfallPolicy ?? "partial");
  const [sweep, setSweep] = useState(existing?.sweepBucketId ?? "");
  const [paused, setPaused] = useState(!!existing?.paused);
  const [lines, setLines] = useState<LineDraft[]>(() => existing?.lines.length ? existing.lines.map((line) => ({
    bucketId: line.bucketId,
    mode: line.mode,
    amount: line.amountMinor == null ? "" : minorToInput(line.amountMinor, dash.household.currency),
    percent: line.percentBps == null ? "" : (line.percentBps / 100).toFixed(2),
    priority: String(line.priority),
    sourceBucketId: line.sourceBucketId ?? "",
  })) : [{ bucketId: choices[0]?.id ?? "", mode: "add", amount: "0.00", percent: "", priority: "1", sourceBucketId: "" }]);
  function moneyText(minor: number) {
    return formatMoney(minor, dash.household.currency, !!session.user?.privacyMode);
  }
  function payload() {
    return {
      version: existing?.version,
      spaceId: dash.spaceId,
      name,
      cadence,
      customDays: cadence === "custom" ? Number(customDays) : null,
      startDate,
      endDate: endDate || null,
      paused,
      shortfallPolicy: policy,
      sweepBucketId: sweep || null,
      lines: lines.filter((line) => line.bucketId).map((line, index) => ({
        bucketId: line.bucketId,
        mode: line.mode,
        amountMinor: line.mode === "shortfall" || line.mode === "percent" ? null : parseAmount(line.amount || "0", dash.household.currency),
        percentBps: line.mode === "percent" ? percentBpsFromInput(line.percent || "0") : null,
        priority: Number(line.priority || index + 1),
        sourceBucketId: line.sourceBucketId || null,
      })),
    };
  }
  function moveLine(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= lines.length) return;
    const next = [...lines];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setLines(next.map((line, lineIndex) => ({ ...line, priority: String(lineIndex + 1) })));
  }
  return (
    <form id={existing ? "fill-edit" : "fill-create"} className="card" onSubmit={(event) => form.run(event, async () => {
      const body = payload();
      if (existing) await api(scoped(session.householdId, `/fills/${existing.id}`), { method: "PATCH", body: JSON.stringify(body) });
      else await api(scoped(session.householdId, "/fills"), { method: "POST", body: JSON.stringify(body) });
      setPreview(existing ? "Saved the edit. Past results were kept, and no money moved." : "Saved. It is scheduled and has not moved any money.");
      session.bump();
      onDone();
    })}>
      <h3>{existing ? `Edit ${existing.name}` : "New fill"}</h3>
      <p className="muted">Saving does not move money and does not rerun a date that already has a result. If this fill has never run, the next date becomes the start date. If it has run, the next date stays unless it is earlier than the new start date. A cadence change takes effect after that next date.</p>
      <Field label="Name"><input name="name" required value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Schedule"><select name="cadence" value={cadence} onChange={(event) => setCadence(event.target.value)}>{FILL_CADENCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      {cadence === "custom" ? <Field label="Custom days"><input name="customDays" inputMode="numeric" required value={customDays} onChange={(event) => setCustomDays(event.target.value)} /></Field> : null}
      <Field label="Start"><input name="startDate" type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Field>
      <Field label="End"><input name="endDate" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field>
      <Field label="If there is not enough cash"><select name="policy" value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="partial">Fund in priority order, then stop</option><option value="skip">Skip the whole occurrence</option></select></Field>
      <Field label="Sweep leftover Ready to Assign into"><select name="sweep" value={sweep} onChange={(event) => setSweep(event.target.value)}><option value="">Do not sweep</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
      <label className="field"><span><input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} /> Paused</span></label>
      {lines.map((line, index) => (
        <fieldset key={index}>
          <legend>Envelope {index + 1}</legend>
          <Field label="Envelope"><select aria-label={`Envelope ${index + 1}`} value={line.bucketId} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, bucketId: event.target.value } : item))}><option value="">Choose</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
          <Field label="What to add"><select aria-label={`Mode ${index + 1}`} value={line.mode} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, mode: event.target.value } : item))}><option value="add">Add a fixed amount</option><option value="top_up">Top up the available balance</option><option value="shortfall">Fund the target shortfall</option><option value="percent">Percent of eligible posted income</option></select></Field>
          {line.mode === "percent" ? <Field label="Percent"><input aria-label={`Percent ${index + 1}`} inputMode="decimal" value={line.percent} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, percent: event.target.value } : item))} /></Field> : line.mode === "shortfall" ? null : <Field label="Amount or desired balance"><input aria-label={`Amount ${index + 1}`} inputMode="decimal" value={line.amount} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} /></Field>}
          <Field label="Priority"><input aria-label={`Priority ${index + 1}`} inputMode="numeric" value={line.priority} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, priority: event.target.value } : item))} /></Field>
          <Field label="Take the money from"><select aria-label={`Source ${index + 1}`} value={line.sourceBucketId} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, sourceBucketId: event.target.value } : item))}><option value="">Ready to Assign</option>{choices.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
          <div className="row">
            <button className="btn-quiet" type="button" aria-label={`Move envelope ${index + 1} up`} onClick={() => moveLine(index, -1)}>Move up</button>
            <button className="btn-quiet" type="button" aria-label={`Move envelope ${index + 1} down`} onClick={() => moveLine(index, 1)}>Move down</button>
            <button className="btn-quiet" type="button" aria-label={`Remove envelope ${index + 1}`} onClick={() => setLines(lines.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, priority: String(itemIndex + 1) })))}>Remove envelope</button>
          </div>
        </fieldset>
      ))}
      <button className="btn-secondary" type="button" disabled={locked} onClick={() => setLines([...lines, { bucketId: "", mode: "add", amount: "", percent: "", priority: String(lines.length + 1), sourceBucketId: "" }])}>Add envelope</button>
      {preview ? <Notice>{preview}</Notice> : null}
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      <div className="row">
        <button className="btn-secondary" type="button" disabled={locked} onClick={async () => {
          try {
            const result = await api<{ note: string; policyText: string; statusLabel: string; plan: { totalAllocatedMinor: number; readyBeforeMinor: number; readyAfterMinor: number; shortfallMinor: number; explanation: string } | null }>(scoped(session.householdId, "/fills/preview"), { method: "POST", body: JSON.stringify(payload()) });
            const plan = result.plan;
            setPreview(plan ? `${result.note} ${result.policyText} This is a preview, not an applied fill. Ready to Assign ${moneyText(plan.readyBeforeMinor)} becomes ${moneyText(plan.readyAfterMinor)}. Allocated ${moneyText(plan.totalAllocatedMinor)}. Short ${moneyText(plan.shortfallMinor)}. ${plan.explanation}` : result.note);
          } catch (caught) {
            form.setError(caught instanceof Error ? caught.message : "Could not preview.");
          }
        }}>Preview</button>
        <button className="btn" type="submit" disabled={locked}>{existing ? "Save edit" : "Save fill"}</button>
        {existing ? <button className="btn-quiet" type="button" onClick={onDone}>Cancel edit</button> : null}
      </div>
    </form>
  );
}

function FillCard({ fill, onEdit }: { fill: FillRow; onEdit: () => void }) {
  const session = useSession();
  const access = useAccess();
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  async function act(path: string, label: string) {
    try {
      const result = await api<{ statusLabel?: string; note?: string; explanation?: string }>(scoped(session.householdId, path), { method: "POST" });
      setMessage(`${label}: ${result.statusLabel ?? ""} ${result.explanation ?? result.note ?? ""}`.trim());
      session.bump();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not update the fill.");
    }
  }
  return (
    <article className="card" style={{ marginTop: 12 }}>
      <strong>{fill.name}</strong>
      <p>{fill.statusLabel} · {fill.cadence} · next {fill.nextDate ?? "none"} · {fill.shortfallPolicy === "skip" ? "Skip when cash is short" : "Fund in priority order when cash is short"}</p>
      {fill.lastOutcome ? <p>Last result: {fill.lastOutcome.statusLabel}{fill.lastOutcome.date ? ` on ${fill.lastOutcome.date}` : ""} · <Money minor={fill.lastOutcome.allocatedMinor} /></p> : <p>No occurrence has run.</p>}
      <div className="row">
        <button className="btn" type="button" disabled={!access.canBudget} aria-label={`Run ${fill.name} now`} onClick={() => act(`/fills/${fill.id}/run`, "Run now")}>Run now</button>
        <button className="btn-secondary" type="button" disabled={!access.canBudget} aria-label={`Skip the next date for ${fill.name}`} onClick={() => act(`/fills/${fill.id}/skip`, "Skip")}>Skip next date</button>
        {fill.statusLabel === "Paused"
          ? <button className="btn-secondary" type="button" disabled={!access.canBudget} aria-label={`Resume ${fill.name}`} onClick={() => act(`/fills/${fill.id}/resume`, "Resume")}>Resume</button>
          : <button className="btn-secondary" type="button" disabled={!access.canBudget} aria-label={`Pause ${fill.name}`} onClick={() => act(`/fills/${fill.id}/pause`, "Pause")}>Pause</button>}
        <button className="btn-secondary" type="button" disabled={!access.canBudget} aria-label={`Edit ${fill.name}`} onClick={onEdit}>Edit</button>
        <button className="btn-secondary" type="button" aria-label={`History for ${fill.name}`} onClick={async () => {
          const rows = await api<{ history: HistoryRow[] }>(scoped(session.householdId, `/fills/${fill.id}/history`));
          setHistory(rows.history);
        }}>History</button>
        <button className="btn-secondary" type="button" disabled={!access.canBudget} aria-label={`Delete ${fill.name}`} onClick={async () => {
          if (!window.confirm(`Delete ${fill.name}? The schedule is removed. Money already assigned stays where it is.`)) return;
          await api(scoped(session.householdId, `/fills/${fill.id}`), { method: "DELETE" });
          session.bump();
        }}>Delete</button>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {history ? (
        history.length === 0 ? <p>No history yet.</p> : (
          <ul>
            {history.map((row) => (
              <li key={row.id}>{row.date} {row.statusLabel}. Allocated <Money minor={row.allocatedMinor} />. Short <Money minor={row.shortfallMinor} />. {row.detail?.explanation ?? row.error ?? ""}</li>
            ))}
          </ul>
        )
      ) : null}
    </article>
  );
}

interface HistoryRow {
  id: string;
  date: string;
  statusLabel: string;
  allocatedMinor: number;
  shortfallMinor: number;
  error?: string | null;
  detail?: { explanation?: string };
}

interface FillLine {
  bucketId: string;
  mode: string;
  amountMinor?: number | null;
  percentBps?: number | null;
  priority: number;
  sourceBucketId?: string | null;
}

interface FillRow {
  id: string;
  name: string;
  version: number;
  cadence: string;
  customDays?: number | null;
  startDate: string;
  endDate?: string | null;
  paused?: boolean;
  nextDate: string | null;
  statusLabel: string;
  shortfallPolicy: string;
  sweepBucketId?: string | null;
  lines: FillLine[];
  lastOutcome: { statusLabel: string; allocatedMinor: number; date?: string } | null;
}

interface LineDraft {
  bucketId: string;
  mode: string;
  amount: string;
  percent: string;
  priority: string;
  sourceBucketId: string;
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
