import nodemailer from "nodemailer";
import { z } from "zod";
import type { Database } from "../db.js";
import { id, nowIso } from "../crypto.js";
import { ApiError } from "../finance.js";

export function smtpConfigured() { return process.env.BUDGETCENTS_MAIL_ENABLED === "true" && !!process.env.SMTP_URL && !!process.env.SMTP_FROM; }

export async function sendSmtp(message: { id: string; to: string; subject: string; text: string }) {
  if (!smtpConfigured()) throw new ApiError(503, "Email is not connected.");
  const url = new URL(process.env.SMTP_URL!);
  if (!["smtp:", "smtps:"].includes(url.protocol) || !z.string().email().safeParse(message.to).success || !z.string().email().safeParse(process.env.SMTP_FROM).success) throw new ApiError(503, "The mail server or sender address is invalid.");
  const localTest = process.env.NODE_ENV === "test" && process.env.SMTP_ALLOW_INSECURE_LOCAL === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const transport = nodemailer.createTransport({
    host: url.hostname, port: Number(url.port || (url.protocol === "smtps:" ? 465 : 587)), secure: url.protocol === "smtps:", requireTLS: !localTest,
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    tls: { rejectUnauthorized: true }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  try {
    const result = await transport.sendMail({ from: process.env.SMTP_FROM, to: message.to, subject: message.subject, text: message.text, messageId: `<${message.id}@${process.env.SMTP_FROM!.split("@")[1]}>`, disableFileAccess: true, disableUrlAccess: true });
    if (!result.accepted.length || result.rejected.length) throw new ApiError(502, "The mail server did not accept the recipient.");
    return { status: "accepted", provenDelivered: false, note: "The mail server accepted the message. Inbox delivery is not yet proven." };
  } finally { transport.close(); }
}

export async function queueAccountMail(db: Database, userId: string, to: string, subject: string, text: string, createdAt = nowIso()) {
  const mailId = id();
  await db.query(`INSERT INTO outbox (id, user_id, to_email, subject, body, created_at, transport_status) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [mailId, userId, to, subject, text, createdAt, smtpConfigured() ? "queued" : "local"]);
  return mailId;
}

/** Claim before HTTP. An ambiguous failure stays attempted/failed and is never silently resent. */
export async function flushAccountMail(db: Database, max = 10) {
  if (!smtpConfigured()) return { accepted: 0, failed: 0 };
  if (process.env.NODE_ENV === "production" && !/^https:\/\//.test(process.env.BUDGETCENTS_PUBLIC_URL ?? "")) throw new ApiError(503, "Production email needs the public HTTPS app URL.");
  let accepted = 0; let failed = 0;
  for (let i = 0; i < max; i++) {
    const mail = await db.tx(async () => {
      const row = (await db.query(`SELECT * FROM outbox WHERE transport_status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`))[0];
      if (!row) return null;
      // A delayed reset/verification/invitation must not send an already-expired link.
      const ttl = String(row.subject).startsWith("Reset") ? 3600000 : String(row.subject).startsWith("Verify") ? 2 * 86400000 : 7 * 86400000;
      const expired = Date.now() - Date.parse(String(row.created_at)) >= ttl;
      await db.query(`UPDATE outbox SET transport_status = $1, attempted_at = $2 WHERE id = $3`, [expired ? "expired" : "attempted", nowIso(), row.id]);
      return { row, expired };
    });
    if (!mail) break;
    if (mail.expired) continue;
    const row = mail.row;
    try {
      await sendSmtp({ id: String(row.id), to: String(row.to_email), subject: String(row.subject), text: String(row.body) });
      await db.query(`UPDATE outbox SET transport_status = 'accepted', accepted_at = $1 WHERE id = $2`, [nowIso(), row.id]);
      accepted++;
    } catch {
      await db.query(`UPDATE outbox SET transport_status = 'failed' WHERE id = $1`, [row.id]); failed++;
    }
  }
  return { accepted, failed };
}
