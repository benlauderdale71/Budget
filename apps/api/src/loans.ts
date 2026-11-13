import { Hono } from "hono";
import { z } from "zod";
import {
  amortize,
  buildLoanPayment,
  compareRefinance,
  displayBalance,
  isIsoDate,
  toCsv,
  type AmortizationSummary,
  type LoanEvent,
  type Transaction,
} from "@budgetcents/domain";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, type Actor, assertWrite, audit, loadSpace, lockHousehold, requireMember } from "./finance.js";

const LOAN_KINDS = new Set(["loan", "student_loan", "mortgage", "other_liability", "credit"]);
const CASH_KINDS = new Set(["checking", "savings", "cash"]);
const PLANNING_NOTE = "Saving or calculating a loan plan does not change the loan balance, cash, Ready to Assign, spending, or net worth.";
const MODEL_NOTE = "Interest in this model is the balance times the APR divided by 12, rounded half away from zero to the cent, and charged once a month. This is a monthly approximation, not a lender payoff quote.";

const eventSchema = z.object({
  monthIndex: z.number().int().min(0).max(1199),
  extraOneTimeMinor: z.number().int().nonnegative().optional(),
  aprBps: z.number().int().min(0).max(100_000).optional(),
  paymentMinor: z.number().int().nonnegative().optional(),
  holiday: z.boolean().optional(),
  label: z.string().max(80).optional(),
});

const refinanceSchema = z.object({
  mode: z.enum(["payment", "term"]),
  newAprBps: z.number().int().min(0).max(100_000),
  newPaymentMinor: z.number().int().nonnegative().optional(),
  newTermMonths: z.number().int().min(1).max(1200).optional(),
  upfrontFeeMinor: z.number().int().nonnegative().default(0),
  financedFeeMinor: z.number().int().nonnegative().default(0),
});

const scenarioSchema = z.object({
  accountId: z.string(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["extra", "refinance"]),
  balanceMinor: z.number().int().nonnegative(),
  balanceDate: z.string(),
  aprBps: z.number().int().min(0).max(100_000),
  paymentMinor: z.number().int().nonnegative(),
  extraMinor: z.number().int().nonnegative().default(0),
  startDate: z.string(),
  frequency: z.string().default("monthly"),
  interestMethod: z.string().default("monthly_nominal"),
  events: z.array(eventSchema).max(240).default([]),
  refinance: refinanceSchema.optional(),
  version: z.number().int().positive().optional(),
});

type ScenarioInput = z.infer<typeof scenarioSchema>;

interface LoanHooks {
  actor: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Actor>;
  assertSpace: (userId: string, householdId: string, spaceId: string) => Promise<void>;
  mustAccount: (userId: string, householdId: string, accountId: string) => Promise<Record<string, unknown>>;
  insertPayment: (user: Actor, householdId: string, input: {
    date: string;
    accountId: string;
    amountMinor: number;
    type: "loan_payment";
    payee: string;
    notes: string;
    splits: { bucketId: string | null; amountMinor: number; role: "principal" | "interest" | "fee" }[];
    bankStatus: "posted";
    reviewStatus: "reviewed";
    opId: string;
    spaceId: string;
  }) => Promise<{ id: string | null; duplicate?: boolean }>;
}

interface StoredRefinance {
  mode: "payment" | "term";
  newAprBps: number;
  newPaymentMinor?: number;
  newTermMonths?: number;
  upfrontFeeMinor: number;
  financedFeeMinor: number;
}

export function mountLoans(app: Hono, db: Database, hooks: LoanHooks) {
  app.get("/api/households/:hid/loan-scenarios", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const loaded = await loadSpace(db, me, householdId, c.req.query("spaceId") ?? undefined, c.req.query("asOf") ?? undefined);
    const includeArchived = c.req.query("archived") === "1";
    const visible = await visibleSpaceIds(db, me.id, householdId);
    const loans = loanChoices(loaded, visible);
    const rows = await db.query(
      `SELECT s.*, a.name AS account_name FROM loan_scenarios s JOIN accounts a ON a.id = s.account_id
       WHERE s.household_id = $1 AND ($2::int = 1 OR s.archived = 0) ORDER BY s.updated_at DESC`,
      [householdId, includeArchived ? 1 : 0],
    );
    const scenarios = [];
    for (const row of rows) {
      if (!visible.has(String(row.space_id)) || !loaded.visibleAccountIds.has(String(row.account_id))) continue;
      scenarios.push({
        id: String(row.id),
        name: String(row.name),
        kind: String(row.kind),
        accountId: String(row.account_id),
        accountName: String(row.account_name),
        archived: num(row.archived) === 1,
        version: num(row.version, 1),
        updatedAt: String(row.updated_at),
      });
    }
    return c.json({
      scenarios,
      loans,
      cashAccounts: cashChoices(loaded, visible),
      planningNote: PLANNING_NOTE,
      modelNote: MODEL_NOTE,
      spaceId: loaded.spaceId,
    });
  });

  app.post("/api/households/:hid/loan-scenarios/preview", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const body = await readScenario(c);
    const account = await authorizedLoan(db, hooks, me, householdId, body.accountId);
    const loaded = await loadSpace(db, me, householdId, String(account.space_id));
    return c.json({
      ...projection(body),
      kind: body.kind,
      name: body.name,
      balanceMinor: body.balanceMinor,
      balanceDate: body.balanceDate,
      accountId: String(account.id),
      accountName: String(account.name),
      snapshot: snapshotFor(loaded, String(account.id), body.balanceMinor, body.balanceDate),
      planningNote: PLANNING_NOTE,
      modelNote: MODEL_NOTE,
    });
  });

  app.post("/api/households/:hid/loan-scenarios", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = await readScenario(c);
    const account = await authorizedLoan(db, hooks, me, householdId, body.accountId);
    projection(body);
    const scenarioId = id();
    const stamp = nowIso();
    await db.tx(async () => {
      await insertScenario(db, scenarioId, householdId, account, body, me.id, stamp);
      await replaceEvents(db, scenarioId, body.events);
      await remember(db, householdId, me.id, scenarioId, "create", `Saved ${body.name}`, 1, stamp);
    });
    return c.json(await present(db, hooks, me, householdId, scenarioId), 201);
  });

  app.get("/api/households/:hid/loan-scenarios/:id/export", async (c) => {
    const me = await hooks.actor(c);
    const view = await present(db, hooks, me, c.req.param("hid"), c.req.param("id"));
    const csv = scenarioCsv(view);
    if (c.req.query("format") === "json") return c.json({ filename: `${slug(view.name)}.csv`, csv });
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${slug(view.name)}.csv"`,
      },
    });
  });

  app.get("/api/households/:hid/loan-scenarios/:id", async (c) => {
    const me = await hooks.actor(c);
    return c.json(await present(db, hooks, me, c.req.param("hid"), c.req.param("id")));
  });

  app.patch("/api/households/:hid/loan-scenarios/:id", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = await readScenario(c);
    if (!body.version) throw new ApiError(400, "Send the plan version you are editing.");
    const account = await authorizedLoan(db, hooks, me, householdId, body.accountId);
    const current = await ownedScenario(db, hooks, me, householdId, c.req.param("id"));
    projection(body);
    const stamp = nowIso();
    const updated = await db.tx(async () => {
      const rows = await db.query(
        `UPDATE loan_scenarios SET space_id = $1, account_id = $2, name = $3, kind = $4, balance_minor = $5, balance_date = $6,
         apr_bps = $7, payment_minor = $8, extra_minor = $9, start_date = $10, frequency = $11, interest_method = $12,
         refinance_json = $13, version = version + 1, updated_at = $14
         WHERE id = $15 AND household_id = $16 AND version = $17 RETURNING version`,
        [
          String(account.space_id), String(account.id), body.name, body.kind, body.balanceMinor, body.balanceDate,
          body.aprBps, body.paymentMinor, body.extraMinor, body.startDate, "monthly", "monthly_nominal",
          body.kind === "refinance" ? JSON.stringify(body.refinance) : null, stamp, String(current.id), householdId, body.version,
        ],
      );
      if (!rows.length) throw new ApiError(409, "Someone else changed this loan plan. Reload it and try again.");
      await replaceEvents(db, String(current.id), body.kind === "extra" ? body.events : []);
      await remember(db, householdId, me.id, String(current.id), "update", `Edited ${body.name}`, num(rows[0].version), stamp);
      return num(rows[0].version);
    });
    void updated;
    return c.json(await present(db, hooks, me, householdId, String(current.id)));
  });

  app.post("/api/households/:hid/loan-scenarios/:id/duplicate", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const current = await ownedScenario(db, hooks, me, householdId, c.req.param("id"));
    const events = await eventsOf(db, String(current.id));
    const copyId = id();
    const stamp = nowIso();
    const name = `Copy of ${String(current.name)}`.slice(0, 120);
    await db.tx(async () => {
      await db.query(
        `INSERT INTO loan_scenarios (id, household_id, space_id, account_id, name, kind, balance_minor, balance_date, apr_bps, payment_minor, extra_minor, start_date, frequency, interest_method, refinance_json, archived, version, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,1,$16,$17,$17)`,
        [copyId, householdId, current.space_id, current.account_id, name, current.kind, current.balance_minor, current.balance_date, current.apr_bps, current.payment_minor, current.extra_minor, current.start_date, current.frequency, current.interest_method, current.refinance_json, me.id, stamp],
      );
      await replaceEvents(db, copyId, events);
      await remember(db, householdId, me.id, copyId, "duplicate", `Copied ${String(current.name)}`, 1, stamp);
    });
    return c.json(await present(db, hooks, me, householdId, copyId), 201);
  });

  app.post("/api/households/:hid/loan-scenarios/:id/archive", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = z.object({ version: z.number().int().positive(), archived: z.boolean().default(true) }).parse(await c.req.json());
    const current = await ownedScenario(db, hooks, me, householdId, c.req.param("id"));
    const stamp = nowIso();
    const rows = await db.query(
      `UPDATE loan_scenarios SET archived = $1, version = version + 1, updated_at = $2 WHERE id = $3 AND household_id = $4 AND version = $5 RETURNING version`,
      [body.archived ? 1 : 0, stamp, String(current.id), householdId, body.version],
    );
    if (!rows.length) throw new ApiError(409, "Someone else changed this loan plan. Reload it and try again.");
    await remember(db, householdId, me.id, String(current.id), body.archived ? "archive" : "restore", body.archived ? "Archived the plan" : "Restored the plan", num(rows[0].version), stamp);
    return c.json(await present(db, hooks, me, householdId, String(current.id)));
  });

  app.post("/api/households/:hid/loan-scenarios/:id/refresh", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
    const current = await ownedScenario(db, hooks, me, householdId, c.req.param("id"));
    const loaded = await loadSpace(db, me, householdId, String(current.space_id), c.req.query("asOf") ?? undefined);
    const ledger = ledgerBalance(loaded, String(current.account_id));
    const stamp = nowIso();
    const rows = await db.query(
      `UPDATE loan_scenarios SET balance_minor = $1, balance_date = $2, version = version + 1, updated_at = $3 WHERE id = $4 AND household_id = $5 AND version = $6 RETURNING version`,
      [ledger, loaded.input.asOf, stamp, String(current.id), householdId, body.version],
    );
    if (!rows.length) throw new ApiError(409, "Someone else changed this loan plan. Reload it and try again.");
    await remember(db, householdId, me.id, String(current.id), "refresh", "Copied the ledger balance into the plan", num(rows[0].version), stamp);
    return c.json(await present(db, hooks, me, householdId, String(current.id)));
  });

  app.delete("/api/households/:hid/loan-scenarios/:id", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
    const current = await ownedScenario(db, hooks, me, householdId, c.req.param("id"));
    const rows = await db.query(
      `DELETE FROM loan_scenarios WHERE id = $1 AND household_id = $2 AND version = $3 RETURNING id`,
      [String(current.id), householdId, body.version],
    );
    if (!rows.length) throw new ApiError(409, "Someone else changed this loan plan. Reload it and try again.");
    await remember(db, householdId, me.id, String(current.id), "delete", `Deleted ${String(current.name)}`, body.version, nowIso());
    await audit(db, householdId, me.id, "loan_scenario.delete", `Deleted ${String(current.name)}`, "loan_scenario", String(current.id));
    return c.json({ deleted: true });
  });

  app.post("/api/households/:hid/loan-scenarios/:id/record-payment", async (c) => {
    const me = await hooks.actor(c);
    const householdId = c.req.param("hid");
    const member = await requireMember(db, me.id, householdId);
    assertWrite(member);
    const body = z.object({
      cashAccountId: z.string(),
      date: z.string(),
      principalMinor: z.number().int().nonnegative(),
      interestMinor: z.number().int().nonnegative().default(0),
      feeMinor: z.number().int().nonnegative().default(0),
      bucketId: z.string().nullable().optional(),
      opId: z.string().min(8).max(80).optional(),
    }).parse(await c.req.json());
    if (!isIsoDate(body.date)) throw new ApiError(400, "The payment date must be YYYY-MM-DD.");
    const current = await ownedScenario(db, hooks, me, householdId, c.req.param("id"));
    const loan = await authorizedLoan(db, hooks, me, householdId, String(current.account_id));
    const cash = await hooks.mustAccount(me.id, householdId, body.cashAccountId);
    if (!CASH_KINDS.has(String(cash.kind)) || num(cash.on_budget) !== 1 || num(cash.archived) === 1) {
      throw new ApiError(400, "Choose an on-budget checking, savings, or cash account. The plan itself does not move money.");
    }
    await hooks.assertSpace(me.id, householdId, String(cash.space_id));
    if (String(cash.id) === String(loan.id)) throw new ApiError(400, "The payment has to come from a cash account, not the loan.");
    if (body.bucketId) {
      const buckets = await db.query(`SELECT space_id FROM buckets WHERE id = $1 AND household_id = $2`, [body.bucketId, householdId]);
      if (!buckets.length) throw new ApiError(404, "Not found");
      await hooks.assertSpace(me.id, householdId, String(buckets[0].space_id));
    }
    const draft = buildLoanPayment({
      cashAccountId: String(cash.id),
      loanAccountId: String(loan.id),
      principalMinor: body.principalMinor,
      interestMinor: body.interestMinor,
      feeMinor: body.feeMinor,
      bucketId: body.bucketId ?? null,
    });
    const opId = body.opId ?? id();
    const posted = await db.tx(async () => {
      await lockHousehold(db, householdId);
      const cashTxn = await hooks.insertPayment(me, householdId, {
        date: body.date,
        accountId: draft.cash.accountId,
        amountMinor: draft.cash.amountMinor,
        type: "loan_payment",
        payee: draft.cash.payee,
        notes: draft.cash.notes,
        splits: draft.cash.splits.map((split) => ({ bucketId: split.bucketId, amountMinor: split.amountMinor, role: split.role as "principal" | "interest" | "fee" })),
        bankStatus: "posted",
        reviewStatus: "reviewed",
        opId,
        spaceId: String(cash.space_id),
      });
      if (cashTxn.duplicate) return { duplicate: true as const, transactionId: cashTxn.id, principalTransactionId: null as string | null };
      let principalId: string | null = null;
      if (draft.reduction) {
        const reduction = await hooks.insertPayment(me, householdId, {
          date: body.date,
          accountId: draft.reduction.accountId,
          amountMinor: draft.reduction.amountMinor,
          type: "loan_payment",
          payee: draft.reduction.payee,
          notes: draft.reduction.notes,
          splits: draft.reduction.splits.map((split) => ({ bucketId: split.bucketId, amountMinor: split.amountMinor, role: "principal" as const })),
          bankStatus: "posted",
          reviewStatus: "reviewed",
          opId: `${opId}:principal`,
          spaceId: String(loan.space_id),
        });
        principalId = reduction.id;
      }
      await remember(db, householdId, me.id, String(current.id), "record_payment", "Recorded a real loan payment. The plan was not applied by itself.", num(current.version, 1), nowIso());
      return { duplicate: false as const, transactionId: cashTxn.id, principalTransactionId: principalId };
    });
    return c.json({
      ...posted,
      note: "This posted a real payment. The saved plan was not turned into a refinance or a new loan.",
    });
  });
}

async function readScenario(c: { req: { json: () => Promise<unknown> } }): Promise<ScenarioInput> {
  const body = scenarioSchema.parse(await c.req.json());
  if (!isIsoDate(body.balanceDate) || !isIsoDate(body.startDate)) throw new ApiError(400, "Dates must be YYYY-MM-DD.");
  if (body.frequency !== "monthly") {
    throw new ApiError(400, "This model only supports a monthly payment. Other frequencies are not converted into a monthly amount.");
  }
  if (body.interestMethod !== "monthly_nominal") {
    throw new ApiError(400, "This model charges interest once a month from the APR divided by 12. Other interest methods are not available.");
  }
  if (body.kind === "refinance" && !body.refinance) throw new ApiError(400, "A refinance comparison needs a proposed rate and either a payment or a term.");
  if (body.kind === "extra" && body.refinance) throw new ApiError(400, "An extra-payment plan does not include refinance terms.");
  if (body.kind === "refinance" && body.events.length) {
    throw new ApiError(400, "Put rate and payment changes on an extra-payment plan. A refinance comparison uses the proposed loan instead.");
  }
  if (body.refinance?.mode === "payment" && body.refinance.newPaymentMinor == null) throw new ApiError(400, "Enter the proposed payment.");
  if (body.refinance?.mode === "term" && body.refinance.newTermMonths == null) throw new ApiError(400, "Enter the proposed term in months.");
  if (body.refinance?.mode === "payment") body.refinance.newTermMonths = undefined;
  if (body.refinance?.mode === "term") body.refinance.newPaymentMinor = undefined;
  return body;
}

async function authorizedLoan(db: Database, hooks: LoanHooks, me: Actor, householdId: string, accountId: string) {
  await requireMember(db, me.id, householdId);
  const account = await hooks.mustAccount(me.id, householdId, accountId);
  await hooks.assertSpace(me.id, householdId, String(account.space_id));
  if (!LOAN_KINDS.has(String(account.kind))) throw new ApiError(400, "Choose a loan, mortgage, or other debt account.");
  if (num(account.archived) === 1) throw new ApiError(400, "That loan is archived.");
  return account;
}

async function ownedScenario(db: Database, hooks: LoanHooks, me: Actor, householdId: string, scenarioId: string) {
  await requireMember(db, me.id, householdId);
  const rows = await db.query(`SELECT * FROM loan_scenarios WHERE id = $1 AND household_id = $2`, [scenarioId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  await hooks.mustAccount(me.id, householdId, String(rows[0].account_id));
  await hooks.assertSpace(me.id, householdId, String(rows[0].space_id));
  return rows[0];
}

async function present(db: Database, hooks: LoanHooks, me: Actor, householdId: string, scenarioId: string) {
  const row = await ownedScenario(db, hooks, me, householdId, scenarioId);
  const events = await eventsOf(db, scenarioId);
  const refinance = parseRefinance(row.refinance_json);
  const body: ScenarioInput = {
    accountId: String(row.account_id),
    name: String(row.name),
    kind: String(row.kind) as "extra" | "refinance",
    balanceMinor: num(row.balance_minor),
    balanceDate: String(row.balance_date),
    aprBps: num(row.apr_bps),
    paymentMinor: num(row.payment_minor),
    extraMinor: num(row.extra_minor),
    startDate: String(row.start_date),
    frequency: String(row.frequency),
    interestMethod: String(row.interest_method),
    events,
    refinance,
  };
  const loaded = await loadSpace(db, me, householdId, String(row.space_id));
  const account = loaded.accounts.find((item) => item.id === String(row.account_id));
  const history = await db.query(
    `SELECT action, detail, version, created_at FROM loan_scenario_audit WHERE scenario_id = $1 AND household_id = $2 ORDER BY created_at`,
    [scenarioId, householdId],
  );
  return {
    id: scenarioId,
    version: num(row.version, 1),
    archived: num(row.archived) === 1,
    spaceId: String(row.space_id),
    accountName: account?.name ?? "Loan",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...body,
    ...projection(body),
    snapshot: snapshotFor(loaded, String(row.account_id), body.balanceMinor, body.balanceDate),
    audit: history.map((item) => ({ action: String(item.action), detail: String(item.detail ?? ""), version: num(item.version), createdAt: String(item.created_at) })),
    planningNote: PLANNING_NOTE,
    modelNote: MODEL_NOTE,
  };
}

function projection(body: ScenarioInput) {
  const debt = { id: body.accountId, name: body.name, balanceMinor: body.balanceMinor, aprBps: body.aprBps, minPaymentMinor: body.paymentMinor };
  if (body.kind === "refinance" && body.refinance) {
    const refinance = compareRefinance({
      balanceMinor: body.balanceMinor,
      aprBps: body.aprBps,
      paymentMinor: body.paymentMinor,
      newAprBps: body.refinance.newAprBps,
      newPaymentMinor: body.refinance.mode === "payment" ? body.refinance.newPaymentMinor : undefined,
      newTermMonths: body.refinance.mode === "term" ? body.refinance.newTermMonths : undefined,
      upfrontFeeMinor: body.refinance.upfrontFeeMinor,
      financedFeeMinor: body.refinance.financedFeeMinor,
      startDate: body.startDate,
    });
    return { baseline: refinance.current, scenario: refinance.proposed, refinanceResult: refinance, comparison: null };
  }
  const baseline = amortize(debt, body.startDate);
  const scenario = amortize({ ...debt, extraMinor: body.extraMinor }, body.startDate, body.events);
  return { baseline, scenario, refinanceResult: null, comparison: extraComparison(baseline, scenario) };
}

function extraComparison(baseline: AmortizationSummary, scenario: AmortizationSummary) {
  const incomplete = !baseline.paidOff || !scenario.paidOff;
  return {
    incomplete,
    baselinePayoffDate: baseline.payoffDate,
    payoffDate: scenario.payoffDate,
    baselineMonths: baseline.payoffMonths,
    months: scenario.payoffMonths,
    interestSavedMinor: incomplete ? null : baseline.totalInterestMinor - scenario.totalInterestMinor,
    monthsSaved: incomplete || baseline.payoffMonths == null || scenario.payoffMonths == null ? null : baseline.payoffMonths - scenario.payoffMonths,
    baselineTotalPaidMinor: incomplete ? null : baseline.totalPaidMinor,
    totalPaidMinor: incomplete ? null : scenario.totalPaidMinor,
    note: incomplete
      ? "One projection does not pay the loan off within 100 years. Those totals are not a finished payoff and are not compared as lifetime savings."
      : "Interest and time saved compare the baseline payment with this plan. This is not a lender quote.",
  };
}

function snapshotFor(loaded: Awaited<ReturnType<typeof loadSpace>>, accountId: string, balanceMinor: number, balanceDate: string) {
  const ledgerBalanceMinor = ledgerBalance(loaded, accountId);
  const moved = loaded.balanceTransactions.some((txn) => touches(txn, accountId) && txn.date > balanceDate && txn.date <= loaded.input.asOf);
  const stale = ledgerBalanceMinor !== balanceMinor || moved;
  return {
    stale,
    ledgerBalanceMinor,
    ledgerAsOf: loaded.input.asOf,
    note: stale
      ? "The saved balance is older than the ledger or does not match it. This plan was not changed. Use the ledger balance to copy the current loan into the plan."
      : "This snapshot matches the loan balance on the ledger.",
  };
}

function ledgerBalance(loaded: Awaited<ReturnType<typeof loadSpace>>, accountId: string): number {
  const account = loaded.input.accounts.find((item) => item.id === accountId);
  if (!account) throw new ApiError(404, "Not found");
  return displayBalance(account, loaded.balanceTransactions, loaded.input.asOf);
}

function touches(txn: Transaction, accountId: string): boolean {
  return !txn.deleted && txn.bankStatus !== "pending" && (txn.accountId === accountId || txn.counterAccountId === accountId);
}

function loanChoices(loaded: Awaited<ReturnType<typeof loadSpace>>, visible: Set<string>) {
  return loaded.accounts
    .filter((account) => visible.has(account.space_id) && LOAN_KINDS.has(account.kind) && num(account.archived) === 0)
    .map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      spaceId: account.space_id,
      balanceMinor: ledgerBalance(loaded, account.id),
      aprBps: account.apr_bps == null ? 0 : num(account.apr_bps),
      paymentMinor: account.minimum_payment_minor == null ? 0 : num(account.minimum_payment_minor),
      balanceDate: loaded.input.asOf,
    }));
}

function cashChoices(loaded: Awaited<ReturnType<typeof loadSpace>>, visible: Set<string>) {
  return loaded.accounts
    .filter((account) => visible.has(account.space_id) && CASH_KINDS.has(account.kind) && num(account.on_budget) === 1 && num(account.archived) === 0)
    .map((account) => ({ id: account.id, name: account.name }));
}

async function visibleSpaceIds(db: Database, userId: string, householdId: string): Promise<Set<string>> {
  const spaces = await db.query<{ id: string; kind: string; owner_user_id: string | null }>(
    `SELECT id, kind, owner_user_id FROM spaces WHERE household_id = $1`,
    [householdId],
  );
  return new Set(spaces.filter((space) => space.kind !== "personal" || space.owner_user_id === userId || space.owner_user_id == null).map((space) => space.id));
}

async function insertScenario(db: Database, scenarioId: string, householdId: string, account: Record<string, unknown>, body: ScenarioInput, userId: string, stamp: string) {
  await db.query(
    `INSERT INTO loan_scenarios (id, household_id, space_id, account_id, name, kind, balance_minor, balance_date, apr_bps, payment_minor, extra_minor, start_date, frequency, interest_method, refinance_json, archived, version, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'monthly','monthly_nominal',$13,0,1,$14,$15,$15)`,
    [
      scenarioId, householdId, String(account.space_id), String(account.id), body.name, body.kind, body.balanceMinor, body.balanceDate,
      body.aprBps, body.paymentMinor, body.extraMinor, body.startDate, body.kind === "refinance" ? JSON.stringify(body.refinance) : null, userId, stamp,
    ],
  );
}

async function replaceEvents(db: Database, scenarioId: string, events: LoanEvent[]) {
  await db.query(`DELETE FROM loan_scenario_events WHERE scenario_id = $1`, [scenarioId]);
  for (const event of events) {
    await db.query(
      `INSERT INTO loan_scenario_events (id, scenario_id, month_index, extra_one_time_minor, apr_bps, payment_minor, holiday, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id(), scenarioId, event.monthIndex, event.extraOneTimeMinor ?? null, event.aprBps ?? null, event.paymentMinor ?? null, event.holiday ? 1 : 0, null],
    );
  }
}

async function eventsOf(db: Database, scenarioId: string): Promise<ScenarioInput["events"]> {
  const rows = await db.query(`SELECT * FROM loan_scenario_events WHERE scenario_id = $1 ORDER BY month_index`, [scenarioId]);
  return rows.map((row) => ({
    monthIndex: num(row.month_index),
    extraOneTimeMinor: row.extra_one_time_minor == null ? undefined : num(row.extra_one_time_minor),
    aprBps: row.apr_bps == null ? undefined : num(row.apr_bps),
    paymentMinor: row.payment_minor == null ? undefined : num(row.payment_minor),
    holiday: num(row.holiday) === 1 ? true : undefined,
    label: str(row.label),
  }));
}

function parseRefinance(value: unknown): StoredRefinance | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return JSON.parse(value) as StoredRefinance;
}

async function remember(db: Database, householdId: string, userId: string, scenarioId: string, action: string, detail: string, version: number, stamp: string) {
  await db.query(
    `INSERT INTO loan_scenario_audit (id, scenario_id, household_id, actor_id, action, detail, version, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id(), scenarioId, householdId, userId, action, detail, version, stamp],
  );
  await audit(db, householdId, userId, `loan_scenario.${action}`, detail, "loan_scenario", scenarioId);
}

function scenarioCsv(view: Awaited<ReturnType<typeof present>>): string {
  const rows: Record<string, string | number>[] = [
    { side: "note", date: "", paymentMinor: "", interestMinor: "", principalMinor: "", extraMinor: "", balanceMinor: "", label: view.modelNote },
    { side: "note", date: "", paymentMinor: "", interestMinor: "", principalMinor: "", extraMinor: "", balanceMinor: "", label: view.planningNote },
  ];
  const pushSchedule = (side: string, schedule: AmortizationSummary | null) => {
    if (!schedule) return;
    rows.push({
      side,
      date: schedule.payoffDate ?? "",
      paymentMinor: "",
      interestMinor: schedule.paidOff ? schedule.totalInterestMinor : "",
      principalMinor: "",
      extraMinor: "",
      balanceMinor: "",
      label: schedule.paidOff ? "finished payoff" : "not a finished payoff",
    });
    for (const month of schedule.months) {
      rows.push({
        side,
        date: month.date,
        paymentMinor: month.paymentMinor,
        interestMinor: month.interestMinor,
        principalMinor: month.principalMinor,
        extraMinor: month.extraMinor,
        balanceMinor: month.balanceMinor,
        label: month.holiday ? "holiday" : "",
      });
    }
  };
  pushSchedule("baseline", view.baseline);
  pushSchedule(view.kind === "refinance" ? "proposed" : "plan", view.scenario);
  if (!rows.length) return "";
  return toCsv(rows);
}

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "loan-plan";
}
