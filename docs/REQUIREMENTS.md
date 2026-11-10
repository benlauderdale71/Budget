# Requirements ledger

BudgetCents is the product. The original specification remains `docs/source/LedgerOne_Complete_Build_Prompt.txt` and is unchanged. LedgerOne is only that document’s historical title.

A row is **Complete and verified** only when the applicable interface, API, persistence, permissions, and error handling were exercised together. **Implemented, verification pending** means the code is present and a release build or unit test covers part of it, but the user flow was not run on that platform. **Partial** means a real slice exists and a named piece does not. **Not implemented** means the workflow is still absent. **Provider integration awaiting activation** means the software stops at a disconnected adapter and does not invent a live result.

Verification recorded with this ledger, on November 10, 2026:

- `npm run typecheck` passed for domain, API, and web.
- Domain tests: 26 passed. API tests: 23 passed, including match, restore, and a dropped transaction response. Web typecheck passed.
- `npm run build` passed, then `npm start` served `/workspace/apps/web/dist` on port 8791. `BUDGETCENTS_WEB=./apps/web/dist` served the same directory on port 8792 even though npm’s working directory is `apps/api`. `/api/health` returned 200. `/` and `/plan` returned the built HTML. A path that escapes the web root returned 404.
- Headless Chrome, desktop 1280×900 and phone 390×844, signed into the sample household on that production server. The home page showed safe to spend, money already given a job, the next bill, needs review, and goals. Hiding the Goals card removed it. Reports drew a cash-flow diagram whose labels included Inflow and Spending. The roadmap showed essential monthly spending of $2,120 from Rent and the car-loan minimum, not a fixed $2,000. A $10 transaction with a $1 split stayed on the form with “Nothing was saved.” The phone width used the bottom tab bar. `/privacy` and `/delete-account` loaded without a session.
- A later headless Chrome pass on port 8794 signed into the sample household. Reset layout was in the card chooser. Hiding Goals removed “Open goals” and left Safe to spend on `/`. Activity showed Duplicate and Match. The new-category form showed Annual and “Percent of posted income.” A match was not completed in the browser; the API test covers that write.
- `./gradlew assembleRelease bundleRelease` in `android/` passed with Android Gradle Plugin 8.13.0 and Gradle 8.13. Artifacts: `android/app/build/outputs/apk/release/app-release.apk` and `android/app/build/outputs/bundle/release/app-release.aab`. They are gitignored. No emulator or `adb` binary was available, so the Android UI was not clicked through.

## Defect fixes from the open review

| ID | What changed | Verification | Status |
|---|---|---|---|
| A | `POST /api/households/:hid/fresh-start` authorizes the target space, then archives and clears assignments for that household and space in one transaction. Transactions and accounts stay. Related assignment, move, bucket, schedule, goal, rule, and import writes also check the space. | API test: another household returns 404, a private space returns 404 to a non-owner, an editor receives 403, an owner reset keeps the expense and writes `plan.reset`. | Complete and verified |
| B | Create, edit, bulk edit, import, rules, and provider updates build the resulting transaction and call `validateTransaction` before any write. | API test: a bad split returns 400, and the dashboard, register, and spending report still load. A bad edit and a bad provider amount leave the stored row unchanged. | Complete and verified |
| C | The web root is the repository `apps/web/dist`, including when the process working directory is `apps/api`. Relative `BUDGETCENTS_WEB` is resolved from the repository root. Static paths cannot escape that directory. | Path tests plus the two `npm start` runs above. | Complete and verified |
| D | The browser assigns one operation id before the first transaction post and keeps it through retries and the offline queue. The queue is stored for the signed-in user. Sign-out does not send another user’s items. The server claims `applied_ops` inside the same transaction as the insert. A dropped response is queued again, and a validation failure is reported instead of discarded. | Queue unit test, a concurrent API retry, and `lost-response.test.ts`: the server commits, the client fetch throws, the normal queue retries, and one transaction remains. Spending changes once. Sign-out sends nothing. A household switch does not retarget the stored path. A non-integer amount is explained and not stored. | Complete and verified |
| E | Android replays the queue on `Dispatchers.IO`, keeps the operation id, leaves failed items in the queue, and reloads after a successful send. Items are tied to the signed-in user. | Present in the release binary. Not run on a device or emulator. | Implemented, verification pending |

## Specification

### 01. One product

Sources: all seven reference apps. Web: BudgetCents shell. Android: `com.budgetcents.app`. API: service name `budgetcents`. Persistence: one household database. Verification: production page title and the Android application id in the release manifest. Remaining: the original prompt’s full behavior list is not all finished; this ledger keeps those items. Dependency: none. Status: **Partial**.

### 02. Web and Android platforms

Web is a responsive Vite app. Android is native Compose with system back from a detail screen, a navigation rail from 840dp, light/dark/system theme, receipt camera and file picker, encrypted session storage, deep links, and a widget. Both use the same HTTP API. Phone and desktop web layouts were checked. Android layouts were not run on a device. Remaining: installable PWA, landscape-specific layouts, and a device pass. Dependency: none. Status: **Partial**.

### 03. Interface

Web and Android share a teal and ink palette, plain formulas, and loading or empty copy on the screens that were built. The web dashboard stores each user’s card visibility with `PATCH /api/me`, and Up and Down store an order. The summary cards follow that order. Lower sections stay in place. Reset clears the saved layout. Android does not yet rearrange dashboard cards. Remaining: resize, undo, WCAG 2.2 AA verification, and a full keyboard pass. Dependency: none. Status: **Partial**.

### 04. Onboarding, accounts, and preferences

Web: register, sign-in, password reset, email verification token, MFA, sessions, sample household, currency, theme, and fresh start. The home page can save an onboarding choice for an individual, couple, family, or freelancer and can mark setup finished. Android: sign-in, sample household, manual account create, theme saved to the account, sessions, and account deletion. API: scrypt passwords, sessions, `users.theme`, `users.onboarding_step`. Verification: the layout and onboarding fields round-trip in an API test. The setup buttons were not clicked in the browser in this pass. Remaining: federated sign-in and a multi-step wizard that resumes after each account and category. Mail stays in the outbox until `SMTP_URL` is set. Dependency: mail host for real delivery. Status: **Partial**.

### 05. Account aggregation

Manual checking, savings, cash, credit, loan, and other account kinds can be created. Connection health is a provider list with `not_configured` or `local_outbox`. No bank password is collected. Remaining: live linking, pending activity from a provider, reconnect, and backfill. Dependency: aggregation vendor. Status: **Provider integration awaiting activation**.

### 06. Transaction register

Web activity can search, filter by account, save a named view, load further pages, edit account, type, splits, tags, notes, and a refund link, duplicate a row, and match or unmatch two equal amounts. Android can edit those same fields, add more than one split, duplicate, and match. API: validation before save, version conflicts, audit, and pagination with `nextOffset`. Matching keeps the keeper’s notes, tags, and review state, moves the receipt, copies a missing provider id, and removes one copy from spending. Unmatch puts that copy and the receipt back. A different household’s account, category, or transaction is rejected. Verification: `workflow.test.ts`. The new web buttons were not clicked in the browser in this pass, and Android was not run on a device. Remaining: a statement-lock screen on Android and a browser click-through of match and restore. Dependency: none. Status: **Partial**.

### 07. Import, export, migration, receipts

CSV, OFX, and QIF preview and commit exist. CSV and PDF export and a version-2 household backup exist. Restore previews first, then adds only missing rows into the signed-in household. An id owned by another household rejects the file and writes nothing. Android can preview and commit a pasted CSV. Receipt upload stores JPEG, PNG, or PDF and does not read the text. Verification: `workflow.test.ts` for preview, add-missing, and the cross-household rejection. The file picker was not used in the browser. Remaining: a migration wizard from another app and OCR. Dependency: OCR vendor for reading receipts. Status: **Partial**.

### 08. Categories, tags, rules

Web and Android can add categories and rules. Rules do not override a locked category. Tags can be typed on the web. API rejects a rule-generated split that breaks the total. Verification: API test for the bad rule. Remaining: rule preview on Android and a fuller action set in the Android form. Dependency: none. Status: **Partial**.

### 09. Category budgeting

The plan page shows category activity on the same balances. A new category can be a regular, annual, goal, or debt envelope, with a rollover choice and an optional percent of posted income. Underfunded auto-assign uses that percent against `incomeMinor` and treats a missing paycheck as zero. Android can set the same style and percent. Verification: domain test for 10 percent of 200000 minor units. Remaining: editing a percent on an existing category, scheduled fills, and target dates. Dependency: none. Status: **Partial**.

### 10. Zero-based assignment

Web assign, move, and auto-assign refuse to fund from expected income. Android Plan can assign and move between categories. A move changes assignments only. Verification: domain tests cover the identity. The Android move control was compiled, not tapped on a device. Dependency: none. Status: **Partial**.

### 11. Envelope budgeting

Envelope style is stored and the web plan can show that view. Android uses the same balances and can create a regular envelope. Remaining: annual and goal envelope artwork and a scheduled fill editor on Android. Dependency: none. Status: **Partial**.

### 12. Flexible spending

Safe to spend and the shortage use flexible balances and upcoming bills. The sample household showed $3,045.00 safe to spend and a separate projected allowance. Android home shows the same API figure. Status: **Partial** because Android was not opened on a device.

### 13. Paychecks and irregular income

Web bills, forecast, and income plan. Android paycheck screen loads the plan and can set a category amount. The plan does not fund Ready to Assign. Verification: API and domain behavior; the Android form was not clicked. Remaining: irregular cadence editing on Android. Dependency: none. Status: **Partial**.

### 14. Goals, targets, sinking funds, emergency reserve

Goals share one envelope. The roadmap’s essential spending is the monthly equivalent of confirmed bills, subscriptions, and debt payments, plus uncovered loan minimums. The sample household showed $2,120.00 from Rent ($1,800) and the car-loan minimum ($320), and an emergency gap of $1,860. Android can save a goal against an envelope. Remaining: Android target-date editing. Dependency: none. Status: **Partial**.

### 15. Credit cards, loans, and debt payoff

Funded card purchases reserve the payment. Card payments are not a second expense. Domain and API tests cover that. Web and Android show snowball and avalanche. Loan amortization and refinance comparison are API operations; the Android debts screen does not yet open the refinance form. Dependency: none. Status: **Partial**.

### 16. Bills, subscriptions, calendars, reminders

Web and Android can add a monthly bill or income schedule and skip one occurrence. Remaining: a calendar view and custom cadence on Android. Dependency: bill-data vendor for statement balances. Status: **Partial**.

### 17. Cancellation and negotiation

A case can be stored. The connections screen says a stored request is not a completed cancellation. Nothing is sent to a biller. Dependency: concierge operator. Status: **Provider integration awaiting activation**.

### 18. Forecasts and scenarios

Cash projection excludes expected income. A saved scenario is labeled as not part of the ledger. Web and Android can create one. Verification: API returns the note; the browser was not used on the forecast page in this pass. Dependency: none. Status: **Partial**.

### 19. Net worth, property, vehicles

Manual assets and liabilities enter net worth. A priced holding replaces that brokerage account’s transaction balance. Valuation providers are disconnected. Dependency: property and vehicle estimate vendors for live values. Status: **Partial**.

### 20. Investments

Manual holdings, cost basis, allocation, and fee impact exist. Missing prices stay missing. The sample quote is labeled manual. Android lists positions and the quote source. Dependency: licensed market data for live prices. Status: **Partial**.

### 21. Retirement

A seeded simulation returns a success rate and states that it is not a promise. Web and Android can run it. Verification: not clicked in the browser this pass. Dependency: none. Status: **Partial**.

### 22. Business, tax, and estate

Separate spaces exist, including a business space in the model. Tax and estate screens are checklists. They are not a filed return or an executed document. Dependency: tax-filing and legal-document partners. Status: **Provider integration awaiting activation** for filing and documents. The checklist itself is **Partial**.

### 23. Reports, watchlists, reviews

Spending, savings rate, and watchlists use stored transactions. The web watchlist reads `actualMinor`. The cash-flow diagram was drawn in the browser for the sample household. Android reports now list the same Sankey links and can request the spending total, including the date range, currency, and the transfer and refund note. Spending and income responses include that note. Verification: the earlier browser diagram, plus the API spending total in the workflow tests. Drill-down from a report total to its transactions is still not a screen. Dependency: none. Status: **Partial**.

### 24. Assistant

Answers use figures from accounts the signed-in person can see. With no model key, the wording stays the fixed ledger answer. Android has an ask box. SMS is not sent. Dependency: optional model key for wording, messaging vendor for texts. Status: **Partial**.

### 25. Household sharing and private spaces

Roles, invitations, and private-account filtering apply to dashboards, net worth, backup, and the assistant. An API test covers a private account and a private-space plan reset. Android can invite an editor. Remaining: professional read-only access as a distinct reviewed workflow, and the 12-person cap was not retested in this pass. Dependency: none. Status: **Partial**.

### 26. Alerts, widgets, shortcuts

In-app alerts and a web search box work. Android posts one unread alert to the `budgetcents` channel and has a home-screen widget. Deep links cover the main screens. Notification text is the server’s generic alert, not a hidden payee. Dependency: SMS vendor. Status: **Partial**.

### 27. Education and support

Lessons can be marked read on web and Android. A support request is stored. Coaching is not a live session. Dependency: a coach. Status: **Partial**.

### 28. Security, privacy, and deletion

Sessions, MFA, export, privacy mode, and deletion exist. Deletion requires the password and the word DELETE. Public pages `/privacy` and `/delete-account` were opened without a session. Android Security can revoke a session and delete the account. Consent withdrawal for a future provider has no live provider to withdraw. Production HTTPS is a deployment responsibility; see `docs/DEPLOYMENT.md`. Dependency: none for the local workflows. Status: **Partial**.

### 29. Offline sync

Web and Android queues keep an operation id and the user id. A concurrent server retry stored one transaction. The browser offline banner exists. A physical offline retry, and an Android replay, were not run. Dependency: none. Status: **Implemented, verification pending**.

### 30. Credit monitoring

A manual score can be stored and is labeled manual. `liveReport` is not a bureau report. Dependency: bureau or reseller agreement. Status: **Provider integration awaiting activation**.

### 31. One ledger and exact money

Categories, envelopes, and flexible spending share transactions. Amounts are integer minor units. Transfers are not income. Expected income does not fund Ready to Assign. The dashboard warns when the identity does not match. Domain tests cover the identity, cards, and essential spending. Dependency: none. Status: **Complete and verified** for the rules that have domain tests. New screens still need to keep calling those rules.

### 32. Acceptance coverage

Domain tests cover identity, essential spending, percent targets, and matching totals. API tests cover card treatment, private accounts, plan reset, split rejection, idempotent retry, match and unmatch, restore, and a dropped transaction response. The browser checks listed at the top passed for the earlier build. Android instrumented tests were not run. Dependency: none. Status: **Partial**.

### 33. Deployment and Play

`docs/DEPLOYMENT.md` and `docs/PLAY.md` match the commands that ran. The release APK and AAB were built and signed with the development keystore, not a Play upload key. The app is not published. Target API 36 was rechecked against Google Play’s page on November 10, 2026. Dependency: Play Console account and the real upload key. Status: **Partial**.

### 34. Repository deliverables

The source prompt is unchanged. This ledger and `docs/SOURCE_RECONCILIATION.md` name what is still open. Dependency: none. Status: **Partial** until the unfinished rows above are closed.

## Still unfinished, on purpose

- Live bank aggregation, bill data, market quotes, property and vehicle estimates, credit monitoring, cancellation, negotiation, automated transfers, SMS, coaching sessions, tax filing, and estate documents.
- Android device or emulator pass, including offline replay, biometrics, widgets, and deep links.
- Web workflows not clicked in the browser this pass: reconciliation, backup restore, account deletion, MFA, match, and the new activity buttons. The lost-response path was exercised through the web queue module against the API, not by cutting Chrome’s network.
- Android device or emulator pass. Split editing, category moves, and the cash-flow list are in the release binary and were not tapped.
- Scheduled envelope fills, irregular paycheck editing, loan refinance forms, report drill-down, and the rest of the original specification after section 23.
