import { afterEach, describe, expect, it } from "vitest";
import { defaultDashboardCards } from "@budgetcents/domain";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;

afterEach(async () => {
  await db?.close();
});

async function app() {
  db = await openMemoryDatabase();
  return createApp(db);
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function household(api: Awaited<ReturnType<typeof app>>, email: string) {
  const registered = await json(await api.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", displayName: email, householdName: email }),
  }));
  const token = registered.body.token as string;
  const userId = registered.body.user.id as string;
  const hid = (await json(await api.request("/api/households", { headers: auth(token) }))).body.households[0].id as string;
  const dash = await json(await api.request(`/api/households/${hid}/dashboard?asOf=2026-11-20`, { headers: auth(token) }));
  return { token, userId, hid, spaceId: dash.body.spaceId as string };
}

function layoutBody(deviceClass: string, revision: number, cards: unknown) {
  return JSON.stringify({ dashboardLayout: { deviceClass, revision, cards } });
}

describe("dashboard layout preferences", () => {
  it("migrates a legacy list, then hides a card without resetting order or another device class", async () => {
    const api = await app();
    const home = await household(api, "legacy-layout@example.com");
    await db.query(`UPDATE users SET dashboard_layout = $1, theme = 'dark', onboarding_step = 'done' WHERE id = $2`, [
      JSON.stringify([{ id: "worth", hidden: false }, { id: "safe", hidden: false }, { id: "goals", hidden: true }]),
      home.userId,
    ]);
    const seeded = await json(await api.request("/api/me", { headers: auth(home.token) }));
    expect(seeded.body.user.theme).toBe("dark");
    expect(seeded.body.user.onboardingStep).toBe("done");
    expect(seeded.body.user.dashboardLayout.revision).toBe(0);
    expect(seeded.body.user.dashboardLayout.layouts["web-desktop"].map((card: { id: string }) => card.id).slice(0, 3)).toEqual(["worth", "safe", "goals"]);
    expect(seeded.body.user.dashboardLayout.layouts["android-compact"][0].id).toBe("worth");
    const cards = seeded.body.user.dashboardLayout.layouts["web-desktop"].map((card: { id: string; hidden: boolean; size: string }) => ({ ...card }));
    const ready = cards.find((card: { id: string }) => card.id === "ready");
    ready.hidden = true;
    const hidden = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", 0, cards),
    }));
    expect(hidden.status).toBe(200);
    const desktop = hidden.body.user.dashboardLayout.layouts["web-desktop"];
    expect(desktop[0].id).toBe("worth");
    expect(desktop.find((card: { id: string }) => card.id === "goals").hidden).toBe(true);
    expect(desktop.find((card: { id: string }) => card.id === "ready").hidden).toBe(true);
    expect(hidden.body.user.dashboardLayout.layouts["web-compact"][0].id).toBe("worth");
    expect(hidden.body.user.dashboardLayout.layouts["web-compact"].find((card: { id: string }) => card.id === "ready").hidden).toBe(false);
    expect(hidden.body.user.theme).toBe("dark");
    expect(hidden.body.user.onboardingStep).toBe("done");
    const sized = desktop.map((card: { id: string; hidden: boolean; size: string }) => card.id === "recent" ? { ...card, size: "standard" } : card);
    const recentAt = sized.findIndex((card: { id: string }) => card.id === "recent");
    const moved = sized.slice();
    const [recent] = moved.splice(recentAt, 1);
    moved.splice(recentAt - 1, 0, recent);
    const resized = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", hidden.body.user.dashboardLayout.revision, moved),
    }));
    const after = resized.body.user.dashboardLayout.layouts["web-desktop"];
    expect(after.find((card: { id: string }) => card.id === "recent").size).toBe("standard");
    expect(after.findIndex((card: { id: string }) => card.id === "recent")).toBe(recentAt - 1);
    const restoredCards = after.map((card: { id: string; hidden: boolean; size: string }) => card.id === "goals" ? { ...card, hidden: false } : card);
    const restored = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", resized.body.user.dashboardLayout.revision, restoredCards),
    }));
    const goals = restored.body.user.dashboardLayout.layouts["web-desktop"].find((card: { id: string }) => card.id === "goals");
    expect(goals.hidden).toBe(false);
    expect(restored.body.user.dashboardLayout.layouts["web-desktop"].findIndex((card: { id: string }) => card.id === "goals")).toBe(after.findIndex((card: { id: string }) => card.id === "goals"));
    const reset = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", restored.body.user.dashboardLayout.revision, defaultDashboardCards()),
    }));
    expect(reset.body.user.dashboardLayout.layouts["web-desktop"][0].id).toBe("safe");
    expect(reset.body.user.dashboardLayout.layouts["android-expanded"][0].id).toBe("worth");
    const undone = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", reset.body.user.dashboardLayout.revision, restoredCards),
    }));
    expect(undone.body.user.dashboardLayout.layouts["web-desktop"].find((card: { id: string }) => card.id === "recent").size).toBe("standard");
    expect(undone.body.user.theme).toBe("dark");
  });

  it("rejects a bad layout, a stale revision, and a second write of the same revision", async () => {
    const api = await app();
    const home = await household(api, "layout-conflict@example.com");
    const cards = defaultDashboardCards();
    const wideSafe = cards.map((card) => card.id === "safe" ? { ...card, size: "wide" } : card);
    const badSize = await json(await api.request("/api/me", { method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", 0, wideSafe) }));
    expect(badSize.status).toBe(400);
    const duplicate = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", 0, [...cards, cards[0]]),
    }));
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toMatch(/more than once/);
    const huge = { deviceClass: "web-desktop", revision: 0, cards: [{ id: "safe", hidden: false, size: "standard", note: "x".repeat(13_000) }] };
    const tooBig = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(home.token), body: JSON.stringify({ dashboardLayout: huge }),
    }));
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatch(/too large/);
    const missing = cards.filter((card) => card.id !== "alerts");
    const added = await json(await api.request("/api/me", { method: "PATCH", headers: auth(home.token), body: layoutBody("android-compact", 0, missing) }));
    expect(added.status).toBe(200);
    const android = added.body.user.dashboardLayout.layouts["android-compact"];
    expect(android[android.length - 1]).toMatchObject({ id: "alerts", hidden: false, size: "wide" });
    expect(added.body.user.dashboardLayout.layouts["web-desktop"][0].id).toBe("safe");
    const stale = await json(await api.request("/api/me", { method: "PATCH", headers: auth(home.token), body: layoutBody("android-compact", 0, cards) }));
    expect(stale.status).toBe(409);
    const current = added.body.user.dashboardLayout.revision as number;
    const moved = cards.slice();
    const [worth] = moved.splice(moved.findIndex((card) => card.id === "worth"), 1);
    moved.unshift(worth);
    const [first, second] = await Promise.all([
      json(await api.request("/api/me", { method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", current, moved) })),
      json(await api.request("/api/me", { method: "PATCH", headers: auth(home.token), body: layoutBody("web-desktop", current, cards) })),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const stored = await json(await api.request("/api/me", { headers: auth(home.token) }));
    const winner = [first, second].find((item) => item.status === 200);
    expect(stored.body.user.dashboardLayout.layouts["web-desktop"][0].id).toBe(winner?.body.user.dashboardLayout.layouts["web-desktop"][0].id);
    expect(stored.body.user.dashboardLayout.revision).toBe(current + 1);
  });

  it("keeps one user's layout away from another user, including a read-only member", async () => {
    const api = await app();
    const owner = await household(api, "layout-owner@example.com");
    const cards = defaultDashboardCards();
    const worthFirst = cards.slice();
    const [worth] = worthFirst.splice(worthFirst.findIndex((card) => card.id === "worth"), 1);
    worthFirst.unshift(worth);
    const saved = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(owner.token),
      body: JSON.stringify({ theme: "dark", dashboardLayout: { deviceClass: "web-desktop", revision: 0, cards: worthFirst } }),
    }));
    expect(saved.body.user.theme).toBe("dark");
    expect(saved.body.user.dashboardLayout.layouts["web-desktop"][0].id).toBe("worth");
    const account = await json(await api.request(`/api/households/${owner.hid}/accounts`, {
      method: "POST", headers: auth(owner.token),
      body: JSON.stringify({ spaceId: owner.spaceId, name: "Checking", kind: "checking", onBudget: true, openingBalanceMinor: 10000, openingDate: "2026-11-01" }),
    }));
    const before = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(owner.token) }));
    await db.query(`UPDATE users SET email_verified_at = $1 WHERE id = $2`, [new Date().toISOString(), owner.userId]);
    const invite = await json(await api.request(`/api/households/${owner.hid}/invitations`, {
      method: "POST", headers: auth(owner.token), body: JSON.stringify({ email: "layout-reader@example.com", role: "readonly" }),
    }));
    const reader = await household(api, "layout-reader@example.com");
    const accepted = await json(await api.request(`/api/invitations/${invite.body.token}/accept`, { method: "POST", headers: auth(reader.token) }));
    expect(accepted.status).toBe(200);
    const denied = await json(await api.request(`/api/households/${owner.hid}/transactions`, {
      method: "POST", headers: auth(reader.token),
      body: JSON.stringify({ date: "2026-11-02", accountId: account.body.id, amountMinor: -100, type: "expense", payee: "Nope", bankStatus: "posted", splits: [] }),
    }));
    expect(denied.status).toBe(403);
    const readerLayout = await json(await api.request("/api/me", {
      method: "PATCH", headers: auth(reader.token), body: layoutBody("web-compact", 0, defaultDashboardCards().map((card) => card.id === "goals" ? { ...card, hidden: true } : card)),
    }));
    expect(readerLayout.status).toBe(200);
    expect(readerLayout.body.user.dashboardLayout.layouts["web-compact"].find((card: { id: string }) => card.id === "goals").hidden).toBe(true);
    const ownerAgain = await json(await api.request("/api/me", { headers: auth(owner.token) }));
    expect(ownerAgain.body.user.dashboardLayout.layouts["web-desktop"][0].id).toBe("worth");
    expect(ownerAgain.body.user.dashboardLayout.layouts["web-compact"].find((card: { id: string }) => card.id === "goals").hidden).toBe(false);
    expect(ownerAgain.body.user.theme).toBe("dark");
    expect(readerLayout.body.user.theme).not.toBe("dark");
    const after = await json(await api.request(`/api/households/${owner.hid}/dashboard?asOf=2026-11-20`, { headers: auth(owner.token) }));
    expect(after.body.budget.readyToAssignMinor).toBe(before.body.budget.readyToAssignMinor);
    expect(after.body.accounts).toHaveLength(before.body.accounts.length);
  });
});
