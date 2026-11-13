import { safeReturnPath } from "@budgetcents/domain/access";

const KEY = "budgetcents.next";

export function marketReturnPath(value: string | null | undefined): string | null {
  const safe = safeReturnPath(value);
  if (!safe) return null;
  const url = new URL(safe, "https://budgethqpro.invalid");
  if (url.origin !== "https://budgethqpro.invalid" || !/^\/stocks-crypto(?:\/|$)/.test(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function rememberReturnPath(value: string | null | undefined) {
  const safe = safeReturnPath(value);
  if (!safe) return null;
  sessionStorage.setItem(KEY, safe);
  return safe;
}

export function peekReturnPath() {
  return safeReturnPath(sessionStorage.getItem(KEY));
}

export function clearReturnPath() {
  sessionStorage.removeItem(KEY);
}

