import { useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { clearReturnPath } from "../return-path.js";
import { useSession } from "../session.js";

export function AndroidSignIn() {
  const session = useSession();
  const location = useLocation();
  const [params] = useSearchParams();
  const challenge = params.get("challenge") ?? "";
  const state = params.get("state") ?? "";
  const app = params.get("app");
  const validProof = /^[A-Za-z0-9_-]{43}$/;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [callback, setCallback] = useState("");
  useEffect(() => {
    clearReturnPath();
    setCallback("");
    setError("");
  }, [location.search, session.user?.id]);

  if (!validProof.test(challenge) || !validProof.test(state) || !["test", "regular"].includes(app ?? "")) {
    return <main className="content legal"><h1>Open Budget HQ Pro on your phone</h1><p>Choose <strong>Use website sign-in</strong> in the Android app to start.</p></main>;
  }
  if (!session.ready) return <p className="state">Opening your account…</p>;
  if (!session.user) return <Navigate replace to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{code: string}>("/api/auth/android/authorize", {
        method: "POST", body: JSON.stringify({ state, challenge }),
      }, { queue: false });
      const scheme = app === "test" ? "com.budgetcents.app.test" : "com.budgetcents.app";
      const uri = `${scheme}://auth/return?${new URLSearchParams({ code: result.code, state })}`;
      setCallback(uri);
      window.location.assign(uri);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect the Android app.");
    } finally {
      setBusy(false);
    }
  }
  return <main className="content legal">
    <h1>Sign in to Budget HQ Pro for Android</h1>
    <p>Continue on this phone as <strong>{session.user.email}</strong>.</p>
    {error && <p role="alert">{error}</p>}
    {callback
      ? <p><a className="btn" href={callback}>Return to the Android app</a></p>
      : <button className="btn" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Continue in Android"}</button>}
    <p><button className="btn-secondary" onClick={() => void session.signOut()}>Use a different account</button></p>
  </main>;
}
