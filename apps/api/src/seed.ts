import { hashPassword, id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { ensureCardReserve, insertStarterBuckets } from "./finance.js";

export const DEMO_EMAIL = "demo@budgetcents.app";
export const DEMO_PASSWORD = "DemoHousehold1";

export async function ensureDemo(db: Database): Promise<void> {
  const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL]);
  if (existing.length) return;
  const userId = id();
  const householdId = id();
  const spaceId = id();
  const personalId = id();
  const created = nowIso();
  await db.tx(async () => {
    await db.query(
      `INSERT INTO users (id, email, password_hash, display_name, email_verified_at, locale, time_zone, budget_approach, label_mode, onboarding_step, created_at)
       VALUES ($1,$2,$3,$4,$5,'en-US','America/Chicago','zero','categories','done',$5)`,
      [userId, DEMO_EMAIL, await hashPassword(DEMO_PASSWORD), "Alex Rivera", created],
    );
    await db.query(
      `INSERT INTO households (id, name, kind, currency, budget_approach, label_mode, is_demo, time_zone, created_at)
       VALUES ($1,'Rivera household','family','USD','zero','categories',1,'America/Chicago',$2)`,
      [householdId, created],
    );
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)`, [householdId, userId, created]);
    await db.query(
      `INSERT INTO spaces (id, household_id, name, kind, owner_user_id, currency, created_at) VALUES ($1,$2,'Household','household',null,'USD',$3), ($4,$2,'Alex private','personal',$5,'USD',$3)`,
      [spaceId, householdId, created, personalId, userId],
    );
    await insertStarterBuckets(db, householdId, spaceId);
    const checking = id();
    const savings = id();
    const card = id();
    const loan = id();
    const brokerage = id();
    const wallet = id();
    const accounts: [string, string, string, string, number, string, number | null, number | null, number | null][] = [
      [checking, spaceId, "Checking", "checking", 1, "shared", null, null, null],
      [savings, spaceId, "Savings", "savings", 1, "shared", null, null, null],
      [card, spaceId, "Everyday card", "credit", 1, "shared", 500_000, 1999, 2_500],
      [loan, spaceId, "Car loan", "loan", 0, "shared", null, 649, 32_000],
      [brokerage, spaceId, "Brokerage", "brokerage", 0, "shared", null, null, null],
      [wallet, personalId, "Wallet", "cash", 1, "private", null, null, null],
    ];
    for (const [accountId, accountSpace, name, kind, onBudget, visibility, limit, apr, minimum] of accounts) {
      await db.query(
        `INSERT INTO accounts (id, household_id, space_id, name, kind, currency, on_budget, visibility, owner_user_id, credit_limit_minor, apr_bps, minimum_payment_minor, institution, mask, created_at)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [accountId, householdId, accountSpace, name, kind, onBudget, visibility, visibility === "private" ? userId : null, limit, apr, minimum, visibility === "private" ? "Cash" : "Sample institution", visibility === "private" ? null : "1234", created],
      );
    }
    await ensureCardReserve(db, householdId, spaceId, card, "Everyday card");
    const bucket = async (name: string) => {
      const rows = await db.query(`SELECT id FROM buckets WHERE space_id = $1 AND name = $2`, [spaceId, name]);
      return String(rows[0].id);
    };
    const groceries = await bucket("Groceries");
    const householdBucket = await bucket("Household");
    const housing = await bucket("Housing");
    const emergency = await bucket("Emergency fund");
    const paychecks = await bucket("Paychecks");
    await addTxn(db, householdId, spaceId, checking, null, 180_000, "opening", "Opening balance", "2026-11-01");
    await addTxn(db, householdId, spaceId, savings, null, 800_000, "opening", "Opening balance", "2026-11-01");
    await addTxn(db, householdId, spaceId, loan, null, -640_000, "opening", "Opening balance", "2026-11-01");
    await addTxn(db, householdId, personalId, wallet, null, 5_000, "opening", "Cash in wallet", "2026-11-01");
    await addTxn(db, householdId, spaceId, checking, null, 320_000, "income", "Northwind payroll", "2026-11-03", [
      { bucketId: paychecks, amountMinor: 320_000, role: "income" },
    ]);
    await addTxn(db, householdId, spaceId, card, null, -10_000, "expense", "Market", "2026-11-04", [
      { bucketId: groceries, amountMinor: 6_000, role: "expense" },
      { bucketId: householdBucket, amountMinor: 4_000, role: "expense" },
    ]);
    await addTxn(db, householdId, spaceId, checking, null, -22_000, "expense", "Market", "2026-11-06", [
      { bucketId: groceries, amountMinor: 22_000, role: "expense" },
    ]);
    await addTxn(db, householdId, spaceId, checking, card, -10_000, "cc_payment", "Everyday card payment", "2026-11-07");
    await addTxn(db, householdId, spaceId, checking, null, 1_500, "refund", "Market refund", "2026-11-08", [
      { bucketId: groceries, amountMinor: 1_500, role: "refund" },
    ]);
    await addTxn(db, householdId, spaceId, savings, brokerage, -250_000, "transfer", "Move to brokerage", "2026-11-09");
    const assignments: [string, number][] = [
      [housing, 180_000],
      [groceries, 60_000],
      [householdBucket, 40_000],
      [await bucket("Transport"), 25_000],
      [await bucket("Giving"), 20_000],
      [await bucket("Fun"), 30_000],
      [emergency, 450_000],
      [await bucket("Insurance"), 15_000],
      [await bucket("Buffer"), 50_000],
    ];
    for (const [bucketId, amount] of assignments) {
      await db.query(
        `INSERT INTO assignments (id, household_id, space_id, bucket_id, period_key, amount_minor) VALUES ($1,$2,$3,$4,'2026-11',$5)`,
        [id(), householdId, spaceId, bucketId, amount],
      );
    }
    await db.query(
      `UPDATE buckets SET target_json = $1 WHERE id = $2`,
      [JSON.stringify({ type: "balance_by_date", amountMinor: 600_000, cadence: "monthly", dueDate: "2027-06-01" }), emergency],
    );
    await db.query(
      `INSERT INTO goals (id, household_id, space_id, bucket_id, name, target_minor, target_date, priority, purpose, notes)
       VALUES ($1,$2,$3,$4,'Emergency fund',600000,'2027-06-01',1,'emergency','Same envelope as the emergency category. It is not a second pile of cash.')`,
      [id(), householdId, spaceId, emergency],
    );
    await db.query(
      `INSERT INTO schedules (id, household_id, space_id, name, cadence, next_date, amount_minor, direction, account_id, bucket_id, type, payee, confirmed)
       VALUES ($1,$2,$3,'Rent','monthly','2026-11-20',180000,'outflow',$4,$5,'bill','Harbor Rent',1),
              ($6,$2,$3,'Northwind payroll','biweekly','2026-11-17',320000,'inflow',$4,$7,'income','Northwind',1)`,
      [id(), householdId, spaceId, checking, housing, id(), paychecks],
    );
    const holdingId = id();
    await db.query(
      `INSERT INTO holdings (id, household_id, account_id, symbol, name, asset_class, sector, geography, quantity, cost_basis_minor, currency)
       VALUES ($1,$2,$3,'VTI','Total market fund','Equity','Broad','United States','10',250000,'USD')`,
      [holdingId, householdId, brokerage],
    );
    await db.query(
      `INSERT INTO quotes (id, household_id, symbol, price_minor, as_of, source, delayed, currency)
       VALUES ($1,$2,'VTI',25000,'2026-11-09','manual',1,'USD')`,
      [id(), householdId],
    );
    await db.query(
      `INSERT INTO credit_entries (id, household_id, user_id, score, model, bureau, report_date, source, factors_json, created_at)
       VALUES ($1,$2,$3,742,'Manual entry','None','2026-11-01','manual','["This is a number you typed. It is not a bureau report."]',$4)`,
      [id(), householdId, userId, created],
    );
    await db.query(
      `INSERT INTO checklist_items (id, household_id, kind, title, sort) VALUES
       ($1,$2,'estate','List the people who should be able to find this household',0),
       ($3,$2,'estate','Review who can see shared accounts',1),
       ($4,$2,'tax','Tag deductible expenses',0),
       ($5,$2,'tax','Export a file for a tax preparer',1)`,
      [id(), householdId, id(), id(), id()],
    );
    for (const [index, [itemId, label]] of [
      ["starter_emergency", "Starter emergency buffer"],
      ["debt_free", "Debt payoff"],
      ["full_emergency", "Full emergency reserve"],
      ["retirement", "Retirement contributions"],
    ].entries()) {
      await db.query(`INSERT INTO roadmap_order (household_id, item_id, label, sort) VALUES ($1,$2,$3,$4)`, [householdId, itemId, label, index]);
    }
  });
}

async function addTxn(
  db: Database,
  householdId: string,
  spaceId: string,
  accountId: string,
  counter: string | null,
  amount: number,
  type: string,
  payee: string,
  date: string,
  splits: { bucketId: string | null; amountMinor: number; role: string }[] = [],
) {
  const txnId = id();
  const stamp = nowIso();
  await db.query(
    `INSERT INTO transactions (id, household_id, space_id, date, account_id, counter_account_id, amount_minor, currency, type, payee, bank_status, review_status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,'posted','reviewed',$10,$10)`,
    [txnId, householdId, spaceId, date, accountId, counter, amount, type, payee, stamp],
  );
  for (const split of splits) {
    await db.query(`INSERT INTO splits (id, transaction_id, bucket_id, amount_minor, role) VALUES ($1,$2,$3,$4,$5)`, [
      id(),
      txnId,
      split.bucketId,
      split.amountMinor,
      split.role,
    ]);
  }
}
