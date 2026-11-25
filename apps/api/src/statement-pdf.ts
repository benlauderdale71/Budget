import { isIsoDate } from "@budgetcents/domain";

interface DraftRow {
  page: number;
  source: string;
  date: string;
  payee: string;
  amount: string;
  issue: string;
}
const moneyPattern = /(?<!\S)(?:\(?[-+−]?\$?\d[\d,]*\.\d{2}\)?(?:\s?(?:CR|DR)|-)?)(?!\S)/gi;
const datePattern = /^\s*(\d{4}-\d\d-\d\d|\d{1,2}[/-]\d{1,2}(?:[/-](?:\d{4}|\d{2}))?)(?=\s|$)/;
const summary =
  /\b(?:opening balance|beginning balance|ending balance|closing balance|previous balance|balance forward|balance brought forward|balance carried forward|total deposits|total withdrawals|daily balance|balance summary|subtotal|page \d+ of \d+)\b/i;

function dateOf(raw: string, year: number) {
  if (raw.includes("-") && raw.length === 10 && isIsoDate(raw)) return raw;
  const [m, d, y] = raw.split(/[/-]/);
  if (!m || !d) return "";
  const value = [y ? (y.length === 2 ? "20" + y : y) : year, m.padStart(2, "0"), d.padStart(2, "0")].join(
    "-",
  );
  return isIsoDate(value) ? value : "";
}
type Column = { key: "debit" | "credit" | "balance" | "amount"; position: number };
function columnsOf(line: string): Column[] {
  return [
    ...line.matchAll(/\b(withdrawals?|debits?|charges?|deposits?|credits?|payments?|balance|amount)\b/gi),
  ].map((m) => {
    const label = m[0].toLowerCase();
    const key = /withdrawal|debit|charge/.test(label)
      ? "debit"
      : /credit|deposit/.test(label)
        ? "credit"
        : label === "balance"
          ? "balance"
          : "amount";
    return { key, position: m.index! + m[0].length / 2 };
  });
}
export function statementDraft(pages: string[], year: number) {
  const rows: DraftRow[] = [];
  const warnings: string[] = [];
  let columns: Column[] = [],
    section: "credit" | "debit" | undefined;
  for (const [index, page] of pages.entries()) {
    let found = 0;
    for (const line of page.split(/\r?\n/)) {
      const source = line.trim();
      if (!source || summary.test(source)) continue;
      const dateMatch = datePattern.exec(line);
      if (!dateMatch) {
        if (
          /\bdate\b/i.test(source) &&
          /\b(description|payee|details|transaction|debits?|credits?|amount)\b/i.test(source)
        ) {
          columns = columnsOf(line);
          continue;
        }
        if (
          /^(?:deposits(?: and (?:other )?credits)?|credits|withdrawals(?: and (?:other )?debits)?|debits|checks paid|card purchases)$/i.test(
            source,
          )
        ) {
          section = /deposit|credit/i.test(source) ? "credit" : "debit";
          columns = [];
          continue;
        }
        if (!moneyPattern.test(source)) {
          moneyPattern.lastIndex = 0;
          continue;
        }
        moneyPattern.lastIndex = 0;
        rows.push({
          page: index + 1,
          source,
          date: "",
          payee: "",
          amount: "",
          issue: "An amount was read without a transaction date. Check this line or exclude it.",
        });
        continue;
      }
      found++;
      const date = dateOf(dateMatch[1], year);
      const amounts = [...line.matchAll(moneyPattern)];
      const description = line.slice(dateMatch[0].length, amounts[0]?.index ?? line.length).trim();
      let amount = "",
        ambiguous = false;
      for (const m of amounts) {
        const raw = m[0],
          center = m.index! + raw.length / 2;
        const nearest = columns
          .slice()
          .sort((a, b) => Math.abs(a.position - center) - Math.abs(b.position - center))[0];
        if (nearest?.key === "balance") continue;
        const negative = /[-−(]|\bDR$/i.test(raw) || /DR$/i.test(raw);
        const positive = /^\+|CR$/i.test(raw);
        const direction = negative
          ? "debit"
          : positive
            ? "credit"
            : nearest?.key === "debit" || nearest?.key === "credit"
              ? nearest.key
              : section;
        if (!direction || amount) {
          ambiguous = true;
          continue;
        }
        amount = (direction === "debit" ? "-" : "") + raw.replace(/[^0-9.]/g, "");
      }
      if (ambiguous) amount = "";
      rows.push({
        page: index + 1,
        source,
        date,
        payee: description,
        amount,
        issue: !amount
          ? "Check the amount and whether it is money in or out."
          : !date || !description
            ? "Check the date and description."
            : "",
      });
    }
    if (!found)
      warnings.push(
        "Page " + (index + 1) + " had no recognized transaction dates. Compare it with the original.",
      );
  }
  if (rows.length > 5000) throw new Error("Split this PDF into smaller statements before importing.");
  return { rows, warnings, pages: pages.length };
}
