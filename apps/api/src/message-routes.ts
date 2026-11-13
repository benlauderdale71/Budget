import { classifyTestDelivery, defaultAlertPreferences, isQuietHours, parseAlertPreferences } from "@budgetcents/domain";
import { Hono } from "hono";
import { z } from "zod";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num } from "./db.js";
import { ApiError, type Actor } from "./finance.js";

const channelSchema = z.enum(["email", "sms", "push"]);

async function quietFor(db: Database, userId: string) {
  const rows = await db.query(`SELECT alert_settings, time_zone FROM users WHERE id = $1`, [userId]);
  const parsed = parseAlertPreferences(JSON.parse(String(rows[0]?.alert_settings || "{}")), String(rows[0]?.time_zone || "America/Chicago"));
  const preferences = parsed.ok ? parsed.value : defaultAlertPreferences(String(rows[0]?.time_zone || "America/Chicago"));
  return isQuietHours(new Date(), preferences);
}

export function mountMessageRoutes(app: Hono, db: Database, actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>) {
  app.post("/api/messages/enrollment", async (c) => {
    const me = await actor(c);
    const body = z.object({ channel: channelSchema, destinationLabel: z.string().min(1).max(80), consent: z.literal(true) }).parse(await c.req.json());
    await db.query(
      `INSERT INTO message_enrollments (user_id, channel, consented_at, opted_out_at, destination_label)
       VALUES ($1,$2,$3,NULL,$4)
       ON CONFLICT (user_id, channel) DO UPDATE SET consented_at = EXCLUDED.consented_at, opted_out_at = NULL, destination_label = EXCLUDED.destination_label`,
      [me.id, body.channel, nowIso(), body.destinationLabel],
    );
    return c.json({ channel: body.channel, consented: true, delivered: false, note: "Consent is stored. No message was sent." }, 201);
  });

  app.post("/api/messages/opt-out", async (c) => {
    const me = await actor(c);
    const body = z.object({ channel: channelSchema }).parse(await c.req.json());
    await db.query(
      `INSERT INTO message_enrollments (user_id, channel, consented_at, opted_out_at, destination_label)
       VALUES ($1,$2,NULL,$3,'')
       ON CONFLICT (user_id, channel) DO UPDATE SET opted_out_at = EXCLUDED.opted_out_at`,
      [me.id, body.channel, nowIso()],
    );
    return c.json({ channel: body.channel, optedOut: true, note: "This channel will not be used. No message was sent." });
  });

  app.post("/api/notifications/test", async (c) => {
    const me = await actor(c);
    const body = z.object({ channel: channelSchema, outcome: z.enum(["accepted", "rejected"]).default("accepted") }).parse(await c.req.json());
    const enrollment = await db.query(`SELECT consented_at, opted_out_at FROM message_enrollments WHERE user_id = $1 AND channel = $2`, [me.id, body.channel]);
    const consented = !!enrollment[0]?.consented_at && !enrollment[0]?.opted_out_at;
    const optedOut = !!enrollment[0]?.opted_out_at;
    if (body.channel === "push" && consented) {
      const tokens = await db.query(`SELECT id FROM devices WHERE user_id = $1 AND push_token IS NOT NULL AND revoked_at IS NULL`, [me.id]);
      if (!tokens.length) throw new ApiError(409, "No push token is enrolled. Nothing was sent.");
    }
    const result = classifyTestDelivery({ outcome: body.outcome, quiet: await quietFor(db, me.id), optedOut, consented });
    const attemptId = id();
    await db.query(
      `INSERT INTO delivery_attempts (id, user_id, channel, status, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [attemptId, me.id, body.channel, result.status, result.note, nowIso()],
    );
    return c.json({ id: attemptId, channel: body.channel, ...result });
  });

  app.post("/api/notifications/test/:id/retry", async (c) => {
    const me = await actor(c);
    const rows = await db.query(`SELECT * FROM delivery_attempts WHERE id = $1 AND user_id = $2`, [c.req.param("id"), me.id]);
    if (!rows.length) throw new ApiError(404, "Not found");
    if (String(rows[0].status) !== "failed") throw new ApiError(409, "Only a failed attempt can be retried. A queued or accepted message was not sent again.");
    const enrollment = (await db.query(`SELECT consented_at, opted_out_at FROM message_enrollments WHERE user_id = $1 AND channel = $2`, [me.id, rows[0].channel]))[0];
    const result = classifyTestDelivery({ outcome: "accepted", quiet: await quietFor(db, me.id), optedOut: !!enrollment?.opted_out_at, consented: !!enrollment?.consented_at && !enrollment?.opted_out_at });
    const attemptId = id();
    await db.query(`INSERT INTO delivery_attempts (id, user_id, channel, status, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [attemptId, me.id, rows[0].channel, result.status, result.note, nowIso()]);
    return c.json({ id: attemptId, retriedFrom: rows[0].id, ...result });
  });

  app.get("/api/notifications/attempts", async (c) => {
    const me = await actor(c);
    const rows = await db.query(`SELECT id, channel, status, detail, created_at FROM delivery_attempts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [me.id]);
    return c.json({ attempts: rows.map((row) => ({ id: row.id, channel: row.channel, status: row.status, detail: row.detail, createdAt: row.created_at, provenDelivered: false })), note: "Accepted by the test sink is not delivered." });
  });
}

export function countAttempts(rows: { n: unknown }[]) {
  return num(rows[0]?.n);
}
