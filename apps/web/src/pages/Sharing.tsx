import { useState } from "react";
import { INVITE_ROLES, roleLabel } from "@budgetcents/domain/access";
import { api } from "../api.js";
import { scoped, useSession } from "../session.js";
import { Field, Loading, Notice, Page, useFormError, useLoad } from "../ui.js";

interface Member {
  id: string;
  displayName: string;
  role: string;
  roleLabel: string;
  you: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  roleLabel: string;
  expiresAt: string;
  status: "pending" | "expired" | "revoked" | "accepted";
}

interface AccessList {
  members: Member[];
  invitations: Invitation[];
  memberCount: number;
  memberLimit: number;
  serverLimit: number;
  you: { id: string; role: string };
}

const STATUS_LABEL: Record<Invitation["status"], string> = {
  pending: "Pending",
  expired: "Expired",
  revoked: "Revoked",
  accepted: "Accepted",
};

export function Household() {
  const session = useSession();
  const state = useLoad(() => api<AccessList>(scoped(session.householdId, "/members")), [session.householdId, session.tick]);
  const form = useFormError();
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  if (!state.data) return <Loading />;
  const access = state.data;
  const canInvite = access.you.role === "owner" || access.you.role === "admin";
  const canTransfer = access.you.role === "owner";

  async function run(key: string, action: () => Promise<void>) {
    setPending(key);
    setError("");
    setNote("");
    try {
      await action();
      session.bump();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That change was not saved.");
    } finally {
      setPending("");
    }
  }

  return (
    <Page title="Sharing" lede={`This household has ${access.memberCount} of ${access.memberLimit} members. Pending invitations do not count. Revoking a link stops someone from joining. It does not remove a person who already accepted.`}>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {note ? <Notice kind="ok">{note}</Notice> : null}
      <ul>
        {access.members.map((member) => (
          <li key={member.id}>
            <span>{member.displayName} · {member.roleLabel}{member.you ? " · you" : ""}</span>
            {canInvite && !member.you && member.role !== "owner" ? (
              <span className="row">
                <label className="sr" htmlFor={`role-${member.id}`}>Role for {member.displayName}</label>
                <select id={`role-${member.id}`} defaultValue="" key={`${member.id}-${member.role}`} onChange={(event) => {
                  const role = event.target.value;
                  if (!role) return;
                  void run(`role-${member.id}`, async () => {
                    await api(scoped(session.householdId, `/members/${member.id}`), { method: "PATCH", body: JSON.stringify({ role }) });
                    setNote(`${member.displayName} is now ${roleLabel(role)}.`);
                  });
                }}>
                  <option value="">{member.roleLabel}</option>
                  {INVITE_ROLES.filter((role) => role !== member.role).map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                </select>
                <button className="btn-quiet" type="button" disabled={pending === `remove-${member.id}`} onClick={() => void run(`remove-${member.id}`, async () => {
                  await api(scoped(session.householdId, `/members/${member.id}`), { method: "DELETE" });
                  setNote(`Removed ${member.displayName}'s access. Shared records stay.`);
                })}>Remove access</button>
                {canTransfer && member.role !== "owner" ? <button className="btn-quiet" type="button" disabled={pending === `transfer-${member.id}`} onClick={() => void run(`transfer-${member.id}`, async () => {
                  await api(scoped(session.householdId, "/transfer"), { method: "POST", body: JSON.stringify({ userId: member.id }) });
                  setNote(`${member.displayName} is now the owner. You are an admin.`);
                  await session.refresh();
                })}>Transfer ownership</button> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {canInvite ? (
        <>
          <h2>Invitations</h2>
          <p className="muted">Creating a link stores a copy in the local outbox. That is not proof an email was delivered.</p>
          {access.invitations.length === 0 ? <p className="muted">No invitations are waiting.</p> : (
            <ul>
              {access.invitations.map((invite) => (
                <li key={invite.id}>
                  <span>{invite.email} · {invite.roleLabel} · {STATUS_LABEL[invite.status]}</span>
                  <span className="row">
                    {invite.status === "pending" ? <button className="btn-quiet" type="button" disabled={pending === `revoke-${invite.id}`} onClick={() => void run(`revoke-${invite.id}`, async () => {
                      await api(scoped(session.householdId, `/invitations/${invite.id}/revoke`), { method: "POST" });
                      setLink("");
                      setNote("The link was revoked. A person who already joined is still a member.");
                    })}>Revoke link</button> : null}
                    {invite.status !== "accepted" ? <button className="btn-quiet" type="button" disabled={pending === `reissue-${invite.id}`} onClick={() => void run(`reissue-${invite.id}`, async () => {
                      const result = await api<{ token: string; note: string }>(scoped(session.householdId, `/invitations/${invite.id}/reissue`), { method: "POST" });
                      setLink(`${window.location.origin}/invite/${result.token}`);
                      setNote(result.note);
                    })}>New link</button> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form className="card" onSubmit={(event) => form.run(event, async () => {
            const data = new FormData(event.currentTarget);
            const result = await api<{ token: string; summary: string; note: string }>(scoped(session.householdId, "/invitations"), { method: "POST", body: JSON.stringify({ email: data.get("email"), role: data.get("role") }) });
            setLink(`${window.location.origin}/invite/${result.token}`);
            setNote(`${result.note} ${result.summary}`);
            session.bump();
          })}>
            <Field label="Email"><input name="email" type="email" required autoComplete="off" /></Field>
            <Field label="Role">
              <select name="role" defaultValue="editor">
                {INVITE_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
              </select>
            </Field>
            {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
            <button className="btn" type="submit">Create invitation link</button>
          </form>
          {link ? <Field label="Invitation link"><input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></Field> : null}
          {canTransfer ? (
            <form className="card" onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const memberLimit = Number(data.get("memberLimit"));
              void run("limit", async () => {
                const result = await api<{ memberLimit: number }>(scoped(session.householdId, "/sharing"), { method: "PATCH", body: JSON.stringify({ memberLimit }) });
                setNote(`The sharing limit is ${result.memberLimit}. The server allows up to ${access.serverLimit}.`);
              });
            }}>
              <h2>Sharing limit</h2>
              <Field label="Member limit"><input name="memberLimit" type="number" min={6} max={access.serverLimit} defaultValue={access.memberLimit} required /></Field>
              <button className="btn-secondary" type="submit" disabled={pending === "limit"}>Save limit</button>
            </form>
          ) : null}
        </>
      ) : <p className="muted">An owner or admin invites people and changes roles.</p>}
      <form className="card" onSubmit={(event) => {
        event.preventDefault();
        void run("leave", async () => {
          await api(scoped(session.householdId, "/leave"), { method: "POST" });
          await session.refresh();
        });
      }}>
        <h2>Leave</h2>
        <p className="muted">Leaving removes your access. Shared records stay. Your other households and personal account stay. The only owner has to transfer ownership first.</p>
        <button className="btn-secondary" type="submit" disabled={pending === "leave"}>{pending === "leave" ? "Leaving…" : "Leave this household"}</button>
      </form>
      {canInvite ? <SpaceForm /> : null}
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
