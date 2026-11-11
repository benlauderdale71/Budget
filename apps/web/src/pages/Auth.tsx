import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useSession } from "../session.js";
import { Field, Notice } from "../ui.js";

export function Auth() {
  const session = useSession();
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [mfa, setMfa] = useState(false);
  if (session.user && session.householdId) return <Navigate to={session.user.onboardingStep === "done" ? "/" : "/setup"} replace />;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNote("");
    const data = new FormData(event.currentTarget);
    try {
      if (mode === "reset") {
        const result = await api<{ message?: string }>("/api/auth/forgot", { method: "POST", body: JSON.stringify({ email: data.get("email") }) });
        setNote(result.message ?? "If that email has an account, a reset message was created.");
        return;
      }
      if (mode === "register") {
        const result = await api<{ token: string }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            email: data.get("email"), password: data.get("password"), displayName: data.get("displayName"),
            householdName: data.get("householdName"), currency: data.get("currency") || "USD",
          }),
        });
        localStorage.setItem("budgetcents.token", result.token);
      } else {
        const result = await api<{ token?: string; mfaRequired?: boolean }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: data.get("email"), password: data.get("password"), code: data.get("code") || undefined }),
        });
        if (result.mfaRequired) { setMfa(true); setNote("Enter the code from your authenticator."); return; }
        localStorage.setItem("budgetcents.token", result.token!);
      }
      await session.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    }
  }

  return (
    <div className="auth">
      <section className="auth-story">
        <div>
          <div className="wordmark">Budget<i>Cents</i></div>
          <h1>One ledger for the plan and the money.</h1>
          <p>Categories, envelopes, and flex spending read the same transactions. A transfer, a card payment, and a savings allocation stay inside the household instead of looking like new income or a second expense.</p>
        </div>
        <ul className="auth-points">
          <li>Ready to Assign uses cash that has arrived.</li>
          <li>Private accounts stay out of shared totals, exports, and the assistant.</li>
          <li>Bank, credit, and negotiation connections stay off until you configure a provider.</li>
        </ul>
      </section>
      <section className="auth-panel">
        <div className="wordmark" style={{ marginBottom: 16 }}>Budget<i>Cents</i></div>
        <div className="chips" role="tablist" aria-label="Account">
          <button className="chip" aria-pressed={mode === "login"} onClick={() => setMode("login")}>Sign in</button>
          <button className="chip" aria-pressed={mode === "register"} onClick={() => setMode("register")}>Create household</button>
          <button className="chip" aria-pressed={mode === "reset"} onClick={() => setMode("reset")}>Reset password</button>
        </div>
        <form onSubmit={submit} style={{ marginTop: 16 }}>
          {mode === "register" ? <>
            <Field label="Your name"><input name="displayName" required autoComplete="name" /></Field>
            <Field label="Household name"><input name="householdName" required /></Field>
            <Field label="Currency"><input name="currency" defaultValue="USD" maxLength={3} /></Field>
          </> : null}
          <Field label="Email"><input name="email" type="email" required autoComplete="username" /></Field>
          {mode !== "reset" ? <Field label="Password"><input name="password" type="password" required minLength={mode === "register" ? 10 : 8} autoComplete={mode === "login" ? "current-password" : "new-password"} /></Field> : <p className="muted">The same reply is shown whether or not that email has an account. Open the link from the message. In development, that message is in <Link to="/dev/mail">Development mail</Link>.</p>}
          {mfa ? <Field label="Authentication code"><input name="code" inputMode="numeric" autoComplete="one-time-code" /></Field> : null}
          {error ? <Notice kind="bad">{error}</Notice> : null}
          {note ? <Notice>{note}</Notice> : null}
          <button className="btn" type="submit">{mode === "register" ? "Create household" : mode === "reset" ? "Continue" : "Sign in"}</button>
        </form>
        <form style={{ marginTop: 18 }} onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            const result = await api<{ token: string }>("/api/auth/demo", { method: "POST" });
            localStorage.setItem("budgetcents.token", result.token);
            await session.refresh();
          } catch (caught) { setError(caught instanceof Error ? caught.message : "Sample household is unavailable."); }
        }}>
          <button className="btn-secondary" type="submit">Open the sample household</button>
          <p className="muted">Alex Rivera’s numbers are sample data, not a live bank connection.</p>
        </form>
        <p className="muted"><Link to="/privacy">Privacy</Link> · <Link to="/delete-account">Delete account</Link> · <Link to="/dev/mail">Development mail</Link></p>
      </section>
    </div>
  );
}

export function Invite() {
  const { token } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  if (!session.user) return <Navigate to="/login" replace />;
  return (
    <main className="content">
      <h1>Join household</h1>
      <p className="lede">The invitation is accepted only when this account’s email matches the invitation.</p>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      <button className="btn" onClick={async () => {
        try {
          await api(`/api/invitations/${token}/accept`, { method: "POST" });
          await session.refresh();
          navigate("/");
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not accept."); }
      }}>Accept invitation</button>
    </main>
  );
}
