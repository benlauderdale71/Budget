# Budget HQ PRO

**[Releases · Download the Android APK](https://github.com/benlauderdale71/Budget/releases)**

Budget HQ PRO is a household finance app for the browser and Android. Categories, zero-based assignments, envelopes, and flex spending are views of one ledger. Transfers, credit-card payments, and savings allocations do not become income or a second expense.

The web app also includes a [physical asset inventory](docs/PHYSICAL_ASSETS.md): belongings, categories, locations, file import with review, private documents, and dated estimates with research links and sources.

The product was specified as LedgerOne and renamed to BudgetCents. The original prompt, coverage ledger, and source list are unchanged in [docs/source/LedgerOne_Complete_Build_Prompt.txt](docs/source/LedgerOne_Complete_Build_Prompt.txt).

The November 12 personal-use continuation adds conflict-safe income plans, SimpleFIN history previews/imports, Finnhub price confirmation, SMTP and Android FCM clients, revisioned FIFO sale history, and corrected monthly retirement accounting. Start with [provider setup and costs](docs/PROVIDERS.md) and [the current verification record](docs/CONTINUATION_2026_11_12.md). AmFirst coverage, real delivery, device checks and public deployment remain pending; this is not a claim that the entire original specification is complete.

## Run it

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:8787. Use **Open the sample household** or create an account. Sample data is fictional and lives in its own household.

`npm test` runs the money-engine tests and the API tests. `npm run build` typechecks the engine and API and builds the web app. `npm start` serves the API and, when `apps/web/dist` exists, the built site.

Without `DATABASE_URL`, BudgetCents uses an embedded Postgres-compatible database (PGlite) under `BUDGETCENTS_DATA`. Set `DATABASE_URL` to use PostgreSQL. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Receipt reading runs on the API with Tesseract and Poppler. Install `tesseract-ocr`, `tesseract-ocr-eng`, and `poppler-utils` on that host. The browser and Android upload the file and review the draft. See [docs/RECEIPTS.md](docs/RECEIPTS.md).

Inventory price research uses active resale listings, U.S. fleet auction sales, and the FHFA quarterly state house price index. Each estimate keeps its date and source. Refresh the bundled public auction and property reference data with `python3 scripts/refresh-asset-reference.py`.

## Android

The Android client is a native app in `android/`, application id `com.budgetcents.app`, target SDK 36. It packages the website’s responsive screens and uses the same account and household API. Assets opens the inventory and Markets opens Stocks & Crypto. All tools includes the Android offline dashboard and device settings. Building the APK also builds the web workspace and requires Node 22 or later. On an emulator, set the server to `http://10.0.2.2:8787`.

```bash
cd android
# ANDROID_HOME must point at an SDK with platform 36.
./gradlew assembleRelease bundleRelease
```

Production builds require the four signing variables listed in [docs/PLAY.md](docs/PLAY.md). For a side-by-side test build, run `./gradlew assembleDevRelease -PsideBySideTest=true` with the development keystore.

To publish a signed APK, add it under `downloads/android/` and merge it into `main`. GitHub verifies the signature and publishes the APK under **Assets** on the [Releases page](https://github.com/benlauderdale71/Budget/releases). Use a new Android `versionCode` for each new build. Side-by-side test builds are marked as prereleases. Use a filename ending in `-test.apk` for a development build that uses the regular app ID.

## What is and is not live

Manual accounts, file import, the plan, reports, and the fact-based assistant work without a third party. Bank aggregation, bill negotiation, credit reports, live market quotes, coaching, tax filing, and estate documents stay disconnected until a provider is configured. The app does not invent those results. The status of each connection is in the app under Connections and in [docs/PROVIDERS.md](docs/PROVIDERS.md).

Feature status, including unfinished items, is in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md). Do not describe this repository as complete feature parity with the seven reference apps. The comparison is in [docs/SOURCE_RECONCILIATION.md](docs/SOURCE_RECONCILIATION.md).
