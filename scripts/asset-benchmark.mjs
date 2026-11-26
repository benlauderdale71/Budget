import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function summarizeBenchmark(cases) {
  const categories = new Map();
  for (const { category, expected, observed = [] } of cases) {
    if (typeof category !== "string" || !Array.isArray(expected) || !Array.isArray(observed)) {
      throw new Error("Each case needs a category, expected items, and observed items.");
    }
    const seen = new Map(observed.map(item=>[item.itemKey,item]));
    if (seen.size !== observed.length || new Set(expected.map(item=>item.itemKey)).size !== expected.length) {
      throw new Error("An item key can be used only once per expected or observed list.");
    }
    const row = categories.get(category) ?? { expected:0, observed:0, exact:0, knownSale:0, estimated:0, absoluteError:0 };
    row.expected += expected.length;
    row.observed += observed.length;
    for (const item of expected) {
      const prediction = seen.get(item.itemKey);
      const identified = typeof item.identity === "string" && item.identity.length > 0 && item.identity === prediction?.identity;
      if (identified) row.exact++;
      if (!Number.isSafeInteger(item.saleMinor) || item.saleMinor <= 0 || !item.currency) continue;
      row.knownSale++;
      if (!identified || prediction.currency !== item.currency || !Number.isSafeInteger(prediction.estimateMinor) || prediction.estimateMinor <= 0) continue;
      row.estimated++;
      // Normalize each error to its own sale price before aggregating across currencies.
      row.absoluteError += Math.abs(prediction.estimateMinor-item.saleMinor)/item.saleMinor;
    }
    categories.set(category,row);
  }
  const ratio = (numerator,denominator)=>denominator ? numerator/denominator : null;
  return Object.fromEntries([...categories].map(([category,row])=>[category,{
    expectedItems:row.expected, proposedItems:row.observed, exactMatches:row.exact,
    exactPrecision:ratio(row.exact,row.observed), exactRecall:ratio(row.exact,row.expected),
    knownSales:row.knownSale, estimatedKnownSales:row.estimated, valuationCoverage:ratio(row.estimated,row.knownSale),
    meanAbsolutePercentageError:ratio(row.absoluteError,row.estimated),
  }]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file=process.argv[2];
  if(!file) throw new Error("Provide a benchmark JSON file.");
  console.log(JSON.stringify(summarizeBenchmark(JSON.parse(await readFile(file,"utf8"))),null,2));
}
