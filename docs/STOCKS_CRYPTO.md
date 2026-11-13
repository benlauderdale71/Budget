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

BudgetCents is the sign-in authority for this section. A valid Budget browser
session mints a Secure, HttpOnly, SameSite cookie restricted to `/stocks-crypto`.
Every market request checks the original session for expiration, revocation and
account deletion. Long-lived API tokens cannot mint a browser market session.
The proxy sends a 30-second Ed25519 assertion bound to the exact request method
and path. It never sends a Budget password, cookie or bearer token upstream.
The private signing key stays in Budget's runtime; Market has only the public key.
Responses are not cached, upstream cookies are discarded, and cross-origin
mutations are refused. The original Market Pulse browser address redirects to
the same Budget sign-in. Existing Basic credentials remain for legacy operator
and test clients, and do not bypass the Budget subpage's session checks.
Budget's service worker excludes the entire section so it cannot overwrite the
Budget offline shell with a market page, login response or market API result.

The existing market database, collectors, learning records and paper ledger stay
on their current service. Each verified Budget user receives a distinct server
paper account; supplying another account identifier does not change ownership.
Browser watchlists, holdings and preferences are scoped to that verified user
before the app's stores initialize. Lists remain local to the browser and are
not synced between devices. Existing unassigned browser values and shared test
paper accounts are retained without automatically assigning them to a new login.
No household-ledger transaction synchronization is performed by this integration.

Validation covers canonical redirects, all proxy path types, query preservation,
credential isolation, shared session creation and revocation, streamed requests
and responses, redirect rewriting, upstream outages and service-worker exclusions.
The Market build also checks signatures, request binding, browser storage
isolation and paper-account ownership. Runtime keys must be configured before
publishing the Budget sign-in bridge. Deploy the Market verifier before Budget.
