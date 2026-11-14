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
  const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
  return { token, hid, spaceId: dash.body.spaceId as string, dash: dash.body };
}

const csv = [
  "Date,Payee,Amount,Splits,Notes,Tags,Balance,Original Description,Check Number",
  "2026-11-02,Market,-8.80,Groceries:5.50|Household:3.30,weekly shop,food|home,91.20,MARKET 123,1002",
  "2026-11-03,Payroll,12.00,Paychecks:12.00,salary,,,ACME PAY,",
].join("\n");

describe("guided import", () => {
  it("retains every bank column, scopes CSV ids to an account, and protects private source details", async () => {
    const api = await app();
    const home = await household(api, "bank-import@example.com");
    const path = `/api/households/${home.hid}`;
    const post = async (url: string, body: unknown) => json(await api.request(path + url, { method: "POST", headers: auth(home.token), body: JSON.stringify(body) }));
    const account = await post("/accounts", { spaceId: home.spaceId, name: "Bank", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01", visibility: "private" });
    const otherAccount = await post("/accounts", { spaceId: home.spaceId, name: "Second bank", kind: "checking", onBudget: true, openingBalanceMinor: 0, openingDate: "2026-11-01", visibility: "private" });
    const columns = ["Transaction ID", "Posting Date", "Effective Date", "Transaction Type", "Posting Status", "Amount", "Check Number", "Reference Number", "Description", "Transaction Category", "Type", "Balance", "Memo", "Extended Description"];
    const values = ["001,002", "11/14/2026", "", "Check", "Posted", "-12.34000", "0007", "000009", "Sample shop", "Shopping", "", "987.66000", "keep this", "Sample extended description"];
    const text = [columns, values].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
    const before = await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [home.hid]);
    const preview = await post("/import/preview", { spaceId: home.spaceId, accountId: account.body.id, format: "csv", text });
    expect(preview.status).toBe(200);
    expect(preview.body.rows[0].errors).toEqual([]);
    expect(preview.body.columnCoverage).toHaveLength(14);
    expect(await db.query(`SELECT count(*) AS n FROM transactions WHERE household_id = $1`, [home.hid])).toEqual(before);
    const commit = await post(`/import/${preview.body.batchId}/commit`, { accountId: account.body.id, rowNumbers: [2] });
    expect(commit.status).toBe(200);
    expect(commit.body.created).toBe(1);
    const txnId = commit.body.transactionIds[0];
    const source = await json(await api.request(`${path}/transactions/${txnId}/import-source`, { headers: auth(home.token) }));
    expect(source.body.rows[0].cells).toEqual(columns.map((column, i) => ({ column, value: values[i] })));
    const ledger = await db.query(`SELECT amount_minor, bank_status, check_number, original_description FROM transactions WHERE id = $1`, [txnId]);
    expect(ledger[0]).toMatchObject({ amount_minor: -1234, bank_status: "posted", check_number: "0007", original_description: values[13] });
    const repreview = await post("/import/preview", { spaceId: home.spaceId, accountId: account.body.id, format: "csv", text });
    expect(repreview.body.rows[0].duplicate).toBe(true);
    const again = await post(`/import/${repreview.body.batchId}/commit`, { accountId: account.body.id, rowNumbers: [2] });
    expect(again.body.created).toBe(0);
    const different = await post("/import/preview", { spaceId: home.spaceId, accountId: otherAccount.body.id, format: "csv", text });
    expect(different.body.rows[0].duplicate).toBe(false);
    expect((await post(`/import/${different.body.batchId}/commit`, { accountId: otherAccount.body.id, rowNumbers: [2] })).body.created).toBe(1);
    // Give another person membership without access to the private source account.
    const outsider = await household(api, "bank-viewer@example.com");
    const users = await db.query(`SELECT id FROM users WHERE email = $1`, ["bank-viewer@example.com"]);
    await db.query(`INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1,$2,'editor',$3)`, [home.hid, users[0].id, new Date().toISOString()]);
    expect((await json(await api.request(`${path}/transactions/${txnId}/import-source`, { headers: auth(outsider.token) }))).status).toBe(404);
    const hiddenPreview = await json(await api.request(`${path}/import/preview`, { method: "POST", headers: auth(outsider.token), body: JSON.stringify({ spaceId: home.spaceId, format: "csv", text }) }));
    // Neither private bank record is revealed by a duplicate or similarity hint.
    expect(hiddenPreview.body.rows[0].duplicate).toBe(false);
    expect(hiddenPreview.body.rows[0].possibleMatch).toBe(false);
  });

  it("requires an explicit transfer decision and does not count transfers as spending", async () => {
    const api = await app();
    const home = await household(api, "bank-transfers@example.com");
    const path = `/api/households/${home.hid}`;
    const post = async (url: string, body: unknown) => json(await api.request(path + url, { method: "POST", headers: auth(home.token), body: JSON.stringify(body) }));
    const a = await post("/accounts", { spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" });
    const b = await post("/accounts", { spaceId: home.spaceId, name: "Savings", kind: "savings", onBudget: true, openingBalanceMinor: 0, openingDate: "2026-11-01" });
    const preview = await post("/import/preview", { spaceId: home.spaceId, accountId: a.body.id, format: "csv", text: "Transaction ID,Posting Date,Amount,Transaction Category,Description\nmove-1,11/14/2026,-10.00000,Transfers,Savings transfer" });
    const commitPath = `/import/${preview.body.batchId}/commit`;
    expect((await post(commitPath, { accountId: a.body.id, rowNumbers: [2] })).status).toBe(400);
    expect((await post(commitPath, { accountId: a.body.id, rowNumbers: [2], transferChoices: { "row:2": a.body.id } })).status).toBe(400);
    const done = await post(commitPath, { accountId: a.body.id, rowNumbers: [2], transferChoices: { "row:2": b.body.id } });
    expect(done.status).toBe(200);
    expect((await db.query(`SELECT type, counter_account_id FROM transactions WHERE id = $1`, [done.body.transactionIds[0]]))[0]).toMatchObject({ type: "transfer", counter_account_id: b.body.id });
    const dashboard = await json(await api.request(`${path}/dashboard?asOf=2026-11-20`, { headers: auth(home.token) }));
    expect(dashboard.body.budget.cashPoolMinor).toBe(10000);
    expect(dashboard.body.budget.spendingMinor).toBe(0);
  });

  it("previews without posting, confirms one split expense, and a retry does not duplicate it", async () => {
    const api = await app();
    const home = await household(api, "import@example.com");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const before = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20`, { headers: auth(home.token) }));
    const preview = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "csv", text: csv }),
    }));
    expect(preview.status).toBe(200);
    expect(preview.body.note).toContain("Nothing was posted");
    expect(preview.body.note).toContain("not a lossless");
    expect(preview.body.balances[0].balanceMinor).toBe(9120);
    expect(preview.body.groups[0].splits).toHaveLength(2);
    expect(preview.body.categories.find((item: { name: string }) => item.name === "Groceries").match.name).toBe("Groceries");
    const during = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20`, { headers: auth(home.token) }));
    expect(during.body.budget.cashPoolMinor).toBe(before.body.budget.cashPoolMinor);
    expect(during.body.budget.spendingMinor).toBe(before.body.budget.spendingMinor);
    const rowNumbers = preview.body.groups.filter((group: { errors: string[] }) => !group.errors.length).flatMap((group: { rowNumbers: number[] }) => group.rowNumbers);
    const committed = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers }),
    }));
    expect(committed.status).toBe(200);
    expect(committed.body.created).toBe(2);
    expect(committed.body.duplicate).toBe(false);
    const again = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers }),
    }));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.created).toBe(2);
    const recent = await json(await api.request(`/api/households/${home.hid}/import/recent?spaceId=${home.spaceId}`, { headers: auth(home.token) }));
    expect(recent.body.batch.id).toBe(preview.body.batchId);
    expect(recent.body.batch.status).toBe("committed");
    expect(recent.body.batch.commit.rowNumbers).toEqual(rowNumbers);
    const changed = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: [rowNumbers[0]] }),
    }));
    expect(changed.status).toBe(409);
    const list = await json(await api.request(`/api/households/${home.hid}/transactions?limit=20`, { headers: auth(home.token) }));
    const market = list.body.transactions.find((txn: { payee: string }) => txn.payee === "Market");
    expect(market.amountMinor).toBe(-880);
    expect(market.notes).toBe("weekly shop");
    expect([...market.tags].sort()).toEqual(["food", "home"]);
    expect(market.checkNumber).toBe("1002");
    expect(market.originalDescription).toBe("MARKET 123");
    expect(market.splits.map((split: { amountMinor: number }) => split.amountMinor).sort()).toEqual([330, 550]);
    expect(list.body.transactions.filter((txn: { payee: string }) => txn.payee === "Market")).toHaveLength(1);
    const spending = await json(await api.request(`/api/households/${home.hid}/reports/spending?asOf=2026-11-20&from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    expect(spending.body.totalMinor).toBe(880);
    const byName = Object.fromEntries(spending.body.rows.map((row: { label: string; amountMinor: number }) => [row.label, row.amountMinor]));
    expect(byName.Groceries).toBe(550);
    expect(byName.Household).toBe(330);
    const after = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20`, { headers: auth(home.token) }));
    expect(after.body.budget.cashPoolMinor).toBe(before.body.budget.cashPoolMinor + 1200 - 880);
    expect(after.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor + 1200);
    expect(after.body.budget.spendingMinor).toBe(880);
    const undone = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/revert`, { method: "POST", headers: auth(home.token) }));
    expect(undone.body.reverted).toBe(2);
    const restored = await json(await api.request(`/api/households/${home.hid}/dashboard?asOf=2026-11-20`, { headers: auth(home.token) }));
    expect(restored.body.budget.cashPoolMinor).toBe(before.body.budget.cashPoolMinor);
    expect(restored.body.budget.spendingMinor).toBe(0);
    const twice = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/revert`, { method: "POST", headers: auth(home.token) }));
    expect(twice.body.already).toBe(true);
    const blocked = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers }),
    }));
    expect(blocked.status).toBe(409);
  });

  it("refuses an unmapped category, creates a missing one, and keeps an edited or reconciled row", async () => {
    const api = await app();
    const home = await household(api, "import-map@example.com");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 5000, openingDate: "2026-11-01" }),
    }));
    const other = await household(api, "import-other@example.com");
    const foreign = await json(await api.request(`/api/households/${other.hid}/dashboard?asOf=2026-11-20`, { headers: auth(other.token) }));
    const foreignBucket = foreign.body.buckets.find((bucket: { name: string }) => bucket.name === "Groceries").id;
    const pets = "Date,Description,Amount,Category\n2026-11-04,Vet,-6.00,Pets\n";
    const preview = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "csv", profile: "mint", text: pets }),
    }));
    const rows = preview.body.rows.map((row: { rowNumber: number }) => row.rowNumber);
    const unmapped = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: rows }),
    }));
    expect(unmapped.status).toBe(400);
    expect(unmapped.body.error).toContain("Pets");
    const wrong = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: rows, categoryMap: { Pets: foreignBucket } }),
    }));
    expect(wrong.status).toBe(400);
    const created = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: rows, createMissingCategories: true }),
    }));
    expect(created.status).toBe(200);
    expect(created.body.createdCategories[0].name).toBe("Pets");
    const listed = await json(await api.request(`/api/households/${home.hid}/transactions?limit=20`, { headers: auth(home.token) }));
    const vet = listed.body.transactions.find((txn: { payee: string }) => txn.payee === "Vet");
    await json(await api.request(`/api/households/${home.hid}/transactions/${vet.id}`, {
      method: "PATCH", headers: auth(home.token),
      body: JSON.stringify({ version: vet.version, notes: "edited after import" }),
    }));
    const kept = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/revert`, { method: "POST", headers: auth(home.token) }));
    expect(kept.body.reverted).toBe(0);
    expect(kept.body.kept[0].reason).toContain("edited");
    const still = await json(await api.request(`/api/households/${home.hid}/transactions?limit=20`, { headers: auth(home.token) }));
    expect(still.body.transactions.some((txn: { payee: string }) => txn.payee === "Vet")).toBe(true);

    const second = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "csv", text: "Date,Payee,Amount,Category\n2026-11-05,Lock,-2.00,Groceries\n" }),
    }));
    const lockedRows = second.body.rows.map((row: { rowNumber: number }) => row.rowNumber);
    const posted = await json(await api.request(`/api/households/${home.hid}/import/${second.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: lockedRows }),
    }));
    expect(posted.body.created).toBe(1);
    const txns = await json(await api.request(`/api/households/${home.hid}/transactions?limit=20`, { headers: auth(home.token) }));
    const lock = txns.body.transactions.find((txn: { payee: string }) => txn.payee === "Lock");
    await db.query(`UPDATE transactions SET reconciled = 1, locked = 1 WHERE id = $1`, [lock.id]);
    const protectedRow = await json(await api.request(`/api/households/${home.hid}/import/${second.body.batchId}/revert`, { method: "POST", headers: auth(home.token) }));
    expect(protectedRow.body.reverted).toBe(0);
    expect(protectedRow.body.kept[0].reason).toContain("reconciled");
    const currency = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "csv", text: "Date,Payee,Amount,Currency\n2026-11-06,Euro,-1.00,EUR\n" }),
    }));
    const rejected = await json(await api.request(`/api/households/${home.hid}/import/${currency.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: [currency.body.rows[0].rowNumber] }),
    }));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("does not convert");
    const partial = [
      "Date,Payee,Amount,Category,Split Group",
      "2026-11-07,Store,-5.00,Groceries,g1",
      "2026-11-07,Store,-3.00,Household,g1",
    ].join("\n");
    const grouped = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "csv", text: partial }),
    }));
    expect(grouped.body.groups).toHaveLength(1);
    const half = await json(await api.request(`/api/households/${home.hid}/import/${grouped.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: [grouped.body.rows[0].rowNumber] }),
    }));
    expect(half.status).toBe(400);
    expect(half.body.error).toContain("every line");
  });

  it("does not import a provider id twice and explains a QIF split", async () => {
    const api = await app();
    const home = await household(api, "import-ofx@example.com");
    const account = await json(await api.request(`/api/households/${home.hid}/accounts`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 8000, openingDate: "2026-11-01" }),
    }));
    const ofx = "<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261102<TRNAMT>-8.00<FITID>bank-1<NAME>Cafe<MEMO>note</STMTTRN></OFX>";
    const preview = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "ofx", text: ofx }),
    }));
    expect(preview.body.explanations.join(" ")).toContain("no categories");
    const first = await json(await api.request(`/api/households/${home.hid}/import/${preview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: [preview.body.rows[0].rowNumber] }),
    }));
    expect(first.body.created).toBe(1);
    const secondPreview = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "ofx", text: ofx }),
    }));
    expect(secondPreview.body.rows[0].duplicate).toBe(true);
    const second = await json(await api.request(`/api/households/${home.hid}/import/${secondPreview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: [secondPreview.body.rows[0].rowNumber] }),
    }));
    expect(second.body.created).toBe(0);
    const list = await json(await api.request(`/api/households/${home.hid}/transactions?limit=20`, { headers: auth(home.token) }));
    const cafes = list.body.transactions.filter((txn: { providerTransactionId?: string }) => txn.providerTransactionId === "bank-1");
    expect(cafes).toHaveLength(1);
    expect(cafes[0].notes).toBe("note");
    const qif = "D11/02/2026\nPMarket\nT-8.80\nMweekly\nLSplit\nSGroceries\n$-5.50\nSHousehold\n$-3.30\n^\n";
    const qifPreview = await json(await api.request(`/api/households/${home.hid}/import/preview`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ spaceId: home.spaceId, format: "qif", text: qif }),
    }));
    const qifCommit = await json(await api.request(`/api/households/${home.hid}/import/${qifPreview.body.batchId}/commit`, {
      method: "POST", headers: auth(home.token),
      body: JSON.stringify({ accountId: account.body.id, rowNumbers: qifPreview.body.rows.map((row: { rowNumber: number }) => row.rowNumber) }),
    }));
    expect(qifCommit.body.created).toBe(1);
    const spending = await json(await api.request(`/api/households/${home.hid}/reports/spending?asOf=2026-11-20&from=2026-11-01&to=2026-11-30`, { headers: auth(home.token) }));
    const groceries = spending.body.rows.find((row: { label: string }) => row.label === "Groceries");
    const householdRow = spending.body.rows.find((row: { label: string }) => row.label === "Household");
    expect(groceries.amountMinor).toBe(550);
    expect(householdRow.amountMinor).toBe(330);
  });
});
