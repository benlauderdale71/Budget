import { createHash, createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { Hono } from "hono";

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  expiresAt: number;
}

const codes = new Map<string, IssuedCode>();
let pair: { privateKey: KeyObject; publicJwk: JsonWebKey } | null = null;

function keys() {
  if (!pair) {
    const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = generated.publicKey.export({ format: "jwk" }) as JsonWebKey;
    publicJwk.alg = "RS256";
    publicJwk.kid = "budgetcents-test";
    publicJwk.use = "sig";
    pair = { privateKey: generated.privateKey, publicJwk };
  }
  return pair;
}

export function testIssuerPublicJwk(): JsonWebKey {
  return keys().publicJwk;
}

function signToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "budgetcents-test", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(keys().privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

export function testExchange(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string; issuer: string }): { idToken: string; jwk: JsonWebKey } {
  if (process.env.OIDC_TEST_MODE !== "1") throw new Error("The local test identity provider is off.");
  const expectedId = process.env.OIDC_CLIENT_ID ?? "";
  const expectedSecret = process.env.OIDC_CLIENT_SECRET ?? "";
  if (!expectedId || input.clientId !== expectedId || input.clientSecret !== expectedSecret) throw new Error("The test identity provider rejected the client.");
  const stored = codes.get(input.code);
  codes.delete(input.code);
  if (!stored || stored.expiresAt < Date.now()) throw new Error("The authorization code is not valid.");
  if (stored.clientId !== input.clientId || stored.redirectUri !== input.redirectUri) throw new Error("The authorization code does not match this request.");
  const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
  if (challenge !== stored.codeChallenge) throw new Error("The code verifier did not match.");
  const idToken = signToken({
    iss: input.issuer.replace(/\/$/, ""),
    aud: input.clientId,
    sub: stored.subject,
    email: stored.email,
    email_verified: stored.emailVerified,
    nonce: stored.nonce,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
  });
  return { idToken, jwk: keys().publicJwk };
}

export function mountTestIssuer(app: Hono) {
  app.get("/oidc-test/authorize", (c) => {
    if (process.env.OIDC_TEST_MODE !== "1") return c.json({ error: "Not found" }, 404);
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const challenge = c.req.query("code_challenge") ?? "";
    const method = c.req.query("code_challenge_method") ?? "";
    if (!clientId || !redirectUri || !state || !nonce || !challenge || method !== "S256") {
      return c.json({ error: "The test provider needs a PKCE authorization request." }, 400);
    }
    let redirect: URL;
    try {
      redirect = new URL(redirectUri);
    } catch {
      return c.json({ error: "The redirect address is not valid." }, 400);
    }
    if (redirect.protocol !== "https:" && redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") {
      return c.json({ error: "The test provider will not redirect off this machine." }, 400);
    }
    const email = (c.req.query("login_hint") ?? "person@example.com").toLowerCase();
    const code = `code-${state.slice(0, 12)}-${codes.size}`;
    codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      nonce,
      subject: `test:${email}`,
      email,
      emailVerified: c.req.query("email_verified") !== "0",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    return c.redirect(redirect.toString(), 302);
  });

  app.post("/oidc-test/token", async (c) => {
    if (process.env.OIDC_TEST_MODE !== "1") return c.json({ error: "Not found" }, 404);
    const raw = await c.req.text();
    const body = new URLSearchParams(raw);
    try {
      const exchanged = testExchange({
        code: body.get("code") ?? "",
        clientId: body.get("client_id") ?? "",
        clientSecret: body.get("client_secret") ?? "",
        redirectUri: body.get("redirect_uri") ?? "",
        codeVerifier: body.get("code_verifier") ?? "",
        issuer: process.env.OIDC_ISSUER || "http://127.0.0.1/oidc-test",
      });
      return c.json({ id_token: exchanged.idToken, token_type: "Bearer", expires_in: 300 });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The token request failed." }, 400);
    }
  });

  app.get("/oidc-test/.well-known/jwks.json", (c) => {
    if (process.env.OIDC_TEST_MODE !== "1") return c.json({ error: "Not found" }, 404);
    return c.json({ keys: [keys().publicJwk] });
  });
}
