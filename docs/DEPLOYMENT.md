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

## HTTPS

Put the process behind a reverse proxy that terminates TLS. Redirect HTTP to HTTPS. The Android manifest allows cleartext so a developer can point an emulator at `http://10.0.2.2:8787`. A phone build aimed at real people should use an `https://` server URL. The app stores that URL on the device.

## Database

- Default: PGlite files in `BUDGETCENTS_DATA` (default `./data/budgetcents`). The schema in `apps/api/src/schema.sql` is applied on startup. Statements use `IF NOT EXISTS`, so starting again does not wipe data.
- Production: set `DATABASE_URL` to PostgreSQL. The same schema is applied on startup. Take a database backup before each deploy. To roll back the app, deploy the previous build and restore the backup if a migration was destructive. This schema has no separate migration history yet, so treat a production change to `schema.sql` as something you review before it runs.

## Files

Receipts are written under `BUDGETCENTS_UPLOADS`. Back that directory up with the database. It is not object storage.

## Mail

Password reset and address verification are written to the `outbox` table until `SMTP_URL` is set. `ALLOW_DEV_MAILSINK=true` returns the raw token in the API response. Leave it unset or `false` on any server other people can reach.

## Demo

`DEMO_LOGIN` defaults to on when `NODE_ENV` is not `production`. Set `DEMO_LOGIN=false` and `SEED_DEMO=false` for a deployment that should not offer the sample household.

## Rollback

Keep the previous Node build and a database snapshot. Stop the process, restore the snapshot if the new process migrated in a way you do not want, and start the previous build. There is no blue-green orchestration in this repo.
