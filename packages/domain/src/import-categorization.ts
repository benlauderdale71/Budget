import { spendingMerchantName } from "./merchant-names.js";
import type { Bucket, Transaction } from "./types.js";

type Candidate = Pick<Transaction, "accountId" | "amountMinor" | "type" | "payee" | "originalDescription">;
type Kind = "income" | "expense";
export type CategoryEstimate = { bucketId: string; basis: "account history" | "bank category" | "merchant" | "fallback" };

const words = (value: string) => value.normalize("NFKC").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const classifications = [
  { names: ["fuel", "gas", "gas fuel", "gasoline", "auto fuel"], labels: /^(?:gasoline|fuel|auto fuel|gas stations?)$/, merchant: /\b(?:fuel|pay at (?:the )?pump)\b|^shell oil\b/ },
  { names: ["groceries", "grocery", "grocery stores", "food groceries"], labels: /^(?:groceries|grocery stores?|supermarkets?)$/, merchant: /^(?:aldi|publix|kroger|foodland|piggly wiggly|whole foods|trader joes|food lion)\b/ },
  { names: ["dining out", "restaurants", "dining", "eating out", "fast food", "restaurants dining", "food dining"], labels: /^(?:restaurants?|dining(?: out)?|fast food|food dining)$/, merchant: /^(?:mcdonalds|burger king|taco bell|jacks|chick fil a|wendys|arbys|subway|doordash|uber eats|grubhub|starbucks)\b/ },
  { names: ["pharmacy", "medical", "healthcare", "health care"], labels: /^(?:pharmacy|drug stores?|medical|health care)$/, merchant: /\b(?:pharmacy|pharmacies|urgent care)\b/ },
  { names: ["home improvement", "home maintenance", "home repairs"], labels: /^(?:home improvement|home maintenance|hardware stores?)$/, merchant: /^(?:home depot|lowes|ace hardware)\b/ },
  { names: ["utilities", "electricity", "electric", "power"], labels: /^(?:electricity|electric|power|utilities)$/, merchant: /^(?:alabama power|tennessee valley electric)\b/ },
  { names: ["subscriptions", "streaming", "entertainment"], labels: /^(?:subscriptions|streaming)$/, merchant: /^(?:netflix|hulu|spotify|disney plus|peacock)\b/ },
  { names: ["bank fees", "fees", "bank charges"], labels: /^(?:fees|bank fees|service charges?)$/, merchant: /^(?:overdraft fee|monthly service fee|atm fee|non sufficient funds fee)\b/ },
  { names: ["paycheck", "paychecks", "salary", "wages", "employment income"], labels: /^(?:salary|wages|payroll|paychecks?)$/, merchant: /\b(?:payroll|salary)\b/ },
];

function kindOf(txn: Candidate): Kind | undefined {
  if (txn.type === "income" && txn.amountMinor > 0) return "income";
  if (["expense", "fee"].includes(txn.type) && txn.amountMinor < 0) return "expense";
}

export function canEstimateImportedCategory(txn: Transaction): boolean {
  const kind = kindOf(txn);
  return !!kind && !!(txn.importBatchId || txn.providerTransactionId) && txn.reviewStatus === "needs_review"
    && txn.bankStatus === "posted" && !txn.deleted && !txn.categoryLockedByUser && !txn.counterAccountId
    && !txn.excludeFromReports && !txn.locked && !txn.reconciled
    && (!txn.splits.length || (txn.splits.length === 1 && !txn.splits[0].bucketId
      && txn.splits[0].role === kind && txn.splits[0].amountMinor === Math.abs(txn.amountMinor)));
}

function merchantKeys(txn: Candidate) {
  const raw = [txn.payee, txn.originalDescription ?? ""]
    .map(value => words(value).replace(/^(?:(?:pos|debit card|checkcard|check card|card purchase|purchase|point of sale)\s+)+/, "")
      .replace(/\s+(?:store\s+)?\d{3,}(?:\s.*)?$/, ""));
  const brands = [txn.payee, txn.originalDescription ?? ""].map(value => words(spendingMerchantName(value)));
  const keys = [...new Set([...raw, ...brands])].filter(key => /[a-z]{3}/.test(key)
    && !/^(?:unknown merchant|unknown|imported|check(?: \d+)?|withdrawal|deposit|transfer|ach|debit|credit|payment)$/.test(key));
  const isFuel = keys.some(key => /\b(?:gas|fuel|pay at (?:the )?pump)\b/.test(key));
  // Keep fuel purchases at warehouse clubs distinct from their regular store purchases.
  return keys.map(key => isFuel ? `fuel:${key}` : key);
}

export function importedCategoryEstimator(buckets: Bucket[], transactions: Transaction[]) {
  const active = buckets.filter(bucket => !bucket.archived && !bucket.hidden && !bucket.systemRole);
  const byId = new Map(active.map(bucket => [bucket.id, bucket]));
  const history = new Map<string, Map<string, number>>();
  const keyFor = (txn: Candidate, key: string) => JSON.stringify([txn.accountId, kindOf(txn), key]);
  for (const txn of transactions) {
    const kind = kindOf(txn);
    if (!kind || txn.bankStatus !== "posted" || txn.deleted || txn.excludeFromReports || txn.counterAccountId
      || !(txn.reviewStatus === "reviewed" || txn.categoryLockedByUser) || txn.splits.length !== 1) continue;
    const bucketId = txn.splits[0].bucketId;
    if (!bucketId || byId.get(bucketId)?.kind !== kind || txn.splits[0].role !== kind) continue;
    for (const merchant of merchantKeys(txn)) {
      const key = keyFor(txn, merchant);
      const votes = history.get(key) ?? new Map<string, number>();
      votes.set(bucketId, (votes.get(bucketId) ?? 0) + 1);
      history.set(key, votes);
    }
  }

  return (txn: Candidate, bankCategory?: string, fallback?: Partial<Record<Kind, string>>): CategoryEstimate | undefined => {
    const kind = kindOf(txn);
    if (!kind) return;
    const merchants = merchantKeys(txn);
    const choices = active.filter(bucket => bucket.kind === kind);
    const choose = (names: string[]) => names.map(name => choices.filter(bucket => words(bucket.name) === name)).find(matches => matches.length === 1)?.[0]?.id;
    const label = words(bankCategory ?? "");
    const descriptors = [txn.payee, txn.originalDescription ?? ""].map(words);
    const ambiguousMovement = /\b(?:transfer|xfer|credit card payment|card payment|online payment|payment thank you|zelle|venmo|cash app|atm withdrawal|refund|reversal|chargeback)\b/;
    const allowMerchantGuess = ![label, ...descriptors].some(text => ambiguousMovement.test(text));
    if (allowMerchantGuess) {
      const votes = merchants.map(key => history.get(keyFor(txn, key))).filter(votes => votes !== undefined);
      const winners = votes.flatMap(counts => {
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const winner = [...counts].find(([, count]) => count * 2 > total);
        return winner ? [winner[0]] : [];
      });
      if (votes.length && winners.length === votes.length && new Set(winners).size === 1) {
        return { bucketId: winners[0], basis: "account history" };
      }
      if (label) {
        const bucketId = choose([label]) ?? choose(classifications.find(entry => entry.labels.test(label))?.names ?? []);
        if (bucketId) return { bucketId, basis: "bank category" };
      }
      const match = classifications.find(entry => merchants.some(merchant => entry.merchant.test(merchant.replace(/^fuel:/, ""))));
      const bucketId = choose(match?.names ?? []);
      if (bucketId) return { bucketId, basis: "merchant" };
    }
    if (!allowMerchantGuess) return;
    const bucketId = fallback?.[kind];
    if (bucketId && byId.get(bucketId)?.kind === kind) return { bucketId, basis: "fallback" };
  };
}
