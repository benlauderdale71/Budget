import { daysBetween, periodFromDate } from "./dates.js";
import type { Account, EngineInput, Transaction } from "./types.js";
import { displayBalance, isLiability, isOnBudgetCash } from "./budget.js";

export interface ReportRow {
  key: string;
  label: string;
  amountMinor: number;
  transactionIds: string[];
}

function inRange(txn: Transaction, from: string, to: string): boolean {
  return !txn.deleted && txn.date >= from && txn.date <= to && txn.bankStatus !== "pending" && !txn.excludeFromReports;
}

const SPEND_TYPES = new Set(["expense", "fee", "interest"]);
const NON_SPEND = new Set(["transfer", "cc_payment", "loan_proceeds", "opening", "reconciliation", "buy", "sell"]);

export function spendingRows(input: EngineInput, from: string, to: string, keyOf: (txn: Transaction, bucketId: string | null) => string): ReportRow[] {
  const map = new Map<string, ReportRow>();
  for (const txn of input.transactions) {
    if (!inRange(txn, from, to)) continue;
    if (NON_SPEND.has(txn.type)) continue;
    const account = input.accounts.find((a) => a.id === txn.accountId);
    if (!account) continue;
    if (txn.type === "refund" || txn.type === "reimbursement") {
      for (const split of txn.splits.length ? txn.splits : [{ bucketId: null, amountMinor: Math.abs(txn.amountMinor), role: "refund" as const }]) {
        const key = keyOf(txn, split.bucketId);
        const row = map.get(key) ?? { key, label: key, amountMinor: 0, transactionIds: [] };
        row.amountMinor -= split.amountMinor;
        row.transactionIds.push(txn.id);
        map.set(key, row);
      }
      continue;
    }
    if (!SPEND_TYPES.has(txn.type) && txn.type !== "loan_payment") continue;
    const splits = txn.splits.length ? txn.splits : [{ bucketId: null, amountMinor: Math.abs(txn.amountMinor), role: "expense" as const }];
    for (const split of splits) {
      if (split.role === "principal" || split.role === "transfer" || split.role === "income") continue;
      const key = keyOf(txn, split.bucketId);
      const row = map.get(key) ?? { key, label: key, amountMinor: 0, transactionIds: [] };
      row.amountMinor += split.amountMinor;
      if (!row.transactionIds.includes(txn.id)) row.transactionIds.push(txn.id);
      map.set(key, row);
    }
    void account;
  }
  return [...map.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}

export function incomeRows(input: EngineInput, from: string, to: string): ReportRow[] {
  const map = new Map<string, ReportRow>();
  for (const txn of input.transactions) {
    if (!inRange(txn, from, to) || txn.type !== "income") continue;
    const key = txn.payee || "Income";
    const row = map.get(key) ?? { key, label: key, amountMinor: 0, transactionIds: [] };
    row.amountMinor += Math.abs(txn.amountMinor);
    row.transactionIds.push(txn.id);
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}

export interface SankeyLink {
  source: string;
  target: string;
  amountMinor: number;
}

export function cashFlowSankey(input: EngineInput, from: string, to: string): { links: SankeyLink[] } {
  const links: SankeyLink[] = [];
  const spending = spendingRows(input, from, to, (txn, bucketId) => {
    const bucket = input.buckets.find((b) => b.id === bucketId);
    return bucket?.group || "Uncategorized";
  });
  const income = incomeRows(input, from, to);
  for (const row of income) links.push({ source: row.label, target: "Inflow", amountMinor: row.amountMinor });
  const totalSpend = spending.reduce((s, row) => s + row.amountMinor, 0);
  if (totalSpend > 0) links.push({ source: "Inflow", target: "Spending", amountMinor: totalSpend });
  for (const row of spending) {
    if (row.amountMinor > 0) links.push({ source: "Spending", target: row.label, amountMinor: row.amountMinor });
  }
  return { links };
}

export interface NetWorthBreakdown {
  assetsMinor: number;
  liabilitiesMinor: number;
  netMinor: number;
  liquidMinor: number;
  formula: string;
  accounts: { accountId: string; name: string; displayMinor: number; contributionMinor: number; liquid: boolean }[];
}

export function netWorth(input: EngineInput, values?: { accountId: string; valueMinor: number }[]): NetWorthBreakdown {
  const accounts = input.accounts
    .filter((account) => !account.excludeFromNetWorth && !account.archived)
    .map((account) => {
      const override = values?.find((value) => value.accountId === account.id);
      const display = override ? override.valueMinor : displayBalance(account, input.transactions, input.asOf, false);
      const contribution = isLiability(account) ? -display : display;
      return {
        accountId: account.id,
        name: account.name,
        displayMinor: display,
        contributionMinor: contribution,
        liquid: isOnBudgetCash(account),
      };
    });
  const assets = accounts.filter((row) => row.contributionMinor > 0).reduce((s, row) => s + row.contributionMinor, 0);
  const liabilities = accounts.filter((row) => row.contributionMinor < 0).reduce((s, row) => s + -row.contributionMinor, 0);
  const liquid = accounts.filter((row) => row.liquid).reduce((s, row) => s + row.contributionMinor, 0);
  return {
    assetsMinor: assets,
    liabilitiesMinor: liabilities,
    netMinor: assets - liabilities,
    liquidMinor: liquid,
    formula: "Net worth is owned balances minus amounts owed. Liquid net worth is on-budget checking, savings, and cash only. Investment values are included only from holdings or a dated valuation you entered — missing prices are not filled in.",
    accounts,
  };
}

export function savingsRate(incomeMinor: number, spendingMinor: number): { rateBps: number | null; formula: string } {
  if (incomeMinor <= 0) return { rateBps: null, formula: "Savings rate needs positive income in the selected period." };
  const saved = incomeMinor - spendingMinor;
  return {
    rateBps: Math.round((saved / incomeMinor) * 10000),
    formula: "(Income − spending) / income. Transfers, credit-card payments, and refunds are not income. Refunds reduce spending.",
  };
}

export interface WatchlistSpec {
  id: string;
  name: string;
  payees?: string[];
  bucketIds?: string[];
  tags?: string[];
  targetMinor?: number;
  from?: string;
  to?: string;
}

export function evaluateWatchlist(spec: WatchlistSpec, input: EngineInput, asOf: string): {
  actualMinor: number;
  targetMinor: number | null;
  averageMonthlyMinor: number | null;
  transactionIds: string[];
  formula: string;
} {
  const from = spec.from ?? periodFromDate(asOf).start;
  const to = spec.to ?? asOf;
  const ids: string[] = [];
  let actual = 0;
  for (const txn of input.transactions) {
    if (!inRange(txn, from, to)) continue;
    if (spec.payees?.length && !spec.payees.some((payee) => txn.payee.toLowerCase().includes(payee.toLowerCase()))) continue;
    if (spec.tags?.length && !spec.tags.some((tag) => txn.tags?.includes(tag))) continue;
    if (spec.bucketIds?.length && !txn.splits.some((split) => split.bucketId && spec.bucketIds!.includes(split.bucketId))) continue;
    if (NON_SPEND.has(txn.type) || txn.type === "income") continue;
    const sign = txn.type === "refund" || txn.type === "reimbursement" ? -1 : 1;
    actual += sign * Math.abs(txn.amountMinor);
    ids.push(txn.id);
  }
  const days = Math.max(1, daysBetween(from, to) + 1);
  const average = Math.round((actual / days) * 30);
  return {
    actualMinor: actual,
    targetMinor: spec.targetMinor ?? null,
    averageMonthlyMinor: average,
    transactionIds: ids,
    formula: "Actual spending in the window, with refunds subtracted. The monthly average annualizes the selected days × 30 and does not invent activity outside the window. Pending transactions are excluded.",
  };
}

export interface RoadmapMilestone {
  id: string;
  label: string;
  complete: boolean;
  detail: string;
}

export function financialRoadmap(input: {
  emergencyMonths: number;
  essentialMonthlyMinor: number;
  emergencySavedMinor: number;
  debtBalanceMinor: number;
  retirementContributionAnnualMinor: number;
  retirementTargetAnnualMinor: number;
  order: { id: string; label: string }[];
}): RoadmapMilestone[] {
  const facts: Record<string, RoadmapMilestone> = {
    starter_emergency: {
      id: "starter_emergency",
      label: "Starter emergency buffer",
      complete: input.emergencySavedMinor >= input.essentialMonthlyMinor,
      detail: "One month of essential spending set aside.",
    },
    debt_free: {
      id: "debt_free",
      label: "Consumer debt payoff",
      complete: input.debtBalanceMinor <= 0,
      detail: "Modeled consumer debts are at zero.",
    },
    full_emergency: {
      id: "full_emergency",
      label: "Full emergency reserve",
      complete: input.emergencySavedMinor >= input.essentialMonthlyMinor * input.emergencyMonths,
      detail: `${input.emergencyMonths} months of essential spending.`,
    },
    retirement: {
      id: "retirement",
      label: "Retirement contribution",
      complete: input.retirementContributionAnnualMinor >= input.retirementTargetAnnualMinor && input.retirementTargetAnnualMinor > 0,
      detail: "Annual contributions meet the target you set. This is not a projection of investment returns.",
    },
  };
  return input.order.map((item) => facts[item.id] ?? { id: item.id, label: item.label, complete: false, detail: "Custom milestone — mark it when you decide it is done." });
}

export function emergencyGap(essentialMonthlyMinor: number, months: number, currentMinor: number): {
  targetMinor: number;
  gapMinor: number;
  formula: string;
} {
  const target = essentialMonthlyMinor * months;
  return {
    targetMinor: target,
    gapMinor: Math.max(0, target - currentMinor),
    formula: "Target = essential monthly spending × months of coverage. Current funds are the emergency envelopes only, so the same dollars are not also counted as spendable cash.",
  };
}

export function accountRunningBalance(account: Account, txns: Transaction[], asOf: string): { id: string; date: string; signedMinor: number; displayMinor: number }[] {
  const rows = txns
    .filter((txn) => !txn.deleted && txn.date <= asOf && txn.bankStatus !== "pending")
    .filter((txn) => txn.accountId === account.id || txn.counterAccountId === account.id)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
  let signed = 0;
  return rows.map((txn) => {
    const leg = txn.accountId === account.id ? txn.amountMinor : -txn.amountMinor;
    signed += leg;
    const display = isLiability(account) ? -signed : signed;
    return { id: txn.id, date: txn.date, signedMinor: leg, displayMinor: display };
  });
}
