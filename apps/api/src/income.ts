import { Hono } from "hono";
import { z } from "zod";
import {
  addDays,
  assertRepeatingSchedule,
  coerceCadence,
  eligiblePostedIncomeMinor,
  expandSchedule,
  forecastDatesForSchedule,
  isIsoDate,
  nextScheduleDate,
  planPaychecks,
  projectCash,
  SCHEDULE_EXPLANATION,
  scenarioAssumption,
  showIncomeOccurrences,
  type IncomeOccurrenceState,
  type IncomeScenario,
  type RepeatingSchedule,
} from "@budgetcents/domain";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import {
  ApiError,
  type Actor,
  assertBudget,
  assertWrite,
  audit,
  canSeeAccount,
  forecastEventsFromSchedules,
  loadSpace,
  lockHousehold,
  requireMember,
  setAssignment,
  visibleNetWorth,
} from "./finance.js";

const KINDS = ["salary", "hourly", "freelance", "commission", "bonus", "seasonal", "benefit", "other", "irregular"] as const;
const money = z.number().int().nonnegative();

const sourceSchema = z.object({
  spaceId: z.string(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS),
  ownerUserId: z.string().nullable().optional(),
  accountId: z.string(),
  amountMinor: money,
  amountMaxMinor: money.nullable().optional(),
  cadence: z.string(),
  customInterval: z.number().int().nullable().optional(),
  anchorDay: z.number().int().nullable().optional(),
  twiceDays: z.tuple([z.number().int(), z.number().int()]).nullable().optional(),
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  dates: z.array(z.object({
    date: z.string(),
    amountMinor: money,
    amountMaxMinor: money.nullable().optional(),
    note: z.string().max(500).optional(),
  })).max(120).optional(),
  exceptions: z.array(z.string()).max(120).optional(),
  version: z.number().int().optional(),
});

const billSchema = z.object({
  spaceId: z.string(),
  name: z.string().trim().min(1).max(120),
  cadence: z.string(),
  nextDate: z.string(),
  amountMinor: money,
  amountMaxMinor: money.nullable().optional(),
  direction: z.enum(["inflow", "outflow"]),
  type: z.enum(["income", "bill", "subscription", "transfer", "debt_payment"]),
  accountId: z.string().optional(),
  bucketId: z.string().optional(),
  payee: z.string().optional(),
  customInterval: z.number().int().nullable().optional(),
  anchorDay: z.number().int().nullable().optional(),
  twiceDays: z.tuple([z.number().int(), z.number().int()]).nullable().optional(),
  endDate: z.string().nullable().optional(),
  exceptions: z.array(z.string()).max(120).optional(),
  paused: z.boolean().optional(),
});

export interface IncomeHooks {
  actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>;
  assertSpace: (userId: string, householdId: string, spaceId: string) => Promise<void>;
  mustAccount: (userId: string, householdId: string, accountId: string) => Promise<Record<string, unknown>>;
  insertIncome: (me: Actor, householdId: string, input: { accountId: string; amountMinor: number; date: string; payee: string; opId: string; spaceId: string; notes?: string }) => Promise<{ id: string | null; duplicate?: boolean }>;
}

type SourceBody = z.infer<typeof sourceSchema>;

function scheduleFromBody(body: SourceBody): RepeatingSchedule {
  return {
    cadence: body.cadence as RepeatingSchedule["cadence"],
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    customInterval: body.customInterval ?? null,
    anchorDay: body.anchorDay ?? null,
    twiceDays: body.twiceDays ?? null,
    amountMinor: body.amountMinor,
    amountMaxMinor: body.amountMaxMinor ?? null,
    dates: body.dates,
    exceptions: body.exceptions,
  };
}

function normalizedSchedule(schedule: RepeatingSchedule): RepeatingSchedule {
  const cadence = coerceCadence(schedule.cadence);
  if (!cadence) throw new ApiError(400, "That schedule is not one BudgetCents can keep.");
  const next = { ...schedule, cadence };
  if (next.cadence === "twice_monthly" && !next.twiceDays) next.twiceDays = [1, 15];
  assertRepeatingSchedule(next);
  return next;
}

function assertCashAccount(account: Record<string, unknown>) {
  if (!["checking", "savings", "cash"].includes(String(account.kind)) || num(account.on_budget) !== 1 || num(account.archived) === 1) {
    throw new ApiError(400, "A paycheck has to use an on-budget checking, savings, or cash account.");
  }
}

async function assertOwner(db: Database, householdId: string, ownerUserId: string | null | undefined) {
  if (!ownerUserId) return;
  const rows = await db.query(`SELECT user_id FROM memberships WHERE household_id = $1 AND user_id = $2`, [householdId, ownerUserId]);
  if (!rows.length) throw new ApiError(400, "The earner has to be a member of this household.");
}

function canSeeRow(userId: string, account: Record<string, unknown> | undefined): boolean {
  if (!account) return false;
  return canSeeAccount(userId, { visibility: String(account.visibility), owner_user_id: str(account.owner_user_id) ?? null });
}

async function accountMap(db: Database, householdId: string) {
  const rows = await db.query(`SELECT * FROM accounts WHERE household_id = $1`, [householdId]);
  return new Map(rows.map((row) => [String(row.id), row]));
}

function mapSource(row: Record<string, unknown>, dates: Record<string, unknown>[], exceptions: string[]) {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    name: String(row.name),
    kind: String(row.kind),
    ownerUserId: str(row.owner_user_id) ?? null,
    accountId: String(row.account_id),
    amountMinor: num(row.amount_minor),
    amountMaxMinor: row.amount_max_minor == null ? null : num(row.amount_max_minor),
    cadence: String(row.cadence),
    customInterval: row.custom_interval == null ? null : num(row.custom_interval),
    anchorDay: row.anchor_day == null ? null : num(row.anchor_day),
    twiceDays: row.twice_day_a == null ? null : [num(row.twice_day_a), num(row.twice_day_b)],
    startDate: String(row.start_date),
    endDate: str(row.end_date) ?? null,
    paused: num(row.paused) === 1,
    archived: num(row.archived) === 1,
    notes: str(row.notes) ?? null,
    version: num(row.version, 1),
    dates: dates.map((date) => ({
      date: String(date.expected_date),
      amountMinor: num(date.amount_minor),
      amountMaxMinor: date.amount_max_minor == null ? null : num(date.amount_max_minor),
      note: str(date.note) ?? null,
    })),
    exceptions,
  };
}

function scheduleFromRow(row: Record<string, unknown>, dates: Record<string, unknown>[], exceptions: string[]): RepeatingSchedule {
  return normalizedSchedule({
    cadence: String(row.cadence) as RepeatingSchedule["cadence"],
    startDate: String(row.start_date),
    endDate: str(row.end_date) ?? null,
    customInterval: row.custom_interval == null ? null : num(row.custom_interval),
    anchorDay: row.anchor_day == null ? null : num(row.anchor_day),
    twiceDays: row.twice_day_a == null ? null : [num(row.twice_day_a), num(row.twice_day_b)],
    amountMinor: num(row.amount_minor),
    amountMaxMinor: row.amount_max_minor == null ? null : num(row.amount_max_minor),
    dates: dates.map((date) => ({ date: String(date.expected_date), amountMinor: num(date.amount_minor), amountMaxMinor: date.amount_max_minor == null ? null : num(date.amount_max_minor) })),
    exceptions,
  });
}

async function datesOf(db: Database, sourceId: string) {
  return db.query(`SELECT * FROM income_dates WHERE source_id = $1 ORDER BY expected_date`, [sourceId]);
}

async function exceptionsOf(db: Database, sourceId: string) {
  const rows = await db.query(`SELECT exception_date FROM income_exceptions WHERE source_id = $1 ORDER BY exception_date`, [sourceId]);
  return rows.map((row) => String(row.exception_date));
}

async function replaceScheduleRows(db: Database, sourceId: string, schedule: RepeatingSchedule) {
  await db.query(`DELETE FROM income_dates WHERE source_id = $1`, [sourceId]);
  await db.query(`DELETE FROM income_exceptions WHERE source_id = $1`, [sourceId]);
  for (const date of schedule.dates ?? []) {
    await db.query(
      `INSERT INTO income_dates (source_id, expected_date, amount_minor, amount_max_minor) VALUES ($1,$2,$3,$4)`,
      [sourceId, date.date, date.amountMinor, date.amountMaxMinor ?? null],
    );
  }
  for (const date of schedule.exceptions ?? []) {
    await db.query(`INSERT INTO income_exceptions (source_id, exception_date) VALUES ($1,$2)`, [sourceId, date]);
  }
}

function stateOf(row: Record<string, unknown>): IncomeOccurrenceState {
  return {
    expectedDate: String(row.expected_date),
    status: String(row.status) as IncomeOccurrenceState["status"],
    expectedAmountMinor: num(row.expected_amount_minor),
    revisedDate: str(row.revised_date) ?? null,
    revisedAmountMinor: row.revised_amount_minor == null ? null : num(row.revised_amount_minor),
    remainingMinor: row.remaining_minor == null ? null : num(row.remaining_minor),
    delayedUntil: str(row.delayed_until) ?? null,
    receivedAmountMinor: row.received_amount_minor == null ? null : num(row.received_amount_minor),
    receivedDate: str(row.received_date) ?? null,
    transactionId: str(row.transaction_id) ?? null,
  };
}

function publicOccurrence(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    expectedDate: String(row.expected_date),
    status: String(row.status),
    expectedAmountMinor: num(row.expected_amount_minor),
    revisedDate: str(row.revised_date) ?? null,
    revisedAmountMinor: row.revised_amount_minor == null ? null : num(row.revised_amount_minor),
    receivedDate: str(row.received_date) ?? null,
    receivedAmountMinor: row.received_amount_minor == null ? null : num(row.received_amount_minor),
    remainingMinor: row.remaining_minor == null ? null : num(row.remaining_minor),
    delayedUntil: str(row.delayed_until) ?? null,
    transactionId: str(row.transaction_id) ?? null,
    extraTransactionId: str(row.extra_transaction_id) ?? null,
    note: str(row.note) ?? null,
    operationId: str(row.client_op_id) ?? str(row.settle_op_id) ?? null,
    updatedAt: String(row.updated_at),
  };
}

async function mustSource(db: Database, me: Actor, householdId: string, sourceId: string, hooks: IncomeHooks) {
  const member = await requireMember(db, me.id, householdId);
  const rows = await db.query(`SELECT * FROM income_sources WHERE id = $1 AND household_id = $2`, [sourceId, member.householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  await hooks.assertSpace(me.id, member.householdId, String(rows[0].space_id));
  const account = await hooks.mustAccount(me.id, member.householdId, String(rows[0].account_id));
  return { member, source: rows[0], account };
}

async function loadBundle(db: Database, source: Record<string, unknown>) {
  const dates = await datesOf(db, String(source.id));
  const exceptions = await exceptionsOf(db, String(source.id));
  const occurrences = await db.query(`SELECT * FROM income_occurrences WHERE source_id = $1 ORDER BY expected_date`, [source.id]);
  return { dates, exceptions, occurrences, schedule: scheduleFromRow(source, dates, exceptions) };
}

async function visibleSources(db: Database, me: Actor, householdId: string, spaceId: string, archived: boolean) {
  const rows = await db.query(
    `SELECT * FROM income_sources WHERE household_id = $1 AND space_id = $2 AND archived = $3 ORDER BY name`,
    [householdId, spaceId, archived ? 1 : 0],
  );
  const accounts = await accountMap(db, householdId);
  return rows.filter((row) => canSeeRow(me.id, accounts.get(String(row.account_id))));
}

function plannedAmount(schedule: RepeatingSchedule, states: IncomeOccurrenceState[], expectedDate: string): number {
  const state = states.find((item) => item.expectedDate === expectedDate);
  if (state?.revisedAmountMinor != null) return state.revisedAmountMinor;
  if (state?.status === "partial") return state.remainingMinor ?? 0;
  const listed = schedule.dates?.find((item) => item.date === expectedDate);
  return listed ? listed.amountMinor : schedule.amountMinor;
}

export async function paycheckPlan(db: Database, me: Actor, householdId: string, query: { spaceId?: string; asOf?: string; scenario?: string; from?: string; to?: string }) {
  const scenario: IncomeScenario = query.scenario === "conservative" || query.scenario === "optimistic" ? query.scenario : "expected";
  const loaded = await loadSpace(db, me, householdId, query.spaceId, query.asOf);
  const from = query.from && isIsoDate(query.from) ? query.from : loaded.input.asOf;
  const to = query.to && isIsoDate(query.to) ? query.to : addDays(loaded.input.asOf, 120);
  const sources = await visibleSources(db, me, loaded.member.householdId, loaded.spaceId, false);
  const upcoming: { sourceId: string; name: string; earner: string; key: string; expectedDate: string; date: string; amountMinor: number; status: string; countsAsExpected: boolean; inFutureForecast: boolean; receivedAmountMinor: number | null; transactionId: string | null }[] = [];
  for (const source of sources) {
    const bundle = await loadBundle(db, source);
    const shown = showIncomeOccurrences({
      sourceId: String(source.id),
      schedule: bundle.schedule,
      states: bundle.occurrences.map(stateOf),
      from,
      until: to,
      scenario,
      asOf: loaded.input.asOf,
    });
    const paused = num(source.paused) === 1;
    for (const item of shown) {
      upcoming.push({
        sourceId: String(source.id),
        name: String(source.name),
        earner: str(source.owner_user_id) ?? String(source.name),
        ...item,
        status: paused ? "paused" : item.status,
        countsAsExpected: paused ? false : item.countsAsExpected,
        inFutureForecast: paused ? false : item.inFutureForecast,
      });
    }
  }
  const days = Math.min(370, Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${loaded.input.asOf}T00:00:00Z`)) / 86_400_000) + 1));
  const billEvents = forecastEventsFromSchedules(loaded.input.schedules ?? [], loaded.input.asOf, days - 1, loaded.input.transactions);
  const sourceEvents = upcoming.filter((item) => item.inFutureForecast).map((item) => ({
    id: item.key,
    date: item.date,
    amountMinor: item.amountMinor,
    label: item.name,
    kind: "income" as const,
    expectedIncome: true,
  }));
  const combined = [...billEvents.map((event) => ({ ...event, kind: event.kind })), ...sourceEvents];
  const cash = projectCash({ startingMinor: loaded.budget.cashPoolMinor, startDate: loaded.input.asOf, days, events: combined, includeExpectedIncome: false });
  const withExpected = projectCash({ startingMinor: loaded.budget.cashPoolMinor, startDate: loaded.input.asOf, days, events: combined, includeExpectedIncome: true });
  const obligations = billEvents.filter((event) => event.amountMinor < 0).map((event) => {
    const schedule = loaded.input.schedules?.find((item) => item.id === (event.scheduleId ?? event.id));
    const amountMinor = -event.amountMinor;
    return { id: event.id, date: event.date, amountMinor, name: event.label, reservedMinor: schedule?.reserved ? amountMinor : 0 };
  });
  const paychecks = [
    ...billEvents.filter((event) => event.expectedIncome).map((event) => ({ id: event.id, date: event.date, amountMinor: event.amountMinor, received: false, earner: event.label })),
    ...upcoming.filter((item) => item.countsAsExpected && item.date > loaded.input.asOf).map((item) => ({ id: item.key, date: item.date, amountMinor: item.amountMinor, received: false, earner: item.name })),
  ];
  const coverage = planPaychecks({ asOf: loaded.input.asOf, startingCashMinor: loaded.budget.cashPoolMinor, paychecks, obligations });
  const worth = visibleNetWorth(loaded);
  const eligible = eligiblePostedIncomeMinor({ transactions: loaded.input.transactions, accounts: loaded.input.accounts, currency: loaded.input.currency, from: loaded.budget.periodStart, to: loaded.budget.periodEnd });
  const overdue = upcoming.filter((item) => item.status === "overdue").length;
  const delayed = upcoming.filter((item) => item.status === "delayed").length;
  return {
    asOf: loaded.input.asOf,
    timeZone: loaded.member.timeZone,
    scenario,
    explanation: SCHEDULE_EXPLANATION,
    assumptions: [
      scenarioAssumption(scenario),
      "Actual cash, Ready to Assign, and net worth do not include expected pay. A date arriving does not post the paycheck.",
      "The figure that includes expected pay is a projection. It is not money you can assign.",
      coverage.formula,
    ],
    actual: {
      cashMinor: loaded.budget.cashPoolMinor,
      readyToAssignMinor: loaded.budget.readyToAssignMinor,
      netWorthMinor: worth.netMinor,
      incomeMinor: loaded.budget.incomeMinor,
      eligiblePostedIncomeMinor: eligible,
    },
    receivedSoFarMinor: eligible,
    next: coverage.beforeNext.nextPaycheckDate ? { date: coverage.beforeNext.nextPaycheckDate, amountMinor: coverage.beforeNext.paycheckMinor, name: coverage.beforeNext.earner } : null,
    billsBeforeNext: coverage.beforeNext.obligations,
    committedMinor: coverage.beforeNext.uncoveredMinor,
    shortfallMinor: coverage.beforeNext.shortageMinor,
    projectedCashMinor: cash.endingMinor,
    projectedWithExpectedMinor: withExpected.endingMinor,
    cashProjection: cash,
    expectedProjection: withExpected,
    states: { empty: sources.length === 0, overdue, delayed, missing: !upcoming.some((item) => item.inFutureForecast) },
    expectedReceipts: upcoming.filter((item) => item.countsAsExpected).map((item) => ({ sourceId: item.sourceId, name: item.name, date: item.date, expectedDate: item.expectedDate, amountMinor: item.amountMinor, status: item.status })),
    upcoming,
    sources: await Promise.all(sources.map(async (source) => mapSource(source, await datesOf(db, String(source.id)), await exceptionsOf(db, String(source.id))))),
    note: "Expected income is not cash, Ready to Assign, or net worth.",
    paychecks: coverage,
    spaceId: loaded.spaceId,
  };
}

export function mountIncome(app: Hono, db: Database, hooks: IncomeHooks) {
  app.get("/api/households/:hid/income-sources", async (c) => {
    const me = await hooks.actor(c);
    const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const includeArchived = c.req.query("archived") === "1";
    const active = await visibleSources(db, me, loaded.member.householdId, loaded.spaceId, false);
    const archived = includeArchived ? await visibleSources(db, me, loaded.member.householdId, loaded.spaceId, true) : [];
    const map = async (source: Record<string, unknown>) => mapSource(source, await datesOf(db, String(source.id)), await exceptionsOf(db, String(source.id)));
    return c.json({ sources: await Promise.all(active.map(map)), archived: await Promise.all(archived.map(map)), explanation: SCHEDULE_EXPLANATION, spaceId: loaded.spaceId });
  });

  app.post("/api/households/:hid/income-sources", async (c) => {
    const me = await hooks.actor(c);
    const created = await createIncomeSource(db, me, c.req.param("hid"), await c.req.json(), hooks);
    return c.json(created, 201);
  });

  app.get("/api/households/:hid/income-sources/:id", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await readIncomeSource(db, me, c.req.param("hid"), c.req.param("id"), c.req.query("from") ?? undefined, c.req.query("to") ?? undefined, hooks));
  });

  app.patch("/api/households/:hid/income-sources/:id", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await updateIncomeSource(db, me, c.req.param("hid"), c.req.param("id"), await c.req.json(), hooks));
  });

  for (const action of ["pause", "resume", "archive", "restore"] as const) {
    app.post(`/api/households/:hid/income-sources/:id/${action}`, async (c) => {
      const me = await hooks.actor(c);
      const body = z.object({ version: z.number().int() }).parse(await c.req.json());
      return c.json(await setIncomeFlag(db, me, c.req.param("hid"), c.req.param("id"), action, body.version, hooks));
    });
  }

  app.post("/api/households/:hid/income-sources/:id/receive", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await receiveIncome(db, me, c.req.param("hid"), c.req.param("id"), await c.req.json(), hooks));
  });

  app.post("/api/households/:hid/income-sources/:id/delay", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await delayIncome(db, me, c.req.param("hid"), c.req.param("id"), await c.req.json(), hooks));
  });

  app.post("/api/households/:hid/income-sources/:id/cancel", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await cancelIncome(db, me, c.req.param("hid"), c.req.param("id"), await c.req.json(), hooks));
  });

  app.post("/api/households/:hid/income-sources/:id/revise", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await reviseIncome(db, me, c.req.param("hid"), c.req.param("id"), await c.req.json(), hooks));
  });

  app.get("/api/households/:hid/paychecks", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await paycheckPlan(db, me, c.req.param("hid"), { spaceId: c.req.query("spaceId") ?? undefined, asOf: c.req.query("asOf") ?? undefined, scenario: c.req.query("scenario") ?? undefined, from: c.req.query("from") ?? undefined, to: c.req.query("to") ?? undefined }));
  });

  app.get("/api/households/:hid/calendar", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await calendarView(db, me, c.req.param("hid"), { spaceId: c.req.query("spaceId") ?? undefined, asOf: c.req.query("asOf") ?? undefined, from: c.req.query("from") ?? "", to: c.req.query("to") ?? "", scenario: c.req.query("scenario") ?? undefined }));
  });

  app.patch("/api/households/:hid/schedules/:id", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await updateBill(db, me, c.req.param("hid"), c.req.param("id"), await c.req.json(), hooks));
  });

  app.post("/api/households/:hid/schedules/:id/reserve", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await reserveBill(db, me, c.req.param("hid"), c.req.param("id"), hooks));
  });
}

async function createIncomeSource(db: Database, me: Actor, householdId: string, raw: unknown, hooks: IncomeHooks) {
  const member = await requireMember(db, me.id, householdId);
  assertBudget(member);
  const body = sourceSchema.parse(raw);
  const schedule = normalizedSchedule(scheduleFromBody(body));
  await hooks.assertSpace(me.id, member.householdId, body.spaceId);
  const account = await hooks.mustAccount(me.id, member.householdId, body.accountId);
  if (String(account.space_id) !== body.spaceId) throw new ApiError(400, "That account is in a different space.");
  assertCashAccount(account);
  await assertOwner(db, member.householdId, body.ownerUserId);
  const sourceId = id();
  const now = nowIso();
  await db.tx(async () => {
    await lockHousehold(db, member.householdId);
    await db.query(
      `INSERT INTO income_sources (id, household_id, space_id, name, kind, owner_user_id, account_id, amount_minor, amount_max_minor, cadence, custom_interval, anchor_day, twice_day_a, twice_day_b, start_date, end_date, notes, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1,$18,$18)`,
      [sourceId, member.householdId, body.spaceId, body.name, body.kind, body.ownerUserId || null, body.accountId, schedule.amountMinor, schedule.amountMaxMinor ?? null, schedule.cadence, schedule.customInterval ?? null, schedule.anchorDay ?? null, schedule.twiceDays?.[0] ?? null, schedule.twiceDays?.[1] ?? null, schedule.startDate, schedule.endDate ?? null, body.notes ?? null, now],
    );
    await replaceScheduleRows(db, sourceId, schedule);
    await audit(db, member.householdId, me.id, "income.create", `Saved expected income ${body.name}`, "income_source", sourceId);
  });
  return { id: sourceId, version: 1, note: "Expected income was saved. Account balances, Ready to Assign, and net worth were not changed." };
}

async function updateIncomeSource(db: Database, me: Actor, householdId: string, sourceId: string, raw: unknown, hooks: IncomeHooks) {
  const body = sourceSchema.parse(raw);
  if (body.version == null) throw new ApiError(400, "Reload this income source before saving it.");
  const schedule = normalizedSchedule(scheduleFromBody(body));
  const { member, source } = await mustSource(db, me, householdId, sourceId, hooks);
  assertBudget(member);
  await hooks.assertSpace(me.id, member.householdId, body.spaceId);
  const account = await hooks.mustAccount(me.id, member.householdId, body.accountId);
  if (String(account.space_id) !== body.spaceId) throw new ApiError(400, "That account is in a different space.");
  assertCashAccount(account);
  await assertOwner(db, member.householdId, body.ownerUserId);
  await db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const current = await db.query(`SELECT version FROM income_sources WHERE id = $1 AND household_id = $2`, [sourceId, member.householdId]);
    if (!current.length) throw new ApiError(404, "Not found");
    if (num(current[0].version) !== body.version) throw new ApiError(409, "Someone else changed this income. Reload it and try again.");
    await db.query(
      `UPDATE income_sources SET space_id=$1, name=$2, kind=$3, owner_user_id=$4, account_id=$5, amount_minor=$6, amount_max_minor=$7, cadence=$8, custom_interval=$9, anchor_day=$10, twice_day_a=$11, twice_day_b=$12, start_date=$13, end_date=$14, notes=$15, version=version+1, updated_at=$16 WHERE id=$17`,
      [body.spaceId, body.name, body.kind, body.ownerUserId || null, body.accountId, schedule.amountMinor, schedule.amountMaxMinor ?? null, schedule.cadence, schedule.customInterval ?? null, schedule.anchorDay ?? null, schedule.twiceDays?.[0] ?? null, schedule.twiceDays?.[1] ?? null, schedule.startDate, schedule.endDate ?? null, body.notes ?? null, nowIso(), sourceId],
    );
    await replaceScheduleRows(db, sourceId, schedule);
    await audit(db, member.householdId, me.id, "income.update", `Updated expected income ${body.name}`, "income_source", sourceId);
  });
  void source;
  return { id: sourceId, version: body.version + 1, note: "The schedule was updated. Received paychecks were not rewritten, and no balance changed." };
}

async function setIncomeFlag(db: Database, me: Actor, householdId: string, sourceId: string, action: "pause" | "resume" | "archive" | "restore", version: number, hooks: IncomeHooks) {
  const { member } = await mustSource(db, me, householdId, sourceId, hooks);
  assertBudget(member);
  const paused = action === "pause" ? 1 : action === "resume" ? 0 : null;
  const archived = action === "archive" ? 1 : action === "restore" ? 0 : null;
  await db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const current = await db.query(`SELECT version FROM income_sources WHERE id = $1 AND household_id = $2`, [sourceId, member.householdId]);
    if (!current.length) throw new ApiError(404, "Not found");
    if (num(current[0].version) !== version) throw new ApiError(409, "Someone else changed this income. Reload it and try again.");
    await db.query(
      `UPDATE income_sources SET paused = COALESCE($1, paused), archived = COALESCE($2, archived), version = version + 1, updated_at = $3 WHERE id = $4`,
      [paused, archived, nowIso(), sourceId],
    );
  });
  return { id: sourceId, version: version + 1, action, note: "No transaction was created." };
}

async function readIncomeSource(db: Database, me: Actor, householdId: string, sourceId: string, from: string | undefined, to: string | undefined, hooks: IncomeHooks) {
  const { member, source } = await mustSource(db, me, householdId, sourceId, hooks);
  const bundle = await loadBundle(db, source);
  const start = from && isIsoDate(from) ? from : String(source.start_date);
  const end = to && isIsoDate(to) ? to : addDays(start, 370);
  const shown = showIncomeOccurrences({ sourceId, schedule: bundle.schedule, states: bundle.occurrences.map(stateOf), from: start, until: end, scenario: "expected", asOf: member.timeZone ? (await loadSpace(db, me, householdId, String(source.space_id))).input.asOf : start });
  const candidates = await db.query(
    `SELECT id, date, payee, amount_minor FROM transactions WHERE household_id = $1 AND space_id = $2 AND deleted = 0 AND type = 'income' AND bank_status = 'posted' AND amount_minor > 0 ORDER BY date DESC LIMIT 20`,
    [member.householdId, source.space_id],
  );
  const used = new Set(bundle.occurrences.flatMap((row) => [str(row.transaction_id), str(row.extra_transaction_id)].filter((value): value is string => !!value)));
  return {
    source: mapSource(source, bundle.dates, bundle.exceptions),
    history: bundle.occurrences.map(publicOccurrence),
    upcoming: shown,
    linkCandidates: candidates.filter((row) => !used.has(String(row.id))).map((row) => ({ id: String(row.id), date: String(row.date), payee: String(row.payee), amountMinor: num(row.amount_minor) })),
    explanation: SCHEDULE_EXPLANATION,
  };
}

const receiveSchema = z.object({
  expectedDate: z.string(),
  opId: z.string().min(8).max(80),
  mode: z.enum(["full", "partial", "link"]),
  amountMinor: money.optional(),
  receivedDate: z.string().optional(),
  transactionId: z.string().optional(),
  note: z.string().max(500).optional(),
});

async function receiveIncome(db: Database, me: Actor, householdId: string, sourceId: string, raw: unknown, hooks: IncomeHooks) {
  const body = receiveSchema.parse(raw);
  if (!isIsoDate(body.expectedDate)) throw new ApiError(400, "Expected date must be YYYY-MM-DD.");
  if (body.receivedDate && !isIsoDate(body.receivedDate)) throw new ApiError(400, "Received date must be YYYY-MM-DD.");
  const { member, source } = await mustSource(db, me, householdId, sourceId, hooks);
  assertWrite(member);
  if (num(source.archived) === 1) throw new ApiError(400, "Restore this income source before recording a receipt.");
  return db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const existingOp = await db.query(
      `SELECT * FROM income_occurrences WHERE household_id = $1 AND (client_op_id = $2 OR settle_op_id = $2)`,
      [member.householdId, body.opId],
    );
    if (existingOp.length) return { duplicate: true, transactionId: str(existingOp[0].settle_op_id) === body.opId ? str(existingOp[0].extra_transaction_id) ?? null : str(existingOp[0].transaction_id) ?? null, occurrence: publicOccurrence(existingOp[0]), note: "This receipt was already recorded." };
    const bundle = await loadBundle(db, source);
    const states = bundle.occurrences.map(stateOf);
    const open = showIncomeOccurrences({ sourceId, schedule: bundle.schedule, states, from: "1900-01-01", until: "2999-12-31", scenario: "expected", asOf: "1900-01-01" }).find((item) => item.expectedDate === body.expectedDate);
    if (!open || open.status === "cancelled") throw new ApiError(400, "That date is not an open expected paycheck.");
    if (open.status === "received") throw new ApiError(409, "That expected date was already settled. The earlier receipt was left as it is.");
    const current = bundle.occurrences.find((row) => String(row.expected_date) === body.expectedDate);
    const stillExpected = plannedAmount(bundle.schedule, states, body.expectedDate);
    const receivedDate = body.receivedDate ?? body.expectedDate;
    let transactionId = body.transactionId ?? "";
    let receivedAmount = body.amountMinor ?? stillExpected;
    if (body.mode === "link" || body.transactionId) {
      if (!body.transactionId) throw new ApiError(400, "Choose the income transaction to link.");
      const claimed = await db.query(`INSERT INTO applied_ops (household_id, op_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING op_id`, [member.householdId, body.opId, nowIso()]);
      if (!claimed.length) {
        const replay = await db.query(`SELECT * FROM income_occurrences WHERE household_id = $1 AND (client_op_id = $2 OR settle_op_id = $2)`, [member.householdId, body.opId]);
        if (replay.length) return { duplicate: true, transactionId: str(replay[0].transaction_id) ?? null, occurrence: publicOccurrence(replay[0]), note: "This receipt was already recorded." };
        throw new ApiError(409, "That operation id was already used.");
      }
      const linked = await linkableTransaction(db, me, member.householdId, body.transactionId, String(source.space_id), `${sourceId}:${body.expectedDate}`, hooks);
      transactionId = String(linked.id);
      receivedAmount = num(linked.amount_minor);
    } else {
      if (body.mode === "partial" && (body.amountMinor == null || body.amountMinor <= 0 || body.amountMinor >= stillExpected)) {
        throw new ApiError(400, "A partial receipt has to be more than zero and less than the amount still expected.");
      }
      if (receivedAmount <= 0) throw new ApiError(400, "The received amount has to be more than zero.");
      const created = await hooks.insertIncome(me, member.householdId, {
        accountId: String(source.account_id),
        amountMinor: receivedAmount,
        date: receivedDate,
        payee: String(source.name),
        opId: body.opId,
        spaceId: String(source.space_id),
        notes: body.note ?? "Paycheck receipt",
      });
      if (created.duplicate || !created.id) {
        const replay = await db.query(`SELECT * FROM income_occurrences WHERE household_id = $1 AND (client_op_id = $2 OR settle_op_id = $2)`, [member.householdId, body.opId]);
        if (replay.length) return { duplicate: true, transactionId: str(replay[0].transaction_id) ?? null, occurrence: publicOccurrence(replay[0]), note: "This receipt was already recorded." };
        if (!created.id) throw new ApiError(409, "That operation id was already used.");
      }
      transactionId = created.id!;
    }
    const settlingRemainder = current && String(current.status) === "partial";
    const previousReceived = settlingRemainder ? num(current.received_amount_minor) : 0;
    const totalReceived = previousReceived + receivedAmount;
    const originalExpected = settlingRemainder ? num(current.expected_amount_minor) : stillExpected;
    const settles = body.mode !== "partial";
    const remaining = settles ? 0 : Math.max(0, originalExpected - totalReceived);
    const status = settles || remaining === 0 ? "received" : "partial";
    const occurrenceId = current ? String(current.id) : id();
    const now = nowIso();
    if (!current) {
      await db.query(
        `INSERT INTO income_occurrences (id, household_id, source_id, occurrence_key, expected_date, status, expected_amount_minor, received_date, received_amount_minor, remaining_minor, transaction_id, note, client_op_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [occurrenceId, member.householdId, sourceId, `${sourceId}:${body.expectedDate}`, body.expectedDate, status, originalExpected, receivedDate, totalReceived, remaining, transactionId, body.note ?? null, body.opId, now],
      );
    } else {
      await db.query(
        `UPDATE income_occurrences SET status=$1, received_date=$2, received_amount_minor=$3, remaining_minor=$4, transaction_id=COALESCE(transaction_id, $5), extra_transaction_id=$6, note=COALESCE($7, note), client_op_id=COALESCE(client_op_id, $8), settle_op_id=$9, updated_at=$10 WHERE id=$11`,
        [status, receivedDate, totalReceived, remaining, transactionId, settlingRemainder ? transactionId : null, body.note ?? null, body.opId, settlingRemainder ? body.opId : null, now, occurrenceId],
      );
    }
    await audit(db, member.householdId, me.id, "income.receive", `Recorded ${String(source.name)} as ${status}`, "income_source", sourceId);
    const saved = await db.query(`SELECT * FROM income_occurrences WHERE id = $1`, [occurrenceId]);
    return { duplicate: false, transactionId, occurrence: publicOccurrence(saved[0]), note: "One income transaction was recorded. The fulfilled amount is no longer expected again." };
  });
}

async function linkableTransaction(db: Database, me: Actor, householdId: string, transactionId: string, spaceId: string, occurrenceKey: string, hooks: IncomeHooks) {
  const rows = await db.query(`SELECT * FROM transactions WHERE id = $1 AND household_id = $2 AND deleted = 0`, [transactionId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  const account = await hooks.mustAccount(me.id, householdId, String(rows[0].account_id));
  if (String(rows[0].type) !== "income" || String(rows[0].bank_status) !== "posted" || num(rows[0].amount_minor) <= 0) {
    throw new ApiError(400, "Only a posted income deposit can be linked. Transfers, refunds, openings, and loan proceeds do not count.");
  }
  if (String(account.space_id) !== spaceId) throw new ApiError(400, "That income is in a different space.");
  const used = await db.query(
    `SELECT id FROM income_occurrences WHERE household_id = $1 AND occurrence_key <> $2 AND (transaction_id = $3 OR extra_transaction_id = $3)`,
    [householdId, occurrenceKey, transactionId],
  );
  if (used.length) throw new ApiError(409, "That income is already linked to a paycheck.");
  return rows[0];
}

async function delayIncome(db: Database, me: Actor, householdId: string, sourceId: string, raw: unknown, hooks: IncomeHooks) {
  const body = z.object({ expectedDate: z.string(), delayedUntil: z.string(), note: z.string().max(500).optional() }).parse(raw);
  if (!isIsoDate(body.expectedDate) || !isIsoDate(body.delayedUntil)) throw new ApiError(400, "Dates must be YYYY-MM-DD.");
  const { member, source } = await mustSource(db, me, householdId, sourceId, hooks);
  assertWrite(member);
  const bundle = await loadBundle(db, source);
  const state = bundle.occurrences.find((row) => String(row.expected_date) === body.expectedDate);
  if (state && (String(state.status) === "received" || String(state.status) === "cancelled")) throw new ApiError(409, "That paycheck was already settled and was not moved.");
  const amount = plannedAmount(bundle.schedule, bundle.occurrences.map(stateOf), body.expectedDate);
  await writeOpenOccurrence(db, member.householdId, source, body.expectedDate, state, { status: "delayed", delayedUntil: body.delayedUntil, amount, note: body.note });
  return { ok: true, note: "The paycheck was delayed. No income was posted." };
}

async function cancelIncome(db: Database, me: Actor, householdId: string, sourceId: string, raw: unknown, hooks: IncomeHooks) {
  const body = z.object({ expectedDate: z.string(), note: z.string().max(500).optional() }).parse(raw);
  if (!isIsoDate(body.expectedDate)) throw new ApiError(400, "Expected date must be YYYY-MM-DD.");
  const { member, source } = await mustSource(db, me, householdId, sourceId, hooks);
  assertWrite(member);
  const bundle = await loadBundle(db, source);
  const state = bundle.occurrences.find((row) => String(row.expected_date) === body.expectedDate);
  if (state && String(state.status) === "received") throw new ApiError(409, "That paycheck was already received. The deposit was left in the register.");
  const amount = state ? num(state.expected_amount_minor) : plannedAmount(bundle.schedule, bundle.occurrences.map(stateOf), body.expectedDate);
  await writeOpenOccurrence(db, member.householdId, source, body.expectedDate, state, { status: "cancelled", amount, note: body.note, remaining: 0 });
  return { ok: true, note: state && String(state.status) === "partial" ? "The remainder was cancelled. The deposit already recorded stays in the register." : "The expected paycheck was cancelled. No income was posted." };
}

async function reviseIncome(db: Database, me: Actor, householdId: string, sourceId: string, raw: unknown, hooks: IncomeHooks) {
  const body = z.object({
    expectedDate: z.string(),
    scope: z.enum(["one", "future"]),
    date: z.string().optional(),
    amountMinor: money.optional(),
    version: z.number().int().optional(),
  }).parse(raw);
  if (!isIsoDate(body.expectedDate) || (body.date && !isIsoDate(body.date))) throw new ApiError(400, "Dates must be YYYY-MM-DD.");
  const { member, source } = await mustSource(db, me, householdId, sourceId, hooks);
  assertBudget(member);
  const bundle = await loadBundle(db, source);
  const state = bundle.occurrences.find((row) => String(row.expected_date) === body.expectedDate);
  if (state && (String(state.status) === "received" || String(state.status) === "cancelled")) {
    throw new ApiError(409, "That paycheck was already settled. The receipt was not rewritten.");
  }
  if (body.scope === "one") {
    const amount = body.amountMinor ?? plannedAmount(bundle.schedule, bundle.occurrences.map(stateOf), body.expectedDate);
    await writeOpenOccurrence(db, member.householdId, source, body.expectedDate, state, { status: "expected", amount, revisedDate: body.date ?? null, revisedAmount: body.amountMinor ?? null });
    return { ok: true, note: "That one expected date was changed. Other dates and received paychecks were left as they were." };
  }
  if (body.version == null) throw new ApiError(400, "Reload this income source before changing future dates.");
  if (body.amountMinor == null) throw new ApiError(400, "Enter the amount for the future occurrences.");
  await db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const current = await db.query(`SELECT version, amount_minor FROM income_sources WHERE id = $1 AND household_id = $2`, [sourceId, member.householdId]);
    if (num(current[0].version) !== body.version) throw new ApiError(409, "Someone else changed this income. Reload it and try again.");
    const prior = expandSchedule(bundle.schedule, bundle.schedule.startDate, addDays(body.expectedDate, -1));
    for (const item of prior) {
      const row = bundle.occurrences.find((occurrence) => String(occurrence.expected_date) === item.date);
      if (row && ["received", "partial", "cancelled"].includes(String(row.status))) continue;
      if (row && row.revised_amount_minor != null) continue;
      await writeOpenOccurrence(db, member.householdId, source, item.date, row, { status: row ? String(row.status) : "expected", amount: item.amountMinor, revisedAmount: item.amountMinor, revisedDate: str(row?.revised_date) ?? null, delayedUntil: str(row?.delayed_until) ?? null });
    }
    await db.query(`UPDATE income_sources SET amount_minor = $1, version = version + 1, updated_at = $2 WHERE id = $3`, [body.amountMinor, nowIso(), sourceId]);
    await db.query(
      `UPDATE income_dates SET amount_minor = $1 WHERE source_id = $2 AND expected_date >= $3 AND expected_date NOT IN (SELECT expected_date FROM income_occurrences WHERE source_id = $2 AND status IN ('received','partial','cancelled'))`,
      [body.amountMinor, sourceId, body.expectedDate],
    );
  });
  return { ok: true, version: body.version + 1, note: "Future expected amounts were changed. Received paychecks were not rewritten." };
}

async function writeOpenOccurrence(db: Database, householdId: string, source: Record<string, unknown>, expectedDate: string, current: Record<string, unknown> | undefined, patch: { status: string; amount: number; note?: string; remaining?: number; delayedUntil?: string | null; revisedDate?: string | null; revisedAmount?: number | null }) {
  const now = nowIso();
  if (!current) {
    await db.query(
      `INSERT INTO income_occurrences (id, household_id, source_id, occurrence_key, expected_date, status, expected_amount_minor, revised_date, revised_amount_minor, remaining_minor, delayed_until, note, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [id(), householdId, source.id, `${source.id}:${expectedDate}`, expectedDate, patch.status, patch.amount, patch.revisedDate ?? null, patch.revisedAmount ?? null, patch.remaining ?? null, patch.delayedUntil ?? null, patch.note ?? null, now],
    );
    return;
  }
  await db.query(
    `UPDATE income_occurrences SET status=$1, revised_date=$2, revised_amount_minor=$3, remaining_minor=$4, delayed_until=$5, note=COALESCE($6, note), updated_at=$7 WHERE id=$8`,
    [patch.status, patch.revisedDate === undefined ? current.revised_date ?? null : patch.revisedDate, patch.revisedAmount === undefined ? current.revised_amount_minor ?? null : patch.revisedAmount, patch.remaining === undefined ? current.remaining_minor ?? null : patch.remaining, patch.delayedUntil === undefined ? current.delayed_until ?? null : patch.delayedUntil, patch.note ?? null, now, current.id],
  );
}

export async function calendarView(db: Database, me: Actor, householdId: string, query: { spaceId?: string; asOf?: string; from: string; to: string; scenario?: string }) {
  const loaded = await loadSpace(db, me, householdId, query.spaceId, query.asOf);
  const from = isIsoDate(query.from) ? query.from : loaded.budget.periodStart;
  const to = isIsoDate(query.to) ? query.to : loaded.budget.periodEnd;
  const plan = await paycheckPlan(db, me, householdId, { spaceId: loaded.spaceId, asOf: loaded.input.asOf, scenario: query.scenario, from, to });
  const items: { id: string; kind: string; name: string; date: string; amountMinor: number; status: string; estimate: boolean; sourceId?: string; scheduleId?: string }[] = [];
  for (const item of plan.upcoming) {
    items.push({ id: item.key, kind: "income", name: item.name, date: item.date, amountMinor: item.amountMinor, status: item.status, estimate: item.countsAsExpected, sourceId: item.sourceId });
  }
  for (const schedule of loaded.input.schedules ?? []) {
    if (schedule.type === "fill") continue;
    if (schedule.paused || schedule.archived) {
      if (schedule.nextDate >= from && schedule.nextDate <= to) items.push({ id: schedule.id, kind: schedule.direction === "inflow" ? "income" : schedule.type, name: schedule.name, date: schedule.nextDate, amountMinor: schedule.amountMinor, status: "paused", estimate: false, scheduleId: schedule.id });
      continue;
    }
    for (const date of schedule.exceptionDates ?? []) {
      if (date >= from && date <= to) items.push({ id: `${schedule.id}:${date}`, kind: schedule.type, name: schedule.name, date, amountMinor: schedule.amountMinor, status: "skipped", estimate: false, scheduleId: schedule.id });
    }
    const dates = forecastDatesForSchedule(schedule, from, to);
    for (const date of dates) {
      const paid = loaded.input.transactions.find((txn) => txn.scheduleId === schedule.id && txn.date === date.date && !txn.deleted);
      items.push({
        id: `${schedule.id}:${date.date}`,
        kind: schedule.direction === "inflow" || schedule.type === "income" ? "income" : schedule.type === "transfer" ? "transfer" : schedule.type === "subscription" ? "subscription" : "bill",
        name: schedule.name,
        date: date.date,
        amountMinor: paid ? Math.abs(paid.amountMinor) : date.amountMinor,
        status: paid ? "paid" : date.date < loaded.input.asOf ? "overdue" : "expected",
        estimate: !paid,
        scheduleId: schedule.id,
      });
    }
  }
  const fills = await db.query(`SELECT id, name, next_date, paused FROM fill_templates WHERE space_id = $1 AND archived = 0 AND next_date IS NOT NULL`, [loaded.spaceId]);
  for (const fill of fills) {
    const date = String(fill.next_date);
    if (date < from || date > to) continue;
    items.push({ id: String(fill.id), kind: "fill", name: String(fill.name), date, amountMinor: 0, status: num(fill.paused) === 1 ? "paused" : "expected", estimate: false });
  }
  const days = plan.cashProjection.points.filter((point) => point.date >= from && point.date <= to).map((point) => {
    const expected = plan.expectedProjection.points.find((item) => item.date === point.date);
    return { date: point.date, projectedMinor: point.balanceMinor, withExpectedMinor: expected?.balanceMinor ?? point.balanceMinor };
  });
  return {
    from,
    to,
    asOf: loaded.input.asOf,
    timeZone: loaded.member.timeZone,
    explanation: SCHEDULE_EXPLANATION,
    items: items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name))),
    days,
    actualCashMinor: plan.actual.cashMinor,
    projectedCashMinor: plan.projectedCashMinor,
    projectedWithExpectedMinor: plan.projectedWithExpectedMinor,
    note: "Estimated bill amounts are not posted transactions. A paid bill is not also counted as money still owed. Expected pay is separate from cash on hand. An envelope fill moves budget assignments, not the bank balance. Days before today are not given an invented balance.",
  };
}

function billSchedule(body: z.infer<typeof billSchema>): RepeatingSchedule {
  return normalizedSchedule({
    cadence: body.cadence as RepeatingSchedule["cadence"],
    startDate: body.nextDate,
    endDate: body.endDate ?? null,
    customInterval: body.customInterval ?? null,
    anchorDay: body.anchorDay ?? null,
    twiceDays: body.twiceDays ?? null,
    amountMinor: body.amountMinor,
    amountMaxMinor: body.amountMaxMinor ?? null,
    exceptions: body.exceptions,
  });
}

export async function createBill(db: Database, me: Actor, householdId: string, raw: unknown, hooks: IncomeHooks) {
  const member = await requireMember(db, me.id, householdId);
  assertBudget(member);
  const body = billSchema.parse(raw);
  const schedule = billSchedule(body);
  await hooks.assertSpace(me.id, member.householdId, body.spaceId);
  if (body.accountId) {
    const account = await hooks.mustAccount(me.id, member.householdId, body.accountId);
    if (String(account.space_id) !== body.spaceId) throw new ApiError(400, "That account is in a different space.");
  }
  if (body.bucketId) {
    const bucket = await db.query(`SELECT id FROM buckets WHERE id = $1 AND household_id = $2 AND space_id = $3`, [body.bucketId, member.householdId, body.spaceId]);
    if (!bucket.length) throw new ApiError(404, "Not found");
  }
  const scheduleId = id();
  const nextDate = expandSchedule(schedule, schedule.startDate, schedule.endDate ?? addDays(schedule.startDate, 3700))[0]?.date ?? schedule.startDate;
  await db.tx(async () => {
    await db.query(
      `INSERT INTO schedules (id, household_id, space_id, name, cadence, custom_days, next_date, amount_minor, amount_max_minor, direction, account_id, bucket_id, type, payee, paused, confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1)`,
      [scheduleId, member.householdId, body.spaceId, body.name, schedule.cadence, schedule.customInterval ?? null, nextDate, schedule.amountMinor, schedule.amountMaxMinor ?? null, body.direction, body.accountId ?? null, body.bucketId ?? null, body.type, body.payee ?? body.name, body.paused ? 1 : 0],
    );
    await db.query(
      `INSERT INTO schedule_details (schedule_id, anchor_day, twice_day_a, twice_day_b, custom_weeks, end_date, exceptions_json) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [scheduleId, schedule.anchorDay ?? null, schedule.twiceDays?.[0] ?? null, schedule.twiceDays?.[1] ?? null, schedule.cadence === "every_n_weeks" ? schedule.customInterval ?? null : null, schedule.endDate ?? null, JSON.stringify(schedule.exceptions ?? [])],
    );
  });
  return { id: scheduleId, nextDate, cadence: schedule.cadence, note: "The schedule was saved. It does not post a transaction or change a balance." };
}

async function updateBill(db: Database, me: Actor, householdId: string, scheduleId: string, raw: unknown, hooks: IncomeHooks) {
  const member = await requireMember(db, me.id, householdId);
  assertBudget(member);
  const body = billSchema.parse(raw);
  const rows = await db.query(`SELECT * FROM schedules WHERE id = $1 AND household_id = $2`, [scheduleId, member.householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  await hooks.assertSpace(me.id, member.householdId, String(rows[0].space_id));
  const schedule = billSchedule(body);
  const nextDate = expandSchedule(schedule, schedule.startDate, schedule.endDate ?? addDays(schedule.startDate, 3700))[0]?.date ?? schedule.startDate;
  await db.tx(async () => {
    await db.query(
      `UPDATE schedules SET name=$1, cadence=$2, custom_days=$3, next_date=$4, amount_minor=$5, amount_max_minor=$6, direction=$7, account_id=$8, bucket_id=$9, type=$10, payee=$11, paused=$12 WHERE id=$13`,
      [body.name, schedule.cadence, schedule.customInterval ?? null, nextDate, schedule.amountMinor, schedule.amountMaxMinor ?? null, body.direction, body.accountId ?? null, body.bucketId ?? null, body.type, body.payee ?? body.name, body.paused ? 1 : 0, scheduleId],
    );
    await db.query(
      `INSERT INTO schedule_details (schedule_id, anchor_day, twice_day_a, twice_day_b, custom_weeks, end_date, exceptions_json) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (schedule_id) DO UPDATE SET anchor_day=$2, twice_day_a=$3, twice_day_b=$4, custom_weeks=$5, end_date=$6, exceptions_json=$7`,
      [scheduleId, schedule.anchorDay ?? null, schedule.twiceDays?.[0] ?? null, schedule.twiceDays?.[1] ?? null, schedule.cadence === "every_n_weeks" ? schedule.customInterval ?? null : null, schedule.endDate ?? null, JSON.stringify(schedule.exceptions ?? [])],
    );
  });
  return { id: scheduleId, nextDate, note: "The bill schedule was updated. Posted payments were not changed." };
}

export async function skipBill(db: Database, me: Actor, householdId: string, scheduleId: string) {
  const member = await requireMember(db, me.id, householdId);
  assertWrite(member);
  const rows = await db.query(
    `SELECT s.*, d.anchor_day, d.twice_day_a, d.twice_day_b, d.end_date AS detail_end_date, d.exceptions_json
     FROM schedules s LEFT JOIN schedule_details d ON d.schedule_id = s.id WHERE s.id = $1 AND s.household_id = $2`,
    [scheduleId, member.householdId],
  );
  if (!rows.length) throw new ApiError(404, "Not found");
  const row = rows[0];
  const skipped = JSON.parse(String(row.skipped_dates || "[]")) as string[];
  const extra = JSON.parse(String(row.exceptions_json || "[]")) as string[];
  const schedule = normalizedSchedule({
    cadence: String(row.cadence) as RepeatingSchedule["cadence"],
    startDate: String(row.next_date),
    endDate: str(row.detail_end_date) ?? null,
    customInterval: row.custom_days == null ? null : num(row.custom_days),
    anchorDay: row.anchor_day == null ? null : num(row.anchor_day),
    twiceDays: row.twice_day_a == null ? null : [num(row.twice_day_a), num(row.twice_day_b)],
    amountMinor: num(row.amount_minor),
    exceptions: [...skipped, ...extra, String(row.next_date)],
  });
  let next = nextScheduleDate(String(row.next_date), schedule);
  let guard = 0;
  while (next && schedule.exceptions?.includes(next) && guard < 24) {
    next = nextScheduleDate(next, schedule);
    guard += 1;
  }
  if (!next) throw new ApiError(400, "This schedule has no later date, so it was not moved forward by 30 days.");
  skipped.push(String(row.next_date));
  await db.query(`UPDATE schedules SET skipped_dates = $1, fulfilled_through = $2, next_date = $3 WHERE id = $4`, [JSON.stringify(skipped), row.next_date, next, scheduleId]);
  return { ok: true, nextDate: next };
}

async function reserveBill(db: Database, me: Actor, householdId: string, scheduleId: string, hooks: IncomeHooks) {
  const member = await requireMember(db, me.id, householdId);
  assertBudget(member);
  const rows = await db.query(`SELECT * FROM schedules WHERE id = $1 AND household_id = $2`, [scheduleId, member.householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  if (String(rows[0].direction) !== "outflow") throw new ApiError(400, "Only a bill can be reserved from cash already on hand.");
  if (!rows[0].bucket_id) throw new ApiError(400, "Choose a category to hold this cash.");
  await hooks.assertSpace(me.id, member.householdId, String(rows[0].space_id));
  const details = await db.query(`SELECT reserved FROM schedule_details WHERE schedule_id = $1`, [scheduleId]);
  if (details.length && num(details[0].reserved) === 1) return { reserved: true, duplicate: true, note: "This bill is already reserved." };
  const loaded = await loadSpace(db, me, householdId, String(rows[0].space_id), String(rows[0].next_date));
  if (loaded.budget.readyToAssignMinor < num(rows[0].amount_minor)) throw new ApiError(400, "Ready to Assign does not have enough cash to reserve this bill.");
  const period = loaded.budget.periodKey;
  await db.tx(async () => {
    await lockHousehold(db, member.householdId);
    const again = await db.query(`SELECT reserved FROM schedule_details WHERE schedule_id = $1`, [scheduleId]);
    if (again.length && num(again[0].reserved) === 1) return;
    const current = await db.query(`SELECT amount_minor FROM assignments WHERE space_id = $1 AND bucket_id = $2 AND period_key = $3`, [rows[0].space_id, rows[0].bucket_id, period]);
    await setAssignment(db, member.householdId, String(rows[0].space_id), String(rows[0].bucket_id), period, num(current[0]?.amount_minor) + num(rows[0].amount_minor));
    await db.query(
      `INSERT INTO schedule_details (schedule_id, reserved) VALUES ($1, 1) ON CONFLICT (schedule_id) DO UPDATE SET reserved = 1`,
      [scheduleId],
    );
  });
  return { reserved: true, duplicate: false, note: "Cash already in Ready to Assign was reserved in the category. Expected income was not used." };
}

export async function expectedIncomeEvents(db: Database, me: Actor, householdId: string, spaceId: string | undefined, asOf: string | undefined) {
  const plan = await paycheckPlan(db, me, householdId, { spaceId, asOf });
  return plan.expectedReceipts.filter((item) => item.date >= plan.asOf).map((item) => ({
    id: `${item.sourceId}:${item.expectedDate}`,
    date: item.date,
    amountMinor: item.amountMinor,
    label: item.name,
    kind: "income" as const,
    expectedIncome: true,
  }));
}
