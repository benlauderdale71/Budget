import { useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadFile } from "../api.js";
import { parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import type { Dashboard } from "../types.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

const moreLinks = [
  ["/forecast", "Forecast", "Cash projection and paycheck coverage"],
  ["/paychecks", "Paychecks", "Expected income that is not cash yet"],
  ["/calendar", "Calendar", "Paychecks, bills, and due dates"],
  ["/bills", "Bills", "Recurring bills and subscriptions"],
  ["/debts", "Debts", "Snowball, avalanche, and a loan model"],
  ["/goals", "Goals", "Envelopes with a target"],
  ["/reports", "Reports", "Spending, savings rate, exports"],
  ["/investments", "Investments", "Holdings and manual prices"],
  ["/retirement", "Retirement", "A seeded model, not a promise"],
  ["/assistant", "Assistant", "Answers from ledger facts"],
  ["/household", "Sharing", "People, roles, and spaces"],
  ["/rules", "Rules", "Payee rules that do not override a lock"],
  ["/import", "Import", "CSV, OFX, and QIF"],
  ["/providers", "Connections", "What is live and what is not"],
  ["/cases", "Requests", "Cancellation notes, with no biller contacted"],
  ["/credit", "Credit", "A score you type, not a bureau report"],
  ["/learn", "Learn", "Short original lessons"],
  ["/checklists", "Checklists", "Tax and estate lists, not legal documents"],
  ["/settings", "Settings", "Security, export, and deletion"],
];

export function More() {
  return (
    <Page title="More" lede="The same household is behind every tool.">
      <div className="more-grid">
        {moreLinks.map(([to, title, body]) => <Link key={to} to={to} className="card"><h2>{title}</h2><p className="muted">{body}</p></Link>)}
      </div>
    </Page>
  );
}

export function Assistant() {
  const session = useSession();
  const [answer, setAnswer] = useState<{ text: string; facts: { label: string; formula?: string }[]; missing: string[] } | null>(null);
  const form = useFormError();
  return (
    <Page title="Assistant" lede="Questions are answered from figures BudgetCents already calculated. Text you paste is data, not an instruction to move money.">
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        setAnswer(await api(scoped(session.householdId, "/assistant"), { method: "POST", body: JSON.stringify({ question: data.get("question"), spaceId: session.spaceId }) }));
      })}>
        <Field label="Question"><textarea name="question" required placeholder="What can I safely spend?" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Ask</button>
      </form>
      {answer ? <article className="card" style={{ marginTop: 16 }}><p>{answer.text}</p>{answer.facts.map((fact) => <p key={fact.label} className="formula">{fact.label}{fact.formula ? ` — ${fact.formula}` : ""}</p>)}{answer.missing.length ? <p>Missing: {answer.missing.join(", ")}</p> : null}</article> : null}
    </Page>
  );
}

export function ImportPage() {
  const session = useSession();
  const accounts = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId]);
  const [preview, setPreview] = useState<{ batchId: string; rows: { rowNumber: number; date?: string; payee?: string; amountMinor?: number; duplicate?: boolean; possibleMatch?: boolean; errors: string[] }[]; missing: string[] } | null>(null);
  const form = useFormError();
  return (
    <Page title="Import" lede="Preview first. Duplicates and broken rows are left out of the commit. A profile does not invent columns the file does not have.">
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const file = data.get("file") as File;
        const text = await file.text();
        setPreview(await api(scoped(session.householdId, "/import/preview"), { method: "POST", body: JSON.stringify({ spaceId: accounts.data?.spaceId, profile: data.get("profile") || undefined, format: data.get("format"), text }) }));
      })}>
        <Field label="Format"><select name="format"><option value="csv">CSV</option><option value="ofx">OFX</option><option value="qif">QIF</option></select></Field>
        <Field label="Profile"><select name="profile"><option value="">Generic columns</option><option value="mint">Mint</option><option value="ynab">YNAB</option><option value="monarch">Monarch</option><option value="simplifi">Simplifi</option><option value="rocket">Rocket Money</option><option value="everydollar">EveryDollar</option><option value="empower">Empower</option><option value="goodbudget">Goodbudget</option></select></Field>
        <Field label="File"><input name="file" type="file" required accept=".csv,.ofx,.qfx,.qif,text/csv,text/plain" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit" disabled={!accounts.data}>Preview</button>
      </form>
      {preview ? <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const rowNumbers = preview.rows.filter((row) => data.get(`row-${row.rowNumber}`) === "on").map((row) => row.rowNumber);
        const result = await api<{ created: number }>(scoped(session.householdId, `/import/${preview.batchId}/commit`), { method: "POST", body: JSON.stringify({ accountId: data.get("accountId"), rowNumbers }) });
        setPreview(null);
        session.bump();
        form.setError("");
        alert(`Imported ${result.created}. They need review before they change a category you already confirmed.`);
      })}>
        <p>{preview.missing.join(" ")}</p>
        <Field label="Account"><select name="accountId" required>{accounts.data?.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        {preview.rows.slice(0, 40).map((row) => <label key={row.rowNumber} className="link-row"><span><input type="checkbox" name={`row-${row.rowNumber}`} defaultChecked={!row.duplicate && !row.possibleMatch && !row.errors.length} disabled={!!row.duplicate || row.errors.length > 0} /> {row.date} {row.payee} {row.duplicate ? "(already imported)" : row.possibleMatch ? "(same date, payee, and amount already in the register — check this only if it is the bank copy you want to match)" : row.errors.join(", ")}</span>{row.amountMinor != null ? <Money minor={row.amountMinor} /> : null}</label>)}
        <button className="btn" type="submit">Import selected</button>
      </form> : null}
    </Page>
  );
}

export function Rules() {
  const session = useSession();
  const state = useLoad(() => api<{ rules: { id: string; name: string; match_mode: string; enabled: number }[] }>(scoped(session.householdId, "/rules")), [session.householdId, session.tick]);
  const dash = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId]);
  const form = useFormError();
  if (!state.data) return <Loading />;
  return (
    <Page title="Rules" lede="A rule can rename a payee or suggest a category. It will not replace a category you locked.">
      <ul>{state.data.rules.map((rule) => <li key={rule.id}>{rule.name} · {rule.match_mode} · {rule.enabled ? "on" : "off"}</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/rules"), { method: "POST", body: JSON.stringify({
          name: data.get("name"), matchMode: "all", priority: 50,
          conditions: [{ field: "payee", op: "contains", value: data.get("contains") }],
          actions: [{ type: "set_bucket", value: data.get("bucketId") }, { type: "set_payee", value: data.get("payee") || undefined }].filter((action) => action.value),
        }) });
        session.bump();
      })}>
        <Field label="Name"><input name="name" required /></Field>
        <Field label="Payee contains"><input name="contains" required /></Field>
        <Field label="Set category"><select name="bucketId">{dash.data?.buckets.filter((bucket) => !bucket.systemRole).map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="Rename payee"><input name="payee" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save rule</button>
      </form>
    </Page>
  );
}

export function Household() {
  const session = useSession();
  const state = useLoad(() => api<{ members: { id: string; displayName: string; role: string; you: boolean }[]; invitations: { id: string; email: string; role: string }[] }>(scoped(session.householdId, "/members")), [session.householdId, session.tick]);
  const form = useFormError();
  const [token, setToken] = useState("");
  if (!state.data) return <Loading />;
  return (
    <Page title="Sharing" lede="Owners and admins invite people. A private account stays hidden from everyone else, including an admin. The household can hold 12 people.">
      <ul>{state.data.members.map((member) => <li key={member.id}>{member.displayName} · {member.role}{member.you ? " · you" : ""}</li>)}</ul>
      <ul>{state.data.invitations.map((invite) => <li key={invite.id}>{invite.email} · {invite.role} · pending</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ token: string; summary: string }>(scoped(session.householdId, "/invitations"), { method: "POST", body: JSON.stringify({ email: data.get("email"), role: data.get("role") }) });
        setToken(`${window.location.origin}/invite/${result.token} — ${result.summary}`);
        session.bump();
      })}>
        <Field label="Email"><input name="email" type="email" required /></Field>
        <Field label="Role"><select name="role"><option value="editor">Editor</option><option value="contributor">Contributor</option><option value="readonly">Read only</option><option value="admin">Admin</option><option value="coach">Coach</option><option value="planner">Planner</option><option value="accountant">Accountant</option></select></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {token ? <Notice>{token}</Notice> : null}
        <button className="btn" type="submit">Create invitation</button>
      </form>
      <SpaceForm />
    </Page>
  );
}

function SpaceForm() {
  const session = useSession();
  const form = useFormError();
  return (
    <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      await api(scoped(session.householdId, "/spaces"), { method: "POST", body: JSON.stringify({ name: data.get("name"), kind: data.get("kind"), businessType: data.get("businessType") || undefined }) });
      session.bump();
    })}>
      <h2>Space</h2>
      <p className="muted">A personal space is visible only to you. A business space keeps its own plan and still rolls into household net worth.</p>
      <Field label="Name"><input name="name" required /></Field>
      <Field label="Kind"><select name="kind"><option value="personal">Personal</option><option value="business">Business</option></select></Field>
      <Field label="Business type"><input name="businessType" /></Field>
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      <button className="btn" type="submit">Add space</button>
    </form>
  );
}

export function Providers() {
  const state = useLoad(() => api<{ providers: { id: string; name: string; group: string; status: string; needs: string; capabilities: string[] }[] }>("/api/providers"), []);
  if (!state.data) return <Loading />;
  return (
    <Page title="Connections" lede="Manual entry and file import work now. Other providers stay off until their credentials and consent are configured. Nothing here pretends a bank or bureau responded.">
      {state.data.providers.map((provider) => (
        <article key={provider.id} className="card" style={{ marginBottom: 12 }}>
          <div className="link-row"><h2>{provider.name}</h2><span>{provider.status.replaceAll("_", " ")}</span></div>
          <p className="muted">{provider.group} · {provider.capabilities.join(", ")}</p>
          <p>{provider.needs}</p>
        </article>
      ))}
    </Page>
  );
}

export function Cases() {
  const session = useSession();
  const state = useLoad(() => api<{ cases: { id: string; merchant: string; kind: string; status: string }[] }>(scoped(session.householdId, "/cases")), [session.householdId, session.tick]);
  const form = useFormError();
  const [note, setNote] = useState("");
  return (
    <Page title="Requests" lede="Saving a request records your authorization. It does not contact a biller, cancel a subscription, or negotiate a bill.">
      <ul>{state.data?.cases.map((item) => <li key={item.id}>{item.merchant} · {item.kind} · {item.status.replaceAll("_", " ")}</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ provider: string }>(scoped(session.householdId, "/cases"), { method: "POST", body: JSON.stringify({ kind: data.get("kind"), merchant: data.get("merchant"), authorized: data.get("authorized") === "on" }) });
        setNote(result.provider);
        session.bump();
      })}>
        <Field label="Kind"><select name="kind"><option value="cancellation">Cancellation</option><option value="negotiation">Negotiation</option><option value="refund_review">Refund review</option></select></Field>
        <Field label="Merchant"><input name="merchant" required /></Field>
        <label className="field"><span><input type="checkbox" name="authorized" required /> I authorize storing this request. I understand no provider is connected.</span></label>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <button className="btn" type="submit">Record request</button>
      </form>
    </Page>
  );
}

export function Credit() {
  const session = useSession();
  const state = useLoad(() => api<{ entries: { id: string; score: number; model: string; source: string; report_date: string }[]; liveReport: null; note: string }>(scoped(session.householdId, "/credit")), [session.householdId, session.tick]);
  const form = useFormError();
  if (!state.data) return <Loading />;
  return (
    <Page title="Credit" lede={state.data.note}>
      {state.data.liveReport === null ? <p className="muted">No live report is attached.</p> : null}
      <ul>{state.data.entries.map((entry) => <li key={entry.id}>{entry.report_date} · {entry.score} · {entry.model} · {entry.source}</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/credit"), { method: "POST", body: JSON.stringify({ score: Number(data.get("score")), model: data.get("model"), note: data.get("note") }) });
        session.bump();
      })}>
        <Field label="Score"><input name="score" type="number" min={300} max={850} required /></Field>
        <Field label="Model"><input name="model" defaultValue="Manual entry" /></Field>
        <Field label="Note"><input name="note" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save manual score</button>
      </form>
    </Page>
  );
}

export function Learn() {
  const state = useLoad(() => api<{ lessons: { id: string; title: string; topic: string; minutes: number; body: string; completed: boolean; quiz: { question: string; choices: string[]; answer: number; explanation: string }[] }[] }>("/api/lessons"), []);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  if (!state.data) return <Loading />;
  return (
    <Page title="Learn" lede="These lessons were written for BudgetCents. Completing one does not enroll you with a coach.">
      {state.data.lessons.map((lesson) => (
        <article key={lesson.id} className="card" style={{ marginBottom: 12 }}>
          <h2>{lesson.title}</h2>
          <p className="muted">{lesson.topic} · {lesson.minutes} min{lesson.completed ? " · completed" : ""}</p>
          <p>{lesson.body}</p>
          {lesson.quiz.map((quiz) => (
            <fieldset key={quiz.question}>
              <legend>{quiz.question}</legend>
              {quiz.choices.map((choice, index) => <label key={choice} className="field"><span><input type="radio" name={lesson.id} onChange={() => setPicked({ ...picked, [lesson.id]: index })} /> {choice}</span></label>)}
              <button className="btn-secondary" type="button" onClick={async () => {
                if (picked[lesson.id] !== quiz.answer) { setNote(quiz.explanation); return; }
                await api(`/api/lessons/${lesson.id}/complete`, { method: "POST", body: JSON.stringify({ score: 1 }) });
                setNote(quiz.explanation);
              }}>Check</button>
            </fieldset>
          ))}
        </article>
      ))}
      {note ? <Notice>{note}</Notice> : null}
    </Page>
  );
}

export function Checklists() {
  const session = useSession();
  const [kind, setKind] = useState("estate");
  const state = useLoad(() => api<{ items: { id: string; title: string; done: number }[] }>(scoped(session.householdId, `/checklists/${kind}`)), [session.householdId, kind, session.tick]);
  const form = useFormError();
  return (
    <Page title="Checklists" lede="Tax and estate lists organize your own tasks. A checked item is not a filed return or an executed will.">
      <div className="chips">{["estate", "tax", "business"].map((item) => <button key={item} className="chip" aria-pressed={kind === item} onClick={() => setKind(item)}>{item}</button>)}</div>
      <ul>{state.data?.items.map((item) => <li key={item.id}><label><input type="checkbox" checked={item.done === 1} onChange={async (event) => { await api(scoped(session.householdId, `/checklists/${kind}`), { method: "POST", body: JSON.stringify({ id: item.id, title: item.title, done: event.target.checked }) }); session.bump(); }} /> {item.title}</label></li>)}</ul>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, `/checklists/${kind}`), { method: "POST", body: JSON.stringify({ title: data.get("title") }) });
        session.bump();
      })}>
        <Field label="Add item"><input name="title" required /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Add</button>
      </form>
    </Page>
  );
}

export function Settings() {
  const session = useSession();
  const sessions = useLoad(() => api<{ sessions: { id: string; device_label: string | null; created_at: string; revoked_at: string | null }[] }>("/api/auth/sessions"), [session.tick]);
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [token, setToken] = useState("");
  const form = useFormError();
  if (!session.user) return null;
  return (
    <Page title="Settings" lede="Sign-in, privacy, export, and deletion. Mail stays in the local outbox until SMTP is configured.">
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await session.patchMe({ displayName: data.get("displayName"), theme: data.get("theme"), aiEnabled: data.get("ai") === "on", labelMode: data.get("labelMode") });
      })}>
        <Field label="Name"><input name="displayName" defaultValue={session.user.displayName} /></Field>
        <Field label="Theme"><select name="theme" defaultValue={session.user.theme}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
        <Field label="Labels"><select name="labelMode" defaultValue={session.user.labelMode}><option value="categories">Categories</option><option value="envelopes">Envelopes</option></select></Field>
        <label className="field"><span><input type="checkbox" name="ai" defaultChecked={session.user.aiEnabled} /> Assistant can answer from ledger facts</span></label>
        <button className="btn" type="submit">Save</button>
      </form>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Authenticator</h2>
        {!session.user.mfaEnabled ? <button className="btn-secondary" onClick={async () => { const result = await api<{ secret: string }>("/api/auth/mfa/setup", { method: "POST" }); setSecret(result.secret); }}>Start setup</button> : null}
        {secret ? <form onSubmit={(event) => form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          const result = await api<{ recoveryCodes: string[] }>("/api/auth/mfa/enable", { method: "POST", body: JSON.stringify({ code: data.get("code") }) });
          setCodes(result.recoveryCodes);
          await session.refresh();
        })}><p>Add this secret to an authenticator, then enter the current code. It is shown once here so you can copy it: {secret}</p><Field label="Code"><input name="code" required /></Field><button className="btn" type="submit">Enable</button></form> : null}
        {codes.length ? <Notice>Recovery codes, shown once: {codes.join(", ")}</Notice> : null}
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Sessions</h2>
        <ul>{sessions.data?.sessions.filter((item) => !item.revoked_at).map((item) => <li key={item.id}>{item.device_label || "Session"} · {item.created_at} <button className="btn-quiet" onClick={async () => { await api(`/api/auth/sessions/${item.id}`, { method: "DELETE" }); session.bump(); }}>Revoke</button></li>)}</ul>
        <button className="btn-secondary" onClick={async () => { const result = await api<{ token: string }>("/api/api-tokens", { method: "POST", body: JSON.stringify({ name: "Personal token" }) }); setToken(result.token); }}>Create API token</button>
        {token ? <Notice>Copy this token now. It is stored only as a hash. {token}</Notice> : null}
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Your data</h2>
        <RestoreBackup />
        <div className="row">
          <button className="btn-secondary" onClick={() => downloadFile(scoped(session.householdId, "/backup"), "budgetcents-backup.json")}>Download backup</button>
          <button className="btn-secondary" onClick={async () => {
            if (!window.confirm("Archive assignments and keep transactions?")) return;
            const dash = await api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId));
            await api(scoped(session.householdId, "/fresh-start"), { method: "POST", body: JSON.stringify({ spaceId: dash.spaceId, keepTargets: true }) });
            session.bump();
          }}>Fresh start</button>
        </div>
        <DeleteAccount />
      </section>
      <Support />
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
    </Page>
  );
}

function RestoreBackup() {
  const session = useSession();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ backup: unknown; adds: Record<string, number>; skipped: number; warnings: string[]; note: string } | null>(null);
  const [done, setDone] = useState("");
  return (
    <div>
      <label className="btn-secondary">Choose a backup file<input name="backup" type="file" accept="application/json,.json" hidden onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        setError("");
        setDone("");
        setPreview(null);
        if (!file) return;
        try {
          const backup = JSON.parse(await file.text()) as unknown;
          const result = await api<{ adds: Record<string, number>; skipped: number; warnings: string[]; note: string }>(scoped(session.householdId, "/restore"), { method: "POST", body: JSON.stringify({ mode: "preview", backup }) });
          setPreview({ backup, ...result });
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : "That file could not be read.";
          setError(`${reason} Nothing was changed.`);
        }
      }} /></label>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {preview ? (
        <div>
          <p>{preview.note} This preview did not write anything. Would add {Object.entries(preview.adds).map(([name, count]) => `${name} ${count}`).join(", ") || "nothing"}. Skipped {preview.skipped}. {preview.warnings.join(" ")}</p>
          <button className="btn" type="button" onClick={async () => {
            setError("");
            try {
              await api(scoped(session.householdId, "/restore"), { method: "POST", body: JSON.stringify({ mode: "add-missing", backup: preview.backup }) });
              setPreview(null);
              setDone("Missing rows were added. Running the same file again does not create a second copy.");
              session.bump();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "The restore was rejected. Nothing was changed.");
            }
          }}>Add the missing rows</button>
        </div>
      ) : null}
      {done ? <Notice>{done}</Notice> : null}
    </div>
  );
}

function DeleteAccount() {
  const session = useSession();
  const form = useFormError();
  return (
    <form style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      await api("/api/me", { method: "DELETE", body: JSON.stringify({ password: data.get("password"), confirm: "DELETE" }) });
      localStorage.removeItem("budgetcents.token");
      window.location.assign("/login");
    })}>
      <h3>Delete account</h3>
      <p className="muted">Type DELETE after your password. An owned household with other people must be left first.</p>
      <Field label="Password"><input name="password" type="password" required /></Field>
      <Field label="Type DELETE"><input name="confirm" required pattern="DELETE" /></Field>
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      <button className="btn-danger" type="submit">Delete my account</button>
    </form>
  );
}

function Support() {
  const form = useFormError();
  const [note, setNote] = useState("");
  return (
    <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      const result = await api<{ note: string }>("/api/support", { method: "POST", body: JSON.stringify({ subject: data.get("subject"), body: data.get("body") }) });
      setNote(result.note);
    })}>
      <h2>Support</h2>
      <Field label="Subject"><input name="subject" required /></Field>
      <Field label="Message"><textarea name="body" required /></Field>
      {note ? <Notice>{note}</Notice> : null}
      <button className="btn-secondary" type="submit">Save request</button>
    </form>
  );
}
