export function shellRequest(input: { method: string; path: string; mode: string }): "bypass" | "navigate" | "asset" {
  if (input.method !== "GET") return "bypass";
  if (input.path === "/stocks-crypto" || input.path.startsWith("/stocks-crypto/")) return "bypass";
  if (input.path.startsWith("/api")) return "bypass";
  if (input.mode === "navigate") return "navigate";
  return "asset";
}
