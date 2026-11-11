import { useSearchParams, Link } from "react-router-dom";
import { api } from "./api.js";
import { scoped, useSession } from "./session.js";
import { ErrorNote, Loading, Money, useLoad } from "./ui.js";

export interface HouseholdPerson { id: string; displayName: string; role: string }

export function useHouseholdPeople() {
  const session = useSession();
  return useLoad(() => api<{ people: HouseholdPerson[] }>(scoped(session.householdId, "/collaboration/people")), [session.householdId, session.tick]);
}

export function OwnershipFilter({ people }: { people: HouseholdPerson[] }) {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const ownership = params.get("ownership") ?? "all";
  const personId = params.get("personId") ?? "";
  const others = people.filter((person) => person.id !== session.user?.id);
  return <>
    <label className="field">Ownership view
      <select aria-label="Ownership view" value={ownership} onChange={(event) => {
        const next = new URLSearchParams(params);
        next.set("ownership", event.target.value);
        if (event.target.value === "yours") next.set("personId", others[0]?.id ?? ""); else next.delete("personId");
        setParams(next);
      }}>
        <option value="all">All visible records</option><option value="mine">Mine</option><option value="ours">Ours</option>
        <option value="yours" disabled={others.length === 0}>Yours — another member</option>
      </select>
    </label>
    {ownership === "yours" ? <label className="field">Whose records?
      <select aria-label="Whose records?" value={personId} onChange={(event) => { const next = new URLSearchParams(params); next.set("personId", event.target.value); setParams(next); }}>
        <option value="" disabled>Choose a member</option>
        {others.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
      </select>
    </label> : null}
  </>;
}

export function OwnershipDashboard() {
  const session = useSession();
  const [params] = useSearchParams();
  const people = useHouseholdPeople();
  const ownership = params.get("ownership") ?? "all";
  const personId = params.get("personId") ?? "";
  const query = new URLSearchParams({ ownership, ...(personId ? { personId } : {}) }).toString();
  const summary = useLoad(() => api<{ from: string; to: string; incomeMinor: number; spendingMinor: number; reviewCount: number; note: string }>(scoped(session.householdId, `/ownership-summary?${query}`, session.spaceId)), [session.householdId, session.spaceId, session.tick, query]);
  return <section className="card ownership-summary" aria-labelledby="ownership-heading">
    <h2 id="ownership-heading">Household ownership activity</h2>
    <div className="row"><OwnershipFilter people={people.data?.people ?? []} /></div>
    <p className="muted">Mine and Yours use the transaction's ownership label. Ours means shared ownership. Labels keep existing account permissions.</p>
    {people.error ? <ErrorNote message={people.error} onRetry={session.bump} /> : null}
    {summary.loading ? <Loading label="Loading ownership activity" /> : summary.error || !summary.data ? <ErrorNote message={summary.error ?? "Could not load ownership activity"} onRetry={session.bump} /> : <>
      <p>{summary.data.from} through {summary.data.to}</p>
      <dl className="row"><div><dt>Posted income</dt><dd><Money minor={summary.data.incomeMinor} /></dd></div><div><dt>Spending after refunds</dt><dd><Money minor={summary.data.spendingMinor} /></dd></div><div><dt>Needs review</dt><dd>{summary.data.reviewCount}</dd></div></dl>
      <p className="muted">{summary.data.note} The cards below show the full visible plan.</p>
      <Link to={`/activity?${query}`}>Open this activity view</Link>
    </>}
  </section>;
}
