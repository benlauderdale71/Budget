import type { Database } from "../db.js";
import { id, nowIso } from "../crypto.js";
import { ApiError } from "../finance.js";
import { resendConfigured, sendResend } from "./resend.js";
import { smtpConfigured, sendSmtp } from "./smtp.js";

// An explicit Resend key selects HTTPS. Never fall back to SMTP after an uncertain send.
export function mailConfigured() {
  return process.env.RESEND_API_KEY?.trim() ? resendConfigured() : smtpConfigured();
}

export async function sendMail(message: { id: string; to: string; subject: string; text: string }) {
  if (!mailConfigured()) throw new ApiError(503, "Email is not connected.");
  return process.env.RESEND_API_KEY?.trim() ? sendResend(message) : sendSmtp(message);
}

export async function queueAccountMail(db: Database, userId: string, to: string, subject: string, text: string, createdAt = nowIso()) {
  const mailId = id();
  await db.query(`INSERT INTO outbox (id, user_id, to_email, subject, body, created_at, transport_status) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [mailId, userId, to, subject, text, createdAt, mailConfigured() ? "queued" : "local"]);
  return mailId;
}

/** Claim before sending. An ambiguous failure is never silently resent. */
export async function flushAccountMail(db: Database, max = 10) {
  if (!mailConfigured()) return { accepted: 0, failed: 0 };
  if (process.env.NODE_ENV === "production" && !/^https:\/\//.test(process.env.BUDGETCENTS_PUBLIC_URL ?? "")) throw new ApiError(503, "Production email needs the public HTTPS app URL.");
  let accepted = 0; let failed = 0;
  for (let i = 0; i < max; i++) {
    const mail = await db.tx(async () => {
      const row = (await db.query(`SELECT * FROM outbox WHERE transport_status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`))[0];
      if (!row) return null;
      const ttl = String(row.subject).startsWith("Reset") ? 3600000 : String(row.subject).startsWith("Verify") ? 2 * 86400000 : 7 * 86400000;
      const expired = Date.now() - Date.parse(String(row.created_at)) >= ttl;
      await db.query(`UPDATE outbox SET transport_status = $1, attempted_at = $2 WHERE id = $3`, [expired ? "expired" : "attempted", nowIso(), row.id]);
      return { row, expired };
    });
    if (!mail) break;
    if (mail.expired) continue;
    const row = mail.row;
    try {
      await sendMail({ id: String(row.id), to: String(row.to_email), subject: String(row.subject), text: String(row.body) });
      await db.query(`UPDATE outbox SET transport_status = 'accepted', accepted_at = $1 WHERE id = $2`, [nowIso(), row.id]);
      accepted++;
    } catch {
      await db.query(`UPDATE outbox SET transport_status = 'failed' WHERE id = $1`, [row.id]); failed++;
    }
  }
  return { accepted, failed };
}
