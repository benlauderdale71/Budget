import type { Split, Transaction } from "./types.js";

export interface RuleCondition {
  field: "payee" | "description" | "account" | "amount" | "direction";
  op: "contains" | "equals" | "starts" | "gt" | "lt" | "eq" | "between";
  value?: string;
  valueMinor?: number;
  valueMinor2?: number;
}

export interface RuleAction {
  type: "set_payee" | "set_bucket" | "add_tag" | "set_owner" | "set_reviewer" | "set_space" | "set_splits" | "exclude";
  value?: string;
  splits?: Split[];
}

export interface Rule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  matchMode: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  stop?: boolean;
}

export interface RuleApplication {
  transaction: Transaction;
  matchedRuleIds: string[];
  changes: string[];
  skipped: string[];
}

function textOf(txn: Transaction, field: "payee" | "description" | "account"): string {
  if (field === "payee") return txn.payee ?? "";
  if (field === "description") return txn.originalDescription ?? "";
  return txn.accountId;
}

function conditionMatches(txn: Transaction, condition: RuleCondition): boolean {
  if (condition.field === "amount") {
    const amount = Math.abs(txn.amountMinor);
    if (condition.op === "gt") return amount > (condition.valueMinor ?? 0);
    if (condition.op === "lt") return amount < (condition.valueMinor ?? 0);
    if (condition.op === "eq") return amount === condition.valueMinor;
    if (condition.op === "between") return amount >= (condition.valueMinor ?? 0) && amount <= (condition.valueMinor2 ?? 0);
    return false;
  }
  if (condition.field === "direction") {
    const direction = txn.amountMinor < 0 ? "outflow" : "inflow";
    return direction === condition.value;
  }
  const hay = textOf(txn, condition.field).toLowerCase();
  const needle = (condition.value ?? "").toLowerCase();
  if (condition.op === "contains") return needle.length > 0 && hay.includes(needle);
  if (condition.op === "equals") return hay === needle;
  if (condition.op === "starts") return hay.startsWith(needle);
  return false;
}

export function applyRules(txn: Transaction, rules: Rule[]): RuleApplication {
  const ordered = [...rules].filter((rule) => rule.enabled).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  let next: Transaction = { ...txn, tags: [...(txn.tags ?? [])], splits: txn.splits.map((split) => ({ ...split })) };
  const matched: string[] = [];
  const changes: string[] = [];
  const skipped: string[] = [];
  for (const rule of ordered) {
    const results = rule.conditions.map((condition) => conditionMatches(next, condition));
    const ok = rule.matchMode === "any" ? results.some(Boolean) : results.every(Boolean);
    if (!ok) continue;
    matched.push(rule.id);
    for (const action of rule.actions) {
      if ((action.type === "set_bucket" || action.type === "set_splits") && next.categoryLockedByUser) {
        skipped.push(`${rule.id} did not override a category you confirmed`);
        continue;
      }
      if (action.type === "set_payee" && action.value) {
        next = { ...next, payee: action.value };
        changes.push(`Payee set by ${rule.name}`);
      } else if (action.type === "set_bucket" && action.value) {
        const magnitude = Math.abs(next.amountMinor);
        next = {
          ...next,
          splits: [{ bucketId: action.value, amountMinor: magnitude, role: next.amountMinor >= 0 ? "income" : "expense" }],
        };
        changes.push(`Category set by ${rule.name}`);
      } else if (action.type === "add_tag" && action.value && !next.tags?.includes(action.value)) {
        next = { ...next, tags: [...(next.tags ?? []), action.value] };
        changes.push(`Tag ${action.value}`);
      } else if (action.type === "set_owner" && action.value) {
        next = { ...next, ownerUserId: action.value };
        changes.push("Owner set");
      } else if (action.type === "set_reviewer") {
        next = { ...next, reviewStatus: "needs_review" };
        changes.push("Marked for review");
      } else if (action.type === "set_space" && action.value) {
        next = { ...next, businessSpaceId: action.value };
        changes.push("Business space set");
      } else if (action.type === "set_splits" && action.splits) {
        next = { ...next, splits: action.splits.map((split) => ({ ...split })) };
        changes.push("Splits set");
      } else if (action.type === "exclude") {
        next = { ...next, excludeFromReports: true };
        changes.push("Excluded from reports");
      }
    }
    if (rule.stop) break;
  }
  return { transaction: next, matchedRuleIds: matched, changes, skipped };
}

export function suggestBucket(payee: string, history: Transaction[]): { bucketId: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const txn of history) {
    if (!txn.categoryLockedByUser && txn.reviewStatus !== "reviewed") continue;
    if (txn.payee.toLowerCase() !== payee.toLowerCase()) continue;
    for (const split of txn.splits) {
      if (!split.bucketId) continue;
      counts.set(split.bucketId, (counts.get(split.bucketId) ?? 0) + 1);
    }
  }
  let best: { bucketId: string; count: number } | null = null;
  for (const [bucketId, count] of counts) {
    if (!best || count > best.count) best = { bucketId, count };
  }
  return best;
}
