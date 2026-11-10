import { serve } from "@hono/node-server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, demoLoginAllowed } from "./http.js";
import { openDatabase } from "./db.js";
import { ensureDemo } from "./seed.js";

const db = await openDatabase();
if (process.env.SEED_DEMO !== "false") await ensureDemo(db);
const app = createApp(db);
const port = Number(process.env.PORT ?? 8787);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = process.env.BUDGETCENTS_WEB ?? join(repoRoot, "apps/web/dist");

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api")) return next();
  const url = new URL(c.req.url);
  const requested = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const relative = requested === "/" ? "index.html" : requested.replace(/^\//, "");
  const filePath = join(webRoot, relative);
  if (!filePath.startsWith(webRoot)) return c.text("Not found", 404);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("missing");
    const type = filePath.endsWith(".html") ? "text/html; charset=utf-8" : filePath.endsWith(".js") ? "text/javascript" : filePath.endsWith(".css") ? "text/css" : "application/octet-stream";
    return new Response(createReadStream(filePath) as unknown as ReadableStream, { headers: { "content-type": type } });
  } catch {
    try {
      const index = join(webRoot, "index.html");
      await stat(index);
      return new Response(createReadStream(index) as unknown as ReadableStream, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch {
      return c.text("BudgetCents API is running. Build the web app to serve the interface.", 200);
    }
  }
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`BudgetCents API listening on http://127.0.0.1:${port}`);
  if (demoLoginAllowed()) console.log("Sample household login is enabled for this environment.");
});
