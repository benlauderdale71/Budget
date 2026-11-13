import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { migrate, openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
afterEach(async () => { await db?.close(); });

async function fixture() {
  db = await openMemoryDatabase();
  const app = createApp(db);
  async function call(path: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  async function register(name: string, householdName?: string) {
    const result = await call("/api/auth/register", "", { email: `${name}@example.com`, password: "correct-horse", displayName: name, householdName });
    expect(result.status).toBe(200);
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), result.body.user.id]);
    return { id: result.body.user.id as string, token: result.body.token as string };
  }
  const owner = await register("Owner", "Ownership test");
  const homes = await call("/api/households", owner.token);
  const hid = homes.body.households[0].id as string;
  const base = `/api/households/${hid}`;
  const dash = await call(`${base}/dashboard?asOf=2026-11-20`, owner.token);
  const spaceId = dash.body.spaceId;
  const coach = await register("Coach");
  const editor = await register("Editor");
  const reader = await register("Reader");
  for (const [person, role] of [[coach, "coach"], [editor, "editor"], [reader, "readonly"]] as const) {
    const invitation = await call(`${base}/invitations`, owner.token, { email: `${person === coach ? "Coach" : person === editor ? "Editor" : "Reader"}@example.com`, role });
    expect(invitation.status).toBe(201);
    expect((await call(`/api/invitations/${invitation.body.token}/accept`, person.token, {})).status).toBe(200);
  }
  const joint = await call(`${base}/accounts`, owner.token, { spaceId, name: "Joint", kind: "checking", openingBalanceMinor: 10000, openingDate: "2026-11-01" });
  const secret = await call(`${base}/accounts`, owner.token, { spaceId, name: "Secret", kind: "checking", visibility: "private", openingBalanceMinor: 70000, openingDate: "2026-11-01" });
  async function purchase(payee: string, accountId = joint.body.id, token = owner.token, amountMinor = -250) {
    const saved = await call(`${base}/transactions`, token, { spaceId, accountId, date: "2026-11-02", amountMinor, type: "expense", payee, splits: [] });
    expect(saved.status).toBe(201);
    return saved.body.id as string;
  }
  const expense = await purchase("Market");
  const privateExpense = await purchase("Hidden Payee", secret.body.id);
  const editorExpense = await purchase("Editor Purchase", joint.body.id, editor.token, -500);
  async function row(id = expense, token = owner.token) {
    const result = await call(`${base}/transactions?asOf=2026-11-20&ids=${id}`, token);
    return result.body.transactions[0];
  }
  async function money() {
    const { body } = await call(`${base}/dashboard?asOf=2026-11-20`, owner.token);
    return [body.budget.readyToAssignMinor, body.budget.spendingMinor, body.budget.incomeMinor, body.netWorth.netMinor, body.budget.identityDifferenceMinor];
  }
  return { call, base, hid, owner, coach, editor, reader, expense, privateExpense, editorExpense, row, money };
}

describe("ownership views and reviewer responsibility", () => {
  it("filters after authorization, persists filters, and never reallocates the plan", async () => {
    const f = await fixture();
    const before = await f.money();
    const old = await f.row();
    const shared = await f.call(`${f.base}/transactions/${f.expense}/ownership`, f.owner.token, { ownerUserId: null, version: old.version });
    expect(shared.status).toBe(200);
    expect((await f.call(`${f.base}/transactions/${f.privateExpense}/ownership`, f.owner.token, { ownerUserId: f.coach.id, version: 1 })).status).toBe(404);
    expect((await f.call(`${f.base}/transactions/${f.privateExpense}/ownership`, f.owner.token, { ownerUserId: null, version: 1 })).status).toBe(200);
    const ours = await f.call(`${f.base}/transactions?asOf=2026-11-20&ownership=ours`, f.coach.token);
    expect(ours.body.transactions.map((t: any) => t.id)).toEqual([f.expense]);
    const yours = await f.call(`${f.base}/transactions?asOf=2026-11-20&ownership=yours&personId=${f.owner.id}`, f.coach.token);
    expect(JSON.stringify(yours.body)).not.toMatch(/Hidden Payee|Secret/);
    expect(yours.body.transactions.some((t: any) => t.id === f.privateExpense)).toBe(false);
    const mine = await f.call(`${f.base}/transactions?asOf=2026-11-20&ownership=mine`, f.editor.token);
    expect(mine.body.transactions.map((t: any) => t.id)).toEqual([f.editorExpense]);
    const summary = await f.call(`${f.base}/ownership-summary?asOf=2026-11-20&ownership=ours`, f.coach.token);
    expect(summary.body.spendingMinor).toBe(250);
    expect(summary.body.incomeMinor).toBe(0);
    expect((await f.call(`${f.base}/ownership-summary?ownership=yours&personId=outsider`, f.coach.token)).status).toBe(400);
    expect((await f.call(`${f.base}/transactions?ownership=garbage`, f.owner.token)).status).toBe(400);
    const saved = await f.call(`${f.base}/views`, f.reader.token, { name: "Ours to review", query: { ownership: "ours", reviewer: "mine", review: "needs_review" } });
    expect(saved.status).toBe(201);
    const views = await f.call(`${f.base}/views`, f.reader.token);
    expect(views.body.views[0].query).toMatchObject({ ownership: "ours", reviewer: "mine" });
    expect(await f.money()).toEqual(before);
    expect((await f.call(`${f.base}/collaboration/people`, f.reader.token)).body.people).toHaveLength(4);
    expect(JSON.stringify((await f.call(`${f.base}/collaboration/people`, f.reader.token)).body)).not.toContain("@example.com");
  });

  it("assigns, resolves, and reopens with conflicts and permanent audit history", async () => {
    const f = await fixture();
    const before = await f.money();
    const assign = (version: number, reviewerUserId: string | null, token = f.owner.token, id = f.expense) => f.call(`${f.base}/transactions/${id}/review-assignment`, token, { version, reviewerUserId });
    const concurrent = await Promise.all([assign(1, f.coach.id), assign(1, f.coach.id)]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await assign(1, f.editor.id)).status).toBe(409);
    expect((await assign(2, f.reader.id)).status).toBe(400);
    expect((await assign(2, "outsider")).status).toBe(400);
    expect((await assign(2, f.editor.id, f.reader.token)).status).toBe(403);
    expect((await assign(1, f.coach.id, f.owner.token, f.privateExpense)).status).toBe(404);
    const queue = await f.call(`${f.base}/transactions?reviewer=mine&review=needs_review&asOf=2026-11-20`, f.coach.token);
    expect(queue.body.transactions.map((t: any) => t.id)).toEqual([f.expense]);
    expect((await f.call(`${f.base}/transactions/${f.expense}/review`, f.reader.token, { version: 2, reviewStatus: "reviewed" })).status).toBe(403);
    expect((await f.call(`${f.base}/transactions/${f.expense}/review`, f.coach.token, { version: 2, reviewStatus: "reviewed" })).status).toBe(200);
    const done = await f.row();
    expect(done.reviewerUserId).toBe(f.coach.id);
    expect(done.reviewResolvedBy).toBe(f.coach.id);
    expect(done.reviewResolvedAt).toBeTruthy();
    expect((await f.call(`${f.base}/transactions?reviewer=mine&review=needs_review&asOf=2026-11-20`, f.coach.token)).body.total).toBe(0);
    expect((await f.call(`${f.base}/transactions/${f.expense}/review`, f.coach.token, { version: 3, reviewStatus: "needs_review" })).status).toBe(200);
    expect((await f.row()).reviewResolvedAt).toBeUndefined();
    const events = await db.query(`SELECT action FROM audit_events WHERE entity_id = $1`, [f.expense]);
    expect(events.filter((e) => e.action === "transaction.review")).toHaveLength(2);
    expect(events.some((e) => e.action === "transaction.review_assignment")).toBe(true);
    await migrate(db);
    expect((await f.row()).reviewerUserId).toBe(f.coach.id);
    expect(await f.money()).toEqual(before);
  });

  it("releases pending reviews after downgrade, removal, and leaving", async () => {
    const f = await fixture();
    const before = await f.money();
    async function assign(personId: string) {
      const txn = await f.row();
      expect((await f.call(`${f.base}/transactions/${f.expense}/review-assignment`, f.owner.token, { reviewerUserId: personId, version: txn.version })).status).toBe(200);
    }
    await assign(f.coach.id);
    expect((await f.call(`${f.base}/members/${f.coach.id}`, f.owner.token, { role: "readonly" }, "PATCH")).status).toBe(200);
    expect((await f.row()).reviewerUserId).toBeUndefined();
    const changed = await f.row();
    expect((await f.call(`${f.base}/transactions/${f.expense}/review`, f.coach.token, { version: changed.version, reviewStatus: "reviewed" })).status).toBe(403);
    await assign(f.editor.id);
    expect((await f.call(`${f.base}/leave`, f.editor.token, {})).status).toBe(200);
    expect((await f.row()).reviewerUserId).toBeUndefined();
    expect((await f.call(`${f.base}/members/${f.coach.id}`, f.owner.token, { role: "coach" }, "PATCH")).status).toBe(200);
    await assign(f.coach.id);
    expect((await f.call(`${f.base}/members/${f.coach.id}`, f.owner.token, undefined, "DELETE")).status).toBe(200);
    expect((await f.row()).reviewerUserId).toBeUndefined();
    expect(await f.money()).toEqual(before);
  });

  it("keeps review resolution and versions consistent for financial edit and bulk clients", async () => {
    const f = await fixture();
    const before = await f.money();
    expect((await f.call(`${f.base}/transactions/${f.expense}/review-assignment`, f.owner.token, { reviewerUserId: f.coach.id, version: 1 })).status).toBe(200);
    expect((await f.call(`${f.base}/transactions/${f.expense}`, f.owner.token, { version: 2, reviewStatus: "reviewed" }, "PATCH")).status).toBe(200);
    const resolved = await f.row();
    expect(resolved.reviewResolvedBy).toBe(f.owner.id);
    expect(resolved.reviewerUserId).toBe(f.coach.id);
    expect((await f.call(`${f.base}/transactions/bulk`, f.owner.token, { ids: [f.expense], reviewStatus: "needs_review" })).status).toBe(200);
    const reopened = await f.row();
    expect(reopened.version).toBe(resolved.version + 1);
    expect(reopened.reviewResolvedAt).toBeUndefined();
    expect(reopened.reviewerUserId).toBe(f.coach.id);
    expect((await f.call(`${f.base}/transactions/${f.expense}/review-assignment`, f.owner.token, { reviewerUserId: null, version: resolved.version })).status).toBe(409);
    expect(await f.money()).toEqual(before);
  });
});
