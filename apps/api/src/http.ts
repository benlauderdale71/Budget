import { BudgetError, MoneyError, answerFinanceQuestion, applyScenario, allocation, allocationDrift, compareRefinance, contributionGap, displayBalance, duplicateKey, eligiblePostedIncomeMinor, essentialObligations, evaluateWatchlist, feeImpact, holdingPeriodDays, IMPORT_PROFILES, isOnBudgetCash, mapCsv, matchProblem, moneyWeightedReturn, parseOfx, parseQif, positionView, projectCash, projectRetirement, spendingRows, suggestBucket, targetProgress, timeWeightedReturn, toCsv, validateTransaction, type Account, type Transaction, incomeRows, cashFlowSankey, savingsRate, amortize } from "@budgetcents/domain";
import { Hono } from "hono";
import { z } from "zod";
import { LESSONS, PROVIDERS } from "./content.js";
import { saveCategory } from "./categories.js";
import { deleteFill, fillHistory, fillSchedulerStatus, listFills, previewFill, runDueFills, runFill, saveFillTemplate, setFillPaused, skipFill, type FillTemplateInput } from "./fills.js";
import { createBill, createIncomeSource, expectedIncomeEvents, mountIncome, paycheckPlan, skipBill } from "./income.js";
import { mountLoans } from "./loans.js";
import { mountOnboarding } from "./onboarding.js";
import { planRestore } from "./restore.js";
import { hashPassword, id, localDate, newMfaSecret, nowIso, randomToken, sha256, verifyPassword, verifyTotp } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import {
  ApiError,
  type Actor,
  applyHouseholdRules,
  assertAdmin,
  assertBudget,
  assertWrite,
  audit,
  canSeeAccount,
  debtPlan,
  evaluateIncomePlan,
  guidanceFor,
  loadSpace,
  lockHousehold,
  planView,
  previewAutoAssign,
  publicAccounts,
  requireMember,
  setAssignment,
  visibleNetWorth,
  emergencyGap,
  financialRoadmap,
  neededForTarget,
} from "./finance.js";
import { readerStatus } from "./ocr.js";
import { textPdf } from "./pdf.js";
import { mountReceipts } from "./receipts.js";
import { DEMO_EMAIL, DEMO_PASSWORD, ensureDemo } from "./seed.js";

const money = z.number().int();

const categoryEditSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1).max(80),
  group: z.string().min(1).max(80),
  icon: z.string().max(40).nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999),
  kind: z.enum(["income", "expense"]),
  flexRole: z.enum(["fixed", "non_monthly", "flexible", "income", "reserve"]),
  envelopeStyle: z.enum(["regular", "annual", "goal", "debt", "none"]),
  rollover: z.enum(["both", "positive", "negative", "none", "capped"]),
  rolloverCapMinor: money.nullable().optional(),
  purpose: z.string().max(40).nullable().optional(),
  archived: z.boolean(),
  hidden: z.boolean().optional(),
  target: z.record(z.unknown()).nullable().optional(),
  effectivePeriod: z.string(),
  recalculate: z.boolean().default(false),
  preview: z.boolean().default(false),
});

const fillTemplateSchema: z.ZodType<FillTemplateInput> = z.object({
  version: z.number().int().positive().optional(),
  spaceId: z.string(),
  name: z.string().min(1).max(80),
  cadence: z.enum(["once", "weekly", "biweekly", "twice_monthly", "monthly", "every_2_months", "every_3_months", "every_6_months", "annual", "custom"]),
  customDays: z.number().int().min(1).max(366).nullable().optional(),
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  paused: z.boolean().optional(),
  shortfallPolicy: z.enum(["skip", "partial"]),
  sweepBucketId: z.string().nullable().optional(),
  lines: z.array(z.object({
    bucketId: z.string(),
    mode: z.enum(["add", "top_up", "shortfall", "percent"]),
    amountMinor: money.nullable().optional(),
    percentBps: z.number().int().min(0).max(10_000).nullable().optional(),
    priority: z.number().int().min(0).max(999),
    sourceBucketId: z.string().nullable().optional(),
  })).min(1).max(40),
});

function targetJson(target: Record<string, unknown> | null | undefined): string | null {
  if (target == null) return null;
  if (target.percentBps != null) {
    const bps = Number(target.percentBps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new ApiError(400, "A percent target has to be between 0 and 100.");
  }
  return JSON.stringify(target);
}
const uploadDir = () => process.env.BUDGETCENTS_UPLOADS ?? "./data/uploads";

export function demoLoginAllowed(): boolean {
  if (process.env.DEMO_LOGIN === "true") return true;
  if (process.env.DEMO_LOGIN === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export function createApp(db: Database) {
  const app = new Hono();
  const hits = new Map<string, { n: number; reset: number }>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof BudgetError || err instanceof MoneyError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((issue) => issue.message).join(" ") }, 400);
    console.error(JSON.stringify({ level: "error", message: err instanceof Error ? err.name : "error" }));
    return c.json({ error: "Something went wrong." }, 500);
  });

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Cache-Control", "no-store");
    if (c.req.path.startsWith("/api")) {
      console.info(JSON.stringify({ method: c.req.method, path: c.req.path.split("?")[0], status: c.res.status, ms: Date.now() - started }));
    }
  });

  function limit(key: string, max: number) {
    const now = Date.now();
    const row = hits.get(key);
    if (!row || row.reset < now) {
      hits.set(key, { n: 1, reset: now + 60_000 });
      return;
    }
    row.n += 1;
    if (row.n > max) throw new ApiError(429, "Too many attempts. Wait a minute and try again.");
  }

  async function actor(c: { req: { header: (name: string) => string | undefined } }): Promise<Actor> {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new ApiError(401, "Sign in required.");
    const rows = await db.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.deleted_at IS NULL`,
      [sha256(token), nowIso()],
    );
    if (!rows.length) {
      const api = await db.query(
        `SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.deleted_at IS NULL`,
        [sha256(token)],
      );
      if (!api.length) throw new ApiError(401, "Sign in required.");
      await db.query(`UPDATE api_tokens SET last_used_at = $1 WHERE token_hash = $2`, [nowIso(), sha256(token)]);
      return mapUser(api[0]);
    }
    return mapUser(rows[0]);
  }

  app.get("/api/health", (c) => c.json({ ok: true, service: "budgetcents", version: "1.0.0", fills: fillSchedulerStatus(), devMail: devMailEnabled(), ocr: readerStatus() }));

  app.get("/api/dev/outbox", async (c) => {
    if (!devMailEnabled()) throw new ApiError(404, "Not found");
    const requested = (c.req.query("email") ?? "").trim().toLowerCase();
    if (!requested.includes("@")) throw new ApiError(400, "Enter the full email address for the mailbox.");
    const header = c.req.header("authorization") ?? "";
    if (header.toLowerCase().startsWith("bearer ") && header.slice(7).trim()) {
      const me = await actor(c);
      if (me.email !== requested) throw new ApiError(404, "Not found");
    }
    const rows = await db.query(
      `SELECT subject, body, created_at FROM outbox WHERE lower(to_email) = $1 ORDER BY created_at DESC LIMIT 20`,
      [requested],
    );
    return c.json({ messages: rows, note: "Development outbox only. This is not proof that SMTP delivered the message." });
  });

  app.post("/api/auth/register", async (c) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(10),
      displayName: z.string().min(1).max(80),
      householdName: z.string().min(1).max(80),
      kind: z.enum(["individual", "couple", "family", "freelancer", "mixed"]).default("individual"),
      currency: z.string().length(3).default("USD"),
      approach: z.enum(["category", "zero", "envelope", "flex"]).default("zero"),
    }).parse(await c.req.json());
    limit(`register:${body.email.toLowerCase()}`, 8);
    const email = body.email.toLowerCase();
    const taken = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (taken.length) throw new ApiError(400, "An account with that email already exists.");
    const userId = id();
    const householdId = id();
    const spaceId = id();
    const created = nowIso();
    const passwordHash = await hashPassword(body.password);
    const verify = randomToken();
    const origin = appOrigin(c);
    await db.tx(async () => {
      await db.query(
        `INSERT INTO users (id, email, password_hash, display_name, locale, time_zone, budget_approach, onboarding_step, created_at)
         VALUES ($1,$2,$3,$4,'en-US','America/Chicago',$5,'who',$6)`,
        [userId, email, passwordHash, body.displayName, body.approach, created],
      );
      await db.query(
        `INSERT INTO households (id, name, kind, currency, budget_approach, time_zone, created_at) VALUES ($1,$2,$3,$4,$5,'America/Chicago',$6)`,
        [householdId, body.householdName, body.kind, body.currency.toUpperCase(), body.approach, created],
      );
      await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)`, [householdId, userId, created]);
      await db.query(
        `INSERT INTO spaces (id, household_id, name, kind, currency, created_at) VALUES ($1,$2,'Household','household',$3,$4)`,
        [spaceId, householdId, body.currency.toUpperCase(), created],
      );
      const { insertStarterBuckets } = await import("./finance.js");
      await insertStarterBuckets(db, householdId, spaceId);
      await db.query(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1,$2,'verify',$3,$4)`,
        [id(), userId, sha256(verify), new Date(Date.now() + 86_400_000 * 2).toISOString()],
      );
      await db.query(`INSERT INTO outbox (id, user_id, to_email, subject, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
        id(), userId, email, "Verify your BudgetCents email", verificationMessage(origin, verify), created,
      ]);
      await db.query(
        `INSERT INTO onboarding_states (user_id, household_id, step, completed_json, skipped_json, draft_json, version, finished_at, updated_at)
         VALUES ($1,$2,'who','[]','[]','{}',1,NULL,$3)`,
        [userId, householdId, created],
      );
      await audit(db, householdId, userId, "register", "Household created");
    });
    const token = await startSession(userId, c.req.header("user-agent") ?? "web");
    return c.json({ token, user: await publicUser(userId), verificationRequired: true });
  });

  app.post("/api/auth/login", async (c) => {
    const body = z.object({ email: z.string().email(), password: z.string(), code: z.string().optional() }).parse(await c.req.json());
    limit(`login:${body.email.toLowerCase()}`, 10);
    const rows = await db.query(`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`, [body.email.toLowerCase()]);
    const dummy = "scrypt$00$00";
    const user = rows[0];
    const ok = await verifyPassword(body.password, user ? String(user.password_hash) : dummy);
    if (!user || !ok) throw new ApiError(401, "Email or password is incorrect.");
    if (num(user.mfa_enabled) === 1) {
      const code = (body.code ?? "").trim();
      if (!code) return c.json({ mfaRequired: true });
      if (!verifyTotp(String(user.mfa_secret), code)) {
        const recovery = JSON.parse(String(user.recovery_hashes || "[]")) as string[];
        if (!recovery.includes(sha256(code))) throw new ApiError(401, "That authentication code is not valid.");
        await consumeRecoveryCode(String(user.id), code);
      }
    }
    await audit(db, null, String(user.id), "login", "Signed in");
    return c.json({ token: await startSession(String(user.id), c.req.header("user-agent") ?? "web"), user: await publicUser(String(user.id)) });
  });

  app.post("/api/auth/demo", async (c) => {
    if (!demoLoginAllowed()) throw new ApiError(404, "Not found");
    await ensureDemo(db);
    const rows = await db.query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL]);
    const token = await startSession(String(rows[0].id), "demo");
    return c.json({
      token,
      user: await publicUser(String(rows[0].id)),
      demo: true,
      note: "This is the isolated sample household. It is not a connected bank.",
      sampleEmail: DEMO_EMAIL,
      samplePassword: DEMO_PASSWORD,
    });
  });

  app.post("/api/auth/logout", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.slice(7).trim();
    await db.query(`UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2`, [nowIso(), sha256(token)]);
    return c.json({ ok: true });
  });

  app.post("/api/auth/forgot", async (c) => {
    const body = z.object({ email: z.string().email() }).parse(await c.req.json());
    limit(`forgot:${body.email.toLowerCase()}`, 5);
    const rows = await db.query(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [body.email.toLowerCase()]);
    if (rows.length) {
      const token = randomToken();
      const expires = new Date(Date.now() + 3_600_000).toISOString();
      await db.query(`INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1,$2,'reset',$3,$4)`, [id(), rows[0].id, sha256(token), expires]);
      await db.query(`INSERT INTO outbox (id, user_id, to_email, subject, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
        id(), rows[0].id, body.email.toLowerCase(), "Reset your BudgetCents password", resetMessage(appOrigin(c), token), nowIso(),
      ]);
    }
    return c.json({ ok: true, message: "If that email has an account, a reset message was created." });
  });

  app.post("/api/auth/reset", async (c) => {
    const body = z.object({ token: z.string().min(1), password: z.string().min(10) }).parse(await c.req.json());
    const passwordHash = await hashPassword(body.password);
    const userId = await db.tx(async () => {
      const consumed = await consumeEmailToken("reset", body.token);
      await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, consumed]);
      await db.query(`UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, [nowIso(), consumed]);
      return consumed;
    });
    const user = await publicUser(userId);
    return c.json({ ok: true, onboardingStep: user.onboardingStep });
  });

  app.post("/api/auth/verify-email", async (c) => {
    const body = z.object({ token: z.string().min(1) }).parse(await c.req.json());
    const userId = await db.tx(async () => {
      const consumed = await consumeEmailToken("verify", body.token);
      await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [nowIso(), consumed]);
      return consumed;
    });
    const user = await publicUser(userId);
    return c.json({ ok: true, emailVerified: true, onboardingStep: user.onboardingStep });
  });

  app.post("/api/auth/verify-email/resend", async (c) => {
    const me = await actor(c);
    const rows = await db.query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [me.id]);
    if (rows[0]?.email_verified_at) throw new ApiError(400, "This email is already verified.");
    const verify = randomToken();
    const created = nowIso();
    await db.tx(async () => {
      await db.query(`UPDATE email_tokens SET used_at = $1 WHERE user_id = $2 AND purpose = 'verify' AND used_at IS NULL`, [created, me.id]);
      await db.query(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1,$2,'verify',$3,$4)`,
        [id(), me.id, sha256(verify), new Date(Date.now() + 86_400_000 * 2).toISOString()],
      );
      await db.query(`INSERT INTO outbox (id, user_id, to_email, subject, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
        id(), me.id, String(rows[0].email), "Verify your BudgetCents email", verificationMessage(appOrigin(c), verify), created,
      ]);
    });
    return c.json({ ok: true, message: "A new verification message was created." });
  });

  app.get("/api/me", async (c) => c.json({ user: await publicUser((await actor(c)).id), households: await householdsFor((await actor(c)).id) }));

  app.patch("/api/me", async (c) => {
    const me = await actor(c);
    const raw = await c.req.json() as Record<string, unknown>;
    const body = z.object({
      displayName: z.string().min(1).max(80).optional(),
      locale: z.string().optional(),
      timeZone: z.string().optional(),
      weekStart: z.number().int().min(0).max(6).optional(),
      theme: z.enum(["light", "dark", "system"]).optional(),
      privacyMode: z.boolean().optional(),
      aiEnabled: z.boolean().optional(),
      payCadence: z.string().optional(),
      budgetApproach: z.enum(["category", "zero", "envelope", "flex"]).optional(),
      labelMode: z.enum(["categories", "envelopes"]).optional(),
      alertSettings: z.record(z.unknown()).optional(),
      dashboardLayout: z.array(z.record(z.unknown())).optional(),
      onboardingStep: z.string().max(40).nullable().optional(),
    }).parse(raw);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if ("displayName" in raw) set("display_name", body.displayName);
    if ("locale" in raw) set("locale", body.locale);
    if ("timeZone" in raw) set("time_zone", body.timeZone);
    if ("weekStart" in raw) set("week_start", body.weekStart);
    if ("theme" in raw) set("theme", body.theme);
    if ("privacyMode" in raw) set("privacy_mode", body.privacyMode ? 1 : 0);
    if ("aiEnabled" in raw) set("ai_enabled", body.aiEnabled ? 1 : 0);
    if ("payCadence" in raw) set("pay_cadence", body.payCadence);
    if ("budgetApproach" in raw) set("budget_approach", body.budgetApproach);
    if ("labelMode" in raw) set("label_mode", body.labelMode);
    if ("alertSettings" in raw) set("alert_settings", JSON.stringify(body.alertSettings ?? {}));
    if ("dashboardLayout" in raw) set("dashboard_layout", JSON.stringify(body.dashboardLayout ?? []));
    if ("onboardingStep" in raw) set("onboarding_step", body.onboardingStep);
    if (sets.length) {
      params.push(me.id);
      await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    }
    return c.json({ user: await publicUser(me.id) });
  });

  app.post("/api/auth/mfa/setup", async (c) => {
    const me = await actor(c);
    const body = z.object({ password: z.string().min(1, "Enter your password.") }).parse(await c.req.json());
    await requirePassword(me.id, body.password);
    const secret = newMfaSecret();
    const updated = await db.query(`UPDATE users SET mfa_secret = $1 WHERE id = $2 AND mfa_enabled = 0 RETURNING id`, [secret, me.id]);
    if (!updated.length) throw new ApiError(400, "Turn off the authenticator before starting again.");
    return c.json({ secret, otpauth: `otpauth://totp/BudgetCents:${me.email}?secret=${secret}&issuer=BudgetCents` });
  });

  app.post("/api/auth/mfa/enable", async (c) => {
    const me = await actor(c);
    const body = z.object({ password: z.string().min(1, "Enter your password."), code: z.string().min(1) }).parse(await c.req.json());
    await requirePassword(me.id, body.password);
    const rows = await db.query(`SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1`, [me.id]);
    if (num(rows[0]?.mfa_enabled) === 1) throw new ApiError(400, "Turn off the authenticator before starting again.");
    const secret = String(rows[0]?.mfa_secret ?? "");
    if (!secret || !verifyTotp(secret, body.code)) throw new ApiError(400, "That code does not match.");
    const codes = Array.from({ length: 8 }, () => randomToken(6));
    const saved = await db.query(`UPDATE users SET mfa_enabled = 1, recovery_hashes = $1 WHERE id = $2 AND mfa_enabled = 0 RETURNING id`, [JSON.stringify(codes.map(sha256)), me.id]);
    if (!saved.length) throw new ApiError(400, "Turn off the authenticator before starting again.");
    return c.json({ recoveryCodes: codes, note: "Store these codes. They are shown once." });
  });

  app.post("/api/auth/mfa/disable", async (c) => {
    const me = await actor(c);
    const body = z.object({ password: z.string().min(1, "Enter your password.") }).parse(await c.req.json());
    await requirePassword(me.id, body.password);
    await db.query(`UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, recovery_hashes = '[]' WHERE id = $1`, [me.id]);
    return c.json({ ok: true });
  });

  app.get("/api/auth/sessions", async (c) => {
    const me = await actor(c);
    const hash = bearerHash(c);
    const rows = await db.query(`SELECT id, token_hash, device_label, user_agent, created_at, expires_at, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`, [me.id]);
    return c.json({
      sessions: rows.map((row) => ({
        id: row.id,
        device_label: row.device_label,
        user_agent: row.user_agent,
        created_at: row.created_at,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        current: row.token_hash === hash,
      })),
    });
  });

  app.delete("/api/auth/sessions/:id", async (c) => {
    const me = await actor(c);
    const hash = bearerHash(c);
    const rows = await db.query(
      `UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL RETURNING token_hash`,
      [nowIso(), c.req.param("id"), me.id],
    );
    return c.json({ ok: true, current: rows[0]?.token_hash === hash });
  });

  app.delete("/api/me", async (c) => {
    const me = await actor(c);
    const body = z.object({ password: z.string(), confirm: z.literal("DELETE") }).parse(await c.req.json());
    const rows = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [me.id]);
    if (!(await verifyPassword(body.password, String(rows[0].password_hash)))) throw new ApiError(401, "Password is incorrect.");
    const owned = await db.query(
      `SELECT h.id FROM households h JOIN memberships m ON m.household_id = h.id AND m.user_id = $1 AND m.role = 'owner'`,
      [me.id],
    );
    for (const household of owned) {
      const others = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1 AND user_id <> $2`, [household.id, me.id]);
      if (others.length) throw new ApiError(409, "Transfer ownership of shared households before deleting your account.");
    }
    await db.tx(async () => {
      for (const household of owned) await db.query(`DELETE FROM households WHERE id = $1`, [household.id]);
      await db.query(`DELETE FROM users WHERE id = $1`, [me.id]);
    });
    return c.json({ ok: true, deleted: true });
  });

  app.get("/api/households", async (c) => c.json({ households: await householdsFor((await actor(c)).id) }));

  app.get("/api/households/:hid/dashboard", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined, c.req.query("month") ?? undefined);
    const guide = guidanceFor(loaded);
    const worth = await withInvestments(loaded);
    await refreshAlerts(me, loaded, guide.guidance.shortageMinor);
    const alerts = await db.query(`SELECT * FROM alerts WHERE user_id = $1 AND household_id = $2 ORDER BY created_at DESC LIMIT 30`, [me.id, loaded.member.householdId]);
    const goals = await db.query(`SELECT * FROM goals WHERE space_id = $1 AND archived = 0`, [loaded.spaceId]);
    return c.json({
      household: loaded.member,
      spaceId: loaded.spaceId,
      spaces: await visibleSpaces(me.id, loaded.member.householdId),
      accounts: publicAccounts(loaded.accounts.filter((account) => account.space_id === loaded.spaceId || account.visibility === "shared")),
      buckets: loaded.input.buckets,
      budget: loaded.budget,
      guidance: guide.guidance,
      ageOfMoney: guide.age,
      explain: guide.explain,
      netWorth: worth,
      upcoming: guide.events,
      goals: goals.map((goal) => ({ ...goal, availableMinor: loaded.budget.buckets.find((row) => row.bucketId === goal.bucket_id)?.availableMinor ?? 0 })),
      alerts,
      recent: loaded.input.transactions.slice(-8).reverse(),
      reviewCount: loaded.input.transactions.filter((txn) => txn.reviewStatus === "needs_review").length,
      labelMode: loaded.member.labelMode,
      funding: fundingFor(loaded),
    });
  });

  app.post("/api/households/:hid/accounts", async (c) => {
    const me = await actor(c);
    const created = await createManualAccount(me, c.req.param("hid"), await c.req.json());
    return c.json(created, 201);
  });

  app.patch("/api/households/:hid/accounts/:id", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const current = await mustAccount(me.id, member.householdId, c.req.param("id"));
    const body = z.object({
      name: z.string().optional(), hidden: z.boolean().optional(), archived: z.boolean().optional(),
      excludeFromNetWorth: z.boolean().optional(), visibility: z.enum(["shared", "private"]).optional(),
      displayOrder: z.number().int().optional(), aprBps: z.number().int().optional(), minimumPaymentMinor: money.optional(),
      creditLimitMinor: money.optional(), linkedAccountId: z.string().nullable().optional(), spaceId: z.string().optional(),
    }).parse(await c.req.json());
    if (body.spaceId) await assertSpace(me.id, member.householdId, body.spaceId);
    await db.query(
      `UPDATE accounts SET name = COALESCE($1, name), hidden = COALESCE($2, hidden), archived = COALESCE($3, archived),
       exclude_from_net_worth = COALESCE($4, exclude_from_net_worth), visibility = COALESCE($5, visibility),
       display_order = COALESCE($6, display_order), apr_bps = COALESCE($7, apr_bps), minimum_payment_minor = COALESCE($8, minimum_payment_minor),
       credit_limit_minor = COALESCE($9, credit_limit_minor), linked_account_id = COALESCE($10, linked_account_id), space_id = COALESCE($11, space_id)
       WHERE id = $12`,
      [body.name ?? null, flag(body.hidden), flag(body.archived), flag(body.excludeFromNetWorth), body.visibility ?? null, body.displayOrder ?? null, body.aprBps ?? null, body.minimumPaymentMinor ?? null, body.creditLimitMinor ?? null, body.linkedAccountId === undefined ? null : body.linkedAccountId, body.spaceId ?? null, current.id],
    );
    return c.json({ ok: true });
  });

  app.get("/api/households/:hid/transactions", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const min = c.req.query("min") ? Number(c.req.query("min")) : null;
    const max = c.req.query("max") ? Number(c.req.query("max")) : null;
    const idFilter = c.req.query("ids");
    const idSet = idFilter ? new Set(idFilter.split(",").map((item) => item.trim()).filter(Boolean)) : null;
    if (idSet && idSet.size > 200) throw new ApiError(400, "Choose a smaller set of transactions.");
    let rows = loaded.input.transactions.filter((txn) => {
      if (idSet && !idSet.has(txn.id)) return false;
      if (q && !`${txn.payee} ${txn.notes ?? ""} ${txn.originalDescription ?? ""} ${txn.checkNumber ?? ""}`.toLowerCase().includes(q)) return false;
      if (c.req.query("accountId") && txn.accountId !== c.req.query("accountId") && txn.counterAccountId !== c.req.query("accountId")) return false;
      if (c.req.query("bucketId") && !txn.splits.some((split) => split.bucketId === c.req.query("bucketId"))) return false;
      if (c.req.query("review") && txn.reviewStatus !== c.req.query("review")) return false;
      if (c.req.query("bank") && txn.bankStatus !== c.req.query("bank")) return false;
      if (c.req.query("tag") && !txn.tags?.includes(c.req.query("tag")!)) return false;
      if (c.req.query("from") && txn.date < c.req.query("from")!) return false;
      if (c.req.query("to") && txn.date > c.req.query("to")!) return false;
      const abs = Math.abs(txn.amountMinor);
      if (min != null && abs < min) return false;
      if (max != null && abs > max) return false;
      return true;
    });
    const sort = c.req.query("sort") === "payee" ? "payee" : "date";
    rows = rows.sort((a, b) => {
      if (sort === "payee") {
        const payee = a.payee.localeCompare(b.payee);
        if (payee !== 0) return payee;
      }
      return a.date === b.date ? b.id.localeCompare(a.id) : a.date < b.date ? 1 : -1;
    });
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limitN = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const page = rows.slice(offset, offset + limitN);
    const links = await db.query(`SELECT keeper_id, archived_id FROM transaction_matches WHERE household_id = $1`, [loaded.member.householdId]);
    const matched = new Map(links.map((link) => [String(link.keeper_id), String(link.archived_id)]));
    const receipts = await db.query(`SELECT transaction_id, count(*) AS n FROM attachments WHERE household_id = $1 AND transaction_id IS NOT NULL GROUP BY transaction_id`, [loaded.member.householdId]);
    const receiptCount = new Map(receipts.map((row) => [String(row.transaction_id), num(row.n)]));
    const nextOffset = offset + page.length < rows.length ? offset + page.length : null;
    return c.json({
      total: rows.length,
      offset,
      limit: limitN,
      sort,
      nextOffset,
      transactions: page.map((txn) => ({ ...txn, matchedArchivedId: matched.get(txn.id) ?? null, attachmentCount: receiptCount.get(txn.id) ?? 0 })),
    });
  });

  app.post("/api/households/:hid/transactions", async (c) => {
    const me = await actor(c);
    const body = transactionSchema.parse(await c.req.json());
    const created = await insertTransaction(me, c.req.param("hid"), body);
    return c.json(created, 201);
  });

  app.patch("/api/households/:hid/transactions/:id", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = transactionSchema.partial().extend({ version: z.number().int(), reason: z.string().optional(), categoryLocked: z.boolean().optional() }).parse(await c.req.json());
    const existing = await mustTxn(me.id, member.householdId, c.req.param("id"));
    if (num(existing.reconciled) === 1 && (body.amountMinor != null || body.accountId != null) && !body.reason) {
      throw new ApiError(409, "This transaction is reconciled. Give a reason to change the amount or account.");
    }
    if (body.refundOfId) {
      if (body.refundOfId === String(existing.id)) throw new ApiError(400, "A transaction cannot refund itself.");
      const original = await mustTxn(me.id, member.householdId, body.refundOfId);
      if (str(original.refund_of_id) === String(existing.id)) throw new ApiError(400, "Those two transactions already point at each other.");
      const nextType = body.type ?? String(existing.type);
      if (nextType !== "refund" && nextType !== "reimbursement") throw new ApiError(400, "Only a refund or reimbursement can point at another transaction.");
    }
    const accountId = body.accountId ?? String(existing.account_id);
    const counterAccountId = body.counterAccountId ?? str(existing.counter_account_id);
    const account = await mustAccount(me.id, member.householdId, accountId);
    if (counterAccountId) await mustAccount(me.id, member.householdId, counterAccountId);
    if (body.splits) {
      for (const split of body.splits) {
        if (!split.bucketId) continue;
        const bucket = await db.query(`SELECT space_id FROM buckets WHERE id = $1 AND household_id = $2`, [split.bucketId, member.householdId]);
        if (!bucket.length) throw new ApiError(404, "Not found");
        await assertSpace(me.id, member.householdId, String(bucket[0].space_id));
      }
    }
    const splits = body.splits ? body.splits.map(splitFromInput) : await splitsOf(String(existing.id));
    const resulting = transactionFromRow(existing, splits, {
      date: body.date,
      payee: body.payee,
      notes: body.notes,
      amountMinor: body.amountMinor,
      reviewStatus: body.reviewStatus,
      bankStatus: body.bankStatus,
      flag: body.flag,
      accountId,
      counterAccountId,
      type: body.type as Transaction["type"] | undefined,
      currency: String(account.currency),
    });
    const accounts = await loadEngineAccounts(member.householdId, [resulting.accountId, resulting.counterAccountId]);
    validateTransaction(resulting, accounts, String(account.currency));
    await db.tx(async () => {
      const updated = await db.query(
        `UPDATE transactions SET date = COALESCE($1, date), payee = COALESCE($2, payee), notes = COALESCE($3, notes), amount_minor = COALESCE($4, amount_minor),
         review_status = COALESCE($5, review_status), bank_status = COALESCE($6, bank_status), flag = COALESCE($7, flag), category_locked = COALESCE($8, category_locked),
         account_id = $9, counter_account_id = $10, type = COALESCE($11, type), currency = $12, space_id = $13,
         check_number = COALESCE($14, check_number), refund_of_id = COALESCE($15, refund_of_id),
         version = version + 1, updated_at = $16
         WHERE id = $17 AND household_id = $18 AND version = $19 AND deleted = 0 RETURNING id`,
        [
          body.date ?? null, body.payee ?? null, body.notes ?? null, body.amountMinor ?? null, body.reviewStatus ?? null, body.bankStatus ?? null, body.flag ?? null,
          body.categoryLocked == null ? null : body.categoryLocked ? 1 : 0, accountId, counterAccountId ?? null, body.type ?? null, account.currency, account.space_id,
          body.checkNumber ?? null, body.refundOfId ?? null, nowIso(), existing.id, member.householdId, body.version,
        ],
      );
      if (!updated.length) throw new ApiError(409, "Someone else changed this transaction. Reload it and try again.");
      if (body.splits) await replaceSplits(String(existing.id), body.splits);
      if (body.tags) await replaceTags(String(existing.id), body.tags);
      await audit(db, member.householdId, me.id, "transaction.update", body.reason ?? "Edited transaction", "transaction", String(existing.id));
    });
    return c.json({ ok: true });
  });

  app.delete("/api/households/:hid/transactions/:id", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const existing = await mustTxn(me.id, member.householdId, c.req.param("id"));
    if (num(existing.reconciled) === 1) throw new ApiError(409, "Unreconcile this transaction before deleting it.");
    await db.query(`UPDATE transactions SET deleted = 1, updated_at = $1 WHERE id = $2`, [nowIso(), existing.id]);
    await audit(db, member.householdId, me.id, "transaction.delete", "Deleted transaction", "transaction", String(existing.id));
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/transactions/bulk", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({
      ids: z.array(z.string()).min(1),
      reviewStatus: z.enum(["needs_review", "reviewed"]).optional(),
      tag: z.string().optional(),
      bucketId: z.string().optional(),
      deleted: z.boolean().optional(),
    }).parse(await c.req.json());
    const prepared: { existing: Awaited<ReturnType<typeof mustTxn>>; splits: Transaction["splits"] }[] = [];
    for (const txnId of body.ids) {
      const existing = await mustTxn(me.id, member.householdId, txnId);
      let splits = await splitsOf(txnId);
      if (body.bucketId) {
        splits = [{ bucketId: body.bucketId, amountMinor: Math.abs(num(existing.amount_minor)), role: num(existing.amount_minor) >= 0 ? "income" : "expense" }];
      }
      const draft = transactionFromRow(existing, splits, { reviewStatus: body.reviewStatus });
      const accounts = await loadEngineAccounts(member.householdId, [draft.accountId, draft.counterAccountId]);
      validateTransaction(draft, accounts, draft.currency);
      prepared.push({ existing, splits });
    }
    await db.tx(async () => {
      for (const { existing } of prepared) {
        const txnId = String(existing.id);
        if (body.deleted) {
          if (num(existing.reconciled) === 1) continue;
          await db.query(`UPDATE transactions SET deleted = 1, updated_at = $1 WHERE id = $2 AND household_id = $3`, [nowIso(), txnId, member.householdId]);
        }
        if (body.reviewStatus) await db.query(`UPDATE transactions SET review_status = $1, updated_at = $2 WHERE id = $3 AND household_id = $4`, [body.reviewStatus, nowIso(), txnId, member.householdId]);
        if (body.tag) await db.query(`INSERT INTO transaction_tags (transaction_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [txnId, body.tag]);
        if (body.bucketId) {
          await replaceSplits(txnId, [{ bucketId: body.bucketId, amountMinor: Math.abs(num(existing.amount_minor)), role: num(existing.amount_minor) >= 0 ? "income" : "expense" }]);
          await db.query(`UPDATE transactions SET category_locked = 1, updated_at = $1 WHERE id = $2 AND household_id = $3`, [nowIso(), txnId, member.householdId]);
        }
      }
      await audit(db, member.householdId, me.id, "transaction.bulk", `Updated ${body.ids.length} transactions`);
    });
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/transactions/:id/match", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ otherId: z.string() }).parse(await c.req.json());
    const keeper = await mustTxn(me.id, member.householdId, c.req.param("id"));
    const incoming = await mustTxn(me.id, member.householdId, body.otherId);
    const problem = matchProblem(
      { id: String(keeper.id), accountId: String(keeper.account_id), amountMinor: num(keeper.amount_minor), currency: String(keeper.currency), providerTransactionId: str(keeper.provider_transaction_id), reconciled: num(keeper.reconciled) === 1, type: String(keeper.type) },
      { id: String(incoming.id), accountId: String(incoming.account_id), amountMinor: num(incoming.amount_minor), currency: String(incoming.currency), providerTransactionId: str(incoming.provider_transaction_id), reconciled: num(incoming.reconciled) === 1, type: String(incoming.type) },
    );
    if (problem) throw new ApiError(400, problem);
    const existing = await db.query(
      `SELECT id FROM transaction_matches WHERE household_id = $1 AND (keeper_id IN ($2,$3) OR archived_id IN ($2,$3))`,
      [member.householdId, keeper.id, incoming.id],
    );
    if (existing.length) throw new ApiError(409, "One of these transactions is already matched. Unmatch it first.");
    await db.tx(async () => {
      const attachments = await db.query(`SELECT id FROM attachments WHERE household_id = $1 AND transaction_id = $2`, [member.householdId, incoming.id]);
      const moved = attachments.map((row) => String(row.id));
      await db.query(`UPDATE transactions SET deleted = 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0`, [nowIso(), incoming.id, member.householdId]);
      const copyProvider = !str(keeper.provider_transaction_id) && !!str(incoming.provider_transaction_id);
      if (copyProvider) {
        await db.query(
          `UPDATE transactions SET provider_transaction_id = $1, original_description = COALESCE(original_description, $2), import_batch_id = COALESCE(import_batch_id, $3), bank_status = $4, version = version + 1, updated_at = $5
           WHERE id = $6 AND household_id = $7`,
          [incoming.provider_transaction_id, incoming.original_description, incoming.import_batch_id, incoming.bank_status, nowIso(), keeper.id, member.householdId],
        );
      }
      if (moved.length) await db.query(`UPDATE attachments SET transaction_id = $1 WHERE household_id = $2 AND transaction_id = $3`, [keeper.id, member.householdId, incoming.id]);
      await db.query(
        `INSERT INTO transaction_matches (id, household_id, keeper_id, archived_id, provider_copied, moved_attachment_ids, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id(), member.householdId, keeper.id, incoming.id, copyProvider ? 1 : 0, JSON.stringify(moved), nowIso()],
      );
      await db.query(`UPDATE income_occurrences SET transaction_id = $1, updated_at = $2 WHERE household_id = $3 AND transaction_id = $4`, [keeper.id, nowIso(), member.householdId, incoming.id]);
      await db.query(`UPDATE income_occurrences SET extra_transaction_id = $1, updated_at = $2 WHERE household_id = $3 AND extra_transaction_id = $4`, [keeper.id, nowIso(), member.householdId, incoming.id]);
      await audit(db, member.householdId, me.id, "transaction.match", "Matched two records of the same money", "transaction", String(keeper.id));
    });
    return c.json({ ok: true, keeperId: keeper.id, archivedId: incoming.id, note: "Notes, tags, review, and the keeper amount stayed. The other record is hidden so it is not counted twice." });
  });

  app.post("/api/households/:hid/transactions/:id/unmatch", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const txnId = c.req.param("id");
    const links = await db.query(
      `SELECT * FROM transaction_matches WHERE household_id = $1 AND (keeper_id = $2 OR archived_id = $2)`,
      [member.householdId, txnId],
    );
    if (!links.length) throw new ApiError(404, "That transaction is not matched.");
    const link = links[0];
    await mustTxn(me.id, member.householdId, String(link.keeper_id));
    const archived = await db.query(`SELECT * FROM transactions WHERE id = $1 AND household_id = $2`, [link.archived_id, member.householdId]);
    if (!archived.length) throw new ApiError(404, "Not found");
    const archivedAccount = await db.query(`SELECT * FROM accounts WHERE id = $1 AND household_id = $2`, [archived[0].account_id, member.householdId]);
    if (!archivedAccount.length || !canSeeAccount(me.id, { visibility: String(archivedAccount[0].visibility), owner_user_id: str(archivedAccount[0].owner_user_id) ?? null })) throw new ApiError(404, "Not found");
    await db.tx(async () => {
      if (num(link.provider_copied) === 1) {
        await db.query(
          `UPDATE transactions SET provider_transaction_id = NULL, version = version + 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND provider_transaction_id = $4`,
          [nowIso(), link.keeper_id, member.householdId, archived[0].provider_transaction_id],
        );
      }
      await db.query(`UPDATE transactions SET deleted = 0, updated_at = $1 WHERE id = $2 AND household_id = $3`, [nowIso(), link.archived_id, member.householdId]);
      const moved = JSON.parse(String(link.moved_attachment_ids || "[]")) as string[];
      for (const attachmentId of moved) {
        await db.query(`UPDATE attachments SET transaction_id = $1 WHERE id = $2 AND household_id = $3`, [link.archived_id, attachmentId, member.householdId]);
      }
      await db.query(`DELETE FROM transaction_matches WHERE id = $1 AND household_id = $2`, [link.id, member.householdId]);
      await audit(db, member.householdId, me.id, "transaction.unmatch", "Restored the separate records", "transaction", String(link.keeper_id));
    });
    return c.json({ ok: true, restoredId: link.archived_id, note: "The hidden record is back in the register with its original amount." });
  });

  app.post("/api/households/:hid/transactions/:id/duplicate", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const existing = await mustTxn(me.id, member.householdId, c.req.param("id"));
    const splits = await splitsOf(String(existing.id));
    const tags = await db.query(`SELECT tag FROM transaction_tags WHERE transaction_id = $1`, [existing.id]);
    const created = await insertTransaction(me, member.householdId, {
      date: String(existing.date),
      accountId: String(existing.account_id),
      counterAccountId: str(existing.counter_account_id),
      amountMinor: num(existing.amount_minor),
      type: String(existing.type),
      payee: String(existing.payee),
      originalDescription: str(existing.original_description),
      splits,
      bankStatus: String(existing.bank_status) === "pending" ? "pending" : "posted",
      reviewStatus: "needs_review",
      notes: str(existing.notes),
      tags: tags.map((row) => String(row.tag)),
      flag: str(existing.flag),
      checkNumber: str(existing.check_number),
      categoryLocked: true,
      refundOfId: str(existing.refund_of_id),
      opId: `dup-${id()}`,
    });
    return c.json({ ...created, note: "This is a new transaction. The original was not changed, and the provider id was not copied." }, 201);
  });

  app.get("/api/households/:hid/views", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const rows = await db.query(`SELECT id, name, query_json, created_at FROM saved_views WHERE household_id = $1 AND user_id = $2 ORDER BY created_at`, [member.householdId, me.id]);
    return c.json({ views: rows.map((row) => ({ id: row.id, name: row.name, query: JSON.parse(String(row.query_json)), createdAt: row.created_at })) });
  });

  app.post("/api/households/:hid/views", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({
      name: z.string().min(1).max(80),
      query: z.object({
        q: z.string().optional(),
        accountId: z.string().optional(),
        bucketId: z.string().optional(),
        review: z.string().optional(),
        tag: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        sort: z.string().optional(),
      }),
    }).parse(await c.req.json());
    const viewId = id();
    await db.query(`INSERT INTO saved_views (id, household_id, user_id, name, query_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [viewId, member.householdId, me.id, body.name, JSON.stringify(body.query), nowIso()]);
    return c.json({ id: viewId }, 201);
  });

  app.patch("/api/households/:hid/views/:id", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({
      name: z.string().min(1).max(80),
      query: z.object({
        q: z.string().optional(),
        accountId: z.string().optional(),
        bucketId: z.string().optional(),
        review: z.string().optional(),
        tag: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        sort: z.string().optional(),
      }),
    }).parse(await c.req.json());
    const updated = await db.query(
      `UPDATE saved_views SET name = $1, query_json = $2 WHERE id = $3 AND household_id = $4 AND user_id = $5 RETURNING id`,
      [body.name, JSON.stringify(body.query), c.req.param("id"), member.householdId, me.id],
    );
    if (!updated.length) throw new ApiError(404, "Not found");
    return c.json({ ok: true });
  });

  app.delete("/api/households/:hid/views/:id", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const removed = await db.query(`DELETE FROM saved_views WHERE id = $1 AND household_id = $2 AND user_id = $3 RETURNING id`, [c.req.param("id"), member.householdId, me.id]);
    if (!removed.length) throw new ApiError(404, "Not found");
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/assignments", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertBudget(member);
    const body = z.object({ spaceId: z.string(), bucketId: z.string(), periodKey: z.string(), amountMinor: money }).parse(await c.req.json());
    await assertSpace(me.id, member.householdId, body.spaceId);
    await assertBucket(member.householdId, body.spaceId, body.bucketId);
    await db.tx(async () => {
      await lockHousehold(db, member.householdId);
      await setAssignment(db, member.householdId, body.spaceId, body.bucketId, body.periodKey, body.amountMinor);
      await audit(db, member.householdId, me.id, "assign", "Updated an assignment");
    });
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/move", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertBudget(member);
    const body = z.object({ spaceId: z.string(), fromBucketId: z.string().nullable(), toBucketId: z.string().nullable(), periodKey: z.string(), amountMinor: money.positive() }).parse(await c.req.json());
    if (body.fromBucketId) await assertBucket(member.householdId, body.spaceId, body.fromBucketId);
    if (body.toBucketId) await assertBucket(member.householdId, body.spaceId, body.toBucketId);
    if (!body.fromBucketId && !body.toBucketId) throw new ApiError(400, "Choose a source or a destination.");
    await db.tx(async () => {
      await lockHousehold(db, member.householdId);
      const loaded = await loadSpace(db, me, member.householdId, body.spaceId);
      const adjust = async (bucketId: string, delta: number) => {
        const current = loaded.budget.buckets.find((row) => row.bucketId === bucketId)?.assignedMinor ?? 0;
        await setAssignment(db, member.householdId, body.spaceId, bucketId, body.periodKey, current + delta);
      };
      if (body.fromBucketId) await adjust(body.fromBucketId, -body.amountMinor);
      if (body.toBucketId) await adjust(body.toBucketId, body.amountMinor);
    });
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/auto-assign", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertBudget(member);
    const body = z.object({ spaceId: z.string(), strategy: z.enum(["underfunded", "previous", "spending", "average"]), apply: z.boolean().default(false) }).parse(await c.req.json());
    const loaded = await loadSpace(db, me, member.householdId, body.spaceId);
    const eligible = eligiblePostedIncomeMinor({
      transactions: loaded.input.transactions,
      accounts: loaded.input.accounts,
      currency: loaded.input.currency,
      from: loaded.budget.periodStart,
      to: loaded.budget.periodEnd,
    });
    const preview = previewAutoAssign({ result: loaded.budget, buckets: loaded.input.buckets, strategy: body.strategy, postedIncomeMinor: eligible });
    let lines = preview.lines;
    if (body.apply) {
      lines = await db.tx(async () => {
        await lockHousehold(db, member.householdId);
        const fresh = await loadSpace(db, me, member.householdId, body.spaceId);
        const freshEligible = eligiblePostedIncomeMinor({
          transactions: fresh.input.transactions,
          accounts: fresh.input.accounts,
          currency: fresh.input.currency,
          from: fresh.budget.periodStart,
          to: fresh.budget.periodEnd,
        });
        const again = previewAutoAssign({ result: fresh.budget, buckets: fresh.input.buckets, strategy: body.strategy, postedIncomeMinor: freshEligible });
        const applied = [];
        let ready = Math.max(0, fresh.budget.readyToAssignMinor);
        for (const line of again.lines) {
          const give = Math.min(line.amountMinor, ready);
          if (give <= 0) continue;
          const current = fresh.budget.buckets.find((row) => row.bucketId === line.bucketId)?.assignedMinor ?? 0;
          await setAssignment(db, member.householdId, body.spaceId, line.bucketId, fresh.budget.periodKey, current + give);
          ready -= give;
          applied.push({ ...line, amountMinor: give });
        }
        return applied;
      });
    }
    return c.json({ ...preview, lines, eligiblePostedIncomeMinor: eligible, note: "Automatic assignment stops when Ready to Assign reaches zero." });
  });

  app.get("/api/households/:hid/schedules", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    return c.json({ schedules: loaded.input.schedules ?? [] });
  });

  app.get("/api/households/:hid/income-plan", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const expected = (loaded.input.schedules ?? []).filter((schedule) => schedule.direction === "inflow" && !schedule.paused).reduce((sum, schedule) => sum + schedule.amountMinor, 0);
    const plan = evaluateIncomePlan(loaded.input.planLines ?? [], expected, loaded.budget.periodKey);
    return c.json({ ...plan, lines: loaded.input.planLines ?? [], periodKey: loaded.budget.periodKey, spaceId: loaded.spaceId });
  });

  app.put("/api/households/:hid/income-plan", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertBudget(member);
    const body = z.object({
      spaceId: z.string(),
      periodKey: z.string(),
      lines: z.array(z.object({ bucketId: z.string(), plannedMinor: money })),
    }).parse(await c.req.json());
    await assertSpace(me.id, member.householdId, body.spaceId);
    for (const line of body.lines) {
      if (line.plannedMinor === 0) continue;
      await assertBucket(member.householdId, body.spaceId, line.bucketId);
    }
    await db.tx(async () => {
      await db.query(`DELETE FROM plan_lines WHERE household_id = $1 AND space_id = $2 AND period_key = $3`, [member.householdId, body.spaceId, body.periodKey]);
      for (const line of body.lines) {
        if (line.plannedMinor === 0) continue;
        await db.query(
          `INSERT INTO plan_lines (id, household_id, space_id, bucket_id, period_key, planned_minor) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id(), member.householdId, body.spaceId, line.bucketId, body.periodKey, line.plannedMinor],
        );
      }
    });
    await audit(db, member.householdId, me.id, "income_plan", "Updated the income plan");
    return c.json({ ok: true, note: "This plan does not fund envelopes until the money arrives and is assigned." });
  });

  app.get("/api/households/:hid/members", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const people = await db.query(
      `SELECT u.id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = $1 AND u.deleted_at IS NULL ORDER BY u.display_name`,
      [member.householdId],
    );
    const invitations = ["owner", "admin"].includes(member.role)
      ? await db.query(`SELECT id, email, role, expires_at, created_at FROM invitations WHERE household_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [member.householdId])
      : [];
    return c.json({
      members: people.map((person) => ({ id: person.id, displayName: person.display_name, role: person.role, you: person.id === me.id })),
      invitations,
    });
  });

  app.post("/api/households/:hid/buckets", async (c) => {
    const me = await actor(c);
    const created = await createManualCategory(me, c.req.param("hid"), await c.req.json());
    return c.json(created, 201);
  });

  app.patch("/api/households/:hid/buckets/:id", async (c) => {
    const me = await actor(c);
    const body = categoryEditSchema.parse(await c.req.json());
    if (body.target) targetJson(body.target);
    const saved = await saveCategory(db, me, c.req.param("hid"), c.req.param("id"), {
      ...body,
      icon: body.icon ?? null,
      rolloverCapMinor: body.rolloverCapMinor ?? null,
      purpose: body.purpose ?? null,
      target: body.target ?? null,
    });
    return c.json(saved);
  });

  app.get("/api/households/:hid/fills", async (c) => {
    const me = await actor(c);
    return c.json(await listFills(db, me, c.req.param("hid")));
  });

  app.post("/api/households/:hid/fills", async (c) => {
    const me = await actor(c);
    const body = fillTemplateSchema.parse(await c.req.json());
    return c.json(await saveFillTemplate(db, me, c.req.param("hid"), null, body), 201);
  });

  app.patch("/api/households/:hid/fills/:id", async (c) => {
    const me = await actor(c);
    const body = fillTemplateSchema.parse(await c.req.json());
    return c.json(await saveFillTemplate(db, me, c.req.param("hid"), c.req.param("id"), body));
  });

  app.post("/api/households/:hid/fills/preview", async (c) => {
    const me = await actor(c);
    const body = fillTemplateSchema.parse(await c.req.json());
    return c.json(await previewFill(db, me, c.req.param("hid"), body, c.req.query("today") ?? undefined));
  });

  app.post("/api/households/:hid/fills/due", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertAdmin(member);
    return c.json(await runDueFills(db, { householdId: member.householdId, today: c.req.query("today") ?? undefined }));
  });

  app.post("/api/households/:hid/fills/:id/pause", async (c) => {
    const me = await actor(c);
    return c.json(await setFillPaused(db, me, c.req.param("hid"), c.req.param("id"), true));
  });

  app.post("/api/households/:hid/fills/:id/resume", async (c) => {
    const me = await actor(c);
    return c.json(await setFillPaused(db, me, c.req.param("hid"), c.req.param("id"), false, c.req.query("today") ?? undefined));
  });

  app.post("/api/households/:hid/fills/:id/preview", async (c) => {
    const me = await actor(c);
    const listed = await listFills(db, me, c.req.param("hid"));
    const template = listed.fills.find((fill) => fill.id === c.req.param("id"));
    if (!template) throw new ApiError(404, "Not found");
    return c.json(await previewFill(db, me, c.req.param("hid"), template, c.req.query("today") ?? undefined));
  });

  app.post("/api/households/:hid/fills/:id/run", async (c) => {
    const me = await actor(c);
    return c.json(await runFill(db, me, c.req.param("hid"), c.req.param("id"), c.req.query("today") ?? undefined));
  });

  app.post("/api/households/:hid/fills/:id/skip", async (c) => {
    const me = await actor(c);
    return c.json(await skipFill(db, me, c.req.param("hid"), c.req.param("id")));
  });

  app.delete("/api/households/:hid/fills/:id", async (c) => {
    const me = await actor(c);
    return c.json(await deleteFill(db, me, c.req.param("hid"), c.req.param("id")));
  });

  app.get("/api/households/:hid/fills/:id/history", async (c) => {
    const me = await actor(c);
    return c.json(await fillHistory(db, me, c.req.param("hid"), c.req.param("id")));
  });

  app.get("/api/households/:hid/forecast", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const requestedDays = Number(c.req.query("days") ?? 30);
    const days = Math.min(370, Math.max(1, Number.isFinite(requestedDays) ? Math.trunc(requestedDays) : 30));
    const accountId = c.req.query("accountId") || undefined;
    let starting = loaded.budget.cashPoolMinor;
    let accountName: string | null = null;
    if (accountId) {
      const account = await mustAccount(me.id, loaded.member.householdId, accountId);
      await assertSpace(me.id, loaded.member.householdId, String(account.space_id));
      const domainAccount: Account = {
        id: String(account.id),
        name: String(account.name),
        kind: String(account.kind) as Account["kind"],
        currency: String(account.currency),
        onBudget: num(account.on_budget) === 1,
        archived: num(account.archived) === 1,
        excludeFromNetWorth: num(account.exclude_from_net_worth) === 1,
      };
      if (!isOnBudgetCash(domainAccount)) throw new ApiError(400, "Choose a cash account. The forecast starts from cash, not a card or loan balance.");
      starting = displayBalance(domainAccount, loaded.balanceTransactions, loaded.input.asOf);
      accountName = domainAccount.name;
    }
    const guide = guidanceFor(loaded, days);
    const income = await expectedIncomeEvents(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const events = [...guide.events, ...income].filter((event) => !accountId || event.accountId === accountId);
    const cash = projectCash({ startingMinor: starting, startDate: loaded.input.asOf, days, events, includeExpectedIncome: false });
    const plan = projectCash({ startingMinor: starting, startDate: loaded.input.asOf, days, events, includeExpectedIncome: true });
    return c.json({
      cash, plan, paycheck: planView(loaded), guidance: guide.guidance, spaceId: loaded.spaceId,
      asOf: loaded.input.asOf, days, accountId: accountId ?? null, accountName, startingMinor: starting,
      note: accountId
        ? "This forecast is one cash account. It includes bills and paychecks assigned to that account. Cash and expected income stay separate."
        : "The cash projection does not spend a paycheck that has not arrived. The plan view is labeled separately.",
    });
  });

  app.post("/api/households/:hid/scenarios", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({
      spaceId: z.string(), name: z.string(), days: z.number().int().default(30),
      adjustments: z.array(z.object({ id: z.string(), label: z.string(), date: z.string(), amountMinor: money, kind: z.enum(["income", "expense", "transfer", "plan"]) })),
      save: z.boolean().default(true),
    }).parse(await c.req.json());
    const loaded = await loadSpace(db, me, member.householdId, body.spaceId);
    const guide = guidanceFor(loaded, body.days);
    const events = applyScenario(guide.events.map((event) => ({ ...event, kind: event.kind })), body.adjustments);
    const projection = projectCash({ startingMinor: loaded.budget.cashPoolMinor, startDate: loaded.input.asOf, days: body.days, events, includeExpectedIncome: false });
    if (body.save) {
      await db.query(`INSERT INTO scenarios (id, household_id, space_id, name, adjustments_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id(), member.householdId, body.spaceId, body.name, JSON.stringify(body.adjustments), nowIso()]);
    }
    return c.json({ projection, note: "This scenario is not part of the ledger until you add the transactions yourself." });
  });

  app.get("/api/households/:hid/debts", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const strategy = (c.req.query("strategy") ?? "snowball") as "snowball" | "avalanche" | "custom";
    return c.json(debtPlan(loaded, strategy, Number(c.req.query("extra") ?? 0)));
  });

  app.post("/api/households/:hid/loans/amortize", async (c) => {
    const me = await actor(c);
    await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({
      balanceMinor: money, aprBps: z.number().int(), minPaymentMinor: money, extraMinor: money.optional(), startDate: z.string(),
      events: z.array(z.object({ monthIndex: z.number().int(), extraOneTimeMinor: money.optional(), aprBps: z.number().int().optional(), paymentMinor: money.optional(), holiday: z.boolean().optional() })).optional(),
      refinance: z.object({ newAprBps: z.number().int(), newPaymentMinor: money, feeMinor: money }).optional(),
    }).parse(await c.req.json());
    const schedule = amortize({ id: "loan", name: "Loan", balanceMinor: body.balanceMinor, aprBps: body.aprBps, minPaymentMinor: body.minPaymentMinor, extraMinor: body.extraMinor }, body.startDate, body.events);
    const refinance = body.refinance ? compareRefinance({ balanceMinor: body.balanceMinor, aprBps: body.aprBps, paymentMinor: body.minPaymentMinor, newAprBps: body.refinance.newAprBps, newPaymentMinor: body.refinance.newPaymentMinor, feeMinor: body.refinance.feeMinor, startDate: body.startDate }) : null;
    return c.json({ schedule, refinance });
  });

  app.post("/api/households/:hid/retirement", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({
      currentAge: z.number().int(), retireAge: z.number().int(), endAge: z.number().int(),
      portfolioMinor: money, annualContributionMinor: money, annualSpendingMinor: money,
      inflationBps: z.number().int(), meanReturnBps: z.number().int(), stdevBps: z.number().int(), feeBps: z.number().int(),
      iterations: z.number().int().max(2000).default(200), seed: z.number().int().default(1),
      socialSecurityAnnualMinor: money.default(0), pensionAnnualMinor: money.default(0),
      events: z.array(z.object({ age: z.number().int(), amountMinor: money, label: z.string() })).optional(),
      targetPortfolioMinor: money.optional(),
    }).parse(await c.req.json());
    const result = projectRetirement({
      people: [{ currentAge: body.currentAge, retireAge: body.retireAge, socialSecurityAnnualMinor: body.socialSecurityAnnualMinor, pensionAnnualMinor: body.pensionAnnualMinor }],
      currentAge: body.currentAge, endAge: body.endAge, portfolioMinor: body.portfolioMinor,
      annualContributionMinor: body.annualContributionMinor, annualSpendingMinor: body.annualSpendingMinor,
      inflationBps: body.inflationBps, meanReturnBps: body.meanReturnBps, stdevBps: body.stdevBps, feeBps: body.feeBps,
      iterations: body.iterations, seed: body.seed, events: body.events,
    });
    const gap = body.targetPortfolioMinor ? contributionGap({ targetPortfolioMinor: body.targetPortfolioMinor, currentPortfolioMinor: body.portfolioMinor, years: Math.max(1, body.retireAge - body.currentAge), growthBps: body.meanReturnBps - body.feeBps }) : null;
    await db.query(`INSERT INTO scenarios (id, household_id, space_id, name, adjustments_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id(), member.householdId, (await visibleSpaces(me.id, member.householdId))[0].id, "Retirement model", JSON.stringify({ kind: "retirement", body }), nowIso()]);
    return c.json({ result, contributionGap: gap });
  });

  app.get("/api/households/:hid/investments", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const holdings = await db.query(`SELECT * FROM holdings WHERE household_id = $1`, [member.householdId]);
    const accountRows = await db.query(`SELECT id, visibility, owner_user_id FROM accounts WHERE household_id = $1`, [member.householdId]);
    const visibleAccounts = new Set(accountRows.filter((account) => canSeeAccount(me.id, { visibility: String(account.visibility), owner_user_id: str(account.owner_user_id) ?? null })).map((account) => String(account.id)));
    const quotes = await db.query(`SELECT * FROM quotes WHERE household_id = $1`, [member.householdId]);
    const positions = holdings.filter((row) => visibleAccounts.has(String(row.account_id))).map((row) => {
      const quote = quotes.find((item) => item.symbol === row.symbol);
      return positionView(mapHolding(row), quote ? mapQuote(quote) : undefined);
    });
    const priced = positions.filter((row) => row.marketValueMinor != null);
    const slices = allocation(priced.map((row) => ({ key: String(holdings.find((item) => item.id === row.holdingId)?.asset_class ?? row.symbol), valueMinor: row.marketValueMinor! })));
    return c.json({
      positions,
      allocation: slices,
      drift: allocationDrift(slices, []),
      note: "Missing prices stay missing. Manual prices are labeled manual.",
    });
  });

  app.post("/api/households/:hid/holdings", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({
      accountId: z.string(), symbol: z.string(), name: z.string(), assetClass: z.string(), sector: z.string().optional(),
      geography: z.string().optional(), quantity: z.string(), costBasisMinor: money.nullable().optional(), currency: z.string().length(3),
      priceMinor: money.optional(), priceAsOf: z.string().optional(),
    }).parse(await c.req.json());
    await mustAccount(me.id, member.householdId, body.accountId);
    const holdingId = id();
    await db.query(
      `INSERT INTO holdings (id, household_id, account_id, symbol, name, asset_class, sector, geography, quantity, cost_basis_minor, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [holdingId, member.householdId, body.accountId, body.symbol.toUpperCase(), body.name, body.assetClass, body.sector ?? null, body.geography ?? null, body.quantity, body.costBasisMinor ?? null, body.currency],
    );
    if (body.priceMinor != null) {
      await db.query(`INSERT INTO quotes (id, household_id, symbol, price_minor, as_of, source, delayed, currency) VALUES ($1,$2,$3,$4,$5,'manual',1,$6)`, [id(), member.householdId, body.symbol.toUpperCase(), body.priceMinor, body.priceAsOf ?? localDate(member.timeZone), body.currency]);
    }
    return c.json({ id: holdingId, quoteSource: body.priceMinor == null ? "missing" : "manual" }, 201);
  });

  app.post("/api/households/:hid/fees", async (c) => {
    await actor(c);
    const body = z.object({ balanceMinor: money, expenseRatioBps: z.number().int(), advisoryBps: z.number().int().default(0), growthBps: z.number().int(), years: z.number().int().max(80) }).parse(await c.req.json());
    return c.json(feeImpact(body));
  });

  app.get("/api/households/:hid/reports/:kind", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const from = c.req.query("from") ?? loaded.budget.periodStart;
    const to = c.req.query("to") ?? loaded.input.asOf;
    const kind = c.req.param("kind");
    if (kind === "spending") {
      const group = c.req.query("by") ?? "bucket";
      const rows = spendingRows(loaded.input, from, to, (txn, bucketId) => {
        if (group === "payee") return txn.payee;
        if (group === "tag") return txn.tags?.[0] ?? "Untagged";
        const bucket = loaded.input.buckets.find((item) => item.id === bucketId);
        return bucket?.name ?? "Uncategorized";
      });
      const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);
      return c.json({ rows, totalMinor: total, currency: loaded.member.currency, from, to, formula: "Transfers and card payments are excluded. Refunds reduce the total." });
    }
    if (kind === "income") return c.json({ rows: incomeRows(loaded.input, from, to), from, to, currency: loaded.member.currency, formula: "This is income that posted. Expected pay is not included. Transfers and refunds are not income." });
    if (kind === "sankey") return c.json({ ...cashFlowSankey(loaded.input, from, to), from, to, currency: loaded.member.currency, formula: "Transfers and card payments are not spending. Refunds reduce the spending flow." });
    if (kind === "savings-rate") {
      const income = incomeRows(loaded.input, from, to).reduce((sum, row) => sum + row.amountMinor, 0);
      const spending = spendingRows(loaded.input, from, to, () => "all").reduce((sum, row) => sum + row.amountMinor, 0);
      return c.json({ ...savingsRate(income, spending), incomeMinor: income, spendingMinor: spending });
    }
    if (kind === "watchlist") {
      const spec = { id: "ad-hoc", name: "Watch", payees: c.req.query("payee") ? [c.req.query("payee")!] : undefined, tags: c.req.query("tag") ? [c.req.query("tag")!] : undefined, from, to };
      return c.json(evaluateWatchlist(spec, loaded.input, loaded.input.asOf));
    }
    throw new ApiError(404, "Unknown report");
  });

  app.get("/api/households/:hid/exports/transactions.csv", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined);
    const csv = toCsv(loaded.input.transactions.map((txn) => ({
      Date: txn.date, Payee: txn.payee, Amount: (txn.amountMinor / 100).toFixed(2), Account: txn.accountId,
      Category: txn.splits.map((split) => split.bucketId ?? "").join("|"), Check: txn.checkNumber ?? "", Notes: txn.notes ?? "",
      RefundOf: txn.refundOfId ?? "",
    })));
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=budgetcents-transactions.csv" } });
  });

  app.get("/api/households/:hid/exports/report.pdf", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined);
    const lines = loaded.budget.buckets.filter((row) => !row.name.includes("Borrowed")).map((row) => `${row.name} available ${(row.availableMinor / 100).toFixed(2)}`);
    return new Response(new Uint8Array(textPdf("BudgetCents report", lines)), { headers: { "content-type": "application/pdf" } });
  });

  app.get("/api/households/:hid/backup", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const accounts = (await db.query(`SELECT * FROM accounts WHERE household_id = $1`, [member.householdId])).filter((account) => canSeeAccount(me.id, { visibility: String(account.visibility), owner_user_id: str(account.owner_user_id) ?? null }));
    const ids = new Set(accounts.map((account) => String(account.id)));
    const spaces = await visibleSpaces(me.id, member.householdId);
    const spaceIds = new Set(spaces.map((space) => String(space.id)));
    const transactions = (await db.query(`SELECT * FROM transactions WHERE household_id = $1 AND deleted = 0`, [member.householdId])).filter((txn) => ids.has(String(txn.account_id)) && (!txn.counter_account_id || ids.has(String(txn.counter_account_id))));
    const txnIds = transactions.map((txn) => String(txn.id));
    const splits = txnIds.length ? await db.query(`SELECT * FROM splits WHERE transaction_id IN (${txnIds.map((_, index) => `$${index + 1}`).join(",")})`, txnIds) : [];
    const tags = txnIds.length ? await db.query(`SELECT * FROM transaction_tags WHERE transaction_id IN (${txnIds.map((_, index) => `$${index + 1}`).join(",")})`, txnIds) : [];
    const buckets = (await db.query(`SELECT * FROM buckets WHERE household_id = $1`, [member.householdId])).filter((bucket) => spaceIds.has(String(bucket.space_id)));
    const bucketIds = new Set(buckets.map((bucket) => String(bucket.id)));
    const assignments = (await db.query(`SELECT * FROM assignments WHERE household_id = $1`, [member.householdId])).filter((row) => bucketIds.has(String(row.bucket_id)));
    const goals = (await db.query(`SELECT * FROM goals WHERE household_id = $1`, [member.householdId])).filter((goal) => spaceIds.has(String(goal.space_id)));
    const schedules = (await db.query(`SELECT * FROM schedules WHERE household_id = $1`, [member.householdId])).filter((row) => spaceIds.has(String(row.space_id)) && (!row.account_id || ids.has(String(row.account_id))));
    return c.json({
      version: 2, exportedAt: nowIso(), currency: member.currency, householdId: member.householdId,
      spaces, accounts, buckets, transactions, splits, tags, assignments, goals, schedules,
      note: "Private accounts you cannot see are omitted. Restoring this file adds missing rows into the household you choose. It does not copy them into a different household's existing ids.",
    });
  });

  app.post("/api/households/:hid/restore", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertAdmin(member);
    const body = z.object({ mode: z.enum(["preview", "add-missing"]), backup: z.unknown() }).parse(await c.req.json());
    const owners = await ownerMaps(db);
    let plan;
    try {
      plan = planRestore(body.backup, member.householdId, owners);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "That backup could not be read.");
    }
    if (body.mode === "preview") {
      return c.json({
        mode: "preview",
        adds: Object.fromEntries(Object.entries(plan.inserts).map(([name, rows]) => [name, rows.length])),
        skipped: plan.skipped.length,
        warnings: plan.warnings,
        note: "Nothing was written. Add missing rows only inserts records this household does not already have.",
      });
    }
    try {
    await db.tx(async () => {
      for (const space of plan.inserts.spaces) await insertRow(db, "spaces", space, ["id", "household_id", "name", "kind", "owner_user_id", "business_type", "currency", "created_at"]);
      for (const bucket of plan.inserts.buckets) await insertRow(db, "buckets", bucket, ["id", "household_id", "space_id", "name", "group_name", "kind", "flex_role", "envelope_style", "rollover", "rollover_cap_minor", "icon", "archived", "hidden", "display_order", "target_json", "system_role", "linked_account_id", "purpose", "due_day", "created_at"]);
      for (const account of plan.inserts.accounts) await insertRow(db, "accounts", account, ["id", "household_id", "space_id", "name", "kind", "currency", "on_budget", "visibility", "owner_user_id", "hidden", "archived", "exclude_from_net_worth", "institution", "mask", "credit_limit_minor", "apr_bps", "minimum_payment_minor", "linked_account_id", "display_order", "created_at"]);
      for (const txn of plan.inserts.transactions) await insertRow(db, "transactions", txn, ["id", "household_id", "space_id", "date", "account_id", "counter_account_id", "amount_minor", "currency", "type", "payee", "original_description", "bank_status", "review_status", "cleared", "reconciled", "locked", "category_locked", "flag", "notes", "check_number", "owner_user_id", "business_space_id", "project", "tax_code", "schedule_id", "refund_of_id", "import_batch_id", "provider_transaction_id", "client_op_id", "fx_json", "exclude_from_reports", "version", "deleted", "created_at", "updated_at"]);
      for (const split of plan.inserts.splits) await insertRow(db, "splits", split, ["id", "transaction_id", "bucket_id", "amount_minor", "role", "memo", "owner_user_id", "business_space_id", "project", "tax_code"]);
      for (const tag of plan.inserts.tags) await insertRow(db, "transaction_tags", tag, ["transaction_id", "tag"]);
      for (const assignment of plan.inserts.assignments) await insertRow(db, "assignments", assignment, ["id", "household_id", "space_id", "bucket_id", "period_key", "amount_minor"]);
      for (const goal of plan.inserts.goals) await insertRow(db, "goals", goal, ["id", "household_id", "space_id", "bucket_id", "name", "target_minor", "target_date", "priority", "purpose", "archived", "notes"]);
      for (const schedule of plan.inserts.schedules) await insertRow(db, "schedules", schedule, ["id", "household_id", "space_id", "name", "cadence", "custom_days", "next_date", "amount_minor", "amount_max_minor", "direction", "account_id", "bucket_id", "type", "payee", "owner_user_id", "paused", "confirmed", "skipped_dates"]);
      await audit(db, member.householdId, me.id, "restore", `Added missing rows from a backup`);
    });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "The backup could not be applied. Nothing was changed.");
    }
    return c.json({ ok: true, added: Object.fromEntries(Object.entries(plan.inserts).map(([name, rows]) => [name, rows.length])), skipped: plan.skipped.length, warnings: plan.warnings });
  });

  app.post("/api/households/:hid/import/preview", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ spaceId: z.string(), profile: z.string().optional(), format: z.enum(["csv", "ofx", "qif"]), text: z.string().max(2_000_000), mapping: z.record(z.string()).optional() }).parse(await c.req.json());
    const profile = IMPORT_PROFILES.find((item) => item.id === body.profile);
    let rows: { rowNumber: number; date?: string; amountMinor?: number; payee?: string; fitId?: string; errors: string[]; duplicateKey?: string }[] = [];
    if (body.format === "csv") rows = mapCsv(body.text, { ...(profile?.map ?? {}), ...body.mapping, date: body.mapping?.date ?? profile?.map.date ?? "Date", amount: body.mapping?.amount ?? profile?.map.amount ?? "Amount", payee: body.mapping?.payee ?? profile?.map.payee ?? "Payee" });
    if (body.format === "ofx") rows = parseOfx(body.text).map((txn, index) => ({ rowNumber: index + 1, ...txn, errors: txn.date ? [] : ["Missing date"], duplicateKey: duplicateKey({ date: txn.date, amountMinor: txn.amountMinor, description: txn.payee, account: "" }) }));
    if (body.format === "qif") rows = parseQif(body.text).map((txn, index) => ({ rowNumber: index + 1, ...txn, errors: [], duplicateKey: duplicateKey({ date: txn.date, amountMinor: txn.amountMinor, description: txn.payee, account: "" }) }));
    const existing = await db.query(`SELECT date, amount_minor, payee, provider_transaction_id FROM transactions WHERE household_id = $1 AND deleted = 0`, [member.householdId]);
    const keys = new Set(existing.map((txn) => duplicateKey({ date: String(txn.date), amountMinor: num(txn.amount_minor), description: String(txn.payee), account: "" })));
    const providerIds = new Set(existing.map((txn) => str(txn.provider_transaction_id)).filter((value): value is string => !!value));
    await assertSpace(me.id, member.householdId, body.spaceId);
    const preview = rows.map((row) => {
      const sameProvider = !!row.fitId && providerIds.has(row.fitId);
      const sameLine = row.duplicateKey ? keys.has(row.duplicateKey) : false;
      return { ...row, duplicate: sameProvider, possibleMatch: !sameProvider && sameLine };
    });
    const batchId = id();
    await db.query(`INSERT INTO import_batches (id, household_id, space_id, source, status, preview_json, created_at) VALUES ($1,$2,$3,$4,'preview',$5,$6)`, [batchId, member.householdId, body.spaceId, body.profile ?? body.format, JSON.stringify(preview), nowIso()]);
    return c.json({ batchId, rows: preview, missing: profile?.missing ?? ["Map the columns you have. Fields that are not in the file are left blank and are not invented."], profiles: IMPORT_PROFILES.map((item) => ({ id: item.id, label: item.label, missing: item.missing })) });
  });

  app.post("/api/households/:hid/import/:batchId/commit", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ accountId: z.string(), rowNumbers: z.array(z.number().int()) }).parse(await c.req.json());
    const account = await mustAccount(me.id, member.householdId, body.accountId);
    const batches = await db.query(`SELECT * FROM import_batches WHERE id = $1 AND household_id = $2 AND status = 'preview'`, [c.req.param("batchId"), member.householdId]);
    if (!batches.length) throw new ApiError(404, "Not found");
    await assertSpace(me.id, member.householdId, String(batches[0].space_id));
    if (String(account.space_id) !== String(batches[0].space_id)) throw new ApiError(400, "Choose an account in the same space as the import.");
    const rows = JSON.parse(String(batches[0].preview_json)) as { rowNumber: number; date?: string; amountMinor?: number; payee?: string; fitId?: string; errors: string[]; duplicate?: boolean }[];
    let created = 0;
    await db.tx(async () => {
      for (const row of rows) {
        if (!body.rowNumbers.includes(row.rowNumber) || row.errors.length || row.duplicate || !row.date || row.amountMinor == null) continue;
        const saved = await insertTransaction(me, member.householdId, {
          spaceId: String(batches[0].space_id), date: row.date, accountId: body.accountId, amountMinor: row.amountMinor,
          type: row.amountMinor >= 0 ? "income" : "expense", payee: row.payee || "Imported", splits: [], bankStatus: "posted", importBatchId: String(batches[0].id), reviewStatus: "needs_review",
          providerTransactionId: row.fitId, opId: `import:${batches[0].id}:${row.rowNumber}`,
        });
        if (!saved.duplicate) created += 1;
      }
      await db.query(`UPDATE import_batches SET status = 'committed', committed_at = $1 WHERE id = $2 AND household_id = $3`, [nowIso(), batches[0].id, member.householdId]);
    });
    return c.json({ created });
  });

  app.post("/api/households/:hid/assistant", async (c) => {
    const me = await actor(c);
    if (!me.aiEnabled) return c.json({ text: "The assistant is turned off. Reports, the plan, and the register still work.", facts: [], missing: ["assistant_disabled"], proposedActions: [] });
    const body = z.object({ question: z.string().min(1).max(500), spaceId: z.string().optional() }).parse(await c.req.json());
    const loaded = await loadSpace(db, me, c.req.param("hid"), body.spaceId);
    const guide = guidanceFor(loaded);
    const worth = visibleNetWorth(loaded);
    const facts = [
      { id: "safe_to_spend", label: "Safe to spend", amountMinor: guide.guidance.primaryFigure === "shortage" ? -guide.guidance.shortageMinor : guide.guidance.cashSafeMinor, formula: guide.guidance.formula, asOf: loaded.input.asOf, text: guide.guidance.primaryFigure === "shortage" ? `a shortage of ${(guide.guidance.shortageMinor / 100).toFixed(2)} ${loaded.member.currency}` : `${(guide.guidance.cashSafeMinor / 100).toFixed(2)} ${loaded.member.currency}` },
      { id: "bills_before_payday", label: "Bills", text: planView(loaded).paychecks.beforeNext.obligations.map((item) => item.name).join(", ") || "No bills before the next paycheck", amountMinor: planView(loaded).paychecks.beforeNext.uncoveredMinor },
      { id: "spending_period", label: "Spending", amountMinor: loaded.budget.spendingMinor, from: loaded.budget.periodStart, to: loaded.input.asOf, text: `${(loaded.budget.spendingMinor / 100).toFixed(2)} ${loaded.member.currency}` },
      { id: "net_worth", label: "Net worth", amountMinor: worth.netMinor, formula: worth.formula, text: `${(worth.netMinor / 100).toFixed(2)} ${loaded.member.currency}` },
      { id: "goal_gap", label: "Goals", text: "Open Goals for the envelope that backs each goal. The same dollars are not counted twice." },
    ];
    const paycheck = await paycheckPlan(db, me, c.req.param("hid"), { spaceId: body.spaceId });
    facts.push({
      id: "next_paycheck",
      label: "Next expected paycheck",
      amountMinor: paycheck.next?.amountMinor ?? paycheck.actual.cashMinor,
      text: paycheck.next
        ? `${paycheck.next.name || "Paycheck"} on ${paycheck.next.date} for ${(paycheck.next.amountMinor / 100).toFixed(2)} ${loaded.member.currency} is expected income, not cash on hand. Cash on hand is ${(paycheck.actual.cashMinor / 100).toFixed(2)}.`
        : `No paycheck is expected in the window you can see. Cash on hand is ${(paycheck.actual.cashMinor / 100).toFixed(2)} ${loaded.member.currency}. Expected income is not cash on hand.`,
      formula: paycheck.explanation,
    });
    const answer = answerFinanceQuestion(body.question, facts);
    const suggestion = suggestBucket(body.question, loaded.input.transactions);
    return c.json({ ...answer, suggestion, proposedActions: answer.proposedActions });
  });

  app.get("/api/providers", async (c) => {
    await actor(c);
    const smtp = process.env.SMTP_URL ? "configured" : "local_outbox";
    return c.json({ providers: PROVIDERS.map((provider) => provider.id === "smtp" ? { ...provider, status: smtp } : provider) });
  });

  app.get("/api/lessons", async (c) => {
    const me = await actor(c);
    const progress = await db.query(`SELECT lesson_id FROM education_progress WHERE user_id = $1`, [me.id]);
    const done = new Set(progress.map((row) => String(row.lesson_id)));
    return c.json({ lessons: LESSONS.map((lesson) => ({ ...lesson, completed: done.has(lesson.id) })) });
  });

  app.post("/api/lessons/:id/complete", async (c) => {
    const me = await actor(c);
    if (!LESSONS.some((lesson) => lesson.id === c.req.param("id"))) throw new ApiError(404, "Not found");
    await db.query(`INSERT INTO education_progress (user_id, lesson_id, completed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [me.id, c.req.param("id"), nowIso()]);
    return c.json({ ok: true });
  });

  app.post("/api/households/:hid/cases", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({
      kind: z.enum(["cancellation", "negotiation", "refund_review"]),
      merchant: z.string().min(1),
      authorized: z.boolean(),
      details: z.record(z.unknown()).default({}),
    }).parse(await c.req.json());
    if (!body.authorized) throw new ApiError(400, "This request is stored only after you explicitly authorize it. Nothing is sent to a biller automatically.");
    const caseId = id();
    await db.query(`INSERT INTO cases (id, household_id, kind, merchant, status, authorized, details_json, created_at, updated_at) VALUES ($1,$2,$3,$4,'authorization_recorded',1,$5,$6,$6)`, [caseId, member.householdId, body.kind, body.merchant, JSON.stringify({ ...body.details, providerStatus: "not_configured" }), nowIso()]);
    return c.json({ id: caseId, status: "authorization_recorded", provider: "Cancellation and negotiation need a concierge provider. No biller was contacted." }, 201);
  });

  app.get("/api/households/:hid/cases", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ cases: await db.query(`SELECT * FROM cases WHERE household_id = $1 ORDER BY created_at DESC`, [member.householdId]) });
  });

  app.post("/api/households/:hid/credit", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({ score: z.number().int().min(300).max(850), model: z.string().default("Manual entry"), note: z.string().optional() }).parse(await c.req.json());
    await db.query(`INSERT INTO credit_entries (id, household_id, user_id, score, model, bureau, report_date, source, factors_json, created_at) VALUES ($1,$2,$3,$4,$5,'None',$6,'manual',$7,$8)`, [id(), member.householdId, me.id, body.score, body.model, localDate(member.timeZone), JSON.stringify([body.note ?? "Entered by you. Not a bureau report."]), nowIso()]);
    return c.json({ source: "manual" }, 201);
  });

  app.get("/api/households/:hid/credit", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const rows = await db.query(`SELECT * FROM credit_entries WHERE household_id = $1 AND user_id = $2 ORDER BY created_at DESC`, [member.householdId, me.id]);
    return c.json({ entries: rows, liveReport: null, note: "There is no credit-bureau connection. Scores you add are manual." });
  });

  app.get("/api/households/:hid/checklists/:kind", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ items: await db.query(`SELECT * FROM checklist_items WHERE household_id = $1 AND kind = $2 ORDER BY sort`, [member.householdId, c.req.param("kind")]) });
  });

  app.post("/api/households/:hid/checklists/:kind", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ title: z.string().min(1), done: z.boolean().optional(), id: z.string().optional() }).parse(await c.req.json());
    if (body.id) {
      await db.query(`UPDATE checklist_items SET done = $1, title = $2 WHERE id = $3 AND household_id = $4`, [body.done ? 1 : 0, body.title, body.id, member.householdId]);
      return c.json({ ok: true });
    }
    const itemId = id();
    await db.query(`INSERT INTO checklist_items (id, household_id, kind, title, done, sort) VALUES ($1,$2,$3,$4,$5,0)`, [itemId, member.householdId, c.req.param("kind"), body.title, body.done ? 1 : 0]);
    return c.json({ id: itemId }, 201);
  });

  app.get("/api/widgets/summary", async (c) => {
    const me = await actor(c);
    const householdId = c.req.query("householdId");
    if (!householdId) throw new ApiError(400, "householdId is required");
    const loaded = await loadSpace(db, me, householdId, c.req.query("spaceId") ?? undefined);
    const guide = guidanceFor(loaded);
    const mask = me.privacyMode || c.req.query("mask") === "1";
    const show = (amount: number) => (mask ? null : amount);
    return c.json({
      masked: mask,
      safeToSpendMinor: show(guide.guidance.cashSafeMinor),
      shortageMinor: show(guide.guidance.shortageMinor),
      readyToAssignMinor: show(loaded.budget.readyToAssignMinor),
      upcoming: mask ? [] : guide.events.slice(0, 3),
      asOf: loaded.input.asOf,
    });
  });

  app.post("/api/households/:hid/sync", async (c) => {
    const me = await actor(c);
    const body = z.object({ ops: z.array(z.object({ opId: z.string(), transaction: transactionSchema })) }).parse(await c.req.json());
    const results = [];
    for (const op of body.ops) {
      const created = await insertTransaction(me, c.req.param("hid"), { ...op.transaction, opId: op.opId });
      results.push({ opId: op.opId, status: created.duplicate ? "duplicate" : created.updated ? "updated" : "applied", id: created.id });
    }
    return c.json({ results });
  });

  app.post("/api/support", async (c) => {
    const me = await actor(c);
    const body = z.object({ subject: z.string().min(1), body: z.string().min(1), householdId: z.string().optional() }).parse(await c.req.json());
    const ticketId = id();
    await db.query(`INSERT INTO support_tickets (id, user_id, household_id, subject, body, status, created_at) VALUES ($1,$2,$3,$4,$5,'open',$6)`, [ticketId, me.id, body.householdId ?? null, body.subject, body.body, nowIso()]);
    return c.json({ id: ticketId, status: "open", note: "This stores your request. It does not mean a person has replied." }, 201);
  });

  app.post("/api/households/:hid/fresh-start", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertAdmin(member);
    const body = z.object({ spaceId: z.string(), keepTargets: z.boolean() }).parse(await c.req.json());
    await assertSpace(me.id, member.householdId, body.spaceId);
    await db.tx(async () => {
      const assignments = await db.query(`SELECT * FROM assignments WHERE household_id = $1 AND space_id = $2`, [member.householdId, body.spaceId]);
      const targets = await db.query(`SELECT id, name, target_json FROM buckets WHERE household_id = $1 AND space_id = $2`, [member.householdId, body.spaceId]);
      await db.query(`INSERT INTO plan_archives (id, household_id, space_id, snapshot_json, created_at) VALUES ($1,$2,$3,$4,$5)`, [id(), member.householdId, body.spaceId, JSON.stringify({ assignments, targets, keepTargets: body.keepTargets }), nowIso()]);
      await db.query(`DELETE FROM assignments WHERE household_id = $1 AND space_id = $2`, [member.householdId, body.spaceId]);
      if (!body.keepTargets) await db.query(`UPDATE buckets SET target_json = NULL WHERE household_id = $1 AND space_id = $2 AND system_role IS NULL`, [member.householdId, body.spaceId]);
      await audit(db, member.householdId, me.id, "plan.reset", "Archived the plan and cleared assignments. Transactions and accounts were kept.", "space", body.spaceId);
    });
    return c.json({ ok: true, note: "Transactions and accounts were kept. Assignments were archived." });
  });

  app.get("/api/households/:hid/audit", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    return c.json({ events: await db.query(`SELECT id, action, entity, entity_id, summary, created_at, user_id FROM audit_events WHERE household_id = $1 ORDER BY created_at DESC LIMIT 100`, [member.householdId]) });
  });

  app.post("/api/households/:hid/invitations", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertAdmin(member);
    const body = z.object({ email: z.string().email(), role: z.enum(["admin", "editor", "contributor", "readonly", "coach", "planner", "accountant"]) }).parse(await c.req.json());
    const verified = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [me.id]);
    if (!verified[0]?.email_verified_at) throw new ApiError(403, "Verify your email before inviting someone.");
    const token = randomToken();
    const summary = `You will see shared spaces and shared accounts in ${member.name}. Private accounts stay hidden. Role: ${body.role}.`;
    await db.query(`INSERT INTO invitations (id, household_id, email, role, token_hash, expires_at, reveal_summary, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id(), member.householdId, body.email.toLowerCase(), body.role, sha256(token), new Date(Date.now() + 7 * 86_400_000).toISOString(), summary, nowIso()]);
    return c.json({ token, summary }, 201);
  });

  app.post("/api/invitations/:token/accept", async (c) => {
    const me = await actor(c);
    const rows = await db.query(`SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2`, [sha256(c.req.param("token")), nowIso()]);
    if (!rows.length) throw new ApiError(400, "That invitation is invalid or expired.");
    if (String(rows[0].email) !== me.email) throw new ApiError(403, "This invitation was sent to a different email.");
    const count = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1`, [rows[0].household_id]);
    if (count.length >= 12) throw new ApiError(400, "This household is at its 12-person sharing limit.");
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [rows[0].household_id, me.id, rows[0].role, nowIso()]);
    await db.query(`UPDATE invitations SET accepted_at = $1 WHERE id = $2`, [nowIso(), rows[0].id]);
    return c.json({ householdId: rows[0].household_id, revealed: rows[0].reveal_summary });
  });

  app.post("/api/households/:hid/comments", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const body = z.object({ transactionId: z.string(), body: z.string().min(1).max(2000) }).parse(await c.req.json());
    await mustTxn(me.id, member.householdId, body.transactionId);
    const commentId = id();
    await db.query(`INSERT INTO comments (id, household_id, transaction_id, user_id, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [commentId, member.householdId, body.transactionId, me.id, body.body, nowIso()]);
    return c.json({ id: commentId }, 201);
  });

  app.post("/api/households/:hid/reconcile", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ accountId: z.string(), statementDate: z.string(), statementBalanceMinor: money, clearedIds: z.array(z.string()), lock: z.boolean().default(false) }).parse(await c.req.json());
    const account = await mustAccount(me.id, member.householdId, body.accountId);
    const loaded = await loadSpace(db, me, member.householdId, String(account.space_id), body.statementDate);
    const onAccount = new Map(loaded.input.transactions.filter((txn) => txn.accountId === account.id || txn.counterAccountId === account.id).map((txn) => [txn.id, txn]));
    const unknown = body.clearedIds.filter((txnId) => !onAccount.has(txnId));
    if (unknown.length) throw new ApiError(404, "One of those transactions is not on this account.");
    const cleared = new Set(body.clearedIds);
    let signed = 0;
    for (const txn of onAccount.values()) {
      if (txn.date > body.statementDate) continue;
      if (!cleared.has(txn.id) && !txn.reconciled) continue;
      if (txn.accountId === account.id) signed += txn.amountMinor;
      else if (txn.counterAccountId === account.id) signed -= txn.amountMinor;
    }
    const liability = ["credit", "loan", "student_loan", "mortgage", "other_liability"].includes(String(account.kind));
    const display = liability ? -signed : signed;
    const difference = body.statementBalanceMinor - display;
    await db.tx(async () => {
      for (const txnId of body.clearedIds) {
        if (body.lock && difference === 0) {
          await db.query(`UPDATE transactions SET cleared = 1, reconciled = 1, locked = 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0`, [nowIso(), txnId, member.householdId]);
        } else {
          await db.query(`UPDATE transactions SET cleared = 1, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0`, [nowIso(), txnId, member.householdId]);
        }
      }
      if (body.lock && difference === 0) await audit(db, member.householdId, me.id, "reconcile.lock", `Locked ${account.name} at the statement balance`, "account", String(account.id));
    });
    return c.json({
      clearedBalanceMinor: display,
      statementBalanceMinor: body.statementBalanceMinor,
      differenceMinor: difference,
      locked: body.lock && difference === 0,
      formula: "Cleared balance uses the transactions you marked, through the statement date. A difference of zero can be locked. Otherwise add an adjustment you can see in the register.",
    });
  });

  app.post("/api/households/:hid/reconcile/unlock", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ accountId: z.string(), transactionIds: z.array(z.string()).min(1) }).parse(await c.req.json());
    const account = await mustAccount(me.id, member.householdId, body.accountId);
    await db.tx(async () => {
      for (const txnId of body.transactionIds) {
        const updated = await db.query(
          `UPDATE transactions SET reconciled = 0, locked = 0, updated_at = $1 WHERE id = $2 AND household_id = $3 AND deleted = 0 AND (account_id = $4 OR counter_account_id = $4) RETURNING id`,
          [nowIso(), txnId, member.householdId, account.id],
        );
        if (!updated.length) throw new ApiError(404, "Not found");
      }
      await audit(db, member.householdId, me.id, "reconcile.unlock", `Unlocked transactions on ${account.name}`, "account", String(account.id));
    });
    return c.json({ ok: true, note: "Those transactions can be edited again. Clearing them did not change their amounts." });
  });

  app.post("/api/households/:hid/reconcile/adjustment", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({ accountId: z.string(), date: z.string(), amountMinor: money, payee: z.string().default("Reconciliation adjustment") }).parse(await c.req.json());
    await mustAccount(me.id, member.householdId, body.accountId);
    if (body.amountMinor === 0) throw new ApiError(400, "An adjustment of zero does not change the balance.");
    const created = await insertTransaction(me, member.householdId, {
      date: body.date, accountId: body.accountId, amountMinor: body.amountMinor, type: "reconciliation", payee: body.payee,
      splits: [], bankStatus: "posted", reviewStatus: "reviewed", notes: "Entered so the cleared balance can match the statement.", categoryLocked: true, opId: `recon-${id()}`,
    });
    return c.json({ ...created, note: "This adjustment is a real register entry. It is not hidden inside the reconciliation." }, 201);
  });

  app.get("/api/households/:hid/roadmap", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined);
    const emergency = loaded.budget.buckets.find((row) => loaded.input.buckets.find((bucket) => bucket.id === row.bucketId)?.purpose === "emergency");
    const essential = essentialObligations({
      schedules: loaded.input.schedules ?? [],
      buckets: loaded.input.buckets,
      accounts: loaded.input.accounts.filter((account) => account.spaceId === loaded.spaceId && loaded.visibleAccountIds.has(account.id)),
    });
    const orderRows = await db.query(`SELECT item_id, label FROM roadmap_order WHERE household_id = $1 ORDER BY sort`, [loaded.member.householdId]);
    const order = orderRows.length ? orderRows.map((row) => ({ id: String(row.item_id), label: String(row.label) })) : [
      { id: "starter_emergency", label: "Starter emergency buffer" },
      { id: "debt_free", label: "Debt payoff" },
      { id: "full_emergency", label: "Full emergency reserve" },
      { id: "retirement", label: "Retirement contributions" },
    ];
    const debts = debtPlan(loaded, "snowball", 0);
    const debtBalance = debts.debts.reduce((sum, debt) => sum + debt.balanceMinor, 0);
    return c.json({
      milestones: financialRoadmap({
        emergencyMonths: 3,
        essentialMonthlyMinor: essential.amountMinor,
        emergencySavedMinor: emergency?.availableMinor ?? 0,
        debtBalanceMinor: debtBalance,
        retirementContributionAnnualMinor: 0,
        retirementTargetAnnualMinor: 0,
        order,
      }),
      essential,
      emergency: emergencyGap(essential.amountMinor, 3, emergency?.availableMinor ?? 0),
    });
  });

  app.post("/api/households/:hid/schedules", async (c) => {
    const me = await actor(c);
    const created = await createBill(db, me, c.req.param("hid"), await c.req.json(), incomeHooks());
    return c.json(created, 201);
  });

  app.post("/api/households/:hid/schedules/:id/skip", async (c) => {
    const me = await actor(c);
    return c.json(await skipBill(db, me, c.req.param("hid"), c.req.param("id")));
  });

  app.post("/api/households/:hid/goals", async (c) => {
    const me = await actor(c);
    const created = await createManualGoal(me, c.req.param("hid"), await c.req.json());
    return c.json(created, 201);
  });

  app.post("/api/households/:hid/rules", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertWrite(member);
    const body = z.object({
      spaceId: z.string().optional(), name: z.string(), priority: z.number().int().default(100), matchMode: z.enum(["all", "any"]),
      conditions: z.array(z.record(z.unknown())), actions: z.array(z.record(z.unknown())), enabled: z.boolean().default(true),
    }).parse(await c.req.json());
    if (body.spaceId) await assertSpace(me.id, member.householdId, body.spaceId);
    const ruleId = id();
    await db.query(`INSERT INTO rules (id, household_id, space_id, name, priority, enabled, match_mode, conditions_json, actions_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ruleId, member.householdId, body.spaceId ?? null, body.name, body.priority, body.enabled ? 1 : 0, body.matchMode, JSON.stringify(body.conditions), JSON.stringify(body.actions)]);
    return c.json({ id: ruleId }, 201);
  });

  app.get("/api/households/:hid/rules", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    const rows = await db.query(`SELECT * FROM rules WHERE household_id = $1 ORDER BY priority`, [member.householdId]);
    return c.json({ rules: rows });
  });

  app.post("/api/households/:hid/rules/preview", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined);
    const body = z.object({ rule: z.object({ id: z.string(), name: z.string(), priority: z.number(), enabled: z.boolean(), matchMode: z.enum(["all", "any"]), conditions: z.array(z.any()), actions: z.array(z.any()) }), limit: z.number().int().default(20) }).parse(await c.req.json());
    const matches = loaded.input.transactions.slice(0, 500).map((txn) => applyHouseholdRules(txn, [{ ...body.rule, stop: false }])).filter((item) => item.matchedRuleIds.length);
    return c.json({ count: matches.length, sample: matches.slice(0, body.limit) });
  });

  app.post("/api/devices", async (c) => {
    const me = await actor(c);
    const body = z.object({ name: z.string(), platform: z.string() }).parse(await c.req.json());
    const deviceId = id();
    await db.query(`INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ($1,$2,$3,$4,$5)`, [deviceId, me.id, body.name, body.platform, nowIso()]);
    return c.json({ id: deviceId }, 201);
  });

  app.post("/api/api-tokens", async (c) => {
    const me = await actor(c);
    const body = z.object({ name: z.string() }).parse(await c.req.json());
    const token = randomToken();
    await db.query(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES ($1,$2,$3,$4,$5)`, [id(), me.id, body.name, sha256(token), nowIso()]);
    await audit(db, null, me.id, "api_token", "Created an API token");
    return c.json({ token, note: "Copy this token now. It is stored only as a hash." }, 201);
  });

  app.post("/api/households/:hid/spaces", async (c) => {
    const me = await actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    assertAdmin(member);
    const body = z.object({ name: z.string(), kind: z.enum(["personal", "business", "household"]), businessType: z.string().optional() }).parse(await c.req.json());
    const spaceId = id();
    await db.query(`INSERT INTO spaces (id, household_id, name, kind, owner_user_id, business_type, currency, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [spaceId, member.householdId, body.name, body.kind, body.kind === "personal" ? me.id : null, body.businessType ?? null, member.currency, nowIso()]);
    const { insertStarterBuckets } = await import("./finance.js");
    if (body.kind !== "personal") await insertStarterBuckets(db, member.householdId, spaceId);
    else {
      const { ensureBorrowedBucket } = await import("./finance.js");
      await ensureBorrowedBucket(db, member.householdId, spaceId);
    }
    return c.json({ id: spaceId }, 201);
  });

  app.get("/api/search", async (c) => {
    const me = await actor(c);
    const householdId = c.req.query("householdId");
    if (!householdId) throw new ApiError(400, "householdId is required");
    const loaded = await loadSpace(db, me, householdId, c.req.query("spaceId") ?? undefined);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const transactions = loaded.input.transactions.filter((txn) => `${txn.payee} ${txn.notes ?? ""}`.toLowerCase().includes(q)).slice(0, 25);
    return c.json({ transactions });
  });

  app.post("/api/households/:hid/alerts/read", async (c) => {
    const me = await actor(c);
    await db.query(`UPDATE alerts SET read_at = $1 WHERE user_id = $2 AND household_id = $3 AND read_at IS NULL`, [nowIso(), me.id, c.req.param("hid")]);
    return c.json({ ok: true });
  });

  app.get("/api/households/:hid/targets", async (c) => {
    const me = await actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined);
    const rows = loaded.input.buckets.filter((bucket) => bucket.target).map((bucket) => {
      const available = loaded.budget.buckets.find((row) => row.bucketId === bucket.id)?.availableMinor ?? 0;
      const assigned = loaded.budget.buckets.find((row) => row.bucketId === bucket.id)?.assignedMinor ?? 0;
      return { bucketId: bucket.id, name: bucket.name, target: bucket.target, neededMinor: neededForTarget(bucket, available, assigned) };
    });
    return c.json({ targets: rows });
  });

  async function requirePassword(userId: string, password: string) {
    const rows = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    if (!(await verifyPassword(password, String(rows[0]?.password_hash ?? "")))) throw new ApiError(401, "Password is incorrect.");
  }

  function bearerHash(c: { req: { header: (name: string) => string | undefined } }) {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    return sha256(token);
  }

  async function consumeEmailToken(purpose: "verify" | "reset", token: string) {
    const now = nowIso();
    const rows = await db.query(
      `UPDATE email_tokens SET used_at = $1 WHERE purpose = $2 AND token_hash = $3 AND used_at IS NULL AND expires_at > $1 RETURNING user_id`,
      [now, purpose, sha256(token)],
    );
    if (!rows.length) throw new ApiError(400, await explainEmailToken(purpose, token));
    return String(rows[0].user_id);
  }

  async function explainEmailToken(purpose: "verify" | "reset", token: string) {
    const noun = purpose === "reset" ? "reset link" : "verification link";
    const rows = await db.query(`SELECT used_at, expires_at FROM email_tokens WHERE purpose = $1 AND token_hash = $2`, [purpose, sha256(token)]);
    if (!rows.length) return `That ${noun} is invalid.`;
    if (rows[0].used_at) return `That ${noun} was already used.`;
    return `That ${noun} is expired.`;
  }

  async function consumeRecoveryCode(userId: string, code: string) {
    const codeHash = sha256(code);
    const claimed = await db.tx(async () => {
      const rows = await db.query(`SELECT recovery_hashes FROM users WHERE id = $1`, [userId]);
      const stored = String(rows[0]?.recovery_hashes ?? "[]");
      const recovery = JSON.parse(stored) as string[];
      if (!recovery.includes(codeHash)) return false;
      const next = JSON.stringify(recovery.filter((item) => item !== codeHash));
      const updated = await db.query(
        `UPDATE users SET recovery_hashes = $1 WHERE id = $2 AND recovery_hashes = $3 RETURNING id`,
        [next, userId, stored],
      );
      return updated.length > 0;
    });
    if (!claimed) throw new ApiError(401, "That recovery code was already used.");
  }

  async function createManualAccount(me: Actor, householdId: string, raw: unknown, forcedId?: string) {
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = z.object({
      spaceId: z.string(),
      name: z.string().min(1),
      kind: z.string(),
      currency: z.string().length(3).optional(),
      onBudget: z.boolean().optional(),
      visibility: z.enum(["shared", "private"]).default("shared"),
      institution: z.string().optional(),
      mask: z.string().max(8).optional(),
      creditLimitMinor: money.optional(),
      aprBps: z.number().int().optional(),
      minimumPaymentMinor: money.optional(),
      linkedAccountId: z.string().optional(),
      openingBalanceMinor: money.optional(),
      openingDate: z.string().optional(),
    }).parse(raw);
    await assertSpace(me.id, member.householdId, body.spaceId);
    const accountId = forcedId ?? id();
    const onBudget = body.onBudget ?? ["checking", "savings", "cash", "credit"].includes(body.kind);
    await db.tx(async () => {
      await db.query(
        `INSERT INTO accounts (id, household_id, space_id, name, kind, currency, on_budget, visibility, owner_user_id, institution, mask, credit_limit_minor, apr_bps, minimum_payment_minor, linked_account_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [accountId, member.householdId, body.spaceId, body.name, body.kind, (body.currency ?? member.currency).toUpperCase(), onBudget ? 1 : 0, body.visibility, me.id, body.institution ?? null, body.mask ?? null, body.creditLimitMinor ?? null, body.aprBps ?? null, body.minimumPaymentMinor ?? null, body.linkedAccountId ?? null, nowIso()],
      );
      if (body.kind === "credit" && onBudget) {
        const { ensureCardReserve } = await import("./finance.js");
        await ensureCardReserve(db, member.householdId, body.spaceId, accountId, body.name);
      }
      if (body.openingBalanceMinor) {
        const signed = ["credit", "loan", "student_loan", "mortgage", "other_liability"].includes(body.kind) ? -Math.abs(body.openingBalanceMinor) : body.openingBalanceMinor;
        await insertTransaction(me, member.householdId, {
          spaceId: body.spaceId, date: body.openingDate ?? localDate(member.timeZone), accountId, amountMinor: signed, type: "opening", payee: "Opening balance", splits: [], bankStatus: "posted", reviewStatus: "reviewed",
        });
      }
      await audit(db, member.householdId, me.id, "account.create", `Added account ${body.name}`, "account", accountId);
    });
    return { id: accountId };
  }

  async function createManualCategory(me: Actor, householdId: string, raw: unknown, forcedId?: string) {
    const member = await requireMember(db, me.id, householdId);
    assertBudget(member);
    const body = z.object({
      spaceId: z.string(), name: z.string().min(1), group: z.string().default("Spending"),
      kind: z.enum(["income", "expense"]).default("expense"),
      flexRole: z.enum(["fixed", "non_monthly", "flexible", "income", "reserve"]).default("flexible"),
      envelopeStyle: z.enum(["regular", "annual", "goal", "debt", "none"]).default("regular"),
      rollover: z.enum(["both", "positive", "negative", "none", "capped"]).default("both"),
      rolloverCapMinor: money.optional(), purpose: z.string().optional(), icon: z.string().optional(),
      displayOrder: z.number().int().min(0).max(9999).optional(),
      target: z.record(z.unknown()).nullable().optional(),
    }).parse(raw);
    await assertSpace(me.id, member.householdId, body.spaceId);
    if (body.target) targetJson(body.target);
    const bucketId = forcedId ?? id();
    await db.tx(async () => {
      await db.query(
        `INSERT INTO buckets (id, household_id, space_id, name, group_name, kind, flex_role, envelope_style, rollover, rollover_cap_minor, icon, purpose, target_json, display_order, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [bucketId, member.householdId, body.spaceId, body.name, body.group, body.kind, body.flexRole, body.envelopeStyle, body.rollover, body.rolloverCapMinor ?? null, body.icon ?? null, body.purpose ?? null, targetJson(body.target), body.displayOrder ?? 0, nowIso()],
      );
      await db.query(`INSERT INTO bucket_revisions (bucket_id, household_id, version, updated_at) VALUES ($1,$2,1,$3)`, [bucketId, member.householdId, nowIso()]);
    });
    return { id: bucketId, version: 1 };
  }

  async function createManualGoal(me: Actor, householdId: string, raw: unknown, forcedId?: string) {
    const member = await requireMember(db, me.id, householdId);
    assertBudget(member);
    const body = z.object({
      spaceId: z.string(), name: z.string().min(1), bucketId: z.string(), targetMinor: money, targetDate: z.string().optional(), purpose: z.string().optional(),
    }).parse(raw);
    await assertSpace(me.id, member.householdId, body.spaceId);
    await assertBucket(member.householdId, body.spaceId, body.bucketId);
    const goalId = forcedId ?? id();
    await db.query(
      `INSERT INTO goals (id, household_id, space_id, bucket_id, name, target_minor, target_date, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [goalId, member.householdId, body.spaceId, body.bucketId, body.name, body.targetMinor, body.targetDate ?? null, body.purpose ?? "goal"],
    );
    return { id: goalId, note: "Progress uses this envelope's available balance, so the dollars are not also free to spend." };
  }

  async function startSession(userId: string, agent: string) {
    const token = randomToken();
    await db.query(`INSERT INTO sessions (id, user_id, token_hash, device_label, user_agent, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id(), userId, sha256(token), agent.slice(0, 80), agent.slice(0, 200), nowIso(), new Date(Date.now() + 30 * 86_400_000).toISOString()]);
    return token;
  }

  async function publicUser(userId: string) {
    const rows = await db.query(`SELECT id, email, display_name, email_verified_at, mfa_enabled, locale, time_zone, week_start, theme, privacy_mode, ai_enabled, pay_cadence, budget_approach, label_mode, onboarding_step, alert_settings, dashboard_layout FROM users WHERE id = $1`, [userId]);
    const row = rows[0];
    return {
      id: row.id, email: row.email, displayName: row.display_name, emailVerified: !!row.email_verified_at, mfaEnabled: num(row.mfa_enabled) === 1,
      locale: row.locale, timeZone: row.time_zone, weekStart: num(row.week_start), theme: row.theme, privacyMode: num(row.privacy_mode) === 1,
      aiEnabled: num(row.ai_enabled) === 1, payCadence: row.pay_cadence, budgetApproach: row.budget_approach, labelMode: row.label_mode,
      onboardingStep: row.onboarding_step, alertSettings: JSON.parse(String(row.alert_settings || "{}")), dashboardLayout: JSON.parse(String(row.dashboard_layout || "[]")),
    };
  }

  async function householdsFor(userId: string) {
    return db.query(
      `SELECT h.id, h.name, h.kind, h.currency, h.is_demo, h.budget_approach, h.label_mode, m.role
       FROM memberships m JOIN households h ON h.id = m.household_id WHERE m.user_id = $1`,
      [userId],
    );
  }

  async function visibleSpaces(userId: string, householdId: string) {
    const rows = await db.query(`SELECT * FROM spaces WHERE household_id = $1`, [householdId]);
    return rows.filter((space) => space.kind !== "personal" || space.owner_user_id == null || space.owner_user_id === userId);
  }

  async function assertSpace(userId: string, householdId: string, spaceId: string) {
    const spaces = await visibleSpaces(userId, householdId);
    if (!spaces.some((space) => space.id === spaceId)) throw new ApiError(404, "Not found");
  }

  async function assertBucket(householdId: string, spaceId: string, bucketId: string) {
    const rows = await db.query(`SELECT id FROM buckets WHERE id = $1 AND household_id = $2 AND space_id = $3`, [bucketId, householdId, spaceId]);
    if (!rows.length) throw new ApiError(404, "Not found");
  }

  async function mustAccount(userId: string, householdId: string, accountId: string) {
    const rows = await db.query(`SELECT * FROM accounts WHERE id = $1 AND household_id = $2`, [accountId, householdId]);
    if (!rows.length || !canSeeAccount(userId, { visibility: String(rows[0].visibility), owner_user_id: str(rows[0].owner_user_id) ?? null })) throw new ApiError(404, "Not found");
    return rows[0];
  }

  async function mustTxn(userId: string, householdId: string, txnId: string) {
    const rows = await db.query(`SELECT * FROM transactions WHERE id = $1 AND household_id = $2 AND deleted = 0`, [txnId, householdId]);
    if (!rows.length) throw new ApiError(404, "Not found");
    const account = await db.query(`SELECT * FROM accounts WHERE id = $1`, [rows[0].account_id]);
    if (!account.length || !canSeeAccount(userId, { visibility: String(account[0].visibility), owner_user_id: str(account[0].owner_user_id) ?? null })) throw new ApiError(404, "Not found");
    return rows[0];
  }

  async function loadEngineAccounts(householdId: string, ids: Array<string | undefined>): Promise<Account[]> {
    const unique = [...new Set(ids.filter((value): value is string => !!value))];
    if (!unique.length) return [];
    const placeholders = unique.map((_, index) => `$${index + 2}`).join(",");
    const rows = await db.query(`SELECT * FROM accounts WHERE household_id = $1 AND id IN (${placeholders})`, [householdId, ...unique]);
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind) as Account["kind"],
      currency: String(row.currency),
      onBudget: num(row.on_budget) === 1,
      archived: num(row.archived) === 1,
      excludeFromNetWorth: num(row.exclude_from_net_worth) === 1,
      minimumPaymentMinor: row.minimum_payment_minor == null ? undefined : num(row.minimum_payment_minor),
      aprBps: row.apr_bps == null ? undefined : num(row.apr_bps),
    }));
  }

  async function insertTransaction(me: Actor, householdId: string, body: z.infer<typeof transactionSchema>) {
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    assertKnownType(body.type);
    const account = await mustAccount(me.id, householdId, body.accountId);
    if (body.counterAccountId) await mustAccount(me.id, householdId, body.counterAccountId);
    if (body.spaceId) await assertSpace(me.id, householdId, body.spaceId);
    if (body.refundOfId) {
      if (body.type !== "refund" && body.type !== "reimbursement") throw new ApiError(400, "Only a refund or reimbursement can point at another transaction.");
      await mustTxn(me.id, householdId, body.refundOfId);
    }
    for (const split of body.splits) {
      if (!split.bucketId) continue;
      const bucket = await db.query(`SELECT space_id FROM buckets WHERE id = $1 AND household_id = $2`, [split.bucketId, householdId]);
      if (!bucket.length) throw new ApiError(404, "Not found");
      await assertSpace(me.id, householdId, String(bucket[0].space_id));
    }
    const rules = await db.query(`SELECT * FROM rules WHERE household_id = $1 AND enabled = 1`, [householdId]);
    let draft: Transaction = {
      id: id(), date: body.date, accountId: body.accountId, counterAccountId: body.counterAccountId, amountMinor: body.amountMinor,
      currency: String(account.currency), type: body.type as Transaction["type"], payee: body.payee, originalDescription: body.originalDescription,
      splits: body.splits.map(splitFromInput), bankStatus: body.bankStatus, reviewStatus: body.reviewStatus ?? "needs_review",
      notes: body.notes, tags: body.tags, flag: body.flag, checkNumber: body.checkNumber, categoryLockedByUser: body.categoryLocked,
      ownerUserId: body.ownerUserId ?? me.id, businessSpaceId: body.businessSpaceId, scheduleId: body.scheduleId, refundOfId: body.refundOfId,
      providerTransactionId: body.providerTransactionId, clientOpId: body.opId, importBatchId: body.importBatchId,
    };
    if (!draft.categoryLockedByUser && rules.length) {
      const applied = applyHouseholdRules(draft, rules.map((rule) => ({
        id: String(rule.id), name: String(rule.name), priority: num(rule.priority), enabled: true,
        matchMode: String(rule.match_mode) as "all" | "any", conditions: JSON.parse(String(rule.conditions_json)), actions: JSON.parse(String(rule.actions_json)),
      })));
      draft = applied.transaction;
    }
    const prior = body.providerTransactionId
      ? await db.query(`SELECT * FROM transactions WHERE household_id = $1 AND provider_transaction_id = $2 AND deleted = 0`, [householdId, body.providerTransactionId])
      : [];
    if (prior.length) {
      const existingSplits = await splitsOf(String(prior[0].id));
      const resulting = transactionFromRow(prior[0], existingSplits, {
        amountMinor: draft.amountMinor,
        bankStatus: draft.bankStatus,
        payee: num(prior[0].category_locked) === 1 ? undefined : draft.payee,
      });
      const accounts = await loadEngineAccounts(householdId, [resulting.accountId, resulting.counterAccountId]);
      validateTransaction(resulting, accounts, resulting.currency);
    } else {
      const accounts = await loadEngineAccounts(householdId, [draft.accountId, draft.counterAccountId]);
      validateTransaction(draft, accounts, draft.currency);
    }
    return db.tx(async () => {
      if (body.opId) {
        const claimed = await db.query(
          `INSERT INTO applied_ops (household_id, op_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING op_id`,
          [householdId, body.opId, nowIso()],
        );
        if (!claimed.length) {
          const existing = await db.query(`SELECT id FROM transactions WHERE household_id = $1 AND client_op_id = $2 AND deleted = 0`, [householdId, body.opId]);
          return { id: existing[0] ? String(existing[0].id) : null, duplicate: true as const };
        }
      }
      if (prior.length) {
        await db.query(
          `UPDATE transactions SET bank_status = $1, amount_minor = $2, payee = CASE WHEN category_locked = 1 THEN payee ELSE $3 END, updated_at = $4 WHERE id = $5 AND household_id = $6`,
          [draft.bankStatus, draft.amountMinor, draft.payee, nowIso(), prior[0].id, householdId],
        );
        await audit(db, householdId, me.id, "transaction.update", `Updated ${draft.payee} from the provider id`, "transaction", String(prior[0].id));
        return { id: String(prior[0].id), updated: true as const };
      }
      await db.query(
        `INSERT INTO transactions (id, household_id, space_id, date, account_id, counter_account_id, amount_minor, currency, type, payee, original_description, bank_status, review_status, flag, notes, check_number, owner_user_id, business_space_id, schedule_id, refund_of_id, provider_transaction_id, client_op_id, import_batch_id, category_locked, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25)`,
        [draft.id, householdId, String(account.space_id), draft.date, draft.accountId, draft.counterAccountId ?? null, draft.amountMinor, draft.currency, draft.type, draft.payee, draft.originalDescription ?? null, draft.bankStatus, draft.reviewStatus, draft.flag ?? null, draft.notes ?? null, draft.checkNumber ?? null, draft.ownerUserId ?? null, draft.businessSpaceId ?? null, draft.scheduleId ?? null, draft.refundOfId ?? null, draft.providerTransactionId ?? null, draft.clientOpId ?? null, draft.importBatchId ?? null, draft.categoryLockedByUser ? 1 : 0, nowIso()],
      );
      await replaceSplits(draft.id!, draft.splits);
      await replaceTags(draft.id!, draft.tags ?? []);
      await audit(db, householdId, me.id, "transaction.create", `Added ${draft.payee}`, "transaction", draft.id);
      return { id: draft.id };
    });
  }

  async function splitsOf(txnId: string): Promise<Transaction["splits"]> {
    const rows = await db.query(`SELECT bucket_id, amount_minor, role, memo FROM splits WHERE transaction_id = $1`, [txnId]);
    return rows.map((row) => ({
      bucketId: row.bucket_id == null ? null : String(row.bucket_id),
      amountMinor: num(row.amount_minor),
      role: String(row.role) as Transaction["splits"][number]["role"],
      memo: str(row.memo),
    }));
  }

  async function replaceSplits(txnId: string, splits: { bucketId: string | null; amountMinor: number; role: string; memo?: string }[]) {
    await db.query(`DELETE FROM splits WHERE transaction_id = $1`, [txnId]);
    for (const split of splits) {
      await db.query(`INSERT INTO splits (id, transaction_id, bucket_id, amount_minor, role, memo) VALUES ($1,$2,$3,$4,$5,$6)`, [id(), txnId, split.bucketId, split.amountMinor, split.role, split.memo ?? null]);
    }
  }

  async function replaceTags(txnId: string, tags: string[]) {
    await db.query(`DELETE FROM transaction_tags WHERE transaction_id = $1`, [txnId]);
    for (const tag of tags) await db.query(`INSERT INTO transaction_tags (transaction_id, tag) VALUES ($1,$2)`, [txnId, tag]);
  }

  async function refreshAlerts(me: Actor, loaded: Awaited<ReturnType<typeof loadSpace>>, shortage: number) {
    const alerts: { kind: string; title: string; body: string }[] = [];
    if (shortage > 0) alerts.push({ kind: "low_balance", title: "Cash shortfall", body: "Projected cash goes negative before the reserved bills are covered." });
    for (const gap of loaded.budget.cardGaps) {
      if (gap.gapMinor > 0) alerts.push({ kind: "card_gap", title: "Card reserve is short", body: "The card balance is higher than the cash reserved to pay it." });
    }
    for (const alert of alerts) {
      const key = `${loaded.input.asOf}:${alert.kind}`;
      const existing = await db.query(`SELECT id FROM alerts WHERE user_id = $1 AND dedupe_key = $2`, [me.id, key]);
      if (existing.length) continue;
      await db.query(`INSERT INTO alerts (id, household_id, user_id, kind, dedupe_key, title, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id(), loaded.member.householdId, me.id, alert.kind, key, alert.title, alert.body, nowIso()]);
    }
  }

  async function withInvestments(loaded: Awaited<ReturnType<typeof loadSpace>>) {
    const holdings = await db.query(`SELECT * FROM holdings WHERE household_id = $1`, [loaded.member.householdId]);
    const quotes = await db.query(`SELECT * FROM quotes WHERE household_id = $1`, [loaded.member.householdId]);
    const overrides: { accountId: string; valueMinor: number }[] = [];
    const byAccount = new Map<string, number>();
    for (const holding of holdings) {
      if (!loaded.visibleAccountIds.has(String(holding.account_id))) continue;
      const quote = quotes.find((item) => item.symbol === holding.symbol && item.currency === holding.currency);
      if (!quote) continue;
      const view = positionView(mapHolding(holding), mapQuote(quote));
      if (view.marketValueMinor == null) continue;
      byAccount.set(String(holding.account_id), (byAccount.get(String(holding.account_id)) ?? 0) + view.marketValueMinor);
    }
    for (const [accountId, valueMinor] of byAccount) overrides.push({ accountId, valueMinor });
    const worth = visibleNetWorth(loaded, overrides);
    return { ...worth, holdingDaysExample: holdingPeriodDays("2026-01-01", loaded.input.asOf) };
  }

  const incomeHooks = () => ({
    actor,
    assertSpace,
    mustAccount,
    insertIncome: (user: Actor, householdId: string, input: { accountId: string; amountMinor: number; date: string; payee: string; opId: string; spaceId: string; notes?: string }) =>
      insertTransaction(user, householdId, {
        date: input.date,
        accountId: input.accountId,
        amountMinor: input.amountMinor,
        type: "income",
        payee: input.payee,
        splits: [],
        bankStatus: "posted",
        reviewStatus: "reviewed",
        notes: input.notes,
        opId: input.opId,
        spaceId: input.spaceId,
      }),
  });
  mountIncome(app, db, incomeHooks());
  mountLoans(app, db, {
    actor,
    assertSpace,
    mustAccount,
    insertPayment: (user, householdId, input) => insertTransaction(user, householdId, input),
  });
  mountOnboarding(app, db, {
    actor,
    createAccount: (user, householdId, raw, forcedId) => createManualAccount(user, householdId, raw, forcedId),
    createCategory: (user, householdId, raw, forcedId) => createManualCategory(user, householdId, raw, forcedId),
    createIncome: (user, householdId, raw, forcedId) => createIncomeSource(db, user, householdId, raw, incomeHooks(), forcedId),
    createBill: (user, householdId, raw, forcedId) => createBill(db, user, householdId, raw, incomeHooks(), forcedId),
    createGoal: (user, householdId, raw, forcedId) => createManualGoal(user, householdId, raw, forcedId),
  });

  mountReceipts(app, db, {
    actor,
    requireMember: (userId, householdId) => requireMember(db, userId, householdId),
    assertWrite,
    assertSpace,
    mustAccount,
    mustTxn,
    insertTransaction,
    uploadDir,
  });

  return app;
}

const TRANSACTION_TYPES = new Set([
  "income", "expense", "transfer", "refund", "reimbursement", "cc_payment", "loan_payment", "loan_proceeds",
  "opening", "reconciliation", "buy", "sell", "dividend", "interest", "fee",
]);

function devMailEnabled() {
  return process.env.NODE_ENV !== "production";
}

function appOrigin(c: { req: { url: string } }) {
  const configured = process.env.BUDGETCENTS_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return new URL(c.req.url).origin;
}

function verificationMessage(origin: string, token: string) {
  return `Verify your BudgetCents email.\nVerification link: ${origin}/verify?token=${token}\nAndroid link: budgetcents://verify?token=${token}\nThe link expires in two days.`;
}

function resetMessage(origin: string, token: string) {
  return `Reset your BudgetCents password.\nReset link: ${origin}/reset?token=${token}\nAndroid link: budgetcents://reset?token=${token}\nThe link expires in one hour.`;
}

function assertKnownType(type: string) {
  if (!TRANSACTION_TYPES.has(type)) throw new ApiError(400, "That transaction type is not supported.");
}

function splitFromInput(split: { bucketId: string | null; amountMinor: number; role: Transaction["splits"][number]["role"]; memo?: string }): Transaction["splits"][number] {
  return { bucketId: split.bucketId, amountMinor: split.amountMinor, role: split.role, memo: split.memo };
}

function transactionFromRow(row: Record<string, unknown>, splits: Transaction["splits"], overrides: Partial<Transaction> = {}): Transaction {
  const counter = overrides.counterAccountId !== undefined ? overrides.counterAccountId : str(row.counter_account_id);
  return {
    id: String(row.id),
    date: overrides.date ?? String(row.date),
    accountId: overrides.accountId ?? String(row.account_id),
    counterAccountId: counter || undefined,
    amountMinor: overrides.amountMinor ?? num(row.amount_minor),
    currency: overrides.currency ?? String(row.currency),
    type: (overrides.type ?? String(row.type)) as Transaction["type"],
    payee: overrides.payee ?? String(row.payee),
    notes: overrides.notes ?? str(row.notes),
    splits,
    bankStatus: (overrides.bankStatus ?? String(row.bank_status)) as Transaction["bankStatus"],
    reviewStatus: (overrides.reviewStatus ?? String(row.review_status)) as Transaction["reviewStatus"],
    flag: overrides.flag ?? str(row.flag),
    deleted: false,
  };
}

function mapUser(row: Record<string, unknown>): Actor {
  return {
    id: String(row.id), email: String(row.email), displayName: String(row.display_name),
    privacyMode: num(row.privacy_mode) === 1, aiEnabled: num(row.ai_enabled) === 1,
    locale: String(row.locale), timeZone: String(row.time_zone), theme: String(row.theme), weekStart: num(row.week_start),
  };
}

function fundingFor(loaded: Awaited<ReturnType<typeof loadSpace>>) {
  const eligible = eligiblePostedIncomeMinor({
    transactions: loaded.input.transactions,
    accounts: loaded.input.accounts,
    currency: loaded.input.currency,
    from: loaded.budget.periodStart,
    to: loaded.budget.periodEnd,
  });
  return {
    eligiblePostedIncomeMinor: eligible,
    formula: "Eligible income is posted income on an on-budget cash account for this month. Expected pay, transfers, refunds, reimbursements, loan proceeds, opening balances, and unrealized gains are not included. Percentages use basis points: 1 basis point is 0.01 percent, and 10.5 percent is 1050. The target is that income times the rate, rounded to the nearest minor unit.",
    buckets: loaded.input.buckets.map((bucket) => {
      const month = loaded.budget.buckets.find((row) => row.bucketId === bucket.id);
      return targetProgress(bucket, month?.availableMinor ?? 0, month?.assignedMinor ?? 0, eligible);
    }),
  };
}

function flag(value: boolean | undefined): number | null {
  if (value == null) return null;
  return value ? 1 : 0;
}

function mapHolding(row: Record<string, unknown>) {
  return {
    id: String(row.id), accountId: String(row.account_id), symbol: String(row.symbol), name: String(row.name),
    assetClass: String(row.asset_class), sector: str(row.sector), geography: str(row.geography), quantity: String(row.quantity),
    costBasisMinor: row.cost_basis_minor == null ? null : num(row.cost_basis_minor), currency: String(row.currency),
  };
}

function mapQuote(row: Record<string, unknown>) {
  return { symbol: String(row.symbol), priceMinor: num(row.price_minor), asOf: String(row.as_of), source: String(row.source) as "manual" | "provider", delayed: num(row.delayed) === 1, currency: String(row.currency) };
}

async function ownerMaps(db: Database): Promise<Record<string, Record<string, string>>> {
  const maps: Record<string, Record<string, string>> = {};
  for (const table of ["spaces", "buckets", "accounts", "transactions", "assignments", "goals", "schedules"]) {
    const rows = await db.query(`SELECT id, household_id FROM ${table}`);
    maps[table] = Object.fromEntries(rows.map((row) => [String(row.id), String(row.household_id)]));
  }
  const splits = await db.query(`SELECT s.id, t.household_id FROM splits s JOIN transactions t ON t.id = s.transaction_id`);
  maps.splits = Object.fromEntries(splits.map((row) => [String(row.id), String(row.household_id)]));
  const tags = await db.query(`SELECT g.transaction_id, g.tag, t.household_id FROM transaction_tags g JOIN transactions t ON t.id = g.transaction_id`);
  maps.tags = Object.fromEntries(tags.map((row) => [`${row.transaction_id}:${row.tag}`, String(row.household_id)]));
  return maps;
}

async function insertRow(db: Database, table: string, row: Record<string, unknown>, columns: string[]) {
  const present = columns.filter((column) => row[column] !== undefined);
  const values = present.map((column) => row[column]);
  const placeholders = present.map((_, index) => `$${index + 1}`).join(",");
  await db.query(`INSERT INTO ${table} (${present.join(",")}) VALUES (${placeholders})`, values);
}

const splitSchema = z.object({
  bucketId: z.string().nullable(),
  amountMinor: money.nonnegative(),
  role: z.enum(["expense", "income", "principal", "interest", "fee", "escrow", "transfer", "refund"]),
  memo: z.string().optional(),
});

const transactionSchema = z.object({
  spaceId: z.string().optional(),
  date: z.string(),
  accountId: z.string(),
  counterAccountId: z.string().optional(),
  amountMinor: money,
  type: z.string(),
  payee: z.string().min(1),
  originalDescription: z.string().optional(),
  splits: z.array(splitSchema).default([]),
  bankStatus: z.enum(["pending", "posted"]).default("posted"),
  reviewStatus: z.enum(["needs_review", "reviewed"]).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  flag: z.string().optional(),
  checkNumber: z.string().optional(),
  categoryLocked: z.boolean().optional(),
  ownerUserId: z.string().optional(),
  businessSpaceId: z.string().optional(),
  scheduleId: z.string().optional(),
  refundOfId: z.string().optional(),
  providerTransactionId: z.string().optional(),
  opId: z.string().optional(),
  importBatchId: z.string().optional(),
});

export { moneyWeightedReturn, timeWeightedReturn };
