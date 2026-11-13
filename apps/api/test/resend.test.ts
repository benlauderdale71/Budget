import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openMemoryDatabase, type Database } from "../src/db.js";
import { createApp } from "../src/http.js";
import { providerCatalog } from "../src/content.js";
import { flushAccountMail, mailConfigured, queueAccountMail, sendMail } from "../src/providers/mail.js";

let db: Database | undefined;
beforeEach(() => {
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_only");
  vi.stubEnv("RESEND_FROM", "noreply@example.test");
  vi.stubEnv("SMTP_URL", "");
  vi.stubEnv("SMTP_FROM", "");
});
afterEach(async () => { await db?.close(); db = undefined; vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const message = { id: "mail-operation-123", to: "recipient@example.test", subject: "Verify your email", text: "https://example.test/verify?token=test-token" };

it("sends through HTTPS with a stable idempotency key and only claims acceptance", async () => {
  const request = vi.fn().mockImplementation(async () => Response.json({ id: "provider-message" }));
  vi.stubGlobal("fetch", request);
  expect(await sendMail(message)).toMatchObject({ status: "accepted", provenDelivered: false });
  await sendMail(message);
  expect(request.mock.calls[0][0]).toBe("https://api.resend.com/emails");
  const options = request.mock.calls[0][1];
  expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer re_test_only", "Content-Type": "application/json" } });
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options.body)).toEqual({ from: "noreply@example.test", to: [message.to], subject: message.subject, text: message.text });
  expect(options.headers["Idempotency-Key"]).toBe(request.mock.calls[1][1].headers["Idempotency-Key"]);
  await sendMail({ ...message, id: "another-operation" });
  expect(options.headers["Idempotency-Key"]).not.toBe(request.mock.calls[2][1].headers["Idempotency-Key"]);
});

it("does not send when disabled or incompletely configured, and does not fall back to SMTP", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "false");
  await expect(sendMail(message)).rejects.toThrow("not connected");
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "true");
  vi.stubEnv("SMTP_URL", "smtp://must-not-be-contacted.invalid");
  vi.stubEnv("SMTP_FROM", "smtp@example.test");
  vi.stubEnv("RESEND_FROM", "");
  expect(mailConfigured()).toBe(false);
  await expect(sendMail(message)).rejects.toThrow("not connected");
  vi.stubEnv("RESEND_FROM", "not-an-email");
  expect(mailConfigured()).toBe(false);
  vi.stubEnv("RESEND_FROM", "noreply@example.test");
  await expect(sendMail({ ...message, to: "invalid" })).rejects.toThrow("recipient");
  expect(request).not.toHaveBeenCalled();
});

it.each(["refused", "malformed", "network"])("does not claim delivery or expose provider details on %s failure", async (failure) => {
  const request = vi.fn().mockImplementation(async () => {
    if (failure === "network") throw new Error("re_test_only and private-recipient in error");
    return failure === "refused" ? Response.json({ message: "private-recipient" }, { status: 403 }) : Response.json({});
  });
  vi.stubGlobal("fetch", request);
  await expect(sendMail(message)).rejects.toThrow("did not confirm acceptance");
  expect(request).toHaveBeenCalledTimes(1);
});

it("claims account messages once, leaves local and expired links unsent, and does not retry uncertain attempts", async () => {
  const request = vi.fn().mockImplementation(async () => Response.json({ id: "accepted-id" }));
  vi.stubGlobal("fetch", request);
  db = await openMemoryDatabase();
  await db.query(`INSERT INTO users (id,email,password_hash,display_name,created_at) VALUES ('mail-user','recipient@example.test','unused','Mail test',$1)`, [new Date().toISOString()]);
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "false");
  const old = await queueAccountMail(db, "mail-user", message.to, message.subject, "Old local copy");
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "true");
  const expired = await queueAccountMail(db, "mail-user", message.to, "Reset your password", "Expired link", new Date(Date.now() - 7200000).toISOString());
  const queued = await queueAccountMail(db, "mail-user", message.to, message.subject, message.text);
  const results = await Promise.all([flushAccountMail(db), flushAccountMail(db)]);
  expect(results.reduce((sum, result) => sum + result.accepted, 0)).toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
  const statuses = new Map((await db.query(`SELECT id, transport_status FROM outbox`)).map(row => [row.id, row.transport_status]));
  expect(statuses.get(old)).toBe("local"); expect(statuses.get(expired)).toBe("expired"); expect(statuses.get(queued)).toBe("accepted");
  request.mockRejectedValue(new Error("Connection lost after sending"));
  const uncertain = await queueAccountMail(db, "mail-user", message.to, message.subject, "Fresh link");
  expect(await flushAccountMail(db)).toEqual({ accepted: 0, failed: 1 });
  expect(await flushAccountMail(db)).toEqual({ accepted: 0, failed: 0 });
  expect((await db.query(`SELECT transport_status FROM outbox WHERE id = $1`, [uncertain]))[0].transport_status).toBe("failed");
  expect(request).toHaveBeenCalledTimes(2);
});

it("reports HTTPS mail as configured without enabling development mail access", async () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ALLOW_DEV_MAILSINK", "false");
  db = await openMemoryDatabase();
  const app = createApp(db);
  expect(await (await app.request("/api/health")).json()).toMatchObject({ mailDelivery: true, devMail: false });
  expect(providerCatalog().find(provider => provider.id === "smtp")?.status).toBe("configured");
  expect((await app.request("/api/dev/outbox?email=recipient@example.test")).status).toBe(404);
  vi.stubEnv("BUDGETCENTS_PUBLIC_URL", "http://example.test");
  await expect(flushAccountMail(db)).rejects.toThrow("public HTTPS");
});
