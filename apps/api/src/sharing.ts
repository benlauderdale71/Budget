import {
  allows,
  capabilityLines,
  effectiveMemberLimit,
  invitationDisclosure,
  isInviteRole,
  MIN_MEMBER_LIMIT,
  roleLabel,
  serverMemberLimit,
} from "@budgetcents/domain";
import { id, nowIso, randomToken, sha256 } from "./crypto.js";
import { type Database, num } from "./db.js";
import { ApiError, type Actor, audit, requireMember } from "./finance.js";

const WEEK_MS = 7 * 86_400_000;

function limitOrThrow(raw: string | undefined) {
  try {
    return serverMemberLimit(raw);
  } catch (error) {
    throw new ApiError(500, error instanceof Error ? error.message : "The sharing limit is misconfigured.");
  }
}

async function householdLimit(db: Database, householdId: string) {
  const rows = await db.query(`SELECT member_limit FROM households WHERE id = $1`, [householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  const configured = rows[0].member_limit == null ? null : num(rows[0].member_limit);
  const server = limitOrThrow(process.env.BUDGETCENTS_MEMBER_LIMIT);
  return { server, effective: effectiveMemberLimit(process.env.BUDGETCENTS_MEMBER_LIMIT, configured) };
}

async function memberCount(db: Database, householdId: string) {
  const rows = await db.query(
    `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND u.deleted_at IS NULL`,
    [householdId],
  );
  return num(rows[0]?.n);
}

function statusOf(row: Record<string, unknown>, now = nowIso()) {
  if (row.accepted_at) return "accepted" as const;
  if (row.revoked_at) return "revoked" as const;
  if (String(row.expires_at) <= now) return "expired" as const;
  return "pending" as const;
}

function invitationMessage(origin: string, token: string, householdName: string, role: string, summary: string) {
  return [
    `A BudgetCents invitation link was created for ${householdName}.`,
    `Role: ${roleLabel(role)}.`,
    summary,
    `${origin}/invite/${token}`,
    `budgetcents://invite?token=${token}`,
    "This copy is in the local outbox. It is not proof that email was delivered.",
  ].join("\n");
}

async function storeInvitation(db: Database, householdId: string, email: string, role: string, householdName: string, origin: string, actorId: string) {
  const token = randomToken();
  const disclosure = invitationDisclosure(householdName, role);
  const inviteId = id();
  const created = nowIso();
  await db.query(
    `INSERT INTO invitations (id, household_id, email, role, token_hash, expires_at, reveal_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [inviteId, householdId, email, role, sha256(token), new Date(Date.now() + WEEK_MS).toISOString(), disclosure.summary, created],
  );
  await db.query(
    `INSERT INTO outbox (id, user_id, to_email, subject, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id(), actorId, email, `BudgetCents invitation to ${householdName}`, invitationMessage(origin, token, householdName, role, disclosure.summary), created],
  );
  return { token, inviteId, summary: disclosure.summary };
}

export async function createInvitation(db: Database, me: Actor, householdId: string, emailRaw: string, role: string, origin: string) {
  const member = await requireMember(db, me.id, householdId);
  if (!allows(member.role, "invite")) throw new ApiError(403, "Your role cannot invite people.");
  if (!isInviteRole(role)) throw new ApiError(400, "Choose a role other than owner. Ownership is transferred separately.");
  const verified = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [me.id]);
  if (!verified[0]?.email_verified_at) throw new ApiError(403, "Verify your email before inviting someone.");
  const email = emailRaw.toLowerCase();
  const existing = await db.query(
    `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND lower(u.email) = $2 AND u.deleted_at IS NULL`,
    [householdId, email],
  );
  if (existing.length) throw new ApiError(409, "That person already belongs to this household. Change their role instead of creating another invitation.");
  const stored = await storeInvitation(db, member.householdId, email, role, member.name, origin, me.id);
  await audit(db, member.householdId, me.id, "invitation.create", `Created a ${roleLabel(role)} invitation`, "invitation", stored.inviteId);
  return {
    token: stored.token,
    summary: stored.summary,
    invitationId: stored.inviteId,
    delivery: "link" as const,
    note: "The link was created and a copy was stored in the local outbox. That is not email delivery.",
  };
}

export async function previewInvitation(db: Database, token: string, viewer: Actor | null) {
  const rows = await db.query(
    `SELECT i.*, h.name AS household_name FROM invitations i JOIN households h ON h.id = i.household_id WHERE i.token_hash = $1`,
    [sha256(token)],
  );
  const signedInEmail = viewer?.email ?? null;
  if (!rows.length) {
    return {
      status: "unavailable" as const,
      householdName: null,
      role: null,
      roleLabel: null,
      capabilities: [] as string[],
      disclosure: null,
      sharedRecords: null,
      privateRecords: null,
      invitedEmail: null,
      signedInEmail,
      emailVerified: null,
      matches: null,
      alreadyMember: false,
      memberRole: null,
      message: "This invitation link is not valid.",
    };
  }
  const row = rows[0];
  const role = String(row.role);
  const disclosure = invitationDisclosure(String(row.household_name), role);
  let emailVerified: boolean | null = null;
  let matches: boolean | null = null;
  let alreadyMember = false;
  let memberRole: string | null = null;
  if (viewer) {
    const user = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [viewer.id]);
    emailVerified = Boolean(user[0]?.email_verified_at);
    matches = viewer.email.toLowerCase() === String(row.email).toLowerCase();
    const membership = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`, [row.household_id, viewer.id]);
    alreadyMember = membership.length > 0;
    memberRole = membership[0] ? String(membership[0].role) : null;
  }
  const status = statusOf(row);
  const message = status === "pending"
    ? "Read this before you accept. Nothing is shared until you accept."
    : status === "expired"
      ? "This invitation has expired. Ask an owner or admin for a new link."
      : status === "revoked"
        ? "This invitation was revoked. Ask an owner or admin for a new link."
        : alreadyMember
          ? "You already belong to this household. Accepting again does not change your role."
          : "This invitation has already been used.";
  return {
    status,
    householdName: String(row.household_name),
    role,
    roleLabel: roleLabel(role),
    capabilities: capabilityLines(role),
    disclosure: String(row.reveal_summary || disclosure.summary),
    sharedRecords: disclosure.sharedRecords,
    privateRecords: disclosure.privateRecords,
    invitedEmail: String(row.email),
    signedInEmail,
    emailVerified,
    matches,
    alreadyMember,
    memberRole,
    message,
  };
}

export async function acceptInvitation(db: Database, me: Actor, token: string) {
  const hash = sha256(token);
  return db.tx(async () => {
    const peek = await db.query(`SELECT household_id FROM invitations WHERE token_hash = $1`, [hash]);
    if (!peek.length) throw new ApiError(400, "That invitation is unavailable.");
    const householdId = String(peek[0].household_id);
    const lockedHousehold = await db.query(`SELECT id, name, member_limit FROM households WHERE id = $1 FOR UPDATE`, [householdId]);
    if (!lockedHousehold.length) throw new ApiError(400, "That invitation is unavailable.");
    const invites = await db.query(`SELECT * FROM invitations WHERE token_hash = $1 AND household_id = $2 FOR UPDATE`, [hash, householdId]);
    if (!invites.length) throw new ApiError(400, "That invitation is unavailable.");
    const invite = invites[0];
    const membership = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2 FOR UPDATE`, [householdId, me.id]);
    const currentRole = membership[0] ? String(membership[0].role) : null;
    if (invite.accepted_at) {
      if (currentRole) {
        return { householdId, role: currentRole, revealed: String(invite.reveal_summary), alreadyMember: true, changed: false, note: "You already belong to this household. This invitation did not change your role." };
      }
      throw new ApiError(400, "This invitation has already been used.");
    }
    if (invite.revoked_at) throw new ApiError(400, "This invitation was revoked. Ask an owner or admin for a new link.");
    if (String(invite.expires_at) <= nowIso()) throw new ApiError(400, "This invitation has expired. Ask an owner or admin for a new link.");
    if (String(invite.email).toLowerCase() !== me.email.toLowerCase()) throw new ApiError(403, "This invitation was sent to a different email.");
    const user = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [me.id]);
    if (!user[0]?.email_verified_at) throw new ApiError(403, "Verify your email before accepting this invitation. It stays pending.");
    if (!isInviteRole(String(invite.role))) throw new ApiError(400, "This invitation cannot grant that role.");
    if (currentRole) {
      await db.query(`UPDATE invitations SET accepted_at = $1 WHERE id = $2`, [nowIso(), invite.id]);
      return { householdId, role: currentRole, revealed: String(invite.reveal_summary), alreadyMember: true, changed: false, note: "You already belong to this household. This invitation did not change your role." };
    }
    const configured = lockedHousehold[0].member_limit == null ? null : num(lockedHousehold[0].member_limit);
    limitOrThrow(process.env.BUDGETCENTS_MEMBER_LIMIT);
    const limit = effectiveMemberLimit(process.env.BUDGETCENTS_MEMBER_LIMIT, configured);
    const count = await memberCount(db, householdId);
    if (count >= limit) throw new ApiError(400, `This household is at its ${limit}-person sharing limit.`);
    const created = nowIso();
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)`, [householdId, me.id, invite.role, created]);
    await db.query(`UPDATE invitations SET accepted_at = $1 WHERE id = $2`, [created, invite.id]);
    await audit(db, householdId, me.id, "invitation.accept", `Accepted a ${roleLabel(String(invite.role))} invitation`, "invitation", String(invite.id));
    return { householdId, role: String(invite.role), revealed: String(invite.reveal_summary), alreadyMember: false, changed: true, note: "You joined this household." };
  });
}

export async function listAccess(db: Database, me: Actor, householdId: string) {
  const member = await requireMember(db, me.id, householdId);
  const people = await db.query(
    `SELECT u.id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND u.deleted_at IS NULL ORDER BY u.display_name`,
    [member.householdId],
  );
  const limit = await householdLimit(db, member.householdId);
  const invitations = allows(member.role, "invite")
    ? await db.query(
      `SELECT id, email, role, expires_at, created_at, accepted_at, revoked_at FROM invitations WHERE household_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC`,
      [member.householdId],
    )
    : [];
  return {
    members: people.map((person) => ({ id: person.id, displayName: person.display_name, role: person.role, roleLabel: roleLabel(String(person.role)), you: person.id === me.id })),
    invitations: invitations.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      roleLabel: roleLabel(String(invite.role)),
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
      status: statusOf(invite),
    })),
    memberCount: people.length,
    memberLimit: limit.effective,
    serverLimit: limit.server,
    you: { id: me.id, role: member.role },
  };
}

async function lockInvitation(db: Database, householdId: string, invitationId: string) {
  await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [householdId]);
  const rows = await db.query(`SELECT * FROM invitations WHERE id = $1 AND household_id = $2 FOR UPDATE`, [invitationId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  return rows[0];
}

export async function revokeInvitation(db: Database, me: Actor, householdId: string, invitationId: string) {
  const member = await requireMember(db, me.id, householdId);
  if (!allows(member.role, "invite")) throw new ApiError(403, "Your role cannot revoke an invitation.");
  return db.tx(async () => {
    const invite = await lockInvitation(db, member.householdId, invitationId);
    if (invite.accepted_at) throw new ApiError(409, "This invitation was already accepted. Remove the member to end their access.");
    if (!invite.revoked_at) {
      await db.query(`UPDATE invitations SET revoked_at = $1 WHERE id = $2`, [nowIso(), invite.id]);
      await audit(db, member.householdId, me.id, "invitation.revoke", "Revoked a pending invitation", "invitation", String(invite.id));
    }
    return { ok: true, status: "revoked" as const, note: "The link can no longer be used. Someone who already joined is still a member until you remove their access." };
  });
}

export async function reissueInvitation(db: Database, me: Actor, householdId: string, invitationId: string, origin: string) {
  const member = await requireMember(db, me.id, householdId);
  if (!allows(member.role, "invite")) throw new ApiError(403, "Your role cannot reissue an invitation.");
  const verified = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [me.id]);
  if (!verified[0]?.email_verified_at) throw new ApiError(403, "Verify your email before inviting someone.");
  return db.tx(async () => {
    const invite = await lockInvitation(db, member.householdId, invitationId);
    if (invite.accepted_at) throw new ApiError(409, "This invitation was already accepted. Change the member's role instead of reissuing the link.");
    if (!invite.revoked_at) await db.query(`UPDATE invitations SET revoked_at = $1 WHERE id = $2`, [nowIso(), invite.id]);
    const stored = await storeInvitation(db, member.householdId, String(invite.email), String(invite.role), member.name, origin, me.id);
    await audit(db, member.householdId, me.id, "invitation.reissue", `Reissued a ${roleLabel(String(invite.role))} invitation`, "invitation", stored.inviteId);
    return {
      token: stored.token,
      summary: stored.summary,
      invitationId: stored.inviteId,
      delivery: "link" as const,
      note: "The previous link no longer works. A new link was created and stored in the local outbox. That is not email delivery.",
    };
  });
}

export async function changeMemberRole(db: Database, me: Actor, householdId: string, userId: string, role: string) {
  const member = await requireMember(db, me.id, householdId);
  if (!allows(member.role, "invite")) throw new ApiError(403, "Your role cannot change membership.");
  if (!isInviteRole(role)) throw new ApiError(400, "Ownership is transferred separately. An admin cannot become the owner this way.");
  if (userId === me.id) throw new ApiError(403, "You cannot change your own role. Ask another owner, or transfer ownership.");
  return db.tx(async () => {
    await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [member.householdId]);
    const target = await db.query(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND m.user_id = $2 AND u.deleted_at IS NULL FOR UPDATE`,
      [member.householdId, userId],
    );
    if (!target.length) throw new ApiError(404, "Not found");
    const current = String(target[0].role);
    if (current === "owner" && member.role !== "owner") throw new ApiError(403, "Only an owner can change another owner's role.");
    if (current === "owner") {
      const owners = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1 AND role = 'owner'`, [member.householdId]);
      if (owners.length < 2) throw new ApiError(409, "Transfer ownership before changing the only owner's role.");
    }
    const caller = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2`, [member.householdId, me.id]);
    if (!caller.length || !allows(String(caller[0].role), "invite")) throw new ApiError(403, "Your role cannot change membership.");
    if (current === role) return { ok: true, role, changed: false };
    await db.query(`UPDATE memberships SET role = $1 WHERE household_id = $2 AND user_id = $3`, [role, member.householdId, userId]);
    await audit(db, member.householdId, me.id, "membership.role", `Changed a member to ${roleLabel(role)}`, "membership", userId);
    return { ok: true, role, changed: true };
  });
}

export async function removeMember(db: Database, me: Actor, householdId: string, userId: string) {
  const member = await requireMember(db, me.id, householdId);
  if (!allows(member.role, "invite")) throw new ApiError(403, "Your role cannot remove a member.");
  if (userId === me.id) throw new ApiError(400, "Use leave to remove your own access.");
  return db.tx(async () => {
    await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [member.householdId]);
    const target = await db.query(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND m.user_id = $2 AND u.deleted_at IS NULL FOR UPDATE`,
      [member.householdId, userId],
    );
    if (!target.length) throw new ApiError(404, "Not found");
    if (String(target[0].role) === "owner") {
      if (member.role !== "owner") throw new ApiError(403, "Only an owner can remove another owner.");
      const owners = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1 AND role = 'owner'`, [member.householdId]);
      if (owners.length < 2) throw new ApiError(409, "Transfer ownership before removing the only owner.");
    }
    await db.query(`DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`, [member.householdId, userId]);
    await audit(db, member.householdId, me.id, "membership.remove", "Removed a member's access. Shared records were kept.", "membership", userId);
    return { ok: true, note: "Their access has ended. Shared records and history stay. Their other households and personal account stay." };
  });
}

export async function leaveHousehold(db: Database, me: Actor, householdId: string) {
  const member = await requireMember(db, me.id, householdId);
  return db.tx(async () => {
    await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [member.householdId]);
    const mine = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2 FOR UPDATE`, [member.householdId, me.id]);
    if (!mine.length) throw new ApiError(404, "Not found");
    if (String(mine[0].role) === "owner") {
      const owners = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1 AND role = 'owner' AND user_id <> $2`, [member.householdId, me.id]);
      if (!owners.length) throw new ApiError(409, "Transfer ownership before leaving. You are the only owner.");
    }
    await db.query(`DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`, [member.householdId, me.id]);
    await audit(db, member.householdId, me.id, "membership.leave", "A member left. Shared records were kept.", "membership", me.id);
    return { ok: true, note: "You left this household. Shared records stay. Your other households and personal account stay." };
  });
}

export async function transferOwnership(db: Database, me: Actor, householdId: string, userId: string) {
  const member = await requireMember(db, me.id, householdId);
  if (!allows(member.role, "transfer")) throw new ApiError(403, "Only an owner can transfer ownership.");
  if (userId === me.id) throw new ApiError(400, "Choose another member.");
  return db.tx(async () => {
    await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [member.householdId]);
    const caller = await db.query(`SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2 FOR UPDATE`, [member.householdId, me.id]);
    if (!caller.length || String(caller[0].role) !== "owner") throw new ApiError(403, "Only an owner can transfer ownership.");
    const target = await db.query(
      `SELECT role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND m.user_id = $2 AND u.deleted_at IS NULL FOR UPDATE`,
      [member.householdId, userId],
    );
    if (!target.length) throw new ApiError(404, "Not found");
    await db.query(`UPDATE memberships SET role = 'owner' WHERE household_id = $1 AND user_id = $2`, [member.householdId, userId]);
    await db.query(`UPDATE memberships SET role = 'admin' WHERE household_id = $1 AND user_id = $2`, [member.householdId, me.id]);
    await audit(db, member.householdId, me.id, "membership.transfer", "Transferred ownership", "membership", userId);
    return { ok: true, yourRole: "admin" as const, ownerId: userId, note: "You are now an admin. The other person is the owner, so you can leave." };
  });
}

export async function setMemberLimit(db: Database, me: Actor, householdId: string, memberLimit: number) {
  const member = await requireMember(db, me.id, householdId);
  if (member.role !== "owner") throw new ApiError(403, "Only an owner can change the sharing limit.");
  const server = limitOrThrow(process.env.BUDGETCENTS_MEMBER_LIMIT);
  if (!Number.isInteger(memberLimit) || memberLimit < MIN_MEMBER_LIMIT || memberLimit > server) {
    throw new ApiError(400, `The sharing limit must be a whole number from ${MIN_MEMBER_LIMIT} through ${server}.`);
  }
  return db.tx(async () => {
    await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [member.householdId]);
    const count = await memberCount(db, member.householdId);
    if (memberLimit < count) throw new ApiError(409, `The household already has ${count} members.`);
    await db.query(`UPDATE households SET member_limit = $1 WHERE id = $2`, [memberLimit, member.householdId]);
    await audit(db, member.householdId, me.id, "membership.limit", `Set the sharing limit to ${memberLimit}`, "household", member.householdId);
    return { memberLimit, serverLimit: server, memberCount: count };
  });
}

function hiddenRecord(viewerId: string, visibility: unknown, ownerUserId: unknown) {
  return String(visibility) === "private" && String(ownerUserId ?? "") !== viewerId;
}

export async function visibleAudit(db: Database, viewerId: string, householdId: string) {
  await requireMember(db, viewerId, householdId);
  const events = await db.query(
    `SELECT id, action, entity, entity_id, summary, created_at, user_id, visibility, owner_user_id FROM audit_events WHERE household_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [householdId],
  );
  const accounts = await db.query(`SELECT id, visibility, owner_user_id FROM accounts WHERE household_id = $1`, [householdId]);
  const transactions = await db.query(
    `SELECT t.id, a.visibility, a.owner_user_id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.household_id = $1`,
    [householdId],
  );
  const accountById = new Map(accounts.map((row) => [String(row.id), row]));
  const transactionById = new Map(transactions.map((row) => [String(row.id), row]));
  return events.map((event) => {
    const storedPrivate = hiddenRecord(viewerId, event.visibility, event.owner_user_id);
    const live = event.entity === "account"
      ? accountById.get(String(event.entity_id ?? ""))
      : event.entity === "transaction"
        ? transactionById.get(String(event.entity_id ?? ""))
        : undefined;
    const livePrivate = live ? hiddenRecord(viewerId, live.visibility, live.owner_user_id) : false;
    if (storedPrivate || livePrivate) {
      return { id: event.id, action: "private.change", entity: null, entity_id: null, summary: "A private record changed.", created_at: event.created_at, user_id: null };
    }
    return { id: event.id, action: event.action, entity: event.entity, entity_id: event.entity_id, summary: event.summary, created_at: event.created_at, user_id: event.user_id };
  });
}
