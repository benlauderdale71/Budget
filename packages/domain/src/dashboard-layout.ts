/**
 * Dashboard layout preferences.
 *
 * Device classes follow the window width, not a browser brand.
 * Compact is 860 CSS pixels or dp and narrower. Wider than that is desktop
 * on the web and expanded on Android. Web and Android are stored separately
 * so one does not overwrite the other. Callers must not write a layout merely
 * because the width changed.
 *
 * A legacy `dashboardLayout` array seeds every class with that order and
 * visibility. A missing size uses the card's default. The stored revision
 * stays 0 until a class is saved. Retired ids are dropped. A card added to
 * the catalog later is appended, visible, at its default size.
 */

export const DASHBOARD_COMPACT_MAX_PX = 860;
export const DASHBOARD_LAYOUT_MAX_BYTES = 12_000;
export const DASHBOARD_UNDO_LIMIT = 20;

export const DASHBOARD_DEVICE_CLASSES = ["web-compact", "web-desktop", "android-compact", "android-expanded"] as const;
export type DashboardDeviceClass = (typeof DASHBOARD_DEVICE_CLASSES)[number];
export type DashboardPlatform = "web" | "android";
export type DashboardCardSize = "standard" | "wide";

export const DASHBOARD_CARDS = [
  { id: "safe", label: "Safe to spend", sizes: ["standard"], defaultSize: "standard" },
  { id: "ready", label: "Ready to Assign", sizes: ["standard"], defaultSize: "standard" },
  { id: "worth", label: "Net worth", sizes: ["standard"], defaultSize: "standard" },
  { id: "age", label: "Age of money", sizes: ["standard"], defaultSize: "standard" },
  { id: "committed", label: "Already given a job", sizes: ["standard"], defaultSize: "standard" },
  { id: "bill", label: "Next bill", sizes: ["standard"], defaultSize: "standard" },
  { id: "review", label: "Needs review", sizes: ["standard"], defaultSize: "standard" },
  { id: "goals", label: "Goals", sizes: ["standard"], defaultSize: "standard" },
  { id: "month", label: "This month", sizes: ["standard", "wide"], defaultSize: "wide" },
  { id: "upcoming", label: "Upcoming", sizes: ["standard", "wide"], defaultSize: "wide" },
  { id: "alerts", label: "Alerts", sizes: ["standard", "wide"], defaultSize: "wide" },
  { id: "recent", label: "Recent", sizes: ["standard", "wide"], defaultSize: "wide" },
] as const;

/** Accepted and discarded. `overview` is not rendered. */
export const RETIRED_DASHBOARD_CARDS = ["overview"] as const;

export interface DashboardCardPreference {
  id: string;
  hidden: boolean;
  size: DashboardCardSize;
}

export interface DashboardLayoutState {
  revision: number;
  layouts: Record<DashboardDeviceClass, DashboardCardPreference[]>;
}

export class DashboardLayoutError extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "DashboardLayoutError";
    this.status = status;
  }
}

type CardSpec = (typeof DASHBOARD_CARDS)[number];

function cardSpec(id: string): CardSpec | undefined {
  return DASHBOARD_CARDS.find((card) => card.id === id);
}

export function dashboardCardLabel(id: string): string {
  return cardSpec(id)?.label ?? "Card";
}

export function isDashboardDeviceClass(value: unknown): value is DashboardDeviceClass {
  return typeof value === "string" && (DASHBOARD_DEVICE_CLASSES as readonly string[]).includes(value);
}

export function deviceClassForViewport(platform: DashboardPlatform, width: number): DashboardDeviceClass {
  const compact = !Number.isFinite(width) || width <= DASHBOARD_COMPACT_MAX_PX;
  if (platform === "android") return compact ? "android-compact" : "android-expanded";
  return compact ? "web-compact" : "web-desktop";
}

export function defaultDashboardCards(): DashboardCardPreference[] {
  return DASHBOARD_CARDS.map((card) => ({ id: card.id, hidden: false, size: card.defaultSize }));
}

function copyCard(card: DashboardCardPreference): DashboardCardPreference {
  return { id: card.id, hidden: card.hidden, size: card.size };
}

function emptyState(): DashboardLayoutState {
  const layouts = {} as Record<DashboardDeviceClass, DashboardCardPreference[]>;
  for (const key of DASHBOARD_DEVICE_CLASSES) layouts[key] = defaultDashboardCards();
  return { revision: 0, layouts };
}

function sizeAllowed(id: string, size: string): size is DashboardCardSize {
  const spec = cardSpec(id);
  return !!spec && (spec.sizes as readonly string[]).includes(size);
}

function appendMissing(cards: DashboardCardPreference[]): DashboardCardPreference[] {
  const seen = new Set(cards.map((card) => card.id));
  const next = cards.map(copyCard);
  for (const spec of DASHBOARD_CARDS) {
    if (seen.has(spec.id)) continue;
    next.push({ id: spec.id, hidden: false, size: spec.defaultSize });
  }
  return next;
}

function normalizeCards(input: unknown, mode: "read" | "write"): DashboardCardPreference[] {
  if (!Array.isArray(input)) {
    if (mode === "write") throw new DashboardLayoutError(400, "The dashboard layout needs a list of cards.");
    return defaultDashboardCards();
  }
  if (input.length > DASHBOARD_CARDS.length + RETIRED_DASHBOARD_CARDS.length) {
    throw new DashboardLayoutError(400, "That dashboard layout has too many cards.");
  }
  const cards: DashboardCardPreference[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      if (mode === "write") throw new DashboardLayoutError(400, "A dashboard card is missing its name.");
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id) {
      if (mode === "write") throw new DashboardLayoutError(400, "A dashboard card is missing its name.");
      continue;
    }
    if ((RETIRED_DASHBOARD_CARDS as readonly string[]).includes(id)) continue;
    const spec = cardSpec(id);
    if (!spec) {
      if (mode === "write") throw new DashboardLayoutError(400, "That dashboard card is not supported.");
      continue;
    }
    if (seen.has(id)) {
      if (mode === "write") throw new DashboardLayoutError(400, `${spec.label} is listed more than once.`);
      continue;
    }
    seen.add(id);
    if (mode === "write" && typeof record.hidden !== "boolean") {
      throw new DashboardLayoutError(400, `${spec.label} needs a visibility choice.`);
    }
    const hidden = record.hidden === true;
    let size = spec.defaultSize as DashboardCardSize;
    if (record.size !== undefined) {
      if (typeof record.size !== "string" || !sizeAllowed(id, record.size)) {
        if (mode === "write") throw new DashboardLayoutError(400, `${record.size} is not a size for ${spec.label}.`);
      } else {
        size = record.size;
      }
    }
    cards.push({ id, hidden, size });
  }
  return appendMissing(cards);
}

function layoutsFrom(cards: DashboardCardPreference[]): Record<DashboardDeviceClass, DashboardCardPreference[]> {
  const layouts = {} as Record<DashboardDeviceClass, DashboardCardPreference[]>;
  for (const key of DASHBOARD_DEVICE_CLASSES) layouts[key] = cards.map(copyCard);
  return layouts;
}

export function readDashboardLayout(stored: unknown): DashboardLayoutState {
  if (Array.isArray(stored)) {
    return { revision: 0, layouts: layoutsFrom(normalizeCards(stored, "read")) };
  }
  if (!stored || typeof stored !== "object") return emptyState();
  const record = stored as Record<string, unknown>;
  const revision = typeof record.revision === "number" && Number.isInteger(record.revision) && record.revision >= 0 && record.revision <= 1_000_000_000
    ? record.revision
    : 0;
  const source = record.layouts && typeof record.layouts === "object" && !Array.isArray(record.layouts)
    ? record.layouts as Record<string, unknown>
    : {};
  const layouts = {} as Record<DashboardDeviceClass, DashboardCardPreference[]>;
  for (const key of DASHBOARD_DEVICE_CLASSES) layouts[key] = normalizeCards(source[key], "read");
  return { revision, layouts };
}

export function updateDashboardLayout(current: DashboardLayoutState, input: unknown): DashboardLayoutState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DashboardLayoutError(400, "Choose the device layout to save.");
  }
  const body = input as Record<string, unknown>;
  if (!isDashboardDeviceClass(body.deviceClass)) throw new DashboardLayoutError(400, "Choose a dashboard layout for this device.");
  if (typeof body.revision !== "number" || !Number.isInteger(body.revision) || body.revision < 0 || body.revision > 1_000_000_000) {
    throw new DashboardLayoutError(400, "The dashboard layout revision is missing.");
  }
  if (body.revision !== current.revision) {
    throw new DashboardLayoutError(409, "This dashboard layout was changed somewhere else. Reload it and try again.");
  }
  const cards = normalizeCards(body.cards, "write");
  const layouts = {} as Record<DashboardDeviceClass, DashboardCardPreference[]>;
  for (const key of DASHBOARD_DEVICE_CLASSES) {
    layouts[key] = key === body.deviceClass ? cards : current.layouts[key].map(copyCard);
  }
  return { revision: current.revision + 1, layouts };
}

export function moveDashboardCard(cards: readonly DashboardCardPreference[], id: string, direction: -1 | 1): DashboardCardPreference[] {
  const items = cards.map(copyCard);
  const index = items.findIndex((card) => card.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
  return items;
}

export function withDashboardVisibility(cards: readonly DashboardCardPreference[], id: string, hidden: boolean): DashboardCardPreference[] {
  return cards.map((card) => card.id === id ? { ...copyCard(card), hidden } : copyCard(card));
}

export function withDashboardSize(cards: readonly DashboardCardPreference[], id: string, size: DashboardCardSize): DashboardCardPreference[] {
  if (!sizeAllowed(id, size)) throw new DashboardLayoutError(400, `${size} is not a size for ${dashboardCardLabel(id)}.`);
  return cards.map((card) => card.id === id ? { ...copyCard(card), size } : copyCard(card));
}

/** Rows follow the saved order. A wide card starts its own row, so a later card cannot slide up beside an earlier one. */
export function dashboardDisplayRows(cards: readonly DashboardCardPreference[], columns: number): DashboardCardPreference[][] {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  const visible = cards.filter((card) => !card.hidden).map(copyCard);
  if (width === 1) return visible.map((card) => [card]);
  const rows: DashboardCardPreference[][] = [];
  let row: DashboardCardPreference[] = [];
  for (const card of visible) {
    if (card.size === "wide") {
      if (row.length) rows.push(row);
      row = [];
      rows.push([card]);
      continue;
    }
    row.push(card);
    if (row.length === width) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows;
}
