import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { fillSchedulerStatus, runDueFills } from "../src/fills.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;

afterEach(async () => {
  const current = db as Database | undefined;
  db = undefined as unknown as Database;
  await current?.close();
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
  const bucket = (name: string) => dash.body.buckets.find((item: { name: string }) => item.name === name);
  return { token, userId, hid, spaceId: dash.body.spaceId as string, bucket, dash: dash.body };
}

function categoryBody(bucket: { name: string; group: string; kind: string; flexRole: string; envelopeStyle: string; rollover: string; displayOrder?: number; version?: number; purpose?: string }, extra: Record<string, unknown> = {}) {
  return {
    version: bucket.version ?? 1,
    name: bucket.name,
    group: bucket.group,
    icon: "cart",
    displayOrder: bucket.displayOrder ?? 2,
    kind: bucket.kind,
    flexRole: bucket.flexRole,
    envelopeStyle: bucket.envelopeStyle,
    rollover: bucket.rollover,
    archived: false,
    target: null,
    effectivePeriod: "2026-11",
    ...extra,
  };
}

describe("category editing", () => {
  it("edits an existing category without moving money and rejects a stale version", async () => {
    const api = await app();
    const home = await household(api, "edit-cat@example.com");
    const groceries = home.bucket("Groceries");
    const before = await json(await api.request(`/api/households/${home.hid}/transactions`, { headers: auth(home.token) }));
    const saved = await json(await api.request(`/api/households/${home.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody(groceries, {
        name: "Market",
        group: "Food",
        flexRole: "fixed",
        envelopeStyle: "annual",
        target: { type: "set_aside", amountMinor: 0, cadence: "monthly", percentBps: 1050, dueDate: "2026-12-31" },
      })),
    }));
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect(saved.body.effect).toMatch(/does not assign or spend|unchanged/);
    const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    const market = dash.body.buckets.find((item: { id: string }) => item.id === groceries.id);
    expect(market.name).toBe("Market");
    expect(market.group).toBe("Food");
    expect(market.flexRole).toBe("fixed");
    expect(market.envelopeStyle).toBe("annual");
    expect(market.target.percentBps).toBe(1050);
    expect(dash.body.funding.eligiblePostedIncomeMinor).toBe(0);
    const progress = dash.body.funding.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id);
    expect(progress.targetMinor).toBe(0);
    expect(progress.shortfallMinor).toBe(0);
    const after = await json(await api.request(`/api/households/${home.hid}/transactions`, { headers: auth(home.token) }));
    expect(after.body.transactions.length).toBe(before.body.transactions.length);
    const stale = await json(await api.request(`/api/households/${home.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody({ ...market, version: 1 }, { name: "Old name" })),
    }));
    expect(stale.status).toBe(409);
    const still = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(still.body.buckets.find((item: { id: string }) => item.id === groceries.id).name).toBe("Market");
    const other = await household(api, "other-cat@example.com");
    const foreign = await json(await api.request(`/api/households/${other.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(other.token),
      body: JSON.stringify(categoryBody(market)),
    }));
    expect(foreign.status).toBe(404);
    const buffer = home.bucket("Buffer");
    const system = await json(await api.request(`/api/households/${home.hid}/buckets/${buffer.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody(buffer, { name: "Not buffer" })),
    }));
    expect(system.status).toBe(400);
  });

  it("applies a new rollover when the month closes and can recalculate earlier months on purpose", async () => {
    const api = await app();
    const home = await household(api, "roll@example.com");
    const groceries = home.bucket("Groceries");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-10-01" }),
    }));
    expect(account.status).toBe(201);
    await api.request(`/api/households/${home.hid}/assignments`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, bucketId: groceries.id, periodKey: "2026-10", amountMinor: 4000 }),
    });
    const preview = await json(await api.request(`/api/households/${home.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody(groceries, { rollover: "none", preview: true })),
    }));
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.thisMonth.availableDeltaMinor).toBe(0);
    expect(preview.body.nextMonth.availableDeltaMinor).toBe(-4000);
    const unchanged = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20&month=2026-11`, { headers: auth(home.token) }));
    expect(unchanged.body.buckets.find((item: { id: string }) => item.id === groceries.id).rollover).toBe("both");
    const saved = await json(await api.request(`/api/households/${home.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody(groceries, { rollover: "none" })),
    }));
    expect(saved.status).toBe(200);
    const november = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20&month=2026-11`, { headers: auth(home.token) }));
    const december = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-12-20&month=2026-12`, { headers: auth(home.token) }));
    expect(november.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id).availableMinor).toBe(4000);
    expect(december.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id).availableMinor).toBe(0);
    expect(december.body.budget.readyToAssignMinor).toBe(10000);
    const recalc = await json(await api.request(`/api/households/${home.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody({ ...groceries, version: saved.body.version, rollover: "none" }, { rollover: "none", recalculate: true })),
    }));
    expect(recalc.status).toBe(200);
    expect(recalc.body.effect).toMatch(/recalculated/);
    const rewritten = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20&month=2026-11`, { headers: auth(home.token) }));
    expect(rewritten.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id).availableMinor).toBe(0);
    expect(rewritten.body.budget.readyToAssignMinor).toBe(10000);
  });
});

describe("scheduled fills", () => {
  it("allocates the acceptance case once and leaves accounts, income, and net worth unchanged", async () => {
    const api = await app();
    const home = await household(api, "fill@example.com");
    const groceries = home.bucket("Groceries");
    const trip = home.bucket("Fun");
    const housing = home.bucket("Housing");
    await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 100000, openingDate: "2026-11-01" }),
    });
    for (const [bucketId, amountMinor] of [[groceries.id, 10000], [housing.id, 60000]] as const) {
      const assigned = await json(await api.request(`/api/households/${home.hid}/assignments`, {
        method: "POST",
        headers: auth(home.token),
        body: JSON.stringify({ spaceId: home.spaceId, bucketId, periodKey: "2026-11", amountMinor }),
      }));
      expect(assigned.status).toBe(200);
    }
    const before = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(before.body.budget.readyToAssignMinor).toBe(30000);
    expect(before.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id).availableMinor).toBe(10000);
    expect(before.body.budget.cashPoolMinor).toBe(100000);
    const txns = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-10`, { headers: auth(home.token) }));
    const template = {
      spaceId: home.spaceId,
      name: "Payday fill",
      cadence: "monthly",
      startDate: "2026-11-10",
      shortfallPolicy: "partial",
      lines: [
        { bucketId: groceries.id, mode: "top_up", amountMinor: 20000, priority: 1 },
        { bucketId: trip.id, mode: "add", amountMinor: 15000, priority: 2 },
      ],
    };
    const preview = await json(await api.request(`/api/households/${home.hid}/fills/preview?today=2026-11-10`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify(template),
    }));
    expect(preview.status).toBe(200);
    expect(preview.body.note).toMatch(/No money has moved/);
    expect(preview.body.plan.totalAllocatedMinor).toBe(25000);
    expect(preview.body.plan.readyAfterMinor).toBe(5000);
    const still = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(still.body.budget.readyToAssignMinor).toBe(30000);
    const created = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify(template),
    }));
    expect(created.status).toBe(201);
    expect(created.body.statusLabel).toBe("Scheduled");
    const ran = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    expect(ran.status).toBe(200);
    expect(ran.body.statusLabel).toBe("Applied");
    expect(ran.body.allocatedMinor).toBe(25000);
    expect(ran.body.duplicate).toBe(false);
    const after = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(after.body.budget.readyToAssignMinor).toBe(5000);
    expect(after.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id).availableMinor).toBe(20000);
    expect(after.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === trip.id).availableMinor).toBe(15000);
    expect(after.body.budget.cashPoolMinor).toBe(100000);
    expect(after.body.budget.incomeMinor).toBe(0);
    expect(after.body.budget.spendingMinor).toBe(0);
    expect(after.body.netWorth.netMinor).toBe(before.body.netWorth.netMinor);
    expect(after.body.budget.identityDifferenceMinor).toBe(0);
    const txnsAfter = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(txnsAfter.body.transactions.length).toBe(txns.body.transactions.length);
    const replay = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    expect(replay.body.duplicate).toBe(true);
    const replayDash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(replayDash.body.budget.readyToAssignMinor).toBe(5000);
    const history = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/history`, { headers: auth(home.token) }));
    expect(history.body.history[0].statusLabel).toBe("Applied");
  });

  it("skips or partially funds, and a missed month is not filled on restart", async () => {
    const api = await app();
    const home = await household(api, "policy@example.com");
    const groceries = home.bucket("Groceries");
    const fun = home.bucket("Fun");
    await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 1000, openingDate: "2026-11-01" }),
    });
    const lines = [
      { bucketId: groceries.id, mode: "add", amountMinor: 800, priority: 1 },
      { bucketId: fun.id, mode: "add", amountMinor: 800, priority: 2 },
    ];
    const skipped = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Skip me", cadence: "once", startDate: "2026-11-10", shortfallPolicy: "skip", lines }),
    }));
    const skipRun = await json(await api.request(`/api/households/${home.hid}/fills/${skipped.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    expect(skipRun.body.statusLabel).toBe("Skipped");
    expect(skipRun.body.allocatedMinor).toBe(0);
    const partial = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Partial", cadence: "once", startDate: "2026-11-10", shortfallPolicy: "partial", lines }),
    }));
    const partialRun = await json(await api.request(`/api/households/${home.hid}/fills/${partial.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    expect(partialRun.body.statusLabel).toBe("Partially funded");
    expect(partialRun.body.allocatedMinor).toBe(1000);
    const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(dash.body.budget.readyToAssignMinor).toBe(0);
    expect(dash.body.budget.cashPoolMinor).toBe(1000);
    const stale = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Old", cadence: "monthly", startDate: "2026-01-31", shortfallPolicy: "partial", lines: [{ bucketId: groceries.id, mode: "add", amountMinor: 100, priority: 1 }] }),
    }));
    const due = await runDueFills(db, { today: "2026-03-15", householdId: home.hid });
    expect(due.applied).toBe(0);
    const listed = await json(await api.request(`/api/households/${home.hid}/fills`, { headers: auth(home.token) }));
    const old = listed.body.fills.find((fill: { id: string }) => fill.id === stale.body.id);
    expect(old.nextDate).toBe("2026-03-31");
    expect(old.statusLabel).toBe("Scheduled");
    const oldHistory = await json(await api.request(`/api/households/${home.hid}/fills/${stale.body.id}/history`, { headers: auth(home.token) }));
    expect(oldHistory.body.history.every((row: { statusLabel: string; allocatedMinor: number }) => row.statusLabel === "Skipped" && row.allocatedMinor === 0)).toBe(true);
    const again = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(again.body.budget.readyToAssignMinor).toBe(0);
  });

  it("does not fund a percent from a refund, and stops when the category or member is gone", async () => {
    const api = await app();
    const home = await household(api, "percent-fill@example.com");
    const groceries = home.bucket("Groceries");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 50000, openingDate: "2026-11-01" }),
    }));
    await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-02", accountId: account.body.id, amountMinor: 20000, type: "income", payee: "Pay", bankStatus: "posted", splits: [] }),
    });
    await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ date: "2026-11-03", accountId: account.body.id, amountMinor: 5000, type: "refund", payee: "Store", bankStatus: "posted", splits: [] }),
    });
    const created = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        spaceId: home.spaceId,
        name: "Ten percent",
        cadence: "monthly",
        startDate: "2026-11-10",
        shortfallPolicy: "partial",
        lines: [{ bucketId: groceries.id, mode: "percent", percentBps: 1000, priority: 1 }],
      }),
    }));
    const ran = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    expect(ran.body.allocatedMinor).toBe(2000);
    const archived = await json(await api.request(`/api/households/${home.hid}/buckets/${groceries.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(categoryBody(groceries, { archived: true, name: "Groceries" })),
    }));
    expect(archived.status).toBe(200);
    const blocked = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Gone", cadence: "once", startDate: "2026-11-12", shortfallPolicy: "partial", lines: [{ bucketId: groceries.id, mode: "add", amountMinor: 100, priority: 1 }] }),
    }));
    expect(blocked.status).toBe(400);
    await db.query(`UPDATE memberships SET role = 'viewer' WHERE user_id = $1`, [home.userId]);
    const denied = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/run?today=2026-12-10`, { method: "POST", headers: auth(home.token) }));
    expect(denied.status).toBe(403);
  });

  it("applies one occurrence when Run now is repeated and rejects a second claim for that key", async () => {
    const api = await app();
    const home = await household(api, "race@example.com");
    const groceries = home.bucket("Groceries");
    await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    });
    const created = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Race", cadence: "once", startDate: "2026-11-10", shortfallPolicy: "partial", lines: [{ bucketId: groceries.id, mode: "add", amountMinor: 4000, priority: 1 }] }),
    }));
    const first = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    const second = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}/run?today=2026-11-10`, { method: "POST", headers: auth(home.token) }));
    const results = [first.body, second.body];
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.statusLabel === "Applied" && !result.duplicate)).toHaveLength(1);
    const occurrences = await db.query(`SELECT occurrence_key FROM fill_occurrences WHERE template_id = $1`, [created.body.id]);
    expect(occurrences).toHaveLength(1);
    const replay = await db.query(
      `INSERT INTO fill_occurrences (id, template_id, household_id, occurrence_key, status, detail_json, created_at)
       VALUES ($1,$2,$3,$4,'applied','{}',$5)
       ON CONFLICT (household_id, occurrence_key) DO NOTHING RETURNING id`,
      ["second-claim", created.body.id, home.hid, occurrences[0].occurrence_key, "2026-11-10T00:00:00.000Z"],
    );
    expect(replay).toHaveLength(0);
    const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(dash.body.budget.buckets.find((item: { bucketId: string }) => item.bucketId === groceries.id).availableMinor).toBe(4000);
    expect(dash.body.budget.readyToAssignMinor).toBe(1000);
  });

  it("edits a template without moving money, then a second scheduler pass does not allocate again", async () => {
    const api = await app();
    const home = await household(api, "edit-fill@example.com");
    const groceries = home.bucket("Groceries");
    await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    });
    const before = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    const created = await json(await api.request(`/api/households/${home.hid}/fills`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Payday", cadence: "monthly", startDate: "2026-11-10", shortfallPolicy: "partial", lines: [{ bucketId: groceries.id, mode: "add", amountMinor: 1000, priority: 1 }] }),
    }));
    const edited = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}`, {
      method: "PATCH", headers: auth(home.token),
      body: JSON.stringify({ ...created.body, name: "Payday plus", lines: [{ bucketId: groceries.id, mode: "add", amountMinor: 1500, priority: 1 }] }),
    }));
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.name).toBe("Payday plus");
    const stale = await json(await api.request(`/api/households/${home.hid}/fills/${created.body.id}`, {
      method: "PATCH", headers: auth(home.token),
      body: JSON.stringify({ ...created.body, version: 1, name: "Old screen" }),
    }));
    expect(stale.status).toBe(409);
    const mid = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(mid.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor);
    expect(await db.query(`SELECT id FROM fill_occurrences WHERE template_id = $1`, [created.body.id])).toHaveLength(0);
    const txns = await db.query(`SELECT id FROM transactions WHERE household_id = $1`, [home.hid]);
    const first = await runDueFills(db, { today: "2026-11-10", householdId: home.hid });
    const second = await runDueFills(db, { today: "2026-11-10", householdId: home.hid });
    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(await db.query(`SELECT id FROM fill_occurrences WHERE template_id = $1 AND status = 'applied'`, [created.body.id])).toHaveLength(1);
    expect(await db.query(`SELECT id FROM transactions WHERE household_id = $1`, [home.hid])).toHaveLength(txns.length);
    const after = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(after.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor - 1500);
    expect(after.body.budget.cashPoolMinor).toBe(before.body.budget.cashPoolMinor);
    expect(after.body.netWorth.netMinor).toBe(before.body.netWorth.netMinor);
  });
});

describe("fill scheduler status", () => {
  it("stays disabled until the poll interval is at least one second", () => {
    const previous = process.env.BUDGETCENTS_FILL_POLL_MS;
    delete process.env.BUDGETCENTS_FILL_POLL_MS;
    expect(fillSchedulerStatus().mode).toBe("disabled");
    expect(fillSchedulerStatus().healthy).toBe(true);
    process.env.BUDGETCENTS_FILL_POLL_MS = "50";
    expect(fillSchedulerStatus().mode).toBe("unhealthy");
    process.env.BUDGETCENTS_FILL_POLL_MS = "60000";
    expect(fillSchedulerStatus()).toMatchObject({ mode: "poll", healthy: true, intervalMs: 60000 });
    if (previous == null) delete process.env.BUDGETCENTS_FILL_POLL_MS;
    else process.env.BUDGETCENTS_FILL_POLL_MS = previous;
  });
});
