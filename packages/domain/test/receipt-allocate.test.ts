import { describe, expect, it } from "vitest";
import { allocateLargestRemainder, extendedMinor, proposeReceiptSplits } from "../src/receipt-allocate.js";

describe("receipt allocation", () => {
  it("shares tax in proportion and reconciles the acceptance example", () => {
    const result = proposeReceiptSplits({
      lines: [
        { id: "groceries", amountMinor: 500, bucketId: "groceries" },
        { id: "household", amountMinor: 300, bucketId: "household" },
      ],
      taxMinor: 80,
      tipMinor: 0,
      discountMinor: 0,
      otherMinor: 0,
      totalMinor: 880,
      taxInclusive: false,
      mode: "proportional",
      adjustmentBucketId: null,
      reviewedAdjustment: null,
    });
    expect(result.reconciled).toBe(true);
    expect(result.splits).toEqual([
      { bucketId: "groceries", amountMinor: 550, role: "expense" },
      { bucketId: "household", amountMinor: 330, role: "expense" },
    ]);
    expect(result.netMinor).toBe(880);
  });

  it("gives a one-cent remainder to the earliest of three equal lines", () => {
    const shares = allocateLargestRemainder(1, [100, 100, 100]);
    expect(shares).toEqual([1, 0, 0]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1);
    const again = allocateLargestRemainder(1, [100, 100, 100]);
    expect(again).toEqual(shares);
  });

  it("does not add tax again on a tax-inclusive receipt or flip a return positive", () => {
    const inclusive = proposeReceiptSplits({
      lines: [
        { id: "a", amountMinor: 500, bucketId: "groceries" },
        { id: "b", amountMinor: -100, bucketId: "household" },
      ],
      taxMinor: 40,
      tipMinor: 0,
      discountMinor: 0,
      otherMinor: 0,
      totalMinor: 400,
      taxInclusive: true,
      mode: "proportional",
      adjustmentBucketId: null,
      reviewedAdjustment: null,
    });
    expect(inclusive.reconciled).toBe(true);
    expect(inclusive.adjustmentMinor).toBe(0);
    expect(inclusive.splits).toEqual([
      { bucketId: "groceries", amountMinor: 500, role: "expense" },
      { bucketId: "household", amountMinor: 100, role: "refund" },
    ]);
    expect(inclusive.message).toMatch(/not added again/);
  });

  it("keeps an unexplained difference out of the last category until it is reviewed", () => {
    const open = proposeReceiptSplits({
      lines: [{ id: "a", amountMinor: 500, bucketId: "groceries" }],
      taxMinor: 0,
      tipMinor: 0,
      discountMinor: 0,
      otherMinor: 0,
      totalMinor: 550,
      taxInclusive: false,
      mode: "proportional",
      adjustmentBucketId: null,
      reviewedAdjustment: null,
    });
    expect(open.reconciled).toBe(false);
    expect(open.differenceMinor).toBe(50);
    expect(open.splits).toEqual([{ bucketId: "groceries", amountMinor: 500, role: "expense" }]);
    const reviewed = proposeReceiptSplits({
      ...{
        lines: [{ id: "a", amountMinor: 500, bucketId: "groceries" }],
        taxMinor: 0, tipMinor: 0, discountMinor: 0, otherMinor: 0, totalMinor: 550,
        taxInclusive: false, mode: "proportional" as const, adjustmentBucketId: null,
      },
      reviewedAdjustment: { amountMinor: 50, bucketId: "household", note: "Bag fee printed as a total difference." },
    });
    expect(reviewed.reconciled).toBe(true);
    expect(reviewed.netMinor).toBe(550);
    expect(reviewed.splits.find((split) => split.bucketId === "household")?.amountMinor).toBe(50);
  });

  it("rounds a quantity times a unit price in minor units", () => {
    expect(extendedMinor(199, 1500)).toBe(299);
    expect(extendedMinor(-250, 2000)).toBe(-500);
  });
});
