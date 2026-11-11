/** Parse receipt text. Missing and ambiguous values stay unresolved. */
export interface ReceiptLine {
  description: string;
  amountMinor: number | null;
  raw: string | null;
  unresolved: string | null;
}

export interface ReceiptFields {
  merchant: string | null;
  date: string | null;
  dateRaw: string | null;
  dateUnresolved: string | null;
  currency: string | null;
  currencyUnresolved: string | null;
  subtotalMinor: number | null;
  taxMinor: number | null;
  tipMinor: number | null;
  discountMinor: number | null;
  totalMinor: number | null;
  totalRaw: string | null;
  totalUnresolved: string | null;
  lineItems: ReceiptLine[];
  lineSumMinor: number | null;
  lineVersusSubtotal: "matches" | "differs" | "incomplete";
  lineVersusTotal: "matches" | "differs" | "incomplete";
}

export interface ReceiptDifference {
  code: "line_total" | "line_subtotal" | "currency" | "total" | "date";
  message: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CURRENCIES = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "MXN", "JPY"]);
const MONEY_TAIL = /((?:USD|EUR|GBP|CAD|AUD|MXN|US\$|[€£$])?\s*-?\(?\d[\d.,]*\)?)\s*$/i;

export function emptyFields(): ReceiptFields {
  return reconcileLines({
    merchant: null,
    date: null,
    dateRaw: null,
    dateUnresolved: null,
    currency: null,
    currencyUnresolved: null,
    subtotalMinor: null,
    taxMinor: null,
    tipMinor: null,
    discountMinor: null,
    totalMinor: null,
    totalRaw: null,
    totalUnresolved: null,
    lineItems: [],
    lineSumMinor: null,
    lineVersusSubtotal: "incomplete",
    lineVersusTotal: "incomplete",
  });
}

export function parseReceiptText(text: string): ReceiptFields {
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const currency = detectCurrency(text);
  const dated = detectDate(lines);
  const fields = emptyFields();
  fields.currency = currency.code;
  fields.currencyUnresolved = currency.unresolved;
  fields.date = dated.iso;
  fields.dateRaw = dated.raw;
  fields.dateUnresolved = dated.unresolved;
  fields.merchant = detectMerchant(lines);
  for (const line of lines) {
    const kind = labelKind(line);
    const tail = line.match(MONEY_TAIL);
    if (kind === "date" || !tail) continue;
    const parsed = parseMoney(tail[1]);
    if (kind === "subtotal") assignMoney(fields, "subtotalMinor", parsed);
    else if (kind === "tax") assignMoney(fields, "taxMinor", parsed);
    else if (kind === "tip") assignMoney(fields, "tipMinor", parsed);
    else if (kind === "discount") {
      if (parsed.minor != null) fields.discountMinor = Math.abs(parsed.minor);
    } else if (kind === "total") {
      fields.totalRaw = tail[1];
      if (parsed.minor == null) fields.totalUnresolved = parsed.unresolved;
      else {
        fields.totalMinor = Math.abs(parsed.minor);
        fields.totalUnresolved = null;
      }
    } else {
      const description = line.slice(0, line.length - tail[0].length).trim() || "Item";
      fields.lineItems.push({
        description: description.slice(0, 120),
        amountMinor: parsed.minor == null ? null : Math.abs(parsed.minor),
        raw: tail[1],
        unresolved: parsed.unresolved,
      });
    }
  }
  if (fields.totalMinor != null && fields.currency == null && !fields.currencyUnresolved) {
    fields.currencyUnresolved = "No currency was printed.";
  }
  return reconcileLines(fields);
}

export function reviewFields(input: {
  merchant?: string | null;
  date?: string | null;
  currency?: string | null;
  subtotalMinor?: number | null;
  taxMinor?: number | null;
  tipMinor?: number | null;
  discountMinor?: number | null;
  totalMinor?: number | null;
  lineItems?: { description?: string | null; amountMinor?: number | null }[];
}): ReceiptFields {
  const fields = emptyFields();
  const merchant = cleanText(input.merchant);
  fields.merchant = merchant;
  if (input.date) {
    if (!isIsoDate(input.date)) throw new Error("Enter the receipt date as YYYY-MM-DD, or leave it blank.");
    fields.date = input.date;
  } else fields.dateUnresolved = "The date is still unresolved.";
  if (input.currency) {
    const code = input.currency.trim().toUpperCase();
    if (!CURRENCIES.has(code)) throw new Error("Enter a currency code such as USD, or leave it blank.");
    fields.currency = code;
  } else fields.currencyUnresolved = "The currency is still unresolved.";
  fields.subtotalMinor = optionalMinor(input.subtotalMinor, "subtotal");
  fields.taxMinor = optionalMinor(input.taxMinor, "tax");
  fields.tipMinor = optionalMinor(input.tipMinor, "tip");
  fields.discountMinor = optionalMinor(input.discountMinor, "discount");
  fields.totalMinor = optionalMinor(input.totalMinor, "total");
  if (fields.totalMinor == null) fields.totalUnresolved = "The total is still unresolved.";
  fields.lineItems = (input.lineItems ?? []).slice(0, 80).map((line) => ({
    description: cleanText(line.description) || "Item",
    amountMinor: optionalMinor(line.amountMinor, "line item"),
    raw: null,
    unresolved: line.amountMinor == null ? "This line amount is unresolved." : null,
  }));
  return reconcileLines(fields);
}

export function receiptDifferences(fields: ReceiptFields, txn: { amountMinor: number; date: string; currency: string } | null, accountCurrency: string | null): ReceiptDifference[] {
  const differences: ReceiptDifference[] = [];
  if (fields.lineVersusTotal === "differs") {
    differences.push({ code: "line_total", message: `Line items add to ${fields.lineSumMinor} minor units and the receipt total is ${fields.totalMinor}.` });
  }
  if (fields.lineVersusSubtotal === "differs") {
    differences.push({ code: "line_subtotal", message: `Line items add to ${fields.lineSumMinor} minor units and the subtotal is ${fields.subtotalMinor}.` });
  }
  if (accountCurrency && fields.currency && fields.currency !== accountCurrency) {
    differences.push({ code: "currency", message: `The receipt says ${fields.currency} and the account uses ${accountCurrency}. No conversion is applied.` });
  }
  if (txn && fields.totalMinor != null && fields.totalMinor !== Math.abs(txn.amountMinor)) {
    differences.push({ code: "total", message: `The receipt total is ${fields.totalMinor} minor units and the transaction is ${Math.abs(txn.amountMinor)}.` });
  }
  if (txn && fields.date && fields.date !== txn.date) {
    differences.push({ code: "date", message: `The receipt date is ${fields.date} and the transaction date is ${txn.date}.` });
  }
  return differences;
}

function reconcileLines(fields: ReceiptFields): ReceiptFields {
  const amounts = fields.lineItems.map((line) => line.amountMinor);
  const complete = amounts.length > 0 && amounts.every((amount) => amount != null);
  const lineSumMinor = complete ? amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) : null;
  const versus = (target: number | null): ReceiptFields["lineVersusTotal"] => {
    if (lineSumMinor == null || target == null) return "incomplete";
    return lineSumMinor === target ? "matches" : "differs";
  };
  return { ...fields, lineSumMinor, lineVersusSubtotal: versus(fields.subtotalMinor), lineVersusTotal: versus(fields.totalMinor) };
}

function assignMoney(fields: ReceiptFields, key: "subtotalMinor" | "taxMinor" | "tipMinor", parsed: { minor: number | null; unresolved: string | null }) {
  if (parsed.minor == null) return;
  fields[key] = Math.abs(parsed.minor);
}

function optionalMinor(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100_000_000_00) throw new Error(`Enter the ${label} in minor units, or leave it blank.`);
  return value;
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, 120) : null;
}

function detectCurrency(text: string): { code: string | null; unresolved: string | null } {
  const codes = new Set<string>();
  if (/€|\bEUR\b/i.test(text)) codes.add("EUR");
  if (/£|\bGBP\b/i.test(text)) codes.add("GBP");
  if (/\bCAD\b/.test(text)) codes.add("CAD");
  if (/\bAUD\b/.test(text)) codes.add("AUD");
  if (/\bMXN\b/.test(text)) codes.add("MXN");
  if (/\bJPY\b/.test(text)) codes.add("JPY");
  if (/\bUSD\b|US\$/.test(text)) codes.add("USD");
  const bareDollar = /(?<!US)\$/.test(text);
  if (codes.size > 1 || (codes.size === 1 && bareDollar && !codes.has("USD"))) {
    return { code: null, unresolved: "More than one currency is printed." };
  }
  if (codes.size === 1) return { code: [...codes][0], unresolved: null };
  if (bareDollar) return { code: null, unresolved: "The $ sign does not say which dollar currency this is." };
  if (/\d[.,]\d{2}/.test(text)) return { code: null, unresolved: "No currency was printed." };
  return { code: null, unresolved: null };
}

function detectDate(lines: string[]): { iso: string | null; raw: string | null; unresolved: string | null } {
  const found: { iso: string | null; raw: string; unresolved: string | null }[] = [];
  for (const line of lines) {
    const iso = line.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
    if (iso && isIsoDate(iso[0])) found.push({ iso: iso[0], raw: iso[0], unresolved: null });
    const named = namedDate(line);
    if (named) found.push(named);
    const numeric = line.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})\b/);
    if (numeric) found.push(numericDate(numeric[1], numeric[2], numeric[3], numeric[0]));
  }
  const unique = new Map(found.map((item) => [`${item.iso ?? ""}|${item.raw}`, item]));
  const items = [...unique.values()];
  if (!items.length) return { iso: null, raw: null, unresolved: "No date was printed." };
  const resolved = items.filter((item) => item.iso);
  const distinct = new Set(resolved.map((item) => item.iso));
  if (distinct.size > 1) return { iso: null, raw: items.map((item) => item.raw).join(", "), unresolved: "More than one date is printed." };
  if (distinct.size === 1 && items.every((item) => item.iso === resolved[0].iso || !item.iso)) {
    if (items.some((item) => !item.iso)) return { iso: null, raw: items.map((item) => item.raw).join(", "), unresolved: "One of the printed dates is ambiguous." };
    return { iso: resolved[0].iso, raw: resolved[0].raw, unresolved: null };
  }
  return { iso: null, raw: items[0].raw, unresolved: items[0].unresolved };
}

function namedDate(line: string): { iso: string | null; raw: string; unresolved: string | null } | null {
  const month = MONTHS.join("|");
  const short = MONTH_SHORT.join("|");
  const pattern = new RegExp(`\\b(?:(${month}|${short})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${month}|${short})\\.?\\s+(20\\d{2}))\\b`, "i");
  const match = line.match(pattern);
  if (!match) return null;
  const name = (match[1] || match[5]).toLowerCase().replace(".", "");
  const day = Number(match[2] || match[4]);
  const year = Number(match[3] || match[6]);
  const index = MONTHS.indexOf(name) >= 0 ? MONTHS.indexOf(name) : MONTH_SHORT.indexOf(name.slice(0, 3));
  const iso = `${year}-${String(index + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (index < 0 || !isIsoDate(iso)) return { iso: null, raw: match[0], unresolved: `${match[0]} is not a calendar date.` };
  return { iso, raw: match[0], unresolved: null };
}

function numericDate(monthOrDay: string, dayOrMonth: string, yearRaw: string, raw: string): { iso: string | null; raw: string; unresolved: string | null } {
  if (yearRaw.length === 2) return { iso: null, raw, unresolved: `${raw} does not include a four-digit year.` };
  const first = Number(monthOrDay);
  const second = Number(dayOrMonth);
  const year = Number(yearRaw);
  if (first > 12 && second > 12) return { iso: null, raw, unresolved: `${raw} is not a calendar date.` };
  if (first > 12 && second <= 12) {
    const iso = `${year}-${String(second).padStart(2, "0")}-${String(first).padStart(2, "0")}`;
    return isIsoDate(iso) ? { iso, raw, unresolved: null } : { iso: null, raw, unresolved: `${raw} is not a calendar date.` };
  }
  if (second > 12 && first <= 12) {
    const iso = `${year}-${String(first).padStart(2, "0")}-${String(second).padStart(2, "0")}`;
    return isIsoDate(iso) ? { iso, raw, unresolved: null } : { iso: null, raw, unresolved: `${raw} is not a calendar date.` };
  }
  return { iso: null, raw, unresolved: `${raw} could be month-first or day-first.` };
}

function detectMerchant(lines: string[]): string | null {
  for (const line of lines) {
    if (labelKind(line) !== "other") continue;
    if (MONEY_TAIL.test(line)) continue;
    if (/\b(20\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/.test(line) && /\bdate\b/i.test(line)) continue;
    if (/^(receipt|invoice|thank you|thanks|tel|phone|www\.|https?:)/i.test(line)) continue;
    if (!/[A-Za-z]{2,}/.test(line)) continue;
    return line.slice(0, 120);
  }
  return null;
}

function labelKind(line: string): "subtotal" | "tax" | "tip" | "discount" | "total" | "date" | "other" {
  const head = line.replace(MONEY_TAIL, "").trim().toLowerCase();
  if (/^date\b/.test(head)) return "date";
  if (/sub\s*-?\s*total/.test(head)) return "subtotal";
  if (/\b(tax|vat|gst)\b/.test(head)) return "tax";
  if (/\b(tip|gratuity)\b/.test(head)) return "tip";
  if (/\b(discount|savings|coupon)\b/.test(head)) return "discount";
  if (/^(grand\s+)?total\b|\bamount due\b|\bbalance due\b|\bamount paid\b/.test(head)) return "total";
  return "other";
}

function parseMoney(raw: string): { minor: number | null; unresolved: string | null } {
  const negative = raw.trim().startsWith("-") || raw.includes("(");
  const body = raw.replace(/[€£$]/g, "").replace(/\b(USD|EUR|GBP|CAD|AUD|MXN|US)\b/gi, "").replace(/[()]/g, "").trim().replace(/^-/, "");
  if (!body) return { minor: null, unresolved: null };
  let normalized: string | null = null;
  if (/^\d{1,3}(,\d{3})+\.\d{2}$/.test(body) || /^\d+\.\d{2}$/.test(body)) normalized = body.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(body)) normalized = body.replace(/\./g, "").replace(",", ".");
  else return { minor: null, unresolved: `${raw.trim()} is not an exact currency amount.` };
  const [whole, frac] = normalized.split(".");
  const minor = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(minor)) return { minor: null, unresolved: `${raw.trim()} is too large.` };
  return { minor: negative ? -minor : minor, unresolved: null };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
