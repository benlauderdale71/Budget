import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { clearReturnPath, marketReturnPath, peekReturnPath, rememberReturnPath } from "../return-path.js";
import { useSession } from "../session.js";
import { Field, Notice } from "../ui.js";
import { DevMailLink, useRuntimeFlags } from "../runtime-flags.js";

export function Auth() {
  const session = useSession();
  const flags = useRuntimeFlags();
  const [params] = useSearchParams();
  rememberReturnPath(params.get("next"));
  const destination = peekReturnPath();
  const [mode, setMode] = useState<"login" | "register" | "join" | "reset">(destination?.startsWith("/invite/") ? "join" : "login");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [mfa, setMfa] = useState(false);
  const marketDestination = marketReturnPath(destination);
  useEffect(() => {
    if (!session.ready || !session.user || !marketDestination) return;
    clearReturnPath();
    window.location.replace(marketDestination);
  }, [session.ready, session.user, marketDestination]);
  if (!session.ready) return <p className="state">Opening BudgetCents…</p>;
  if (session.user && marketDestination) return <p className="state">Opening Market Pulse…</p>;
  if (session.user && destination) return <Navigate to={destination} replace />;
  if (session.user && session.householdId) return <Navigate to={session.user.onboardingStep && session.user.onboardingStep !== "done" ? "/setup" : "/"} replace />;
  if (session.user && !session.householdId) {
    return (
      <main className="content legal">
        <h1>No household yet</h1>
        <p>You are signed in as {session.user.email}. Open the invitation you were sent, or sign out and create a household with a new account. Accepting an invitation is a separate step.</p>
        <p><DevMailLink /></p>
        <button className="btn" type="button" onClick={() => void session.signOut()}>Use a different account</button>
      </main>
    );
  }

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
      if (mode === "register" || mode === "join") {
        const result = await api<{ token: string }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            email: data.get("email"), password: data.get("password"), displayName: data.get("displayName"),
            householdName: mode === "join" ? undefined : data.get("householdName"), currency: data.get("currency") || "USD",
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
      <main className="auth-panel">
        <div className="wordmark" style={{ marginBottom: 16 }}>Budget<i>Cents</i></div>
        <div className="chips" role="group" aria-label="Account">
          <button className="chip" aria-pressed={mode === "login"} onClick={() => setMode("login")}>Sign in</button>
          <button className="chip" aria-pressed={mode === "join"} onClick={() => setMode("join")}>Join a household</button>
          <button className="chip" aria-pressed={mode === "register"} onClick={() => setMode("register")}>Create household</button>
          <button className="chip" aria-pressed={mode === "reset"} onClick={() => setMode("reset")}>Reset password</button>
        </div>
        <form onSubmit={submit} style={{ marginTop: 16 }}>
          {mode === "register" || mode === "join" ? <>
            <Field label="Your name"><input name="displayName" required autoComplete="name" /></Field>
            {mode === "register" ? <Field label="Household name"><input name="householdName" required /></Field> : <p className="muted">This account is only for joining an existing household. It does not create a new one.</p>}
            <Field label="Currency"><input name="currency" defaultValue="USD" maxLength={3} /></Field>
          </> : null}
          <Field label="Email"><input name="email" type="email" required autoComplete="username" /></Field>
          {mode !== "reset" ? <Field label="Password"><input name="password" type="password" required minLength={mode === "login" ? 8 : 10} autoComplete={mode === "login" ? "current-password" : "new-password"} aria-describedby={mode === "register" || mode === "join" ? "password-help" : undefined} /></Field> : <p className="muted">The same reply is shown whether or not that email has an account. Open the link from the message. {flags.devMail ? <>In development, that message is in <DevMailLink />.</> : null}</p>}
          {flags.loaded && !flags.mailDelivery && !flags.devMail && mode !== "login" ? <Notice>Email delivery is not configured. You can create a household and continue setup, but email verification, invitations, and password-reset delivery are not available yet.</Notice> : null}
          {mode === "register" || mode === "join" ? <p id="password-help" className="muted">At least 10 characters. A password manager can fill or paste this.</p> : null}
          {mfa ? <Field label="Authentication code"><input name="code" inputMode="numeric" autoComplete="one-time-code" /></Field> : null}
          {error ? <Notice kind="bad">{error}</Notice> : null}
          {note ? <Notice>{note}</Notice> : null}
          <button className="btn" type="submit">{mode === "register" ? "Create household" : mode === "join" ? "Create account" : mode === "reset" ? "Continue" : "Sign in"}</button>
        </form>
        {flags.federatedLogin ? <button className="btn-secondary" type="button" style={{ marginTop: 12 }} onClick={async () => {
          setError("");
          try {
            const start = await api<{ authorizationUrl: string }>(`/api/auth/oidc/start?next=${encodeURIComponent(destination || "/")}`);
            window.location.assign(start.authorizationUrl);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Federated sign-in is not configured.");
          }
        }}>Sign in with an identity provider</button> : null}
        {params.get("oidc") === "link" || params.get("oidc") === "mfa" ? <form style={{ marginTop: 12 }} onSubmit={async (event) => {
          event.preventDefault();
          const pending = sessionStorage.getItem("budgetcents.oidcPending") ?? "";
          const data = new FormData(event.currentTarget);
          try {
            const path = params.get("oidc") === "mfa" ? "/api/auth/oidc/mfa" : "/api/auth/oidc/link";
            const result = await api<{ token?: string; note?: string }>(path, { method: "POST", body: JSON.stringify(params.get("oidc") === "mfa" ? { pendingToken: pending, code: data.get("code") } : { pendingToken: pending, password: data.get("password") }) });
            if (result.token) {
              sessionStorage.removeItem("budgetcents.oidcPending");
              localStorage.setItem("budgetcents.token", result.token);
              await session.refresh();
            } else setNote(result.note ?? "The identity was not signed in.");
          } catch (caught) { setError(caught instanceof Error ? caught.message : "The identity was not linked."); }
        }}>
          <p className="muted">{params.get("oidc") === "mfa" ? "Enter the authentication code from your authenticator. No invitation is accepted." : "Enter the password for the existing account to link this identity. No invitation is accepted."}</p>
          {params.get("oidc") === "mfa" ? <Field label="Authentication code"><input name="code" inputMode="numeric" required /></Field> : <Field label="Password"><input name="password" type="password" required /></Field>}
          <button className="btn" type="submit">{params.get("oidc") === "mfa" ? "Finish sign-in" : "Link account"}</button>
        </form> : null}
        {flags.demoLogin ? <form style={{ marginTop: 18 }} onSubmit={async (event) => {
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
        </form> : null}
        <p className="muted"><Link to="/privacy">Privacy</Link> · <Link to="/delete-account">Delete account</Link><DevMailLink separator /></p>
      </main>
    </div>
  );
}

