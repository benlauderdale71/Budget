import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { createOidcStart, oidcReturnPath, projectMonthlyRetirement } from "@budgetcents/domain";
import { auditAssistant, confirmAssistantAction, undoAssistantAction } from "./assistant-actions.js";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num } from "./db.js";
import { ApiError, type Actor, assertBudget, assertWrite, audit, requireMember } from "./finance.js";
import { mountLearningRoutes } from "./learning-routes.js";
import { mountInvestmentLots } from "./investment-lots.js";
import { mountMessageRoutes } from "./message-routes.js";
import { completeOidcCallback, completeOidcLink, completeOidcMfa } from "./oidc-flow.js";
import { activityFromWebhook, connectSandbox, importSandboxActivities, reconnectSandbox, sandboxConnection, syncSandbox } from "./sandbox-import.js";
import { visibleAudit } from "./sharing.js";

const HELP = [
  { id: "ready", title: "Ready to Assign", body: "Ready to Assign is cash already in on-budget accounts that does not yet have a job. Expected income is not included." },
  { id: "ownership", title: "Mine, yours, and ours", body: "A transaction labeled Ours belongs to the household. A split can name a member for part of the same purchase. The parts add up to the purchase once, and the bank total does not change." },
  { id: "alerts", title: "Alerts", body: "Alerts are checked from the ledger you can see. A background refresh does not send the same open alert again. Push, email, and text are off until a provider is connected." },
  { id: "offline", title: "Offline", body: "A transaction or assignment kept on this device is waiting. It is not saved on the ledger until the server accepts it. A saved dashboard is the last copy this device was allowed to see, and it is not the current ledger." },
  { id: "retirement", title: "Retirement projections", body: "A projection is a model with stated assumptions. It is not a guarantee and it does not move money in the register." },
  { id: "providers", title: "Outside services", body: "The sandbox bank can import its built-in test history. That history is not your bank. A stored price or credit event does not create a transaction. A request stored in BudgetCents is not a completed cancellation, transfer, booking, tax filing, or legal document." },
];

export interface ContinuationDeps {
  actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>;
  insertTransaction: (user: Actor, householdId: string, body: any) => Promise<{ id?: string }>;
  createGoal: (user: Actor, householdId: string, body: any) => Promise<{ id: string }>;
  startSession: (userId: string, agent: string) => Promise<string>;
}

export function mountContinuation(app: Hono, db: Database, deps: ContinuationDeps) {
  app.get("/api/households/:hid/changes", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const since = c.req.query("since") ?? "";
    const events = (await visibleAudit(db, me.id, member.householdId)).filter((event) => String(event.created_at) > since);
    const prefs = await db.query(`SELECT version FROM alert_preferences WHERE user_id = $1 AND household_id = $2`, [me.id, member.householdId]);
    return c.json({
      serverTime: nowIso(),
      planRevision: member.planRevision,
      role: member.role,
      alertVersion: prefs.length ? num(prefs[0].version) : 0,
      events: events.filter((event) => event.action !== "alert.settings" || event.user_id === me.id),
    });
  });

  app.get("/api/help", async (c) => {
    await deps.actor(c);
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const articles = HELP.filter((article) => !q || `${article.title} ${article.body}`.toLowerCase().includes(q));
    return c.json({ articles, note: "These articles were written for BudgetCents. They are guidance, not a filed support request or an appointment." });
  });

  app.get("/api/support", async (c) => {
    const me = await deps.actor(c);
    const tickets = await db.query(`SELECT id, subject, status, created_at FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`, [me.id]);
    return c.json({ tickets });
  });

  app.post("/api/support/:id/messages", async (c) => {
    const me = await deps.actor(c);
    const body = z.object({ body: z.string().min(1).max(4000) }).parse(await c.req.json());
    const tickets = await db.query(`SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`, [c.req.param("id"), me.id]);
    if (!tickets.length) throw new ApiError(404, "Not found");
    const messageId = id();
    await db.query(`INSERT INTO support_messages (id, ticket_id, user_id, body, created_at) VALUES ($1,$2,$3,$4,$5)`, [messageId, tickets[0].id, me.id, body.body, nowIso()]);
    return c.json({ id: messageId, status: tickets[0].status, note: "Your message is stored with the request. It does not mean a person has replied." }, 201);
  });

  app.get("/api/auth/oidc/start", async (c) => {
    const issuer = process.env.OIDC_ISSUER;
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!issuer || !clientId || !process.env.OIDC_CLIENT_SECRET) {
      return c.json({ error: "Federated sign-in is not configured.", status: "not_configured" }, 404);
    }
    const start = createOidcStart({
      issuer,
      clientId,
      redirectUri: process.env.OIDC_REDIRECT_URI || "https://localhost/api/auth/oidc/callback",
      returnPath: oidcReturnPath(c.req.query("next")),
    });
    await db.query(`INSERT INTO oidc_states (state, nonce, code_verifier, return_path, created_at) VALUES ($1,$2,$3,$4,$5)`, [start.state, start.nonce, start.codeVerifier, oidcReturnPath(c.req.query("next")), nowIso()]);
    return c.json({ authorizationUrl: start.authorizationUrl, status: "redirect" });
  });

  app.get("/api/auth/oidc/callback", async (c) => {
    if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
      return c.json({ error: "Federated sign-in is not configured.", status: "not_configured" }, 404);
    }
    const done = await completeOidcCallback(db, {
      code: c.req.query("code") ?? "",
      state: c.req.query("state") ?? "",
      userAgent: c.req.header("user-agent") ?? "web",
    }, deps.startSession);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) return c.json(done);
    const token = "token" in done ? String(done.token ?? "") : "";
    const pending = "pendingToken" in done ? String(done.pendingToken ?? "") : "";
    const path = String(done.returnPath || "/");
    const mode = "mfaRequired" in done && done.mfaRequired ? "mfa" : "status" in done && done.status === "link-required" ? "link" : "";
    const script = token
      ? `localStorage.setItem("budgetcents.token", ${JSON.stringify(token)}); location.replace(${JSON.stringify(path)});`
      : `sessionStorage.setItem("budgetcents.oidcPending", ${JSON.stringify(pending)}); location.replace(${JSON.stringify(`/login?oidc=${mode}`)});`;
    const note = "note" in done ? String(done.note ?? "Signing in.") : "Signing in.";
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BudgetCents sign-in</title></head><body><p>${note.replace(/[<>&]/g, "")}</p><script>${script}</script></body></html>`);
  });

  app.post("/api/auth/oidc/link", async (c) => {
    const body = z.object({ pendingToken: z.string().min(1), password: z.string().min(1) }).parse(await c.req.json());
    return c.json(await completeOidcLink(db, { ...body, userAgent: c.req.header("user-agent") ?? "web" }, deps.startSession));
  });

  app.post("/api/auth/oidc/mfa", async (c) => {
    const body = z.object({ pendingToken: z.string().min(1), code: z.string().min(1) }).parse(await c.req.json());
    return c.json(await completeOidcMfa(db, { ...body, userAgent: c.req.header("user-agent") ?? "web" }, deps.startSession));
  });

  app.patch("/api/households/:hid/goals/:id", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertBudget(member);
    const body = z.object({ name: z.string().min(1).max(80).optional(), targetMinor: z.number().int().nonnegative().optional(), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(await c.req.json());
    const rows = await db.query(`SELECT id FROM goals WHERE id = $1 AND household_id = $2`, [c.req.param("id"), member.householdId]);
    if (!rows.length) throw new ApiError(404, "Not found");
    if (body.name != null) await db.query(`UPDATE goals SET name = $1 WHERE id = $2`, [body.name, rows[0].id]);
    if (body.targetMinor != null) await db.query(`UPDATE goals SET target_minor = $1 WHERE id = $2`, [body.targetMinor, rows[0].id]);
    if (body.targetDate !== undefined) await db.query(`UPDATE goals SET target_date = $1 WHERE id = $2`, [body.targetDate, rows[0].id]);
    return c.json({ ok: true, note: "The goal target changed. Envelope balances and the register did not." });
  });

  mountInvestmentLots(app, db, deps.actor);

  app.post("/api/households/:hid/benchmarks", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ name: z.string().min(1).max(80), points: z.array(z.object({ date: z.string(), valueMinor: z.number().int() })).min(2) }).parse(await c.req.json());
    const benchmarkId = id();
    await db.query(`INSERT INTO benchmarks (id, household_id, name, points_json, source, updated_at) VALUES ($1,$2,$3,$4,'manual',$5)`, [benchmarkId, member.householdId, body.name, JSON.stringify(body.points), nowIso()]);
    return c.json({ id: benchmarkId, source: "manual", note: "This series is what you entered. BudgetCents did not download a market index." }, 201);
  });

  app.get("/api/households/:hid/look-through", async (c) => {
    const me = await deps.actor(c);
    await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ available: false, holdings: [], note: "Fund look-through needs licensed holdings data. None is configured, so no underlying holdings were invented." });
  });

  app.post("/api/households/:hid/retirement/monthly", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    const body = z.object({
      portfolioMinor: z.number().int().nonnegative(),
      traditionalMinor: z.number().int().nonnegative(),
      annualReturnBps: z.number().int(),
      annualSpendingMinor: z.number().int().nonnegative(),
      annualContributionMinor: z.number().int().nonnegative(),
      taxBps: z.number().int().nonnegative(),
      age: z.number().int().min(0).max(120),
      birthYear: z.number().int().optional(),
      months: z.number().int().min(1).max(600),
      priorYearTraditionalMinor: z.number().int().safe().nonnegative().optional(),
      strategy: z.enum(["other_first", "traditional_first"]).optional(),
      inheritedAccount: z.boolean().optional(),
      youngerSpouseSoleBeneficiary: z.boolean().optional(),
    }).parse(await c.req.json());
    const projection = projectMonthlyRetirement(body);
    const after = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [member.householdId]);
    if (num(before[0].n) !== num(after[0].n)) throw new Error("A retirement projection must not post to the ledger.");
    const summarize = (strategy: "other_first" | "traditional_first") => {
      const result = projectMonthlyRetirement({ ...body, strategy });
      return { strategy, endingMinor: result.months.at(-1)!.portfolioMinor, taxMinor: result.months.reduce((sum, month) => sum + month.taxMinor, 0), unmetSpendingMinor: result.months.reduce((sum, month) => sum + month.unmetSpendingMinor, 0) };
    };
    return c.json({ ...projection, comparison: [summarize("other_first"), summarize("traditional_first")], guarantee: false });
  });

  app.post("/api/households/:hid/assistant/actions/preview", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ kind: z.enum(["create_transaction", "create_goal", "create_rule", "create_category", "set_category", "set_tags", "adjust_plan"]), payload: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    if (body.kind === "create_goal" || body.kind === "create_category" || body.kind === "adjust_plan") assertBudget(member);
    const actionId = id();
    await db.query(
      `INSERT INTO assistant_actions (id, household_id, user_id, kind, payload_json, result_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actionId, member.householdId, me.id, body.kind, JSON.stringify(body.payload), JSON.stringify({ status: "preview" }), nowIso()],
    );
    return c.json({ id: actionId, kind: body.kind, payload: body.payload, status: "preview", note: "Nothing was saved. Confirm to run this through the normal ledger rules." });
  });

  app.post("/api/households/:hid/assistant/actions/:id/confirm", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const rows = await db.query(`SELECT * FROM assistant_actions WHERE id = $1 AND household_id = $2 AND user_id = $3`, [c.req.param("id"), member.householdId, me.id]);
    if (!rows.length) throw new ApiError(404, "Not found");
    const result = JSON.parse(String(rows[0].result_json)) as { status?: string };
    if (result.status !== "preview") throw new ApiError(409, "This proposal was already confirmed or undone.");
    const payload = JSON.parse(String(rows[0].payload_json)) as Record<string, unknown>;
    const saved = await confirmAssistantAction(db, me, member, String(rows[0].kind), payload, deps);
    await db.query(`UPDATE assistant_actions SET result_json = $1 WHERE id = $2`, [JSON.stringify({ status: "confirmed", entityId: saved.entityId, undo: saved.undo }), rows[0].id]);
    await auditAssistant(db, member.householdId, me.id, "assistant.confirm", `Confirmed ${String(rows[0].kind)}`, String(rows[0].id));
    return c.json({ ok: true, entityId: saved.entityId, note: "The action ran through the same rules as a form you save yourself." });
  });

  app.post("/api/households/:hid/assistant/actions/:id/undo", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const rows = await db.query(`SELECT * FROM assistant_actions WHERE id = $1 AND household_id = $2 AND user_id = $3`, [c.req.param("id"), member.householdId, me.id]);
    if (!rows.length) throw new ApiError(404, "Not found");
    const result = JSON.parse(String(rows[0].result_json)) as { status?: string; entityId?: string; undo?: Record<string, unknown> };
    if (result.status !== "confirmed" || !result.entityId) throw new ApiError(409, "There is nothing to undo.");
    await undoAssistantAction(db, member, String(rows[0].kind), result.entityId, result.undo ?? { kind: rows[0].kind });
    await db.query(`UPDATE assistant_actions SET undone_at = $1, result_json = $2 WHERE id = $3`, [nowIso(), JSON.stringify({ status: "undone", entityId: result.entityId }), rows[0].id]);
    await auditAssistant(db, member.householdId, me.id, "assistant.undo", `Undid ${String(rows[0].kind)}.`, String(rows[0].id));
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/providers/sandbox/connect", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ provider: z.literal("sandbox-bank"), spaceId: z.string() }).parse(await c.req.json());
    const connected = await connectSandbox(db, me, member.householdId, body.spaceId, deps.insertTransaction);
    return c.json(connected, 201);
  });

  app.post("/api/households/:hid/providers/sandbox/sync", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ spaceId: z.string() }).parse(await c.req.json());
    return c.json(await syncSandbox(db, me, member.householdId, body.spaceId, deps.insertTransaction));
  });

  app.post("/api/households/:hid/providers/sandbox/reconnect", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    return c.json(await reconnectSandbox(db, me, member.householdId));
  });

  app.post("/api/households/:hid/providers/sandbox/revoke", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    await db.query(`UPDATE connections SET status = 'revoked' WHERE household_id = $1 AND provider = 'sandbox-bank' AND status = 'sandbox'`, [member.householdId]);
    await db.query(`UPDATE consents SET withdrawn_at = $1 WHERE household_id = $2 AND provider = 'sandbox-bank' AND withdrawn_at IS NULL`, [nowIso(), member.householdId]);
    return c.json({ status: "revoked", note: "The sandbox consent was withdrawn. No bank was contacted." });
  });

  app.post("/api/providers/sandbox/webhook", async (c) => {
    const secret = process.env.SANDBOX_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "The sandbox webhook secret is not configured.", status: "not_configured" }, 404);
    const raw = await c.req.text();
    const sent = c.req.header("x-budgetcents-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const left = Buffer.from(sent);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ApiError(401, "The webhook signature did not match. Nothing was stored.");
    const body = z.object({
      householdId: z.string(),
      externalId: z.string().min(1),
      kind: z.enum(["price_increase", "credit_change", "broken_connection"]),
      title: z.string().min(1).max(80),
      body: z.string().min(1).max(180),
      occurredOn: z.string(),
    }).parse(JSON.parse(raw));
    const inserted = await db.query(
      `INSERT INTO provider_events (id, household_id, provider, kind, external_id, title, body, occurred_on, created_at)
       VALUES ($1,$2,'sandbox-bank',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (household_id, provider, external_id) DO NOTHING RETURNING id`,
      [id(), body.householdId, body.kind, body.externalId, body.title, body.body, body.occurredOn, nowIso()],
    );
    return c.json({ accepted: true, duplicate: inserted.length === 0, transactionsImported: 0, note: "The event was stored. No transaction was imported." });
  });

  app.post("/api/providers/sandbox/activity", async (c) => {
    const secret = process.env.SANDBOX_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "The sandbox webhook secret is not configured.", status: "not_configured" }, 404);
    const raw = await c.req.text();
    const sent = c.req.header("x-budgetcents-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const left = Buffer.from(sent);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ApiError(401, "The webhook signature did not match. Nothing was stored.");
    const body = z.object({
      householdId: z.string(),
      spaceId: z.string(),
      activity: z.object({
        externalId: z.string().min(1),
        postedOn: z.string(),
        payee: z.string().min(1),
        amountMinor: z.number().int(),
        bankStatus: z.enum(["pending", "posted"]),
        settlesExternalId: z.string().optional(),
      }),
    }).parse(JSON.parse(raw));
    const connection = await sandboxConnection(db, body.householdId);
    if (!connection || connection.status !== "sandbox") throw new ApiError(409, "The sandbox connection is not active. No transaction was imported.");
    const actor = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1 AND role = 'owner' LIMIT 1`, [body.householdId]);
    if (!actor.length) throw new ApiError(404, "Not found");
    const result = await importSandboxActivities(db, { id: String(actor[0].user_id), email: "", displayName: "Sandbox" } as Actor, body.householdId, body.spaceId, [activityFromWebhook(body.activity)], deps.insertTransaction);
    return c.json({ accepted: true, duplicate: result.duplicates > 0 && result.imported === 0 && result.settled === 0, ...result, note: "Activity was matched to the sandbox ledger. A repeated id does not add a second row." });
  });

  app.post("/api/households/:hid/service-requests", async (c) => {
    const me = await deps.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({ kind: z.enum(["cancellation", "negotiation", "transfer", "booking", "tax", "estate"]), detail: z.string().min(1).max(1000) }).parse(await c.req.json());
    const requestId = id();
    await db.query(`INSERT INTO service_requests (id, household_id, user_id, kind, status, detail, created_at) VALUES ($1,$2,$3,$4,'authorization_recorded',$5,$6)`, [requestId, member.householdId, me.id, body.kind, body.detail, nowIso()]);
    return c.json({ id: requestId, status: "authorization_recorded", completed: false, note: "This records your request. It is not a completed cancellation, transfer, booking, tax filing, or legal document." }, 201);
  });

  app.post("/api/devices/:id/push-token", async (c) => {
    const me = await deps.actor(c);
    const body = z.object({ token: z.string().min(1).max(4096) }).parse(await c.req.json());
    await db.tx(async () => {
      await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [me.id]);
      const enrollment = (await db.query(`SELECT consented_at, opted_out_at FROM message_enrollments WHERE user_id = $1 AND channel = 'push'`, [me.id]))[0];
      if (!enrollment?.consented_at || enrollment.opted_out_at) throw new ApiError(409, "Save push consent before enrolling this phone.");
      const device = await db.query(`SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [c.req.param("id"), me.id]);
      if (!device.length) throw new ApiError(404, "Not found");
      await db.query(`UPDATE devices SET push_token = NULL WHERE push_token = $1`, [body.token]);
      await db.query(`UPDATE devices SET push_token = $1 WHERE id = $2`, [body.token, c.req.param("id")]);
    });
    return c.json({ stored: true, delivery: "enrolled", note: "The phone token is stored. No remote notification was sent." });
  });

  app.post("/api/notifications/email-test", async (c) => {
    await deps.actor(c);
    if (!process.env.SMTP_URL) return c.json({ error: "Email delivery is not connected. A development outbox is not email delivery.", status: "not_configured" }, 404);
    return c.json({ error: "Email delivery is configured, but this build does not send a message without an explicit send operation.", status: "not_sent" }, 409);
  });

  app.get("/api/households/:hid/coaching", async (c) => {
    const me = await deps.actor(c);
    await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ provider: "not_configured", appointments: [], note: "No coaching provider is configured. Nothing here is a confirmed appointment." });
  });

  mountMessageRoutes(app, db, deps.actor);
  mountLearningRoutes(app, db, deps.actor);
}
