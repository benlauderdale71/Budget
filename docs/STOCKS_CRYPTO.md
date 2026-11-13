# Stocks & Crypto on BudgetHQPro

The desktop Insight menu and mobile More page open the complete Market Pulse app
at `https://budgethqpro.com/stocks-crypto/`. Navigation loads a separate document,
so the original Market Pulse layout, styling and interactions occupy the full
viewport. There is no Budget shell or iframe around the research app.

The Budget server proxies this section to the existing Market Pulse service.
Frontend and asset paths keep their prefix; `/stocks-crypto/api/*` maps to the
existing upstream `/api/*`. Budget's `/api/*` stays on the household ledger.
The stock app's original root build remains available. Both builds use identical
page and style sources; the second build changes only its route and API base.

The existing Market Pulse Basic login remains in force. The proxy does not send
Budget cookies or bearer credentials to the market backend. Responses are not
cached, upstream cookies are discarded, and cross-origin mutations are refused.
Budget's service worker excludes the entire section so it cannot overwrite the
Budget offline shell with a market page, login response or market API result.

The existing market database, collectors, learning records and paper ledger stay
on their current service. Browser-only watchlists, holdings and preferences are
specific to each website origin. Values saved under the old Railway address are
not automatically transferred into budgethqpro.com. No browser data migration
or household-ledger synchronization is performed by this integration.

Validation covers canonical redirects, all proxy path types, query preservation,
credential isolation, the Basic challenge, streamed requests and responses,
redirect rewriting, upstream outages and service-worker exclusions. Deployment
must include the Market Pulse nested build before the Budget menu is published.
