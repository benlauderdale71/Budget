import { expect, it } from "vitest";
import { realizeFifo } from "../src/lots.js";

it("conserves share, basis and proceeds remainders across partial FIFO sales with large integer products", () => {
  const original = [{ id: "a", acquired: "2000-01-01", quantityMicro: 6000000000000, costBasisMinor: 7000000000001 }, { id: "b", acquired: "2001-01-01", quantityMicro: 2000000, costBasisMinor: 1001 }];
  const first = realizeFifo(original, 5000000000001, 7000000000000);
  const second = realizeFifo(first.remaining, first.remaining.reduce((n, l) => n + l.quantityMicro, 0), 1002);
  expect([...first.sales, ...second.sales].reduce((n, s) => n + s.basisMinor, 0)).toBe(original.reduce((n, l) => n + l.costBasisMinor, 0));
  expect(first.sales.reduce((n, s) => n + s.proceedsMinor, 0)).toBe(7000000000000);
  expect(second.sales.reduce((n, s) => n + s.proceedsMinor, 0)).toBe(1002);
  expect(second.remaining).toEqual([]);
  expect(() => realizeFifo([...original, original[0]], 1, 1)).toThrow("unique");
});
