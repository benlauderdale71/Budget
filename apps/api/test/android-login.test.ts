import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { openMemoryDatabase, type Database } from "../src/db.js";

let db: Database;
afterEach(async () => { await db?.close(); });

it("signs Android into the existing household from an approved browser session", async () => {
  db = await openMemoryDatabase();
  const app = createApp(db);
  const request = (path: string, body?: object, token?: string) => app.request(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  const credentials = { email: "android@example.invalid", password: " Original pãssword! " };
  const account = await request("/api/auth/register", { ...credentials, displayName: "Phone owner", householdName: "Original home" });
  expect(account.status).toBe(200);
  const { token, user } = await (await request("/api/auth/login", credentials)).json();
  const homes = await (await request("/api/households", undefined, token)).json();
  expect(homes.households).toHaveLength(1);
  const nonce = () => randomBytes(32).toString("base64url");
  const state = nonce(), verifier = nonce();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = (session?: string) => request("/api/auth/android/authorize", { state, challenge }, session);
  const exchange = (code: string, proof = verifier, attempt = state) => request("/api/auth/android/exchange", { code, verifier: proof, state: attempt });
  expect((await authorize()).status).toBe(401);
  const approval = await authorize(token);
  expect(approval.status).toBe(200);
  const { code } = await approval.json();
  expect((await exchange(code, nonce())).status).toBe(401);
  expect((await exchange(code, verifier, nonce())).status).toBe(401);
  const results = await Promise.all([exchange(code), exchange(code)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 401]);
  const phone = await results.find(r => r.status === 200)!.json();
  expect(phone.user.id).toBe(user.id);
  expect(phone.token).not.toEqual(token);
  expect(await (await request("/api/households", undefined, phone.token)).json()).toEqual(homes);
  const expired = await (await authorize(token)).json();
  await db.exec("UPDATE android_login_codes SET expires_at='2000-01-01T00:00:00.000Z'");
  expect((await exchange(expired.code)).status).toBe(401);
  const revoked = await (await authorize(token)).json();
  await request("/api/auth/logout", {}, token);
  expect((await exchange(revoked.code)).status).toBe(401);
  expect((await request("/api/auth/login", credentials)).status).toBe(200);
});
