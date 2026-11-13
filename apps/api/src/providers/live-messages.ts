import type { Context, Hono } from "hono";
import { z } from "zod";
import { defaultAlertPreferences, isQuietHours, parseAlertPreferences } from "@budgetcents/domain";
import type { Database } from "../db.js";
import { id, nowIso } from "../crypto.js";
import { ApiError, type Actor } from "../finance.js";
import { sendSmtp, smtpConfigured } from "./smtp.js";
import { sendFcm, fcmConfigured } from "./fcm.js";

export async function sendOwnMessage(db: Database, userId: string, channel: "email" | "push", eventId: string) {
  const user = (await db.query(`SELECT email, email_verified_at, deleted_at FROM users WHERE id = $1`, [userId]))[0];
  const enrollment = (await db.query(`SELECT consented_at, opted_out_at FROM message_enrollments WHERE user_id = $1 AND channel = $2`, [userId, channel]))[0];
  if (!user || user.deleted_at || !enrollment?.consented_at || enrollment.opted_out_at) throw new ApiError(409, "This channel needs current consent. Nothing was sent.");
  if (channel === "email") {
    if (!user.email_verified_at) throw new ApiError(409, "Verify your account email before sending alert mail.");
    const url = process.env.BUDGETCENTS_PUBLIC_URL ?? "";
    if (!/^https:\/\//.test(url) && process.env.NODE_ENV !== "test") throw new ApiError(503, "Alert email needs the public HTTPS app address.");
    return sendSmtp({ id: eventId, to: String(user.email), subject: "BudgetCents notification", text: `You have a BudgetCents notification. Sign in to review it.\n${url.replace(/\/$/, "")}/alerts\nManage notification consent in Connections.` });
  }
  const devices = await db.query(`SELECT id, push_token FROM devices WHERE user_id = $1 AND push_token IS NOT NULL AND revoked_at IS NULL`, [userId]);
  const tokens = [...new Set(devices.map((d) => String(d.push_token)))];
  if (!tokens.length) throw new ApiError(409, "Enroll an Android phone for remote push first.");
  let accepted = 0;
  for (const token of tokens) {
    try { await sendFcm(token, eventId); accepted++; }
    catch (e) {
      if (e instanceof ApiError && e.status === 410) await db.query(`UPDATE devices SET push_token = NULL WHERE user_id = $1 AND push_token = $2`, [userId, token]);
    }
  }
  if (!accepted) throw new ApiError(502, "No enrolled phone notification was accepted. No delivery was claimed.");
  return { status: "accepted", provenDelivered: false, note: `Firebase accepted ${accepted} of ${tokens.length} phone notifications. Delivery is not proven.` };
}

export function mountLiveMessages(app: Hono, db: Database, actor: (c: Context) => Promise<Actor>) {
  app.post("/api/notifications/send-test", async (c) => {
    const me = await actor(c);
    const body = z.object({ channel: z.enum(["email", "push"]), opId: z.string().min(1).max(100) }).parse(await c.req.json());
    if (body.channel === "email" ? !smtpConfigured() : !fcmConfigured()) throw new ApiError(503, "This delivery provider is not connected.");
    const claimed = await db.tx(async () => {
      await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [me.id]);
      const previous = (await db.query(`SELECT * FROM remote_messages WHERE user_id = $1 AND op_id = $2`, [me.id, body.opId]))[0];
      if (previous) {
        if (previous.channel !== body.channel) throw new ApiError(409, "This send operation was already used for another channel.");
        return { duplicate: true, id: String(previous.id), status: String(previous.status), provenDelivered: !!previous.received_at };
      }
      const recent = await db.query(`SELECT id FROM remote_messages WHERE user_id = $1 AND created_at > $2`, [me.id, new Date(Date.now() - 60000).toISOString()]);
      if (recent.length) throw new ApiError(429, "Wait one minute before sending another real test.");
      const prefs = (await db.query(`SELECT alert_settings, time_zone FROM users WHERE id = $1`, [me.id]))[0];
      const parsed = parseAlertPreferences(JSON.parse(String(prefs.alert_settings || "{}")), String(prefs.time_zone));
      if (isQuietHours(new Date(), parsed.ok ? parsed.value : defaultAlertPreferences(String(prefs.time_zone)))) throw new ApiError(409, "Quiet hours are active. Nothing was sent.");
      const messageId = id();
      await db.query(`INSERT INTO remote_messages (id, user_id, op_id, channel, status, detail, created_at) VALUES ($1,$2,$3,$4,'attempted','Waiting for provider acceptance',$5)`, [messageId, me.id, body.opId, body.channel, nowIso()]);
      return { duplicate: false, id: messageId, status: "attempted", provenDelivered: false };
    });
    if (claimed.duplicate) return c.json({ ...claimed, note: "This operation was already recorded. It was not sent twice." });
    try {
      const result = await sendOwnMessage(db, me.id, body.channel, claimed.id);
      await db.query(`UPDATE remote_messages SET status = CASE WHEN received_at IS NULL THEN 'accepted' ELSE 'delivered' END, detail = $1 WHERE id = $2`, [result.note, claimed.id]);
      return c.json({ id: claimed.id, ...result });
    } catch (e) {
      await db.query(`UPDATE remote_messages SET status = CASE WHEN received_at IS NULL THEN 'failed' ELSE 'delivered' END, detail = 'Provider acceptance was not confirmed; no automatic retry' WHERE id = $1`, [claimed.id]);
      throw e instanceof ApiError ? e : new ApiError(502, "Sending failed. Check the provider configuration; no delivery was claimed.");
    }
  });
  app.get("/api/notifications/remote-history", async (c) => {
    const me = await actor(c);
    const rows = await db.query(`SELECT id, channel, status, detail, created_at, received_at FROM remote_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [me.id]);
    return c.json({ messages: rows.map((r) => ({ ...r, provenDelivered: !!r.received_at, deliveryEvidence: r.received_at ? "Android reported posting the notification. This does not prove it was read." : "No device or inbox receipt." })) });
  });
  app.post("/api/notifications/remote/:id/received", async (c) => {
    const me = await actor(c);
    const rows = await db.query(`UPDATE remote_messages SET received_at = COALESCE(received_at,$1), status = 'delivered' WHERE id = $2 AND user_id = $3 AND channel = 'push' AND status IN ('attempted','accepted','delivered') RETURNING id`, [nowIso(), c.req.param("id"), me.id]);
    if (!rows.length) throw new ApiError(404, "Notification not found.");
    return c.json({ recorded: true });
  });
}
