/** Cleared-balance rules shared by preview and lock. Preview must not post or clear anything. */

const LIABILITY = new Set(["credit", "loan", "student_loan", "mortgage", "other_liability"]);

export interface ReconciliationTransaction {
  id: string;
  date: string;
  accountId: string;
  counterAccountId?: string | null;
  amountMinor: number;
  reconciled: boolean;
}

export interface ReconciliationPlan {
  clearedBalanceMinor: number;
  statementBalanceMinor: number;
  differenceMinor: number;
  includedIds: string[];
  unknownIds: string[];
  canLock: boolean;
}

export function planReconciliation(input: {
  accountId: string;
  accountKind: string;
  statementDate: string;
  statementBalanceMinor: number;
  clearedIds: string[];
  transactions: ReconciliationTransaction[];
}): ReconciliationPlan {
  const onAccount = input.transactions.filter((txn) => txn.accountId === input.accountId || txn.counterAccountId === input.accountId);
  const known = new Set(onAccount.map((txn) => txn.id));
  const unknownIds = input.clearedIds.filter((txnId) => !known.has(txnId));
  const cleared = new Set(input.clearedIds);
  let signed = 0;
  const includedIds: string[] = [];
  for (const txn of onAccount) {
    if (txn.date > input.statementDate) continue;
    if (!cleared.has(txn.id) && !txn.reconciled) continue;
    if (txn.accountId === input.accountId) signed += txn.amountMinor;
    else if (txn.counterAccountId === input.accountId) signed -= txn.amountMinor;
    includedIds.push(txn.id);
  }
  const display = LIABILITY.has(input.accountKind) ? -signed : signed;
  const differenceMinor = input.statementBalanceMinor - display;
  return {
    clearedBalanceMinor: display,
    statementBalanceMinor: input.statementBalanceMinor,
    differenceMinor,
    includedIds,
    unknownIds,
    canLock: unknownIds.length === 0 && differenceMinor === 0,
  };
}
