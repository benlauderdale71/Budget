import type { JsonWebKey } from "node:crypto";
import { oidcIdentityDecision, verifyRs256IdToken } from "@budgetcents/domain";
import { hashPassword, id, nowIso, randomToken, sha256, verifyPassword, verifyTotp } from "./crypto.js";
import type { Database } from "./db.js";
import { num, str } from "./db.js";
import { ApiError, audit } from "./finance.js";
import { testExchange } from "./oidc-test-provider.js";

function issuerOf(): string {
  return (process.env.OIDC_ISSUER ?? "").replace(/\/$/, "");
}

function isLocalTestIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.pathname.replace(/\/$/, "") === "/oidc-test";
  } catch {
    return false;
  }
}

async function exchangeCode(input: { code: string; verifier: string }): Promise<{ idToken: string; jwk: JsonWebKey }> {
  const issuer = issuerOf();
  const clientId = process.env.OIDC_CLIENT_ID ?? "";
  const clientSecret = process.env.OIDC_CLIENT_SECRET ?? "";
  const redirectUri = process.env.OIDC_REDIRECT_URI || "https://localhost/api/auth/oidc/callback";
  if (isLocalTestIssuer(issuer)) {
    const exchanged = testExchange({ code: input.code, clientId, clientSecret, redirectUri, codeVerifier: input.verifier, issuer });
    return { idToken: exchanged.idToken, jwk: exchanged.jwk };
  }
  const tokenUrl = new URL(`${issuer}/token`);
  if (tokenUrl.origin !== new URL(issuer).origin) throw new Error("The token address left the identity provider.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: input.verifier,
  });
  const tokenResponse = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(8000) });
  if (!tokenResponse.ok) throw new Error("The identity provider did not issue a token.");
  const tokenJson = await tokenResponse.json() as { id_token?: string };
  if (!tokenJson.id_token) throw new Error("The identity provider did not issue an identity token.");
  const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
  const jwksResponse = await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) });
  if (!jwksResponse.ok) throw new Error("The identity provider did not publish a signing key.");
  const jwks = await jwksResponse.json() as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.find((key) => key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256"));
  if (!jwk) throw new Error("The identity provider did not publish an RS256 key.");
  return { idToken: tokenJson.id_token, jwk };
}

async function savePending(db: Database, input: { userId: string | null; purpose: "link" | "mfa"; issuer: string; subject: string; email: string; returnPath: string }) {
  const token = randomToken();
  await db.query(
    `INSERT INTO oidc_pending (id, user_id, token_hash, purpose, issuer, subject, email, return_path, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id(), input.userId, sha256(token), input.purpose, input.issuer, input.subject, input.email, input.returnPath, new Date(Date.now() + 10 * 60 * 1000).toISOString()],
  );
  return token;
}

async function takePending(db: Database, token: string, purpose: "link" | "mfa") {
  const rows = await db.query(`SELECT * FROM oidc_pending WHERE token_hash = $1 AND purpose = $2`, [sha256(token), purpose]);
  if (!rows.length) throw new ApiError(400, "That sign-in attempt expired. Start again.");
  await db.query(`DELETE FROM oidc_pending WHERE id = $1`, [rows[0].id]);
  if (Date.parse(String(rows[0].expires_at)) < Date.now()) throw new ApiError(400, "That sign-in attempt expired. Start again.");
  return rows[0];
}

export async function completeOidcCallback(db: Database, input: { code: string; state: string; userAgent: string }, startSession: (userId: string, agent: string) => Promise<string>) {
  const saved = await db.query(`SELECT * FROM oidc_states WHERE state = $1`, [input.state]);
  if (saved.length) await db.query(`DELETE FROM oidc_states WHERE state = $1`, [input.state]);
  if (!saved.length) throw new ApiError(400, "The sign-in attempt could not be matched. Start again. No account was created.");
  if (Date.now() - Date.parse(String(saved[0].created_at)) > 10 * 60 * 1000) {
    throw new ApiError(400, "That sign-in attempt expired. Start again. No account was created.");
  }
  const issuer = issuerOf();
  const clientId = process.env.OIDC_CLIENT_ID ?? "";
  let verified: { subject: string; email: string; emailVerified: boolean };
  try {
    const exchanged = await exchangeCode({ code: input.code, verifier: String(saved[0].code_verifier) });
    verified = verifyRs256IdToken(exchanged.idToken, exchanged.jwk, { issuer, audience: clientId, nonce: String(saved[0].nonce) });
  } catch (error) {
    throw new ApiError(502, `The identity provider did not complete sign-in. No account was created or linked, and no invitation was accepted. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const subjectRows = await db.query(`SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2`, [issuer, verified.subject]);
  const emailRows = verified.email ? await db.query(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [verified.email]) : [];
  const decision = oidcIdentityDecision({
    emailVerified: verified.emailVerified,
    email: verified.email,
    subject: verified.subject,
    existingSubjectUserId: subjectRows[0] ? String(subjectRows[0].user_id) : null,
    existingEmailUserId: emailRows[0] ? String(emailRows[0].id) : null,
  });
  const returnPath = String(saved[0].return_path || "/");
  if (decision.action === "reject") throw new ApiError(400, `${decision.reason} No account was created and no invitation was accepted.`);
  if (decision.action === "link-required") {
    const pendingToken = await savePending(db, { userId: String(emailRows[0].id), purpose: "link", issuer, subject: verified.subject, email: verified.email, returnPath });
    return { status: "link-required" as const, pendingToken, returnPath, invitationAccepted: false, note: decision.reason };
  }
  const userId = decision.action === "sign-in" ? String(subjectRows[0].user_id) : await createOidcUser(db, verified.email);
  if (decision.action === "create") {
    await db.query(`INSERT INTO oidc_identities (issuer, subject, user_id, email, created_at) VALUES ($1,$2,$3,$4,$5)`, [issuer, verified.subject, userId, verified.email, nowIso()]);
  }
  return finishSignIn(db, userId, issuer, verified.subject, verified.email, returnPath, input.userAgent, startSession, decision.action === "create");
}

async function createOidcUser(db: Database, email: string) {
  const userId = id();
  const local = email.split("@")[0]?.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40) || "Member";
  await db.query(
    `INSERT INTO users (id, email, password_hash, display_name, email_verified_at, locale, time_zone, onboarding_step, created_at)
     VALUES ($1,$2,$3,$4,$5,'en-US','America/Chicago','done',$5)`,
    [userId, email, await hashPassword(randomToken()), local, nowIso()],
  );
  await audit(db, null, userId, "oidc.create", "Created an account from a confirmed identity. No household was created and no invitation was accepted.");
  return userId;
}

async function finishSignIn(db: Database, userId: string, issuer: string, subject: string, email: string, returnPath: string, userAgent: string, startSession: (userId: string, agent: string) => Promise<string>, created: boolean) {
  const rows = await db.query(`SELECT mfa_enabled FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!rows.length) throw new ApiError(400, "That account is not available.");
  if (num(rows[0].mfa_enabled) === 1) {
    const pendingToken = await savePending(db, { userId, purpose: "mfa", issuer, subject, email, returnPath });
    return { mfaRequired: true as const, pendingToken, returnPath, invitationAccepted: false, created, note: "Enter the authentication code. No session was started and no invitation was accepted." };
  }
  await audit(db, null, userId, "oidc.login", "Signed in with the identity provider. No invitation was accepted.");
  const token = await startSession(userId, userAgent);
  return { token, userId, returnPath, invitationAccepted: false, created, household: null, note: created ? "This account has no household yet. Password recovery can add a password. No invitation was accepted." : "Signed in. No invitation was accepted." };
}

export async function completeOidcLink(db: Database, input: { pendingToken: string; password: string; userAgent: string }, startSession: (userId: string, agent: string) => Promise<string>) {
  const pending = await takePending(db, input.pendingToken, "link");
  const userId = str(pending.user_id);
  if (!userId) throw new ApiError(400, "That sign-in attempt expired. Start again.");
  const users = await db.query(`SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!users.length || !(await verifyPassword(input.password, String(users[0].password_hash)))) {
    throw new ApiError(401, "The password did not match. The identity was not linked and no invitation was accepted.");
  }
  await db.query(`INSERT INTO oidc_identities (issuer, subject, user_id, email, created_at) VALUES ($1,$2,$3,$4,$5)`, [pending.issuer, pending.subject, userId, pending.email, nowIso()]);
  await audit(db, null, userId, "oidc.link", "Linked an identity provider after a password check. No invitation was accepted.");
  return finishSignIn(db, userId, String(pending.issuer), String(pending.subject), String(pending.email), String(pending.return_path), input.userAgent, startSession, false);
}

export async function completeOidcMfa(db: Database, input: { pendingToken: string; code: string; userAgent: string }, startSession: (userId: string, agent: string) => Promise<string>) {
  const pending = await takePending(db, input.pendingToken, "mfa");
  const userId = str(pending.user_id);
  if (!userId) throw new ApiError(400, "That sign-in attempt expired. Start again.");
  const users = await db.query(`SELECT mfa_secret, recovery_hashes FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!users.length) throw new ApiError(400, "That account is not available.");
  const code = input.code.trim();
  if (!verifyTotp(String(users[0].mfa_secret), code)) {
    const recovery = JSON.parse(String(users[0].recovery_hashes || "[]")) as string[];
    if (!recovery.includes(sha256(code))) throw new ApiError(401, "That authentication code is not valid. No session was started.");
    const next = recovery.filter((item) => item !== sha256(code));
    await db.query(`UPDATE users SET recovery_hashes = $1 WHERE id = $2`, [JSON.stringify(next), userId]);
  }
  await audit(db, null, userId, "oidc.login", "Signed in with the identity provider after the authentication code. No invitation was accepted.");
  const token = await startSession(userId, input.userAgent);
  return { token, userId, returnPath: String(pending.return_path), invitationAccepted: false, note: "Signed in. No invitation was accepted." };
}
