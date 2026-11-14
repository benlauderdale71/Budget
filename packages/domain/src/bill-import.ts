import { normalizeDate, parseAmount } from "./importers.js";

export type BillImportKind = "bill" | "subscription" | "income" | "estimate" | "ignore";
export interface BillImportCell { column: string; value: string; formula?: string }
export interface BillImportRow {
  key: string;
  location: string;
  name: string;
  kind: BillImportKind;
  amountMinor?: number;
  nextDate?: string;
  anchorDay?: number;
  cadence: string;
  paymentMethod: string;
  paidReference: string;
  notes: string;
  balanceOwedMinor?: number;
  sourceCells: BillImportCell[];
  warnings: string[];
  suggested: boolean;
  duplicate?: boolean;
}
export interface BillImportGrid { name: string; rows: string[][]; formulas?: Record<string, string>; ocr?: boolean }
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^\d+/, "");
const aliases: Record<string, string[]> = {
  name: ["bill", "bil", "billname", "name", "payee", "merchant", "description", "vendor"],
  income: ["income", "incomesource"], estimate: ["variable", "variables", "variableexpenses", "spendingestimates"],
  date: ["date", "due", "duedate", "dueday", "day", "nextdate", "paymentdate"],
  amount: ["amount", "amountdue", "payment", "paymentamount", "averageamount", "cost"],
  monthly: ["amountmonthly", "monthlyamount", "monthly"], annual: ["amountyearly", "yearlyamount", "annualamount", "yearly"],
  cadence: ["frequency", "cadence", "repeat", "recurrence"],
  method: ["paytype", "paymenttype", "paymentmethod", "autopay"], paid: ["paid", "paidstatus", "status"],
  notes: ["notes", "note", "memo"], balance: ["balanceowed", "balance", "outstandingbalance"], kind: ["type", "kind"],
};
export function billHeader(value: string): string | undefined {
  const key = normalized(value);
  return Object.keys(aliases).find((field) => aliases[field].includes(key));
}

export function billImportDate(value: string, month: string): { date?: string; day?: number; warning?: string } {
  const raw = value.trim();
  if (!raw) return { warning: "Choose a due date; none was supplied." };
  // Refuse malformed ordinals rather than repairing an uncertain OCR digit.
  const ordinal = raw.match(/^(\d{1,2})(st|nd|rd|th)?$/i);
  if (ordinal) {
    const day = Number(ordinal[1]);
    const suffix = day >= 11 && day <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
    if (ordinal[2] && ordinal[2].toLowerCase() !== suffix) return { warning: "The due day is unclear. Check it against the original." };
    if (day < 1 || day > 31 || !/^\d{4}-\d{2}$/.test(month)) return { warning: "Check the due day and starting month." };
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    return { date: `${month}-${String(Math.min(day, last)).padStart(2, "0")}`, day, warning: `Only a day was supplied. Confirm ${month} as the starting month${day > last ? "; this month uses its last day" : ""}.` };
  }
  const written=raw.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/i);
  const monthNumber=written?["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(written[1].slice(0,3).toLowerCase())+1:0;
  const parsed = normalizeDate(written?`${written[3]}-${String(monthNumber).padStart(2,"0")}-${written[2].padStart(2,"0")}`:raw, "mdy");
  return parsed.date ? { date: parsed.date } : { warning: "The due date could not be read. Enter the correct date." };
}

function cadenceOf(value: string): string | undefined {
  const key = normalized(value);
  return ({ monthly: "monthly", month: "monthly", weekly: "weekly", week: "weekly", biweekly: "biweekly", every2weeks: "biweekly", everytwoweeks: "biweekly", quarterly: "every_3_months", every3months: "every_3_months", annual: "annual", annually: "annual", yearly: "annual", once: "once", onetime: "once", every2months: "every_2_months", every6months: "every_6_months" } as Record<string, string>)[key];
}

export function parseBillGrids(grids: BillImportGrid[], month: string): BillImportRow[] {
  const output: BillImportRow[] = [];
  for (const [gridIndex, grid] of grids.entries()) {
    type Section = { start: number; end: number; nameCol: number; kind: BillImportKind; header: string[]; fields: Record<string, number> };
    const sections = new Map<number, Section>();
    for (const [rowIndex, cells] of grid.rows.entries()) {
      const anchors = cells.flatMap((cell, column) => ["name", "income", "estimate"].includes(billHeader(cell) ?? "") ? [{ column, field: billHeader(cell)! }] : []);
      const headerRow = anchors.length && cells.some((cell) => ["amount", "monthly", "annual"].includes(billHeader(cell) ?? ""));
      const updated = new Set<number>();
      if (headerRow) {
        for (const [anchorIndex, anchor] of anchors.entries()) {
          const old = sections.get(anchor.column);
          const start = old?.start ?? (anchorIndex === 0 && sections.size === 0 ? 0 : Math.max(0, anchor.column - (billHeader(cells[anchor.column - 1] ?? "") === "date" ? 1 : 0)));
          const nextAnchor = anchors[anchorIndex + 1]?.column;
          const end = nextAnchor == null ? cells.length : nextAnchor - (billHeader(cells[nextAnchor - 1] ?? "") === "date" ? 1 : 0);
          const fields: Record<string, number> = {};
          for (let col = start; col < end; col++) { const field = billHeader(cells[col] ?? ""); if (field) fields[field] = col; }
          sections.set(anchor.column, { start, end: old?.end ?? end, nameCol: anchor.column, kind: anchor.field === "income" ? "income" : anchor.field === "estimate" ? "estimate" : "bill", header: cells, fields });
          updated.add(anchor.column);
        }
      }
      for (const section of sections.values()) {
        if (updated.has(section.nameCol)) continue;
        const get = (field: string) => cells[section.fields[field]]?.trim() ?? "";
        const name = (cells[section.nameCol] ?? "").trim();
        if (!name || !/[a-z]/i.test(name)) continue;
        const warnings: string[] = [];
        let kind = section.kind;
        if (/^(sub\s*total|total|net|remaining|surplus|deficit|balance forward)\b/i.test(name)) kind = "ignore";
        const explicitKind = get("kind").toLowerCase();
        if (["bill", "subscription", "income", "estimate", "ignore"].includes(explicitKind)) kind = explicitKind as BillImportKind;
        const date = billImportDate(get("date"), month);
        let cadence = cadenceOf(get("cadence")) ?? (date.day ? "monthly" : "once");
        let amountText = get("amount");
        if (!amountText && get("monthly")) { amountText = get("monthly"); cadence = "monthly"; }
        if (!amountText && get("annual")) { amountText = get("annual"); cadence = "annual"; }
        if (get("monthly") && get("annual")) warnings.push("Both monthly and yearly amounts are present. Confirm which schedule to create.");
        const amountMinor = parseAmount(amountText);
        const balanceRaw = get("balance");
        const balanceOwedMinor = balanceRaw ? parseAmount(balanceRaw) : undefined;
        if (!get("date") && kind === "bill" && /^(gas|groceries|medical|food|movie|misc|grass cutting|entertainment)\b/i.test(name)) kind = "estimate";
        if (kind !== "ignore") {
          if (date.warning) warnings.push(date.warning);
          if (amountMinor == null || amountMinor < 0) warnings.push("Enter a readable, nonnegative amount.");
          else if (amountMinor === 0) warnings.push("The amount is zero. Confirm it or leave this item out.");
          if (get("cadence") && !cadenceOf(get("cadence"))) warnings.push("The frequency was not recognized. Choose how often this repeats.");
          if (get("paid")) warnings.push("Paid is a reference note only; no payment will be posted or marked paid.");
          if (balanceRaw && balanceOwedMinor == null) warnings.push("Check the balance owed; its original text is retained.");
          if (kind === "estimate") warnings.push("This looks like a spending estimate. Change it to a bill and choose a date only if you want a schedule.");
          if (grid.ocr) warnings.push("Read from an image. Check the name, amount and due date against the original.");
        }
        const sourceCells = cells.slice(section.start, section.end).map((value, offset) => {
          const column = section.start + offset;
          return { column: section.header[column] || `Column ${column + 1}`, value, ...(grid.formulas?.[`${rowIndex}:${column}`] ? { formula: grid.formulas[`${rowIndex}:${column}`] } : {}) };
        });
        if (sourceCells.some((cell) => cell.formula)) warnings.push("Formula results are cached spreadsheet values; formulas were not recalculated. Confirm the amount.");
        output.push({ key: `${gridIndex}:${rowIndex}:${section.nameCol}`, location: `${grid.name}, row ${rowIndex + 1}`, name, kind, amountMinor, nextDate: date.date, anchorDay: date.day, cadence, paymentMethod: get("method"), paidReference: get("paid"), notes: get("notes"), balanceOwedMinor, sourceCells, warnings, suggested: !grid.ocr && (kind === "bill" || kind === "subscription") && !!date.date && (amountMinor ?? 0) > 0 });
      }
    }
  }
  if (output.length > 500) throw new Error("This document has more than 500 items. Split it into smaller files before importing.");
  return output;
}

/** Read a single invoice when no bill-list table is present. Nothing is selected automatically. */
export function parseSingleBill(text: string, month: string): BillImportRow[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const amountLine = lines.find((line) => /(?:amount|total|payment)\s+due\b/i.test(line));
  const dueLine = lines.find((line) => /(?:due\s+date|pay(?:ment)?\s+by|due\s+on)\b/i.test(line));
  if (!amountLine && !dueLine) return [];
  const amount = amountLine?.replace(/^.*?(?:amount|total|payment)\s+due\b[:\s]*/i, "").match(/(?:\(\s*)?[+-]?\s*[$€£]?\s*\d[\d,]*\.\d{2}(?:0+)?\s*\)?/)?.[0];
  const dateText = dueLine?.replace(/^.*?(?:due\s+date|pay(?:ment)?\s+by|due\s+on)\b[:\s]*/i, "").trim() ?? "";
  const date = billImportDate(dateText, month);
  return [{ key: "invoice:0", location: "Invoice", name: (lines.find((line) => /[a-z]{3}/i.test(line) && !/^(invoice|statement|account|date|bill to|due)/i.test(line)) ?? "Imported bill").slice(0, 120), kind: "bill", amountMinor: amount ? parseAmount(amount) : undefined, nextDate: date.date, cadence: "once", paymentMethod: "", paidReference: "", notes: "", sourceCells: lines.map((value, i) => ({ column: `Line ${i + 1}`, value })), warnings: ["Check this suggested bill against the original document.", ...(date.warning ? [date.warning] : [])], suggested: false }];
}

export function billImportSignature(row: { name: string; kind: string; amountMinor: number; cadence: string; nextDate: string; anchorDay?: number | null; accountId?: string | null }): string {
  const day = row.anchorDay ?? Number(row.nextDate.slice(8,10));
  const interval = ({monthly:1,every_2_months:2,every_3_months:3,every_6_months:6} as Record<string,number>)[row.cadence];
  const days = row.cadence === "weekly" ? 7 : row.cadence === "biweekly" ? 14 : 0;
  const when = interval ? `${(Number(row.nextDate.slice(0,4))*12+Number(row.nextDate.slice(5,7))-1)%interval}:${day}` : days ? String(Math.floor(Date.parse(`${row.nextDate}T00:00:00Z`)/86400000)%days) : row.cadence === "annual" ? `${row.nextDate.slice(5,7)}:${day}` : row.nextDate;
  return JSON.stringify([row.name.toLowerCase().replace(/[^a-z0-9]/g, ""), row.kind, row.amountMinor, row.cadence, when, row.accountId || ""]);
}
