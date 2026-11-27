import { test } from "node:test";
import assert from "node:assert/strict";
import { watchChanges } from "../src/live-changes.ts";

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("checks on wake, skips unchanged revisions, and pauses while hidden", async () => {
  let active = true;
  let revision = "first";
  let requests = 0;
  let updates = 0;
  const watch = watchChanges({ load: async () => { requests++; return { revision }; }, active: () => active,
    changed: () => { updates++; }, failed: () => assert.fail("unexpected failure"), recovered: () => {} });
  try {
    await settled();
    assert.equal(updates, 1);
    watch.wake(); await settled();
    assert.equal(updates, 1);
    active = false; revision = "second";
    watch.wake(); await settled();
    assert.equal(requests, 2);
    active = true;
    watch.wake(); await settled();
    assert.equal(updates, 2);
    watch.invalidate(); watch.wake(); await settled();
    assert.equal(updates, 3, "a failed data refresh can retry the same revision");
  } finally { watch.stop(); }
});

test("does not overlap requests or publish a disposed session's response", async () => {
  let finish!: (value: { revision: string }) => void;
  let signal!: AbortSignal;
  let requests = 0;
  let updates = 0;
  const watch = watchChanges({ load: (input) => { requests++; signal = input; return new Promise((resolve) => { finish = resolve; }); },
    active: () => true, changed: () => { updates++; }, failed: () => assert.fail("disposed request reported an error"), recovered: () => {} });
  watch.wake(); watch.wake();
  assert.equal(requests, 1);
  watch.stop();
  assert.equal(signal.aborted, true);
  finish({ revision: "old household" }); await settled();
  assert.equal(updates, 0);
});

test("a failed check preserves the cursor and reconnect catches the next change", async () => {
  let reject = false;
  let revision = "a";
  let updates = 0;
  let failures = 0;
  let recoveries = 0;
  const watch = watchChanges({ load: async () => { if (reject) throw new Error("offline"); return { revision }; }, active: () => true,
    changed: () => { updates++; }, failed: () => { failures++; }, recovered: () => { recoveries++; } });
  try {
    await settled(); reject = true;
    watch.wake(); await settled();
    assert.equal(failures, 1); assert.equal(updates, 1);
    reject = false;
    watch.wake(); await settled();
    assert.equal(updates, 2); assert.equal(recoveries, 2);
    revision = "b";
    watch.wake(); await settled();
    assert.equal(updates, 3);
  } finally { watch.stop(); }
});
