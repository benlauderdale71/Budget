# Source reconciliation

This is not a claim of feature parity. The public pages below were the research inputs. BudgetCents implements the behavior in its own interface and its own words. It does not copy those products’ logos, marketing, or screen layouts.

The original mapping is attached unchanged in `docs/source/LedgerOne_Complete_Build_Prompt.txt`.

| Reference | What BudgetCents actually does | What it does not do |
|---|---|---|
| Monarch Money | Shared accounts, categories and flex roles, rollovers, recurring schedules, goals tied to envelopes, net worth, manual investments, reports, household roles, a fact-based assistant, a cash forecast, a business space, fee math, an estate checklist | Live aggregation, live quotes, a human advisor, estate-document access |
| YNAB | Zero-based assignment, envelope balances, targets, auto-assign that will not use expected income, future-month assignment, credit overspend, a card payment reserve, loan models, reconciliation, shared households, an offline transaction queue, an Android widget | Their bank partners, their referral network, a claim that age of money is a liquidity guarantee |
| Quicken Simplifi | A spending plan on the same cash, a daily cash figure, planned income lines that do not fund cash, watchlists, bills, projected balances with and without expected income, scenarios that do not post, manual investments, a retirement model, sharing, reports, the assistant | Their bank connections and any guarantee from the retirement model |
| Rocket Money | Schedules you can mark as subscriptions, a cancellation request that is stored and not sent, rules, spending reports, a manual credit entry, net worth, debt balances, partner invites, in-app alerts, a widget | Detection of subscriptions from a bank feed, cancellation, negotiation, credit monitoring, text assistance, automated savings transfers |
| EveryDollar | An income plan against expected pay, custom categories, sinking-fund purposes, a giving category in the starter set, splits, file import, paycheck schedules, debt snowball, a roadmap, reports, lessons | A coach, their course library, bank import as a live connection |
| Empower Personal Dashboard | A dashboard, manual holdings, allocation from priced holdings, fee impact, a seeded retirement simulation, emergency-fund gap math, debt models, net worth | Live portfolio data, professional-service booking, market quotes |
| Goodbudget | Regular, annual, and goal envelopes on the same balances, assignment and moves, file import, reconciliation, running balances through the register, envelope activity in the plan, debt tracking, household sync through the API | Their specific sync product and a second ledger beside categories |

Before anyone says the product matches one of those apps, re-read that app’s current public pages and this table. Provider rows in `docs/PROVIDERS.md` are still `not configured` unless the deployment has added credentials.
