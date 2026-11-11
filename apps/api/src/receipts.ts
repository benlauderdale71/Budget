import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiError, type Actor, type Member, audit, canSeeAccount } from "./finance.js";
import { id, nowIso } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { readReceipt, readerStatus } from "./ocr.js";
import { emptyFields, receiptDifferences, reviewFields, parseReceiptText, type ReceiptFields } from "./receipt-fields.js";

interface ReceiptDeps {
  actor: (c: Context) => Promise<Actor>;
  requireMember: (userId: string, householdId: string) => Promise<Member>;
  assertWrite: (member: Member) => void;
  assertSpace: (userId: string, householdId: string, spaceId: string) => Promise<void>;
  mustAccount: (userId: string, householdId: string, accountId: string) => Promise<Record<string, unknown>>;
  mustTxn: (userId: string, householdId: string, txnId: string) => Promise<Record<string, unknown>>;
  insertTransaction: (me: Actor, householdId: string, body: {
    spaceId?: string;
    date: string;
    accountId: string;
    amountMinor: number;
    type: string;
    payee: string;
    splits: { bucketId: string | null; amountMinor: number; role: "expense"; memo?: string }[];
    bankStatus: "posted";
    reviewStatus: "reviewed";
    notes?: string;
    categoryLocked: boolean;
    opId: string;
  }) => Promise<{ id: string | null; duplicate?: boolean }>;
  uploadDir: () => string;
}

const running = new Set<string>();
const opPattern = /^[A-Za-z0-9_.:-]{8,80}$/;

export function mountReceipts(app: Hono, db: Database, deps: ReceiptDeps) {
  app.post("/api/households/:hid/attachments", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    deps.assertWrite(member);
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new ApiError(400, "Choose a JPEG, PNG, or PDF.");
    if (file.size > 8_000_000) throw new ApiError(400, "Files need to be 8 MB or smaller.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = sniff(bytes);
    if (!mime) throw new ApiError(400, "Only JPEG, PNG, and PDF files are accepted.");
    const transactionId = typeof form.transactionId === "string" && form.transactionId ? form.transactionId : null;
    if (transactionId) await assertTransactionAccess(db, deps, me.id, member.householdId, transactionId);
    const attachmentId = id();
    const key = `${member.householdId}/${attachmentId}`;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const stamp = nowIso();
    await mkdir(resolve(deps.uploadDir(), member.householdId), { recursive: true });
    await writeFile(storedPath(deps.uploadDir(), key), bytes);
    try {
      await db.tx(async () => {
        await db.query(
          `INSERT INTO attachments (id, household_id, transaction_id, filename, mime, size_bytes, storage_key, created_by, created_at, ocr_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [attachmentId, member.householdId, transactionId, safeFilename(mime), mime, bytes.length, key, me.id, stamp, JSON.stringify({ status: "uploaded", draftId: attachmentId })],
        );
        await db.query(
          `INSERT INTO receipt_drafts (id, household_id, attachment_id, status, version, fields_json, user_edited, transaction_id, content_sha256, created_at, updated_at)
           VALUES ($1,$2,$3,'uploaded',1,$4,0,$5,$6,$7,$7)`,
          [id(), member.householdId, attachmentId, JSON.stringify(emptyFields()), transactionId, hash, stamp],
        );
      });
    } catch (error) {
      await rm(storedPath(deps.uploadDir(), key), { force: true });
      throw error;
    }
    const draft = await loadDraft(db, member.householdId, attachmentId);
    const possibleDuplicates = await duplicates(db, member.householdId, hash, attachmentId);
    return c.json({ id: attachmentId, status: "uploaded", draft: publicDraft(draft), possibleDuplicates }, 201);
  });

  app.get("/api/households/:hid/receipts", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    const rows = await db.query(
      `SELECT * FROM receipt_drafts WHERE household_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [member.householdId],
    );
    const visible = [];
    for (const row of rows) {
      if (await canReadDraft(db, deps, me.id, member.householdId, row)) visible.push(publicDraft(row, false));
    }
    return c.json({ receipts: visible, reader: readerStatus() });
  });

  app.get("/api/households/:hid/attachments/:id", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    const accountCurrency = loaded.draft.transaction_id ? await transactionCurrency(db, me.id, member.householdId, String(loaded.draft.transaction_id), deps) : null;
    const txn = loaded.draft.transaction_id ? await deps.mustTxn(me.id, member.householdId, String(loaded.draft.transaction_id)) : null;
    return c.json({
      attachment: publicAttachment(loaded.attachment),
      draft: publicDraft(loaded.draft, true),
      possibleDuplicates: await duplicates(db, member.householdId, String(loaded.draft.content_sha256), String(loaded.attachment.id)),
      possibleTransactions: await possibleTransactions(db, deps, me, member.householdId, fieldsOf(loaded.draft)),
      differences: receiptDifferences(fieldsOf(loaded.draft), txn ? txnView(txn) : null, accountCurrency),
      reader: readerStatus(),
    });
  });

  app.get("/api/households/:hid/attachments/:id/file", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    const bytes = await readFile(storedPath(deps.uploadDir(), String(loaded.attachment.storage_key)));
    const mime = sniff(bytes) ?? "application/octet-stream";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": mime,
        "content-disposition": `inline; filename="${safeFilename(mime)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post("/api/households/:hid/attachments/:id/extract", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    deps.assertWrite(member);
    const body = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    const kept = keepExisting(loaded.draft);
    if (kept) return c.json({ kept: true, reason: kept, draft: publicDraft(loaded.draft, true) });
    if (num(loaded.draft.version) !== body.version) throw new ApiError(409, "Reload this receipt. A newer draft was saved.");
    if (running.has(String(loaded.attachment.id))) return c.json({ draft: publicDraft({ ...loaded.draft, status: "processing" }, true), status: "processing" });
    const nextVersion = body.version + 1;
    const bumped = await db.query(
      `UPDATE receipt_drafts SET status = 'processing', error = NULL, version = version + 1, updated_at = $1
       WHERE attachment_id = $2 AND household_id = $3 AND version = $4 AND user_edited = 0 AND status IN ('uploaded','failed','ready','processing') RETURNING version`,
      [nowIso(), loaded.attachment.id, member.householdId, body.version],
    );
    if (!bumped.length) throw new ApiError(409, "Reload this receipt. A newer draft was saved.");
    running.add(String(loaded.attachment.id));
    try {
      const bytes = await readFile(storedPath(deps.uploadDir(), String(loaded.attachment.storage_key)));
      const mime = sniff(bytes);
      if (!mime) throw new Error("Only JPEG, PNG, and PDF files are accepted.");
      const read = await readReceipt(bytes, mime);
      const letters = read.text.match(/[A-Za-z0-9]/g)?.length ?? 0;
      const fields = letters >= 4 ? parseReceiptText(read.text) : emptyFields();
      const failed = letters < 4;
      const error = failed ? "The reader did not find readable text. Type the merchant, date, currency, and total yourself." : null;
      const saved = await db.query(
        `UPDATE receipt_drafts SET status = $1, engine = $2, source_kind = $3, raw_text = $4, fields_json = $5, confidence = $6, confidence_note = $7, error = $8, updated_at = $9
         WHERE attachment_id = $10 AND household_id = $11 AND version = $12 AND user_edited = 0 RETURNING *`,
        [failed ? "failed" : "ready", read.engine, read.source, read.text.slice(0, 20_000), JSON.stringify(fields), read.confidence, read.confidenceNote, error ?? read.note, nowIso(), loaded.attachment.id, member.householdId, nextVersion],
      );
      if (!saved.length) {
        const current = await loadDraft(db, member.householdId, String(loaded.attachment.id));
        return c.json({ kept: true, reason: "A newer review was kept.", draft: publicDraft(current, true) });
      }
      await db.query(`UPDATE attachments SET ocr_json = $1 WHERE id = $2`, [JSON.stringify({ status: failed ? "failed" : "ready", draftId: saved[0].id }), loaded.attachment.id]);
      return c.json({ kept: false, draft: publicDraft(saved[0], true), reader: readerStatus() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The receipt could not be read.";
      const saved = await db.query(
        `UPDATE receipt_drafts SET status = 'failed', error = $1, fields_json = $2, updated_at = $3
         WHERE attachment_id = $4 AND household_id = $5 AND version = $6 AND user_edited = 0 RETURNING *`,
        [message, JSON.stringify(emptyFields()), nowIso(), loaded.attachment.id, member.householdId, nextVersion],
      );
      const current = saved[0] ?? await loadDraft(db, member.householdId, String(loaded.attachment.id));
      return c.json({ kept: false, draft: publicDraft(current, true), reader: readerStatus() });
    } finally {
      running.delete(String(loaded.attachment.id));
    }
  });

  app.patch("/api/households/:hid/attachments/:id/draft", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    deps.assertWrite(member);
    const body = z.object({
      version: z.number().int().positive(),
      fields: z.object({
        merchant: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
        currency: z.string().nullable().optional(),
        subtotalMinor: z.number().int().nullable().optional(),
        taxMinor: z.number().int().nullable().optional(),
        tipMinor: z.number().int().nullable().optional(),
        discountMinor: z.number().int().nullable().optional(),
        totalMinor: z.number().int().nullable().optional(),
        lineItems: z.array(z.object({ description: z.string().nullable().optional(), amountMinor: z.number().int().nullable().optional() })).max(80).optional(),
      }),
    }).parse(await c.req.json());
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    if (loaded.draft.status === "confirmed") throw new ApiError(409, "This receipt is already confirmed.");
    if (loaded.draft.status === "discarded") throw new ApiError(409, "This receipt was discarded.");
    let fields: ReceiptFields;
    try {
      fields = reviewFields(body.fields);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "The receipt fields are not valid.");
    }
    const saved = await db.query(
      `UPDATE receipt_drafts SET status = 'ready', fields_json = $1, user_edited = 1, error = NULL, version = version + 1, updated_at = $2
       WHERE attachment_id = $3 AND household_id = $4 AND version = $5 AND status NOT IN ('confirmed','discarded') RETURNING *`,
      [JSON.stringify(fields), nowIso(), loaded.attachment.id, member.householdId, body.version],
    );
    if (!saved.length) throw new ApiError(409, "Reload this receipt. A newer draft was saved.");
    return c.json({ draft: publicDraft(saved[0], true) });
  });

  app.post("/api/households/:hid/attachments/:id/discard", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    deps.assertWrite(member);
    const body = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    if (loaded.draft.status === "confirmed") throw new ApiError(409, "This receipt is already confirmed. The transaction was not changed.");
    const saved = await db.query(
      `UPDATE receipt_drafts SET status = 'discarded', version = version + 1, updated_at = $1
       WHERE attachment_id = $2 AND household_id = $3 AND version = $4 AND status <> 'confirmed' RETURNING *`,
      [nowIso(), loaded.attachment.id, member.householdId, body.version],
    );
    if (!saved.length) throw new ApiError(409, "Reload this receipt. A newer draft was saved.");
    await db.query(`UPDATE attachments SET ocr_json = $1 WHERE id = $2`, [JSON.stringify({ status: "discarded", draftId: saved[0].id }), loaded.attachment.id]);
    return c.json({ draft: publicDraft(saved[0], true), note: "The receipt was discarded. No transaction was changed." });
  });

  app.post("/api/households/:hid/attachments/:id/apply", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    deps.assertWrite(member);
    const body = z.object({
      confirm: z.literal(true),
      transactionId: z.string(),
      draftVersion: z.number().int().positive(),
      transactionVersion: z.number().int().positive(),
      opId: z.string().regex(opPattern),
      acceptTotalMismatch: z.boolean().optional(),
      acceptDateMismatch: z.boolean().optional(),
      acceptCurrencyMismatch: z.boolean().optional(),
      acceptLineMismatch: z.boolean().optional(),
    }).parse(await c.req.json());
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    const destination = await assertTransactionAccess(db, deps, me.id, member.householdId, body.transactionId);
    if (loaded.attachment.transaction_id && String(loaded.attachment.transaction_id) !== destination.id) {
      throw new ApiError(409, "This receipt is already linked to another transaction.");
    }
    const fields = fieldsOf(loaded.draft);
    const account = await deps.mustAccount(me.id, member.householdId, String(destination.account_id));
    const differences = receiptDifferences(fields, txnView(destination), String(account.currency));
    const blocked = unaccepted(differences, body);
    if (blocked.length) {
      return c.json({ ok: false, mismatch: true, error: "The receipt does not match the transaction. Nothing was changed.", differences: blocked }, 409);
    }
    const result = await db.tx(async () => {
      const claimed = await claimOp(db, member.householdId, body.opId);
      const current = await db.query(`SELECT * FROM receipt_drafts WHERE attachment_id = $1 FOR UPDATE`, [loaded.attachment.id]);
      const draft = current[0];
      if (!claimed) {
        if (String(draft.op_id ?? "") === body.opId && draft.status === "confirmed") {
          return { ok: true, duplicate: true, created: false, transactionId: String(draft.transaction_id) };
        }
        throw new ApiError(409, "That operation id was already used.");
      }
      if (draft.status === "confirmed") return { ok: true, duplicate: true, created: false, transactionId: str(draft.transaction_id) };
      if (draft.status === "discarded") throw new ApiError(409, "This receipt was discarded.");
      if (num(draft.version) !== body.draftVersion) throw new ApiError(409, "Reload this receipt. A newer draft was saved.");
      const fresh = await deps.mustTxn(me.id, member.householdId, String(destination.id));
      if (num(fresh.version) !== body.transactionVersion) throw new ApiError(409, "Reload this transaction. Someone else saved a newer version.");
      if (num(fresh.reconciled) === 1) {
        await db.query(`UPDATE attachments SET transaction_id = $1 WHERE id = $2 AND household_id = $3`, [fresh.id, loaded.attachment.id, member.householdId]);
        await db.query(
          `UPDATE receipt_drafts SET status = 'confirmed', transaction_id = $1, op_id = $2, version = version + 1, updated_at = $3 WHERE attachment_id = $4`,
          [fresh.id, body.opId, nowIso(), loaded.attachment.id],
        );
        await audit(db, member.householdId, me.id, "receipt.link", "Linked a receipt to a reconciled transaction without changing it", "transaction", String(fresh.id));
        return { ok: true, duplicate: false, created: false, transactionId: String(fresh.id), note: "The receipt was attached. The reconciled transaction was not changed." };
      }
      await db.query(`UPDATE attachments SET transaction_id = $1 WHERE id = $2 AND household_id = $3`, [fresh.id, loaded.attachment.id, member.householdId]);
      await db.query(
        `UPDATE receipt_drafts SET status = 'confirmed', transaction_id = $1, op_id = $2, version = version + 1, updated_at = $3 WHERE attachment_id = $4`,
        [fresh.id, body.opId, nowIso(), loaded.attachment.id],
      );
      await audit(db, member.householdId, me.id, "receipt.link", "Linked a receipt to an existing transaction without changing it", "transaction", String(fresh.id));
      return { ok: true, duplicate: false, created: false, transactionId: String(fresh.id), note: "The receipt was linked. No second expense was created, and the transaction was not changed." };
    });
    return c.json(result);
  });

  app.post("/api/households/:hid/attachments/:id/confirm", async (c) => {
    const me = await deps.actor(c);
    const member = await deps.requireMember(me.id, c.req.param("hid"));
    deps.assertWrite(member);
    const body = z.object({
      confirm: z.literal(true),
      version: z.number().int().positive(),
      opId: z.string().regex(opPattern),
      accountId: z.string(),
      splits: z.array(z.object({ bucketId: z.string().nullable(), amountMinor: z.number().int().nonnegative() })).max(12).default([]),
      acceptCurrencyMismatch: z.boolean().optional(),
      acceptLineMismatch: z.boolean().optional(),
    }).parse(await c.req.json());
    const loaded = await mustAttachment(db, deps, me.id, member.householdId, c.req.param("id"));
    if (loaded.attachment.transaction_id) {
      if (loaded.draft.status === "confirmed") {
        return c.json({ ok: true, duplicate: true, created: false, transactionId: String(loaded.draft.transaction_id) });
      }
      throw new ApiError(409, "This receipt is already linked to a transaction. Confirming it again would add another expense.");
    }
    const account = await deps.mustAccount(me.id, member.householdId, body.accountId);
    await deps.assertSpace(me.id, member.householdId, String(account.space_id));
    const fields = fieldsOf(loaded.draft);
    if (!fields.merchant || !fields.date || !fields.currency || fields.totalMinor == null) {
      throw new ApiError(400, "Save a merchant, date, currency, and total before creating an expense.");
    }
    if (!body.splits.length || body.splits.some((split) => !split.bucketId)) throw new ApiError(400, "Choose a category before creating the expense.");
    const splitSum = body.splits.reduce((sum, split) => sum + split.amountMinor, 0);
    if (splitSum !== fields.totalMinor) throw new ApiError(400, "The categories do not add up to the receipt total.");
    const differences = receiptDifferences(fields, null, String(account.currency));
    const blocked = unaccepted(differences, body);
    if (blocked.length) return c.json({ ok: false, mismatch: true, error: "Resolve the receipt differences before creating an expense. Nothing was changed.", differences: blocked }, 409);
    const splits = body.splits.map((split) => ({
      bucketId: split.bucketId,
      amountMinor: split.amountMinor,
      role: "expense" as const,
    }));
    const note = fields.currency === String(account.currency)
      ? "Confirmed from a reviewed receipt. A receipt does not prove which account paid."
      : "Confirmed from a reviewed receipt. The receipt currency differed from the account. No conversion was applied. A receipt does not prove which account paid.";
    const result = await db.tx(async () => {
      const current = await db.query(`SELECT * FROM receipt_drafts WHERE attachment_id = $1 FOR UPDATE`, [loaded.attachment.id]);
      const draft = current[0];
      if (draft.status === "confirmed") return { ok: true, duplicate: true, created: false, transactionId: str(draft.transaction_id) };
      if (draft.status === "discarded") throw new ApiError(409, "This receipt was discarded.");
      if (num(draft.version) !== body.version) throw new ApiError(409, "Reload this receipt. A newer draft was saved.");
      if (draft.transaction_id) throw new ApiError(409, "This receipt is already linked to a transaction.");
      const created = await deps.insertTransaction(me, member.householdId, {
        spaceId: String(account.space_id),
        date: fields.date!,
        accountId: body.accountId,
        amountMinor: -fields.totalMinor!,
        type: "expense",
        payee: fields.merchant!,
        splits,
        bankStatus: "posted",
        reviewStatus: "reviewed",
        notes: note,
        categoryLocked: true,
        opId: body.opId,
      });
      if (!created.id) throw new ApiError(409, "The expense could not be saved.");
      if (created.duplicate) throw new ApiError(409, "That operation id was already used.");
      await db.query(`UPDATE attachments SET transaction_id = $1 WHERE id = $2 AND household_id = $3`, [created.id, loaded.attachment.id, member.householdId]);
      await db.query(
        `UPDATE receipt_drafts SET status = 'confirmed', transaction_id = $1, op_id = $2, version = version + 1, updated_at = $3 WHERE attachment_id = $4`,
        [created.id, body.opId, nowIso(), loaded.attachment.id],
      );
      await audit(db, member.householdId, me.id, "receipt.confirm", "Confirmed one reviewed receipt as an expense", "transaction", created.id);
      return { ok: true, duplicate: !!created.duplicate, created: !created.duplicate, transactionId: created.id };
    });
    return c.json(result, result.created ? 201 : 200);
  });
}

async function claimOp(db: Database, householdId: string, opId: string): Promise<boolean> {
  const claimed = await db.query(
    `INSERT INTO applied_ops (household_id, op_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING op_id`,
    [householdId, opId, nowIso()],
  );
  return claimed.length > 0;
}

function keepExisting(draft: Record<string, unknown>): string | null {
  if (num(draft.user_edited) === 1) return "Your corrections were kept.";
  if (draft.status === "confirmed") return "This receipt is already confirmed.";
  if (draft.status === "discarded") return "This receipt was discarded.";
  return null;
}

function unaccepted(differences: { code: string; message: string }[], body: { acceptTotalMismatch?: boolean; acceptDateMismatch?: boolean; acceptCurrencyMismatch?: boolean; acceptLineMismatch?: boolean }) {
  return differences.filter((difference) => {
    if (difference.code === "total") return !body.acceptTotalMismatch;
    if (difference.code === "date") return !body.acceptDateMismatch;
    if (difference.code === "currency") return !body.acceptCurrencyMismatch;
    return !body.acceptLineMismatch;
  });
}

async function mustAttachment(db: Database, deps: ReceiptDeps, userId: string, householdId: string, attachmentId: string) {
  const rows = await db.query(`SELECT * FROM attachments WHERE id = $1 AND household_id = $2`, [attachmentId, householdId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  const draftRows = await db.query(`SELECT * FROM receipt_drafts WHERE attachment_id = $1 AND household_id = $2`, [attachmentId, householdId]);
  if (!draftRows.length) throw new ApiError(404, "Not found");
  if (!(await canReadDraft(db, deps, userId, householdId, draftRows[0]))) throw new ApiError(404, "Not found");
  return { attachment: rows[0], draft: draftRows[0] };
}

async function canReadDraft(db: Database, deps: ReceiptDeps, userId: string, householdId: string, draft: Record<string, unknown>): Promise<boolean> {
  const transactionId = str(draft.transaction_id);
  if (!transactionId) return true;
  try {
    await assertTransactionAccess(db, deps, userId, householdId, transactionId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

async function assertTransactionAccess(db: Database, deps: ReceiptDeps, userId: string, householdId: string, transactionId: string) {
  const txn = await deps.mustTxn(userId, householdId, transactionId);
  const spaceId = str(txn.space_id);
  if (spaceId) await deps.assertSpace(userId, householdId, spaceId);
  return txn;
}

async function transactionCurrency(db: Database, userId: string, householdId: string, transactionId: string, deps: ReceiptDeps) {
  const txn = await deps.mustTxn(userId, householdId, transactionId);
  const account = await deps.mustAccount(userId, householdId, String(txn.account_id));
  return String(account.currency);
}

async function loadDraft(db: Database, householdId: string, attachmentId: string) {
  const rows = await db.query(`SELECT * FROM receipt_drafts WHERE household_id = $1 AND attachment_id = $2`, [householdId, attachmentId]);
  if (!rows.length) throw new ApiError(404, "Not found");
  return rows[0];
}

async function duplicates(db: Database, householdId: string, hash: string, attachmentId: string) {
  const rows = await db.query(
    `SELECT attachment_id, status FROM receipt_drafts WHERE household_id = $1 AND content_sha256 = $2 AND attachment_id <> $3 LIMIT 8`,
    [householdId, hash, attachmentId],
  );
  return rows.map((row) => ({ attachmentId: String(row.attachment_id), status: String(row.status) }));
}

async function possibleTransactions(db: Database, deps: ReceiptDeps, me: Actor, householdId: string, fields: ReceiptFields) {
  const rows = await db.query(
    `SELECT t.*, a.visibility, a.owner_user_id FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.household_id = $1 AND t.deleted = 0 AND t.type = 'expense' ORDER BY t.date DESC LIMIT 80`,
    [householdId],
  );
  const matches = [];
  for (const row of rows) {
    if (!canSeeAccount(me.id, { visibility: String(row.visibility), owner_user_id: str(row.owner_user_id) ?? null })) continue;
    try {
      if (str(row.space_id)) await deps.assertSpace(me.id, householdId, String(row.space_id));
    } catch {
      continue;
    }
    const amountMatches = fields.totalMinor != null && Math.abs(num(row.amount_minor)) === fields.totalMinor;
    const merchant = fields.merchant?.toLowerCase() ?? "";
    const payee = String(row.payee).toLowerCase();
    const merchantMatches = merchant.length > 2 && (payee.includes(merchant) || merchant.includes(payee));
    const dateClose = fields.date ? Math.abs(Date.parse(fields.date) - Date.parse(String(row.date))) <= 14 * 86_400_000 : false;
    if (!amountMatches && !(merchantMatches && dateClose)) continue;
    matches.push({
      id: String(row.id),
      date: String(row.date),
      payee: String(row.payee),
      amountMinor: num(row.amount_minor),
      currency: String(row.currency),
      version: num(row.version),
      accountId: String(row.account_id),
      reconciled: num(row.reconciled) === 1,
      reason: amountMatches ? "The amount matches." : "The merchant and date are close.",
    });
    if (matches.length >= 8) break;
  }
  return matches;
}

function fieldsOf(draft: Record<string, unknown>): ReceiptFields {
  try {
    return JSON.parse(String(draft.fields_json || "{}")) as ReceiptFields;
  } catch {
    return emptyFields();
  }
}

function txnView(txn: Record<string, unknown>) {
  return { amountMinor: num(txn.amount_minor), date: String(txn.date), currency: String(txn.currency) };
}

function publicAttachment(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    mime: String(row.mime),
    sizeBytes: num(row.size_bytes),
    createdAt: String(row.created_at),
    transactionId: str(row.transaction_id),
  };
}

function publicDraft(row: Record<string, unknown>, includeText = false) {
  const fields = fieldsOf(row);
  return {
    id: String(row.id),
    attachmentId: String(row.attachment_id),
    status: String(row.status),
    version: num(row.version),
    engine: str(row.engine),
    source: str(row.source_kind),
    confidence: row.confidence == null ? null : Number(row.confidence),
    confidenceNote: str(row.confidence_note),
    userEdited: num(row.user_edited) === 1,
    transactionId: str(row.transaction_id),
    opId: str(row.op_id),
    error: str(row.error),
    fields,
    rawText: includeText ? str(row.raw_text) : undefined,
    updatedAt: String(row.updated_at),
  };
}

function storedPath(root: string, key: string): string {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key)) throw new ApiError(400, "The stored receipt path is not valid.");
  const rootPath = resolve(root);
  const full = resolve(rootPath, key);
  if (!full.startsWith(rootPath + sep)) throw new ApiError(400, "The stored receipt path is not valid.");
  return full;
}

function safeFilename(mime: string): string {
  if (mime === "image/png") return "receipt.png";
  if (mime === "application/pdf") return "receipt.pdf";
  return "receipt.jpg";
}

function sniff(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (bytes.length > 4 && bytes.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
  return null;
}
