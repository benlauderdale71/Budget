import { useState } from "react";
import { api } from "../api.js";
import { todayISO } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { Field, Modal, Money, Notice } from "../ui.js";

type Preview = {
  impacts:{currency:string;from:string|null;to:string;totalMinor:number;count:number}[];
  imported: number;
  unreviewed: number;
  eligible: number;
  remaining: number;
  proposed: number;
  applied: number;
  token: string;
  groups: { bucketId: string; basis: string; count: number }[];
};

export function ImportCategorization({ buckets, onClose }: { buckets: Dashboard["buckets"]; onClose: () => void }) {
  const session = useSession();
  const [year, setYear] = useState(todayISO().slice(0, 4));
  const eligible = buckets.filter(bucket => !bucket.archived && !bucket.hidden && !bucket.systemRole);
  const defaultFallback = (kind: "income" | "expense", names: RegExp) =>
    eligible.find(bucket => bucket.kind === kind && names.test(bucket.name))?.id ?? "";
  const [expenseFallback, setExpenseFallback] = useState(() => defaultFallback("expense", /^(misc(?:ellaneous)?(?: expenses)?|other expenses?|general expenses?)$/i));
  const [incomeFallback, setIncomeFallback] = useState(() => defaultFallback("income", /^(other income|miscellaneous income)$/i));
  const [preview, setPreview] = useState<Preview>();
  const [saved, setSaved] = useState<Preview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(confirm?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Preview>(scoped(session.householdId, "/transactions/categorization", session.spaceId), {
        method: "POST",
        body: JSON.stringify({ year: Number(year), expenseFallback: expenseFallback || undefined, incomeFallback: incomeFallback || undefined, confirm }),
      });
      if (confirm) {
        setPreview(undefined);
        setSaved(result);
        session.bump();
      } else {
        setSaved(undefined);
        setPreview(result);
      }
    } catch (err) {
      setPreview(undefined);
      setError(err instanceof Error ? err.message : "Could not reassess imports.");
    } finally {
      setBusy(false);
    }
  }

  function change(setValue: (value: string) => void, value: string) {
    setValue(value);
    setPreview(undefined);
    setSaved(undefined);
  }

  return <Modal title="Categorize imported transactions" onClose={onClose}>
    <p>Recheck missing categories and earlier estimates against verified merchant history, bank labels, and merchant names. Saved estimates stay marked for review.</p>
    <form onSubmit={event => { event.preventDefault(); void run(); }}>
      <Field label="Year"><input type="number" min="1900" max="9998" step="1" required value={year} disabled={busy} onChange={event => change(setYear, event.target.value)} /></Field>
      {([
        ["expense", expenseFallback, setExpenseFallback],
        ["income", incomeFallback, setIncomeFallback],
      ] as const).map(([kind, value, setValue]) => <Field label={kind === "expense" ? "Fallback for unclear expenses" : "Fallback for unclear income"} key={kind}>
        <select value={value} disabled={busy} onChange={event => change(setValue, event.target.value)}>
          <option value="">Leave uncategorized</option>
          {eligible.filter(bucket => bucket.kind === kind).map(bucket => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}
        </select>
      </Field>)}
      <button className="btn" type="submit" disabled={busy}>Preview estimates</button>
    </form>
    {error ? <Notice kind="bad">{error}</Notice> : null}
    {preview ? <>
      <p>{preview.imported} imported records · {preview.unreviewed} need review · {preview.eligible} eligible for a category estimate.</p>
      <p>{preview.proposed} estimates ready. {preview.remaining} eligible records have no suggested category.</p>
      {preview.groups.length ? <ul>{preview.groups.map(group => <li key={JSON.stringify([group.bucketId, group.basis])}>
        {buckets.find(bucket => bucket.id === group.bucketId)?.name} · {group.count} · {group.basis}
      </li>)}</ul> : null}
      {preview.impacts.map(i=><p key={JSON.stringify([i.currency,i.from,i.to])}>{buckets.find(b=>b.id===i.from)?.name??"Uncategorized"} → {buckets.find(b=>b.id===i.to)?.name}: <Money currency={i.currency} minor={i.totalMinor}/> across {i.count} records.</p>)}
      {preview.proposed ? <button className="btn" type="button" disabled={busy} onClick={() => void run(preview.token)}>Apply {preview.proposed} estimates</button> : null}
    </> : null}
    {saved ? <Notice kind="ok">Applied {saved.applied} category estimates. {saved.remaining} eligible records remain uncategorized.</Notice> : null}
  </Modal>;
}
