# Formulas

The executable versions live in `packages/domain` and are covered by `packages/domain/test/budget.test.ts`. The API checks the same rules. This page is the short form.

## Identity

On-budget cash = Ready to Assign + every bucket balance (including card-payment reserves and borrowed-funds parking) + cash reserved for future months.

Credit-card debt that was never funded is not cash. A transfer between on-budget cash accounts does not change the total. The dashboard shows a warning when `identityDifferenceMinor` is not zero.

## Ready to Assign

Cash that has entered on-budget accounts and has not been given a job, minus cash that left without a category. Expected paychecks are not included. Loan proceeds sit in the borrowed-funds bucket and are not income. An investment withdrawal can increase Ready to Assign and is not income. Unrealized gains do not enter the budget.

## Safe to spend

Ready to Assign + flexible envelope balances − upcoming bills that are not already reserved.

If that result is negative, the screen shows the shortage. Expected income is a separate projected allowance and is labeled as not cash.

## Cards and refunds

A funded card purchase moves available money from the category into that card’s payment reserve. Paying the card spends the reserve. It is not a second expense. A cash refund reduces spending and is not income.

## Interest

Monthly interest is `balance * APR / 12`, with the APR in basis points, rounded half away from zero using integers. Snowball orders the smallest balance first. Avalanche orders the highest APR first. A refinance comparison adds the fee to the new principal.

## Age of money

Cash outflows consume the oldest cash inflows. The figure is an average of recent outflows. It is not a measure of how long the household can last.

## Investments and retirement

Missing prices stay missing. A holding with a price replaces that account’s transaction balance so cash and the holding are not both counted. Time-weighted return chains subperiod growth. The retirement model is a seeded simulation. Its success rate is not a promise.

## Reports

Spending excludes transfers, card payments, and principal. Refunds reduce the total. Savings rate is `(income − spending) / income` when income is positive. Watchlists use transactions you already have and do not invent charges.
