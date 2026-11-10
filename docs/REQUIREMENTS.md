# Requirements ledger

Status words: **working** means the path can be used in this repo; **partial** means a real slice exists and a named piece does not; **provider** means the screen and the data model exist and the outside service is not connected. Nothing here is described as feature parity. See `docs/SOURCE_RECONCILIATION.md`.

| Id | Requirement | Web | Android | Backend | Dependency | Status |
|---|---|---|---|---|---|---|
| 01 | One product, original UI, renamed BudgetCents, prompt kept | App shell | Native client | Service name `budgetcents` | None | working |
| 02 | Web and Android share accounts and rules | Vite app | Compose client | HTTP API | User sets the Android server URL | working |
| 02b | Phone and tablet layout | Sidebar and a five-tab bar | Five tabs, scrollable screens | Same API | None | working |
| 02c | Biometric unlock | Not a browser feature | Optional BiometricPrompt | None | Device hardware | partial |
| 02d | Notifications | In-app alerts | Notification channel from unread alerts | `alerts` | Android 13 permission | working |
| 02e | Receipt capture | File input, stored | Camera, JPEG uploaded | Attachment sniff, 8 MB | OCR provider | partial |
| 02f | Widget | None | Home-screen summary | Cached on device | Launcher | partial |
| 02g | Offline entry and sync | Queue for failed transaction posts, service worker for the shell in production | Queue in encrypted prefs, replay on the next successful load | `applied_ops` and provider id replay | Network | working |
| 03 | Light, dark, system theme, loading and error states | Settings and banners | Light Material theme | `users.theme` | None | partial |
| 04 | Register, sign-in, sample household, preferences | Auth and Settings | Sign-in and sample household | scrypt, sessions | Mail for verification | partial |
| 05 | Account aggregation | Connections page | Mentioned on More | Provider status only | Aggregation vendor | provider |
| 06 | Register: splits, tags, notes, review, reconcile, refunds | Activity, Accounts | Expense entry and list | Transactions, splits | None | working |
| 07 | CSV, OFX, QIF import, CSV and PDF export, backup | Import, Reports, Settings | Not a separate screen | Import batches, formula-safe CSV | None | partial |
| 07b | Receipt OCR | Upload says it needs review | Upload says OCR is off | File stored, no OCR engine | OCR vendor | provider |
| 08 | Rules that do not override a locked category | Rules | Not a separate screen | `applyRules` | None | partial |
| 09 | Category view of the same balances | Plan | Plan list | Buckets | None | working |
| 10 | Zero-based assignment, move, auto-assign | Plan | Assign on Plan | Assignments | None | working |
| 11 | Envelopes, including annual and goal styles | Plan envelope view, new category | Same balances, no separate envelope art | `envelope_style` | None | working |
| 12 | Flex roles and safe-to-spend | Home and Plan | Home figure | `spendGuidance` | None | working |
| 13 | Paychecks and irregular income | Bills, Forecast, income plan | Upcoming is not a separate screen | Schedules | None | partial |
| 14 | Goals, targets, sinking funds | Goals, Plan | Not a separate screen | Goals share a bucket | None | partial |
| 15 | Cards, reserves, loans, snowball, avalanche | Activity, Debts | Card math is on the server; no debt screen | Domain debt and card tests | None | partial |
| 16 | Recurring bills and skip | Bills | Not a separate screen | Schedules | Bill-data vendor | partial |
| 17 | Cancellation and negotiation | Requests | Not a separate screen | Case row, no outbound call | Concierge | provider |
| 18 | Forecast, shortage, scenarios | Forecast | Not a separate screen | `projectCash` | None | partial |
| 19 | Net worth, manual property and vehicles | Wealth, Accounts | Wealth | Holdings override brokerage cash | Valuation vendors | partial |
| 20 | Investments, allocation, fees, no invented quotes | Investments | Not a separate screen | Manual quotes | Market data | partial |
| 21 | Retirement simulation | Retirement | Not a separate screen | Seeded model | None | partial |
| 22 | Business space, tax and estate checklists | Sharing, Checklists | Not a separate screen | Spaces, checklist items | Tax and legal partners | provider |
| 23 | Spending, savings rate, watchlist, Sankey data | Reports. Sankey is returned by the API and not drawn | Not a separate screen | Report queries | None | partial |
| 24 | Assistant from facts only | Assistant | Not a separate screen | `answerFinanceQuestion` | Optional model for wording | working |
| 25 | Household roles, private accounts, 12-person cap | Sharing | Sign-in only | Memberships, visibility filter | None | partial |
| 26 | Alerts and quick search | Home, header search | Notification | Alerts | SMS vendor for texts | partial |
| 27 | Lessons, support ticket | Learn, Settings | Not a separate screen | Lessons, tickets | A coach | partial |
| 28 | MFA, sessions, export, deletion, privacy mode | Settings | Privacy hides amounts; deletion is on the web | Users, sessions | None | partial |
| 29 | Sync idempotency | Web queue | Android queue | Op id and provider id | None | working |
| 30 | Credit monitoring | Credit, manual only | Not a separate screen | `liveReport` is null | Bureau | provider |
| 31 | Integer money, one ledger, identity | Dashboard warns if identity breaks | Uses the same API | Domain engine | None | working |
| 32 | Acceptance tests for card, privacy, demo identity, replay, deletion | Exercised in the browser against the sample household | Release binary builds | `packages/domain/test`, `apps/api/test` | None | working |
| 33 | Deployment notes, test APK, AAB, Play handoff | `docs/DEPLOYMENT.md` | `docs/PLAY.md`. Not submitted to Play | Node API | Play Console account | partial |
| 34 | Source in this repo, ledger, unfinished items named | This file | This file | This file | None | working |

## Known limits

- The roadmap’s essential monthly spending is a placeholder of $2,000 until it is derived from fixed bills.
- Sankey data is available from the API and is not drawn as a diagram.
- Android does not repeat every web form. The shared rules still apply to anything it posts.
- Email is an outbox until `SMTP_URL` is set.
- The Android Gradle plugin used here warns that 8.7.3 was tested through compile SDK 35. The project still targets API 36. See `docs/PLAY.md`.
- Uninvested cash inside a brokerage should be its own holding or its own account. A priced holding replaces that account’s transaction balance so the cash and the securities are not both counted.
