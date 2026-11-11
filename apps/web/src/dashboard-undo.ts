import { DASHBOARD_UNDO_LIMIT, type DashboardCardPreference } from "@budgetcents/domain/dashboard-layout";

/** Tab-local dashboard undo. This is not the transaction queue and not a financial history. */
export const DASHBOARD_UNDO_STORAGE = "budgetcents.dashboardUndo";

export type UndoStacks = Map<string, DashboardCardPreference[][]>;

function copyCards(cards: readonly DashboardCardPreference[]): DashboardCardPreference[] {
  return cards.map((card) => ({ id: card.id, hidden: card.hidden, size: card.size }));
}

function validCards(value: unknown): DashboardCardPreference[] | null {
  if (!Array.isArray(value)) return null;
  const cards: DashboardCardPreference[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const card = item as Partial<DashboardCardPreference>;
    if (typeof card.id !== "string" || card.id.length === 0 || card.id.length > 40) return null;
    if (typeof card.hidden !== "boolean") return null;
    if (card.size !== "standard" && card.size !== "wide") return null;
    cards.push({ id: card.id, hidden: card.hidden, size: card.size });
  }
  return cards;
}

/** Keeps stacks for this user only. Another user's saved undo is ignored. */
export function readUndoStacks(raw: string | null, userId: string): UndoStacks {
  const stacks: UndoStacks = new Map();
  if (!userId) return stacks;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return stacks;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return stacks;
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith(`${userId}:`) || !Array.isArray(value)) continue;
    const stack: DashboardCardPreference[][] = [];
    let valid = true;
    for (const entry of value) {
      const cards = validCards(entry);
      if (!cards) {
        valid = false;
        break;
      }
      stack.push(cards);
    }
    if (valid && stack.length) stacks.set(key, stack.slice(-DASHBOARD_UNDO_LIMIT));
  }
  return stacks;
}

export function writeUndoStacks(stacks: UndoStacks): string {
  const record: Record<string, DashboardCardPreference[][]> = {};
  for (const [key, stack] of stacks) {
    if (stack.length) record[key] = stack.map((cards) => copyCards(cards));
  }
  return JSON.stringify(record);
}

export function withUndoStack(stacks: UndoStacks, key: string, stack: readonly (readonly DashboardCardPreference[])[]): UndoStacks {
  const next: UndoStacks = new Map(stacks);
  const copied = stack.map((cards) => copyCards(cards)).slice(-DASHBOARD_UNDO_LIMIT);
  if (copied.length) next.set(key, copied);
  else next.delete(key);
  return next;
}
