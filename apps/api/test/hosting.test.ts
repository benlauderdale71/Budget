import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database | undefined;
afterEach(async () => {
  await db?.close();
  vi.unstubAllEnvs();
});

it("advertises unavailable production controls without opening development endpoints", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_LOGIN", "false");
  vi.stubEnv("ALLOW_DEV_MAILSINK", "false");
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "false");
  vi.stubEnv("OIDC_ISSUER", "");
  db = await openMemoryDatabase();
  const app = createApp(db);
  const health = await (await app.request("/api/health")).json();
  expect(health).toMatchObject({ ok: true, demoLogin: false, devMail: false, mailDelivery: false, federatedLogin: false });
  expect((await app.request("/api/auth/demo", { method: "POST" })).status).toBe(404);
  expect((await app.request("/api/dev/outbox?email=smoke@example.invalid")).status).toBe(404);
});
