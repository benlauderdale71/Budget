# Requirements ledger

BudgetCents is the product. The original specification remains `docs/source/LedgerOne_Complete_Build_Prompt.txt` and is unchanged. LedgerOne is only that document’s historical title.

A row is **Complete and verified** only when the applicable interface, API, persistence, permissions, and error handling were exercised together. **Implemented, verification pending** means the code is present and a release build or unit test covers part of it, but the user flow was not run on that platform. **Partial** means a real slice exists and a named piece does not. **Not implemented** means the workflow is still absent. **Provider integration awaiting activation** means the software stops at a disconnected adapter and does not invent a live result.

Verification recorded with this ledger, on November 10, 2026:

- `npm run typecheck` passed for domain, API, and web.
- Domain tests: 33 passed. API tests: 29 passed, including match, restore, a dropped transaction response, category edits, rollover effective dates, and scheduled fills. Web typecheck passed.
- A later pass on November 10, 2026 added category editing and scheduled fills. Domain 33 passed. API 29 passed. Web `tsc --noEmit` and `vite build` passed (`dist/assets/index-BdiReeKP.js`). Android `assembleRelease` and `bundleRelease` passed. No `adb` or emulator was available. Headless Chrome on the production server at port 8795, desktop 1280×900 and phone 390×844: each category has Edit, Groceries kept the saved icon `basket` at version 4, a fill preview said no money had moved, the saved fill was Scheduled with “No occurrence has run,” Run now applied $1.00, Ready to Assign went from $1,800.00 to $1,799.00, and the next date stayed Scheduled while the last result said Applied. That pass did not click match, restore, reconciliation, MFA, or account deletion. The later pass on port 8796 clicked match, unmatch, duplicate, split, refund, saved views, reconciliation, and restore. MFA and account deletion remain unclicked.
- `npm run build` passed, then `npm start` served `/workspace/apps/web/dist` on port 8791. `BUDGETCENTS_WEB=./apps/web/dist` served the same directory on port 8792 even though npm’s working directory is `apps/api`. `/api/health` returned 200. `/` and `/plan` returned the built HTML. A path that escapes the web root returned 404.
- Headless Chrome, desktop 1280×900 and phone 390×844, signed into the sample household on that production server. The home page showed safe to spend, money already given a job, the next bill, needs review, and goals. Hiding the Goals card removed it. Reports drew a cash-flow diagram whose labels included Inflow and Spending. The roadmap showed essential monthly spending of $2,120 from Rent and the car-loan minimum, not a fixed $2,000. A $10 transaction with a $1 split stayed on the form with “Nothing was saved.” The phone width used the bottom tab bar. `/privacy` and `/delete-account` loaded without a session.
- A later headless Chrome pass on port 8794 signed into the sample household. Reset layout was in the card chooser. Hiding Goals removed “Open goals” and left Safe to spend on `/`. Activity showed Duplicate and Match. The new-category form showed Annual and “Percent of posted income.” That 8794 pass showed the Match button and did not finish a match. The later pass on port 8796 completed match and unmatch.
- `./gradlew assembleRelease bundleRelease` in `android/` passed with Android Gradle Plugin 8.13.0 and Gradle 8.13 before production signing was separated. Those artifacts were signed with the development keystore. They are gitignored. No emulator or `adb` binary was available, so the Android UI was not clicked through.
- A later pass on November 10, 2026 exercised the production web build in headless Chrome at `http://127.0.0.1:8796`, desktop 1280×900 and phone 390×844, with disposable households. Match kept the keeper’s notes, tags, review state, and receipt and counted the purchase once ($24.00 while the bank copy was hidden). Unmatch put the bank id and receipt back on the bank row. An equal $8 purchase with a different payee stayed a separate transaction. Duplicate left the original Reviewed, marked the copy Needs review, and did not copy the bank id. A $5 Housing and $3 Groceries split survived reload; $1 plus $1 stayed on the form with “Nothing was saved.” A stale transaction version showed “Reload it” and did not overwrite the newer notes. A $3 refund and an $8 refund reduced spending to $29.00 and were not income; the CSV contained `RefundOf`. A saved view was created, reopened, renamed, and deleted for that user. The next register page did not repeat the first page, and changing the sort returned to the first page. Reconciliation showed the difference as currency, added a visible adjustment, locked at zero, required a reason to change the locked amount, and unlocked. A transaction id from checking was rejected on the cash account. The settings file picker previewed a backup without writing, rejected another household’s file with no new account, added a fixture once, and a second add plus a malformed file left one “Restored market.” A fill was previewed, saved as Scheduled with no occurrence, renamed, and Ready to Assign did not change. The Housing report link opened only the Diner transaction, then the whole register again. This was not a Chrome network cut. `lost-response.test.ts` still covers the client queue when `fetch` throws after the server commits. Automatic fills stayed off because `BUDGETCENTS_FILL_POLL_MS` was unset. `npm test` passed: domain 33, API 32, and the web typecheck. The production web bundle is `dist/assets/index-BG__yfEr.js`. `./gradlew assembleDevRelease` succeeded. `./gradlew assembleRelease` stopped because the four production signing variables were absent. Android was not launched.
- A later pass on November 10, 2026 added irregular paychecks, receipt recording, custom bill frequencies, and a calendar. `npm test` passed: domain 42, API 37, and the web typecheck. The production bundle is `dist/assets/index-DeKrib2B.js`. Headless Chrome 156 opened that build at `http://127.0.0.1:8808`, desktop 1280×900 and phone 390×844, in disposable households. Creating a Side contract for $1,200.00 on 2026-11-18 and $650.00 on 2026-11-27 left cash, Ready to Assign, and received income at $1,000.00, $1,000.00, and $0.00. The register had the opening balance and no Side contract row. Editing the note kept those totals. A bill interval of 0 was rejected with “was not changed to 30 days” and was not saved. Power, every 10 days, was saved and then edited from $40.00 to $45.00 without changing cash. Changing only the November 27 amount to $700.00 left the $1,200.00 date in place. Recording November 18 as fully received for $1,100.00 raised cash, Ready to Assign, and net worth to $2,100.00, posted one Side contract income row, and left the next expected amount at $700.00. The forecast that includes expected pay was $700.00 higher than projected cash, and $1,200.00 was no longer shown. Submitting the receipt again said the date was already settled and left cash at $2,100.00. Safe to spend stayed below cash and did not include that unpaid $700.00. The calendar opened the $700.00 estimate and a Power estimate, closed back to 2026-11, and Previous month then Next month returned to that month. The desktop month grid was visible. At phone width the grid was hidden, the list remained, and Paychecks, Bills, and Calendar were opened from More. This was not a Chrome network cut. `./gradlew assembleDevRelease` succeeded after the Android paycheck, calendar, and bill editors. `./gradlew assembleRelease` stopped again because `BUDGETCENTS_KEYSTORE`, `BUDGETCENTS_STORE_PASSWORD`, `BUDGETCENTS_KEY_ALIAS`, and `BUDGETCENTS_KEY_PASSWORD` were absent. It did not sign with the development keystore. No `adb` binary or emulator was available, so the Android screens were not tapped.

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

Web: register, sign-in, password reset, email verification token, MFA, sessions, sample household, currency, theme, and fresh start. The home page can save an onboarding choice for an individual, couple, family, or freelancer and can mark setup finished. Android: sign-in, sample household, manual account create, theme saved to the account, sessions, and account deletion. API: scrypt passwords, sessions, `users.theme`, `users.onboarding_step`. Verification: the layout and onboarding fields round-trip in an API test. The setup choice buttons have not been clicked in the browser. Remaining: federated sign-in and a multi-step wizard that resumes after each account and category. Mail stays in the outbox until `SMTP_URL` is set. Dependency: mail host for real delivery. Status: **Partial**.

### 05. Account aggregation

Manual checking, savings, cash, credit, loan, and other account kinds can be created. Connection health is a provider list with `not_configured` or `local_outbox`. No bank password is collected. Remaining: live linking, pending activity from a provider, reconnect, and backfill. Dependency: aggregation vendor. Status: **Provider integration awaiting activation**.

### 06. Transaction register

Web activity can search, filter by account, save a named view, load further pages, edit account, type, splits, tags, notes, and a refund link, duplicate a row, and match or unmatch two equal amounts. Android can edit those same fields, add more than one split, duplicate, and match. API: validation before save, version conflicts, audit, and pagination with `nextOffset`. Matching keeps the keeper’s notes, tags, and review state, moves the receipt, copies a missing provider id, and removes one copy from spending. Unmatch puts that copy and the receipt back. A different household’s account, category, or transaction is rejected. Verification: `workflow.test.ts`, plus the Chrome pass above for match, unmatch, duplicate, split, stale version, refund, saved view, paging, and sort. Android was not run on a device. Remaining: a statement-lock screen on Android. Dependency: none. Status: **Partial**.

### 07. Import, export, migration, receipts

CSV, OFX, and QIF preview and commit exist. The same date, payee, and amount is a possible match the person can check. The same provider id is an already-imported duplicate and stays unchecked. CSV and PDF export and a version-2 household backup exist. The CSV includes `RefundOf`. Restore previews first and writes nothing during preview, then adds only missing rows into the signed-in household. Running it again does not duplicate those rows. An id owned by another household rejects the whole file and writes nothing. A file that is not JSON is rejected in the browser with the message that nothing was changed. Android can preview and commit a pasted CSV. Receipt upload stores JPEG, PNG, or PDF and does not read the text. Verification: `workflow.test.ts`, and the Chrome file picker for preview, add-missing, a repeated restore, a cross-household rejection, and a malformed file. Remaining: a migration wizard from another app, and receipt reading. Storing a photo is not OCR. No on-device reader is connected, and extracted values cannot change a confirmed record until a person reviews them. Dependency: none for storage. A local OCR engine is still to be chosen and wired. Status: **Partial**.

### 08. Categories, tags, rules

Web and Android can add categories and rules. Rules do not override a locked category. Tags can be typed on the web. API rejects a rule-generated split that breaks the total. Verification: API test for the bad rule. Remaining: rule preview on Android and a fuller action set in the Android form. Dependency: none. Status: **Partial**.

### 09. Category budgeting

The plan page shows category activity on the same balances. Web and Android can edit an existing category: name, group, icon, order, kind, fixed/non-monthly/flexible classification, regular/annual/goal/debt style, target type, amount, date, cadence, pause, percent, rollover, cap, archive, and restore. The save sends the category version. A stale screen gets 409 and does not overwrite the newer edit. A rollover change applies when the selected month closes. Earlier months stay as they were unless the user previews and saves Recalculate. Android refuses to save a recalculation until that preview has succeeded. Editing does not create a transaction or an assignment. Eligible income for a percent is posted income on an on-budget cash account. Expected pay, transfers, refunds, reimbursements, loan proceeds, openings, and unrealized gains are excluded. Zero eligible income produces a zero target. A fill can add a fixed amount, top up an available balance, fund a shortfall, or assign a percent, for more than one envelope, with a priority, a source of Ready to Assign or another envelope, and an optional sweep. If cash is short, the saved policy skips the occurrence or funds in priority order and stops at zero Ready to Assign. Schedules support once, weekly, biweekly, twice monthly, monthly, every two/three/six months, annual, and custom. Missed dates are skipped with no money. Run now, pause, resume, skip, and delete are on the web plan and in the Android Envelope fills screen. The same occurrence key cannot be applied twice. Verification: domain tests for percent rounding, refund exclusion, rollover effective month, and the $250 fill identity; API tests for version conflict, another household, rollover preview, the acceptance case and its replay, partial and skipped fills, a missed month, a refund that does not raise the percent, an archived category, a demoted member, a template edit that does not move money, and a second scheduler pass that allocates nothing. Browser: a new fill was previewed, saved as Scheduled with no occurrence, renamed, and Ready to Assign stayed the same. Android category and fill amounts use the device privacy setting. Those Android screens were not tapped. Remaining: irregular paycheck editing and a bill calendar. Dependency: none for the budget math. Automatic execution needs `BUDGETCENTS_FILL_POLL_MS` of at least 1000, or an owner calling the due route. Status: **Partial**.

### 10. Zero-based assignment

Web assign, move, and auto-assign refuse to fund from expected income. Applying auto-assign stops when Ready to Assign reaches zero. Android Plan can assign and move between categories. A move changes assignments only. Assignment, move, auto-assign, and fills lock the household row so they cannot allocate the same cash together. Verification: domain tests cover the identity. The Android move control was compiled, not tapped on a device. Dependency: none. Status: **Partial**.

### 11. Envelope budgeting

Envelope style is stored and the web plan can show that view. Android can create and edit a regular, annual, goal, or debt envelope on the same balances. Fill editing exists on both clients and is not a two-line form. The web form and the Android form can change the name, every envelope line, the mode, the amount or percent, the priority, the sweep, the source envelope, the insufficient-cash policy, the cadence and custom interval, the start and end dates, and pause. Lines can be added, removed, and moved up or down. The web edit sends the template version. Saving explains that a schedule which has never run takes the new start date, and one which has run keeps the next date unless it is earlier than the new start. That save does not execute the fill. Android history lists the date, status, allocated amount, shortage, and explanation, formatted with the household privacy setting rather than a raw minor-unit integer. The web edit was used in Chrome. The Android form was compiled and not tapped. Remaining: envelope artwork that is more than the shared balance card, and a device pass. Dependency: none. Status: **Partial**.

### 12. Flexible spending

Safe to spend and the shortage use flexible balances and upcoming bills. The sample household showed $3,045.00 safe to spend and a separate projected allowance. Android home shows the same API figure. Status: **Partial** because Android was not opened on a device.

### 13. Paychecks and irregular income

An income source is separate from a posted income transaction and from a budget assignment. Web and Android can create, inspect, edit, pause, resume, archive, and restore one. Kinds are salary, hourly, freelance or contract, commission, bonus, seasonal, benefits, other recurring receipts, and irregular or one-time pay. Schedules are weekly, every two weeks, twice a month on two chosen days, monthly or longer with an anchored day, every N days, every N weeks, once, or an explicit list of dates and amounts. The irregular list is not stored as a monthly series. One date can be revised without changing the others, and a future-amount change leaves received rows in place. A missing or non-positive custom interval is rejected and is not replaced with 30 days. The anchored day returns after a short month, including a 31st after February and February 29 in a leap year. Twice a month and every two weeks stay different. Saving, editing, moving, or cancelling an expected paycheck does not change an account balance, Ready to Assign, net worth, or a category. Recording a receipt creates or links exactly one posted income transaction. The amount and date can differ from the estimate. Full, partial, delayed, and cancelled are distinct. The same operation id does not insert a second deposit. A received occurrence is not also kept as future income. Nothing posts automatically because the date arrived. The planning view shows cash on hand, Ready to Assign, posted income received so far, the next expected paycheck, bills due before it, and two projections: cash without expected pay, and a labeled forecast if that pay arrives. Conservative, expected, and optimistic use the low end, the midpoint, and the high end. Another household and a private account the caller cannot see are left out of the list, the totals, and the assistant.

Verification: `packages/domain/test/income.test.ts` and `apps/api/test/income.test.ts`, plus the Chrome pass at the top of this ledger for creation, editing, the one-date change, the $1,100.00 receipt, the duplicate submit, and the calendar. The API also covers a partial receipt, a delay, a cancellation, a link to an imported deposit, and a paid bill that is not subtracted twice. Android `assembleDevRelease` contains the editor, the extra date rows, pause, archive, restore, full and partial receipt, delay, cancel, one-date and future revision, and the calendar list. Those controls were not tapped because this environment has no emulator or `adb`. The separate category plan still does not move money. Dependency: none. Status: **Partial** until the Android screens run on a device.

### 14. Goals, targets, sinking funds, emergency reserve

Goals share one envelope. The roadmap’s essential spending is the monthly equivalent of confirmed bills, subscriptions, and debt payments, plus uncovered loan minimums. The sample household showed $2,120.00 from Rent ($1,800) and the car-loan minimum ($320), and an emergency gap of $1,860. Android can save a goal against an envelope. Remaining: Android target-date editing. Dependency: none. Status: **Partial**.

### 15. Credit cards, loans, and debt payoff

Funded card purchases reserve the payment. Card payments are not a second expense. Domain and API tests cover that. Web and Android show snowball and avalanche. Loan amortization and refinance comparison are API operations; the Android debts screen does not yet open the refinance form. Dependency: none. Status: **Partial**.

### 16. Bills, subscriptions, calendars, reminders

Web and Android can save and edit a bill or subscription with weekly, every two weeks, twice monthly, monthly and longer anchored dates, every N days, every N weeks, once, and an end date. Skip moves the next date and does not turn an invalid interval into 30 days. A bill with a category can reserve cash already in Ready to Assign. The calendar and list show expected paychecks, bills, received and paid occurrences, overdue items, paused or skipped occurrences, and estimated cash from today forward. An estimate is not a posted transaction. A posted bill is not also counted as money still owed. Opening an item and closing it keeps the selected month. Fills stay labeled as assignment moves, not bank withdrawals. Verification: the Chrome pass created and edited Power and opened it from the calendar, and the API test kept a paid bill out of the cash projection. The Android calendar and bill editor are in the development build and were not tapped. Dependency: a bill-data vendor for statement balances. Status: **Partial**.

### 17. Cancellation and negotiation

A case can be stored. The connections screen says a stored request is not a completed cancellation. Nothing is sent to a biller. Dependency: concierge operator. Status: **Provider integration awaiting activation**.

### 18. Forecasts and scenarios

Cash projection excludes expected income unless the screen is the labeled forecast that says the pay has not arrived. A saved scenario is labeled as not part of the ledger. Web and Android can create one. The paycheck planning view was exercised in Chrome, including the separate projected-cash and expected-pay figures. The dedicated Forecast page was not opened in this pass. Dependency: none. Status: **Partial**.

### 19. Net worth, property, vehicles

Manual assets and liabilities enter net worth. A priced holding replaces that brokerage account’s transaction balance. Valuation providers are disconnected. Dependency: property and vehicle estimate vendors for live values. Status: **Partial**.

### 20. Investments

Manual holdings, cost basis, allocation, and fee impact exist. Missing prices stay missing. The sample quote is labeled manual. Android lists positions and the quote source. Dependency: licensed market data for live prices. Status: **Partial**.

### 21. Retirement

A seeded simulation returns a success rate and states that it is not a promise. Web and Android can run it. Verification: the retirement simulation has not been clicked in the browser. Dependency: none. Status: **Partial**.

### 22. Business, tax, and estate

Separate spaces exist, including a business space in the model. Tax and estate screens are checklists. They are not a filed return or an executed document. Dependency: tax-filing and legal-document partners. Status: **Provider integration awaiting activation** for filing and documents. The checklist itself is **Partial**.

### 23. Reports, watchlists, reviews

Spending, savings rate, and watchlists use stored transactions. The web watchlist reads `actualMinor`. The cash-flow diagram was drawn in the browser for the sample household. Android reports list the same Sankey links and can request the spending total, including the date range, currency, and the transfer and refund note. Spending and income responses include that note. Each web spending row links to the register filtered by that row’s transaction ids. In Chrome, Housing opened only the Diner split and left Bookstore off that page; Show the whole register brought the other rows back. The phone report showed Uncategorized $21.30, Housing $5.00, and Groceries $3.00 after the extra one-cent rows used for paging. Android does not open the underlying transactions from a report row. Verification: the Chrome click and `workflow.test.ts` for the id filter. Dependency: none. Status: **Partial**.

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

Domain tests cover identity, essential spending, percent targets, matching totals, and irregular income dates. API tests cover card treatment, private accounts, plan reset, split rejection, idempotent retry, match and unmatch, restore, a dropped transaction response, and paycheck receipt. The browser checks listed at the top include the register workflows and the paycheck and calendar workflows. Android instrumented tests were not run. Dependency: none. Status: **Partial**.

### 33. Deployment and Play

`docs/PLAY.md` is the current Android signing record. `./gradlew assembleDevRelease` and `./gradlew bundleDevRelease` sign with the development keystore. `./gradlew assembleRelease` and `./gradlew bundleRelease` require `BUDGETCENTS_KEYSTORE`, `BUDGETCENTS_STORE_PASSWORD`, `BUDGETCENTS_KEY_ALIAS`, and `BUDGETCENTS_KEY_PASSWORD`, and they do not fall back to the development key. On November 10, 2026, `assembleDevRelease` succeeded and `assembleRelease`, run separately, stopped because those four values were absent. An earlier pass, before that split, did sign release artifacts with the development keystore. The development key is not a Play upload key. The app is not published. A successful Gradle task is not a device pass: no emulator or `adb` was available. Target API 36 was rechecked against Google Play’s page on November 10, 2026. Dependency: a Play Console account and the four production signing values. Status: **Partial**.

### 34. Repository deliverables

The source prompt is unchanged. This ledger and `docs/SOURCE_RECONCILIATION.md` name what is still open. Dependency: none. Status: **Partial** until the unfinished rows above are closed.

## Still unfinished, on purpose

- Live bank aggregation, bill data, market quotes, property and vehicle estimates, credit monitoring, cancellation, negotiation, automated transfers, SMS, coaching sessions, tax filing, and estate documents.
- Android device or emulator pass, including offline replay, biometrics, widgets, and deep links.
- Browser workflows still not clicked: account deletion, MFA enrollment and a code at sign-in, session revocation, registration email verification, password recovery through the mail path, and the dedicated Forecast page. Match, unmatch, duplicate, split, refund, saved views, reconciliation, backup restore, paycheck creation and editing, an irregular one-date change, receipt recording, custom bill editing, and calendar navigation were clicked in headless Chrome. The lost-response path remains `lost-response.test.ts`, where `fetch` throws after the server commits. It is not a cut of Chrome’s network.
- Loan extra-payment and refinance forms that save a loan, Android report drill-down, resumable onboarding, and receipt OCR that a person reviews before an extracted value becomes a confirmed record.
- Android device or emulator pass for the paycheck editor, calendar, custom bill editor, category editing, envelope fills, split editing, category moves, and the cash-flow list. Those screens are in the development build and were not tapped. `assembleDevRelease` succeeding is not that pass.
