import { allows } from "@budgetcents/domain/access";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, clearLocalSession, flushQueue, queuedCount, setQueueOwner } from "./api.js";
import { clearDashboardCaches } from "./offline-cache.js";
import type { HouseholdRow, User } from "./types.js";

interface SessionValue {
  ready: boolean;
  user: User | null;
  households: HouseholdRow[];
  householdId: string;
  spaceId?: string;
  currency: string;
  tick: number;
  draftEpoch: number;
  incoming: string;
  offline: boolean;
  queued: number;
  syncError: string;
  refresh: (preferHouseholdId?: string) => Promise<void>;
  bump: () => void;
  holdDraft: () => () => void;
  acceptIncoming: () => void;
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
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [incoming, setIncoming] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [queued, setQueued] = useState(queuedCount());
  const [syncError, setSyncError] = useState("");
  const userIdRef = useRef<string | null>(null);
  const sessionGen = useRef(0);
  const holds = useRef(0);
  const refreshRef = useRef<(preferHouseholdId?: string) => Promise<void>>(async () => undefined);
  userIdRef.current = user?.id ?? null;

  async function refresh(preferHouseholdId?: string) {
    const data = await api<{ user: User; households: HouseholdRow[] }>("/api/me");
    await api("/api/auth/market-session", { method: "POST" }, { queue: false }).catch(() => undefined);
    setUser(data.user);
    setHouseholds(data.households);
    setQueueOwner(data.user.id);
    applyTheme(data.user.theme);
    const flushed = await flushQueue();
    setQueued(queuedCount());
    setSyncError(flushed.rejected);
    if (flushed.sent) setTick((item) => item + 1);
    if (preferHouseholdId) localStorage.setItem("budgetcents.household", preferHouseholdId);
    const stored = localStorage.getItem("budgetcents.household");
    const next = data.households.find((item) => item.id === stored)?.id ?? data.households[0]?.id ?? "";
    if (!next) {
      localStorage.removeItem("budgetcents.household");
      localStorage.removeItem(PROFILE);
      setHouseholdId("");
      setSpaceId(undefined);
      return;
    }
    setHouseholdId(next);
    const storedSpace = localStorage.getItem(`budgetcents.space.${next}`) ?? undefined;
    localStorage.setItem("budgetcents.household", next);
    setSpaceId(storedSpace);
    writeProfile(data.user, data.households, next, storedSpace);
    api("/api/devices", { method: "POST", body: JSON.stringify({ name: "Web browser", platform: "web" }) }).catch(() => undefined);
  }

  refreshRef.current = refresh;

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
    let accessAt = 0;
    const onAccess = () => {
      const now = Date.now();
      if (now - accessAt < 1000) return;
      accessAt = now;
      clearDashboardCaches(localStorage);
      refresh().catch(() => undefined);
    };
    window.addEventListener("budgetcents-unauthorized", onAuth);
    window.addEventListener("budgetcents-access", onAccess);
    window.addEventListener("offline", onOff);
    window.addEventListener("online", onOn);
    window.addEventListener("budgetcents-queue", onQueue);
    const token = localStorage.getItem("budgetcents.token");
    if (!token) setReady(true);
    else {
      refresh().catch((error: unknown) => {
        const denied = error instanceof ApiError && error.status === 401;
        if (!denied && error instanceof ApiError && restoreProfile()) return;
        localStorage.removeItem("budgetcents.token");
        localStorage.removeItem(PROFILE);
      }).finally(() => setReady(true));
    }
    return () => {
      window.removeEventListener("budgetcents-unauthorized", onAuth);
      window.removeEventListener("budgetcents-access", onAccess);
      window.removeEventListener("offline", onOff);
      window.removeEventListener("online", onOn);
      window.removeEventListener("budgetcents-queue", onQueue);
    };
  }, []);

  useEffect(() => {
    if (!user?.id || !householdId) return;
    const watchedUser = user.id;
    const watchedHousehold = householdId;
    let since = new Date().toISOString();
    let seenPlan = -1;
    let seenRole = "";
    let seenAlert = -1;
    let stop = false;
    const poll = async () => {
      if (stop || document.hidden || !navigator.onLine) return;
      const gen = sessionGen.current;
      try {
        const data = await api<{ serverTime: string; planRevision: number; role: string; alertVersion: number; events: unknown[] }>(`/api/households/${watchedHousehold}/changes?since=${encodeURIComponent(since)}`);
        if (stop || gen !== sessionGen.current || userIdRef.current !== watchedUser) return;
        since = data.serverTime;
        const roleChanged = seenRole !== "" && seenRole !== data.role;
        const changed = (seenPlan >= 0 && seenPlan !== data.planRevision) || roleChanged || (seenAlert >= 0 && seenAlert !== data.alertVersion) || data.events.length > 0;
        seenPlan = data.planRevision;
        seenRole = data.role;
        seenAlert = data.alertVersion;
        if (roleChanged) await refreshRef.current();
        if (!changed || stop || gen !== sessionGen.current) return;
        if (holds.current > 0) setIncoming("Someone else saved a change. Your unsaved text is still here. Reload when you want to replace it.");
        else {
          setIncoming("");
          setTick((item) => item + 1);
        }
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) refreshRef.current().catch(() => undefined);
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 12000);
    const onVisible = () => { if (!document.hidden && navigator.onLine) void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      stop = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [user?.id, householdId]);

  const currency = households.find((item) => item.id === householdId)?.currency ?? "USD";
  const value = useMemo<SessionValue>(() => ({
    ready, user, households, householdId, spaceId, currency, tick, draftEpoch, incoming, offline, queued, syncError,
    refresh, bump: () => setTick((item) => item + 1),
    holdDraft: () => {
      holds.current += 1;
      return () => { holds.current = Math.max(0, holds.current - 1); };
    },
    acceptIncoming: () => {
      setIncoming("");
      setDraftEpoch((item) => item + 1);
      setTick((item) => item + 1);
    },
    chooseHousehold: (id) => {
      sessionGen.current += 1;
      holds.current = 0;
      setIncoming("");
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
      holds.current = 0;
      userIdRef.current = null;
      await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      clearLocalSession();
      setUser(null);
      setHouseholdId("");
    },
  }), [ready, user, households, householdId, spaceId, currency, tick, draftEpoch, incoming, offline, queued, syncError]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

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
    readOnly: role !== "" && !allows(role, "finance"),
    canWrite: allows(role, "finance"),
    canBudget: allows(role, "plan"),
    canComment: allows(role, "comment"),
    canReview: allows(role, "review"),
    canInvite: allows(role, "invite"),
    canTransfer: allows(role, "transfer"),
  };
}

export function scoped(householdId: string, suffix: string, spaceId?: string) {
  const path = `/api/households/${householdId}${suffix}`;
  if (!spaceId) return path;
  return `${path}${suffix.includes("?") ? "&" : "?"}spaceId=${encodeURIComponent(spaceId)}`;
}

