import { MoneyError } from "./money.js";

export interface ExternalActivity {
  externalId: string;
  postedOn: string;
  payee: string;
  amountMinor: number;
  bankStatus: "pending" | "posted";
  /** When the bank uses a new id for the posted copy of a pending line. */
  settlesExternalId?: string;
}

export interface LedgerMirror {
  id: string;
  externalId: string;
  bankStatus: "pending" | "posted";
}

export interface SyncPlan {
  insert: ExternalActivity[];
  settle: { id: string; activity: ExternalActivity }[];
  duplicates: string[];
}

/** Built-in sandbox history. These are fixtures, not a person's bank. */
export const SANDBOX_INITIAL: ExternalActivity[] = [
  { externalId: "sbx-rent", postedOn: "2026-11-01", payee: "Sandbox Rent", amountMinor: -120000, bankStatus: "posted" },
  { externalId: "sbx-market", postedOn: "2026-11-03", payee: "Sandbox Market", amountMinor: -2540, bankStatus: "pending" },
];

export const SANDBOX_INCREMENTAL: ExternalActivity[] = [
  { externalId: "sbx-market-posted", postedOn: "2026-11-04", payee: "Sandbox Market", amountMinor: -2540, bankStatus: "posted", settlesExternalId: "sbx-market" },
  { externalId: "sbx-fuel", postedOn: "2026-11-05", payee: "Sandbox Fuel", amountMinor: -4100, bankStatus: "posted" },
];

export function planExternalSync(existing: LedgerMirror[], incoming: ExternalActivity[]): SyncPlan {
  const byExternal = new Map(existing.map((row) => [row.externalId, row]));
  const insert: ExternalActivity[] = [];
  const settle: SyncPlan["settle"] = [];
  const duplicates: string[] = [];
  for (const activity of incoming) {
    if (!activity.externalId || !activity.payee.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(activity.postedOn)) {
      throw new MoneyError("A bank activity needs an id, a payee, and a date.");
    }
    if (!Number.isInteger(activity.amountMinor)) throw new MoneyError("A bank activity amount must be an integer number of minor units.");
    const same = byExternal.get(activity.externalId);
    if (same && same.id !== "new" && same.bankStatus === "pending" && activity.bankStatus === "posted") {
      settle.push({ id: same.id, activity });
      byExternal.set(activity.externalId, { ...same, bankStatus: "posted" });
      continue;
    }
    if (same) {
      duplicates.push(activity.externalId);
      continue;
    }
    const prior = activity.settlesExternalId ? byExternal.get(activity.settlesExternalId) : undefined;
    if (activity.settlesExternalId && prior && prior.id !== "new" && prior.bankStatus === "pending") {
      settle.push({ id: prior.id, activity });
      byExternal.set(activity.externalId, { id: prior.id, externalId: activity.externalId, bankStatus: "posted" });
      byExternal.set(prior.externalId, { ...prior, bankStatus: "posted" });
      continue;
    }
    if (activity.settlesExternalId && prior) {
      duplicates.push(activity.externalId);
      continue;
    }
    insert.push(activity);
    byExternal.set(activity.externalId, { id: "new", externalId: activity.externalId, bankStatus: activity.bankStatus });
  }
  return { insert, settle, duplicates };
}
