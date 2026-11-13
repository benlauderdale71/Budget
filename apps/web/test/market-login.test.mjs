import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("../public/market-login.js", import.meta.url), "utf8");

async function handoff({ token = null, status = 200, networkError = false, storageError = false, pathname = "/stocks-crypto/analysis", search = "?symbol=BRK.B", hash = "#chart" } = {}) {
  const replacements = [], calls = [];
  const statusNode = { textContent: "Opening Market Pulse…", children: [], append(...nodes) { this.children.push(...nodes); } };
  const context = {
    URL,
    AbortSignal,
    location: { origin: "https://budgethqpro.com", pathname, search, hash, replace: (path) => replacements.push(path) },
    localStorage: { getItem(key) { assert.equal(key, "budgetcents.token"); if (storageError) throw new Error("Storage denied"); return token; } },
    document: {
      getElementById(id) { assert.equal(id, "market-login-status"); return statusNode; },
      createElement(tag) { assert.equal(tag, "a"); return { href: "", textContent: "" }; },
      createTextNode(text) { return text; },
    },
    async fetch(path, init) {
      calls.push({ path, init });
      if (networkError) throw new Error("Private transport details");
      return { status, ok: status >= 200 && status < 300 };
    },
  };
  await vm.runInNewContext(script, context);
  return { replacements, calls, statusNode };
}

test("a Budget session creates the same-origin bridge and returns to the complete market deep link", async () => {
  const result = await handoff({ token: "private-budget-token" });
  assert.deepEqual(result.replacements, ["/stocks-crypto/analysis?symbol=BRK.B#chart"]);
  assert.equal(result.calls.length, 1);
  const call = result.calls[0];
  assert.equal(call.path, "/api/auth/market-session");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer private-budget-token");
  assert.equal(call.init.credentials, "same-origin");
  assert.equal(call.init.cache, "no-store");
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.ok(result.replacements.every((url) => !url.includes("private-budget-token")));
  assert.ok(!call.path.includes("private-budget-token"));
});

test("missing or rejected credentials use Budget login without sharing the token in a URL", async () => {
  const expected = `/login?next=${encodeURIComponent("/stocks-crypto/analysis?symbol=BRK.B#chart")}`;
  const missing = await handoff();
  assert.deepEqual(missing.replacements, [expected]);
  assert.equal(missing.calls.length, 0);
  for (const status of [401, 403]) {
    const rejected = await handoff({ token: "private-budget-token", status });
    assert.deepEqual(rejected.replacements, [expected]);
    assert.ok(!rejected.replacements[0].includes("private-budget-token"));
  }
});

test("network and service failures leave a safe retry link instead of a login loop", async () => {
  for (const options of [{ status: 503 }, { networkError: true }]) {
    const result = await handoff({ token: "private-budget-token", ...options });
    assert.equal(result.replacements.length, 0);
    assert.match(result.statusNode.textContent, /could not connect/);
    assert.doesNotMatch(result.statusNode.textContent, /private-budget-token|Private transport/);
    assert.equal(result.statusNode.children[1].href, "/stocks-crypto/analysis?symbol=BRK.B#chart");
    assert.equal(result.statusNode.children[1].textContent, "Try again");
  }
});

test("the handoff cannot return to another origin or an unrelated app route", async () => {
  for (const pathname of ["//other.invalid/", "/stocks-cryptocurrency/", "/plan", "/stocks-crypto/../settings", "/stocks-crypto/%2e%2e/settings", "/stocks-crypto/%5cother.invalid", "/stocks-crypto/%00bad"]) {
    const result = await handoff({ pathname, search: "", hash: "" });
    assert.deepEqual(result.replacements, [`/login?next=${encodeURIComponent("/stocks-crypto/")}`]);
  }
  const unavailable = await handoff({ storageError: true });
  assert.equal(unavailable.calls.length, 0);
  assert.match(unavailable.replacements[0], /^\/login\?next=/);
});
