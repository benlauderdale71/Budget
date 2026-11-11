import { divRoundHalfAway } from "./money.js";

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

/** Split a non-negative minor amount by positive weights. Ties go to the earliest line. */
export function allocateLargestRemainder(amount: number, weights: number[]): number[] {
  if (!Number.isInteger(amount) || amount < 0) throw new AllocationError("The adjustment must be a non-negative number of minor units.");
  if (!weights.length) throw new AllocationError("There is no positive item to share this adjustment across.");
  if (weights.some((weight) => !Number.isInteger(weight) || weight <= 0)) {
    throw new AllocationError("Only positive item amounts can share an adjustment.");
  }
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map(() => 0);
  const fractions: { index: number; remainder: number }[] = [];
  let used = 0;
  for (let index = 0; index < weights.length; index++) {
    const numerator = BigInt(amount) * BigInt(weights[index]);
    const floor = numerator / BigInt(weightSum);
    shares[index] = Number(floor);
    used += shares[index];
    fractions.push({ index, remainder: Number(numerator % BigInt(weightSum)) });
  }
  fractions.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let leftover = amount - used;
  for (let index = 0; leftover > 0; index++) {
    shares[fractions[index].index] += 1;
    leftover -= 1;
  }
  return shares;
}

/** Quantity is thousandths of a unit. 1.5 is 1500. Half a minor unit rounds away from zero. */
export function extendedMinor(unitMinor: number, quantityMilli: number): number {
  if (!Number.isInteger(unitMinor) || !Number.isInteger(quantityMilli)) {
    throw new AllocationError("Quantity and price must be exact minor units.");
  }
  const negative = (unitMinor < 0) !== (quantityMilli < 0) && unitMinor !== 0 && quantityMilli !== 0;
  const value = Number(divRoundHalfAway(BigInt(Math.abs(unitMinor)) * BigInt(Math.abs(quantityMilli)), 1000n));
  return negative ? -value : value;
}

export interface AllocationLine {
  id: string;
  amountMinor: number;
  bucketId: string;
}

export interface AllocationInput {
  lines: AllocationLine[];
  taxMinor: number;
  tipMinor: number;
  discountMinor: number;
  otherMinor: number;
  totalMinor: number;
  taxInclusive: boolean;
  mode: "proportional" | "category";
  adjustmentBucketId: string | null;
  reviewedAdjustment: { amountMinor: number; bucketId: string; note: string } | null;
}

export interface ProposedSplit {
  bucketId: string;
  amountMinor: number;
  role: "expense" | "refund";
}

export interface AllocationResult {
  splits: ProposedSplit[];
  categoryTotals: { bucketId: string; amountMinor: number }[];
  lineSumMinor: number;
  adjustmentMinor: number;
  expectedMinor: number;
  differenceMinor: number;
  netMinor: number;
  reconciled: boolean;
  message: string;
}

export function proposeReceiptSplits(input: AllocationInput): AllocationResult {
  const lines = input.lines;
  if (!lines.length) throw new AllocationError("Add at least one line before allocating the receipt.");
  if (lines.some((line) => !line.bucketId)) throw new AllocationError("Assign a category to every line.");
  if (lines.some((line) => !Number.isInteger(line.amountMinor))) throw new AllocationError("Every line needs an amount in minor units.");
  const lineSum = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const amounts = [input.taxMinor, input.tipMinor, input.discountMinor, input.otherMinor, input.totalMinor];
  if (amounts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new AllocationError("Enter tax, tip, discount, other charges, and the total as non-negative minor units. A return belongs on a line.");
  }
  const taxAdd = input.taxInclusive ? 0 : input.taxMinor;
  const adjustment = taxAdd + input.tipMinor + input.otherMinor - input.discountMinor;
  const expected = lineSum + adjustment;
  const difference = input.totalMinor - expected;
  const signed = new Map<string, number>();
  for (const line of lines) signed.set(line.bucketId, (signed.get(line.bucketId) ?? 0) + line.amountMinor);

  const positive = lines.filter((line) => line.amountMinor > 0);
  const pieces = [
    ["tax", taxAdd],
    ["tip", input.tipMinor],
    ["other", input.otherMinor],
  ] as const;
  let blocked: string | null = null;
  if (input.taxInclusive && input.taxMinor > 0) {
    blocked = null;
  }
  const needsShare = adjustment !== 0;
  if (needsShare && input.mode === "proportional" && !positive.length) {
    blocked = "Choose a category for the tax, tip, or discount. A return line does not receive a share.";
  } else if (needsShare && input.mode === "category" && !input.adjustmentBucketId) {
    blocked = "Choose the category that should receive the tax, tip, and discount.";
  } else if (needsShare && input.mode === "proportional") {
    const weights = positive.map((line) => line.amountMinor);
    for (const [, amount] of pieces) {
      if (amount === 0) continue;
      const shares = allocateLargestRemainder(amount, weights);
      shares.forEach((share, index) => {
        const bucketId = positive[index].bucketId;
        signed.set(bucketId, (signed.get(bucketId) ?? 0) + share);
      });
    }
    if (input.discountMinor > 0) {
      const shares = allocateLargestRemainder(input.discountMinor, weights);
      shares.forEach((share, index) => {
        const bucketId = positive[index].bucketId;
        signed.set(bucketId, (signed.get(bucketId) ?? 0) - share);
      });
    }
  } else if (needsShare && input.mode === "category" && input.adjustmentBucketId) {
    signed.set(input.adjustmentBucketId, (signed.get(input.adjustmentBucketId) ?? 0) + adjustment);
  }

  let message = input.taxInclusive && input.taxMinor > 0
    ? "Tax is already included in the item prices, so it was not added again."
    : "Adjustments are shared by the method you chose.";
  if (blocked) message = blocked;
  let reconciled = !blocked && difference === 0;
  if (!blocked && difference !== 0) {
    const reviewed = input.reviewedAdjustment;
    const note = reviewed?.note.trim() ?? "";
    if (reviewed && reviewed.amountMinor === difference && reviewed.bucketId && note) {
      signed.set(reviewed.bucketId, (signed.get(reviewed.bucketId) ?? 0) + reviewed.amountMinor);
      reconciled = true;
      message = `A reviewed adjustment of ${reviewed.amountMinor} minor units was assigned to the category you chose. ${note}`;
    } else {
      reconciled = false;
      message = `The lines and adjustments come to ${expected} minor units and the total is ${input.totalMinor}. The difference is ${difference}. Correct a field or record a reviewed adjustment for that exact difference.`;
    }
  }

  const categoryTotals = [...signed.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([bucketId, amountMinor]) => ({ bucketId, amountMinor }))
    .sort((a, b) => a.bucketId.localeCompare(b.bucketId));
  const splits: ProposedSplit[] = categoryTotals.map((row) => ({
    bucketId: row.bucketId,
    amountMinor: Math.abs(row.amountMinor),
    role: row.amountMinor < 0 ? "refund" : "expense",
  }));
  const net = categoryTotals.reduce((sum, row) => sum + row.amountMinor, 0);
  if (reconciled && net !== input.totalMinor) {
    reconciled = false;
    message = `The categories add to ${net} minor units and the receipt total is ${input.totalMinor}. Nothing was posted.`;
  }
  return {
    splits,
    categoryTotals,
    lineSumMinor: lineSum,
    adjustmentMinor: adjustment,
    expectedMinor: expected,
    differenceMinor: difference,
    netMinor: net,
    reconciled,
    message,
  };
}
