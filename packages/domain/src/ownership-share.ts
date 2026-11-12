import type { Transaction } from "./types.js";

export type OwnershipView = "all" | "mine" | "yours" | "ours";

const SPEND_TYPES = new Set(["expense", "fee", "interest", "loan_payment"]);
const NON_SPEND = new Set(["transfer", "cc_payment", "loan_proceeds", "opening", "reconciliation", "buy", "sell"]);

/** A split owner is used only when at least one split names a person. Otherwise the whole transaction label applies. */
export function portionOwner(txn: Pick<Transaction, "ownerUserId" | "splits">, splitOwner?: string | null): string | null {
  if (txn.splits.some((split) => split.ownerUserId)) return splitOwner ?? null;
  return txn.ownerUserId ?? null;
}

export function transactionMatchesOwnership(txn: Transaction, view: OwnershipView, actorId: string, personId?: string): boolean {
  if (view === "all") return true;
  const owners = portionOwners(txn);
  if (view === "ours") return owners.some((owner) => owner == null);
  const wanted = view === "mine" ? actorId : personId;
  return owners.some((owner) => owner === wanted);
}

export function ownershipMoney(transactions: Transaction[], view: OwnershipView, actorId: string, personId: string | undefined, from: string, to: string): { incomeMinor: number; spendingMinor: number } {
  let incomeMinor = 0;
  let spendingMinor = 0;
  for (const txn of transactions) {
    if (txn.deleted || txn.date < from || txn.date > to || txn.bankStatus === "pending" || txn.excludeFromReports) continue;
    if (txn.type === "income") {
      incomeMinor += signedPortions(txn).filter((portion) => matches(portion.ownerUserId, view, actorId, personId)).reduce((sum, portion) => sum + Math.abs(portion.amountMinor), 0);
      continue;
    }
    if (NON_SPEND.has(txn.type) || (!SPEND_TYPES.has(txn.type) && txn.type !== "refund" && txn.type !== "reimbursement")) continue;
    for (const portion of signedPortions(txn)) {
      if (!matches(portion.ownerUserId, view, actorId, personId)) continue;
      spendingMinor += portion.amountMinor;
    }
  }
  return { incomeMinor, spendingMinor };
}

function portionOwners(txn: Transaction): (string | null)[] {
  if (!txn.splits.length) return [txn.ownerUserId ?? null];
  if (!txn.splits.some((split) => split.ownerUserId)) return [txn.ownerUserId ?? null];
  return txn.splits.map((split) => split.ownerUserId ?? null);
}

function signedPortions(txn: Transaction): { ownerUserId: string | null; amountMinor: number }[] {
  const refund = txn.type === "refund" || txn.type === "reimbursement";
  if (!txn.splits.length) {
    const amount = txn.type === "income" ? txn.amountMinor : refund ? -Math.abs(txn.amountMinor) : Math.abs(txn.amountMinor);
    return [{ ownerUserId: txn.ownerUserId ?? null, amountMinor: amount }];
  }
  const directed = txn.splits.some((split) => split.ownerUserId);
  return txn.splits.filter((split) => split.role !== "principal" && split.role !== "transfer" && split.role !== "income").map((split) => ({
    ownerUserId: directed ? split.ownerUserId ?? null : txn.ownerUserId ?? null,
    amountMinor: split.role === "refund" || refund ? -split.amountMinor : split.amountMinor,
  }));
}

function matches(owner: string | null, view: OwnershipView, actorId: string, personId?: string): boolean {
  if (view === "all") return true;
  if (view === "ours") return owner == null;
  if (view === "mine") return owner === actorId;
  return owner === personId;
}
