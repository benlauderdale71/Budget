import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_UNDO_LIMIT } from "@budgetcents/domain/dashboard-layout";
import { readUndoStacks, withUndoStack, writeUndoStacks, type UndoStacks } from "../src/dashboard-undo.ts";

const owner = "user-owner";
const other = "user-other";

function cards(ids: string[], hiddenId = "") {
  return ids.map((id) => ({ id, hidden: id === hiddenId, size: id === "recent" ? "standard" as const : "wide" as const }));
}

test("undo history keeps order, visibility, and size for one user and device class", () => {
  let stacks: UndoStacks = new Map();
  const desktop = `${owner}:web-desktop`;
  const compact = `${owner}:web-compact`;
  stacks = withUndoStack(stacks, desktop, [cards(["safe", "worth", "goals"])]);
  stacks = withUndoStack(stacks, desktop, [cards(["safe", "worth", "goals"]), cards(["worth", "safe", "goals"], "goals")]);
  stacks = withUndoStack(stacks, compact, [cards(["safe", "alerts"])]);
  const stored = writeUndoStacks(stacks);
  const read = readUndoStacks(stored, owner);
  assert.deepEqual(read.get(desktop)?.at(-1)?.find((card) => card.id === "goals"), { id: "goals", hidden: true, size: "wide" });
  assert.equal(read.get(desktop)?.[0]?.[0]?.id, "safe");
  assert.equal(read.get(compact)?.[0]?.map((card) => card.id).join(","), "safe,alerts");
  assert.equal(readUndoStacks(stored, other).size, 0);
});

test("a stored undo for someone else is dropped when this user writes", () => {
  const foreign = writeUndoStacks(withUndoStack(new Map(), `${other}:web-desktop`, [cards(["worth"])]));
  const mine = readUndoStacks(foreign, owner);
  assert.equal(mine.size, 0);
  assert.equal(writeUndoStacks(mine), "{}");
});

test("malformed undo history is ignored and the stack stays bounded", () => {
  const raw = JSON.stringify({
    [`${owner}:web-desktop`]: [cards(["safe"]), { id: "worth" }, cards(["ready"])],
    [`${owner}:bad`]: "nope",
    [`${other}:web-desktop`]: [cards(["worth"])],
  });
  assert.equal(readUndoStacks(raw, owner).size, 0);
  assert.equal(readUndoStacks("{", owner).size, 0);
  let stacks: UndoStacks = new Map();
  const key = `${owner}:android-compact`;
  const entries = Array.from({ length: DASHBOARD_UNDO_LIMIT + 3 }, (_, index) => cards([`card-${index}`]));
  stacks = withUndoStack(stacks, key, entries);
  const stack = readUndoStacks(writeUndoStacks(stacks), owner).get(key) ?? [];
  assert.equal(stack.length, DASHBOARD_UNDO_LIMIT);
  assert.equal(stack[0][0].id, "card-3");
  assert.equal(stack.at(-1)?.[0]?.id, `card-${DASHBOARD_UNDO_LIMIT + 2}`);
});

test("clearing one class leaves the other class and does not invent cards", () => {
  let stacks = withUndoStack(new Map(), `${owner}:web-desktop`, [cards(["worth", "safe"])]);
  stacks = withUndoStack(stacks, `${owner}:web-compact`, [cards(["safe"])]);
  stacks = withUndoStack(stacks, `${owner}:web-desktop`, []);
  const read = readUndoStacks(writeUndoStacks(stacks), owner);
  assert.equal(read.has(`${owner}:web-desktop`), false);
  assert.equal(read.get(`${owner}:web-compact`)?.[0]?.[0]?.id, "safe");
});
