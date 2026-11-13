import type { Context, Hono } from "hono";
import { z } from "zod";
import { realizeFifo, type TaxLot } from "@budgetcents/domain";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { id, nowIso, sha256 } from "./crypto.js";
import { ApiError, type Actor, assertWrite, audit, canSeeAccount, lockHousehold, requireMember } from "./finance.js";

const integer = z.number().int().safe().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, "Enter a valid date.");
function shares(value: string) {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new ApiError(409, "The holding quantity must have at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const result = Number(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0")));
  if (!Number.isSafeInteger(result)) throw new ApiError(409, "The holding quantity is too large.");
  return result;
}
function quantity(value: number) { return `${Math.floor(value / 1000000)}.${String(value % 1000000).padStart(6, "0")}`; }

export function mountInvestmentLots(app: Hono, db: Database, actor: (c: Context) => Promise<Actor>) {
  async function visible(userId: string, hid: string) {
    await requireMember(db, userId, hid);
    return (await db.query(`SELECT h.*, a.visibility, a.owner_user_id, s.kind AS space_kind, s.owner_user_id AS space_owner FROM holdings h JOIN accounts a ON a.id = h.account_id JOIN spaces s ON s.id = a.space_id WHERE h.household_id = $1 AND a.household_id = $1`, [hid])).filter((h) => canSeeAccount(userId, { visibility: String(h.visibility), owner_user_id: str(h.owner_user_id) ?? null }) && !(h.space_kind === "personal" && h.space_owner && h.space_owner !== userId));
  }
  async function holding(userId: string, hid: string, holdingId: string) {
    const row = (await visible(userId, hid)).find((h) => h.id === holdingId);
    if (!row) throw new ApiError(404, "Holding not found.");
    return row;
  }
  async function write(userId: string, hid: string) { await lockHousehold(db, hid); assertWrite(await requireMember(db, userId, hid)); }
  async function increment(holdingId: string) { await db.query(`UPDATE holdings SET lot_revision = lot_revision + 1 WHERE id = $1`, [holdingId]); }
  app.get("/api/households/:hid/lots", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    return c.json(await db.tx(async () => {
      const holdings = await visible(me.id, hid); const ids = new Map(holdings.map((h) => [String(h.id), h]));
      const rows = await db.query(`SELECT l.* FROM lots l JOIN holdings h ON h.id = l.holding_id WHERE h.household_id = $1 ORDER BY l.acquired, l.id`, [hid]);
      const lots = rows.filter((l) => ids.has(String(l.holding_id))).map((l) => ({ id: l.id, holdingId: l.holding_id, symbol: ids.get(String(l.holding_id))!.symbol, currency: ids.get(String(l.holding_id))!.currency, quantityMicro: Number(l.quantity), costBasisMinor: l.cost_basis_minor == null ? null : num(l.cost_basis_minor), acquired: l.acquired, revision: Number(ids.get(String(l.holding_id))!.lot_revision) }));
      const saved = await db.query(`SELECT * FROM lot_sales WHERE household_id = $1 ORDER BY sold_on DESC, created_at DESC`, [hid]);
      return { lots, revisions: Object.fromEntries(holdings.map((h) => [String(h.id), Number(h.lot_revision)])), missingBasis: lots.filter((l) => l.costBasisMinor == null).length, sales: saved.filter((s) => ids.has(String(s.holding_id))).map((s) => ({ id: s.id, holdingId: s.holding_id, symbol: ids.get(String(s.holding_id))!.symbol, soldOn: s.sold_on, ...JSON.parse(String(s.result_json)) })), note: "Lots describe the holding already recorded. Adding a lot does not add shares. A recorded sale reduces the holding and retains its realized-gain history; it does not post the sale proceeds to your cash account." };
    }));
  });
  app.post("/api/households/:hid/lots", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const body = z.object({ holdingId: z.string(), quantityMicro: integer.positive(), costBasisMinor: integer.nullable(), acquired: date, opId: z.string().min(1).max(100) }).parse(await c.req.json());
    return c.json(await db.tx(async () => {
      await write(me.id, hid); const h = await holding(me.id, hid, body.holdingId);
      const hash = sha256(JSON.stringify(body));
      const previous = (await db.query(`SELECT request_hash, result_json FROM lot_create_operations WHERE household_id = $1 AND user_id = $2 AND op_id = $3`, [hid, me.id, body.opId]))[0];
      if (previous) {
        if (previous.request_hash !== hash) throw new ApiError(409, "This operation was already used for another lot.");
        return { ...JSON.parse(String(previous.result_json)), duplicate: true };
      }
      const lots = await db.query(`SELECT quantity FROM lots WHERE holding_id = $1`, [h.id]);
      if (lots.reduce((n, l) => n + BigInt(String(l.quantity)), BigInt(body.quantityMicro)) > BigInt(shares(String(h.quantity)))) throw new ApiError(409, "These lots would exceed the shares in the holding. Correct the holding first.");
      const lotId = id();
      await db.query(`INSERT INTO lots (id, holding_id, quantity, cost_basis_minor, acquired) VALUES ($1,$2,$3,$4,$5)`, [lotId, h.id, String(body.quantityMicro), body.costBasisMinor, body.acquired]);
      await increment(String(h.id));
      await audit(db, hid, me.id, "lot.create", "Added a tax lot. The register was not changed.", "account", String(h.account_id));
      const result = { id: lotId, revision: Number(h.lot_revision) + 1 };
      await db.query(`INSERT INTO lot_create_operations (household_id,user_id,op_id,request_hash,result_json) VALUES ($1,$2,$3,$4,$5)`, [hid, me.id, body.opId, hash, JSON.stringify(result)]);
      return { ...result, duplicate: false };
    }), 201);
  });
  app.patch("/api/households/:hid/lots/:id", async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const body = z.object({ costBasisMinor: integer.nullable(), expectedRevision: integer }).parse(await c.req.json());
    return c.json(await db.tx(async () => {
      await write(me.id, hid);
      const lot = (await db.query(`SELECT * FROM lots WHERE id = $1`, [c.req.param("id")]))[0];
      if (!lot) throw new ApiError(404, "Lot not found.");
      const h = await holding(me.id, hid, String(lot.holding_id));
      if (Number(h.lot_revision) !== body.expectedRevision) throw new ApiError(409, "The lots changed. Reload them before changing the basis.");
      await db.query(`UPDATE lots SET cost_basis_minor = $1 WHERE id = $2`, [body.costBasisMinor, lot.id]);
      await increment(String(h.id));
      await audit(db, hid, me.id, "lot.basis", "Updated a lot's basis. The register was not changed.", "account", String(h.account_id));
      return { ok: true, revision: body.expectedRevision + 1 };
    }));
  });
  for (const operation of ["preview", "sell"] as const) app.post(`/api/households/:hid/lots/${operation}`, async (c) => {
    const me = await actor(c); const hid = c.req.param("hid");
    const body = z.object({ holdingId: z.string(), quantityMicro: integer.positive(), proceedsMinor: integer, soldOn: date, expectedRevision: integer, opId: z.string().min(1).max(100) }).parse(await c.req.json());
    return c.json(await db.tx(async () => {
      await write(me.id, hid); const h = await holding(me.id, hid, body.holdingId);
      const hash = sha256(JSON.stringify(body));
      const previous = (await db.query(`SELECT request_hash, result_json FROM lot_sales WHERE household_id = $1 AND user_id = $2 AND op_id = $3`, [hid, me.id, body.opId]))[0];
      if (previous) {
        if (previous.request_hash !== hash) throw new ApiError(409, "This operation was already used for a different sale.");
        return { ...JSON.parse(String(previous.result_json)), duplicate: true };
      }
      if (Number(h.lot_revision) !== body.expectedRevision) throw new ApiError(409, "The lots changed. Reload and review this sale again.");
      const rows = await db.query(`SELECT * FROM lots WHERE holding_id = $1 ORDER BY acquired, id`, [h.id]);
      if (rows.some((r) => r.cost_basis_minor == null)) throw new ApiError(400, "Add the missing cost basis before recording this sale. Missing basis is not zero.");
      const lots: TaxLot[] = rows.map((r) => ({ id: String(r.id), quantityMicro: Number(r.quantity), costBasisMinor: num(r.cost_basis_minor), acquired: String(r.acquired) }));
      if (body.quantityMicro > shares(String(h.quantity))) throw new ApiError(409, "The sale exceeds the holding's shares.");
      const result = realizeFifo(lots, body.quantityMicro, body.proceedsMinor);
      if (result.sales.some((s) => lots.find((l) => l.id === s.lotId)!.acquired > body.soldOn)) throw new ApiError(400, "A sale cannot precede acquisition of its lots.");
      const basis = result.sales.reduce((n, s) => n + s.basisMinor, 0);
      if (operation === "preview") return { gainMinor: result.gainMinor, basisMinor: basis, currency: String(h.currency), sales: result.sales, note: "Preview only. No holding, lot, or cash transaction was changed." };
      const remaining = new Map(result.remaining.map((l) => [l.id, l]));
      for (const lot of lots) {
        const rest = remaining.get(lot.id);
        if (rest) await db.query(`UPDATE lots SET quantity = $1, cost_basis_minor = $2 WHERE id = $3`, [String(rest.quantityMicro), rest.costBasisMinor, rest.id]);
        else await db.query(`DELETE FROM lots WHERE id = $1`, [lot.id]);
      }
      const holdingBasis = h.cost_basis_minor == null || num(h.cost_basis_minor) < basis ? null : num(h.cost_basis_minor) - basis;
      await db.query(`UPDATE holdings SET quantity = $1, cost_basis_minor = $2, lot_revision = lot_revision + 1 WHERE id = $3`, [quantity(shares(String(h.quantity)) - body.quantityMicro), holdingBasis, h.id]);
      const saleId = id();
      const saved = { id: saleId, currency: String(h.currency), gainMinor: result.gainMinor, proceedsMinor: body.proceedsMinor, basisMinor: basis, quantityMicro: body.quantityMicro, sales: result.sales.map((s) => ({ ...s, acquired: lots.find((l) => l.id === s.lotId)!.acquired })), revision: Number(h.lot_revision) + 1, note: "Sale history saved and holding reduced. Record the matching proceeds once in the cash ledger separately. This is not a tax return." };
      await db.query(`INSERT INTO lot_sales (id, household_id, holding_id, user_id, op_id, request_hash, sold_on, result_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [saleId, hid, h.id, me.id, body.opId, hash, body.soldOn, JSON.stringify(saved), nowIso()]);
      await audit(db, hid, me.id, "lot.sell", "Recorded a lot sale. No cash transaction was created.", "account", String(h.account_id));
      return { ...saved, duplicate: false };
    }));
  });
}
