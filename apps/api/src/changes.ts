import { sha256 } from "./crypto.js";
import type { Database } from "./db.js";
import { requireMember } from "./finance.js";

/** A snapshot, not a timestamp cursor: late commits and deletions cannot be skipped.
 * No record content or identifiers leave this endpoint. Read-only and private-space
 * permissions still apply to every subsequent data request.
 */
export async function collaborationRevision(db: Database, userId: string, householdId: string) {
  const member = await requireMember(db, userId, householdId);
  const sources = [
    ["spaces", "SELECT * FROM visible_spaces"],
    ["accounts", "SELECT * FROM visible_accounts"],
    ["transactions", "SELECT id, version, updated_at, deleted, reconciled, locked FROM visible_transactions"],
    ["comments", "SELECT c.* FROM comments c JOIN visible_transactions t ON t.id = c.transaction_id"],
    ["attachments", "SELECT a.id, a.transaction_id FROM attachments a JOIN visible_transactions t ON t.id = a.transaction_id"],
    ["members", "SELECT m.user_id, m.role, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1"],
    // Audited operations on other shared screens also invalidate their readers.
    // Private event content is never included in another member's snapshot.
    ["audit", "SELECT e.id FROM audit_events e WHERE e.household_id = $1 AND (e.visibility <> 'private' OR e.owner_user_id = $2) AND (e.entity IS DISTINCT FROM 'account' OR e.entity_id IN (SELECT id FROM visible_accounts)) AND (e.entity IS DISTINCT FROM 'transaction' OR e.entity_id IN (SELECT id FROM visible_transactions))"],
    ["invitations", "SELECT i.id, i.role, i.expires_at, i.accepted_at, i.revoked_at FROM invitations i WHERE i.household_id = $1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.household_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'admin'))"],
    ...["buckets", "assignments", "plan_lines", "goals", "schedules", "income_sources", "fill_templates"].map((table) =>
      [table, `SELECT r.* FROM ${table} r JOIN visible_spaces s ON s.id = r.space_id WHERE r.household_id = $1`]),
    ["bucket_revisions", "SELECT r.* FROM bucket_revisions r JOIN buckets b ON b.id = r.bucket_id JOIN visible_spaces s ON s.id = b.space_id WHERE r.household_id = $1"],
  ];
  // One statement gives a consistent database snapshot. Aggregate in the database
  // so polling transfers fixed-size digests rather than entire ledgers to Node.
  const digests = await db.query(`WITH visible_spaces AS (
    SELECT * FROM spaces WHERE household_id = $1 AND (kind <> 'personal' OR owner_user_id IS NULL OR owner_user_id = $2)
  ), visible_accounts AS (
    SELECT a.* FROM accounts a JOIN visible_spaces s ON s.id = a.space_id
    WHERE a.household_id = $1 AND (a.visibility <> 'private' OR a.owner_user_id = $2)
  ), visible_transactions AS (
    SELECT t.* FROM transactions t JOIN visible_spaces s ON s.id = t.space_id
    WHERE t.household_id = $1 AND (t.account_id IN (SELECT id FROM visible_accounts) OR t.counter_account_id IN (SELECT id FROM visible_accounts))
  ) ${sources.map(([name, query]) => `SELECT '${name}' AS source, md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text, '[]')) AS digest FROM (${query}) r`).join(" UNION ALL ")} ORDER BY source`, [householdId, userId]);
  return { revision: sha256(JSON.stringify([member, digests])) };
}
