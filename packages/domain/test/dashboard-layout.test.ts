import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CARDS,
  DashboardLayoutError,
  dashboardDisplayRows,
  defaultDashboardCards,
  deviceClassForViewport,
  moveDashboardCard,
  readDashboardLayout,
  updateDashboardLayout,
  withDashboardSize,
  withDashboardVisibility,
} from "../src/dashboard-layout.js";

const legacy = [
  { id: "worth", hidden: false },
  { id: "safe", hidden: false },
  { id: "goals", hidden: true },
  { id: "overview", hidden: false },
  { id: "worth", hidden: true },
  { id: "not-a-card", hidden: false },
];

describe("dashboard layout", () => {
  it("seeds every device class from a legacy list without losing order or visibility", () => {
    const state = readDashboardLayout(legacy);
    expect(state.revision).toBe(0);
    for (const cards of Object.values(state.layouts)) {
      expect(cards.map((card) => card.id).slice(0, 3)).toEqual(["worth", "safe", "goals"]);
      expect(cards.find((card) => card.id === "goals")?.hidden).toBe(true);
      expect(cards.find((card) => card.id === "worth")?.hidden).toBe(false);
      expect(cards.find((card) => card.id === "recent")?.size).toBe("wide");
      expect(cards.map((card) => card.id)).not.toContain("overview");
      expect(cards.map((card) => card.id)).not.toContain("not-a-card");
      expect(new Set(cards.map((card) => card.id)).size).toBe(DASHBOARD_CARDS.length);
    }
    expect(readDashboardLayout([])).toEqual(readDashboardLayout(undefined));
    expect(readDashboardLayout([]).layouts["web-desktop"][0].id).toBe("safe");
  });

  it("keeps order when another card is hidden, and size when a card is moved", () => {
    const seeded = readDashboardLayout(legacy).layouts["web-desktop"];
    const hidden = withDashboardVisibility(seeded, "ready", true);
    expect(hidden.map((card) => card.id)[0]).toBe("worth");
    expect(hidden.find((card) => card.id === "goals")?.hidden).toBe(true);
    expect(hidden.find((card) => card.id === "ready")?.hidden).toBe(true);
    const restored = withDashboardVisibility(hidden, "goals", false);
    expect(restored.findIndex((card) => card.id === "goals")).toBe(hidden.findIndex((card) => card.id === "goals"));
    expect(restored.find((card) => card.id === "goals")?.hidden).toBe(false);
    const sized = withDashboardSize(seeded, "recent", "standard");
    const moved = moveDashboardCard(sized, "recent", -1);
    expect(moved.find((card) => card.id === "recent")?.size).toBe("standard");
    expect(moved.findIndex((card) => card.id === "recent")).toBe(sized.findIndex((card) => card.id === "recent") - 1);
    expect(moveDashboardCard(seeded, "worth", -1).map((card) => card.id)).toEqual(seeded.map((card) => card.id));
    const last = seeded[seeded.length - 1].id;
    expect(moveDashboardCard(seeded, last, 1).map((card) => card.id)).toEqual(seeded.map((card) => card.id));
    expect(() => withDashboardSize(seeded, "safe", "wide")).toThrow(DashboardLayoutError);
  });

  it("does not let a wide card pull a later card up beside an earlier one", () => {
    let ordered = defaultDashboardCards();
    while (ordered.findIndex((card) => card.id === "month") > 1) ordered = moveDashboardCard(ordered, "month", -1);
    const rows = dashboardDisplayRows(ordered, 4);
    const flat = rows.flat().map((card) => card.id);
    expect(flat).toEqual(ordered.filter((card) => !card.hidden).map((card) => card.id));
    expect(flat.indexOf("safe")).toBeLessThan(flat.indexOf("month"));
    expect(flat.indexOf("month")).toBeLessThan(flat.indexOf("ready"));
    expect(rows.find((row) => row.some((card) => card.id === "month"))).toHaveLength(1);
    expect(rows.find((row) => row.some((card) => card.id === "safe"))?.some((card) => card.id === "ready")).toBe(false);
    expect(dashboardDisplayRows(ordered, 1).map((row) => row[0].id)).toEqual(flat);
  });

  it("updates one device class and rejects a stale revision", () => {
    expect(deviceClassForViewport("web", 860)).toBe("web-compact");
    expect(deviceClassForViewport("web", 861)).toBe("web-desktop");
    expect(deviceClassForViewport("android", 320)).toBe("android-compact");
    expect(deviceClassForViewport("android", 900)).toBe("android-expanded");
    const current = readDashboardLayout(legacy);
    const desktop = moveDashboardCard(current.layouts["web-desktop"], "safe", -1);
    const next = updateDashboardLayout(current, { deviceClass: "web-desktop", revision: 0, cards: desktop });
    expect(next.revision).toBe(1);
    expect(next.layouts["web-desktop"][0].id).toBe("safe");
    expect(next.layouts["web-compact"][0].id).toBe("worth");
    expect(next.layouts["android-compact"][0].id).toBe("worth");
    expect(() => updateDashboardLayout(next, { deviceClass: "web-desktop", revision: 0, cards: desktop })).toThrow(/changed somewhere else/);
    const undone = updateDashboardLayout(next, { deviceClass: "web-desktop", revision: 1, cards: current.layouts["web-desktop"] });
    expect(undone.layouts["web-desktop"][0].id).toBe("worth");
    expect(undone.layouts["android-expanded"][0].id).toBe("worth");
    expect(() => updateDashboardLayout(current, { deviceClass: "phone", revision: 0, cards: desktop })).toThrow(/this device/);
    expect(() => updateDashboardLayout(current, [])).toThrow(/device layout/);
    expect(() => updateDashboardLayout(current, {
      deviceClass: "web-desktop",
      revision: 0,
      cards: [...desktop, desktop[0]],
    })).toThrow(/more than once/);
  });

  it("appends a newly introduced card and drops a retired one on save", () => {
    const cards = defaultDashboardCards().filter((card) => card.id !== "alerts");
    cards.unshift({ id: "overview", hidden: true, size: "standard" });
    const next = updateDashboardLayout(readDashboardLayout([]), { deviceClass: "android-expanded", revision: 0, cards });
    const saved = next.layouts["android-expanded"];
    expect(saved.map((card) => card.id)).not.toContain("overview");
    expect(saved[saved.length - 1].id).toBe("alerts");
    expect(saved[saved.length - 1]).toMatchObject({ hidden: false, size: "wide" });
    expect(next.layouts["web-desktop"][0].id).toBe("safe");
  });
});
