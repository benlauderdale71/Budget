import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function serviceWorkerPlugin(): Plugin {
  return {
    name: "budgetcents-service-worker",
    apply: "build",
    async closeBundle() {
      const dist = path.resolve("dist");
      const assets = await readdir(path.join(dist, "assets"));
      const files = [
        "/",
        "/index.html",
        "/manifest.webmanifest",
        "/icon.svg",
        "/icon-192.png",
        "/icon-512.png",
        "/icon-maskable-512.png",
        ...assets.map((name) => `/assets/${name}`),
      ];
      const id = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const template = await readFile(path.resolve("public/sw.js"), "utf8");
      const source = template
        .replace("__CACHE_ID__", id)
        .replace("const PRECACHE = [];", `const PRECACHE = ${JSON.stringify(files)};`);
      await writeFile(path.join(dist, "sw.js"), source);
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
