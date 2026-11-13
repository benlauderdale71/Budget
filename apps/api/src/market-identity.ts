import { createPrivateKey, sign } from "node:crypto";

export function createMarketAssertion(userId: string, method: string, path: string, encodedKey = process.env.BUDGETHQ_SSO_PRIVATE_KEY ?? "", now = Date.now()): string {
  if (!encodedKey) throw new Error("Market single sign-in is not configured.");
  const key = createPrivateKey({ key: Buffer.from(encodedKey, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid market signing key.");
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: "https://budgethqpro.com", aud: "market-pulse", sub: userId, iat, exp: iat + 30, method, path })).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
}

export function marketSameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const url = new URL(request.url);
  // TLS terminates before the Node server; public origins always use HTTPS.
  const expected = ["budgethqpro.com", "www.budgethqpro.com"].includes(url.hostname) ? `https://${url.host}` : url.origin;
  const origin = request.headers.get("origin");
  return !origin || origin === expected;
}
