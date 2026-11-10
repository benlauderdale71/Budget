import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Repository root for either `apps/api/src` (tsx) or `apps/api/dist` (compiled). */
export function repositoryRoot(moduleDir: string): string {
  const fromSource = resolve(moduleDir, "../../..");
  const fromDist = resolve(moduleDir, "../..");
  if (existsSync(join(fromSource, "package.json"))) return fromSource;
  return fromDist;
}

/**
 * Absolute directory of the built web app.
 * Relative `BUDGETCENTS_WEB` values are resolved from the repository root.
 * `npm start` runs with the API package as its working directory, so `./apps/web/dist` still means the repo's web build.
 * An absolute path is used as given. Pass `cwd` only to pin the base in a test.
 */
export function resolveWebRoot(options: { moduleDir: string; configured?: string; cwd?: string }): string {
  const base = options.cwd ?? repositoryRoot(options.moduleDir);
  const fallback = resolve(base, "apps/web/dist");
  const raw = options.configured?.trim();
  if (!raw) return fallback;
  return resolve(base, raw);
}

export function resolveStaticFile(webRoot: string, pathname: string): { file: string; allowed: boolean } {
  const root = resolve(webRoot);
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { file: root, allowed: false };
  }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  if (requested.includes("\0")) return { file: root, allowed: false };
  const file = resolve(root, requested);
  const rel = relative(root, file);
  const allowed = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  return { file, allowed };
}

export function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
