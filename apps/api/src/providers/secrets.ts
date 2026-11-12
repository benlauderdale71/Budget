import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "../finance.js";

export function providerKey() {
  const value = process.env.BUDGETCENTS_PROVIDER_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ApiError(503, "Bank connections need a configured server encryption key.");
  return Buffer.from(value, "hex");
}
export function sealProviderSecret(value: string, scope: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", providerKey(), iv);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}
export function openProviderSecret(value: string, scope: string) {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", providerKey(), iv);
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
