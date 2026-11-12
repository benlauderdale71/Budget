import type { Hono, Context } from "hono";
import { z } from "zod";
import type { Database } from "./db.js";
import { num } from "./db.js";
import { id, nowIso, sha256 } from "./crypto.js";
import { ApiError, type Actor, assertBudget, audit, evaluateIncomePlan, loadSpace, lockHousehold, requireMember } from "./finance.js";

const input = z.object({
  spaceId: z.string().min(1),
  periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  opId: z.string().min(1).max(100),
  lines: z.array(z.object({ bucketId: z.string().min(1), plannedMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })).max(1000),
});

export function mountIncomePlan(app: Hono, db: Database, actor: (c: Context) => Promise<Actor>) {
  app.get("/api/households/:hid/income-plan", async (c) => {
    const me = await actor(c);
    return c.json(await db.tx(async () => {
      // Pair the revision and lines in one snapshot, serialized with every save.
      await db.query(`SELECT id FROM households WHERE id = $1 FOR SHARE`, [c.req.param("hid")]);
      const loaded = await loadSpace(db, me, c.req.param("hid"), c.req.query("spaceId"), c.req.query("asOf"));
      const periodKey = loaded.budget.periodKey;
      const rows = await db.query(`SELECT revision FROM income_plan_revisions WHERE household_id = $1 AND space_id = $2 AND period_key = $3`, [c.req.param("hid"), loaded.spaceId, periodKey]);
      const lines = (loaded.input.planLines ?? []).filter((line) => line.periodKey === periodKey);
      const expected = (loaded.input.schedules ?? []).filter((s) => s.direction === "inflow" && !s.paused).reduce((sum, s) => sum + s.amountMinor, 0);
      return { ...evaluateIncomePlan(lines, expected, periodKey), lines, periodKey, spaceId: loaded.spaceId, revision: num(rows[0]?.revision) };
    }));
  });

  app.put("/api/households/:hid/income-plan", async (c) => {
    const me = await actor(c);
    const hid = c.req.param("hid");
    assertBudget(await requireMember(db, me.id, hid));
    const body = input.parse(await c.req.json());
    if (new Set(body.lines.map((line) => line.bucketId)).size !== body.lines.length) throw new ApiError(400, "Include each category only once.");
    if (!Number.isSafeInteger(body.lines.reduce((sum, line) => sum + line.plannedMinor, 0))) throw new ApiError(400, "The planned total is too large.");
    const lines = [...body.lines].sort((a, b) => a.bucketId.localeCompare(b.bucketId));
    const fingerprint = sha256(JSON.stringify({ ...body, lines }));
    return c.json(await db.tx(async () => {
      await lockHousehold(db, hid);
      // Membership may have changed while this request waited for the lock.
      assertBudget(await requireMember(db, me.id, hid));
      const spaces = await db.query(`SELECT kind, owner_user_id FROM spaces WHERE id = $1 AND household_id = $2`, [body.spaceId, hid]);
      const space = spaces[0];
      if (!space || (space.kind === "personal" && space.owner_user_id != null && space.owner_user_id !== me.id)) throw new ApiError(404, "Not found");
      const replay = await db.query(`SELECT fingerprint, response_json FROM income_plan_operations WHERE household_id = $1 AND user_id = $2 AND op_id = $3`, [hid, me.id, body.opId]);
      if (replay[0]) {
        if (replay[0].fingerprint !== fingerprint) throw new ApiError(409, "This save was already used for different income-plan changes.");
        return { ...JSON.parse(String(replay[0].response_json)), duplicate: true };
      }
      const revisions = await db.query(`SELECT revision FROM income_plan_revisions WHERE household_id = $1 AND space_id = $2 AND period_key = $3`, [hid, body.spaceId, body.periodKey]);
      const revision = num(revisions[0]?.revision);
      if (revision !== body.expectedRevision) throw new ApiError(409, "Someone else changed the income plan. Your draft was not saved. Load the latest plan before trying again.");
      for (const line of lines) {
        const buckets = await db.query(`SELECT id FROM buckets WHERE id = $1 AND household_id = $2 AND space_id = $3 AND kind = 'expense' AND archived = 0 AND system_role IS NULL`, [line.bucketId, hid, body.spaceId]);
        if (!buckets.length) throw new ApiError(400, "Choose an active expense category in this space.");
      }
      await db.query(`DELETE FROM plan_lines WHERE household_id = $1 AND space_id = $2 AND period_key = $3`, [hid, body.spaceId, body.periodKey]);
      for (const line of lines.filter((line) => line.plannedMinor !== 0)) {
        await db.query(`INSERT INTO plan_lines (id, household_id, space_id, bucket_id, period_key, planned_minor) VALUES ($1,$2,$3,$4,$5,$6)`, [id(), hid, body.spaceId, line.bucketId, body.periodKey, line.plannedMinor]);
      }
      await db.query(`INSERT INTO income_plan_revisions (household_id, space_id, period_key, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (household_id, space_id, period_key) DO UPDATE SET revision = EXCLUDED.revision`, [hid, body.spaceId, body.periodKey, revision + 1]);
      const response = { ok: true, revision: revision + 1, duplicate: false, note: "This plan does not fund envelopes until the money arrives and is assigned." };
      await db.query(`INSERT INTO income_plan_operations (household_id, user_id, op_id, fingerprint, response_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [hid, me.id, body.opId, fingerprint, JSON.stringify(response), nowIso()]);
      await audit(db, hid, me.id, "income_plan", "Updated the income plan", "space", body.spaceId, space.kind === "personal" ? { visibility: "private", ownerUserId: String(space.owner_user_id) } : undefined);
      return response;
    }));
  });
}
