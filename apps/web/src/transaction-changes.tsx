import { api } from "./api.js";
import { scoped, useSession } from "./session.js";
import type { Txn } from "./types.js";
import { Money, useLoad } from "./ui.js";

export function useTransactionChange(opened: Txn | null) {
  const session = useSession();
  const current = useLoad(() => opened
    ? api<{ transactions: Txn[] }>(scoped(session.householdId, `/transactions?ids=${encodeURIComponent(opened.id)}&limit=1`, session.spaceId))
    : Promise.resolve({ transactions: [] as Txn[] }), [session.householdId, session.spaceId, opened?.id, opened?.version]);
  const latest = current.data?.transactions[0];
  const unavailable = !!opened && !!current.data && (!latest || latest.accountId.startsWith("redacted:") || latest.counterAccountId?.startsWith("redacted:"));
  const changed = !!opened && !!latest && latest.version !== opened.version;
  return { latest, changed, unavailable, error: current.error, blocked: changed || unavailable };
}

export function TransactionChangeNotice({ change, onReload }: { change: ReturnType<typeof useTransactionChange>; onReload: (txn: Txn) => void }) {
  if (change.unavailable) return <div className="banner live-conflict" role="status">This transaction was removed or is no longer available to you. This draft cannot be saved.</div>;
  if (change.changed && change.latest) return <div className="banner live-conflict" role="status">
    <p>This transaction changed while you were editing. Your draft has been kept. Load the latest version before saving.</p>
    <details><summary>Latest saved version</summary>
    <p>Latest saved: {change.latest.payee}, <Money minor={change.latest.amountMinor} />. {change.latest.reviewStatus === "reviewed" ? "Reviewed." : "Needs review."}</p>
    {change.latest.notes ? <p>Saved note: {change.latest.notes}</p> : null}
    </details>
    <button type="button" className="btn-secondary" onClick={() => onReload(change.latest!)}>Discard draft and load latest</button>
  </div>;
  return change.error ? <p role="status">Could not check for a newer version. Your draft stays here; saving still checks for conflicts.</p> : null;
}
