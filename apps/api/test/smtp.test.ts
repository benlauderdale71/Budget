import { createServer, type Server } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { openMemoryDatabase, type Database } from "../src/db.js";
import { flushAccountMail, queueAccountMail, sendSmtp } from "../src/providers/smtp.js";

let db: Database; let server: Server;
afterEach(async () => { vi.unstubAllEnvs(); await db?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

it("uses the SMTP protocol, records acceptance once and leaves old local copies unsent", async () => {
  const messages: string[] = [];
  server = createServer((socket) => {
    socket.write("220 local.test ESMTP\r\n"); let buffer = ""; let message = ""; let inData = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (inData) { if (line === ".") { messages.push(message); message = ""; inData = false; socket.write("250 Accepted\r\n"); } else message += `${line}\r\n`; }
        else if (line.startsWith("EHLO")) socket.write("250-local.test\r\n250 SIZE 100000\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 End with dot\r\n"); }
        else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("SMTP_ALLOW_INSECURE_LOCAL", "true"); vi.stubEnv("SMTP_URL", `smtp://127.0.0.1:${port}`); vi.stubEnv("SMTP_FROM", "sender@example.test");
  db = await openMemoryDatabase();
  await db.query(`INSERT INTO users (id,email,password_hash,display_name,created_at) VALUES ('mail-user','recipient@example.test','unused','Mail test',$1)`, [new Date().toISOString()]);
  const old = await queueAccountMail(db, "mail-user", "recipient@example.test", "Verify your BudgetCents email", "Old local-only copy");
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "true");
  const queued = await queueAccountMail(db, "mail-user", "recipient@example.test", "Verify your BudgetCents email", "This is a loopback-only SMTP integration test.");
  const runs = await Promise.all([flushAccountMail(db), flushAccountMail(db)]);
  expect(runs.reduce((n, r) => n + r.accepted, 0)).toBe(1);
  expect(messages).toHaveLength(1); expect(messages[0]).toContain("loopback-only");
  expect((await db.query(`SELECT transport_status FROM outbox WHERE id = $1`, [queued]))[0].transport_status).toBe("accepted");
  expect((await db.query(`SELECT transport_status FROM outbox WHERE id = $1`, [old]))[0].transport_status).toBe("local");
  expect(await flushAccountMail(db)).toEqual({ accepted: 0, failed: 0 });
  await db.query(`UPDATE outbox SET transport_status = 'queued' WHERE id = $1`, [queued]);
  vi.stubEnv("SMTP_URL", "smtp://127.0.0.1:1");
  expect((await flushAccountMail(db)).failed).toBe(1);
  expect((await flushAccountMail(db)).failed).toBe(0);
  vi.stubEnv("BUDGETCENTS_MAIL_ENABLED", "false");
  await expect(sendSmtp({ id: "disabled", to: "recipient@example.test", subject: "Test", text: "Disabled" })).rejects.toThrow("not connected");
});
