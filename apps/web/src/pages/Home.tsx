import { Link } from "react-router-dom";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  DASHBOARD_CARDS,
  DASHBOARD_UNDO_LIMIT,
  dashboardCardLabel,
  dashboardDisplayRows,
  defaultDashboardCards,
  deviceClassForViewport,
  moveDashboardCard,
  readDashboardLayout,
  withDashboardSize,
  withDashboardVisibility,
  type DashboardCardPreference,
  type DashboardDeviceClass,
} from "@budgetcents/domain/dashboard-layout";
import { ApiError, api } from "../api.js";
import { DASHBOARD_UNDO_STORAGE, readUndoStacks, withUndoStack, writeUndoStacks, type UndoStacks } from "../dashboard-undo.js";
import { monthLabel } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import { OwnershipDashboard } from "../ownership.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Loading, Modal, Money, useLoad } from "../ui.js";

function useDeviceClass(): DashboardDeviceClass {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return deviceClassForViewport("web", width);
}

function copyCards(cards: readonly DashboardCardPreference[]): DashboardCardPreference[] {
  return cards.map((card) => ({ id: card.id, hidden: card.hidden, size: card.size }));
}

export function Home() {
  const session = useSession();
  const access = useAccess();
  const deviceClass = useDeviceClass();
  const columns = deviceClass === "web-compact" ? 1 : 4;
  const layout = readDashboardLayout(session.user?.dashboardLayout);
  const saved = layout.layouts[deviceClass];
  const [draft, setDraft] = useState<{ deviceClass: DashboardDeviceClass; cards: DashboardCardPreference[] } | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ cards: DashboardCardPreference[]; message: string; focusId: string | null; mode: "change" | "undo" } | null>(null);
  const userId = session.user?.id ?? "";
  const historyRef = useRef<UndoStacks>(new Map());
  const historyReady = useRef(false);
  if (!historyReady.current) {
    historyReady.current = true;
    try {
      historyRef.current = readUndoStacks(sessionStorage.getItem(DASHBOARD_UNDO_STORAGE), userId);
    } catch {
      historyRef.current = new Map();
    }
  }
  const seenUser = useRef(userId);
  const [, setHistoryVersion] = useState(0);
  const savingRef = useRef(false);
  const historyKey = `${userId}:${deviceClass}`;
  const past = historyRef.current.get(historyKey) ?? [];
  const shown = draft?.deviceClass === deviceClass ? draft.cards : saved;
  const state = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  useEffect(() => { if (state.data) session.adoptSpace(state.data.spaceId); }, [state.data?.spaceId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(DASHBOARD_UNDO_STORAGE, writeUndoStacks(historyRef.current));
    } catch {
      /* the in-memory stack still covers this page */
    }
  }, [userId]);
  useEffect(() => {
    if (seenUser.current === userId) return;
    seenUser.current = userId;
    historyRef.current = new Map();
    try {
      sessionStorage.removeItem(DASHBOARD_UNDO_STORAGE);
    } catch {
      /* a new signed-in user still starts without the previous undo stack */
    }
    setHistoryVersion((value) => value + 1);
    setRetry(null);
    setDraft(null);
  }, [userId]);

  function commitHistory(next: UndoStacks) {
    historyRef.current = next;
    try {
      sessionStorage.setItem(DASHBOARD_UNDO_STORAGE, writeUndoStacks(next));
    } catch {
      /* keep the in-memory stack if this browser refuses storage */
    }
    setHistoryVersion((value) => value + 1);
  }
  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  async function persist(next: DashboardCardPreference[], message: string, mode: "change" | "undo", nextFocus: string | null) {
    if (savingRef.current) return;
    savingRef.current = true;
    const owner = userId;
    const key = historyKey;
    const previous = copyCards(shown);
    const revision = layout.revision;
    const klass = deviceClass;
    setSaving(true);
    setFailed(false);
    setRetry(null);
    setDraft({ deviceClass: klass, cards: next });
    setStatus("Saving the dashboard layout.");
    try {
      const applied = await session.patchMe({ dashboardLayout: { deviceClass: klass, revision, cards: next } });
      if (!applied || (session.user?.id ?? "") !== owner) {
        setDraft(null);
        return;
      }
      const stack = historyRef.current.get(key) ?? [];
      commitHistory(withUndoStack(historyRef.current, key, mode === "undo" ? stack.slice(0, -1) : [...stack, previous].slice(-DASHBOARD_UNDO_LIMIT)));
      setDraft(null);
      setStatus(`${message} Dashboard layout saved.`);
      setFocusId(nextFocus);
    } catch (error) {
      setDraft(null);
      const statusCode = error instanceof ApiError ? error.status : 0;
      if (statusCode === 409) {
        commitHistory(withUndoStack(historyRef.current, key, []));
        setFailed(true);
        setStatus("This layout changed somewhere else. The change was not saved.");
        session.refresh().catch(() => undefined);
      } else {
        setRetry({ cards: next, message, focusId: nextFocus, mode });
        setFailed(true);
        setStatus(error instanceof ApiError ? error.message : "Could not save the dashboard layout. This change was not saved.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function undo(source: "page" | "dialog") {
    const stack = historyRef.current.get(historyKey) ?? [];
    const snapshot = stack[stack.length - 1];
    if (!snapshot || saving) return;
    const more = stack.length > 1;
    const nextFocus = source === "page"
      ? (more ? "dashboard-undo-page" : "dashboard-customize")
      : (more ? "dashboard-undo-dialog" : "dashboard-reset");
    void persist(copyCards(snapshot), "Previous dashboard layout restored.", "undo", nextFocus);
  }

  if (state.loading && !state.data) return <Loading label="Loading the household" />;
  if (state.error || !state.data) return <ErrorNote message={state.error ?? "No dashboard"} onRetry={session.bump} />;
  const dash = state.data;
  const rows = dashboardDisplayRows(shown, columns);
  return (
    <section data-device-class={deviceClass}>
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
          <button id="dashboard-customize" type="button" className="btn-secondary" onClick={() => setCustomizing(true)}>Customize dashboard</button>
          <button id="dashboard-undo-page" type="button" className="btn-secondary" aria-disabled={past.length === 0 || saving} onClick={() => undo("page")}>Undo</button>
          {access.canWrite ? <Link className="btn" to="/activity">Add transaction</Link> : <Link className="btn-secondary" to="/activity">View activity</Link>}
        </div>
      </header>
      <OwnershipDashboard key={`${session.householdId}:${session.spaceId ?? ""}`} />
      {customizing ? null : <LayoutStatus status={status} failed={failed} retry={retry} onRetry={() => { if (retry) void persist(retry.cards, retry.message, retry.mode, retry.focusId); }} />}
      {dash.budget.identityDifferenceMinor !== 0 ? <div className="banner bad" role="alert">The plan does not match on-budget cash by <Money minor={dash.budget.identityDifferenceMinor} />. Review recent edits before relying on Ready to Assign.</div> : null}
      {dash.budget.warnings.filter((warning) => !warning.includes("identity")).map((warning) => <div key={warning} className="banner bad">{warning}</div>)}
      {Number(session.households.find((item) => item.id === session.householdId)?.is_demo) === 1 ? null : session.user?.onboardingStep !== "done" ? <article className="card">
        <h2>Setup</h2>
        <p className="muted">Continue the saved setup. A bank connection is not required, and bank linking is not available.</p>
        <p><Link to="/setup">Continue setup</Link></p>
      </article> : <article className="card">
        <h2>Setup</h2>
        <p><Link to="/setup">Review optional setup</Link></p>
      </article>}
      {session.user && !session.user.emailVerified && Number(session.households.find((item) => item.id === session.householdId)?.is_demo) !== 1 ? <div className="banner" role="status">Email is not verified. Invitations stay closed until the verification link is used.</div> : null}
      <div className="dashboard-flow">
        {rows.map((row) => {
          const single = columns === 1 || (row.length === 1 && row[0].size === "wide");
          return (
            <div key={row.map((card) => card.id).join("-")} className={single ? "dashboard-row single" : "dashboard-row"}>
              {row.map((card) => <DashboardCard key={card.id} card={card} dash={dash} session={session} />)}
            </div>
          );
        })}
      </div>
      {dash.budget.cardGaps.some((gap) => gap.gapMinor > 0) ? (
        <div className="banner" style={{ marginTop: 16 }}>A card balance is larger than the payment reserve. That gap is debt, not missing cash in another category.</div>
      ) : null}
      {customizing ? (
        <Modal title="Customize dashboard" onClose={() => setCustomizing(false)}>
          <LayoutStatus status={status} failed={failed} retry={retry} onRetry={() => { if (retry) void persist(retry.cards, retry.message, retry.mode, retry.focusId); }} />
          <p className="muted">This layout is saved for your account on this window size. It does not change any balance. Undo reverses these layout changes only.</p>
          <p id="dashboard-size-help" className="muted">Standard sits with the other cards. Wide uses a full row when the window is wider than 860 pixels. A narrower window still shows the whole card, and the choice is kept.</p>
          <div className="row">
            <button id="dashboard-undo-dialog" type="button" className="btn-secondary" aria-disabled={past.length === 0 || saving} onClick={() => undo("dialog")}>Undo</button>
            <button id="dashboard-reset" type="button" className="btn-quiet" aria-disabled={saving} onClick={() => void persist(defaultDashboardCards(), "Dashboard layout reset.", "change", "dashboard-undo-dialog")}>Reset layout</button>
          </div>
          <LayoutEditor
            cards={shown}
            saving={saving}
            onCommit={(next, message, nextFocus) => void persist(next, message, "change", nextFocus)}
          />
        </Modal>
      ) : null}
    </section>
  );
}

function LayoutStatus({ status, failed, retry, onRetry }: { status: string; failed: boolean; retry: { cards: DashboardCardPreference[] } | null; onRetry: () => void }) {
  if (!status) return null;
  return (
    <div id="dashboard-layout-status" className={`banner ${failed ? "bad" : "ok"}`} role="status">
      <p>{status}</p>
      {retry ? <button id="dashboard-retry" type="button" className="btn-secondary" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

function LayoutEditor({ cards, saving, onCommit }: { cards: DashboardCardPreference[]; saving: boolean; onCommit: (next: DashboardCardPreference[], message: string, focusId: string | null) => void }) {
  const [order, setOrder] = useState(cards);
  const orderRef = useRef(cards);
  const dragging = useRef<{ id: string; moved: boolean } | null>(null);
  const key = cards.map((card) => `${card.id}:${card.hidden}:${card.size}`).join("|");
  useEffect(() => {
    if (dragging.current) return;
    orderRef.current = cards;
    setOrder(cards);
  }, [cards, key]);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (saving || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { id, moved: false };
  }
  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragging.current;
    if (!drag) return;
    const rows = document.querySelectorAll<HTMLElement>("[data-layout-id]");
    let target: string | null = null;
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (event.clientY >= box.top && event.clientY <= box.bottom) {
        target = row.dataset.layoutId ?? null;
        break;
      }
    }
    if (!target || target === drag.id) return;
    const list = orderRef.current;
    const from = list.findIndex((card) => card.id === drag.id);
    const to = list.findIndex((card) => card.id === target);
    if (from < 0 || to < 0 || from === to) return;
    const next = list.map((card) => ({ ...card }));
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    drag.moved = true;
    orderRef.current = next;
    setOrder(next);
  }
  function onPointerUp() {
    const drag = dragging.current;
    dragging.current = null;
    if (!drag?.moved) return;
    const label = dashboardCardLabel(drag.id);
    const index = orderRef.current.findIndex((card) => card.id === drag.id);
    const focusId = index <= 0 ? `dash-down-${drag.id}` : `dash-up-${drag.id}`;
    onCommit(copyCards(orderRef.current), `${label} moved.`, focusId);
  }
  function onPointerCancel() {
    dragging.current = null;
    orderRef.current = cards;
    setOrder(cards);
  }

  return (
    <fieldset>
      <legend>Dashboard cards</legend>
      <ul className="layout-list">
        {order.map((card, index) => {
          const label = dashboardCardLabel(card.id);
          const sizes = DASHBOARD_CARDS.find((item) => item.id === card.id)?.sizes ?? ["standard"];
          return (
            <li key={card.id} className="layout-item" data-layout-id={card.id}>
              <button type="button" className="btn-quiet drag-handle" aria-label={`Drag ${label}`} onPointerDown={(event) => onPointerDown(event, card.id)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>Drag</button>
              <span className="name">{label}{card.hidden ? " · Hidden" : ""}</span>
              <button id={`dash-up-${card.id}`} type="button" className="btn-quiet" aria-label={`Move ${label} up`} aria-disabled={saving || index === 0} onClick={() => {
                if (saving || index === 0) return;
                const next = moveDashboardCard(order, card.id, -1);
                const at = next.findIndex((item) => item.id === card.id);
                onCommit(next, `${label} moved up.`, at === 0 ? `dash-down-${card.id}` : `dash-up-${card.id}`);
              }}>Up</button>
              <button id={`dash-down-${card.id}`} type="button" className="btn-quiet" aria-label={`Move ${label} down`} aria-disabled={saving || index === order.length - 1} onClick={() => {
                if (saving || index === order.length - 1) return;
                const next = moveDashboardCard(order, card.id, 1);
                const at = next.findIndex((item) => item.id === card.id);
                onCommit(next, `${label} moved down.`, at === next.length - 1 ? `dash-up-${card.id}` : `dash-down-${card.id}`);
              }}>Down</button>
              {card.hidden ? (
                <button id={`dash-restore-${card.id}`} type="button" className="btn-quiet" aria-label={`Restore ${label}`} aria-disabled={saving} onClick={() => {
                  if (saving) return;
                  onCommit(withDashboardVisibility(order, card.id, false), `${label} restored.`, `dash-hide-${card.id}`);
                }}>Restore</button>
              ) : (
                <button id={`dash-hide-${card.id}`} type="button" className="btn-quiet" aria-label={`Hide ${label}`} aria-disabled={saving} onClick={() => {
                  if (saving) return;
                  onCommit(withDashboardVisibility(order, card.id, true), `${label} hidden.`, `dash-restore-${card.id}`);
                }}>Hide</button>
              )}
              {sizes.length > 1 ? (
                <select id={`dash-size-${card.id}`} aria-label={`Change ${label} card size`} aria-describedby="dashboard-size-help" value={card.size} onChange={(event) => {
                  if (saving) return;
                  const size = event.target.value === "wide" ? "wide" : "standard";
                  onCommit(withDashboardSize(order, card.id, size), `${label} is ${size === "wide" ? "Wide" : "Standard"}.`, `dash-size-${card.id}`);
                }}>
                  <option value="standard">Standard</option>
                  <option value="wide">Wide</option>
                </select>
              ) : null}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function DashboardCard({ card, dash, session }: { card: DashboardCardPreference; dash: Dashboard; session: ReturnType<typeof useSession> }) {
  const short = dash.guidance.primaryFigure === "shortage";
  const unread = dash.alerts.filter((alert) => !alert.read_at);
  const committed = dash.budget.claimsMinor - dash.budget.readyToAssignMinor - dash.budget.futureAssignedMinor;
  const nextBill = dash.upcoming.find((item) => item.amountMinor < 0);
  const props = { className: "card dashboard-card", "data-card-id": card.id, "data-card-size": card.size };
  if (card.id === "safe") return <article {...props}><p className="kicker">{short ? "Short before upcoming bills" : "Safe to spend"}</p><p className={`figure ${short ? "shortage" : ""}`}><Money minor={short ? dash.guidance.shortageMinor : dash.guidance.cashSafeMinor} tone={!short} /></p><p className="formula">{dash.guidance.formula}</p>{dash.guidance.projectedUsesExpectedIncome ? <p className="muted">Projected allowance, including expected income that is not cash: <Money minor={dash.guidance.projectedAllowanceMinor} />. Daily cash figure: <Money minor={dash.guidance.dailyCashMinor} />.</p> : null}</article>;
  if (card.id === "ready") return <article {...props}><p className="kicker">Ready to Assign</p><p className="figure"><Money minor={dash.budget.readyToAssignMinor} /></p><p className="formula">{dash.explain.formula}</p></article>;
  if (card.id === "worth") return <article {...props}><p className="kicker">Net worth</p><p className="figure"><Money minor={dash.netWorth.netMinor} /></p><p className="muted">Liquid <Money minor={dash.netWorth.liquidMinor} /></p></article>;
  if (card.id === "age") return <article {...props}><p className="kicker">Age of money</p><p className="figure">{dash.ageOfMoney.days == null ? "—" : `${dash.ageOfMoney.days}d`}</p><p className="formula">{dash.ageOfMoney.formula}</p></article>;
  if (card.id === "committed") return <article {...props}><p className="kicker">Already given a job</p><p className="figure"><Money minor={committed} /></p><p className="muted">Cash sitting in categories, envelopes, and reserves. It is not also free to spend.</p></article>;
  if (card.id === "bill") return <article {...props}><p className="kicker">Next bill</p>{nextBill ? <p className="figure"><Money minor={nextBill.amountMinor} /></p> : <p className="figure">None</p>}<p className="muted">{nextBill ? `${nextBill.date} · ${nextBill.label}` : "No outflow is scheduled in the next month."}</p></article>;
  if (card.id === "review") return <article {...props}><p className="kicker">Needs review</p><p className="figure">{dash.reviewCount}</p><p>{dash.reviewCount ? <Link to="/activity?review=needs_review">Open the queue</Link> : "Nothing is waiting for a category check."}</p></article>;
  if (card.id === "goals") return <article {...props}><p className="kicker">Goals</p>{dash.goals.length === 0 ? <p className="muted">No goal is using an envelope yet.</p> : <ul className="list">{dash.goals.slice(0, 3).map((goal) => <li key={goal.id}><span>{goal.name}</span><span><Money minor={goal.availableMinor} /> / <Money minor={goal.target_minor} /></span></li>)}</ul>}<p><Link to="/goals">Open goals</Link></p></article>;
  if (card.id === "month") return (
    <article {...props}>
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
    </article>
  );
  if (card.id === "upcoming") return (
    <article {...props}>
      <div className="link-row"><h2>Upcoming</h2><Link to="/bills">Bills</Link></div>
      {dash.upcoming.length === 0 ? <p className="muted">Nothing scheduled in the next month.</p> : (
        <ul className="list">
          {dash.upcoming.slice(0, 6).map((item) => (
            <li key={`${item.id}-${item.date}`}><span>{item.date} · {item.label}{item.expectedIncome ? " · expected" : ""}</span><Money minor={item.amountMinor} /></li>
          ))}
        </ul>
      )}
    </article>
  );
  if (card.id === "alerts") return (
    <article {...props}>
      <div className="link-row">
        <h2>Alerts</h2>
        {unread.length ? <button type="button" className="btn-quiet" onClick={async () => { await api(scoped(session.householdId, "/alerts/read"), { method: "POST" }); session.bump(); }}>Mark read</button> : null}
      </div>
      {dash.alerts.length === 0 ? <p className="muted">No alerts.</p> : (
        <ul className="list">{dash.alerts.slice(0, 4).map((alert) => <li key={alert.id}><span><strong>{alert.title}</strong><br /><span className="muted">{alert.body}</span></span></li>)}</ul>
      )}
    </article>
  );
  if (card.id === "recent") return (
    <article {...props}>
      <h2>Recent</h2>
      {dash.recent.length === 0 ? <p className="muted">No transactions yet. Add an account, then record what happened.</p> : (
        <div className="table-wrap">
          <table>
            <caption>Recent transactions</caption>
            <thead><tr><th>Date</th><th>Payee</th><th>Type</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {dash.recent.map((txn) => <tr key={txn.id}><td>{txn.date}</td><td>{txn.payee}</td><td>{txn.type.replaceAll("_", " ")}</td><td className="num"><Money minor={txn.amountMinor} /></td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
  return null;
}
