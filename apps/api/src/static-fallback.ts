const FILE_DESTINATIONS = new Set(["script", "style", "image", "font", "audio", "video", "manifest"]);

export function shouldServeAppShell(input: { pathname: string; fetchDest?: string; fetchMode?: string }): boolean {
  if (input.pathname.startsWith("/api")) return false;
  if (input.fetchDest && FILE_DESTINATIONS.has(input.fetchDest)) return false;
  if (input.fetchMode === "navigate" || input.fetchDest === "document") return true;
  if (input.pathname.startsWith("/assets/")) return false;
  const last = input.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  const extension = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  return extension === "" || extension === "html";
}
