# Deployment

BudgetCents is a Node 22 API (`apps/api`) and a static web app (`apps/web`). They share one database and one set of calculation rules in `packages/domain`.

## Local

```bash
npm install
npm test
npm run build
npm start
```

`npm start` runs the API with `tsx` from `apps/api/src/server.ts`. npm runs that script with `apps/api` as the working directory. The web build is still resolved from the repository root as `apps/web/dist`. Set `BUDGETCENTS_WEB` to an absolute path or a path relative to the repository root, such as `./apps/web/dist`. A request that escapes that directory is rejected. If the build is missing, the process answers that the API is up.

Environment variables are listed in `.env.example`. Placeholders only. Do not commit `.env`.

## budgethqpro.com production hosting

The web interface and API share one origin at `https://budgethqpro.com`.
Cloudflare manages DNS and Railway runs the Node service and PostgreSQL.
The production environment is the dedicated Railway project `BudgetHQPro`;
other projects are not used for this deployment.

`Dockerfile` builds both workspaces with Node 22 and installs Tesseract, the
English language pack, and Poppler in the runtime image. The entrypoint prepares
the mounted upload directory and runs the application as the unprivileged
`node` user. Railway's service settings select this Dockerfile and `/api/health`
as the healthcheck, with a 180-second timeout and five retries on failure.
The image refuses to start without `DATABASE_URL`. No deprecated Railway
Config-as-Code file is required.

Configure the web service with:

- `DATABASE_URL=${{Postgres.DATABASE_URL}}` using Railway's private-network reference.
- A persistent volume mounted at `/data`; receipts use `/data/uploads`.
- `NODE_ENV=production`, `HOST=0.0.0.0`, and `PORT=8080`.
- `BUDGETCENTS_PUBLIC_URL=https://budgethqpro.com`.
- `DEMO_LOGIN=false`, `SEED_DEMO=false`, and `ALLOW_DEV_MAILSINK=false`.
- A server-only `BUDGETCENTS_PROVIDER_KEY` generated as 32 random bytes in hex.

The deployment is pinned to a tested source commit. Pushing unrelated changes
to the development branch does not automatically replace the live app. Change
the pinned source only after checking a new release. PR #1 remains the source
review; deploying a commit does not merge that pull request.

Create custom domains on the Railway web service before adding the DNS records
it returns in Cloudflare. Both the apex and `www` route to the same app. Use a
valid origin certificate and HTTPS; never use Cloudflare's Flexible TLS mode.
Keep API responses, receipts, backups, and exports out of shared CDN caches.

Both custom domains use Cloudflare's proxy, Full (strict) origin TLS, an HTTP to
HTTPS redirect, and TLS 1.2 or newer. `/api/health` exposes boolean capabilities
for sample login, development mail, SMTP configuration, and federated sign-in;
the browser hides unavailable optional login controls. These flags do not
contain credentials or demonstrate mail delivery. Production keeps
`BUDGETCENTS_MAIL_ENABLED=false` and `BUDGETCENTS_PUSH_ENABLED=false` until their
providers are configured. Automatic envelope polling remains off by default.

The initial live API smoke test used only a disposable fictional household.
Registration and a $100 opening balance succeeded. A $4.25 expense left cash
and net worth at $95.75, Ready to Assign at $100, spending at $4.25, and the
budget identity difference at zero. Replaying the operation returned the same
transaction. A receipt uploaded to the mounted directory and Tesseract 5.3.0
read a $6.48 draft without changing that ledger. Demo login and development
outbox endpoints returned 404, and an unauthenticated profile returned 401.

The production database starts empty. Development households and local files
are not copied. Register a new household on the public site. Email verification,
password-reset delivery, and emailed invitations require the SMTP settings
below; the development outbox remains inaccessible in production. SimpleFIN
also requires the person's own setup token and consent, and does not establish
AmFirst coverage. No market, mail, or push credential is supplied by this image.

Back up the PostgreSQL and receipt volumes together before updates. The
provider encryption key must be retained with those backups. A persistent
volume is not itself a backup or a tested restore. Do not restore a previous
database over a live household merely to roll back the application image.

## HTTPS

Put the process behind a reverse proxy that terminates TLS. Redirect HTTP to HTTPS. The Android manifest allows cleartext so a developer can point an emulator at `http://10.0.2.2:8787`. A phone build aimed at real people should use an `https://` server URL. The app stores that URL on the device.

## Database

- Default: PGlite files in `BUDGETCENTS_DATA` (default `./data/budgetcents`). The schema in `apps/api/src/schema.sql` is applied on startup. Statements use `IF NOT EXISTS`, so starting again does not wipe data.
- Production: set `DATABASE_URL` to PostgreSQL. The same schema is applied on startup. Take a database backup before each deploy. To roll back the app, deploy the previous build and restore the backup if a migration was destructive. This schema has no separate migration history yet, so treat a production change to `schema.sql` as something you review before it runs.

## Files

Receipts are written under `BUDGETCENTS_UPLOADS`. Back that directory up with the database. It is not object storage. Reading a receipt needs `tesseract-ocr`, `tesseract-ocr-eng`, and `poppler-utils` on the API host. Setup, limits, and the health fields are in `docs/RECEIPTS.md`.

## Mail

New reset, verification and invitation messages queue with `BUDGETCENTS_MAIL_ENABLED=true` plus either `RESEND_API_KEY` and `RESEND_FROM` (recommended on Railway), or `SMTP_URL` and `SMTP_FROM`. Resend uses HTTPS and does not require Railway's Pro-only outbound SMTP support. Configure the public HTTPS `BUDGETCENTS_PUBLIC_URL` before enabling delivery. Otherwise messages remain local. Old local copies are never automatically sent. Provider acceptance is not inbox-delivery evidence. In development, `GET /api/dev/outbox?email=` reads the local mailbox; the route is absent in production. See [provider setup](PROVIDERS.md) for domain verification, keys, TLS, workers, consent and Firebase configuration.

Node does not load `.env` automatically. Export the values in the host environment, or run `node --env-file=.env --import tsx apps/api/src/server.ts` from the repository root. Supabase can host PostgreSQL, but keep the BudgetCents tables inaccessible to its public Data API. The existing custom authentication is not replaced by setting a database URL.

## Scheduled fills

Envelope fills are assignment changes, not bank transactions. Schedules and occurrence rows live in the database. Each occurrence key is unique per household, so a retry, a second worker, or another Run now does not apply it twice. The household row is locked for the duration of a fill and for manual assignment, move, and auto-assign, so those cannot spend the same Ready to Assign at the same time.

Dates use the household time zone's calendar day. Weekly and custom schedules add a fixed number of days. Monthly, annual, and every-two/three/six-month schedules keep the start day's number and use the last day of a short month, including February 29 in a leap year. The arithmetic is on calendar dates, so a daylight-saving change does not move the day.

Missed dates are recorded as Skipped and allocate nothing. A restart does not apply a backlog. At most the occurrence dated today is applied. If a schedule is more than 36 dates behind, it is paused after those skips. Pause and resume do not move money. Resume skips dates that already passed.

Development runs a fill when someone uses Run now. An owner or admin can also call `POST /api/households/:id/fills/due`. That route accepts `today=YYYY-MM-DD` for a controlled check. Saving or editing a template does not call it.

Automatic scheduling is off unless `BUDGETCENTS_FILL_POLL_MS` is an integer of at least 1000. The process then polls on that interval. `GET /api/health` reports `fills.mode` as `disabled`, `poll`, or `unhealthy`, with `healthy` and the last run. The plan page repeats that note. Unset, empty, or `0` is disabled and healthy: Run now and the due route still work. A value below 1000 is unhealthy and the poll does not start. A poll that throws is unhealthy until a later poll succeeds. Leave the variable unset when an external scheduler calls the due route instead. Two workers are safe because the occurrence key is unique and the household row is locked for the apply. The embedded database used in development runs one transaction at a time; the uniqueness check in tests is sequential. Postgres holds the row lock across the transaction.

The poll is off by default so tests and a normal `npm start` do not move money in the background. A fill still does not change an account balance, net worth, income, spending, or the bank-transaction count. It only assigns cash that is already in the budget.

## Demo

`DEMO_LOGIN` defaults to on when `NODE_ENV` is not `production`. Set `DEMO_LOGIN=false` and `SEED_DEMO=false` for a deployment that should not offer the sample household.

## Rollback

Keep the previous Node build and a database snapshot. Stop the process, restore the snapshot if the new process migrated in a way you do not want, and start the previous build. There is no blue-green orchestration in this repo.
