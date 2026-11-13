import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot, resolveStaticFile, resolveWebRoot } from "../src/paths.js";
import { shouldServeAppShell } from "../src/static-fallback.js";

describe("web root resolution", () => {
  it("resolves the repository root from the API source directory", () => {
    const root = repositoryRoot(join(process.cwd(), "src"));
    expect(root).toBe(resolve(process.cwd(), "../.."));
    const web = resolveWebRoot({ moduleDir: join(process.cwd(), "src") });
    expect(web).toBe(join(root, "apps/web/dist"));
  });

  it("normalizes a relative BUDGETCENTS_WEB value to the same absolute directory", () => {
    const cwd = process.cwd().endsWith("apps/api") ? join(process.cwd(), "../..") : process.cwd();
    const fromRelative = resolveWebRoot({ moduleDir: join(cwd, "apps/api/src"), configured: "./apps/web/dist", cwd });
    const fromPlain = resolveWebRoot({ moduleDir: join(cwd, "apps/api/src"), configured: "apps/web/dist", cwd });
    expect(fromRelative).toBe(fromPlain);
    expect(fromRelative).toBe(join(cwd, "apps/web/dist"));
    const fromPackageDir = resolveWebRoot({ moduleDir: join(cwd, "apps/api/src"), configured: "./apps/web/dist" });
    expect(fromPackageDir).toBe(join(cwd, "apps/web/dist"));
    const inside = resolveStaticFile(fromRelative, "/index.html");
    expect(inside.allowed).toBe(true);
    expect(inside.file).toBe(join(fromRelative, "index.html"));
  });

  it("rejects paths that escape the web root, including a sibling prefix", () => {
    const root = join(tmpdir(), `budgetcents-web-${process.pid}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "ok");
    expect(resolveStaticFile(root, "/../../etc/passwd").allowed).toBe(false);
    expect(resolveStaticFile(root, "/%2e%2e/%2e%2e/etc/passwd").allowed).toBe(false);
    const sibling = resolveStaticFile(`${root}`, "/../" + root.split("/").pop() + "-evil/secret");
    expect(sibling.allowed).toBe(false);
  });
});

describe("app shell fallback", () => {
  it("serves the shell for navigation and not for a missing asset", () => {
    expect(shouldServeAppShell({ pathname: "/plan", fetchMode: "navigate", fetchDest: "document" })).toBe(true);
    expect(shouldServeAppShell({ pathname: "/import", fetchDest: "document" })).toBe(true);
    expect(shouldServeAppShell({ pathname: "/settings" })).toBe(true);
    expect(shouldServeAppShell({ pathname: "/assets/index-missing.js", fetchDest: "script" })).toBe(false);
    expect(shouldServeAppShell({ pathname: "/assets/index-missing.css", fetchDest: "style" })).toBe(false);
    expect(shouldServeAppShell({ pathname: "/icon-missing.png", fetchDest: "image" })).toBe(false);
    expect(shouldServeAppShell({ pathname: "/assets/index-missing.js" })).toBe(false);
    expect(shouldServeAppShell({ pathname: "/api/me", fetchDest: "empty" })).toBe(false);
  });
});
