import { allows, incomeRows, spendingRows, type Transaction } from "@budgetcents/domain";
import { nowIso } from "./crypto.js";
import { type Database, num, str } from "./db.js";
import { ApiError, audit, canSeeAccount, loadSpace, requireMember, type Actor } from "./finance.js";

export type OwnershipView = "all" | "mine" | "yours" | "ours";

export async function collaborationPeople(db: Database, actorId: string, householdId: string) {
  await requireMember(db, actorId, householdId);
  return db.query<{ id: string; displayName: string; role: string }>(
    `SELECT u.id, u.display_name AS "displayName", m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.household_id = $1 AND u.deleted_at IS NULL ORDER BY u.display_name, u.id`, [householdId],
  );
}

export async function ownershipFilter(db: Database, actorId: string, householdId: string, raw = "all", personId?: string) {
  if (!["all", "mine", "yours", "ours"].includes(raw)) throw new ApiError(400, "Choose All, Mine, Yours, or Ours.");
  if (raw === "yours") {
    const people = await collaborationPeople(db, actorId, householdId);
    if (!personId || personId === actorId || !people.some((person) => person.id === personId)) {
      throw new ApiError(400, "Choose another current household member for Yours.");
    }
  }
  return (txn: Transaction) => raw === "all" || (raw === "ours" ? !txn.ownerUserId : txn.ownerUserId === (raw === "mine" ? actorId : personId));
}

export async function ownershipSummary(db: Database, me: Actor, householdId: string, view: string, personId?: string, spaceId?: string, asOf?: string) {
  const loaded = await loadSpace(db, me, householdId, spaceId, asOf);
  const matches = await ownershipFilter(db, me.id, householdId, view, personId);
  const transactions = loaded.input.transactions.filter(matches);
  const input = { ...loaded.input, transactions };
  const from = loaded.budget.periodStart;
  const to = loaded.input.asOf < loaded.budget.periodEnd ? loaded.input.asOf : loaded.budget.periodEnd;
  const current = transactions.filter((txn) => txn.date >= from && txn.date <= to && !txn.deleted);
  return {
    view, personId: view === "yours" ? personId : null, from, to,
    incomeMinor: incomeRows(input, from, to).reduce((sum, row) => sum + row.amountMinor, 0),
    spendingMinor: spendingRows(input, from, to, () => "spending").reduce((sum, row) => sum + row.amountMinor, 0),
    reviewCount: current.filter((txn) => txn.reviewStatus === "needs_review").length,
    transactionCount: current.length,
    note: "Ownership labels filter activity. They do not grant access or divide the shared plan's cash and assignments.",
  };
}

async function accessibleTransaction(db: Database, userId: string, householdId: string, transactionId: string) {
  const rows = await db.query(`SELECT * FROM transactions WHERE id = $1 AND household_id = $2 AND deleted = 0 FOR UPDATE`, [transactionId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  const txn = rows[0];
  const spaces = await db.query(`SELECT kind, owner_user_id FROM spaces WHERE id = $1 AND household_id = $2`, [txn.space_id, householdId]);
  if (!spaces.length || (spaces[0].kind === "personal" && spaces[0].owner_user_id && spaces[0].owner_user_id !== userId)) throw new ApiError(404, "Not found");
  const accounts = await db.query(`SELECT id, visibility, owner_user_id FROM accounts WHERE household_id = $1 AND (id = $2 OR id = $3)`, [householdId, txn.account_id, txn.counter_account_id ?? null]);
  if (!accounts.some((account) => account.id === txn.account_id) || (txn.counter_account_id && !accounts.some((account) => account.id === txn.counter_account_id)) || accounts.some((account) => !canSeeAccount(userId, { visibility: String(account.visibility), owner_user_id: str(account.owner_user_id) ?? null }))) throw new ApiError(404, "Not found");
  return txn;
}

export async function updateCollaboration(db: Database, me: Actor, householdId: string, transactionId: string, version: number,
  change: { kind: "owner"; userId: string | null } | { kind: "assignment"; userId: string | null } | { kind: "review"; status: "needs_review" | "reviewed" }) {
  return db.tx(async () => {
    await db.query(`SELECT id FROM households WHERE id = $1 FOR UPDATE`, [householdId]);
    const member = await requireMember(db, me.id, householdId);
    if (!allows(member.role, change.kind === "review" ? "review" : "finance")) throw new ApiError(403, "Your current role cannot make that change.");
    const txn = await accessibleTransaction(db, me.id, householdId, transactionId);
    if (num(txn.version, 1) !== version) throw new ApiError(409, "Someone else changed this transaction. Reload it and try again.");
    let personLabel = "";
    if (change.kind !== "review" && change.userId) {
      const people = await collaborationPeople(db, me.id, householdId);
      const person = people.find((item) => item.id === change.userId);
      if (!person || (change.kind === "assignment" && !allows(person.role, "review"))) throw new ApiError(400, "Choose a current member who can perform this task.");
      personLabel = `${person.displayName} (${person.id})`;
      // Ownership and assignment never grant access to a private account or personal space.
      await accessibleTransaction(db, change.userId, householdId, transactionId);
    }
    const now = nowIso();
    if (change.kind === "owner") {
      await db.query(`UPDATE transactions SET owner_user_id = $1, version = version + 1, updated_at = $2 WHERE id = $3 AND household_id = $4`, [change.userId, now, transactionId, householdId]);
    } else if (change.kind === "assignment") {
      await db.query(`UPDATE transactions SET reviewer_user_id = $1, review_assigned_by = $2, review_assigned_at = $3,
        review_resolved_by = NULL, review_resolved_at = NULL, review_status = 'needs_review', version = version + 1, updated_at = $3 WHERE id = $4 AND household_id = $5`,
      [change.userId, me.id, now, transactionId, householdId]);
    } else {
      if (txn.reviewer_user_id && txn.reviewer_user_id !== me.id && !allows(member.role, "finance")) throw new ApiError(403, "This transaction is assigned to another reviewer.");
      await db.query(`UPDATE transactions SET review_status = $1, review_resolved_by = $2, review_resolved_at = $3,
        version = version + 1, updated_at = $4 WHERE id = $5 AND household_id = $6`,
      [change.status, change.status === "reviewed" ? me.id : null, change.status === "reviewed" ? now : null, now, transactionId, householdId]);
    }
    const action = change.kind === "owner" ? "transaction.ownership" : change.kind === "assignment" ? "transaction.review_assignment" : "transaction.review";
    const summary = change.kind === "owner" ? (change.userId ? `Labeled a transaction for ${personLabel}` : "Labeled a transaction Ours")
      : change.kind === "assignment" ? (change.userId ? `Assigned a transaction for review to ${personLabel}` : `Removed the review assignment from ${str(txn.reviewer_user_id) ?? "unassigned"}`)
      : change.status === "reviewed" ? "Resolved a transaction review" : "Reopened a transaction review";
    await audit(db, householdId, me.id, action, summary, "transaction", transactionId);
    return { ok: true, version: version + 1, note: "Saved. The amount, categories, balances, and shared plan did not change." };
  });
}

/** Keep resolution history consistent when an older client uses financial edit or bulk review. */
export async function recordReviewResolution(db: Database, householdId: string, transactionId: string, actorId: string, status: "needs_review" | "reviewed") {
  await db.query(`UPDATE transactions SET review_resolved_by = $1, review_resolved_at = $2 WHERE id = $3 AND household_id = $4`,
    [status === "reviewed" ? actorId : null, status === "reviewed" ? nowIso() : null, transactionId, householdId]);
  await audit(db, householdId, actorId, "transaction.review", status === "reviewed" ? "Resolved a transaction review" : "Reopened a transaction review", "transaction", transactionId);
}

/** Called under the membership household lock; history stays in the audit log. */
export async function releaseReviewer(db: Database, householdId: string, userId: string, actorId: string) {
  const changed = await db.query(`UPDATE transactions SET reviewer_user_id = NULL, review_assigned_by = NULL, review_assigned_at = NULL,
    version = version + 1, updated_at = $1 WHERE household_id = $2 AND reviewer_user_id = $3 AND review_status = 'needs_review' AND deleted = 0 RETURNING id`, [nowIso(), householdId, userId]);
  for (const row of changed) await audit(db, householdId, actorId, "transaction.review_assignment", `Released the review assignment for ${userId} after their access changed`, "transaction", String(row.id));
}
