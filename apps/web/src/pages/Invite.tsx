import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { capabilityLines, roleLabel } from "@budgetcents/domain/access";
import { api } from "../api.js";
import { clearReturnPath, rememberReturnPath } from "../return-path.js";
import { useSession } from "../session.js";
import { Notice } from "../ui.js";

interface Preview {
  status: "pending" | "expired" | "revoked" | "accepted" | "unavailable";
  householdName: string | null;
  role: string | null;
  roleLabel: string | null;
  capabilities: string[];
  disclosure: string | null;
  sharedRecords: string | null;
  privateRecords: string | null;
  invitedEmail: string | null;
  signedInEmail: string | null;
  emailVerified: boolean | null;
  matches: boolean | null;
  alreadyMember: boolean;
  memberRole: string | null;
  message: string;
}

export function Invite() {
  const { token = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const destination = `/invite/${token}`;

  useEffect(() => {
    rememberReturnPath(destination);
  }, [destination]);

  useEffect(() => {
    if (!session.ready || !token) return;
    let cancel = false;
    setPreview(null);
    api<Preview>(`/api/invitations/${encodeURIComponent(token)}`)
      .then((data) => { if (!cancel) setPreview(data); })
      .catch((caught: unknown) => { if (!cancel) setError(caught instanceof Error ? caught.message : "The invitation could not be opened."); });
    return () => { cancel = true; };
  }, [session.ready, session.user?.id, token]);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function accept() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ householdId: string; role: string; note?: string }>(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" });
      clearReturnPath();
      await session.refresh(result.householdId);
      setStatus(result.note ?? `You are in this household as ${roleLabel(result.role)}.`);
      navigate("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invitation was not accepted.");
      setBusy(false);
    }
  }

  if (!session.ready) return <p className="state">Opening BudgetCents…</p>;
  const next = `/login?next=${encodeURIComponent(destination)}`;
  const lines = preview?.capabilities?.length ? preview.capabilities : preview?.role ? capabilityLines(preview.role) : [];

  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Invitation</h1>
      {!preview && !error ? <p className="state">Reading the invitation…</p> : null}
      {error ? <div ref={alertRef} tabIndex={-1}><Notice kind="bad">{error}</Notice></div> : null}
      {status ? <Notice kind="ok">{status}</Notice> : null}
      {preview ? (
        <section className="card">
          <p>{preview.message}</p>
          {preview.householdName ? <p><strong>{preview.householdName}</strong>{preview.roleLabel ? ` · ${preview.roleLabel}` : ""}</p> : null}
          {preview.disclosure ? <p>{preview.disclosure}</p> : null}
          {preview.sharedRecords ? <p>{preview.sharedRecords}</p> : null}
          {preview.privateRecords ? <p>{preview.privateRecords}</p> : null}
          {lines.length ? <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul> : null}
          {preview.invitedEmail ? <p>This invitation is for <strong>{preview.invitedEmail}</strong>.</p> : null}
          {session.user && preview.matches === false ? (
            <div>
              <p>You are signed in as {session.user.email}. That is not the invited email.</p>
              <button className="btn-secondary" type="button" onClick={() => { rememberReturnPath(destination); void session.signOut().then(() => navigate(next)); }}>Sign out and use the invited email</button>
            </div>
          ) : null}
          {session.user && preview.matches && preview.emailVerified === false ? (
            <p>Verify {session.user.email} before accepting. The invitation stays pending. Open <Link to="/dev/mail">Development mail</Link> or <Link to="/verify">enter the verification token</Link>.</p>
          ) : null}
          {preview.status === "pending" && session.user && preview.matches && preview.emailVerified ? (
            <button className="btn" type="button" disabled={busy} onClick={() => void accept()}>{busy ? "Accepting…" : preview.alreadyMember ? "Open household" : "Accept invitation"}</button>
          ) : null}
          {preview.status === "accepted" && preview.alreadyMember ? (
            <button className="btn" type="button" disabled={busy} onClick={() => void accept()}>{busy ? "Opening…" : "Open household"}</button>
          ) : null}
          {!session.user && preview.status !== "unavailable" ? (
            <p><Link to={next}>Sign in or create an account</Link> to respond. Accepting is a separate step after you return here.</p>
          ) : null}
          {preview.status === "unavailable" ? null : <p className="muted">Balances, transactions, and other members are not shown on this page.</p>}
        </section>
      ) : null}
      <p className="muted"><Link to="/login">Sign in</Link> · <Link to="/dev/mail">Development mail</Link></p>
    </main>
  );
}
