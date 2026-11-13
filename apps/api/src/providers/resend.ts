import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../finance.js";

export function resendConfigured() {
  return process.env.BUDGETCENTS_MAIL_ENABLED === "true" && !!process.env.RESEND_API_KEY?.trim() && z.string().email().safeParse(process.env.RESEND_FROM).success;
}

export async function sendResend(message: { id: string; to: string; subject: string; text: string }) {
  if (!resendConfigured()) throw new ApiError(503, "Email is not connected.");
  if (!z.string().email().safeParse(message.to).success) throw new ApiError(503, "The mail recipient address is invalid.");
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `budgetcents/${createHash("sha256").update(message.id).digest("hex")}`,
      },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Provider refused the request");
    const result = z.object({ id: z.string().min(1) }).safeParse(await response.json());
    if (!result.success) throw new Error("Missing provider acceptance");
    return { status: "accepted", provenDelivered: false, note: "The mail provider accepted the message. Inbox delivery is not yet proven." };
  } catch {
    // Provider errors may include recipients or credentials. Keep them out of API responses and logs.
    throw new ApiError(502, "The mail provider did not confirm acceptance. Check the email configuration; no delivery was claimed.");
  }
}
