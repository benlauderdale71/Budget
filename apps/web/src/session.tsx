import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, clearLocalSession, flushQueue, queuedCount, setQueueOwner } from "./api.js";
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
  patchMe: (body: Record<string, unknown>) => Promise<boolean>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const PROFILE = "budgetcents.profile";

function writeProfile(user: User, households: HouseholdRow[], householdId: string, spaceId?: string) {
  localStorage.setItem(PROFILE, JSON.stringify({ user, households, householdId, spaceId }));
}

function readProfile(): { user: User; households: HouseholdRow[]; householdId: string; spaceId?: string } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE) || "null") as { user?: User; households?: HouseholdRow[]; householdId?: string; spaceId?: string } | null;
    if (!parsed?.user?.id || !parsed.households || !parsed.householdId) return null;
    return { user: parsed.user, households: parsed.households, householdId: parsed.householdId, spaceId: parsed.spaceId };
  } catch {
    return null;
  }
}

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
  const userIdRef = useRef<string | null>(null);
  const sessionGen = useRef(0);
  userIdRef.current = user?.id ?? null;

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
    const storedSpace = next ? localStorage.getItem(`budgetcents.space.${next}`) ?? undefined : undefined;
    if (next) {
      localStorage.setItem("budgetcents.household", next);
      setSpaceId(storedSpace);
    }
    writeProfile(data.user, data.households, next, storedSpace);
    api("/api/devices", { method: "POST", body: JSON.stringify({ name: "Web browser", platform: "web" }) }).catch(() => undefined);
  }

  function restoreProfile() {
    const cached = readProfile();
    if (!cached) return false;
    setUser(cached.user);
    setHouseholds(cached.households);
    setHouseholdId(cached.householdId);
    setSpaceId(cached.spaceId);
    setQueueOwner(cached.user.id);
    applyTheme(cached.user.theme);
    return true;
  }

  useEffect(() => {
    const token = localStorage.getItem("budgetcents.token");
    if (!token) {
      setReady(true);
      return;
    }
    refresh().catch((error: unknown) => {
      const denied = error instanceof ApiError && error.status === 401;
      if (!denied && error instanceof ApiError && restoreProfile()) return;
      localStorage.removeItem("budgetcents.token");
      localStorage.removeItem(PROFILE);
    }).finally(() => setReady(true));
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
      const owner = userIdRef.current;
      const gen = sessionGen.current;
      const data = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify(body) });
      if (sessionGen.current !== gen || userIdRef.current !== owner || !owner || data.user.id !== owner) return false;
      setUser(data.user);
      applyTheme(data.user.theme);
      writeProfile(data.user, households, householdId, spaceId);
      return true;
    },
    signOut: async () => {
      sessionGen.current += 1;
      userIdRef.current = null;
      await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      clearLocalSession();
      setUser(null);
      setHouseholdId("");
    },
  }), [ready, user, households, householdId, spaceId, currency, tick, offline, queued, syncError]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

const READ_ONLY_ROLES = new Set(["readonly", "coach", "planner", "accountant"]);

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session missing");
  return value;
}

export function useAccess() {
  const session = useSession();
  const role = session.households.find((item) => item.id === session.householdId)?.role ?? "";
  return {
    role,
    readOnly: READ_ONLY_ROLES.has(role),
    canWrite: !READ_ONLY_ROLES.has(role),
    canBudget: role !== "contributor" && !READ_ONLY_ROLES.has(role),
  };
}

export function scoped(householdId: string, suffix: string, spaceId?: string) {
  const path = `/api/households/${householdId}${suffix}`;
  if (!spaceId) return path;
  return `${path}${suffix.includes("?") ? "&" : "?"}spaceId=${encodeURIComponent(spaceId)}`;
}
