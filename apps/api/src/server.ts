import { serve } from "@hono/node-server";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordFillPoll, runDueFills } from "./fills.js";
import { createApp, demoLoginAllowed } from "./http.js";
import { openDatabase } from "./db.js";
import { ensureDemo } from "./seed.js";
import { contentType, resolveStaticFile, resolveWebRoot } from "./paths.js";
import { shouldServeAppShell } from "./static-fallback.js";

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
    const bytes = await readFile(filePath);
    return new Response(bytes, {
      headers: { "content-type": contentType(filePath), "cache-control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600" },
    });
  };
  try {
    return await send(resolved.file);
  } catch {
    const shell = shouldServeAppShell({
      pathname: url.pathname,
      fetchDest: c.req.header("sec-fetch-dest"),
      fetchMode: c.req.header("sec-fetch-mode"),
    });
    if (!shell) return c.text("Not found", 404);
    try {
      return await send(join(webRoot, "index.html"));
    } catch {
      return c.text("BudgetCents API is running. Build the web app to serve the interface.", 200);
    }
  }
});

const fillPollMs = Number(process.env.BUDGETCENTS_FILL_POLL_MS ?? 0);

serve({ fetch: app.fetch, port }, () => {
  console.log(`BudgetCents API listening on http://127.0.0.1:${port}`);
  console.log(`Serving the web build from ${webRoot}`);
  if (demoLoginAllowed()) console.log("Sample household login is enabled for this environment.");
  if (Number.isFinite(fillPollMs) && fillPollMs >= 1000) {
    setInterval(() => {
      runDueFills(db)
        .then((result) => recordFillPoll(result))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Scheduled fill failed";
          recordFillPoll(null, message);
          console.error("Scheduled fill failed", error);
        });
    }, fillPollMs);
    console.log(`Scheduled envelope fills poll every ${fillPollMs} ms. Unset BUDGETCENTS_FILL_POLL_MS to leave fills for Run now or an operator call.`);
  } else if (process.env.BUDGETCENTS_FILL_POLL_MS && Number(process.env.BUDGETCENTS_FILL_POLL_MS) !== 0) {
    console.error("BUDGETCENTS_FILL_POLL_MS must be at least 1000. Automatic fills were not started.");
  }
});
