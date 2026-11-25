import { addDays, monthPeriod } from "./dates.js";
import { displayBalance, signedForAccount } from "./budget.js";
import type { EngineInput } from "./types.js";

export interface StatementPeriod {
  accountId: string;
  start: string;
  end: string;
  closingMinor: number;
  depositsMinor?: number|null;
  withdrawalsMinor?: number|null;
  transactionCount?: number|null;
}

export function statementCoverage(input: EngineInput, year: number, periods: StatementPeriod[], selectedAccount?: string, lifetimes: Record<string,{opened:string|null;closed:string|null}> = {}) {
  const months = Array.from({length: 12}, (_, index) => monthPeriod(year, index + 1));
  const accounts = input.accounts.filter(a => !a.id.startsWith("redacted:") && (!selectedAccount || a.id === selectedAccount));
  const rows = accounts.map(account => {
    const entries = input.transactions.filter(t => !t.deleted && (t.accountId === account.id || t.counterAccountId === account.id));
    const lifetime=lifetimes[account.id] ?? {opened:null,closed:null};
    const statements = periods.filter(p => p.accountId === account.id).map(p => {
      const activity=entries.filter(t=>t.date>=p.start && t.date<=p.end && t.currency===account.currency && t.bankStatus==="posted" && t.type!=="opening");
      const legs=activity.map(t=>signedForAccount(account.id,t) ?? 0);
      const deposits=legs.reduce((n,v)=>n+Math.max(0,v),0);
      const withdrawals=legs.reduce((n,v)=>n+Math.max(0,-v),0);
      const differenceMinor=p.closingMinor-displayBalance(account,entries,p.end);
      const mismatch=(p.depositsMinor!=null && deposits!==p.depositsMinor) || (p.withdrawalsMinor!=null && withdrawals!==p.withdrawalsMinor)
        || (p.transactionCount!=null && activity.length!==p.transactionCount);
      const verified=differenceMinor===0 && !mismatch && p.depositsMinor!=null && p.withdrawalsMinor!=null;
      return {...p,differenceMinor,ledgerDeposits:deposits,ledgerWithdrawals:withdrawals,ledgerCount:activity.length,mismatch,verified};
    }).sort((a,b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    const coverage = months.map(month => {
      const imports = entries.filter(t => t.accountId === account.id && (t.importBatchId || t.providerTransactionId)
        && t.date >= month.start && t.date <= month.end);
      const overlapping = statements.filter(s => s.end >= month.start && s.start <= month.end);
      const start=lifetime.opened && lifetime.opened>month.start ? lifetime.opened : month.start;
      const end=lifetime.closed && lifetime.closed<month.end ? lifetime.closed : month.end;
      let next = start;
      const gaps: {start:string;end:string}[]=[];
      for (const s of overlapping) {
        if (!s.verified || s.end < next || s.start>end) continue;
        if (s.start > next) gaps.push({start:next,end:addDays(s.start,-1)});
        next=addDays(s.end,1);
      }
      if (next<=end) gaps.push({start:next,end});
      const importDates=imports.map(t=>t.date).sort();
      const status = start>end ? "Outside account dates" : month.start > input.asOf ? "Upcoming" : overlapping.some(s => s.differenceMinor !== 0) ? "Balance mismatch"
        : overlapping.some(s=>s.mismatch) ? "Activity mismatch" : !gaps.length && end <= input.asOf ? "Reconciled"
        : overlapping.length && overlapping.every(s=>!s.verified) ? "Balance only"
        : imports.length || overlapping.length ? "Partial" : "No coverage";
      return { month: month.key, status, imported: imports.length, firstImport:importDates[0] ?? null, lastImport:importDates.at(-1) ?? null, gaps };
    });
    return { accountId: account.id, name: account.name, lifetime, currency: account.currency, months: coverage, statements };
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
  const completeMonths = months.flatMap((_,i) => {
    const active=required.filter(a=>a.months[i].status!=="Outside account dates");
    return active.length && active.every(a=>a.months[i].status==="Reconciled") ? [i] : [];
  });
  return {year, accounts:rows, completeMonths, requiredAccountIds:required.map(a=>a.accountId)};
}

export type StatementCoverage = ReturnType<typeof statementCoverage>;
