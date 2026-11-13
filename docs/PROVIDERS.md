# Providers and personal-use setup

SimpleFIN, Finnhub, Resend HTTPS, SMTP, and Android Firebase Cloud Messaging clients are implemented. Configuration is separate from delivery verification. `GET /api/providers` reports configuration; it does not certify bank coverage or delivery. Calculations remain in BudgetCents. No bank password is collected by BudgetCents.

For a primarily personal U.S. installation, start with SimpleFIN for supported bank history, Finnhub for eligible personal stock/ETF quotes, Resend HTTPS for mail, and FCM for Android push. Supabase can supply PostgreSQL hosting; it does not supply bank aggregation or market prices.

| Service | Published entry price checked November 12, 2026 | Limits |
|---|---|---|
| [SimpleFIN Bridge](https://beta-bridge.simplefin.org/) | $15/year plus tax, or $1.50/month | Check the bank selector first. **America’s First Federal Credit Union (AmFirst, amfirst.org) coverage is unverified.** This is not America First Credit Union in Utah. |
| [Finnhub](https://finnhub.io/pricing) | Free personal plan where eligible | U.S. instrument coverage and personal-use terms apply. No public redistribution or fund look-through rights are implied. |
| [Resend](https://resend.com/pricing) | Free: 3,000 emails/month, 100/day | Verify a sending domain. Domain registration and hosting are separate costs. |
| [Firebase Cloud Messaging](https://firebase.google.com/pricing) | No messaging charge | Firebase project, messaging permission, Android configuration and device consent. Other Firebase products can cost money. |
| [Supabase](https://supabase.com/pricing) | Free development tier; paid hosting optional | An account is not a BudgetCents deployment. No unrelated project was changed. The Node API and receipt files also need hosting. |

These are provider prices, not an all-in hosting estimate. Use manual/CSV entry if AmFirst is unsupported. SMS, credit-bureau feeds, property/vehicle estimates and professional-service providers can wait for a personal installation.

## SimpleFIN

Set `BUDGETCENTS_PROVIDER_KEY` to 32 random bytes encoded as 64 hex characters on the API server. Back it up securely with the database. Replacing it without re-encryption makes existing connections unreadable.

Check AmFirst in SimpleFIN's selector before subscribing. Obtain a one-time setup token, then enter it in Connections and explicitly grant read consent. The encrypted access credential is bound to that user, household and connection and never returned to a client. Only documented SimpleFIN HTTPS hosts are allowed; redirects are refused.

Preview posted history, map its account to a ledger account of the same currency, review types and explicitly confirm the selected rows. Web imports a batch; Android imports one selected USD row at a time. Previews expire after 15 minutes; fetched responses are cached for one hour. The feed requests up to 90 days of posted history. Pending rows are excluded. Bank balances never replace the ledger opening balance. Set an opening balance that excludes the history being imported. Select a counter-account for a transfer and the original purchase for a refund. Import only one transfer side.

Repeated provider account/id imports are skipped, including after reconnect by the same person in the same household. Changed imported records are refused for review. Changed provider ids, manual duplicates and another external transfer side still require human review. Missing provider history never deletes the ledger. There is no unattended sync, bill discovery or automatic reconciliation. Disconnect clears local credentials and cache; also revoke the token with SimpleFIN. Imported transactions remain.

The public SimpleFIN demo transport returned three accounts and 112 posted rows during this pass. It did not connect AmFirst or import personal data.

## Prices, lots and retirement

Set server-only `FINNHUB_API_KEY`. Investments can preview a USD stock/ETF quote and explicitly confirm its source/date. Confirmation changes investment valuation and potentially net worth; it does not post transactions or change cash/Ready to Assign. Stale/expired previews fail. Requests are rate limited across server processes. Delayed/stale dates stay visible. This is an on-request price client, not streaming or a brokerage connection.

Web and Android can add lots to existing holdings, correct basis, preview/confirm a FIFO sale and read realized-gain history. Creation uses an operation id; edits/sales require the current lot revision. Sales reduce holding shares and basis, retaining allocations. **They do not post cash proceeds:** record the matching deposit once separately. Android connected investment controls support USD; use the web for another currency. Wash-sale adjustments, specific-lot election, tax filing, historical benchmark feeds and licensed fund look-through are still absent.

The monthly retirement comparison models traditional and other funds, gross withdrawals, assumed flat tax, monthly cent remainders, prior-December balances and Uniform Lifetime required distributions. Unspent distributions remain in other funds. Both withdrawal orders are shown. It starts January 1 and supports post-2022 modeling only. Inherited accounts and the younger-spouse sole-beneficiary case are rejected because their tables are absent. The separate annual model is unchanged. Tax brackets, inflation, contribution limits and early-withdrawal penalties are not modeled here. Source: [IRS Publication 590-B](https://www.irs.gov/publications/p590b).

## Email

For Resend, verify the sending domain, create a sending-only API key restricted to that domain, and set server-only `RESEND_API_KEY`, a plain sender address in `RESEND_FROM` (for example `noreply@budgethqpro.com`), the public HTTPS `BUDGETCENTS_PUBLIC_URL`, and `BUDGETCENTS_MAIL_ENABLED=true`. The app sends through `https://api.resend.com/emails` with a stable idempotency key per message. Requests time out after 20 seconds and do not follow redirects. Keep the API key out of source control and browser builds. [Railway restricts SMTP to Pro and above](https://docs.railway.com/networking/outbound-networking); the HTTPS connection works on its lower-cost plans.

Alternatively leave `RESEND_API_KEY` empty and set `SMTP_URL` and a plain sender address in `SMTP_FROM`, with the same public URL and enable switch. Use `smtps://` for implicit TLS or `smtp://` with required STARTTLS. URL-encode credentials. Certificate validation is required; plaintext loopback is allowed only in tests. A Resend key selects HTTPS explicitly; a failed or incomplete Resend setup never silently falls back to SMTP.

New verification/reset/invitation messages queue when configured. A worker claims each row before sending. Old development-outbox rows never become a delivery backlog. Expired rows are not sent. Failed or ambiguous attempts are not automatically resent; request a fresh link after fixing configuration. Provider acceptance is recorded separately from inbox delivery. Delivery/bounce webhooks are not implemented.

Alert mail additionally requires verified account email, enrollment consent in Connections and email consent in that household's alert settings. Messages are generic links to authenticated Alerts, without account names, payees or amounts. The explicit real-test control targets only the current verified account address. Keep delivery off on development machines unless intentionally testing real mail.

## Android push and remote alerts

Enable the FCM API and authorize a service account for server messaging. Store its JSON only on the API server as `FCM_SERVICE_ACCOUNT_JSON`; set `BUDGETCENTS_PUSH_ENABLED=true`. Build Android with public `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_API_KEY`, and `FIREBASE_SENDER_ID`. Never include the private service-account JSON in an APK or repository.

Sign in on the phone, grant Android notification permission and enroll it in Connections. Opt-out/sign-out disables local display, clears local enrollment and deletes the FCM token. Remote payloads contain only a generic kind and opaque delivery-event id. The app checks sign-in and notification settings before posting a generic notification. Opening it still passes authentication/session lock and visibility checks.

When mail or push is enabled, the server checks eligible member alerts every minute. A remote copy requires in-app delivery, household channel consent, channel enrollment, a visible target, and a condition generated after enrollment. Quiet hours, snooze, read/resolved state and membership are rechecked. One remote row exists per person/condition/channel. Crashes and ambiguous failures are not automatically resent; an attempted row can remain unproven after a crash. Expired FCM tokens are removed.

`GET /api/notifications/remote-history` distinguishes queued, attempted, accepted, failed, cancelled and delivered. Provider acceptance has `provenDelivered=false`. Only an authenticated recipient's Android posting receipt supplies device evidence; it does not prove reading. SMTP inbox receipts are absent. FCM data messages can be delayed by power-saving or a force-stopped app. Web push and SMS remain unimplemented. Older message-test sinks remain explicitly simulated.

## Supabase and hosting

BudgetCents owns authentication and runs a Node API. Server-side `DATABASE_URL` can point to Supabase PostgreSQL; this does not migrate the app to Supabase Auth, Storage or Realtime. Keep these tables inaccessible to the public Data API: disable that API for a dedicated project, or use a non-exposed schema with reviewed permissions. Never expose the database password or service-role key in clients. Review migrations/backups before using a real database. Do not repurpose unrelated projects without a migration plan.

The API needs persistent receipt files, Tesseract/Poppler, HTTPS and a running process for workers. Node does not automatically read `.env`: export environment values, or run `node --env-file=.env --import tsx apps/api/src/server.ts` from the repository root. Gradle reads Firebase values from the build environment.

## Still without a client

Bill data, property/vehicle estimates, credit bureaus, automatic savings transfers, SMS/web push, concierge cancellation/negotiation, coaching appointments, tax filing, estate documents and an external language model have no production client. Their stored requests/checklists/test sinks are not delivered services. They need a product/vendor decision and implementation, not just a secret. Production identity-provider configuration, production Android signing/Play submission and a public installation also remain absent.
