import { addDays, monthPeriod } from "./dates.js";
import { displayBalance } from "./budget.js";
import type { EngineInput } from "./types.js";

export interface StatementPeriod {
  accountId: string;
  start: string;
  end: string;
  closingMinor: number;
}

export function statementCoverage(input: EngineInput, year: number, periods: StatementPeriod[], selectedAccount?: string) {
  const months = Array.from({length: 12}, (_, index) => monthPeriod(year, index + 1));
  const accounts = input.accounts.filter(a => !a.id.startsWith("redacted:") && (!selectedAccount || a.id === selectedAccount));
  const rows = accounts.map(account => {
    const entries = input.transactions.filter(t => !t.deleted && (t.accountId === account.id || t.counterAccountId === account.id));
    const statements = periods.filter(p => p.accountId === account.id).map(p => ({
      ...p, differenceMinor: p.closingMinor - displayBalance(account, entries, p.end),
    })).sort((a,b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    const coverage = months.map(month => {
      const imports = entries.filter(t => t.accountId === account.id && (t.importBatchId || t.providerTransactionId)
        && t.date >= month.start && t.date <= month.end);
      const overlapping = statements.filter(s => s.end >= month.start && s.start <= month.end);
      let next = month.start;
      const gaps: {start:string;end:string}[]=[];
      for (const s of overlapping) {
        if (s.differenceMinor !== 0 || s.end < next) continue;
        if (s.start > next) gaps.push({start:next,end:addDays(s.start,-1)});
        next=addDays(s.end,1);
      }
      if (next<=month.end) gaps.push({start:next,end:month.end});
      const importDates=imports.map(t=>t.date).sort();
      const status = month.start > input.asOf ? "Upcoming" : overlapping.some(s => s.differenceMinor !== 0) ? "Balance mismatch"
        : !gaps.length && month.end <= input.asOf ? "Reconciled"
        : imports.length || overlapping.length ? "Partial" : "No coverage";
      return { month: month.key, status, imported: imports.length, firstImport:importDates[0] ?? null, lastImport:importDates.at(-1) ?? null, gaps };
    });
    return { accountId: account.id, name: account.name, currency: account.currency, months: coverage, statements };
  });
  // Household reports require evidence for every relevant spending account in the report currency.
  const required = rows.filter(row => {
    if (row.currency !== input.currency) return false;
    if (selectedAccount) return true;
    const a = accounts.find(a => a.id === row.accountId)!;
    return (!a.archived && ["checking","savings","cash","credit"].includes(a.kind))
      || row.statements.length > 0 || input.transactions.some(t => t.accountId === a.id && t.date.startsWith(String(year) + "-")
        && ["expense","fee","interest","refund","reimbursement","loan_payment"].includes(t.type));
  });
  const completeMonths = months.flatMap((_,i) => required.length && required.every(a => a.months[i].status === "Reconciled") ? [i] : []);
  return {year, accounts:rows, completeMonths, requiredAccountIds:required.map(a=>a.accountId)};
}

export type StatementCoverage = ReturnType<typeof statementCoverage>;
