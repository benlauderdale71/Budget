import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../finance.js";
import { sha256 } from "../crypto.js";

let cached: { key: string; token: string; expires: number } | undefined;
export function fcmConfigured() { return process.env.BUDGETCENTS_PUSH_ENABLED === "true" && !!process.env.FCM_SERVICE_ACCOUNT_JSON; }

export async function sendFcm(token: string, eventId: string, request: typeof fetch = fetch) {
  if (!fcmConfigured()) throw new ApiError(503, "Remote push is not connected.");
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON!;
  const account = z.object({ project_id: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/), client_email: z.string().email().endsWith(".gserviceaccount.com"), private_key: z.string().min(100) }).parse(JSON.parse(raw));
  const key = sha256(raw);
  if (!cached || cached.key !== key || cached.expires <= Date.now() + 60000) {
    const issued = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const assertion = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: issued, exp: issued + 3600 })}`;
    const signature = sign("RSA-SHA256", Buffer.from(assertion), createPrivateKey(account.private_key)).toString("base64url");
    const response = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${assertion}.${signature}` }), redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new ApiError(502, "Firebase could not authorize this server. Check the service account and messaging permission.");
    const value = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().max(3600) }).parse(await response.json());
    cached = { key, token: value.access_token, expires: Date.now() + value.expires_in * 1000 };
  }
  // Data-only: the app checks its local signed-in state before displaying anything.
  // No financial data, household names, or record ids enter a lock-screen notification.
  const response = await request(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, { method: "POST", headers: { authorization: `Bearer ${cached.token}`, "content-type": "application/json" }, body: JSON.stringify({ message: { token, data: { kind: "budgetcents_alert", eventId }, android: { priority: "normal", ttl: "3600s" } } }), redirect: "error", signal: AbortSignal.timeout(15000) });
  if (response.status === 401) cached = undefined;
  const result = await response.json() as { name?: string; error?: { details?: { errorCode?: string }[] } };
  if (!response.ok) {
    if (result.error?.details?.some((d) => d.errorCode === "UNREGISTERED")) throw new ApiError(410, "This phone's push token expired. Enroll the phone again.");
    throw new ApiError(502, "Firebase did not accept the notification. It was not marked delivered.");
  }
  if (!result.name?.startsWith(`projects/${account.project_id}/messages/`)) throw new ApiError(502, "Firebase did not confirm acceptance.");
  return { status: "accepted", provenDelivered: false, note: "Firebase accepted the notification. Phone delivery is not yet proven." };
}
