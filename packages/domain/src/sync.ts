import type { Transaction } from "./types.js";

/** Keep one transaction per provider id. Replaying a webhook updates the same row. */
export function mergeProviderTransaction(existing: Transaction[], incoming: Transaction): { transactions: Transaction[]; action: "insert" | "update" } {
  if (!incoming.providerTransactionId) {
    return { transactions: [...existing, incoming], action: "insert" };
  }
  const index = existing.findIndex((txn) => txn.providerTransactionId === incoming.providerTransactionId && !txn.deleted);
  if (index < 0) return { transactions: [...existing, incoming], action: "insert" };
  const previous = existing[index];
  const locked = previous.categoryLockedByUser || previous.reconciled;
  const merged: Transaction = {
    ...incoming,
    id: previous.id,
    notes: previous.notes ?? incoming.notes,
    receiptIds: previous.receiptIds ?? incoming.receiptIds,
    tags: previous.tags ?? incoming.tags,
    flag: previous.flag ?? incoming.flag,
    checkNumber: previous.checkNumber ?? incoming.checkNumber,
    categoryLockedByUser: previous.categoryLockedByUser,
    reconciled: previous.reconciled,
    locked: previous.locked,
    splits: locked ? previous.splits : incoming.splits,
    payee: locked ? previous.payee : incoming.payee,
    reviewStatus: locked ? previous.reviewStatus : incoming.reviewStatus,
  };
  const transactions = existing.slice();
  transactions[index] = merged;
  return { transactions, action: "update" };
}

export interface SyncOp {
  opId: string;
  kind: "create" | "update" | "delete";
  transaction: Transaction;
}

/** Drop operations this device already applied. */
export function unseenOps(ops: SyncOp[], appliedIds: string[]): SyncOp[] {
  const seen = new Set(appliedIds);
  const fresh: SyncOp[] = [];
  const batch = new Set<string>();
  for (const op of ops) {
    if (seen.has(op.opId) || batch.has(op.opId)) continue;
    batch.add(op.opId);
    fresh.push(op);
  }
  return fresh;
}
