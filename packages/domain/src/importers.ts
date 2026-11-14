import { sanitizeSpreadsheetCell } from "./money.js";
import type { TransactionType } from "./types.js";

export interface ImportSplitDraft {
  category: string;
  /** Positive magnitude in minor units. */
  amountMinor: number;
  role: "expense" | "income" | "refund";
  memo?: string;
}

export interface ImportRow {
  rowNumber: number;
  /** Original cells, including blank and unrecognized columns, in file order. */
  sourceCells?: { column: string; value: string }[];
  effectiveDate?: string;
  bankCategory?: string;
  bankStatus?: "pending" | "posted";
  transactionType?: string;
  referenceNumber?: string;
  requiresTransferReview?: boolean;
  date?: string;
  amountMinor?: number;
  payee?: string;
  description?: string;
  category?: string;
  account?: string;
  notes?: string;
  checkNumber?: string;
  tags?: string[];
  splitLabel?: string;
  splits?: ImportSplitDraft[];
  splitGroup?: string;
  currency?: string;
  observedBalanceMinor?: number;
  opening?: boolean;
  fitId?: string;
  errors: string[];
  warnings: string[];
  duplicateKey?: string;
  groupKey?: string;
}

export interface ImportGroup {
  groupKey: string;
  rowNumbers: number[];
  date?: string;
  amountMinor?: number;
  payee: string;
  originalDescription?: string;
  notes?: string;
  tags: string[];
  checkNumber?: string;
  currency?: string;
  account?: string;
  fitId?: string;
  bankStatus?: "pending" | "posted";
  bankCategory?: string;
  requiresTransferReview?: boolean;
  csvSource?: boolean;
  opening: boolean;
  splits: ImportSplitDraft[];
  observedBalanceMinor?: number;
  errors: string[];
  warnings: string[];
  duplicateKey?: string;
}

export interface ColumnMap {
  transactionId?: string;
  effectiveDate?: string;
  transactionType?: string;
  postingStatus?: string;
  referenceNumber?: string;
  bankCategory?: string;
  date?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  payee?: string;
  description?: string;
  category?: string;
  account?: string;
  notes?: string;
  checkNumber?: string;
  tags?: string;
  splits?: string;
  splitGroup?: string;
  balance?: string;
  currency?: string;
  inflowSign?: "positive_in" | "positive_out";
}

export interface ImportParseOptions {
  dateOrder?: "mdy" | "dmy";
  decimal?: "period" | "comma";
  inflowSign?: "positive_in" | "positive_out";
}

export const IMPORT_PROFILES: { id: string; label: string; map: ColumnMap; missing: string[] }[] = [
  {
    id: "amfirst", label: "America’s First Federal Credit Union",
    map: { date: "Posting Date", effectiveDate: "Effective Date", amount: "Amount", payee: "Description", description: "Extended Description", bankCategory: "Transaction Category", notes: "Memo", balance: "Balance", checkNumber: "Check Number", transactionId: "Transaction ID", transactionType: "Transaction Type", postingStatus: "Posting Status", referenceNumber: "Reference Number" },
    missing: ["Bank categories are kept as reference details. They do not automatically create budget categories. Transfers and credit-card payments need an account decision before import."],
  },
  {
    id: "mint",
    label: "Mint CSV",
    map: { date: "Date", amount: "Amount", payee: "Description", description: "Original Description", category: "Category", account: "Account Name", notes: "Notes", tags: "Labels" },
    missing: [
      "Mint transaction files usually have no split lines and no split-group id. Each row stays its own transaction unless a Splits or Split Group column is mapped.",
      "Pending status and a balance history are not invented when the file does not contain them.",
    ],
  },
  {
    id: "ynab",
    label: "YNAB register CSV",
    map: { date: "Date", payee: "Payee", category: "Category", notes: "Memo", description: "Memo", debit: "Outflow", credit: "Inflow", account: "Account" },
    missing: [
      "Budget assignments and targets are not in the register export.",
      "YNAB lists each split as its own row and does not include a split-group id. Those rows stay separate unless you map a Split Group column. A Splits column of Category:amount pairs is kept as one transaction.",
    ],
  },
  {
    id: "monarch",
    label: "Monarch CSV",
    map: { date: "Date", payee: "Merchant", amount: "Amount", category: "Category", account: "Account", notes: "Notes", tags: "Tags" },
    missing: [
      "Institution connection ids and household permissions are not in the file.",
      "Splits are kept only when a Splits or Split Group column is present. They are not guessed from the merchant.",
    ],
  },
  {
    id: "simplifi",
    label: "Simplifi CSV",
    map: { date: "Date", payee: "Payee", amount: "Amount", category: "Category", account: "Account", tags: "Tags", notes: "Notes" },
    missing: ["Watchlists and spending-plan settings are not transaction fields. Splits are kept only from a Splits or Split Group column."],
  },
  {
    id: "rocket",
    label: "Rocket Money CSV",
    map: { date: "Date", payee: "Name", description: "Description", amount: "Amount", category: "Category", account: "Account" },
    missing: ["Negotiation cases, credit-report fields, tags, notes, and splits are not in a typical transaction CSV and are not invented."],
  },
  {
    id: "everydollar",
    label: "EveryDollar CSV",
    map: { date: "Date", payee: "Payee", amount: "Amount", category: "Budget Item", notes: "Memo" },
    missing: ["The export does not include bank-provider ids, tags, or splits. Those stay blank."],
  },
  {
    id: "empower",
    label: "Empower / Personal Capital CSV",
    map: { date: "Date", payee: "Description", amount: "Amount", category: "Category", account: "Account" },
    missing: ["Holdings and fee breakdowns need the investment export, not the transaction file. Tags and splits are not invented."],
  },
  {
    id: "goodbudget",
    label: "Goodbudget CSV",
    map: { date: "Date", payee: "Payee", amount: "Amount", category: "Envelope", account: "Account", notes: "Notes", checkNumber: "Check Number" },
    missing: ["Envelope fill templates are not reconstructed unless they appear as transactions. Splits need a Splits or Split Group column."],
  },
];

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (quoted) throw new Error("The CSV has an unfinished quoted field. Export it again before importing.");
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function parseAmount(raw: string, decimal: "period" | "comma" = "period"): number | undefined {
  let cleaned = raw.trim().replace(/[\s$€£]/g, "");
  if (!cleaned) return undefined;
  cleaned = cleaned.replace(/^(USD|EUR|GBP|CAD|AUD)\s*/i, "");
  const paren = cleaned.match(/^\((.+)\)$/);
  let negative = false;
  if (paren) {
    negative = true;
    cleaned = paren[1];
  }
  if (cleaned.startsWith("+")) cleaned = cleaned.slice(1);
  if (cleaned.startsWith("-")) {
    negative = !negative;
    cleaned = cleaned.slice(1);
  }
  if (decimal === "comma") cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  else cleaned = cleaned.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const [whole, frac = ""] = cleaned.split(".");
  // Bank exports often pad cents to five decimal places. Never round money away.
  if (/[1-9]/.test(frac.slice(2))) return undefined;
  const padded = frac.padEnd(3, "0");
  let minor = BigInt(whole) * 100n + BigInt(padded.slice(0, 2) || "0");
  if (padded[2] >= "5") minor += 1n;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const value = Number(minor);
  return negative ? -value : value;
}

function tidy(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function isOpening(payee?: string, category?: string): boolean {
  return /^(starting balance|opening balance|initial balance)$/i.test(payee ?? "") || /^(starting balance|opening balance|initial balance)$/i.test(category ?? "");
}

export function netOutflow(splits: ImportSplitDraft[]): number {
  return splits.reduce((sum, split) => sum + (split.role === "income" || split.role === "refund" ? -split.amountMinor : split.amountMinor), 0);
}

function validIso(iso: string): boolean {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeDate(raw: string, order: "mdy" | "dmy"): { date?: string; error?: string } {
  const value = raw.trim();
  if (!value) return { error: "Date is missing or not YYYY-MM-DD or M/D/YYYY." };
  let iso = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) iso = value;
  else if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) iso = value.replace(/\//g, "-");
  else {
    const parts = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!parts) return { error: "Date is missing or not YYYY-MM-DD or M/D/YYYY." };
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    if (order === "mdy" && first > 12) return { error: "This date does not match month/day/year." };
    if (order === "dmy" && second > 12) return { error: "This date does not match day/month/year." };
    const month = order === "mdy" ? first : second;
    const day = order === "mdy" ? second : first;
    iso = `${parts[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (!validIso(iso)) return { error: "That date is not a real calendar date." };
  return { date: iso };
}

export function withHeaderDefaults(header: string[], map: ColumnMap): ColumnMap {
  const next: ColumnMap = { ...map };
  const has = (name: string) => header.some((cell) => cell.trim().toLowerCase() === name.toLowerCase());
  const fill = (key: keyof ColumnMap, names: string[]) => {
    if (next[key]) return;
    const found = names.find((name) => has(name));
    if (found) next[key] = found as never;
  };
  fill("date", ["Date", "Posting Date", "Posted Date", "Transaction Date"]);
  fill("payee", ["Payee", "Merchant", "Name", "Description"]);
  fill("description", ["Original Description", "Extended Description"]);
  fill("transactionId", ["Transaction ID"]);
  fill("effectiveDate", ["Effective Date"]);
  fill("transactionType", ["Transaction Type"]);
  fill("postingStatus", ["Posting Status"]);
  fill("referenceNumber", ["Reference Number"]);
  fill("bankCategory", ["Transaction Category"]);
  fill("category", ["Category", "Envelope", "Budget Item"]);
  fill("notes", ["Notes", "Memo"]);
  fill("tags", ["Tags", "Labels"]);
  fill("splits", ["Splits"]);
  fill("splitGroup", ["Split Group"]);
  fill("balance", ["Balance"]);
  fill("checkNumber", ["Check Number"]);
  fill("currency", ["Currency"]);
  fill("account", ["Account", "Account Name"]);
  if (!next.amount && !next.debit && !next.credit) fill("amount", ["Amount"]);
  if (!next.amount && !next.debit) fill("debit", ["Outflow", "Debit"]);
  if (!next.amount && !next.credit) fill("credit", ["Inflow", "Credit"]);
  return next;
}

export function resolvedColumnMap(text: string, map: ColumnMap): ColumnMap {
  const table = parseCsv(text);
  const header = table[0]?.map((cell) => cell.trim()) ?? [];
  return withHeaderDefaults(header, map);
}

function parseSplitTokens(raw: string, parentMinor: number, decimal: "period" | "comma"): { splits: ImportSplitDraft[]; error?: string } {
  const parts = raw.split(/[|;]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { splits: [], error: "A split must look like Category:1.00." };
  const splits: ImportSplitDraft[] = [];
  for (const part of parts) {
    const colon = part.lastIndexOf(":");
    if (colon <= 0) return { splits: [], error: "A split must look like Category:1.00." };
    const category = tidy(part.slice(0, colon));
    const signed = parseAmount(part.slice(colon + 1), decimal);
    if (!category || category.length > 80 || signed == null || signed === 0) return { splits: [], error: "A split amount could not be read." };
    const role = signed < 0 ? (parentMinor >= 0 ? "expense" : "refund") : parentMinor >= 0 ? "income" : "expense";
    splits.push({ category, amountMinor: Math.abs(signed), role });
  }
  const net = netOutflow(splits);
  if (net !== -parentMinor) {
    return {
      splits,
      error: `The split amounts net to ${net} outflow and the transaction requires ${-parentMinor}. The difference was not assigned to a category.`,
    };
  }
  return { splits };
}

export function mapCsv(text: string, map: ColumnMap, options: ImportParseOptions = {}): ImportRow[] {
  const table = parseCsv(text);
  if (!table.length) return [];
  const header = table[0].map((cell) => cell.trim());
  const resolved = withHeaderDefaults(header, map);
  const decimal = options.decimal ?? "period";
  const dateOrder = options.dateOrder ?? "mdy";
  const sign = options.inflowSign ?? resolved.inflowSign;
  const index = (name?: string) => (name ? header.findIndex((cell) => cell.toLowerCase() === name.toLowerCase()) : -1);
  return table.slice(1).map((cells, offset) => {
    const get = (name?: string) => {
      const i = index(name);
      return i >= 0 ? cells[i] ?? "" : "";
    };
    const errors: string[] = [];
    const warnings: string[] = [];
    if (cells.length !== header.length) errors.push("The row has a different number of cells than the header. Nothing on this row can be imported.");
    if (new Set(header.map((name) => name.toLowerCase())).size !== header.length) errors.push("The CSV has repeated column names. Give each column a unique name.");
    const parsedDate = normalizeDate(get(resolved.date), dateOrder);
    if (parsedDate.error) errors.push(parsedDate.error);
    const debitHeader = index(resolved.debit) >= 0;
    const creditHeader = index(resolved.credit) >= 0;
    let amount: number | undefined;
    if (debitHeader || creditHeader) {
      const debitRaw = get(resolved.debit).trim();
      const creditRaw = get(resolved.credit).trim();
      if (!debitRaw && !creditRaw) {
        const amountRaw = get(resolved.amount).trim();
        amount = amountRaw ? parseAmount(amountRaw, decimal) : undefined;
        if (amount == null) errors.push("Amount could not be read as a number.");
      } else {
        const debit = debitRaw ? parseAmount(debitRaw, decimal) : 0;
        const credit = creditRaw ? parseAmount(creditRaw, decimal) : 0;
        if ((debitRaw && debit == null) || (creditRaw && credit == null)) errors.push("Amount could not be read as a number.");
        else amount = (credit ?? 0) - Math.abs(debit ?? 0);
      }
    } else {
      amount = parseAmount(get(resolved.amount), decimal);
      if (amount == null) errors.push("Amount could not be read as a number.");
    }
    if (sign === "positive_out" && amount != null) amount = -amount;
    if (amount === 0) errors.push("Amount is zero.");
    const transactionType = tidy(get(resolved.transactionType));
    if (amount != null && ((/^(debit|check)$/i.test(transactionType) && amount > 0) || (/^credit$/i.test(transactionType) && amount < 0))) errors.push("The amount sign disagrees with Transaction Type. Check the sign setting before importing.");
    const postingStatus = tidy(get(resolved.postingStatus)).toLowerCase();
    const bankStatus = postingStatus === "pending" ? "pending" : "posted";
    if (postingStatus && !["pending", "posted", "cleared"].includes(postingStatus)) errors.push("Posting status is not recognized. This row was not treated as posted.");
    const effectiveRaw = get(resolved.effectiveDate).trim();
    const effective = effectiveRaw ? normalizeDate(effectiveRaw, dateOrder) : undefined;
    if (effective?.error) errors.push(`Effective date: ${effective.error}`);
    const bankCategory = tidy(get(resolved.bankCategory));
    const requiresTransferReview = /^(transfers?|credit card payments?)$/i.test(bankCategory) || /^(transfer|xfer)$/i.test(transactionType);
    if (requiresTransferReview) warnings.push("Choose the other account for this transfer or explicitly confirm it is ordinary income or spending. It is not selected automatically.");
    const payee = tidy(get(resolved.payee) || get(resolved.description));
    const description = tidy(get(resolved.description));
    const category = tidy(get(resolved.category));
    const notes = tidy(get(resolved.notes));
    const checkNumber = tidy(get(resolved.checkNumber));
    const account = tidy(get(resolved.account));
    const splitGroup = tidy(get(resolved.splitGroup));
    const currencyRaw = tidy(get(resolved.currency)).toUpperCase();
    let currency: string | undefined;
    if (currencyRaw) {
      if (!/^[A-Z]{3}$/.test(currencyRaw)) errors.push("Currency must be a 3-letter code. It was not converted.");
      else currency = currencyRaw;
    }
    const balanceRaw = get(resolved.balance).trim();
    const observedBalanceMinor = balanceRaw ? parseAmount(balanceRaw, decimal) : undefined;
    if (balanceRaw && observedBalanceMinor == null) warnings.push("A balance in the file could not be read and was not posted.");
    const tagCell = get(resolved.tags);
    const tags = tagCell
      ? tagCell.split(/[|;,]/).map((tag) => tidy(tag)).filter(Boolean)
      : undefined;
    if (tags?.some((tag) => tag.length > 40) || (tags?.length ?? 0) > 20) errors.push("Use at most 20 tags, each 40 characters or fewer.");
    const opening = isOpening(payee, category);
    let splits: ImportSplitDraft[] | undefined;
    const splitCell = get(resolved.splits).trim();
    if (!opening && splitCell && amount != null && !errors.some((error) => error.startsWith("Amount"))) {
      const parsed = parseSplitTokens(splitCell, amount, decimal);
      if (parsed.error) errors.push(parsed.error);
      splits = parsed.splits;
      if (category) warnings.push("The Splits column is used. The Category column on this row was not added again.");
    } else if (!opening && category && amount != null && !errors.some((error) => error.startsWith("Amount"))) {
      if (category.length > 80) errors.push("Category names are limited to 80 characters.");
      else splits = [{ category, amountMinor: Math.abs(amount), role: amount >= 0 ? "income" : "expense" }];
    }
    if (opening && category) warnings.push("An opening balance is not assigned to a category.");
    if (notes.length > 4000) errors.push("Notes are longer than 4,000 characters.");
    const row: ImportRow = {
      rowNumber: offset + 2,
      sourceCells: cells.map((value, i) => ({ column: header[i] ?? `Extra column ${i + 1}`, value })),
      fitId: get(resolved.transactionId).trim() || undefined,
      effectiveDate: effective?.date,
      referenceNumber: get(resolved.referenceNumber).trim() || undefined,
      transactionType: transactionType || undefined,
      bankCategory: bankCategory || undefined,
      bankStatus,
      requiresTransferReview,
      date: parsedDate.date,
      amountMinor: amount,
      payee: payee || undefined,
      description: description || undefined,
      category: category || undefined,
      account: account || undefined,
      notes: notes || undefined,
      checkNumber: checkNumber || undefined,
      tags,
      splitLabel: splitCell || undefined,
      splits,
      splitGroup: splitGroup || undefined,
      currency,
      observedBalanceMinor,
      opening,
      errors,
      warnings,
    };
    if (parsedDate.date && amount != null) row.duplicateKey = duplicateKey({ date: parsedDate.date, amountMinor: amount, description: payee, account: row.account ?? "" });
    return row;
  });
}

export function groupImportRows(rows: ImportRow[]): ImportGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const key = row.splitGroup ? `split:${row.splitGroup}` : `row:${row.rowNumber}`;
    row.groupKey = key;
    if (!buckets.has(key)) {
      order.push(key);
      buckets.set(key, []);
    }
    buckets.get(key)!.push(row);
  }
  return order.map((key) => buildGroup(key, buckets.get(key)!));
}

function buildGroup(groupKey: string, rows: ImportRow[]): ImportGroup {
  const errors = [...new Set(rows.flatMap((row) => row.errors))];
  const warnings = [...new Set(rows.flatMap((row) => row.warnings ?? []))];
  const dates = [...new Set(rows.map((row) => row.date).filter((date): date is string => !!date))];
  if (dates.length > 1) errors.push("Split rows must share one date.");
  const currencies = [...new Set(rows.map((row) => row.currency).filter((currency): currency is string => !!currency))];
  if (currencies.length > 1) errors.push("Split rows use more than one currency and were not combined.");
  const fitIds = [...new Set(rows.map((row) => row.fitId).filter((fitId): fitId is string => !!fitId))];
  if (fitIds.length > 1) errors.push("These rows have different provider ids and were not combined.");
  const amounts = rows.map((row) => row.amountMinor);
  const amount = amounts.every((value) => value != null) ? amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
  if (amount === 0 && !errors.includes("Amount is zero.")) errors.push("Amount is zero.");
  const payee = rows.map((row) => row.payee).find((value) => !!value) || "Imported";
  const original = rows.map((row) => row.description).find((value) => !!value && value !== payee);
  const notes = [...new Set(rows.map((row) => row.notes).filter((value): value is string => !!value))].join("\n");
  const tags = [...new Set(rows.flatMap((row) => row.tags ?? []))];
  const opening = rows.every((row) => row.opening);
  if (rows.some((row) => row.opening) && !opening) errors.push("An opening balance was mixed with other rows.");
  const categorized = rows.some((row) => (row.splits?.length ?? 0) > 0);
  const blank = rows.some((row) => (row.splits?.length ?? 0) === 0 && !row.opening);
  if (rows.length > 1 && categorized && blank) errors.push("A line in this split has no category. The remainder was not assigned to a category.");
  const splits = opening ? [] : rows.flatMap((row) => row.splits ?? []);
  if (!opening && splits.length && amount != null && !errors.some((error) => error.includes("split amounts") || error.includes("remainder"))) {
    const net = netOutflow(splits);
    if (net !== -amount) errors.push(`The split amounts net to ${net} outflow and the transaction requires ${-amount}. The difference was not assigned to a category.`);
  }
  const balanceRow = [...rows].reverse().find((row) => row.observedBalanceMinor != null);
  const date = dates[0];
  return {
    groupKey,
    rowNumbers: rows.map((row) => row.rowNumber),
    date,
    amountMinor: amount,
    payee,
    originalDescription: original,
    notes: notes || undefined,
    tags,
    checkNumber: rows.map((row) => row.checkNumber).find((value) => !!value),
    currency: currencies[0],
    account: rows.map((row) => row.account).find((value) => !!value),
    fitId: fitIds[0],
    bankStatus: rows.some((row) => row.bankStatus === "pending") ? "pending" : "posted",
    bankCategory: rows.map((row) => row.bankCategory).find(Boolean),
    requiresTransferReview: rows.some((row) => row.requiresTransferReview),
    csvSource: rows.some((row) => !!row.sourceCells),
    opening,
    splits,
    observedBalanceMinor: balanceRow?.observedBalanceMinor,
    errors,
    warnings,
    duplicateKey: date && amount != null ? duplicateKey({ date, amountMinor: amount, description: payee, account: "" }) : undefined,
  };
}

export interface ImportFieldReport {
  present: string[];
  absent: string[];
  balances: { account: string; date: string; balanceMinor: number }[];
  note: string;
}

export function importFieldReport(rows: ImportRow[], profileMissing: string[]): ImportFieldReport {
  const present: string[] = [];
  const absent = [...profileMissing];
  const has = (pred: (row: ImportRow) => boolean) => rows.some(pred);
  if (has((row) => !!row.bankCategory)) { present.push("bank categories (reference details)"); absent.push("Bank categories are preserved as reference details; assign your own budget categories after import. Transfers need an explicit account decision."); }
  if (has((row) => !!row.sourceCells)) present.push("all original CSV columns");
  if (has((row) => !!row.category || (row.splits?.length ?? 0) > 0)) present.push("categories");
  else absent.push(has((row) => !!row.bankCategory) ? "No budget category was mapped. The bank’s original category remains in the saved bank details." : "No category was in the file. Nothing is assigned to a category.");
  if (has((row) => (row.tags?.length ?? 0) > 0)) present.push("tags");
  else absent.push("No tags were in the file.");
  if (has((row) => !!row.notes)) present.push("notes");
  else absent.push("No notes were in the file.");
  if (has((row) => !!row.splitGroup || (row.splits?.length ?? 0) > 1)) present.push("splits");
  else absent.push("No split amounts were in the file. Each row stays its own transaction.");
  if (has((row) => row.observedBalanceMinor != null)) present.push("balances");
  else absent.push("No balance column was in the file. Historical balances are not reconstructed.");
  const byAccount = new Map<string, { account: string; date: string; balanceMinor: number }>();
  for (const row of rows) {
    if (row.observedBalanceMinor == null || !row.date) continue;
    const account = row.account || "";
    const current = byAccount.get(account);
    // Bank exports list the newest row first; do not substitute an earlier balance on the same day.
    if (!current || row.date > current.date) byAccount.set(account, { account: account || "This file", date: row.date, balanceMinor: row.observedBalanceMinor });
  }
  return {
    present,
    absent,
    balances: [...byAccount.values()],
    note: has((row) => !!row.bankCategory) ? "Every original CSV column is retained. Bank labels and running balances are reference details; budget assignments are not inferred." : "This is not a lossless copy of the other app. Settings, targets, and fields that were not in the file are left blank.",
  };
}

export function duplicateKey(input: { date: string; amountMinor: number; description: string; account: string }): string {
  const description = input.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${input.date}|${input.amountMinor}|${description}|${input.account.toLowerCase()}`;
}

export interface ParsedBankTxn {
  date: string;
  amountMinor: number;
  payee: string;
  fitId?: string;
  type: TransactionType;
  notes?: string;
  category?: string;
  checkNumber?: string;
  currency?: string;
  splits?: ImportSplitDraft[];
  errors?: string[];
  warnings?: string[];
}

function draftFromSigned(signed: number, parent: number, category: string, memo?: string): ImportSplitDraft | undefined {
  if (!category || signed === 0) return undefined;
  const role = signed < 0 ? "expense" : parent >= 0 ? "income" : "refund";
  return { category: tidy(category), amountMinor: Math.abs(signed), role, memo };
}

export function parseOfx(text: string): ParsedBankTxn[] {
  const fileCurrency = text.match(/<CURDEF>([A-Za-z]{3})/i)?.[1]?.toUpperCase();
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  return blocks.map((block) => {
    const pick = (tag: string) => block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, "i"))?.[1]?.trim() ?? "";
    const errors: string[] = [];
    const dateRaw = pick("DTPOSTED").slice(0, 8);
    const date = dateRaw.length === 8 ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}` : "";
    if (!date || !validIso(date)) errors.push("Date is missing or not YYYY-MM-DD or M/D/YYYY.");
    const parsed = parseAmount(pick("TRNAMT"));
    if (parsed == null) errors.push("Amount could not be read as a number.");
    const amount = parsed ?? 0;
    const name = tidy(pick("NAME"));
    const memo = tidy(pick("MEMO"));
    const currency = (pick("CURRENCY") || fileCurrency || "").toUpperCase();
    if (/^XFER$/i.test(pick("TRNTYPE"))) errors.push("This row is a transfer and the file does not name both accounts. It was not imported as income or spending.");
    return {
      date,
      amountMinor: amount,
      payee: name || memo || "Imported",
      notes: name && memo ? memo : undefined,
      fitId: pick("FITID") || undefined,
      checkNumber: tidy(pick("CHECKNUM") || pick("CHKNUM")) || undefined,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined,
      type: amount >= 0 ? "income" : "expense",
      errors,
    } satisfies ParsedBankTxn;
  });
}

export function parseQif(text: string): ParsedBankTxn[] {
  const records = text.split(/\^/).map((part) => part.trim()).filter(Boolean);
  const txns: ParsedBankTxn[] = [];
  for (const record of records) {
    if (record.startsWith("!")) continue;
    let date = "";
    let amount = 0;
    let amountSeen = false;
    let payee = "";
    let notes = "";
    let category = "";
    let checkNumber = "";
    const errors: string[] = [];
    const warnings: string[] = [];
    const signedSplits: { category: string; signed: number; memo?: string }[] = [];
    let pending: { category?: string; memo?: string; signed?: number } | null = null;
    const flush = () => {
      if (!pending) return;
      if (!pending.category || pending.signed == null) errors.push("A split line has no amount. The remainder was not assigned to a category.");
      else signedSplits.push({ category: pending.category, signed: pending.signed, memo: pending.memo });
      pending = null;
    };
    for (const line of record.split(/\r?\n/)) {
      if (!line) continue;
      const code = line[0];
      const value = line.slice(1).trim();
      if (code === "S" || code === "$" || code === "E") {
        if (code === "S") {
          flush();
          pending = { category: value };
        } else if (code === "$") {
          pending = pending ?? {};
          const parsed = parseAmount(value);
          if (parsed == null) errors.push("A split amount could not be read.");
          else pending.signed = parsed;
        } else if (code === "E") {
          pending = pending ?? {};
          pending.memo = tidy(value);
        }
        continue;
      }
      flush();
      if (line.startsWith("D")) {
        const parsed = normalizeDate(line.slice(1), "mdy");
        date = parsed.date ?? "";
        if (parsed.error) errors.push(parsed.error);
      } else if (line.startsWith("T") || line.startsWith("U")) {
        const parsed = parseAmount(line.slice(1));
        amountSeen = true;
        if (parsed == null) errors.push("Amount could not be read as a number.");
        else amount = parsed;
      } else if (line.startsWith("P")) payee = tidy(line.slice(1));
      else if (line.startsWith("M")) notes = tidy(line.slice(1));
      else if (line.startsWith("L")) category = tidy(line.slice(1));
      else if (line.startsWith("N")) checkNumber = tidy(line.slice(1));
    }
    flush();
    if (!date && !amountSeen && !payee) continue;
    const splits: ImportSplitDraft[] = [];
    if (category.startsWith("[")) errors.push("This row names a transfer account and not both sides. It was not imported as income or spending.");
    else if (signedSplits.length) {
      const signedSum = signedSplits.reduce((sum, split) => sum + split.signed, 0);
      if (signedSum !== amount) errors.push(`The split amounts net to ${-signedSum} outflow and the transaction requires ${-amount}. The difference was not assigned to a category.`);
      for (const split of signedSplits) {
        const draft = draftFromSigned(split.signed, amount, split.category, split.memo);
        if (draft) splits.push(draft);
      }
      if (category && !/^split$/i.test(category)) warnings.push("The category on the split transaction was not added again.");
    }
    txns.push({
      date,
      amountMinor: amount,
      payee: payee || "Imported",
      notes: notes || undefined,
      category: category || undefined,
      checkNumber: checkNumber || undefined,
      splits: splits.length ? splits : undefined,
      type: amount >= 0 ? "income" : "expense",
      errors,
      warnings,
    });
  }
  return txns;
}

export function rowsFromBank(txns: ParsedBankTxn[]): ImportRow[] {
  return txns.map((txn, index) => {
    const errors = [...(txn.errors ?? [])];
    const warnings = [...(txn.warnings ?? [])];
    if (!txn.date) {
      if (!errors.some((error) => error.startsWith("Date"))) errors.push("Date is missing or not YYYY-MM-DD or M/D/YYYY.");
    } else if (!validIso(txn.date)) errors.push("That date is not a real calendar date.");
    if (!errors.some((error) => error.startsWith("Amount")) && txn.amountMinor === 0) errors.push("Amount is zero.");
    const payee = tidy(txn.payee || "") || "Imported";
    const opening = isOpening(payee, txn.category);
    let splits = txn.splits ? [...txn.splits] : [];
    const transfer = txn.category?.startsWith("[") || errors.some((error) => error.includes("transfer"));
    if (!opening && !transfer && !splits.length && txn.category && txn.amountMinor !== 0) {
      if (txn.category.length > 80) errors.push("Category names are limited to 80 characters.");
      else splits = [{ category: tidy(txn.category), amountMinor: Math.abs(txn.amountMinor), role: txn.amountMinor >= 0 ? "income" : "expense" }];
    }
    if (opening) splits = [];
    const row: ImportRow = {
      rowNumber: index + 1,
      date: txn.date || undefined,
      amountMinor: txn.amountMinor,
      payee,
      notes: txn.notes,
      category: txn.category,
      checkNumber: txn.checkNumber,
      currency: txn.currency,
      fitId: txn.fitId,
      splits: splits.length ? splits : undefined,
      opening,
      errors,
      warnings,
    };
    if (row.date && row.amountMinor != null) row.duplicateKey = duplicateKey({ date: row.date, amountMinor: row.amountMinor, description: payee, account: "" });
    return row;
  });
}

export interface CategoryBucket {
  id: string;
  name: string;
  kind: string;
  archived: boolean;
}

export interface CategoryAssignment {
  name: string;
  kind: "income" | "expense";
  bucketId?: string;
  create?: boolean;
}

export interface CategoryPlan {
  assignments: CategoryAssignment[];
  errors: string[];
}

function normName(value: string): string {
  return tidy(value).toLowerCase();
}

export function planCategoryAssignments(
  uses: { name: string; kind: "income" | "expense" }[],
  buckets: CategoryBucket[],
  categoryMap: Record<string, string>,
  createMissing: boolean,
): CategoryPlan {
  const errors: string[] = [];
  const grouped = new Map<string, { name: string; kind: "income" | "expense" }>();
  for (const use of uses) {
    const name = tidy(use.name);
    if (!name) continue;
    if (name.length > 80) {
      errors.push("Category names are limited to 80 characters.");
      continue;
    }
    const key = normName(name);
    const existing = grouped.get(key);
    if (existing && existing.kind !== use.kind) errors.push(`${name} is used for both income and spending. Nothing was assigned.`);
    else if (!existing) grouped.set(key, { name, kind: use.kind });
  }
  const assignments: CategoryAssignment[] = [];
  for (const use of grouped.values()) {
    const mapped = Object.entries(categoryMap).find(([key, value]) => value.trim() && normName(key) === normName(use.name))?.[1]?.trim();
    if (mapped) {
      const bucket = buckets.find((item) => item.id === mapped);
      if (!bucket) errors.push(`${use.name} was mapped to a category that is not in this plan.`);
      else if (bucket.archived) errors.push(`${bucket.name} is archived.`);
      else if (bucket.kind !== use.kind) errors.push(`${bucket.name} is a ${bucket.kind} category and this row is ${use.kind}.`);
      else assignments.push({ name: use.name, kind: use.kind, bucketId: bucket.id });
      continue;
    }
    const matches = buckets.filter((bucket) => !bucket.archived && bucket.kind === use.kind && normName(bucket.name) === normName(use.name));
    if (matches.length > 1) errors.push(`${use.name} matches more than one category. Choose one.`);
    else if (matches.length === 1) assignments.push({ name: use.name, kind: use.kind, bucketId: matches[0].id });
    else if (createMissing) assignments.push({ name: use.name, kind: use.kind, create: true });
    else errors.push(`${use.name} is not in this plan. Map it or create it.`);
  }
  return { assignments, errors: [...new Set(errors)] };
}

export function toCsv(rows: Record<string, string | number>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const safe = sanitizeSpreadsheetCell(String(row[header] ?? ""));
          if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
          return safe;
        })
        .join(","),
    );
  }
  return lines.join("\n");
}
