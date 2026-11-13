export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PREFIX = "budgetcents.cache.";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedDashboard {
  savedAt: string;
  dashboard: unknown;
}

function keyFor(userId: string, householdId: string) {
  return `${PREFIX}${userId}.${householdId}`;
}

export function writeDashboardCache(store: CacheStorage, userId: string, householdId: string, dashboard: unknown, now = Date.now()) {
  if (!userId || !householdId) return;
  store.setItem(keyFor(userId, householdId), JSON.stringify({ savedAt: new Date(now).toISOString(), dashboard }));
}

export function readDashboardCache(store: CacheStorage, userId: string, householdId: string, now = Date.now()): CachedDashboard | null {
  if (!userId || !householdId) return null;
  const key = keyFor(userId, householdId);
  const raw = store.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedDashboard;
    if (!parsed.savedAt || Date.parse(parsed.savedAt) + MAX_AGE_MS < now) {
      store.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    store.removeItem(key);
    return null;
  }
}

export function forgetHouseholdCache(store: CacheStorage, userId: string, householdId: string) {
  store.removeItem(keyFor(userId, householdId));
}

export function clearDashboardCaches(store: CacheStorage) {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  for (const key of keys) store.removeItem(key);
}
