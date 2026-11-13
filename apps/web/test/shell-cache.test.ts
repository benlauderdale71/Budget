import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shellRequest } from "../src/shell-cache.ts";

test("navigation fallback is separate from assets and API responses", () => {
  assert.equal(shellRequest({ method: "GET", path: "/plan", mode: "navigate" }), "navigate");
  assert.equal(shellRequest({ method: "GET", path: "/import", mode: "navigate" }), "navigate");
  assert.equal(shellRequest({ method: "GET", path: "/assets/index.js", mode: "same-origin" }), "asset");
  assert.equal(shellRequest({ method: "GET", path: "/assets/index.css", mode: "same-origin" }), "asset");
  assert.equal(shellRequest({ method: "GET", path: "/icon-512.png", mode: "same-origin" }), "asset");
  assert.equal(shellRequest({ method: "GET", path: "/api/me", mode: "cors" }), "bypass");
  assert.equal(shellRequest({ method: "POST", path: "/api/households/1/transactions", mode: "cors" }), "bypass");
  assert.equal(shellRequest({ method: "GET", path: "/api/households/1/attachments/1", mode: "cors" }), "bypass");
  for (const path of ["/stocks-crypto", "/stocks-crypto/", "/stocks-crypto/analysis", "/stocks-crypto/api/learning/metrics", "/stocks-crypto/assets/app.js"]) {
    assert.equal(shellRequest({ method: "GET", path, mode: "navigate" }), "bypass");
  }
  assert.equal(shellRequest({ method: "GET", path: "/stocks-cryptocurrency", mode: "navigate" }), "navigate");
});

test("the service worker does not return the page for a missing file", () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /pathname\.startsWith\("\/api"\)/);
  assert.match(source, /This file is not available offline/);
  assert.doesNotMatch(source, /hit \|\| caches\.match\("\/index\.html"\)/);
  const navigateAt = source.indexOf('request.mode === "navigate"');
  const pageFallback = source.indexOf('caches.match("/index.html")');
  const assetMiss = source.indexOf("This file is not available offline.");
  assert.ok(navigateAt >= 0 && pageFallback > navigateAt && assetMiss > pageFallback);
  assert.ok(source.indexOf('url.pathname.startsWith("/stocks-crypto/")') < navigateAt);
  assert.match(source, /skip-waiting/);
  assert.match(source, /caches\.delete/);
});
