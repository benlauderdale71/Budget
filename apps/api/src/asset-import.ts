import { isIsoDate, parseCsv, multiplyDecimalByMinor, minorFactor } from "@budgetcents/domain";
import { readBillDocument } from "./bill-document-reader.js";

export const ASSET_CATEGORIES = ["Vehicles", "Real estate", "Electronics", "Furniture", "Appliances", "Tools & equipment", "Jewelry & watches", "Collectibles & art", "Sports & outdoors", "Other"];
export function assetCategory(name: string): string {
  for (const [pattern, category] of [
    [/\b(car|truck|suv|ford|chevrolet|toyota|honda|motorcycle|trailer|boat|vehicle|expedition)\b/i, "Vehicles"],
    [/\b(house|property|land|condo|real estate)\b/i, "Real estate"],
    [/\b(laptop|computer|phone|ipad|tablet|camera|television|tv|console|monitor|macbook)\b/i, "Electronics"],
    [/\b(sofa|couch|table|chair|desk|bed|dresser|furniture)\b/i, "Furniture"],
    [/\b(washer|dryer|refrigerator|freezer|oven|dishwasher|appliance)\b/i, "Appliances"],
    [/\b(drill|saw|mower|tractor|compressor|tool|generator|equipment)\b/i, "Tools & equipment"],
    [/\b(ring|necklace|bracelet|watch|jewelry|diamond)\b/i, "Jewelry & watches"],
    [/\b(coin|painting|art|antique|collectible|trading card)\b/i, "Collectibles & art"],
    [/\b(bicycle|bike|kayak|tent|golf|sport|fishing)\b/i, "Sports & outdoors"],
  ] as const) if (pattern.test(name)) return category;
  return "Other";
}
export interface AssetCandidate {
  key: string; name: string; category: string; location: string; brand: string; model: string;
  serialNumber: string; condition: string; quantity: number; notes: string; purchaseDate: string;
  purchaseMinor: number | null; estimateMinor: number | null; sourceName: string; sourceUrl: string;
  asOf: string; sourceType: string; tags: string[]; issues: string[]; sourceCells: { column: string; value: string }[];
}
const aliases: Record<string, string> = {
  name: "name", asset: "name", assetname: "name", item: "name", itemname: "name", description: "name", product: "name",
  category: "category", type: "category", location: "location", room: "location", storedat: "location",
  brand: "brand", manufacturer: "brand", make: "brand", model: "model", modelnumber: "model",
  serial: "serialNumber", serialnumber: "serialNumber", vin: "serialNumber", condition: "condition",
  quantity: "quantity", qty: "quantity", count: "quantity", notes: "notes", tags: "tags",
  purchasedate: "purchaseDate", purchased: "purchaseDate", purchaseprice: "purchase", cost: "purchase", purchasecost: "purchase",
  value: "estimate", estimatedvalue: "estimate", estimate: "estimate", currentvalue: "estimate", unitvalue: "estimate", price: "estimate",
  source: "sourceName", sourcename: "sourceName", sourceurl: "sourceUrl", url: "sourceUrl", link: "sourceUrl",
  asof: "asOf", valuationdate: "asOf", estimatedate: "asOf", sourcetype: "sourceType", currency: "currency",
};
export const assetHeader = (s: string) => aliases[s.toLowerCase().replace(/[^a-z]/g, "")];
const field=assetHeader;
const clean = (s: unknown) => s == null ? "" : String(s).trim();

export function assetRows(rows: string[][], currency: string, prefix = "0"): AssetCandidate[] {
  const headerIndex = rows.findIndex(row => row.some(cell => field(cell) === "name"));
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex], fields = headers.map(field);
  return rows.slice(headerIndex + 1).flatMap((cells, index) => {
    if (!cells.some(cell => clean(cell))) return [];
    const data: Record<string, string> = {};
    cells.forEach((value, i) => { if (fields[i]) data[fields[i]] = clean(value); });
    if (/^(grand\s+)?totals?$/i.test(data.name || "")) return [];
    const issues: string[] = [];
    if (!data.name) issues.push("Enter an asset name.");
    const amount = (value: string, label: string): number | null => {
      if (!value) return null;
      if(data.currency && data.currency.toUpperCase()!==currency) {issues.push(`The ${label} uses ${data.currency}; enter a reviewed ${currency} amount. No currency conversion was applied.`);return null;}
      try { const minor = multiplyDecimalByMinor(value.replace(/[$£€,]/g, "").trim(), minorFactor(currency)); if (minor < 0 || minor > 999999999999) throw new Error(); return minor; }
      catch { issues.push(`Check ${label}: ${value}`); return null; }
    };
    const quantity = data.quantity ? Number(data.quantity) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) issues.push("Check the quantity (1–10,000).");
    for (const key of ["purchaseDate", "asOf"]) if (data[key] && !isIsoDate(data[key])) { issues.push(`Check ${key}: ${data[key]}. Use YYYY-MM-DD.`); data[key] = ""; }
    const condition = ["new", "excellent", "good", "fair", "poor", "unknown"].includes(data.condition?.toLowerCase()) ? data.condition.toLowerCase() : "unknown";
    if (data.condition && condition === "unknown") issues.push(`Check condition: ${data.condition}`);
    return [{ key: `${prefix}:${index}`, name: (data.name || "").slice(0,160), category: (data.category || assetCategory([data.name, data.brand, data.model].join(" "))).slice(0,80),
      location: (data.location || "").slice(0,120), brand: (data.brand || "").slice(0,100), model: (data.model || "").slice(0,100),
      serialNumber: (data.serialNumber || "").slice(0,160), condition, quantity: Number.isInteger(quantity) && quantity > 0 && quantity <= 10000 ? quantity : 1,
      purchaseDate: data.purchaseDate || "", purchaseMinor: amount(data.purchase, "purchase price"), estimateMinor: amount(data.estimate, "estimated unit value"),
      sourceName: (data.sourceName || "Imported value — review source").slice(0,200), sourceUrl: (data.sourceUrl || "").slice(0,2000), asOf: data.asOf || "",
      sourceType: ["manual", "sold_comparable", "asking_price", "appraisal", "replacement_cost"].includes(data.sourceType) ? data.sourceType : "manual",
      notes: (data.notes || "").slice(0,4000), tags: (data.tags || "").split(/[,;|]/).map(s => s.trim()).filter(Boolean).slice(0,20), issues,
      sourceCells: headers.map((column, i) => ({ column, value: cells[i] || "" })),
    }];
  });
}

export async function readAssetFile(bytes: Buffer, filename: string, currency: string) {
  if (!bytes.length || bytes.length > 8_000_000) throw new Error("Choose a file no larger than 8 MB.");
  const ext = filename.toLowerCase().split(".").pop();
  let grids: {name:string;rows:string[][]}[], text = "", warnings: string[] = [];
  if (["json", "txt", "tsv"].includes(ext || "")) {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 600000) throw new Error("Use a file with at most 600,000 characters.");
    if (ext === "json") {
      const parsed = JSON.parse(text), records = Array.isArray(parsed) ? parsed : parsed.assets;
      if (!Array.isArray(records) || records.some(r => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("Use a JSON array of asset objects or an object containing an assets array.");
      const headers = [...new Set(records.flatMap(r => Object.keys(r)))];
      grids = [{ name: "JSON", rows: [headers, ...records.map(record => headers.map(key => clean(Array.isArray(record[key]) ? record[key].join(", ") : record[key])))] }];
    } else if (ext === "tsv" || text.split(/\r?\n/)[0].includes("\t")) grids = [{name:"Text",rows:text.split(/\r?\n/).map(line=>line.split("\t"))}];
    else if (text.split(/\r?\n/)[0].includes(",")) grids = [{name:"Text",rows:parseCsv(text)}];
    else grids = [{name:"Text",rows:[["Name"],...text.split(/\r?\n/).filter(s=>s.trim()).map(s=>[s.replace(/^[-*•]\s*/, "")])]}];
  } else {
    const read = await readBillDocument(bytes, filename, assetHeader);
    grids = read.grids; text = read.text; warnings = read.warnings;
  }
  if (grids.reduce((n,g)=>n+g.rows.length,0)>1100 || grids.some(g=>g.rows.some(r=>r.length>60||r.some(c=>c.length>4000)))) throw new Error("Use at most 1,000 rows, 60 columns, and 4,000 characters per cell.");
  if (text.length > 600000) throw new Error("The document is too large to preview. Split it into smaller files.");
  const rows = grids.flatMap((grid, i) => {
    let found = assetRows(grid.rows, currency, String(i));
    // Text PDFs often have unruled columns. Preserve their spacing for inventory tables.
    if (!found.length && grid.rows.some(row=>row.length===1)) found = assetRows(grid.rows.map(row=>row.join(" ").split(/\t|\s{2,}/)), currency, String(i));
    if (!found.length) warnings.push(`${grid.name}: no inventory columns were recognized. Review the extracted text and add any missing items.`);
    return found;
  });
  if (!rows.length) {
    const fallback = assetRows([["Name","Notes"],[filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g," "),text.slice(0,4000)]],currency);
    rows.push(...fallback.map(row=>({...row,issues:["Name this asset and check its category. A photo alone does not reliably identify its model or value."]})));
    warnings.push("An editable draft was created from the filename. The original file is kept; text recognition does not identify objects in a photograph.");
  }
  if (rows.length > 500) throw new Error("Import up to 500 assets at a time.");
  return { rows, text, warnings: [...new Set([...warnings,"Amounts are per item, in your household currency. Review every selected row before saving."])], filename };
}
