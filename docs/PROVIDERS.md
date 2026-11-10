# Providers

BudgetCents calculates in process. A provider is a status and a setup note until credentials exist. The Connections screen reads `GET /api/providers`.

| Id | Status in this build | What you would connect | What the app does meanwhile |
|---|---|---|---|
| manual | active | Nothing | Accounts, transactions, holdings, and manual values |
| aggregation | not configured | A client id and secret. Never a bank password | File import (CSV, OFX, QIF) and manual entry |
| bills | not configured | A bill-data agreement and consent | Schedules you type |
| market | not configured | A licensed price feed | Manual prices, labeled manual. Missing prices stay blank |
| property | not configured | A valuation key | A property account with a balance you enter |
| vehicle | not configured | A valuation key | A vehicle account with a balance you enter |
| credit | not configured | A bureau or reseller agreement and consent | A score you type, labeled manual. `liveReport` is null |
| sms | not configured | A messaging provider and a verified number | In-app alerts only |
| savings | not configured | A bank partner that can move deposits | Goals are envelopes. They do not pay interest or hold a deposit |
| concierge | not configured | An operator who contacts billers | A request is stored only after you check the authorization box. Status is `authorization_recorded`. No biller is contacted |
| coaching | not configured | A coach | Lessons in the app. Completing one does not book a person |
| tax | not configured | A filing partner | A checklist. A set-aside is not a filed return |
| estate | not configured | A legal-document partner | A checklist. It is not an executed will |
| smtp | local outbox | `SMTP_URL` | Verification and reset rows in `outbox` |
| model | not configured | A model key for wording | The assistant still answers from ledger facts, or stays quiet if you turn it off |

Adding a provider means implementing the adapter, storing consent, and showing its errors. Do not fill gaps with made-up balances, scores, cancellations, or quotes.
