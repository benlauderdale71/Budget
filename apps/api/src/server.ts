import { serve } from "@hono/node-server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, demoLoginAllowed } from "./http.js";
import { openDatabase } from "./db.js";
import { ensureDemo } from "./seed.js";
import { contentType, resolveStaticFile, resolveWebRoot } from "./paths.js";

const db = await openDatabase();
if (process.env.SEED_DEMO !== "false") await ensureDemo(db);
const app = createApp(db);
const port = Number(process.env.PORT ?? 8787);
const webRoot = resolveWebRoot({
  moduleDir: dirname(fileURLToPath(import.meta.url)),
  configured: process.env.BUDGETCENTS_WEB,
});

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api")) return next();
  const url = new URL(c.req.url);
  const resolved = resolveStaticFile(webRoot, url.pathname);
  if (!resolved.allowed) return c.text("Not found", 404);
  const send = async (filePath: string) => {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("missing");
    return new Response(createReadStream(filePath) as unknown as ReadableStream, {
      headers: { "content-type": contentType(filePath), "cache-control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600" },
    });
  };
  try {
    return await send(resolved.file);
  } catch {
    try {
      return await send(join(webRoot, "index.html"));
    } catch {
      return c.text("BudgetCents API is running. Build the web app to serve the interface.", 200);
    }
  }
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`BudgetCents API listening on http://127.0.0.1:${port}`);
  console.log(`Serving the web build from ${webRoot}`);
  if (demoLoginAllowed()) console.log("Sample household login is enabled for this environment.");
});
