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
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function markVerified(email: string) {
  await db.query(`UPDATE users SET email_verified_at = $1 WHERE email = $2`, [new Date().toISOString(), email.toLowerCase()]);
}

async function household(api: Awaited<ReturnType<typeof app>>, email: string, name = email) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: name, householdName: name }),
  }));
  const token = registered.body.token as string;
  const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-10`, { headers: auth(token) }));
  return { token, hid, spaceId: dash.body.spaceId as string };
}

async function snapshot(api: Awaited<ReturnType<typeof app>>, home: { token: string; hid: string }) {
  const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
  const txns = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-10&limit=50`, { headers: auth(home.token) }));
  return {
    cash: dash.body.budget.cashPoolMinor as number,
    ready: dash.body.budget.readyToAssignMinor as number,
    spending: dash.body.budget.spendingMinor as number,
    net: dash.body.netWorth.netMinor as number,
    transactions: (txns.body.transactions as { id: string }[]).length,
  };
}

function planBody(accountId: string, extra: Record<string, unknown> = {}) {
  return {
    accountId,
    name: "Pay faster",
    kind: "extra",
    balanceMinor: 60_000,
    balanceDate: "2026-11-01",
    aprBps: 0,
    paymentMinor: 20_000,
    extraMinor: 0,
    startDate: "2026-11-01",
    frequency: "monthly",
    interestMethod: "monthly_nominal",
    events: [
      { monthIndex: 0, extraOneTimeMinor: 5_000 },
      { monthIndex: 0, extraOneTimeMinor: 5_000 },
    ],
    ...extra,
  };
}

describe("saved loan plans", () => {
  it("rolls paid-off minimums through the debt plan", async () => {
    const api = await app();
    const home = await household(api, "debts@example.com");
    for (const [name, balance] of [["A", 10_000], ["B", 50_000]] as const) {
      const created = await json(await api.request(`/api/households/${home.hid}/accounts`, {
        method: "POST",
        headers: auth(home.token),
        body: JSON.stringify({ spaceId: home.spaceId, name, kind: "loan", onBudget: false, openingBalanceMinor: balance, openingDate: "2026-11-01", aprBps: 0, minimumPaymentMinor: 10_000 }),
      }));
      expect(created.status).toBe(201);
    }
    const plan = await json(await api.request(`/api/households/${home.hid}/debts?strategy=snowball&extra=0&asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(plan.body.plan.months).toBe(3);
    expect(plan.body.plan.totalInterestMinor).toBe(0);
    expect(plan.body.plan.totalPrincipalMinor).toBe(60_000);
    const november = (plan.body.plan.timeline as { date: string; paymentMinor: number }[]).filter((row) => row.date === "2026-11-10");
    expect(november.reduce((sum, row) => sum + row.paymentMinor, 0)).toBe(20_000);
    const december = (plan.body.plan.timeline as { date: string; debtId: string; paymentMinor: number }[]).filter((row) => row.date === "2026-12-10");
    expect(december.reduce((sum, row) => sum + row.paymentMinor, 0)).toBe(20_000);
  });

  it("saves a plan without changing the ledger and keeps it for the same user", async () => {
    const api = await app();
    const home = await household(api, "plans@example.com");
    const cash = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 100_000, openingDate: "2026-11-01" }),
    }));
    const loan = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Car", kind: "loan", onBudget: false, openingBalanceMinor: 60_000, openingDate: "2026-11-01", aprBps: 0, minimumPaymentMinor: 20_000 }),
    }));
    const before = await snapshot(api, home);
    expect(before).toMatchObject({ cash: 100_000, ready: 100_000, spending: 0, net: 40_000, transactions: 2 });

    const preview = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/preview`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify(planBody(loan.body.id)),
    }));
    expect(preview.status).toBe(200);
    expect(preview.body.scenario.months[0].paymentMinor).toBe(30_000);
    expect(preview.body.scenario.months[0].extraMinor).toBe(10_000);
    expect(preview.body.scenario.months.at(-1).paymentMinor).toBe(10_000);
    expect(preview.body.scenario.paidOff).toBe(true);
    expect(preview.body.comparison.interestSavedMinor).toBe(0);
    expect(preview.body.planningNote).toMatch(/does not change the loan/i);

    const created = await json(await api.request(`/api/households/${home.hid}/loan-scenarios`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify(planBody(loan.body.id)),
    }));
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);
    expect(created.body.audit[0].action).toBe("create");
    expect(await snapshot(api, home)).toEqual(before);

    const listed = await json(await api.request(`/api/households/${home.hid}/loan-scenarios?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(listed.body.scenarios).toHaveLength(1);
    expect(listed.body.loans[0].balanceMinor).toBe(60_000);
    const again = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(again.body.name).toBe("Pay faster");
    expect(again.body.events).toHaveLength(2);
    expect(again.body.snapshot.stale).toBe(false);

    const edited = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(planBody(loan.body.id, { name: "Pay faster still", extraMinor: 10_000, version: 1, events: [] })),
    }));
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.scenario.months[0].paymentMinor).toBe(30_000);
    const staleEdit = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify(planBody(loan.body.id, { name: "Lost edit", version: 1, events: [] })),
    }));
    expect(staleEdit.status).toBe(409);
    expect(staleEdit.body.error).toMatch(/Reload/);
    const kept = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}`, { headers: auth(home.token) }));
    expect(kept.body.name).toBe("Pay faster still");

    const copy = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}/duplicate`, { method: "POST", headers: auth(home.token), body: "{}" }));
    expect(copy.status).toBe(201);
    expect(copy.body.name).toBe("Copy of Pay faster still");
    const archived = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${copy.body.id}/archive`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ version: copy.body.version }),
    }));
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
    const visible = await json(await api.request(`/api/households/${home.hid}/loan-scenarios`, { headers: auth(home.token) }));
    expect(visible.body.scenarios.map((item: { name: string }) => item.name)).not.toContain("Copy of Pay faster still");
    const withArchived = await json(await api.request(`/api/households/${home.hid}/loan-scenarios?archived=1`, { headers: auth(home.token) }));
    expect(withArchived.body.scenarios.map((item: { name: string }) => item.name)).toContain("Copy of Pay faster still");
    const removed = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${copy.body.id}`, {
      method: "DELETE",
      headers: auth(home.token),
      body: JSON.stringify({ version: archived.body.version }),
    }));
    expect(removed.status).toBe(200);
    const afterDelete = await json(await api.request(`/api/households/${home.hid}/loan-scenarios?archived=1`, { headers: auth(home.token) }));
    expect(afterDelete.body.scenarios.map((item: { id: string }) => item.id)).not.toContain(copy.body.id);
    expect(afterDelete.body.scenarios.map((item: { id: string }) => item.id)).toContain(created.body.id);
    const refinance = await json(await api.request(`/api/households/${home.hid}/loan-scenarios`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify(planBody(loan.body.id, {
        name: "Lower rate",
        kind: "refinance",
        events: [],
        refinance: { mode: "term", newAprBps: 0, newTermMonths: 12, upfrontFeeMinor: 1_000, financedFeeMinor: 2_000 },
      })),
    }));
    expect(refinance.status).toBe(201);
    expect(refinance.body.refinance.mode).toBe("term");
    expect(refinance.body.refinanceResult.financedFeeMinor).toBe(2_000);
    expect(refinance.body.refinanceResult.upfrontFeeMinor).toBe(1_000);
    expect(refinance.body.refinanceResult.proposed.totalPaidMinor).toBe(62_000);
    expect(refinance.body.refinanceResult.proposedTotalCostMinor).toBe(63_000);
    expect(refinance.body.refinanceResult.netBenefitMinor).toBe(-3_000);
    expect(refinance.body.refinanceResult.assumptions.join(" ")).toMatch(/does not submit a loan application/i);
    expect(await snapshot(api, home)).toEqual(before);

    const exported = await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}/export`, { headers: auth(home.token) });
    expect(exported.status).toBe(200);
    const csv = await exported.text();
    expect(csv).toMatch(/baseline/);
    expect(csv).toMatch(/not a lender payoff quote/i);

    const paid = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}/record-payment`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ cashAccountId: cash.body.id, date: "2026-11-10", principalMinor: 20_000, interestMinor: 0, feeMinor: 0, opId: "car-payment-1" }),
    }));
    expect(paid.status).toBe(200);
    expect(paid.body.duplicate).toBe(false);
    const afterPay = await snapshot(api, home);
    expect(afterPay).toMatchObject({ cash: 80_000, ready: 80_000, spending: 0, net: 40_000, transactions: 4 });
    const retry = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}/record-payment`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ cashAccountId: cash.body.id, date: "2026-11-10", principalMinor: 20_000, interestMinor: 0, feeMinor: 0, opId: "car-payment-1" }),
    }));
    expect(retry.body.duplicate).toBe(true);
    expect((await snapshot(api, home)).cash).toBe(80_000);

    const stale = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}?asOf=2026-11-10`, { headers: auth(home.token) }));
    expect(stale.body.snapshot.stale).toBe(true);
    expect(stale.body.snapshot.ledgerBalanceMinor).toBe(40_000);
    expect(stale.body.balanceMinor).toBe(60_000);
    const refreshed = await json(await api.request(`/api/households/${home.hid}/loan-scenarios/${created.body.id}/refresh?asOf=2026-11-10`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ version: stale.body.version }),
    }));
    expect(refreshed.body.balanceMinor).toBe(40_000);
    expect(refreshed.body.snapshot.stale).toBe(false);
    expect((await snapshot(api, home)).net).toBe(40_000);
  });

  it("rejects another frequency, a conflict, an unfinished payoff, and unauthorized loans", async () => {
    const api = await app();
    const owner = await household(api, "owner@example.com", "Owner household");
    const loan = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Shared loan", kind: "loan", openingBalanceMinor: 10_000, openingDate: "2026-11-01", aprBps: 1200, minimumPaymentMinor: 100 }),
    }));
    const weekly = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify(planBody(loan.body.id, { frequency: "weekly", balanceMinor: 10_000, paymentMinor: 100, aprBps: 1200, events: [] })),
    }));
    expect(weekly.status).toBe(400);
    expect(weekly.body.error).toMatch(/monthly payment/i);
    const conflict = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios/preview`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify(planBody(loan.body.id, {
        balanceMinor: 10_000,
        paymentMinor: 500,
        aprBps: 1200,
        events: [{ monthIndex: 1, aprBps: 100 }, { monthIndex: 1, aprBps: 900 }],
      })),
    }));
    expect(conflict.status).toBe(400);
    expect(conflict.body.error).toMatch(/one rate/i);
    const unfinished = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios/preview`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify(planBody(loan.body.id, { balanceMinor: 100_000, paymentMinor: 100, aprBps: 1200, events: [] })),
    }));
    expect(unfinished.body.comparison.incomplete).toBe(true);
    expect(unfinished.body.comparison.interestSavedMinor).toBeNull();
    expect(unfinished.body.scenario.paidOff).toBe(false);

    const outsider = await household(api, "outsider@example.com");
    const missing = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios`, { headers: auth(outsider.token) }));
    expect(missing.status).toBe(404);

    await markVerified("owner@example.com");
    const invite = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ email: "editor@example.com", role: "editor" }),
    }));
    const editor = await household(api, "editor@example.com");
    await markVerified("editor@example.com");
    const accepted = await json(await api.request(`/api/invitations/${invite.body.token}/accept`, { method: "POST", headers: auth(editor.token) }));
    expect(accepted.status).toBe(200);
    const privateLoan = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Private loan", kind: "loan", visibility: "private", openingBalanceMinor: 5_000, openingDate: "2026-11-01" }),
    }));
    const hidden = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios`, {
      method: "POST",
      headers: auth(editor.token),
      body: JSON.stringify(planBody(privateLoan.body.id, { balanceMinor: 5_000, events: [] })),
    }));
    expect(hidden.status).toBe(404);
    const personal = await json(await api.request(`/api/households/${owner.hid}/spaces`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ name: "Mine", kind: "personal" }),
    }));
    const personalLoan = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ spaceId: personal.body.id, name: "Personal loan", kind: "loan", openingBalanceMinor: 5_000, openingDate: "2026-11-01" }),
    }));
    const blocked = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios`, {
      method: "POST",
      headers: auth(editor.token),
      body: JSON.stringify(planBody(personalLoan.body.id, { balanceMinor: 5_000, events: [] })),
    }));
    expect(blocked.status).toBe(404);
    const visible = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios?asOf=2026-11-10`, { headers: auth(editor.token) }));
    expect((visible.body.loans as { name: string }[]).map((item) => item.name)).not.toContain("Private loan");
    expect((visible.body.loans as { name: string }[]).map((item) => item.name)).not.toContain("Personal loan");

    const readerInvite = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST",
      headers: auth(owner.token),
      body: JSON.stringify({ email: "reader@example.com", role: "readonly" }),
    }));
    const reader = await household(api, "reader@example.com");
    await markVerified("reader@example.com");
    await api.request(`/api/invitations/${readerInvite.body.token}/accept`, { method: "POST", headers: auth(reader.token) });
    const denied = await json(await api.request(`/api/households/${owner.hid}/loan-scenarios`, {
      method: "POST",
      headers: auth(reader.token),
      body: JSON.stringify(planBody(loan.body.id, { balanceMinor: 10_000, paymentMinor: 500, events: [] })),
    }));
    expect(denied.status).toBe(403);
  });
});
