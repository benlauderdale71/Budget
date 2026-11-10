/** Integer money. Never store or reconcile with binary floats. */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** ISO currency minor-unit exponents. Unknown currencies default to 2 and are labeled as an assumption. */
export const CURRENCY_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  NZD: 2,
  CHF: 2,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  IQD: 3,
};

export function minorFactor(currency: string): number {
  const exp = CURRENCY_EXPONENTS[currency] ?? 2;
  return 10 ** exp;
}

export function assertMinor(value: number, label = "amount"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`${label} must be a finite number of minor units`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range`);
  }
  return value;
}

export function sameCurrency(a: string, b: string): void {
  if (a !== b) {
    throw new MoneyError(`Currency mismatch: ${a} vs ${b}. Convert with an explicit rate, date, and base amount.`);
  }
}

/** Round a positive rational to the nearest integer, half away from zero. Inputs must be integers. */
export function divRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError("denominator must be positive");
  const neg = numerator < 0n;
  const n = neg ? -numerator : numerator;
  const q = (n + denominator / 2n) / denominator;
  return neg ? -q : q;
}

/** Monthly interest in minor units. aprBps is annual APR in basis points (699 = 6.99%). */
export function monthlyInterestMinor(balanceMinor: number, aprBps: number): number {
  assertMinor(balanceMinor, "balance");
  assertMinor(aprBps, "apr");
  if (balanceMinor <= 0 || aprBps <= 0) return 0;
  const interest = divRoundHalfAway(BigInt(balanceMinor) * BigInt(aprBps), 10000n * 12n);
  return Number(interest);
}

/**
 * Multiply a decimal quantity string by a per-unit minor price.
 * "10.5" shares at 2500 cents = 26250 cents, rounded half away from zero.
 */
export function multiplyDecimalByMinor(quantity: string, priceMinor: number): number {
  assertMinor(priceMinor, "price");
  const text = quantity.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`Invalid quantity "${quantity}"`);
  }
  const neg = text.startsWith("-");
  const unsigned = neg ? text.slice(1) : text;
  const [whole, frac = ""] = unsigned.split(".");
  const scale = 10n ** BigInt(frac.length);
  const q = BigInt((whole || "0") + frac);
  const signed = neg ? -q : q;
  const value = divRoundHalfAway(signed * BigInt(priceMinor), scale);
  const asNum = Number(value);
  if (!Number.isSafeInteger(asNum)) throw new MoneyError("market value exceeds safe integer");
  return asNum;
}

export function formatMinor(amountMinor: number, currency: string, locale = "en-US"): string {
  assertMinor(amountMinor, "amount");
  const factor = minorFactor(currency);
  const exp = CURRENCY_EXPONENTS[currency] ?? 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(amountMinor / factor);
}

/** Prefix spreadsheet formula triggers so Excel/Sheets treat them as text. */
export function sanitizeSpreadsheetCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

export interface ExplainedNumber {
  amountMinor: number;
  currency: string;
  title: string;
  formula: string;
  lines: { label: string; amountMinor: number; hint?: string }[];
}
