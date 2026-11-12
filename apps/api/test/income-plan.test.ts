import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
afterEach(async () => { await db?.close(); });

async function fixture() {
  db = await openMemoryDatabase();
  const app = createApp(db);
  const register = async (email: string) => {
    const result = await (await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "test-income-plan-password", displayName: email, householdName: email }) })).json();
    return { userId: result.user.id as string, headers: { authorization: `Bearer ${result.token}`, "content-type": "application/json" } };
  };
  const owner = await register("income-owner@example.test");
  const editor = await register("income-editor@example.test");
  const hid = (await (await app.request("/api/households", { headers: owner.headers })).json()).households[0].id;
  await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'editor',$3)`, [hid, editor.userId, new Date().toISOString()]);
  const dash = await (await app.request(`/api/households/${hid}/dashboard?asOf=2026-11-12&evaluate=0`, { headers: owner.headers })).json();
  const bucket = dash.buckets.find((b: { name: string }) => b.name === "Groceries").id;
  const route = `/api/households/${hid}/income-plan`;
  const body = { spaceId: dash.spaceId, periodKey: "2026-11", expectedRevision: 0, opId: "income-plan-1", lines: [{ bucketId: bucket, plannedMinor: 1234 }] };
  const save = (payload: unknown, headers = owner.headers) => app.request(route, { method: "PUT", headers, body: JSON.stringify(payload) });
  const read = async () => (await app.request(`${route}?asOf=2026-11-12`, { headers: owner.headers })).json();
  return { app, hid, owner, editor, body, save, read, dash };
}

describe("atomic income plans", () => {
  it("serializes concurrent first saves, rejects stale writes and replays only the identical operation", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.save(f.body), f.save({ ...f.body, opId: "editor-first", lines: [{ ...f.body.lines[0], plannedMinor: 9999 }] }, f.editor.headers)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const saved = await f.read();
    expect(saved.revision).toBe(1);
    const winner = a.status === 200 ? f.body : { ...f.body, opId: "editor-first", lines: [{ ...f.body.lines[0], plannedMinor: 9999 }] };
    const winnerHeaders = a.status === 200 ? f.owner.headers : f.editor.headers;
    const replay = await f.save(winner, winnerHeaders);
    expect(await replay.json()).toMatchObject({ revision: 1, duplicate: true });
    expect((await f.save({ ...winner, lines: [] }, winnerHeaders)).status).toBe(409);
    expect((await f.save({ ...f.body, opId: "stale", lines: [] })).status).toBe(409);
    expect(await f.read()).toEqual(saved);
    const after = await (await f.app.request(`/api/households/${f.hid}/dashboard?asOf=2026-11-12&evaluate=0`, { headers: f.owner.headers })).json();
    expect(after.budget).toEqual(f.dash.budget);
    expect(after.netWorth).toEqual(f.dash.netWorth);
  });

  it("rolls back line replacement, revision, receipt and audit together when a later write fails", async () => {
    const f = await fixture();
    expect((await f.save(f.body)).status).toBe(200);
    const before = await f.read();
    const query = db.query;
    db.query = ((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO audit_events")) throw new Error("simulated audit storage failure");
      return query(sql, params);
    }) as Database["query"];
    const payload = { ...f.body, expectedRevision: 1, opId: "retry-after-failure", lines: [] };
    expect((await f.save(payload)).status).toBe(500);
    db.query = query;
    expect(await f.read()).toEqual(before);
    expect((await f.save(payload)).status).toBe(200);
    expect(await f.read()).toMatchObject({ revision: 2, lines: [] });
  });

  it("requires a revision and valid unique categories, and rechecks downgraded or removed members", async () => {
    const f = await fixture();
    const { expectedRevision: _, ...legacy } = f.body;
    expect((await f.save(legacy)).status).toBe(400);
    expect((await f.save({ ...f.body, lines: [...f.body.lines, ...f.body.lines] })).status).toBe(400);
    expect((await f.save({ ...f.body, lines: [{ bucketId: "missing", plannedMinor: 0 }] })).status).toBe(400);
    expect((await f.save(f.body, f.editor.headers)).status).toBe(200);
    const saved = await f.read();
    await db.query(`UPDATE memberships SET role = 'readonly' WHERE household_id = $1 AND user_id = $2`, [f.hid, f.editor.userId]);
    expect((await f.save(f.body, f.editor.headers)).status).toBe(403);
    await db.query(`DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`, [f.hid, f.editor.userId]);
    expect((await f.save({ ...f.body, expectedRevision: 1 }, f.editor.headers)).status).toBe(404);
    expect(await f.read()).toEqual(saved);
  });

  it("isolates periods and personal spaces, including audit visibility", async () => {
    const f = await fixture();
    expect((await f.save(f.body)).status).toBe(200);
    expect((await f.save({ ...f.body, opId: "next-month", periodKey: "2026-12", lines: [] })).status).toBe(200);
    expect((await f.read()).lines).toHaveLength(1);
    const created = await (await f.app.request(`/api/households/${f.hid}/spaces`, { method: "POST", headers: f.owner.headers, body: JSON.stringify({ name: "Private", kind: "personal" }) })).json();
    expect((await f.save({ ...f.body, spaceId: created.id, opId: "private", lines: [] })).status).toBe(200);
    expect((await f.save({ ...f.body, spaceId: created.id, opId: "not-mine", lines: [] }, f.editor.headers)).status).toBe(404);
    const rows = await db.query(`SELECT visibility, owner_user_id FROM audit_events WHERE action = 'income_plan' AND entity_id = $1`, [created.id]);
    expect(rows[0]).toMatchObject({ visibility: "private", owner_user_id: f.owner.userId });
  });
});
