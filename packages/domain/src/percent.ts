/**
 * Percentages are stored as basis points. One basis point is 0.01 percent, so 10.5% is 1050.
 * A value may have at most two decimal places. The currency result is
 * round(eligiblePostedIncomeMinor * percentBps / 10000), with halves rounded away from zero.
 * The product of the two integers must stay inside the safe integer range.
 */
export const PERCENT_PRECISION =
  "Percentages use basis points: 1 basis point is 0.01%. 10.5% is stored as 1050. More than two decimal places is rejected. The target is the eligible posted income times that rate, rounded to the nearest minor unit.";

export function percentBpsFromDecimal(value: string): number {
  const text = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error("Enter a percent from 0 to 100 with at most two decimal places.");
  }
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (bps > 10_000) throw new Error("Enter a percent from 0 to 100.");
  return bps;
}

export function formatPercent(percentBps: number): string {
  const whole = Math.floor(percentBps / 100);
  const fraction = String(percentBps % 100).padStart(2, "0");
  return `${whole}.${fraction}%`;
}

/** Half away from zero. Both inputs are integers. */
export function percentTargetMinor(incomeMinor: number, percentBps: number): number {
  if (!Number.isInteger(incomeMinor) || !Number.isInteger(percentBps)) throw new Error("Percent math needs integers.");
  if (percentBps < 0 || percentBps > 10_000) throw new Error("Enter a percent from 0 to 100.");
  const product = incomeMinor * percentBps;
  if (!Number.isSafeInteger(product)) throw new Error("That income is too large to multiply exactly.");
  const sign = product < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(product) + 5_000) / 10_000);
}
