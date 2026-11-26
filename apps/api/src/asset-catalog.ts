import catalog from "../../../packages/domain/catalogs/resale-catalogs.json" with { type: "json" };
import { ApiError } from "./finance.js";

export async function readAssetCatalog(sourceId: string, term: string, request = fetch) {
  const source = catalog.sources.find(item => item.id === sourceId);
  if (!source || term.length < 2 || term.length > 120) throw new ApiError(400, "Choose a catalog and enter a search description.");
  const shopify = source.kind === "shopify";
  const address = new URL(shopify ? catalog.storefrontPath : "/wp-json/wc/store/v1/products", "https://" + source.host);
  if (!shopify) address.search = new URLSearchParams({search: term, per_page:"18", stock_status:"instock", _fields:"name,permalink,is_in_stock,prices"}).toString();
  try {
    const response = await request(address, {
      method: shopify ? "POST" : "GET", redirect:"error", signal: AbortSignal.timeout(8500),
      headers: shopify ? { "Content-Type":"application/json", Accept:"application/json" } : { Accept:"application/json" },
      body: shopify ? JSON.stringify({query:catalog.query, variables:{term}}) : undefined,
    });
    if (!response.ok) throw new Error("Unavailable");
    const data = await response.json();
    if (shopify ? !Array.isArray(data?.data?.search?.nodes) : !Array.isArray(data)) throw new Error("Unexpected catalog response");
    return data;
  } catch {
    throw new ApiError(503, "This resale catalog is temporarily unavailable.");
  }
}
