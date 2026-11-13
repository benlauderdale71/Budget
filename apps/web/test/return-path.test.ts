import assert from "node:assert/strict";
import test from "node:test";
import { marketReturnPath } from "../src/return-path.ts";

test("market return navigation preserves local deep links and query or fragment state", () => {
  assert.equal(marketReturnPath("/stocks-crypto/analysis?symbol=BRK.B#chart"), "/stocks-crypto/analysis?symbol=BRK.B#chart");
  assert.equal(marketReturnPath("/stocks-crypto/"), "/stocks-crypto/");
  assert.equal(marketReturnPath("/stocks-crypto"), "/stocks-crypto");
});

test("only validated Market Pulse routes trigger document navigation", () => {
  for (const path of [null, undefined, "", "/plan", "/invite/safe", "/stocks-cryptocurrency/", "https://other.invalid/stocks-crypto/", "//other.invalid/stocks-crypto/", "/stocks-crypto/../settings", "/stocks-crypto/%2e%2e/settings", "/stocks-crypto/%5cother.invalid"]) {
    assert.equal(marketReturnPath(path), null);
  }
});
