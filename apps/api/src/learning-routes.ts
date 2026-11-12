import { Hono } from "hono";
import { z } from "zod";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num } from "./db.js";
import { ApiError, type Actor } from "./finance.js";

const TOURS = [
  { id: "plan-tour", title: "Give money a job", steps: ["Open Plan.", "Assign part of the paycheck to a category.", "Ready to Assign falls by that assignment and the register does not change."] },
  { id: "activity-tour", title: "Record a purchase", steps: ["Open Activity.", "Enter the payee and the amount.", "Save it. The cash total changes once."] },
];

const PRACTICE = [
  { id: "give-dollars-a-job", prompt: "A paycheck of 25.00 arrives and you assign 10.00 to groceries. How many dollars remain unassigned?", answerMinor: 1500 },
];

export function mountLearningRoutes(app: Hono, db: Database, actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>) {
  app.get("/api/learn", async (c) => {
    const me = await actor(c);
    const progress = await db.query(`SELECT item_id, kind, step FROM learning_steps WHERE user_id = $1`, [me.id]);
    return c.json({
      tours: TOURS,
      practice: PRACTICE.map(({ id: itemId, prompt }) => ({ id: itemId, prompt })),
      progress,
      note: "Practice checks an answer. It does not post a transaction or book a coach.",
    });
  });

  app.post("/api/learn/tours", async (c) => {
    const me = await actor(c);
    const body = z.object({ itemId: z.string(), step: z.number().int().nonnegative() }).parse(await c.req.json());
    if (!TOURS.some((tour) => tour.id === body.itemId)) throw new ApiError(404, "Not found");
    await db.query(
      `INSERT INTO learning_steps (user_id, item_id, kind, step, updated_at) VALUES ($1,$2,'tour',$3,$4)
       ON CONFLICT (user_id, item_id) DO UPDATE SET step = EXCLUDED.step, updated_at = EXCLUDED.updated_at`,
      [me.id, body.itemId, body.step, nowIso()],
    );
    return c.json({ itemId: body.itemId, step: body.step, note: "Tour progress is saved on your account. No money moved." });
  });

  app.post("/api/learn/practice", async (c) => {
    const me = await actor(c);
    const body = z.object({ itemId: z.string(), answerMinor: z.number().int() }).parse(await c.req.json());
    const item = PRACTICE.find((entry) => entry.id === body.itemId);
    if (!item) throw new ApiError(404, "Not found");
    const before = await db.query(`SELECT count(*) AS n FROM transactions`);
    const correct = body.answerMinor === item.answerMinor;
    if (correct) {
      await db.query(
        `INSERT INTO learning_steps (user_id, item_id, kind, step, updated_at) VALUES ($1,$2,'practice',1,$3)
         ON CONFLICT (user_id, item_id) DO UPDATE SET step = 1, updated_at = EXCLUDED.updated_at`,
        [me.id, body.itemId, nowIso()],
      );
    }
    const after = await db.query(`SELECT count(*) AS n FROM transactions`);
    if (num(before[0].n) !== num(after[0].n)) throw new Error("Practice must not post a transaction.");
    return c.json({ correct, note: correct ? "That matches the practice ledger. Nothing was posted to your household." : "That does not match. Nothing was posted." });
  });

  app.get("/api/support/:id", async (c) => {
    const me = await actor(c);
    const tickets = await db.query(`SELECT id, subject, status, created_at FROM support_tickets WHERE id = $1 AND user_id = $2`, [c.req.param("id"), me.id]);
    if (!tickets.length) throw new ApiError(404, "Not found");
    const messages = await db.query(`SELECT id, body, created_at FROM support_messages WHERE ticket_id = $1 ORDER BY created_at`, [tickets[0].id]);
    const attachments = await db.query(`SELECT id, filename, content_type, size_bytes, created_at FROM support_attachments WHERE ticket_id = $1 AND user_id = $2 ORDER BY created_at`, [tickets[0].id, me.id]);
    return c.json({ ticket: tickets[0], messages, attachments, note: "A stored message is not a reply from a person." });
  });

  app.post("/api/support/:id/status", async (c) => {
    const me = await actor(c);
    const body = z.object({ status: z.enum(["open", "closed"]) }).parse(await c.req.json());
    const updated = await db.query(`UPDATE support_tickets SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING id, status`, [body.status, c.req.param("id"), me.id]);
    if (!updated.length) throw new ApiError(404, "Not found");
    return c.json({ id: updated[0].id, status: updated[0].status, note: "The status is yours. Closing a request does not mean a person replied." });
  });

  app.post("/api/support/:id/attachments", async (c) => {
    const me = await actor(c);
    const body = z.object({
      filename: z.string().min(1).max(80),
      contentType: z.enum(["image/jpeg", "image/png", "text/plain"]),
      dataBase64: z.string().min(1).max(200_000),
    }).parse(await c.req.json());
    if (body.filename.includes("/") || body.filename.includes("\\") || body.filename.includes("..")) throw new ApiError(400, "Use a file name without a path.");
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (!bytes.length || bytes.length > 100_000) throw new ApiError(400, "That file is empty or larger than 100 KB.");
    const text = bytes.toString("utf8").trim().toLowerCase();
    if (body.contentType === "text/plain" && (text.startsWith("<html") || text.includes("<script"))) throw new ApiError(400, "HTML is not an allowed attachment.");
    const tickets = await db.query(`SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2`, [c.req.param("id"), me.id]);
    if (!tickets.length) throw new ApiError(404, "Not found");
    const attachmentId = id();
    await db.query(
      `INSERT INTO support_attachments (id, ticket_id, user_id, filename, content_type, size_bytes, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [attachmentId, tickets[0].id, me.id, body.filename, body.contentType, bytes.length, body.dataBase64, nowIso()],
    );
    return c.json({ id: attachmentId, filename: body.filename, sizeBytes: bytes.length, note: "The file is stored with your request. It is not scanned by a support agent." }, 201);
  });
}
