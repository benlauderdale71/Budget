import { allows, displayBalance } from "@budgetcents/domain";
import { Hono } from "hono";
import { z } from "zod";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, type Actor, loadSpace, requireMember } from "./finance.js";

const STEPS = [
  { id: "who", title: "Who this plan is for", optional: false },
  { id: "preferences", title: "Household preferences", optional: false },
  { id: "verify", title: "Email verification", optional: false },
  { id: "accounts", title: "Accounts and opening balances", optional: true },
  { id: "import", title: "Import", optional: true },
  { id: "categories", title: "Categories and envelopes", optional: true },
  { id: "income", title: "Expected income", optional: true },
  { id: "bills", title: "Bills", optional: true },
  { id: "goal", title: "A first goal", optional: true },
  { id: "invite", title: "Household invitations", optional: true },
  { id: "review", title: "Review", optional: false },
] as const;

const STEP_IDS = new Set<string>(STEPS.map((step) => step.id));
const KINDS = ["individual", "couple", "family", "freelancer", "mixed"] as const;
const APPROACHES = ["category", "zero", "envelope", "flex"] as const;
const RESOURCE_KINDS = ["account", "category", "income", "bill", "goal"] as const;
const SECRET_KEY = /password|token|secret|mfa|recovery/i;

const whoSchema = z.object({ kind: z.enum(KINDS) });
const preferencesSchema = z.object({
  householdName: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3),
  locale: z.string().trim().min(2).max(35),
  timeZone: z.string().trim().min(1).max(80),
  weekStart: z.number().int().min(0).max(6),
  approach: z.enum(APPROACHES),
});

export interface OnboardingHooks {
  actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>;
  createAccount: (me: Actor, householdId: string, raw: unknown, forcedId: string) => Promise<{ id: string }>;
  createCategory: (me: Actor, householdId: string, raw: unknown, forcedId: string) => Promise<{ id: string }>;
  createIncome: (me: Actor, householdId: string, raw: unknown, forcedId: string) => Promise<{ id: string }>;
  createBill: (me: Actor, householdId: string, raw: unknown, forcedId: string) => Promise<{ id: string }>;
  createGoal: (me: Actor, householdId: string, raw: unknown, forcedId: string) => Promise<{ id: string }>;
}

interface StateRow {
  user_id: string;
  household_id: string;
  step: string;
  completed_json: string;
  skipped_json: string;
  draft_json: string;
  version: number | string;
  finished_at: string | null;
  updated_at: string;
}

export function mountOnboarding(app: Hono, db: Database, hooks: OnboardingHooks) {
  app.get("/api/households/:hid/onboarding", async (c) => {
    const me = await hooks.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    if (member.isDemo) return c.json({ demo: true, note: "This is the sample household. Its records are fictional and are not your setup." });
    const state = await ensureState(db, me.id, member.householdId);
    return c.json(await present(db, me, member.householdId, state));
  });

  app.patch("/api/households/:hid/onboarding", async (c) => {
    const me = await hooks.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    if (member.isDemo) throw new ApiError(400, "The sample household is fictional. Create your own household for setup.");
    const body = z.object({
      version: z.number().int().positive(),
      step: z.string().optional(),
      complete: z.string().optional(),
      skip: z.string().optional(),
      draft: z.record(z.unknown()).optional(),
      who: whoSchema.optional(),
      preferences: preferencesSchema.optional(),
      finish: z.boolean().optional(),
    }).parse(await c.req.json());
    if (body.complete === "verify") throw new ApiError(400, "Email verification is confirmed by the verification link, not by this step.");
    if (body.step && !STEP_IDS.has(body.step)) throw new ApiError(400, "That setup step is not part of this flow.");
    if (body.complete && !STEP_IDS.has(body.complete)) throw new ApiError(400, "That setup step is not part of this flow.");
    if (body.skip && !STEP_IDS.has(body.skip)) throw new ApiError(400, "That setup step is not part of this flow.");
    if (body.skip && !STEPS.find((step) => step.id === body.skip)?.optional && body.skip !== "verify") {
      throw new ApiError(400, "Save this step before leaving it. It is part of the required setup.");
    }
    if ((body.who || body.preferences) && !allows(member.role, "plan")) {
      throw new ApiError(403, "Your role cannot change this household.");
    }
    if (body.preferences) assertTimeZone(body.preferences.timeZone);
    const current = await ensureState(db, me.id, member.householdId);
    const completed = parseList(current.completed_json).filter((step) => step !== "verify");
    const skipped = parseList(current.skipped_json);
    let draft = parseDraft(current.draft_json);
    let step = current.step;
    let finishedAt = current.finished_at;
    if (body.who) {
      add(completed, "who");
      remove(skipped, "who");
      draft.who = { kind: body.who.kind };
    }
    if (body.preferences) {
      add(completed, "preferences");
      remove(skipped, "preferences");
      draft.preferences = body.preferences;
    }
    if (body.complete && body.complete !== "verify") {
      add(completed, body.complete);
      remove(skipped, body.complete);
    }
    if (body.skip) {
      add(skipped, body.skip);
      remove(completed, body.skip);
    }
    if (body.draft) draft = mergeDraft(draft, sanitize(body.draft));
    if (body.step) step = body.step;
    if (body.finish) {
      if (!completed.includes("who") || !completed.includes("preferences")) {
        throw new ApiError(400, "Save who this plan is for and the household preferences before finishing.");
      }
      finishedAt = finishedAt ?? nowIso();
      step = "review";
    }
    const saved = await db.tx(async () => {
      if (body.who) await db.query(`UPDATE households SET kind = $1 WHERE id = $2`, [body.who.kind, member.householdId]);
      if (body.preferences) {
        const prefs = body.preferences;
        await db.query(
          `UPDATE households SET name = $1, currency = $2, budget_approach = $3, time_zone = $4, week_start = $5 WHERE id = $6`,
          [prefs.householdName, prefs.currency.toUpperCase(), prefs.approach, prefs.timeZone, prefs.weekStart, member.householdId],
        );
        await db.query(
          `UPDATE users SET locale = $1, time_zone = $2, week_start = $3, budget_approach = $4 WHERE id = $5`,
          [prefs.locale, prefs.timeZone, prefs.weekStart, prefs.approach, me.id],
        );
        if (draft.who && (draft.who as { kind?: string }).kind === "mixed") await ensureBusinessSpace(db, member.householdId, prefs.currency.toUpperCase());
      }
      const userStep = finishedAt ? "done" : step;
      await db.query(`UPDATE users SET onboarding_step = $1 WHERE id = $2`, [userStep, me.id]);
      const rows = await db.query(
        `UPDATE onboarding_states
         SET step = $1, completed_json = $2, skipped_json = $3, draft_json = $4, finished_at = $5, updated_at = $6, version = version + 1
         WHERE user_id = $7 AND household_id = $8 AND version = $9
         RETURNING *`,
        [step, JSON.stringify(completed), JSON.stringify(skipped), JSON.stringify(draft), finishedAt, nowIso(), me.id, member.householdId, body.version],
      );
      if (!rows.length) throw new ApiError(409, "Someone else changed this setup. Reload it and try again.");
      return rows[0] as unknown as StateRow;
    });
    return c.json(await present(db, me, member.householdId, saved));
  });

  app.post("/api/households/:hid/onboarding/resources", async (c) => {
    const me = await hooks.actor(c);
    const member = await requireMember(db, me.id, c.req.param("hid"));
    if (member.isDemo) throw new ApiError(400, "The sample household is fictional. Create your own household for setup.");
    const body = z.object({
      version: z.number().int().positive(),
      kind: z.enum(RESOURCE_KINDS),
      setupKey: z.string().trim().min(1).max(80),
      payload: z.unknown(),
    }).parse(await c.req.json());
    await ensureState(db, me.id, member.householdId);
    const created = await claimResource(db, me, member.householdId, body.version, body.kind, body.setupKey, async (forcedId) => {
      if (body.kind === "account") return hooks.createAccount(me, member.householdId, body.payload, forcedId);
      if (body.kind === "category") return hooks.createCategory(me, member.householdId, body.payload, forcedId);
      if (body.kind === "income") return hooks.createIncome(me, member.householdId, body.payload, forcedId);
      if (body.kind === "bill") return hooks.createBill(me, member.householdId, body.payload, forcedId);
      return hooks.createGoal(me, member.householdId, body.payload, forcedId);
    });
    const state = await ensureState(db, me.id, member.householdId);
    return c.json({ ...created, onboarding: await present(db, me, member.householdId, state) }, created.duplicate ? 200 : 201);
  });
}

async function claimResource(
  db: Database,
  me: Actor,
  householdId: string,
  version: number,
  kind: string,
  setupKey: string,
  create: (forcedId: string) => Promise<{ id: string }>,
) {
  return db.tx(async () => {
    const resourceId = id();
    const claimed = await db.query(
      `INSERT INTO onboarding_keys (household_id, user_id, kind, setup_key, resource_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (household_id, user_id, kind, setup_key) DO NOTHING
       RETURNING resource_id`,
      [householdId, me.id, kind, setupKey, resourceId, nowIso()],
    );
    if (!claimed.length) {
      const existing = await db.query(
        `SELECT resource_id FROM onboarding_keys WHERE household_id = $1 AND user_id = $2 AND kind = $3 AND setup_key = $4`,
        [householdId, me.id, kind, setupKey],
      );
      const state = await db.query(`SELECT version FROM onboarding_states WHERE user_id = $1 AND household_id = $2`, [me.id, householdId]);
      return { id: String(existing[0].resource_id), duplicate: true, version: num(state[0].version) };
    }
    const bumped = await db.query(
      `UPDATE onboarding_states SET version = version + 1, updated_at = $1 WHERE user_id = $2 AND household_id = $3 AND version = $4 RETURNING version`,
      [nowIso(), me.id, householdId, version],
    );
    if (!bumped.length) throw new ApiError(409, "Someone else changed this setup. Reload it and try again.");
    const created = await create(resourceId);
    if (created.id !== resourceId) throw new ApiError(500, "The setup save did not keep its id.");
    return { id: created.id, duplicate: false, version: num(bumped[0].version) };
  });
}

async function ensureState(db: Database, userId: string, householdId: string): Promise<StateRow> {
  const existing = await db.query(`SELECT * FROM onboarding_states WHERE user_id = $1 AND household_id = $2`, [userId, householdId]);
  if (existing.length) return existing[0] as unknown as StateRow;
  const user = await db.query(`SELECT onboarding_step FROM users WHERE id = $1`, [userId]);
  const seeded = seedFromLegacy(str(user[0]?.onboarding_step) ?? null);
  await db.query(
    `INSERT INTO onboarding_states (user_id, household_id, step, completed_json, skipped_json, draft_json, version, finished_at, updated_at)
     VALUES ($1,$2,$3,$4,'[]',$5,1,$6,$7)
     ON CONFLICT (user_id, household_id) DO NOTHING`,
    [userId, householdId, seeded.step, JSON.stringify(seeded.completed), JSON.stringify(seeded.draft), seeded.finishedAt, nowIso()],
  );
  const rows = await db.query(`SELECT * FROM onboarding_states WHERE user_id = $1 AND household_id = $2`, [userId, householdId]);
  return rows[0] as unknown as StateRow;
}

function seedFromLegacy(step: string | null) {
  if (step === "done") return { step: "review", completed: ["who", "preferences"], draft: {}, finishedAt: nowIso() };
  if (step && KINDS.includes(step as (typeof KINDS)[number])) {
    return { step: "preferences", completed: ["who"], draft: { who: { kind: step } }, finishedAt: null };
  }
  if (step && STEP_IDS.has(step)) return { step, completed: [], draft: {}, finishedAt: null };
  return { step: "who", completed: [], draft: {}, finishedAt: null };
}

async function present(db: Database, me: Actor, householdId: string, state: StateRow) {
  const user = await db.query(`SELECT email_verified_at FROM users WHERE id = $1`, [me.id]);
  const emailVerified = Boolean(user[0]?.email_verified_at);
  const completed = parseList(state.completed_json).filter((step) => step !== "verify");
  const skipped = parseList(state.skipped_json);
  const finished = Boolean(state.finished_at);
  let step = state.step;
  if (step === "verify" && emailVerified) step = nextOpen(completed, skipped, emailVerified);
  const loaded = await loadSpace(db, me, householdId);
  const accounts = loaded.input.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    kind: account.kind,
    balanceMinor: displayBalance(account, loaded.input.transactions, loaded.input.asOf),
  }));
  const income = await db.query(
    `SELECT id, name, amount_minor, cadence FROM income_sources WHERE household_id = $1 AND archived = 0 ORDER BY name`,
    [householdId],
  );
  const givenAJobMinor = loaded.budget.claimsMinor - loaded.budget.readyToAssignMinor - loaded.budget.futureAssignedMinor;
  const notFinished = [
    ...STEPS.filter((item) => item.optional && !completed.includes(item.id) && !skipped.includes(item.id)).map((item) => item.title),
    ...(!emailVerified ? ["Email not verified"] : []),
  ];
  return {
    version: num(state.version),
    step,
    finished,
    emailVerified,
    bankLinking: "unavailable",
    policy: "An unverified account can sign in and finish manual setup. Invitations stay closed until the email is verified. Saving a step does not verify the email or grant another role.",
    steps: STEPS.map((item) => ({
      id: item.id,
      title: item.title,
      optional: item.optional,
      status: statusFor(item.id, completed, skipped, step, emailVerified),
    })),
    draft: parseDraft(state.draft_json),
    spaceId: loaded.spaceId,
    buckets: loaded.input.buckets.filter((bucket) => !bucket.archived && !bucket.systemRole).map((bucket) => ({ id: bucket.id, name: bucket.name, kind: bucket.kind })),
    review: {
      actualBalances: accounts,
      expectedIncome: income.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        amountMinor: num(row.amount_minor),
        cadence: String(row.cadence),
        note: "Expected future income. It is not cash, Ready to Assign, or net worth.",
      })),
      allocations: {
        readyToAssignMinor: loaded.budget.readyToAssignMinor,
        givenAJobMinor,
        note: "Budget allocations are money already given a job. Expected income is not included.",
      },
      notFinished,
    },
  };
}

function statusFor(id: string, completed: string[], skipped: string[], current: string, emailVerified: boolean) {
  if (id === "verify") {
    if (emailVerified) return "done";
    if (skipped.includes(id)) return "skipped";
    return current === id ? "current" : "open";
  }
  if (completed.includes(id)) return "done";
  if (skipped.includes(id)) return "skipped";
  return current === id ? "current" : "open";
}

function nextOpen(completed: string[], skipped: string[], emailVerified: boolean) {
  for (const step of STEPS) {
    if (step.id === "verify") {
      if (!emailVerified && !skipped.includes("verify")) return "verify";
      continue;
    }
    if (!completed.includes(step.id) && !skipped.includes(step.id)) return step.id;
  }
  return "review";
}

async function ensureBusinessSpace(db: Database, householdId: string, currency: string) {
  const existing = await db.query(`SELECT id FROM spaces WHERE household_id = $1 AND kind = 'business'`, [householdId]);
  if (existing.length) return;
  await db.query(
    `INSERT INTO spaces (id, household_id, name, kind, currency, created_at) VALUES ($1,$2,'Business','business',$3,$4)`,
    [id(), householdId, currency, nowIso()],
  );
}

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new ApiError(400, "That time zone was not recognized.");
  }
}

function parseList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && STEP_IDS.has(item)) : [];
  } catch {
    return [];
  }
}

function parseDraft(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? sanitize(parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mergeDraft(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete next[key];
    else next[key] = value;
  }
  const encoded = JSON.stringify(next);
  if (encoded.length > 20_000) throw new ApiError(400, "That setup draft is too large.");
  return next;
}

function sanitize(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = sanitizeValue(item);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? sanitize(item as Record<string, unknown>) : item));
  if (value && typeof value === "object") return sanitize(value as Record<string, unknown>);
  return value;
}

function add(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

function remove(list: string[], value: string) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}
