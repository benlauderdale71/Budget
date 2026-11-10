import { describe, expect, it } from "vitest";
import { partitionQueue, withStableOpId } from "../../web/src/queue";

describe("browser transaction queue", () => {
  it("keeps the operation id that was assigned before the first attempt", () => {
    let calls = 0;
    const first = withStableOpId("/api/households/h/transactions", "POST", JSON.stringify({ payee: "Cafe", amountMinor: -500 }), () => {
      calls += 1;
      return "op-stable";
    });
    const retry = withStableOpId("/api/households/h/transactions", "POST", first.body, () => "op-other");
    expect(first.opId).toBe("op-stable");
    expect(retry.opId).toBe("op-stable");
    expect(calls).toBe(1);
    expect(JSON.parse(retry.body ?? "{}").opId).toBe("op-stable");
  });

  it("does not send another user's queued transactions", () => {
    const items = [
      { path: "/api/households/a/transactions", method: "POST", body: "{}", at: 1, ownerId: "ada", opId: "a" },
      { path: "/api/households/b/transactions", method: "POST", body: "{}", at: 2, ownerId: "bea", opId: "b" },
    ];
    const signedOut = partitionQueue(items, null);
    expect(signedOut.send).toEqual([]);
    expect(signedOut.keep).toHaveLength(2);
    const ada = partitionQueue(items, "ada");
    expect(ada.send.map((item) => item.opId)).toEqual(["a"]);
    expect(ada.keep.map((item) => item.opId)).toEqual(["b"]);
  });
});