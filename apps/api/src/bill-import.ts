import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { billImportSignature, isIsoDate, parseBillGrids, parseSingleBill, type BillImportRow } from "@budgetcents/domain";
import { id, nowIso, sha256 } from "./crypto.js";
import type { Database } from "./db.js";
import { ApiError, assertBudget, canSeeAccount, lockHousehold, requireMember, type Actor } from "./finance.js";
import { readBillDocument } from "./bill-document-reader.js";

interface Hooks {
  actor(c: Context): Promise<Actor>;
  assertSpace(userId: string, hid: string, spaceId: string): Promise<unknown>;
  mustAccount(userId: string, hid: string, accountId: string): Promise<Record<string, unknown>>;
  createBill(me: Actor, hid: string, raw: unknown): Promise<{ id: string }>;
}
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(value => Number(value.slice(0,4)) >= 1900 && Number(value.slice(0,4)) <= 2200);
const rowSchema = z.object({
  key: z.string().max(100), name: z.string().trim().min(1).max(120),
  kind: z.enum(["bill", "subscription", "income"]),
  amountMinor: z.number().int().nonnegative().max(999999999999),
  nextDate: z.string().refine(isIsoDate, "Enter a valid due date."),
  cadence: z.enum(["once", "weekly", "biweekly", "monthly", "every_2_months", "every_3_months", "every_6_months", "annual"]),
  anchorDay: z.number().int().min(1).max(31).optional(),
  accountId: z.string().max(100).optional(), bucketId: z.string().max(100).optional(),
  paymentMethod: z.string().max(300), paidReference: z.string().max(300), notes: z.string().max(4000),
  balanceOwedMinor: z.number().int().min(-999999999999).max(999999999999).optional(),
});
const confirmSchema = z.object({ reviewed: z.literal(true), rows: z.array(rowSchema).min(1).max(500) });
type Draft = { id: string; household_id: string; user_id: string; space_id: string; account_id: string | null; preview_json: string; result_json: string | null; fingerprint: string | null; expires_at: string };

export function mountBillImport(app: Hono, db: Database, hooks: Hooks) {
  const base = "/api/households/:hid/bill-imports";
  app.use(`${base}/*`, bodyLimit({ maxSize: 9_000_000, onError: c => c.json({ error: "Choose a file no larger than 8 MB." }, 413) }));
  app.use(base, bodyLimit({ maxSize: 9_000_000, onError: c => c.json({ error: "Choose a file no larger than 8 MB." }, 413) }));

  async function account(me: Actor, hid: string, spaceId: string, accountId?: string) {
    if (!accountId) return;
    const row = await hooks.mustAccount(me.id, hid, accountId);
    if (String(row.space_id) !== spaceId || Number(row.archived) === 1) throw new ApiError(400, "Choose an active account in this budget space.");
  }
  async function signatures(me: Actor, hid: string, spaceId: string) {
    const rows = await db.query(`SELECT s.*, d.anchor_day, a.visibility, a.owner_user_id AS account_owner
      FROM schedules s LEFT JOIN schedule_details d ON d.schedule_id=s.id LEFT JOIN accounts a ON a.id=s.account_id
      WHERE s.household_id=$1 AND s.space_id=$2 AND COALESCE(d.archived,0)=0`, [hid, spaceId]);
    return new Set(rows.filter(row => !row.account_id || canSeeAccount(me.id, { visibility: row.visibility, owner_user_id: row.account_owner } as Parameters<typeof canSeeAccount>[1])).map(row => billImportSignature({ name: String(row.name), kind: String(row.type), amountMinor: Number(row.amount_minor), cadence: String(row.cadence), nextDate: String(row.next_date), anchorDay: row.anchor_day == null ? undefined : Number(row.anchor_day), accountId: row.account_id == null ? undefined : String(row.account_id) })));
  }
  async function draft(me: Actor, hid: string, draftId: string): Promise<Draft> {
    await requireMember(db, me.id, hid);
    const [row] = await db.query<Draft>(`SELECT * FROM bill_import_drafts WHERE id=$1 AND household_id=$2 AND user_id=$3`, [draftId, hid, me.id]);
    if (!row || row.expires_at < nowIso()) throw new ApiError(404, "This private import preview is no longer available. Upload the file again.");
    await hooks.assertSpace(me.id, hid, row.space_id);
    await account(me, hid, row.space_id, row.account_id ?? undefined);
    return row;
  }

  app.post(base, async c => {
    const me = await hooks.actor(c), hid = c.req.param("hid");
    const member = await requireMember(db, me.id, hid);
    assertBudget(member);
    if (["JPY","KRW","VND","BHD","KWD","OMR","IQD"].includes(member.currency)) throw new ApiError(400, "Bill-file amounts currently support currencies with two decimal places. Add these schedules manually in Bills.");
    const form = await c.req.parseBody();
    const spaceId = z.string().min(1).parse(form.spaceId), month = monthSchema.parse(form.month);
    const accountId = typeof form.accountId === "string" ? form.accountId : "";
    await hooks.assertSpace(me.id, hid, spaceId);
    await account(me, hid, spaceId, accountId);
    const file = form.file;
    if (!file || typeof file === "string" || Array.isArray(file)) throw new ApiError(400, "Choose a bill file to upload.");
    const recent = await db.query(`SELECT id FROM bill_import_drafts WHERE user_id=$1 AND created_at>$2`, [me.id, new Date(Date.now()-3600000).toISOString()]);
    if (recent.length >= 20) throw new ApiError(429, "The hourly bill-upload limit was reached. Try again later.");
    let document;
    try { document = await readBillDocument(Buffer.from(await file.arrayBuffer()), file.name); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : "The bill document could not be read."); }
    if (document.text.length > 600000) throw new ApiError(400, "This file contains too much text. Upload a smaller bill list.");
    let rows: BillImportRow[];
    try {
      rows = document.grids.flatMap((grid,index) => {
        let found=parseBillGrids([grid],month);
        if(!found.length) found=parseSingleBill(grid.rows.map(row=>row.join("\t")).join("\n"),month);
        if(!found.length) document.warnings.push(`${grid.name}: no bill rows were recognized. Check its extracted text and add missing items manually.`);
        return found.map(row=>({...row,key:`${index}:${row.key}`,location:row.location==="Invoice"?`${grid.name}, invoice`:row.location}));
      });
      if(rows.length>500) throw new Error("This document has more than 500 items. Split it into smaller files before importing.");
    }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : "The bill list could not be read."); }
    const existing = await signatures(me, hid, spaceId);
    for (const row of rows) {
      row.duplicate = row.amountMinor != null && !!row.nextDate && existing.has(billImportSignature({ ...row, amountMinor: row.amountMinor, nextDate: row.nextDate, accountId }));
      if (row.duplicate) row.suggested = false;
    }
    const draftId = id(), expiresAt = new Date(Date.now()+7*86400000).toISOString();
    const preview = { id: draftId, filename: file.name.slice(0,255), format: document.format, pages: document.pages, month, spaceId, accountId, rows, warnings: document.warnings, extractedText: document.text, expiresAt };
    // Recheck access after reading a potentially slow document.
    await db.tx(async () => {
      await lockHousehold(db, hid);
      assertBudget(await requireMember(db, me.id, hid));
      await hooks.assertSpace(me.id, hid, spaceId); await account(me,hid,spaceId,accountId);
      await db.query(`DELETE FROM bill_import_drafts WHERE user_id=$1 AND expires_at<$2`,[me.id,nowIso()]);
      await db.query(`INSERT INTO bill_import_drafts (id,household_id,user_id,space_id,account_id,preview_json,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [draftId,hid,me.id,spaceId,accountId||null,JSON.stringify(preview),nowIso(),expiresAt]);
    });
    return c.json(preview, 201);
  });

  app.get(`${base}/:draftId`, async c => {
    const row = await draft(await hooks.actor(c),c.req.param("hid"),c.req.param("draftId"));
    return c.json({ ...JSON.parse(row.preview_json), result: row.result_json ? JSON.parse(row.result_json) : null });
  });

  app.post(`${base}/:draftId/confirm`, async c => {
    const me = await hooks.actor(c), hid = c.req.param("hid"), input = confirmSchema.parse(await c.req.json());
    const fingerprint = sha256(JSON.stringify(input));
    const result = await db.tx(async () => {
      await lockHousehold(db, hid);
      assertBudget(await requireMember(db, me.id, hid));
      const stored = await draft(me,hid,c.req.param("draftId"));
      if (stored.result_json) {
        if (stored.fingerprint !== fingerprint) throw new ApiError(409, "This preview has already been imported. Upload again to choose additional items.");
        return { ...JSON.parse(stored.result_json), repeated: true };
      }
      const preview = JSON.parse(stored.preview_json) as { rows: BillImportRow[]; filename: string };
      const source = new Map(preview.rows.map(row => [row.key,row]));
      const keys = new Set<string>();
      for (const row of input.rows) {
        if (keys.has(row.key) || (!source.has(row.key) && !/^manual:[a-zA-Z0-9-]{1,80}$/.test(row.key))) throw new ApiError(400, "Each selected item must belong to this preview and appear once.");
        keys.add(row.key);
        await account(me,hid,stored.space_id,row.accountId);
      }
      const existing = await signatures(me,hid,stored.space_id);
      const created: {key:string;id:string;name:string}[] = [], skipped: {key:string;name:string}[] = [];
      for (const row of input.rows) {
        const signature = billImportSignature(row);
        if (existing.has(signature)) { skipped.push({key:row.key,name:row.name}); continue; }
        const saved = await hooks.createBill(me,hid,{ ...row, spaceId: stored.space_id, type: row.kind, direction: row.kind === "income" ? "inflow" : "outflow" });
        const original = source.get(row.key);
        const details = { filename: preview.filename, location: original?.location ?? "Manually added during review", paymentMethod: row.paymentMethod, paidReference: row.paidReference, notes: row.notes, balanceOwedMinor: row.balanceOwedMinor, sourceCells: original?.sourceCells ?? [] };
        await db.query(`INSERT INTO schedule_import_details (schedule_id,details_json) VALUES ($1,$2)`, [saved.id,JSON.stringify(details)]);
        created.push({key:row.key,id:saved.id,name:row.name}); existing.add(signature);
      }
      const result = { created, skipped, repeated: false, note: "Schedules saved. No payments, account balances, debts or budget assignments were changed." };
      await db.query(`UPDATE bill_import_drafts SET result_json=$1,fingerprint=$2 WHERE id=$3`,[JSON.stringify(result),fingerprint,stored.id]);
      return result;
    });
    return c.json(result);
  });

  app.get("/api/households/:hid/schedules/:scheduleId/import-details", async c => {
    const me=await hooks.actor(c),hid=c.req.param("hid");
    await requireMember(db,me.id,hid);
    const [schedule]=await db.query(`SELECT * FROM schedules WHERE id=$1 AND household_id=$2`,[c.req.param("scheduleId"),hid]);
    if(!schedule) throw new ApiError(404,"Not found");
    await hooks.assertSpace(me.id,hid,String(schedule.space_id));
    if(schedule.account_id) await hooks.mustAccount(me.id,hid,String(schedule.account_id));
    const [details]=await db.query(`SELECT details_json FROM schedule_import_details WHERE schedule_id=$1`,[schedule.id]);
    return c.json({details:details?JSON.parse(String(details.details_json)):null});
  });
}
