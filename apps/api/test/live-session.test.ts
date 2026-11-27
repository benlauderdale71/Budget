import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../web/src/api.js";

afterEach(() => vi.unstubAllGlobals());

function browser() {
  const store = new Map([["budgetcents.token", "old-session"]]);
  const events: string[] = [];
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, removeItem: (key: string) => store.delete(key) });
  vi.stubGlobal("window", { dispatchEvent: (event: Event) => events.push(event.type) });
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { respond = resolve; }));
  return { store, events, respond: (status: number) => respond(new Response(JSON.stringify({ error: "Not authorized" }), { status })) };
}

it("a late unauthorized response cannot clear the next person's login", async () => {
  const f = browser();
  const result = api("/api/households/old/collaboration/changes");
  f.store.set("budgetcents.token", "new-session");
  f.respond(401);
  await expect(result).rejects.toThrow("no longer active");
  expect(f.store.get("budgetcents.token")).toBe("new-session");
  expect(f.events).toEqual([]);
});

it("an aborted household watcher cannot trigger an access refresh", async () => {
  const f = browser();
  const controller = new AbortController();
  const result = api("/api/households/old/collaboration/changes", { signal: controller.signal });
  controller.abort();
  f.respond(404);
  await expect(result).rejects.toThrow("no longer active");
  expect(f.events).toEqual([]);
});

it("revocation of the active session still signs out", async () => {
  const f = browser();
  const result = api("/api/households/current/collaboration/changes");
  f.respond(401);
  await expect(result).rejects.toThrow("Not authorized");
  expect(f.store.has("budgetcents.token")).toBe(false);
  expect(f.events).toEqual(["budgetcents-unauthorized"]);
});
