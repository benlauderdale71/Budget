import { DevMailLink } from "../runtime-flags.js";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { peekReturnPath } from "../return-path.js";
import { useSession } from "../session.js";
import { Field, Notice } from "../ui.js";

export function VerifyEmail() {
  const session = useSession();
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNote("");
    try {
      const result = await api<{ onboardingStep?: string | null }>("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: token.trim() }),
      });
      if (session.user) await session.refresh();
      const next = peekReturnPath();
      const follow = next ? "Return to the invitation when you are ready. It stays pending until you accept it." : result.onboardingStep && result.onboardingStep !== "done" ? "Setup continues from the saved step." : "You can sign in and continue.";
      setNote(`Email verified. ${follow}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That verification link did not work.");
    }
  }

  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Verify email</h1>
      <p className="lede">An unverified account can keep setting up. Invitations stay closed until this link is used. Saving a setup step does not verify the email.</p>
      <form onSubmit={submit}>
        <Field label="Verification token"><input name="token" value={token} onChange={(event) => setToken(event.target.value)} required /></Field>
        {error ? <Notice kind="bad">{error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <button className="btn" type="submit">Verify email</button>
      </form>
      <p>{peekReturnPath() ? <Link to={peekReturnPath()!}>Return to the invitation</Link> : session.user ? <Link to="/setup">Continue setup</Link> : <Link to="/login">Sign in</Link>}<DevMailLink separator /></p>
    </main>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNote("");
    if (password !== confirm) {
      setError("Enter the same password in both fields.");
      return;
    }
    try {
      await api("/api/auth/reset", { method: "POST", body: JSON.stringify({ token: token.trim(), password }) });
      setPassword("");
      setConfirm("");
      setNote("Password updated. Sign in with the new one. Setup continues from the saved step.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That reset link did not work.");
    }
  }

  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Choose a new password</h1>
      <p className="lede">This link works once. Other signed-in sessions are signed out. An authenticator you already turned on stays on.</p>
      <form onSubmit={submit}>
        <Field label="Reset token"><input name="token" value={token} onChange={(event) => setToken(event.target.value)} required /></Field>
        <Field label="New password"><input name="password" type="password" minLength={10} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
        <Field label="Confirm password"><input name="confirm" type="password" minLength={10} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></Field>
        {error ? <Notice kind="bad">{error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <button className="btn" type="submit">Update password</button>
      </form>
      <p><Link to="/login">Sign in</Link><DevMailLink separator /></p>
    </main>
  );
}

export function DevMail() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [messages, setMessages] = useState<{ subject: string; body: string; created_at: string }[]>([]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNote("");
    try {
      const result = await api<{ messages: { subject: string; body: string; created_at: string }[]; note: string }>(`/api/dev/outbox?email=${encodeURIComponent(email.trim())}`);
      setMessages(result.messages);
      setNote(result.note);
    } catch (caught) {
      setMessages([]);
      setError(caught instanceof Error ? caught.message : "Development mail is off.");
    }
  }

  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Development mail</h1>
      <p className="lede">This page reads the local outbox for one address. It is off when the server is in production. It does not show that an SMTP service delivered anything.</p>
      <form onSubmit={submit}>
        <Field label="Mailbox email"><input name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
        {error ? <Notice kind="bad">{error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <button className="btn" type="submit">Show messages</button>
      </form>
      {messages.map((message) => (
        <article className="card" key={`${message.created_at}-${message.subject}`}>
          <h2>{message.subject}</h2>
          <pre>{message.body}</pre>
          {linkFrom(message.body).map((href) => <p key={href}><a href={href}>{href}</a></p>)}
        </article>
      ))}
      <p><Link to="/login">Sign in</Link></p>
    </main>
  );
}

function linkFrom(body: string) {
  return body.match(/https?:\/\/[^\s]+/g) ?? [];
}
