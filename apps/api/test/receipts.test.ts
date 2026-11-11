import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { textPdf } from "../src/pdf.js";
import { parseReceiptText } from "../src/receipt-fields.js";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
const root = mkdtempSync(join(tmpdir(), "bc-receipts-"));
const fixtures = mkdtempSync(join(tmpdir(), "bc-fixtures-"));
process.env.BUDGETCENTS_UPLOADS = root;

beforeAll(() => {
  execFileSync("python3", ["-c", `
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
out = Path(${JSON.stringify(fixtures)})
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 42)
def draw(lines):
    img = Image.new("RGB", (980, 70 + 64 * len(lines)), "white")
    pen = ImageDraw.Draw(img)
    y = 24
    for line in lines:
        pen.text((36, y), line, fill="black", font=font)
        y += 64
    return img
clear = ["NORTH MARKET", "Date: 2026-11-10", "Milk 3.50", "Bread 2.50", "SUBTOTAL 6.00", "TAX 0.48", "TOTAL USD 6.48"]
image = draw(clear)
image.save(out / "clear.png")
image.save(out / "clear.jpg", quality=95)
image.rotate(90, expand=True, fillcolor="white").save(out / "rotated.png")
image.save(out / "scan.pdf", "PDF", resolution=150.0)
draw(["CORNER STORE", "Date: 03/04/2026", "Soap 12.50", "TOTAL $12.50"]).save(out / "ambiguous.png")
draw(["NORTH MARKET", "Date: 2026-11-10", "Milk 10.00", "Bread 10.00", "TOTAL USD 30.00"]).save(out / "lines.png")
Image.effect_noise((480, 240), 90).convert("RGB").save(out / "noise.png")
pages = [Image.new("RGB", (80, 80), "white") for _ in range(9)]
pages[0].save(out / "many.pdf", save_all=True, append_images=pages[1:])
`], { stdio: "inherit" });
});

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
  const groceries = (dash.body.buckets as { id: string; name: string }[]).find((bucket) => bucket.name === "Groceries");
  return { token, userId, hid, spaceId: dash.body.spaceId as string, groceries: groceries?.id as string };
}

async function checking(api: Awaited<ReturnType<typeof app>>, home: Awaited<ReturnType<typeof household>>, opening = 100000, name = "Checking", visibility = "shared") {
  return json(await api.request(`/api/households/${home.hid}/accounts`, {
    method: "POST",
    headers: auth(home.token),
    body: JSON.stringify({ spaceId: home.spaceId, name, kind: "checking", onBudget: true, visibility, openingBalanceMinor: opening, openingDate: "2026-11-01" }),
  }));
}

async function snapshot(api: Awaited<ReturnType<typeof app>>, home: Awaited<ReturnType<typeof household>>) {
  const dash = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-10`, { headers: auth(home.token) }));
  const txns = await json(await api.request(`/api/households/${home.hid}/transactions?asOf=2026-11-10&limit=50`, { headers: auth(home.token) }));
  const expenses = (txns.body.transactions as { type: string; amountMinor: number; payee: string }[]).filter((txn) => txn.type === "expense");
  return {
    cash: dash.body.budget.cashPoolMinor as number,
    ready: dash.body.budget.readyToAssignMinor as number,
    spending: dash.body.budget.spendingMinor as number,
    income: dash.body.budget.incomeMinor as number,
    net: dash.body.netWorth.netMinor as number,
    expenses,
  };
}

function fileOf(name: string) {
  return readFileSync(join(fixtures, name));
}

async function upload(api: Awaited<ReturnType<typeof app>>, home: Awaited<ReturnType<typeof household>>, bytes: Buffer, type: string, transactionId?: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "receipt", { type }));
  if (transactionId) form.set("transactionId", transactionId);
  return json(await api.request(`/api/households/${home.hid}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${home.token}` },
    body: form,
  }));
}

async function extract(api: Awaited<ReturnType<typeof app>>, home: Awaited<ReturnType<typeof household>>, id: string, version = 1) {
  return json(await api.request(`/api/households/${home.hid}/attachments/${id}/extract`, {
    method: "POST",
    headers: auth(home.token),
    body: JSON.stringify({ version }),
  }));
}

describe("receipt text", () => {
  it("keeps ambiguous dates and currencies unresolved", () => {
    const clear = parseReceiptText("NORTH MARKET\nDate: 2026-11-10\nMilk 3.50\nBread 2.50\nSUBTOTAL 6.00\nTAX 0.48\nDISCOUNT 1.00\nTOTAL USD 6.48\n");
    expect(clear.merchant).toBe("NORTH MARKET");
    expect(clear.date).toBe("2026-11-10");
    expect(clear.currency).toBe("USD");
    expect(clear.subtotalMinor).toBe(600);
    expect(clear.taxMinor).toBe(48);
    expect(clear.discountMinor).toBe(100);
    expect(clear.totalMinor).toBe(648);
    expect(clear.lineItems.map((line) => line.amountMinor)).toEqual([350, 250]);
    expect(clear.lineVersusSubtotal).toBe("matches");
    expect(clear.lineVersusTotal).toBe("differs");

    const ambiguous = parseReceiptText("CORNER STORE\nDate: 03/04/2026\nSoap 12.50\nTOTAL $12.50\n");
    expect(ambiguous.date).toBeNull();
    expect(ambiguous.dateUnresolved).toMatch(/month-first or day-first/);
    expect(ambiguous.currency).toBeNull();
    expect(ambiguous.currencyUnresolved).toMatch(/\$ sign/);
    expect(ambiguous.totalMinor).toBe(1250);

    const dayFirst = parseReceiptText("Shop\nDate: 13/01/2026\nTOTAL USD 1.00\n");
    expect(dayFirst.date).toBe("2026-01-13");
    const shortYear = parseReceiptText("Shop\nDate: 03/04/05\nTOTAL USD 1.00\n");
    expect(shortYear.date).toBeNull();
    expect(shortYear.dateUnresolved).toMatch(/four-digit year/);
    expect(parseReceiptText("Shop\nTOTAL 12,50\n").totalMinor).toBeNull();
  });
});

describe("local receipt reader", () => {
  it("reads JPEG, PNG, rotated images, text PDFs, and scanned PDFs with the installed engine", async () => {
    const api = await app();
    const health = await json(await api.request("/api/health"));
    expect(health.body.ocr.available).toBe(true);
    expect(health.body.ocr.onDevice).toBe(false);
    expect(health.body.ocr.engine).toBe("tesseract");
    expect(String(health.body.ocr.version)).toMatch(/tesseract/i);
    expect(health.body.ocr.languages).toEqual(["eng"]);

    const home = await household(api, "reader@example.com");
    await checking(api, home);
    const before = await snapshot(api, home);

    const png = await upload(api, home, fileOf("clear.png"), "image/png");
    expect(png.status).toBe(201);
    expect(png.body.status).toBe("uploaded");
    const read = await extract(api, home, png.body.id);
    expect(read.body.draft.status).toBe("ready");
    expect(read.body.draft.source).toBe("image_ocr");
    expect(read.body.draft.engine).toMatch(/tesseract/i);
    expect(typeof read.body.draft.confidence).toBe("number");
    expect(read.body.draft.fields.merchant).toBe("NORTH MARKET");
    expect(read.body.draft.fields.date).toBe("2026-11-10");
    expect(read.body.draft.fields.currency).toBe("USD");
    expect(read.body.draft.fields.totalMinor).toBe(648);
    expect(read.body.draft.fields.subtotalMinor).toBe(600);
    expect(read.body.draft.fields.taxMinor).toBe(48);
    expect(read.body.draft.rawText).toMatch(/NORTH MARKET/);

    const jpeg = await extract(api, home, (await upload(api, home, fileOf("clear.jpg"), "image/jpeg")).body.id);
    expect(jpeg.body.draft.fields.totalMinor).toBe(648);
    expect(jpeg.body.draft.fields.currency).toBe("USD");

    const rotated = await extract(api, home, (await upload(api, home, fileOf("rotated.png"), "image/png")).body.id);
    expect(rotated.body.draft.fields.merchant).toBe("NORTH MARKET");
    expect(rotated.body.draft.fields.totalMinor).toBe(648);

    const text = await upload(api, home, textPdf("Harbor Books", ["Date: 2026-11-02", "Notebook 4.00", "TOTAL USD 4.00"]), "application/pdf");
    const textRead = await extract(api, home, text.body.id);
    expect(textRead.body.draft.source).toBe("pdf_text");
    expect(textRead.body.draft.confidence).toBeNull();
    expect(textRead.body.draft.confidenceNote).toMatch(/does not include a Tesseract confidence/);
    expect(textRead.body.draft.fields.merchant).toBe("Harbor Books");
    expect(textRead.body.draft.fields.date).toBe("2026-11-02");
    expect(textRead.body.draft.fields.totalMinor).toBe(400);

    const scan = await extract(api, home, (await upload(api, home, fileOf("scan.pdf"), "application/pdf")).body.id);
    expect(scan.body.draft.source).toBe("pdf_scan");
    expect(typeof scan.body.draft.confidence).toBe("number");
    expect(scan.body.draft.fields.merchant).toBe("NORTH MARKET");
    expect(scan.body.draft.fields.totalMinor).toBe(648);

    const ambiguous = await extract(api, home, (await upload(api, home, fileOf("ambiguous.png"), "image/png")).body.id);
    expect(ambiguous.body.draft.fields.date).toBeNull();
    expect(ambiguous.body.draft.fields.currency).toBeNull();
    expect(ambiguous.body.draft.fields.dateUnresolved).toBeTruthy();
    expect(ambiguous.body.draft.fields.currencyUnresolved).toMatch(/\$/);
    expect(ambiguous.body.draft.fields.totalMinor).toBe(1250);

    const lines = await extract(api, home, (await upload(api, home, fileOf("lines.png"), "image/png")).body.id);
    expect(lines.body.draft.fields.totalMinor).toBe(3000);
    expect(lines.body.draft.fields.lineSumMinor).toBe(2000);
    expect(lines.body.draft.fields.lineVersusTotal).toBe("differs");

    const noise = await extract(api, home, (await upload(api, home, fileOf("noise.png"), "image/png")).body.id);
    expect(noise.body.draft.status).toBe("failed");
    expect(noise.body.draft.fields.merchant).toBeNull();
    expect(noise.body.draft.fields.totalMinor).toBeNull();
    expect(noise.body.draft.fields.currency).toBeNull();

    const many = await extract(api, home, (await upload(api, home, fileOf("many.pdf"), "application/pdf")).body.id);
    expect(many.body.draft.status).toBe("failed");
    expect(many.body.draft.error).toMatch(/8 pages/);
    expect(await snapshot(api, home)).toEqual(before);
  }, 90000);

  it("does not change money until one explicit confirmation, and a repeat does not add another expense", async () => {
    const api = await app();
    const home = await household(api, "confirm@example.com");
    const account = await checking(api, home);
    const before = await snapshot(api, home);
    const uploaded = await upload(api, home, fileOf("clear.png"), "image/png");
    const read = await extract(api, home, uploaded.body.id);
    expect(await snapshot(api, home)).toEqual(before);

    const corrected = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/draft`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({
        version: read.body.draft.version,
        fields: { ...read.body.draft.fields, merchant: "North Market", lineItems: read.body.draft.fields.lineItems },
      }),
    }));
    expect(corrected.status).toBe(200);
    expect(await snapshot(api, home)).toEqual(before);
    const kept = await extract(api, home, uploaded.body.id, corrected.body.draft.version);
    expect(kept.body.kept).toBe(true);
    expect(kept.body.draft.fields.merchant).toBe("North Market");

    const blocked = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/confirm`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ confirm: true, version: corrected.body.draft.version, opId: "receipt-confirm-1", accountId: account.body.id, splits: [] }),
    }));
    expect(blocked.status).toBe(400);
    expect(await snapshot(api, home)).toEqual(before);

    const opId = "receipt-confirm-1";
    const created = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/confirm`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        confirm: true, version: corrected.body.draft.version, opId, accountId: account.body.id,
        acceptLineMismatch: true,
        splits: [{ bucketId: home.groceries, amountMinor: 648 }],
      }),
    }));
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    const once = await snapshot(api, home);
    expect(once.expenses).toHaveLength(1);
    expect(once.spending).toBe(648);
    expect(once.cash).toBe(before.cash - 648);
    expect(once.income).toBe(0);

    const replay = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/confirm`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        confirm: true, version: corrected.body.draft.version + 1, opId: "receipt-confirm-2", accountId: account.body.id,
        acceptLineMismatch: true,
        splits: [{ bucketId: home.groceries, amountMinor: 648 }],
      }),
    }));
    expect(replay.body.created).toBe(false);
    expect(replay.body.transactionId).toBe(created.body.transactionId);
    expect(await snapshot(api, home)).toEqual(once);
  });

  it("links a receipt to an existing expense without a second expense, and rejects stale, private, and reconciled overwrites", async () => {
    const api = await app();
    const home = await household(api, "link@example.com");
    const account = await checking(api, home);
    const other = await household(api, "other@example.com");
    const expense = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        date: "2026-11-09", accountId: account.body.id, amountMinor: -500, type: "expense", payee: "Corner",
        splits: [{ bucketId: home.groceries, amountMinor: 500, role: "expense" }], opId: "manual-expense-1", reviewStatus: "reviewed",
      }),
    }));
    const before = await snapshot(api, home);
    const uploaded = await upload(api, home, fileOf("clear.png"), "image/png");
    const read = await extract(api, home, uploaded.body.id);
    const missing = await json(await api.request(`/api/households/${home.hid}/attachments/${crypto.randomUUID()}/apply`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ confirm: true, transactionId: expense.body.id, draftVersion: 1, transactionVersion: 1, opId: "missing-apply-1" }),
    }));
    expect(missing.status).toBe(404);
    expect((await snapshot(api, home)).expenses[0].payee).toBe("Corner");

    const mismatch = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/apply`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ confirm: true, transactionId: expense.body.id, draftVersion: read.body.draft.version, transactionVersion: 1, opId: "link-mismatch-1" }),
    }));
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.mismatch).toBe(true);
    expect(await snapshot(api, home)).toEqual(before);

    const patched = await json(await api.request(`/api/households/${home.hid}/transactions/${expense.body.id}`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ version: 1, payee: "Corner shop" }),
    }));
    expect(patched.status).toBe(200);
    const stale = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/apply`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        confirm: true, transactionId: expense.body.id, draftVersion: read.body.draft.version, transactionVersion: 1, opId: "link-stale-1",
        acceptTotalMismatch: true, acceptDateMismatch: true, acceptLineMismatch: true,
      }),
    }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/newer version/);

    const linked = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/apply`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        confirm: true, transactionId: expense.body.id, draftVersion: read.body.draft.version, transactionVersion: 2, opId: "link-ok-1",
        acceptTotalMismatch: true, acceptDateMismatch: true, acceptLineMismatch: true,
      }),
    }));
    expect(linked.status).toBe(200);
    expect(linked.body.created).toBe(false);
    const afterLink = await snapshot(api, home);
    expect(afterLink.expenses).toHaveLength(1);
    expect(afterLink.expenses[0].amountMinor).toBe(-500);
    expect(afterLink.spending).toBe(before.spending);

    const outsider = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}`, { headers: auth(other.token) }));
    expect(outsider.status).toBe(404);

    const second = await upload(api, home, fileOf("lines.png"), "image/png");
    expect(second.body.possibleDuplicates).toEqual([]);
    const duplicate = await upload(api, home, fileOf("lines.png"), "image/png");
    expect(duplicate.body.possibleDuplicates.map((item: { attachmentId: string }) => item.attachmentId)).toContain(second.body.id);

    const privateAccount = await checking(api, home, 50000, "Private", "private");
    const privateExpense = await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        date: "2026-11-08", accountId: privateAccount.body.id, amountMinor: -200, type: "expense", payee: "Secret",
        splits: [{ bucketId: home.groceries, amountMinor: 200, role: "expense" }], opId: "private-expense-1", reviewStatus: "reviewed",
      }),
    }));
    const privateReceipt = await upload(api, home, fileOf("noise.png"), "image/png", privateExpense.body.id);
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'editor',$3)`, [home.hid, other.userId, new Date().toISOString()]);
    const hidden = await json(await api.request(`/api/households/${home.hid}/attachments/${privateReceipt.body.id}`, { headers: auth(other.token) }));
    expect(hidden.status).toBe(404);
    const hiddenApply = await json(await api.request(`/api/households/${home.hid}/attachments/${privateReceipt.body.id}/apply`, {
      method: "POST",
      headers: auth(other.token),
      body: JSON.stringify({ confirm: true, transactionId: privateExpense.body.id, draftVersion: 1, transactionVersion: 1, opId: "private-apply-1" }),
    }));
    expect(hiddenApply.status).toBe(404);

    await db.query(`UPDATE transactions SET reconciled = 1, locked = 1 WHERE id = $1`, [expense.body.id]);
    const reconciledReceipt = await upload(api, home, fileOf("ambiguous.png"), "image/png");
    await extract(api, home, reconciledReceipt.body.id);
    const reconciled = await json(await api.request(`/api/households/${home.hid}/attachments/${reconciledReceipt.body.id}/apply`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        confirm: true, transactionId: expense.body.id, draftVersion: 2, transactionVersion: 2, opId: "reconciled-link-1",
        acceptTotalMismatch: true, acceptDateMismatch: true, acceptCurrencyMismatch: true,
      }),
    }));
    expect(reconciled.status).toBe(200);
    const row = await db.query(`SELECT payee, amount_minor, reconciled FROM transactions WHERE id = $1`, [expense.body.id]);
    expect(num(row[0].amount_minor)).toBe(-500);
    expect(String(row[0].payee)).toBe("Corner shop");
    expect(num(row[0].reconciled)).toBe(1);
  });

  it("discards a failed read without posting, and a stale draft cannot confirm", async () => {
    const api = await app();
    const home = await household(api, "manual@example.com");
    const account = await checking(api, home);
    const before = await snapshot(api, home);
    const uploaded = await upload(api, home, fileOf("noise.png"), "image/png");
    const failed = await extract(api, home, uploaded.body.id);
    const typed = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/draft`, {
      method: "PATCH",
      headers: auth(home.token),
      body: JSON.stringify({ version: failed.body.draft.version, fields: { merchant: "Typed Market", date: "2026-11-10", currency: "USD", totalMinor: 700, lineItems: [] } }),
    }));
    expect(typed.body.draft.status).toBe("ready");
    expect(typed.body.draft.userEdited).toBe(true);
    const stale = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/confirm`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        confirm: true, version: failed.body.draft.version, opId: "stale-draft-1", accountId: account.body.id,
        splits: [{ bucketId: home.groceries, amountMinor: 700 }],
      }),
    }));
    expect(stale.status).toBe(409);
    const discarded = await json(await api.request(`/api/households/${home.hid}/attachments/${uploaded.body.id}/discard`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ version: typed.body.draft.version }),
    }));
    expect(discarded.body.draft.status).toBe("discarded");
    expect(await snapshot(api, home)).toEqual(before);
  });
});

describe("forecast", () => {
  it("keeps cash and expected income apart, skips settled items, and leaves private accounts out", async () => {
    const api = await app();
    const home = await household(api, "forecast@example.com");
    const account = await checking(api, home);
    const other = await checking(api, home, 0, "Savings");
    const source = await json(await api.request(`/api/households/${home.hid}/income-sources`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        spaceId: home.spaceId, name: "Side contract", kind: "irregular", accountId: account.body.id, amountMinor: 0, cadence: "irregular", startDate: "2026-11-01",
        dates: [{ date: "2026-11-18", amountMinor: 25000 }],
      }),
    }));
    const bill = await json(await api.request(`/api/households/${home.hid}/schedules`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Power", cadence: "monthly", nextDate: "2026-11-12", amountMinor: 4000, direction: "outflow", type: "bill", accountId: account.body.id }),
    }));
    const open = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=20`, { headers: auth(home.token) }));
    expect(open.body.plan.endingMinor - open.body.cash.endingMinor).toBe(25000);
    expect(open.body.cash.endingMinor).toBe(100000 - 4000);
    expect(open.body.cash.includedExpectedIncome).toBe(false);
    expect(open.body.plan.includedExpectedIncome).toBe(true);

    const onlySavings = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=20&accountId=${other.body.id}`, { headers: auth(home.token) }));
    expect(onlySavings.body.cash.endingMinor).toBe(0);
    expect(onlySavings.body.plan.endingMinor).toBe(0);
    const onlyChecking = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=20&accountId=${account.body.id}`, { headers: auth(home.token) }));
    expect(onlyChecking.body.cash.endingMinor).toBe(96000);
    expect(onlyChecking.body.plan.endingMinor).toBe(121000);

    await json(await api.request(`/api/households/${home.hid}/transactions`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({
        date: "2026-11-12", accountId: account.body.id, amountMinor: -4000, type: "expense", payee: "Power", scheduleId: bill.body.id,
        splits: [{ bucketId: home.groceries, amountMinor: 4000, role: "expense" }], opId: "pay-power-1", reviewStatus: "reviewed",
      }),
    }));
    const paid = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=20&accountId=${account.body.id}`, { headers: auth(home.token) }));
    expect(paid.body.cash.endingMinor).toBe(96000);

    await json(await api.request(`/api/households/${home.hid}/income-sources/${source.body.id}/receive`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ expectedDate: "2026-11-18", opId: "receive-side-1", mode: "full", amountMinor: 25000, receivedDate: "2026-11-10" }),
    }));
    const received = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=20&accountId=${account.body.id}`, { headers: auth(home.token) }));
    expect(received.body.plan.endingMinor - received.body.cash.endingMinor).toBe(0);
    const beforeScenario = await snapshot(api, home);
    const scenario = await json(await api.request(`/api/households/${home.hid}/scenarios`, {
      method: "POST",
      headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Extra", days: 20, save: true, adjustments: [{ id: "extra", label: "Extra", date: "2026-11-15", amountMinor: -1000, kind: "expense" }] }),
    }));
    expect(scenario.status).toBe(200);
    expect(scenario.body.note).toMatch(/not part of the ledger/i);
    expect(await snapshot(api, home)).toEqual(beforeScenario);

    const guest = await household(api, "guest@example.com");
    await checking(api, home, 50000, "Private savings", "private");
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'editor',$3)`, [home.hid, guest.userId, new Date().toISOString()]);
    const owner = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=5`, { headers: auth(home.token) }));
    const member = await json(await api.request(`/api/households/${home.hid}/forecast?asOf=2026-11-10&days=5`, { headers: auth(guest.token) }));
    expect(owner.body.cash.startingMinor - member.body.cash.startingMinor).toBe(50000);
  });
});

function num(value: unknown): number {
  return Number(value);
}
