import { createHash, randomBytes } from "node:crypto";

export interface OidcStart {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  authorizationUrl: string;
}

export function createOidcStart(input: { issuer: string; clientId: string; redirectUri: string; returnPath: string }): OidcStart {
  const issuer = input.issuer.replace(/\/$/, "");
  if (!issuer.startsWith("https://")) throw new Error("The identity provider address has to use HTTPS.");
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
