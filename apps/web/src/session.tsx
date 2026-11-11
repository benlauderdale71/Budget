import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, clearLocalSession, flushQueue, queuedCount, setQueueOwner } from "./api.js";
import type { HouseholdRow, User } from "./types.js";

interface SessionValue {
  ready: boolean;
  user: User | null;
  households: HouseholdRow[];
  householdId: string;
  spaceId?: string;
  currency: string;
  tick: number;
  offline: boolean;
  queued: number;
  syncError: string;
  refresh: () => Promise<void>;
  bump: () => void;
  chooseHousehold: (id: string) => void;
  chooseSpace: (id: string) => void;
  adoptSpace: (id: string) => void;
  patchMe: (body: Record<string, unknown>) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function applyTheme(theme: string) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [households, setHouseholds] = useState<HouseholdRow[]>([]);
  const [householdId, setHouseholdId] = useState("");
  const [spaceId, setSpaceId] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [queued, setQueued] = useState(queuedCount());
  const [syncError, setSyncError] = useState("");

  async function refresh() {
    const data = await api<{ user: User; households: HouseholdRow[] }>("/api/me");
    setUser(data.user);
    setHouseholds(data.households);
    setQueueOwner(data.user.id);
    applyTheme(data.user.theme);
    const flushed = await flushQueue();
    setQueued(queuedCount());
    setSyncError(flushed.rejected);
    if (flushed.sent) setTick((item) => item + 1);
    const stored = localStorage.getItem("budgetcents.household");
    const next = data.households.find((item) => item.id === stored)?.id ?? data.households[0]?.id ?? "";
    setHouseholdId(next);
    if (next) {
      localStorage.setItem("budgetcents.household", next);
      setSpaceId(localStorage.getItem(`budgetcents.space.${next}`) ?? undefined);
    }
    api("/api/devices", { method: "POST", body: JSON.stringify({ name: "Web browser", platform: "web" }) }).catch(() => undefined);
  }

  useEffect(() => {
    const token = localStorage.getItem("budgetcents.token");
    if (!token) {
      setReady(true);
      return;
    }
    refresh().catch(() => localStorage.removeItem("budgetcents.token")).finally(() => setReady(true));
    const onAuth = () => { setUser(null); setHouseholdId(""); setQueueOwner(null); };
    const onOff = () => setOffline(true);
    const onOn = () => {
      setOffline(false);
      flushQueue().then((flushed) => {
        setQueued(queuedCount());
        setSyncError(flushed.rejected);
        if (flushed.sent) setTick((item) => item + 1);
      });
    };
    const onQueue = () => setQueued(queuedCount());
    window.addEventListener("budgetcents-unauthorized", onAuth);
    window.addEventListener("offline", onOff);
    window.addEventListener("online", onOn);
    window.addEventListener("budgetcents-queue", onQueue);
    return () => {
      window.removeEventListener("budgetcents-unauthorized", onAuth);
      window.removeEventListener("offline", onOff);
      window.removeEventListener("online", onOn);
      window.removeEventListener("budgetcents-queue", onQueue);
    };
  }, []);

  const currency = households.find((item) => item.id === householdId)?.currency ?? "USD";
  const value = useMemo<SessionValue>(() => ({
    ready, user, households, householdId, spaceId, currency, tick, offline, queued, syncError,
    refresh, bump: () => setTick((item) => item + 1),
    chooseHousehold: (id) => {
      localStorage.setItem("budgetcents.household", id);
      setHouseholdId(id);
      setSpaceId(localStorage.getItem(`budgetcents.space.${id}`) ?? undefined);
      setTick((item) => item + 1);
    },
    chooseSpace: (id) => {
      if (householdId) localStorage.setItem(`budgetcents.space.${householdId}`, id);
      setSpaceId(id);
      setTick((item) => item + 1);
    },
    adoptSpace: (id) => setSpaceId((current) => current ?? id),
    patchMe: async (body) => {
      const data = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify(body) });
      setUser(data.user);
      applyTheme(data.user.theme);
    },
    signOut: async () => {
      await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      clearLocalSession();
      setUser(null);
      setHouseholdId("");
    },
  }), [ready, user, households, householdId, spaceId, currency, tick, offline, queued, syncError]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session missing");
  return value;
}

export function scoped(householdId: string, suffix: string, spaceId?: string) {
  const path = `/api/households/${householdId}${suffix}`;
  if (!spaceId) return path;
  return `${path}${suffix.includes("?") ? "&" : "?"}spaceId=${encodeURIComponent(spaceId)}`;
}
