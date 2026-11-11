import { safeReturnPath } from "@budgetcents/domain/access";

const KEY = "budgetcents.next";

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
