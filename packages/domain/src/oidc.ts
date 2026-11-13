import { createHash, createPublicKey, createVerify, randomBytes, type JsonWebKey } from "node:crypto";

export interface OidcStart {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  authorizationUrl: string;
}

export function oidcIssuerAllowed(issuer: string): boolean {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

export function createOidcStart(input: { issuer: string; clientId: string; redirectUri: string; returnPath: string }): OidcStart {
  const issuer = input.issuer.replace(/\/$/, "");
  if (!oidcIssuerAllowed(issuer)) throw new Error("The identity provider address has to use HTTPS, or HTTP on localhost for a test provider.");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL(`${issuer}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { state, nonce, codeVerifier, codeChallenge, authorizationUrl: url.toString() };
}

export function oidcReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value.slice(0, 200);
}

/** Verified email and subject are required. A matching local email does not sign in until the accounts are linked on purpose. */
export function oidcIdentityDecision(input: {
  emailVerified: boolean;
  email: string;
  subject: string;
  existingSubjectUserId: string | null;
  existingEmailUserId: string | null;
}): { action: "sign-in" | "create" | "link-required" | "reject"; reason: string } {
  if (!input.emailVerified || !input.email.includes("@") || !input.subject) {
    return { action: "reject", reason: "The identity provider did not confirm the email address." };
  }
  if (input.existingSubjectUserId) return { action: "sign-in", reason: "This identity is already linked." };
  if (input.existingEmailUserId) return { action: "link-required", reason: "An account with this email already exists. Sign in with the password and link the identity. Nothing was signed in." };
  return { action: "create", reason: "No BudgetCents account uses this confirmed email." };
}

export function verifyRs256IdToken(token: string, jwk: JsonWebKey, expected: { issuer: string; audience: string; nonce: string }): { subject: string; email: string; emailVerified: boolean } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("The identity token was not a signed token.");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string };
  if (header.alg !== "RS256") throw new Error("The identity token must use RS256.");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  if (!verifier.verify(key, Buffer.from(parts[2], "base64url"))) throw new Error("The identity token signature did not match.");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== expected.issuer.replace(/\/$/, "")) throw new Error("The identity token came from a different provider.");
  const audience = payload.aud;
  const audienceOk = audience === expected.audience || (Array.isArray(audience) && audience.includes(expected.audience));
  if (!audienceOk) throw new Error("The identity token was issued for a different application.");
  if (payload.nonce !== expected.nonce) throw new Error("The identity token did not match this sign-in attempt.");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("The identity token expired.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("The identity token had no subject.");
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  return { subject: payload.sub, email, emailVerified: payload.email_verified === true };
}
