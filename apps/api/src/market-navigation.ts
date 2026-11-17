/** A normal document link also works inside the installed budget app. */
const RETURN_NAV = '<nav id="budgethq-return-nav" aria-label="Budget navigation"><a href="/" target="_self"><span aria-hidden="true">←</span> Back to Budget HQ PRO</a><span class="budgethq-market-label">Stocks &amp; Crypto</span></nav>';

export function needsMarketDocument(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (/^\/stocks-crypto\/(?:api|assets)(?:\/|$)/.test(new URL(request.url).pathname)) return false;
  const destination = request.headers.get("sec-fetch-dest");
  return destination === "document" || request.headers.get("sec-fetch-mode") === "navigate"
    || (!destination && (request.headers.get("accept") ?? "").includes("text/html"));
}

export function addBudgetNavigation(html: string): string {
  // Leave non-document HTML alone. The navigation sits outside Market Pulse's
  // React root, so its client-side route changes cannot remove the return link.
  if (!/<\/head\s*>/i.test(html) || !/<body(?:\s[^>]*)?>/i.test(html) || html.includes('id="budgethq-return-nav"')) return html;
  return html.replace(/<\/head\s*>/i, '<link rel="stylesheet" href="/market-budget-nav.css"></head>')
    .replace(/<body(?:\s[^>]*)?>/i, (body) => `${body}${RETURN_NAV}`);
}

export function marketUnavailable(request: Request, status: number, message: string): Response {
  const headers = new Headers({ "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  if (!needsMarketDocument(request)) return new Response(request.method === "HEAD" ? null : message, { status, headers });
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const escaped = message.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const html = addBudgetNavigation(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stocks &amp; Crypto | Budget HQ PRO</title></head><body><main class="budgethq-market-status"><h1>Stocks &amp; Crypto</h1><p>${escaped}</p></main></body></html>`);
  return new Response(request.method === "HEAD" ? null : html, { status, headers });
}
