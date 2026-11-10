import {
  ageOfMoney,
  applyRules,
  type Account,
  type Assignment,
  type Bucket,
  type BudgetResult,
  computeBudget,
  emergencyGap,
  evaluateIncomePlan,
  evaluateWatchlist,
  explainReadyToAssign,
  financialRoadmap,
  neededForTarget,
  netWorth,
  payoffPlan,
  planPaychecks,
  previewAutoAssign,
  projectCash,
  spendingRows,
  spendGuidance,
  type Transaction,
  uncoveredOutflows,
  validateTransaction,
} from "@budgetcents/domain";
import { id, localDate, nowIso } from "./crypto.js";
import { type Database, num, str } from "./db.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  privacyMode: boolean;
  aiEnabled: boolean;
  locale: string;
  timeZone: string;
  theme: string;
  weekStart: number;
}

export interface Member {
  householdId: string;
  role: string;
  name: string;
  currency: string;
  isDemo: boolean;
  labelMode: string;
  budgetApproach: string;
  timeZone: string;
  kind: string;
}

const WRITE_ROLES = new Set(["owner", "admin", "editor", "contributor"]);
const ADMIN_ROLES = new Set(["owner", "admin"]);

export function canWrite(role: string): boolean {
  return WRITE_ROLES.has(role);
}

export async function requireMember(db: Database, actorId: string, householdId: string): Promise<Member> {
  const rows = await db.query(
    `SELECT m.role, h.name, h.currency, h.is_demo, h.label_mode, h.budget_approach, h.time_zone, h.kind
     FROM memberships m JOIN households h ON h.id = m.household_id
     WHERE m.user_id = $1 AND m.household_id = $2`,
    [actorId, householdId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "Not found");
  return {
    householdId,
    role: String(row.role),
    name: String(row.name),
    currency: String(row.currency),
    isDemo: num(row.is_demo) === 1,
    labelMode: String(row.label_mode),
    budgetApproach: String(row.budget_approach),
    timeZone: String(row.time_zone),
    kind: String(row.kind),
  };
}

export async function audit(db: Database, householdId: string | null, userId: string | null, action: string, summary: string, entity?: string, entityId?: string) {
  await db.query(
    `INSERT INTO audit_events (id, household_id, user_id, action, entity, entity_id, summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id(), householdId, userId, action, entity ?? null, entityId ?? null, summary, nowIso()],
  );
}

interface AccountRow {
  id: string;
  space_id: string;
  name: string;
  kind: string;
  currency: string;
  on_budget: number;
  visibility: string;
  owner_user_id: string | null;
  hidden: number;
  archived: number;
  exclude_from_net_worth: number;
  institution: string | null;
  mask: string | null;
  credit_limit_minor: number | null;
  apr_bps: number | null;
  minimum_payment_minor: number | null;
  linked_account_id: string | null;
}

export function canSeeAccount(actorId: string, account: { visibility: string; owner_user_id: string | null }): boolean {
  if (account.visibility !== "private") return true;
  return account.owner_user_id === actorId;
}

export interface Loaded {
  member: Member;
  spaceId: string;
  input: import("@budgetcents/domain").EngineInput;
  budget: BudgetResult;
  accounts: AccountRow[];
  visibleAccountIds: Set<string>;
  /** Every visible transaction, including other spaces, so net worth is not limited to the open plan. */
  balanceTransactions: Transaction[];
}

export async function loadSpace(db: Database, actor: Actor, householdId: string, spaceId?: string, asOf?: string, viewPeriod?: string): Promise<Loaded> {
  const member = await requireMember(db, actor.id, householdId);
  const spaces = await db.query<{ id: string; kind: string; owner_user_id: string | null }>(
    `SELECT id, kind, owner_user_id FROM spaces WHERE household_id = $1`,
    [householdId],
  );
  const visibleSpaces = spaces.filter((space) => space.kind !== "personal" || space.owner_user_id === actor.id || space.owner_user_id == null);
  const space = spaceId ? visibleSpaces.find((item) => item.id === spaceId) : visibleSpaces.find((item) => item.kind === "household") ?? visibleSpaces[0];
  if (!space) throw new ApiError(404, "Not found");
  await ensureBorrowedBucket(db, householdId, space.id);
  const accounts = await db.query<AccountRow>(`SELECT * FROM accounts WHERE household_id = $1`, [householdId]);
  const visibleAccounts = accounts.filter((account) => canSeeAccount(actor.id, account));
  const visibleIds = new Set(visibleAccounts.map((account) => account.id));
  const spaceIds = new Set(visibleAccounts.filter((account) => account.space_id === space.id).map((account) => account.id));
  for (const account of accounts) {
    if (account.space_id === space.id && account.kind === "credit" && num(account.on_budget) === 1 && canSeeAccount(actor.id, account)) {
      await ensureCardReserve(db, householdId, space.id, account.id, account.name);
    }
  }
  const bucketRows = await db.query(`SELECT * FROM buckets WHERE space_id = $1`, [space.id]);
  const txnRows = await db.query(`SELECT * FROM transactions WHERE household_id = $1 AND deleted = 0`, [householdId]);
  const txnIds = txnRows.map((txn) => String(txn.id));
  const splitRows = await idsQuery(db, "splits", "transaction_id", txnIds);
  const tagRows = await idsQuery(db, "transaction_tags", "transaction_id", txnIds);
  const assignmentRows = await db.query(`SELECT * FROM assignments WHERE space_id = $1`, [space.id]);
  const scheduleRows = await db.query(`SELECT * FROM schedules WHERE space_id = $1`, [space.id]);
  const planRows = await db.query(`SELECT * FROM plan_lines WHERE space_id = $1`, [space.id]);

  const splitsByTxn = new Map<string, import("@budgetcents/domain").Split[]>();
  for (const split of splitRows) {
    const list = splitsByTxn.get(String(split.transaction_id)) ?? [];
    list.push({
      bucketId: str(split.bucket_id) ?? null,
      amountMinor: num(split.amount_minor),
      role: String(split.role) as import("@budgetcents/domain").Split["role"],
      memo: str(split.memo),
      ownerUserId: str(split.owner_user_id),
      businessSpaceId: str(split.business_space_id),
      project: str(split.project),
      taxCode: str(split.tax_code),
    });
    splitsByTxn.set(String(split.transaction_id), list);
  }
  const tagsByTxn = new Map<string, string[]>();
  for (const tag of tagRows) {
    const list = tagsByTxn.get(String(tag.transaction_id)) ?? [];
    list.push(String(tag.tag));
    tagsByTxn.set(String(tag.transaction_id), list);
  }

  const stubs = new Map<string, Account>();
  const engineAccounts: Account[] = visibleAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    kind: account.kind as Account["kind"],
    currency: account.currency,
    onBudget: account.space_id === space.id && num(account.on_budget) === 1 && num(account.archived) === 0,
    hidden: num(account.hidden) === 1,
    archived: num(account.archived) === 1,
    excludeFromNetWorth: num(account.exclude_from_net_worth) === 1,
    institution: str(account.institution),
    mask: str(account.mask),
    ownerUserId: str(account.owner_user_id) ?? undefined,
    spaceId: account.space_id,
    creditLimitMinor: account.credit_limit_minor == null ? undefined : num(account.credit_limit_minor),
    aprBps: account.apr_bps == null ? undefined : num(account.apr_bps),
    minimumPaymentMinor: account.minimum_payment_minor == null ? undefined : num(account.minimum_payment_minor),
    linkedAccountId: str(account.linked_account_id),
  }));

  const transactions: Transaction[] = [];
  const balanceTransactions: Transaction[] = [];
  for (const row of txnRows) {
    const primaryVisible = visibleIds.has(String(row.account_id));
    const counterId = str(row.counter_account_id);
    const counterVisible = !counterId || visibleIds.has(counterId);
    const touches =
      (primaryVisible && spaceIds.has(String(row.account_id))) || (!!counterId && counterVisible && spaceIds.has(counterId));
    if (!primaryVisible && !(counterId && counterVisible)) continue;
    let accountId = String(row.account_id);
    let counterAccountId = counterId;
    if (!primaryVisible) {
      accountId = `redacted:${row.account_id}`;
      stubs.set(accountId, stubAccount(accountId, String(row.currency)));
    }
    if (counterAccountId && !counterVisible) {
      const redacted = `redacted:${counterAccountId}`;
      stubs.set(redacted, stubAccount(redacted, String(row.currency)));
      counterAccountId = redacted;
    }
    const fx = str(row.fx_json);
    transactions.push({
      id: String(row.id),
      date: String(row.date),
      accountId,
      counterAccountId,
      amountMinor: num(row.amount_minor),
      currency: String(row.currency),
      type: String(row.type) as Transaction["type"],
      payee: primaryVisible ? String(row.payee) : "Private transfer",
      originalDescription: str(row.original_description),
      splits: splitsByTxn.get(String(row.id)) ?? [],
      bankStatus: String(row.bank_status) as Transaction["bankStatus"],
      reviewStatus: String(row.review_status) as Transaction["reviewStatus"],
      cleared: num(row.cleared) === 1,
      reconciled: num(row.reconciled) === 1,
      locked: num(row.locked) === 1,
      categoryLockedByUser: num(row.category_locked) === 1,
      tags: tagsByTxn.get(String(row.id)) ?? [],
      flag: str(row.flag),
      notes: str(row.notes),
      checkNumber: str(row.check_number),
      ownerUserId: str(row.owner_user_id),
      businessSpaceId: str(row.business_space_id),
      project: str(row.project),
      taxCode: str(row.tax_code),
      scheduleId: str(row.schedule_id),
      refundOfId: str(row.refund_of_id),
      importBatchId: str(row.import_batch_id),
      providerTransactionId: str(row.provider_transaction_id),
      clientOpId: str(row.client_op_id),
      fx: fx ? JSON.parse(fx) : undefined,
      deleted: false,
      excludeFromReports: num(row.exclude_from_reports) === 1,
    });
    const mapped = transactions[transactions.length - 1];
    if ((primaryVisible || (counterId && counterVisible)) && mapped) balanceTransactions.push(mapped);
    if (!touches) transactions.pop();
  }

  const buckets: Bucket[] = bucketRows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    group: String(row.group_name),
    kind: String(row.kind) as Bucket["kind"],
    flexRole: String(row.flex_role) as Bucket["flexRole"],
    envelopeStyle: String(row.envelope_style) as Bucket["envelopeStyle"],
    rollover: String(row.rollover) as Bucket["rollover"],
    rolloverCapMinor: row.rollover_cap_minor == null ? undefined : num(row.rollover_cap_minor),
    icon: str(row.icon),
    archived: num(row.archived) === 1,
    hidden: num(row.hidden) === 1,
    displayOrder: num(row.display_order),
    target: str(row.target_json) ? JSON.parse(String(row.target_json)) : undefined,
    systemRole: (str(row.system_role) as Bucket["systemRole"]) ?? null,
    linkedAccountId: str(row.linked_account_id),
    purpose: str(row.purpose) as Bucket["purpose"],
    dueDay: row.due_day == null ? undefined : num(row.due_day),
  }));
  const assignments: Assignment[] = assignmentRows.map((row) => ({
    id: String(row.id),
    bucketId: String(row.bucket_id),
    periodKey: String(row.period_key),
    amountMinor: num(row.amount_minor),
  }));
  const today = asOf ?? localDate(member.timeZone);
  const input = {
    currency: member.currency,
    asOf: today,
    viewPeriod,
    accounts: [...engineAccounts, ...stubs.values()],
    buckets,
    transactions,
    assignments,
    schedules: scheduleRows.map(mapSchedule),
    planLines: planRows.map((row) => ({
      id: String(row.id),
      bucketId: String(row.bucket_id),
      periodKey: String(row.period_key),
      plannedMinor: num(row.planned_minor),
    })),
    includePending: false,
  };
  for (const txn of transactions) {
    if (txn.currency !== member.currency) continue;
    validateTransaction(txn, input.accounts, member.currency);
  }
  const budget = computeBudget(input);
  return { member, spaceId: space.id, input, budget, accounts: visibleAccounts, visibleAccountIds: visibleIds, balanceTransactions };
}

async function idsQuery(db: Database, table: "splits" | "transaction_tags", column: "transaction_id", ids: string[]) {
  if (!ids.length) return [];
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
  return db.query(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`, ids);
}

function stubAccount(accountId: string, currency: string): Account {
  return { id: accountId, name: "Private account", kind: "checking", currency, onBudget: false, excludeFromNetWorth: true };
}

function mapSchedule(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    cadence: String(row.cadence) as import("@budgetcents/domain").Schedule["cadence"],
    customDays: row.custom_days == null ? undefined : num(row.custom_days),
    nextDate: String(row.next_date),
    amountMinor: num(row.amount_minor),
    amountMaxMinor: row.amount_max_minor == null ? undefined : num(row.amount_max_minor),
    direction: String(row.direction) as "inflow" | "outflow",
    accountId: str(row.account_id),
    bucketId: str(row.bucket_id),
    type: String(row.type) as import("@budgetcents/domain").Schedule["type"],
    payee: str(row.payee),
    ownerUserId: str(row.owner_user_id),
    paused: num(row.paused) === 1,
    trialEnds: str(row.trial_ends),
    renewalDate: str(row.renewal_date),
    reminderDays: row.reminder_days == null ? undefined : num(row.reminder_days),
    fulfilledThrough: str(row.fulfilled_through),
    confirmed: num(row.confirmed) === 1,
    detected: num(row.detected) === 1,
  };
}

export function guidanceFor(loaded: Loaded, horizonDays = 30) {
  const events = forecastEventsFromSchedules(loaded.input.schedules ?? [], loaded.input.asOf, horizonDays, loaded.input.transactions);
  const bills = events.filter((event) => event.amountMinor < 0).map((event) => ({
    bucketId: event.bucketId ?? null,
    amountMinor: -event.amountMinor,
  }));
  const uncovered = uncoveredOutflows(bills, loaded.budget, loaded.input.buckets);
  const expectedIncome = events.filter((event) => event.expectedIncome).reduce((sum, event) => sum + event.amountMinor, 0);
  const end = loaded.budget.periodEnd;
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(loaded.input.asOf)) / 86_400_000) + 1);
  return {
    guidance: spendGuidance({
      result: loaded.budget,
      buckets: loaded.input.buckets,
      uncoveredBillsMinor: uncovered,
      expectedIncomeMinor: expectedIncome,
      daysRemaining: days,
    }),
    events,
    age: ageOfMoney(loaded.input),
    explain: explainReadyToAssign(loaded.budget),
  };
}

export async function ensureBorrowedBucket(db: Database, householdId: string, spaceId: string) {
  const existing = await db.query(`SELECT id FROM buckets WHERE space_id = $1 AND system_role = 'borrowed_funds'`, [spaceId]);
  if (existing.length) return String(existing[0].id);
  const bucketId = id();
  await db.query(
    `INSERT INTO buckets (id, household_id, space_id, name, group_name, kind, flex_role, envelope_style, rollover, system_role, display_order, created_at)
     VALUES ($1,$2,$3,'Borrowed funds','System','expense','reserve','none','both','borrowed_funds',999,$4)`,
    [bucketId, householdId, spaceId, nowIso()],
  );
  return bucketId;
}

export async function ensureCardReserve(db: Database, householdId: string, spaceId: string, accountId: string, name: string) {
  const existing = await db.query(
    `SELECT id FROM buckets WHERE space_id = $1 AND system_role = 'cc_reserve' AND linked_account_id = $2`,
    [spaceId, accountId],
  );
  if (existing.length) return;
  await db.query(
    `INSERT INTO buckets (id, household_id, space_id, name, group_name, kind, flex_role, envelope_style, rollover, system_role, linked_account_id, display_order, created_at)
     VALUES ($1,$2,$3,$4,'Credit cards','expense','reserve','debt','both','cc_reserve',$5,50,$6)`,
    [id(), householdId, spaceId, `${name} payment`, accountId, nowIso()],
  );
}

export const STARTER_BUCKETS: Omit<Bucket, "id">[] = [
  { name: "Paychecks", group: "Income", kind: "income", flexRole: "income", envelopeStyle: "none", rollover: "none" },
  { name: "Housing", group: "Bills", kind: "expense", flexRole: "fixed", envelopeStyle: "regular", rollover: "both", purpose: "general" },
  { name: "Groceries", group: "Spending", kind: "expense", flexRole: "flexible", envelopeStyle: "regular", rollover: "both" },
  { name: "Household", group: "Spending", kind: "expense", flexRole: "flexible", envelopeStyle: "regular", rollover: "both" },
  { name: "Transport", group: "Spending", kind: "expense", flexRole: "flexible", envelopeStyle: "regular", rollover: "both" },
  { name: "Giving", group: "Giving", kind: "expense", flexRole: "fixed", envelopeStyle: "regular", rollover: "both", purpose: "giving" },
  { name: "Fun", group: "Spending", kind: "expense", flexRole: "flexible", envelopeStyle: "regular", rollover: "both" },
  { name: "Emergency fund", group: "Goals", kind: "expense", flexRole: "reserve", envelopeStyle: "goal", rollover: "both", purpose: "emergency" },
  { name: "Insurance", group: "Sinking funds", kind: "expense", flexRole: "non_monthly", envelopeStyle: "annual", rollover: "both", purpose: "sinking" },
  { name: "Buffer", group: "Reserves", kind: "expense", flexRole: "reserve", envelopeStyle: "none", rollover: "both", purpose: "general", systemRole: "buffer" },
];

export async function insertStarterBuckets(db: Database, householdId: string, spaceId: string) {
  let order = 0;
  for (const bucket of STARTER_BUCKETS) {
    await db.query(
      `INSERT INTO buckets (id, household_id, space_id, name, group_name, kind, flex_role, envelope_style, rollover, icon, display_order, system_role, purpose, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id(),
        householdId,
        spaceId,
        bucket.name,
        bucket.group,
        bucket.kind,
        bucket.flexRole,
        bucket.envelopeStyle,
        bucket.rollover,
        bucket.icon ?? null,
        order++,
        bucket.systemRole ?? null,
        bucket.purpose ?? null,
        nowIso(),
      ],
    );
  }
  await ensureBorrowedBucket(db, householdId, spaceId);
}

export function publicAccounts(accounts: AccountRow[]) {
  return accounts
    .filter((account) => !String(account.id).startsWith("redacted:"))
    .map((account) => ({
      id: account.id,
      spaceId: account.space_id,
      name: account.name,
      kind: account.kind,
      currency: account.currency,
      onBudget: num(account.on_budget) === 1,
      visibility: account.visibility,
      ownerUserId: account.owner_user_id,
      hidden: num(account.hidden) === 1,
      archived: num(account.archived) === 1,
      excludeFromNetWorth: num(account.exclude_from_net_worth) === 1,
      institution: account.institution,
      mask: account.mask,
      creditLimitMinor: account.credit_limit_minor,
      aprBps: account.apr_bps,
      minimumPaymentMinor: account.minimum_payment_minor,
      linkedAccountId: account.linked_account_id,
    }));
}

export function assertWrite(member: Member) {
  if (!canWrite(member.role)) throw new ApiError(403, "You have read-only access to this household.");
}

export function assertBudget(member: Member) {
  if (!["owner", "admin", "editor"].includes(member.role)) {
    throw new ApiError(403, "Your role can record transactions but cannot change the plan.");
  }
}

export function assertAdmin(member: Member) {
  if (!ADMIN_ROLES.has(member.role)) throw new ApiError(403, "Only an owner or admin can do that.");
}

export async function setAssignment(db: Database, householdId: string, spaceId: string, bucketId: string, periodKey: string, amountMinor: number) {
  await db.query(
    `INSERT INTO assignments (id, household_id, space_id, bucket_id, period_key, amount_minor)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (space_id, bucket_id, period_key) DO UPDATE SET amount_minor = EXCLUDED.amount_minor`,
    [id(), householdId, spaceId, bucketId, periodKey, amountMinor],
  );
}

export function planView(loaded: Loaded) {
  const { events } = guidanceFor(loaded, 45);
  const paychecks = (loaded.input.schedules ?? [])
    .filter((schedule) => schedule.direction === "inflow" && !schedule.paused)
    .map((schedule) => ({
      id: schedule.id,
      date: schedule.nextDate,
      amountMinor: schedule.amountMinor,
      received: false,
      earner: schedule.payee || schedule.name,
    }));
  const obligations = events
    .filter((event) => event.amountMinor < 0)
    .map((event) => ({
      id: event.id,
      date: event.date,
      amountMinor: -event.amountMinor,
      name: event.label,
      reservedMinor: 0,
    }));
  const reserved = uncoveredOutflows(
    obligations.map((item) => ({ bucketId: loaded.input.schedules?.find((schedule) => schedule.id === item.id)?.bucketId ?? null, amountMinor: item.amountMinor })),
    loaded.budget,
    loaded.input.buckets,
  );
  const cash = loaded.budget.cashPoolMinor;
  return {
    paychecks: planPaychecks({ asOf: loaded.input.asOf, startingCashMinor: cash, paychecks, obligations: obligations.map((item) => ({ ...item, reservedMinor: 0 })) }),
    note: "Reserved bills are removed in safe-to-spend. This paycheck view lists the obligations before the next payday against cash already on hand.",
    uncoveredPreviewMinor: reserved,
  };
}

export function debtPlan(loaded: Loaded, strategy: "snowball" | "avalanche" | "custom", extraMinor: number, customOrder?: string[]) {
  const debts = loaded.input.accounts
    .filter((account) => ["loan", "student_loan", "mortgage", "credit", "other_liability"].includes(account.kind) && !account.archived && !account.excludeFromNetWorth)
    .map((account) => ({
      id: account.id,
      name: account.name,
      balanceMinor: Math.max(0, netWorth({ ...loaded.input, accounts: [account], transactions: loaded.input.transactions }).liabilitiesMinor),
      aprBps: account.aprBps ?? 0,
      minPaymentMinor: account.minimumPaymentMinor ?? 0,
    }))
    .filter((debt) => debt.balanceMinor > 0);
  if (!debts.length) {
    return { debts: [], plan: null, assumptions: ["Add a loan, card, or other debt with a balance to build a payoff plan."] };
  }
  return {
    debts,
    plan: payoffPlan({ debts, strategy, extraMinor, startDate: loaded.input.asOf, customOrder }),
  };
}

export function visibleNetWorth(loaded: Loaded, values?: { accountId: string; valueMinor: number }[]) {
  const visible = new Set(loaded.accounts.map((account) => account.id));
  return netWorth(
    {
      ...loaded.input,
      transactions: loaded.balanceTransactions,
      accounts: loaded.input.accounts.filter((account) => visible.has(account.id) && !account.excludeFromNetWorth),
    },
    values,
  );
}

export { neededForTarget, previewAutoAssign, evaluateIncomePlan, evaluateWatchlist, spendingRows, projectCash, financialRoadmap, emergencyGap, computeBudget };

export function forecastEventsFromSchedules(
  schedules: import("@budgetcents/domain").Schedule[],
  asOf: string,
  horizonDays: number,
  transactions: Transaction[],
) {
  const until = new Date(Date.parse(`${asOf}T00:00:00Z`) + horizonDays * 86_400_000).toISOString().slice(0, 10);
  const posted = new Set(transactions.filter((txn) => txn.scheduleId && txn.date <= asOf).map((txn) => `${txn.scheduleId}:${txn.date}`));
  const events: { id: string; date: string; amountMinor: number; label: string; kind: "income" | "expense"; expectedIncome?: boolean; bucketId?: string }[] = [];
  for (const schedule of schedules) {
    if (schedule.paused) continue;
    if (schedule.nextDate < asOf || schedule.nextDate > until) continue;
    if (schedule.fulfilledThrough && schedule.fulfilledThrough >= schedule.nextDate) continue;
    if (posted.has(`${schedule.id}:${schedule.nextDate}`)) continue;
    const signed = schedule.direction === "inflow" ? schedule.amountMinor : -schedule.amountMinor;
    events.push({
      id: schedule.id,
      date: schedule.nextDate,
      amountMinor: signed,
      label: schedule.name,
      kind: schedule.direction === "inflow" ? "income" : "expense",
      expectedIncome: schedule.direction === "inflow",
      bucketId: schedule.bucketId,
    });
  }
  return events;
}

export function applyHouseholdRules(txn: Transaction, rules: { id: string; name: string; priority: number; enabled: boolean; matchMode: "all" | "any"; conditions: import("@budgetcents/domain").RuleCondition[]; actions: import("@budgetcents/domain").RuleAction[]; stop?: boolean }[]) {
  return applyRules(txn, rules);
}
