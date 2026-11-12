import assert from "node:assert/strict";
import test from "node:test";
import { clearDashboardCaches, readDashboardCache, writeDashboardCache } from "../src/offline-cache.ts";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test("a dashboard cache stays with its user and household and expires", () => {
  const store = memory();
  const now = Date.parse("2026-11-12T00:00:00Z");
  writeDashboardCache(store, "owner", "home", { budget: { readyToAssignMinor: 1000 } }, now);
  writeDashboardCache(store, "editor", "home", { budget: { readyToAssignMinor: 5 } }, now);
  assert.equal((readDashboardCache(store, "owner", "home", now)?.dashboard as { budget: { readyToAssignMinor: number } }).budget.readyToAssignMinor, 1000);
  assert.equal(readDashboardCache(store, "owner", "other", now), null);
  assert.equal((readDashboardCache(store, "editor", "home", now)?.dashboard as { budget: { readyToAssignMinor: number } }).budget.readyToAssignMinor, 5);
  assert.equal(readDashboardCache(store, "owner", "home", now + 8 * 24 * 60 * 60 * 1000), null);
  writeDashboardCache(store, "owner", "home", { budget: { readyToAssignMinor: 1000 } }, now);
  clearDashboardCaches(store);
  assert.equal(readDashboardCache(store, "owner", "home", now), null);
  assert.equal(readDashboardCache(store, "editor", "home", now), null);
});
