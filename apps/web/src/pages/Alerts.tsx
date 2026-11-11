import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { minorToInput, parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import { Empty, ErrorNote, Field, Loading, Money, Notice, Page } from "../ui.js";

interface Thresholds {
  lowBalanceMinor: number;
  largeTransactionMinor: number;
  unusualSpendingRatioBps: number;
  billLeadDays: number;
  trialLeadDays: number;
  renewalLeadDays: number;
  missingPayGraceDays: number;
  goalHorizonDays: number;
  debtMilestoneMinor: number;
}

interface AlertSettings {
  timezone: string;
  types: Record<string, boolean>;
  thresholds: Thresholds;
  frequency: "immediate" | "digest";
  quietHours: { enabled: boolean; start: string; end: string };
  digest: { enabled: boolean; frequency: "daily" | "weekly"; hour: number; minute: number; weekday: number };
  snoozeHours: number;
  escalation: { enabled: boolean; afterHours: number };
  channels: { inapp: { enabled: boolean }; push: { consent: boolean }; email: { consent: boolean }; sms: { consent: boolean } };
}

interface SettingsPayload {
  version: number;
  settings: AlertSettings;
  channels: { id: string; available: boolean; enabled: boolean; consent: boolean; reason: string }[];
  unsupported: { kind: string; reason: string }[];
  kinds: { id: string; label: string; enabled: boolean }[];
}

interface AlertRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  deliveryStatus: string;
  deliveryDetail: string | null;
  amountMinor: number | null;
  href: string | null;
  targetAvailable: boolean;
  targetNote: string | null;
  createdAt: string;
  snoozedUntil: string | null;
  escalated: boolean;
  channels: Record<string, string>;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function Alerts() {
  const session = useSession();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<AlertSettings | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [serverCopy, setServerCopy] = useState<SettingsPayload | null>(null);
  const [lowBalance, setLowBalance] = useState("");
  const [large, setLarge] = useState("");
  const [debt, setDebt] = useState("");
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  function applyServer(next: SettingsPayload, replaceForm: boolean) {
    if (!replaceForm) return;
    setPayload(next);
    setDraft(next.settings);
    setLowBalance(minorToInput(next.settings.thresholds.lowBalanceMinor, session.currency));
    setLarge(minorToInput(next.settings.thresholds.largeTransactionMinor, session.currency));
    setDebt(minorToInput(next.settings.thresholds.debtMilestoneMinor, session.currency));
    setDirty(false);
    dirtyRef.current = false;
  }

  useEffect(() => {
    let live = true;
    if (!session.householdId) return;
    setLoading(true);
    Promise.all([
      api<SettingsPayload>(scoped(session.householdId, "/alert-settings")),
      api<{ alerts: AlertRow[] }>(scoped(session.householdId, "/alerts")),
    ]).then(([settingsResult, alertResult]) => {
      if (!live) return;
      setAlerts(alertResult.alerts);
      if (!dirtyRef.current) applyServer(settingsResult, true);
      setError("");
    }).catch((caught: unknown) => {
      if (!live) return;
      setError(caught instanceof Error ? caught.message : "Alerts could not be loaded.");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [session.householdId, session.tick, session.currency]);

  function update(patch: Partial<AlertSettings>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
    setNotice("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !payload || !session.householdId) return;
    setNotice("");
    try {
      const settings: AlertSettings = {
        ...draft,
        thresholds: {
          ...draft.thresholds,
          lowBalanceMinor: parseAmount(lowBalance, session.currency),
          largeTransactionMinor: parseAmount(large, session.currency),
          debtMilestoneMinor: parseAmount(debt, session.currency),
        },
        channels: {
          inapp: { enabled: draft.channels.inapp.enabled },
          push: { consent: draft.channels.push.consent },
          email: { consent: draft.channels.email.consent },
          sms: { consent: draft.channels.sms.consent },
        },
      };
      const saved = await api<SettingsPayload>(scoped(session.householdId, "/alert-settings"), { method: "PUT", body: JSON.stringify({ version: payload.version, settings }) });
      applyServer(saved, true);
      setConflict("");
      setNotice("Alert settings saved for this household.");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const body = caught.payload as SettingsPayload | null;
        if (body?.settings && body.version) setServerCopy(body);
        setConflict(caught.message);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Alert settings were not saved.");
    }
  }

  async function checkNow() {
    if (!session.householdId) return;
    setError("");
    try {
      const result = await api<{ alerts: AlertRow[] }>(scoped(session.householdId, "/alerts/check"), { method: "POST", body: "{}" });
      setAlerts(result.alerts);
      setNotice("Checked the records you can see. Unchanged conditions were not alerted again.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The check did not finish.");
    }
  }

  async function act(id: string, action: "read" | "snooze" | "resolve") {
    if (!session.householdId) return;
    setError("");
    try {
      await api(scoped(session.householdId, `/alerts/${id}/${action}`), { method: "POST", body: action === "snooze" ? JSON.stringify({ hours: draft?.snoozeHours }) : "{}" });
      const result = await api<{ alerts: AlertRow[] }>(scoped(session.householdId, "/alerts"));
      setAlerts(result.alerts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That alert was not updated.");
    }
  }

  if (!session.householdId) return null;
  if (loading && !draft && !alerts) return <Loading label="Loading alerts" />;
  if (!draft || !payload || !alerts) {
    return (
      <Page title="Alerts" lede="Personal alerts for this household.">
        {session.offline ? <Notice kind="bad">You are offline. Alert settings and history are not stored on this device.</Notice> : null}
        <ErrorNote message={error || "Alerts could not be loaded."} onRetry={() => session.bump()} />
      </Page>
    );
  }

  return (
    <Page title="Alerts" lede="These settings belong to you in this household. They do not change transactions, balances, or the plan." actions={<button className="btn-secondary" type="button" onClick={() => void checkNow()} disabled={session.offline}>Check now</button>}>
      {session.offline ? <Notice kind="bad">You are offline. You can review what was already loaded. Changes wait until the connection returns.</Notice> : null}
      {error ? <ErrorNote message={error} onRetry={() => session.bump()} /> : null}
      {conflict ? (
        <Notice kind="bad">
          {conflict}{" "}
          <button className="btn-quiet" type="button" onClick={() => { if (serverCopy) applyServer(serverCopy, true); setConflict(""); setServerCopy(null); }}>Load saved settings</button>
        </Notice>
      ) : null}
      {notice ? <Notice>{notice}</Notice> : null}
      <form className="card" onSubmit={(event) => void save(event)}>
        <h2>What to watch</h2>
        <fieldset>
          <legend>Alert types</legend>
          {payload.kinds.map((kind) => (
            <label className="row" key={kind.id}>
              <input type="checkbox" checked={!!draft.types[kind.id]} onChange={(event) => update({ types: { ...draft.types, [kind.id]: event.target.checked } })} />
              {kind.label}
            </label>
          ))}
        </fieldset>
        <div className="row">
          <Field label="Low balance at or below"><input inputMode="decimal" value={lowBalance} onChange={(event) => { setLowBalance(event.target.value); setDirty(true); }} /></Field>
          <Field label="Large transaction at or above"><input inputMode="decimal" value={large} onChange={(event) => { setLarge(event.target.value); setDirty(true); }} /></Field>
          <Field label="Debt milestone at or below"><input inputMode="decimal" value={debt} onChange={(event) => { setDebt(event.target.value); setDirty(true); }} /></Field>
        </div>
        <div className="row">
          <Field label="Bill lead days"><input type="number" min={0} max={90} value={draft.thresholds.billLeadDays} onChange={(event) => update({ thresholds: { ...draft.thresholds, billLeadDays: Number(event.target.value) } })} /></Field>
          <Field label="Trial lead days"><input type="number" min={0} max={90} value={draft.thresholds.trialLeadDays} onChange={(event) => update({ thresholds: { ...draft.thresholds, trialLeadDays: Number(event.target.value) } })} /></Field>
          <Field label="Renewal lead days"><input type="number" min={0} max={90} value={draft.thresholds.renewalLeadDays} onChange={(event) => update({ thresholds: { ...draft.thresholds, renewalLeadDays: Number(event.target.value) } })} /></Field>
          <Field label="Missing pay grace days"><input type="number" min={0} max={30} value={draft.thresholds.missingPayGraceDays} onChange={(event) => update({ thresholds: { ...draft.thresholds, missingPayGraceDays: Number(event.target.value) } })} /></Field>
          <Field label="Goal horizon days"><input type="number" min={0} max={3650} value={draft.thresholds.goalHorizonDays} onChange={(event) => update({ thresholds: { ...draft.thresholds, goalHorizonDays: Number(event.target.value) } })} /></Field>
          <Field label="Unusual spending, percent of the earlier average"><input type="number" min={100} max={10000} value={draft.thresholds.unusualSpendingRatioBps / 100} onChange={(event) => update({ thresholds: { ...draft.thresholds, unusualSpendingRatioBps: Math.round(Number(event.target.value) * 100) } })} /></Field>
        </div>
        <p className="muted">Unusual spending needs at least two earlier months for that category. A goal without a target date is not alerted.</p>
        <h2>When to deliver</h2>
        <Field label="Time zone"><input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} autoComplete="off" /></Field>
        <Field label="Frequency">
          <select value={draft.frequency} onChange={(event) => update({ frequency: event.target.value as AlertSettings["frequency"], digest: { ...draft.digest, enabled: event.target.value === "digest" ? true : draft.digest.enabled } })}>
            <option value="immediate">As soon as quiet hours allow</option>
            <option value="digest">Digest</option>
          </select>
        </Field>
        <fieldset>
          <legend>Quiet hours</legend>
          <label className="row"><input type="checkbox" checked={draft.quietHours.enabled} onChange={(event) => update({ quietHours: { ...draft.quietHours, enabled: event.target.checked } })} /> Hold delivery during quiet hours</label>
          <div className="row">
            <Field label="Start"><input type="time" value={draft.quietHours.start} onChange={(event) => update({ quietHours: { ...draft.quietHours, start: event.target.value.slice(0, 5) } })} /></Field>
            <Field label="End"><input type="time" value={draft.quietHours.end} onChange={(event) => update({ quietHours: { ...draft.quietHours, end: event.target.value.slice(0, 5) } })} /></Field>
          </div>
          <p className="muted">A start later than the end crosses midnight. The end minute is not included.</p>
        </fieldset>
        <fieldset>
          <legend>Digest</legend>
          <label className="row"><input type="checkbox" checked={draft.digest.enabled} onChange={(event) => update({ digest: { ...draft.digest, enabled: event.target.checked }, frequency: event.target.checked ? draft.frequency : "immediate" })} /> Use a digest schedule</label>
          <div className="row">
            <Field label="Digest"><select value={draft.digest.frequency} onChange={(event) => update({ digest: { ...draft.digest, frequency: event.target.value as "daily" | "weekly" } })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></Field>
            <Field label="Hour"><input type="number" min={0} max={23} value={draft.digest.hour} onChange={(event) => update({ digest: { ...draft.digest, hour: Number(event.target.value) } })} /></Field>
            <Field label="Minute"><input type="number" min={0} max={59} value={draft.digest.minute} onChange={(event) => update({ digest: { ...draft.digest, minute: Number(event.target.value) } })} /></Field>
            <Field label="Weekday"><select value={draft.digest.weekday} onChange={(event) => update({ digest: { ...draft.digest, weekday: Number(event.target.value) } })}>{WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></Field>
          </div>
        </fieldset>
        <div className="row">
          <Field label="Snooze hours"><input type="number" min={1} max={168} value={draft.snoozeHours} onChange={(event) => update({ snoozeHours: Number(event.target.value) })} /></Field>
          <Field label="Escalate after hours"><input type="number" min={1} max={720} value={draft.escalation.afterHours} onChange={(event) => update({ escalation: { ...draft.escalation, afterHours: Number(event.target.value) } })} /></Field>
        </div>
        <label className="row"><input type="checkbox" checked={draft.escalation.enabled} onChange={(event) => update({ escalation: { ...draft.escalation, enabled: event.target.checked } })} /> Mark an unread in-app alert as escalated after that many hours. No email or text is sent.</label>
        <h2>Channels</h2>
        <ul className="list">
          {payload.channels.map((channel) => (
            <li key={channel.id}>
              <span>
                <strong>{channelName(channel.id)}</strong>
                <br />
                <span className="muted">{channel.available ? "Available. " : "Unavailable. "}{channel.reason}</span>
              </span>
              {channel.id === "inapp" ? (
                <label className="row"><input type="checkbox" checked={draft.channels.inapp.enabled} onChange={(event) => update({ channels: { ...draft.channels, inapp: { enabled: event.target.checked } } })} /> In app</label>
              ) : (
                <label className="row"><input type="checkbox" checked={draft.channels[channel.id as "push" | "email" | "sms"].consent} onChange={(event) => update({ channels: { ...draft.channels, [channel.id]: { consent: event.target.checked } } })} /> Remember consent</label>
              )}
            </li>
          ))}
        </ul>
        <p className="muted">Consent for push, email, or text does not send those messages. A development outbox is not email delivery, and a notification created on the phone is not remote push.</p>
        {dirty ? <p role="status">You have unsaved alert settings. A refresh will not replace them.</p> : null}
        <button className="btn" type="submit" disabled={session.offline}>Save alert settings</button>
      </form>
      <section className="card" style={{ marginTop: 16 }} aria-labelledby="alert-history-title">
        <h2 id="alert-history-title">History</h2>
        {alerts.length === 0 ? <Empty title="No alerts" body="Check now looks at bills, balances, spending, goals, and expected pay you can already see." /> : (
          <ul className="list">
            {alerts.map((alert) => (
              <li key={alert.id}>
                <span>
                  <strong>{alert.title}</strong>
                  <br />
                  <span className="muted">{statusLabel(alert.status)} · {deliveryLabel(alert.deliveryStatus)}{alert.escalated ? " · Escalated in the app" : ""}{alert.snoozedUntil ? ` · Snoozed until ${alert.snoozedUntil}` : ""}</span>
                  <br />
                  {alert.body}
                  {alert.amountMinor != null ? <> {" "}<Money minor={alert.amountMinor} /></> : null}
                  {alert.deliveryDetail ? <><br /><span className="muted">{alert.deliveryDetail}</span></> : null}
                  {alert.targetNote ? <><br /><span className="muted">{alert.targetNote}</span></> : null}
                </span>
                <span className="row">
                  {alert.href && alert.targetAvailable ? <Link to={alert.href}>Open record</Link> : null}
                  {alert.status !== "read" && alert.status !== "resolved" ? <button className="btn-quiet" type="button" onClick={() => void act(alert.id, "read")}>Mark read</button> : null}
                  {alert.status !== "resolved" ? <button className="btn-quiet" type="button" onClick={() => void act(alert.id, "snooze")}>Snooze</button> : null}
                  {alert.status !== "resolved" ? <button className="btn-quiet" type="button" onClick={() => void act(alert.id, "resolve")}>Resolve</button> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Not available from the ledger</h2>
        <ul>{payload.unsupported.map((item) => <li key={item.kind}>{item.reason}</li>)}</ul>
      </section>
    </Page>
  );
}

function channelName(id: string): string {
  if (id === "inapp") return "In app";
  if (id === "push") return "Push";
  if (id === "email") return "Email";
  if (id === "sms") return "Text";
  return id;
}

function statusLabel(status: string): string {
  if (status === "unread") return "Unread";
  if (status === "read") return "Read";
  if (status === "snoozed") return "Snoozed";
  if (status === "resolved") return "Resolved";
  return status;
}

function deliveryLabel(status: string): string {
  if (status === "generated") return "Generated";
  if (status === "queued") return "Queued";
  if (status === "attempted") return "Attempted";
  if (status === "delivered") return "Delivered in the app";
  return status;
}
