import { sanitizeSpreadsheetCell } from "./money.js";
import type { TransactionType } from "./types.js";

export interface ImportRow {
  rowNumber: number;
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
  currency?: string;
  errors: string[];
  duplicateKey?: string;
}

export interface ColumnMap {
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
  inflowSign?: "positive_in" | "positive_out";
}

export const IMPORT_PROFILES: { id: string; label: string; map: ColumnMap; missing: string[] }[] = [
  {
    id: "mint",
    label: "Mint CSV",
    map: { date: "Date", amount: "Amount", payee: "Description", description: "Original Description", category: "Category", account: "Account Name", notes: "Notes" },
    missing: ["Mint exports vary. Splits, tags, and pending status are often absent and will not be invented."],
  },
  {
    id: "ynab",
    label: "YNAB register CSV",
    map: { date: "Date", payee: "Payee", category: "Category", description: "Memo", amount: "Amount", account: "Account", notes: "Memo" },
    missing: ["Budget assignments and targets are not in the register export."],
  },
  {
    id: "monarch",
    label: "Monarch CSV",
    map: { date: "Date", payee: "Merchant", amount: "Amount", category: "Category", account: "Account", notes: "Notes", tags: "Tags" },
    missing: ["Institution connection ids and household permissions are not in the file."],
  },
  {
    id: "simplifi",
    label: "Simplifi CSV",
    map: { date: "Date", payee: "Payee", amount: "Amount", category: "Category", account: "Account", tags: "Tags", notes: "Notes" },
    missing: ["Watchlists and spending-plan settings are not transaction fields."],
  },
  {
    id: "rocket",
    label: "Rocket Money CSV",
    map: { date: "Date", payee: "Name", description: "Description", amount: "Amount", category: "Category", account: "Account" },
    missing: ["Negotiation cases and credit-report fields are not in a transaction CSV."],
  },
  {
    id: "everydollar",
    label: "EveryDollar CSV",
    map: { date: "Date", payee: "Payee", amount: "Amount", category: "Budget Item", notes: "Memo" },
    missing: ["The export does not include bank-provider ids."],
  },
  {
    id: "empower",
    label: "Empower / Personal Capital CSV",
    map: { date: "Date", payee: "Description", amount: "Amount", category: "Category", account: "Account" },
    missing: ["Holdings and fee breakdowns need the investment export, not the transaction file."],
  },
  {
    id: "goodbudget",
    label: "Goodbudget CSV",
    map: { date: "Date", payee: "Payee", amount: "Amount", category: "Envelope", account: "Account", notes: "Notes", checkNumber: "Check Number" },
    missing: ["Envelope fill templates are not reconstructed unless they appear as transactions."],
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
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseAmount(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/[$,]/g, "").replace(/\((.*)\)/, "-$1");
  if (!cleaned) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const negative = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const cents = frac.padEnd(2, "0").slice(0, 2);
  const minor = Number(whole) * 100 + Number(cents);
  return negative ? -minor : minor;
}

function normalizeDate(raw: string): string | undefined {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return undefined;
}

export function mapCsv(text: string, map: ColumnMap): ImportRow[] {
  const table = parseCsv(text);
  if (!table.length) return [];
  const header = table[0].map((cell) => cell.trim());
  const index = (name?: string) => (name ? header.findIndex((cell) => cell.toLowerCase() === name.toLowerCase()) : -1);
  return table.slice(1).map((cells, offset) => {
    const get = (name?: string) => {
      const i = index(name);
      return i >= 0 ? cells[i] ?? "" : "";
    };
    const errors: string[] = [];
    const date = normalizeDate(get(map.date));
    if (!date) errors.push("Date is missing or not YYYY-MM-DD or M/D/YYYY.");
    let amount = map.amount ? parseAmount(get(map.amount)) : undefined;
    if (map.debit || map.credit) {
      const debit = parseAmount(get(map.debit)) ?? 0;
      const credit = parseAmount(get(map.credit)) ?? 0;
      amount = credit - Math.abs(debit);
    }
    if (amount == null) errors.push("Amount could not be read as a number.");
    if (map.inflowSign === "positive_out" && amount != null) amount = -amount;
    const payee = get(map.payee) || get(map.description);
    const row: ImportRow = {
      rowNumber: offset + 2,
      date,
      amountMinor: amount,
      payee,
      description: get(map.description),
      category: get(map.category),
      account: get(map.account),
      notes: get(map.notes),
      checkNumber: get(map.checkNumber),
      tags: get(map.tags)
        ? get(map.tags)
            .split(/[|;]/)
            .map((tag) => tag.trim())
            .filter(Boolean)
        : undefined,
      errors,
    };
    if (date && amount != null) row.duplicateKey = duplicateKey({ date, amountMinor: amount, description: payee, account: row.account ?? "" });
    return row;
  });
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
}

export function parseOfx(text: string): ParsedBankTxn[] {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  return blocks.map((block) => {
    const pick = (tag: string) => block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, "i"))?.[1]?.trim() ?? "";
    const dateRaw = pick("DTPOSTED").slice(0, 8);
    const date = dateRaw.length === 8 ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}` : "";
    const amount = parseAmount(pick("TRNAMT")) ?? 0;
    return {
      date,
      amountMinor: amount,
      payee: pick("NAME") || pick("MEMO") || "Imported",
      fitId: pick("FITID") || undefined,
      type: amount >= 0 ? "income" : "expense",
    } satisfies ParsedBankTxn;
  }).filter((txn) => txn.date);
}

export function parseQif(text: string): ParsedBankTxn[] {
  const records = text.split(/\^/).map((part) => part.trim()).filter(Boolean);
  const txns: ParsedBankTxn[] = [];
  for (const record of records) {
    if (record.startsWith("!")) continue;
    let date = "";
    let amount = 0;
    let payee = "";
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("D")) date = normalizeDate(line.slice(1)) ?? "";
      else if (line.startsWith("T") || line.startsWith("U")) amount = parseAmount(line.slice(1)) ?? 0;
      else if (line.startsWith("P")) payee = line.slice(1).trim();
    }
    if (date) txns.push({ date, amountMinor: amount, payee: payee || "Imported", type: amount >= 0 ? "income" : "expense" });
  }
  return txns;
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
