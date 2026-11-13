import { daysBetween } from "./dates.js";
import { divRoundHalfAway, multiplyDecimalByMinor } from "./money.js";

export interface Quote {
  symbol: string;
  priceMinor: number;
  asOf: string;
  source: "manual" | "provider";
  delayed: boolean;
  currency: string;
}

export interface Holding {
  id: string;
  accountId: string;
  symbol: string;
  name: string;
  assetClass: string;
  sector?: string;
  geography?: string;
  quantity: string;
  costBasisMinor: number | null;
  currency: string;
}

export interface Lot {
  id: string;
  holdingId: string;
  quantity: string;
  costBasisMinor: number;
  acquired: string;
}

export function marketValueMinor(holding: Holding, quote: Quote | undefined): number | null {
  if (!quote) return null;
  if (quote.currency !== holding.currency) return null;
  return multiplyDecimalByMinor(holding.quantity, quote.priceMinor);
}

export interface PositionView {
  holdingId: string;
  symbol: string;
  marketValueMinor: number | null;
  costBasisMinor: number | null;
  unrealizedMinor: number | null;
  quoteSource: Quote["source"] | "missing";
  quoteAsOf: string | null;
  delayed: boolean;
  missing: string[];
}

export function positionView(holding: Holding, quote?: Quote): PositionView {
  const missing: string[] = [];
  if (!quote) missing.push("No price on file. Add a manual price or connect a market-data provider. BudgetCents does not invent live quotes.");
  else if (quote.currency !== holding.currency) missing.push(`The quote is ${quote.currency} and the holding is ${holding.currency}. They are not combined.`);
  if (holding.costBasisMinor == null) missing.push("Cost basis is missing, so gain and loss are not calculated.");
  const market = quote ? marketValueMinor(holding, quote) : null;
  const unrealized = market != null && holding.costBasisMinor != null ? market - holding.costBasisMinor : null;
  return {
    holdingId: holding.id,
    symbol: holding.symbol,
    marketValueMinor: market,
    costBasisMinor: holding.costBasisMinor,
    unrealizedMinor: unrealized,
    quoteSource: quote?.source ?? "missing",
    quoteAsOf: quote?.asOf ?? null,
    delayed: quote?.delayed ?? false,
    missing,
  };
}

export interface CashFlow {
  date: string;
  /** Investor sign: contributions negative, withdrawals and ending value positive. */
  amountMinor: number;
}

/** Money-weighted return via XIRR. Returns a decimal (0.05 = 5%) or null when it does not converge. */
export function moneyWeightedReturn(flows: CashFlow[]): { rate: number | null; method: string } {
  if (flows.length < 2) return { rate: null, method: "Need at least two dated cash flows." };
  const start = flows.map((f) => f.date).sort()[0];
  const f = (rate: number) =>
    flows.reduce((sum, flow) => {
      const years = daysBetween(start, flow.date) / 365;
      return sum + flow.amountMinor / Math.pow(1 + rate, years);
    }, 0);
  let rate = 0.1;
  for (let i = 0; i < 50; i++) {
    const value = f(rate);
    const step = 0.0001;
    const derivative = (f(rate + step) - value) / step;
    if (!Number.isFinite(derivative) || derivative === 0) break;
    const next = rate - value / derivative;
    if (Math.abs(next - rate) < 1e-8) return { rate: next, method: "XIRR (Newton). Deposits are negative cash flows; the current value is a positive flow on the valuation date. Not a guarantee." };
    rate = next;
    if (rate <= -0.99) break;
  }
  return { rate: null, method: "XIRR did not converge for these cash flows." };
}

export interface ValuationPoint {
  date: string;
  valueMinor: number;
  /** External contribution (+) or withdrawal (−) that happened at the END of the previous subperiod / start of this one. */
  externalFlowMinor: number;
}

/**
 * Time-weighted return across valuation points.
 * Each subperiod return is (endValue) / (startValue + externalFlow) - 1, and external flow is applied at the start of the subperiod.
 */
export function timeWeightedReturn(points: ValuationPoint[]): { rate: number | null; method: string } {
  if (points.length < 2) return { rate: null, method: "Need two valuations to compute a time-weighted return." };
  const ordered = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  let factor = 1;
  for (let i = 1; i < ordered.length; i++) {
    const start = ordered[i - 1].valueMinor + ordered[i].externalFlowMinor;
    if (start <= 0) return { rate: null, method: "A subperiod started at zero, so time-weighted return is undefined." };
    factor *= ordered[i].valueMinor / start;
  }
  return {
    rate: factor - 1,
    method: "Time-weighted return chains subperiod growth so deposits and withdrawals do not look like investment performance.",
  };
}

export interface AllocationSlice {
  key: string;
  valueMinor: number;
  weightBps: number;
}

/** Combine rows that share a key before weighting them. Missing values are omitted by the caller. */
export function allocationByKey(rows: { key: string; valueMinor: number }[]): AllocationSlice[] {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isInteger(row.valueMinor) || row.valueMinor < 0) continue;
    grouped.set(row.key, (grouped.get(row.key) ?? 0) + row.valueMinor);
  }
  return allocation([...grouped.entries()].map(([key, valueMinor]) => ({ key, valueMinor })));
}

export function allocation(rows: { key: string; valueMinor: number }[]): AllocationSlice[] {
  const total = rows.reduce((s, row) => s + Math.max(0, row.valueMinor), 0);
  return rows.map((row) => ({
    key: row.key,
    valueMinor: row.valueMinor,
    weightBps: total > 0 ? Number(divRoundHalfAway(BigInt(Math.max(0, row.valueMinor)) * 10000n, BigInt(total))) : 0,
  }));
}

export interface FeeImpact {
  annualFeeMinor: number;
  balanceAfterYearsWithFeeMinor: number;
  balanceAfterYearsWithoutFeeMinor: number;
  compoundFeeCostMinor: number;
  assumptions: string[];
}

/** Compound a balance annually. growthBps and feeBps are annual. Integer minor units via bigint rounding. */
export function feeImpact(input: {
  balanceMinor: number;
  expenseRatioBps: number;
  advisoryBps: number;
  growthBps: number;
  years: number;
}): FeeImpact {
  const feeBps = input.expenseRatioBps + input.advisoryBps;
  const grow = (balance: number, netBps: number) => {
    let value = BigInt(balance);
    for (let i = 0; i < input.years; i++) {
      value = divRoundHalfAway(value * BigInt(10000 + netBps), 10000n);
    }
    return Number(value);
  };
  const withFee = grow(input.balanceMinor, input.growthBps - feeBps);
  const without = grow(input.balanceMinor, input.growthBps);
  const annualFee = Number(divRoundHalfAway(BigInt(input.balanceMinor) * BigInt(feeBps), 10000n));
  return {
    annualFeeMinor: annualFee,
    balanceAfterYearsWithFeeMinor: withFee,
    balanceAfterYearsWithoutFeeMinor: without,
    compoundFeeCostMinor: without - withFee,
    assumptions: [
      "Fees are a flat annual percent of the balance, compounded once a year.",
      "The growth rate is an assumption you entered, not a forecast from a market-data provider.",
    ],
  };
}

export function holdingPeriodDays(acquired: string, asOf: string): number {
  return daysBetween(acquired, asOf);
}

export interface DriftRow {
  key: string;
  actualBps: number;
  targetBps: number;
  driftBps: number;
}

export function allocationDrift(actual: AllocationSlice[], targets: { key: string; targetBps: number }[]): DriftRow[] {
  const keys = new Set([...actual.map((row) => row.key), ...targets.map((row) => row.key)]);
  return [...keys].map((key) => {
    const actualBps = actual.find((row) => row.key === key)?.weightBps ?? 0;
    const targetBps = targets.find((row) => row.key === key)?.targetBps ?? 0;
    return { key, actualBps, targetBps, driftBps: actualBps - targetBps };
  });
}
