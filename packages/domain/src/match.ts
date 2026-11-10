/** Two records of the same money. Matching removes the duplicate from the ledger and keeps the user's notes. */

export interface MatchRecord {
  id: string;
  accountId: string;
  amountMinor: number;
  currency: string;
  providerTransactionId?: string;
  reconciled?: boolean;
}

export function matchProblem(keeper: MatchRecord, incoming: MatchRecord): string | null {
  if (keeper.id === incoming.id) return "Choose two different transactions.";
  if (keeper.accountId !== incoming.accountId) return "Match transactions that belong to the same account.";
  if (keeper.currency !== incoming.currency) return "Match transactions in the same currency.";
  if (keeper.amountMinor !== incoming.amountMinor) return "The amounts have to be equal. Matching then removes one copy, so the total changes once.";
  if (keeper.reconciled && incoming.reconciled) return "Unreconcile one of them before matching.";
  if (keeper.providerTransactionId && incoming.providerTransactionId) {
    return keeper.providerTransactionId === incoming.providerTransactionId
      ? "These already share a provider id. One register record is enough."
      : "These already have different provider ids. Leave them separate.";
  }
  return null;
}

/** The keeper stays. The incoming record leaves the totals. Unmatching adds that same amount back. */
export function matchedTotals(before: number[], incomingAmount: number): { afterMatch: number; afterUnmatch: number } {
  const afterMatch = before.reduce((sum, amount) => sum + amount, 0) - incomingAmount;
  return { afterMatch, afterUnmatch: afterMatch + incomingAmount };
}
