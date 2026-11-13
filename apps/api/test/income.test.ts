import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;

afterEach(async () => {
  await db?.close();
});

async function app() {
  db = await openMemoryDatabase();
  return createApp(db);
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function household(api: Awaited<ReturnType<typeof app>>, email: string) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: email, householdName: email }),
  }));
  const token = registered.body.token as string;
  const userId = registered.body.user.id as string;
  const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-10`, { headers: auth(token) }));
  return { token, userId, hid, spaceId: dash.body.spaceId as string, currency: dash.body.household.currency as string };
}

async function checking(api: Awaited<ReturnType<typeof app>>, home: Awaited<ReturnType<typeof household>>, opening = 100000) {
  return json(await api.request(`/api/households/${home.hid}/accounts`, {
    method: "POST",
    headers: auth(home.token),
    body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: opening, openingDate: "2026-11-01" }),
  }));
}

async function snapshot(api: Awaited<ReturnType<typeof app>>, home: Awaited<ReturnType<typeof household>>) {
  const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
  const txns = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-10&limit=50`, { headers: auth(home.token) }));
  const income = (txns.body.transactions as { type: string; amountMinor: number }[]).filter((txn) => txn.type === "income");
  return {
    cash: dash.body.budget.cashPoolMinor as number,
    ready: dash.body.budget.readyToAssignMinor as number,
    net: dash.body.netWorth.netMinor as number,
    income: dash.body.budget.incomeMinor as number,
    eligible: dash.body.funding.eligiblePostedIncomeMinor as number,
    deposits: income,
  };
}

describe("irregular paychecks", () => {
  it("keeps expected irregular pay out of the ledger until one receipt is recorded", async () => {
    const api = await app();
    const home = await household(api, "pay@example.com");
    const account = await checking(api, home);
    const before = await snapshot(api, home);
    expect(before).toMatchObject({ cash: 100000, ready: 100000, net: 100000, income: 0, eligible: 0 });
    expect(before.deposits).toHaveLength(0);

    const created = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        spaceId: home.spaceId,
        name: "Side contract",
        kind: "irregular",
        accountId: account.body.id,
        amountMinor: 0,
        cadence: "irregular",
        startDate: "2026-11-01",
        dates: [
          { date: "2026-11-18", amountMinor: 120000 },
          { date: "2026-11-27", amountMinor: 65000 },
        ],
      }),
    }));
    expect(created.status).toBe(201);
    const parked = await snapshot(api, home);
    expect(parked).toMatchObject({ cash: 100000, ready: 100000, net: 100000, income: 0, eligible: 0 });
    expect(parked.deposits).toHaveLength(0);
    const forecast = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&from=2026-11-10&to=2026-12-15`, { headers: auth(home.token) }));
    expect(forecast.body.expectedReceipts.map((item: { amountMinor: number }) => item.amountMinor).sort((a: number, b: number) => a - b)).toEqual([65000, 120000]);
    expect(forecast.body.projectedWithExpectedMinor - forecast.body.projectedCashMinor).toBe(185000);
    expect(forecast.body.actual.cashMinor).toBe(100000);
    expect(forecast.body.note).toMatch(/not cash/i);

    const opId = "receipt-side-contract-1";
    const received = await json(await api.request(`/api/households/${home.hid}/income-sources/${created.body.id}/receive`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-18", opId, mode: "full", amountMinor: 110000, receivedDate: "2026-11-10" }),
    }));
    expect(received.status).toBe(200);
    expect(received.body.duplicate).toBe(false);
    const after = await snapshot(api, home);
    expect(after).toMatchObject({ cash: 210000, ready: 210000, net: 210000, income: 110000, eligible: 110000 });
    expect(after.deposits).toHaveLength(1);
    expect(after.deposits[0].amountMinor).toBe(110000);
    const later = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&from=2026-11-10&to=2026-12-15`, { headers: auth(home.token) }));
    expect(later.body.expectedReceipts.map((item: { amountMinor: number }) => item.amountMinor)).toEqual([65000]);
    expect(later.body.projectedWithExpectedMinor - later.body.projectedCashMinor).toBe(65000);

    const retry = await json(await api.request(`/api/households/${home.hid}/income-sources/${created.body.id}/receive`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-18", opId, mode: "full", amountMinor: 110000, receivedDate: "2026-11-10" }),
    }));
    expect(retry.body.duplicate).toBe(true);
    const still = await snapshot(api, home);
    expect(still.cash).toBe(210000);
    expect(still.deposits).toHaveLength(1);

    const renamed = await json(await api.request(`/api/households/${home.hid}/income-sources/${created.body.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({
        spaceId: home.spaceId,
        name: "Side contract revised",
        kind: "irregular",
        accountId: account.body.id,
        amountMinor: 0,
        cadence: "irregular",
        startDate: "2026-11-01",
        version: 1,
        dates: [{ date: "2026-11-27", amountMinor: 70000 }],
      }),
    }));
    expect(renamed.status).toBe(200);
    const detail = await json(await api.request(`/api/households/${home.hid}/income-sources/${created.body.id}`, { headers: auth(home.token) }));
    expect(detail.body.history[0].receivedAmountMinor).toBe(110000);
    expect(detail.body.history[0].transactionId).toBe(received.body.transactionId);
    const kept = await snapshot(api, home);
    expect(kept.deposits[0].amountMinor).toBe(110000);
    expect(kept.cash).toBe(210000);
  });

  it("records a partial, a delay, and a cancellation without posting expected money", async () => {
    const api = await app();
    const home = await household(api, "partial@example.com");
    const account = await checking(api, home);
    const source = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        spaceId: home.spaceId, name: "Bonus", kind: "bonus", accountId: account.body.id, amountMinor: 120000,
        cadence: "once", startDate: "2026-11-20",
      }),
    }));
    const partial = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/receive`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-20", opId: "partial-bonus-1", mode: "partial", amountMinor: 50000, receivedDate: "2026-11-10" }),
    }));
    expect(partial.status).toBe(200);
    expect((await snapshot(api, home)).cash).toBe(150000);
    const plan = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&to=2026-12-01`, { headers: auth(home.token) }));
    expect(plan.body.expectedReceipts).toEqual([expect.objectContaining({ amountMinor: 70000, status: "partial" })]);
    const retry = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/receive`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-20", opId: "partial-bonus-1", mode: "partial", amountMinor: 50000, receivedDate: "2026-11-10" }),
    }));
    expect(retry.body.duplicate).toBe(true);
    expect((await snapshot(api, home)).deposits).toHaveLength(1);

    const delayed = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Shift", kind: "hourly", accountId: account.body.id, amountMinor: 40000, cadence: "once", startDate: "2026-11-22" }),
    }));
    const moved = await json(await api.request(`/api/households/${home.hid}/income-sources/${delayed.body.id}/delay`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-22", delayedUntil: "2026-11-28" }),
    }));
    expect(moved.status).toBe(200);
    const delayedPlan = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&to=2026-12-01`, { headers: auth(home.token) }));
    expect(delayedPlan.body.expectedReceipts).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-11-28", status: "delayed", amountMinor: 40000 })]));
    expect((await snapshot(api, home)).cash).toBe(150000);
    const cancelled = await json(await api.request(`/api/households/${home.hid}/income-sources/${delayed.body.id}/cancel`, {
      method: "POST", headers: auth(home.token), body: JSON.stringify({ expectedDate: "2026-11-22" }),
    }));
    expect(cancelled.status).toBe(200);
    const afterCancel = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&to=2026-12-01`, { headers: auth(home.token) }));
    expect(afterCancel.body.expectedReceipts.some((item: { name: string }) => item.name === "Shift")).toBe(false);
    expect((await snapshot(api, home)).deposits).toHaveLength(1);
  });

  it("rejects an invalid interval, keeps the 31st anchor, and separates twice-monthly from biweekly", async () => {
    const api = await app();
    const home = await household(api, "dates@example.com");
    const account = await checking(api, home, 0);
    const invalid = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Bad", kind: "salary", accountId: account.body.id, amountMinor: 100, cadence: "every_n_days", startDate: "2026-01-01" }),
    }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/30 days/);
    const listed = await json(await api.request(`/api/households/${home.hid}/income-sources`, { headers: auth(home.token) }));
    expect(listed.body.sources).toHaveLength(0);

    const anchored = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Salary", kind: "salary", accountId: account.body.id, amountMinor: 100, cadence: "monthly", anchorDay: 31, startDate: "2026-01-31" }),
    }));
    expect(anchored.status).toBe(201);
    const calendar = await json(await api.request(`/api/households/${home.hid}/calendar?asOf=2026-01-01&from=2026-01-01&to=2026-05-31`, { headers: auth(home.token) }));
    const salary = calendar.body.items.filter((item: { name: string }) => item.name === "Salary").map((item: { date: string }) => item.date);
    expect(salary).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);

    const twice = await json(await api.request(`/api/households/${home.hid}/schedules`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Twice", cadence: "twice_monthly", nextDate: "2026-01-01", amountMinor: 100, direction: "outflow", type: "bill", twiceDays: [1, 15] }),
    }));
    const weeks = await json(await api.request(`/api/households/${home.hid}/schedules`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Weeks", cadence: "biweekly", nextDate: "2026-01-01", amountMinor: 100, direction: "outflow", type: "bill" }),
    }));
    expect(twice.status).toBe(201);
    expect(weeks.status).toBe(201);
    const bills = await json(await api.request(`/api/households/${home.hid}/calendar?asOf=2026-01-01&from=2026-01-01&to=2026-02-28`, { headers: auth(home.token) }));
    expect(bills.body.items.filter((item: { name: string }) => item.name === "Twice").map((item: { date: string }) => item.date)).toEqual(["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]);
    expect(bills.body.items.filter((item: { name: string }) => item.name === "Weeks").map((item: { date: string }) => item.date)).toContain("2026-01-29");
    const custom = await json(await api.request(`/api/households/${home.hid}/schedules`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Every ten", cadence: "every_n_days", customInterval: 10, nextDate: "2026-11-01", amountMinor: 500, direction: "outflow", type: "bill" }),
    }));
    const skipped = await json(await api.request(`/api/households/${home.hid}/schedules/${custom.body.id}/skip`, { method: "POST", headers: auth(home.token) }));
    expect(skipped.body.nextDate).toBe("2026-11-11");
    const badBill = await json(await api.request(`/api/households/${home.hid}/schedules`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Nope", cadence: "every_n_days", nextDate: "2026-11-01", amountMinor: 500, direction: "outflow", type: "bill" }),
    }));
    expect(badBill.status).toBe(400);
    expect(badBill.body.error).toMatch(/30 days/);
  });

  it("does not let another household, a viewer, or a private account read or post the paycheck", async () => {
    const api = await app();
    const home = await household(api, "owner@example.com");
    const account = await checking(api, home);
    const source = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Visible", kind: "salary", accountId: account.body.id, amountMinor: 80000, cadence: "monthly", anchorDay: 15, startDate: "2026-11-15" }),
    }));
    const other = await household(api, "other@example.com");
    const foreign = await json(await api.request(`/api/households/${home.hid}/income-sources`, { headers: auth(other.token) }));
    expect(foreign.status).toBe(404);
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'viewer',$3)`, [home.hid, other.userId, "2026-11-01T00:00:00.000Z"]);
    const viewerCreate = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(other.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Nope", kind: "other", accountId: account.body.id, amountMinor: 1, cadence: "once", startDate: "2026-11-15" }),
    }));
    expect(viewerCreate.status).toBe(403);
    const viewerReceive = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/receive`, {
      method: "POST", headers: auth(other.token),
      body: JSON.stringify({ expectedDate: "2026-11-15", opId: "viewer-should-fail", mode: "full", amountMinor: 80000, receivedDate: "2026-11-10" }),
    }));
    expect(viewerReceive.status).toBe(403);
    expect((await snapshot(api, home)).cash).toBe(100000);

    const hidden = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Private cash", kind: "cash", onBudget: true, visibility: "private", openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const quiet = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Quiet contract", kind: "freelance", accountId: hidden.body.id, amountMinor: 99900, cadence: "once", startDate: "2026-11-19" }),
    }));
    expect(quiet.status).toBe(201);
    await db.query(`UPDATE memberships SET role = 'editor' WHERE household_id = $1 AND user_id = $2`, [home.hid, other.userId]);
    const editorList = await json(await api.request(`/api/households/${home.hid}/income-sources`, { headers: auth(other.token) }));
    expect(editorList.body.sources.map((item: { name: string }) => item.name)).toEqual(["Visible"]);
    const editorRead = await json(await api.request(`/api/households/${home.hid}/income-sources/${quiet.body.id}`, { headers: auth(other.token) }));
    expect(editorRead.status).toBe(404);
    const editorPlan = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&to=2026-12-01`, { headers: auth(other.token) }));
    expect(JSON.stringify(editorPlan.body)).not.toContain("Quiet contract");
    expect(JSON.stringify(editorPlan.body)).not.toContain("99900");
    const answer = await json(await api.request(`/api/households/${home.hid}/assistant`, {
      method: "POST", headers: auth(other.token), body: JSON.stringify({ question: "When is my next paycheck?" }),
    }));
    expect(answer.body.text).not.toContain("Quiet");
    expect(answer.body.text).toMatch(/not cash/i);

    const stale = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}`, {
      method: "PATCH", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Visible", kind: "salary", accountId: account.body.id, amountMinor: 1, cadence: "monthly", anchorDay: 15, startDate: "2026-11-15", version: 9 }),
    }));
    expect(stale.status).toBe(409);
    const one = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/revise`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-12-15", scope: "one", amountMinor: 81000, date: "2026-12-16" }),
    }));
    expect(one.status).toBe(200);
    const changed = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&from=2026-11-01&to=2027-01-15`, { headers: auth(home.token) }));
    const visible = changed.body.expectedReceipts.filter((item: { name: string }) => item.name === "Visible");
    expect(visible).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: "2026-11-15", amountMinor: 80000 }),
      expect.objectContaining({ date: "2026-12-16", amountMinor: 81000 }),
    ]));
  });

  it("links an imported deposit once and does not count a paid bill twice", async () => {
    const api = await app();
    const home = await household(api, "link@example.com");
    const account = await checking(api, home);
    const deposit = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-10", accountId: account.body.id, amountMinor: 40000, type: "income", payee: "Imported pay", bankStatus: "posted", splits: [], providerTransactionId: "bank-pay-1" }),
    }));
    const source = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Imported", kind: "salary", accountId: account.body.id, amountMinor: 50000, cadence: "once", startDate: "2026-11-18" }),
    }));
    const linked = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/receive`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-18", opId: "link-imported-pay", mode: "link", transactionId: deposit.body.id, receivedDate: "2026-11-10" }),
    }));
    expect(linked.status).toBe(200);
    expect(linked.body.transactionId).toBe(deposit.body.id);
    const once = await snapshot(api, home);
    expect(once.cash).toBe(140000);
    expect(once.deposits).toHaveLength(1);
    const retry = await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/receive`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-18", opId: "link-imported-pay", mode: "link", transactionId: deposit.body.id }),
    }));
    expect(retry.body.duplicate).toBe(true);
    expect((await snapshot(api, home)).deposits).toHaveLength(1);
    const plan = await json(await api.request(`/api/households/${home.hid}/paychecks?asOf=2026-11-10&to=2026-12-01`, { headers: auth(home.token) }));
    expect(plan.body.expectedReceipts).toEqual([]);

    const buckets = (await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }))).body.buckets as { id: string; name: string }[];
    const bucket = buckets.find((item) => item.name === "Housing") ?? buckets[0];
    const bill = await json(await api.request(`/api/households/${home.hid}/schedules`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Power", cadence: "monthly", nextDate: "2026-11-05", amountMinor: 4000, direction: "outflow", type: "bill", accountId: account.body.id, bucketId: bucket.id }),
    }));
    await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-05", accountId: account.body.id, amountMinor: -4000, type: "expense", payee: "Power", bankStatus: "posted", splits: [], scheduleId: bill.body.id }),
    });
    const calendar = await json(await api.request(`/api/households/${home.hid}/calendar?asOf=2026-11-10&from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    const power = calendar.body.items.filter((item: { name: string }) => item.name === "Power");
    expect(power).toEqual([expect.objectContaining({ date: "2026-11-05", status: "paid", estimate: false })]);
    expect(calendar.body.projectedCashMinor).toBe(calendar.body.actualCashMinor);
  });
});
