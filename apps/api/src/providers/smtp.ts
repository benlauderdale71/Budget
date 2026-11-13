import nodemailer from "nodemailer";
import { z } from "zod";
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
