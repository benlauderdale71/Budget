# Formulas

The executable versions live in `packages/domain` and are covered by `packages/domain/test/budget.test.ts`. The API checks the same rules. This page is the short form.

## Identity

On-budget cash = Ready to Assign + every bucket balance (including card-payment reserves and borrowed-funds parking) + cash reserved for future months.

Credit-card debt that was never funded is not cash. A transfer between on-budget cash accounts does not change the total. The dashboard shows a warning when `identityDifferenceMinor` is not zero.

## Ready to Assign

Cash that has entered on-budget accounts and has not been given a job, minus cash that left without a category. Expected paychecks are not included. Loan proceeds sit in the borrowed-funds bucket and are not income. An investment withdrawal can increase Ready to Assign and is not income. Unrealized gains do not enter the budget.

## Percent targets and fills

Eligible posted income is posted `income` on an on-budget checking, savings, or cash account for the selected month. It excludes expected paychecks, transfers, refunds, reimbursements, loan proceeds, opening balances, pending transactions, and unrealized gains. Percentages are basis points: 1 basis point is 0.01 percent, so 10.5 percent is 1050. More than two decimal places is rejected. The target is `round(eligible * percentBps / 10000)`, half away from zero. With no eligible income the target is zero.

An envelope fill changes assignments only. Ready to Assign falls by the amount actually allocated, and the destination envelopes rise by the same total. Account balances, net worth, income, and spending stay the same. If the plan does not fit, the saved policy either skips the occurrence or funds envelopes in priority order and stops at zero. It does not make Ready to Assign negative. A category-to-category line moves available money and does not create a bank transaction. Leftover Ready to Assign is swept only when every line was fully funded.

## Safe to spend

Ready to Assign + flexible envelope balances − upcoming bills that are not already reserved.

If that result is negative, the screen shows the shortage. Expected income is a separate projected allowance and is labeled as not cash.

## Cards and refunds

A funded card purchase moves available money from the category into that card’s payment reserve. Paying the card spends the reserve. It is not a second expense. A cash refund reduces spending and is not income.

## Interest

Monthly interest is `balance * APR / 12`, with the APR in basis points, rounded half away from zero using integers, and charged once a month. That is a model, not a lender payoff quote. Snowball orders the smallest balance first. Avalanche orders the highest APR first. The monthly debt budget is the starting minimums plus any extra, and a paid-off minimum stays in that budget. A financed refinance fee is added to the new principal once. An upfront fee is part of the future cost and is not added to principal. If either side is not paid off within 100 years, the interest totals are not compared as lifetime savings.

## Age of money

Cash outflows consume the oldest cash inflows. The figure is an average of recent outflows. It is not a measure of how long the household can last.

## Investments and retirement

Missing prices stay missing. A holding with a price replaces that account’s transaction balance so cash and the holding are not both counted. Time-weighted return chains subperiod growth. The retirement model is a seeded simulation. Its success rate is not a promise.

## Essential spending

The roadmap uses confirmed bills, subscriptions, and debt payments, converted to a monthly equivalent, plus loan minimums that are not already on that schedule. Flexible spending and expected income are left out. If none of those are selected, the figure is zero. BudgetCents does not substitute a default amount.

## Reports

Spending excludes transfers, card payments, and principal. Refunds reduce the total. Savings rate is `(income − spending) / income` when income is positive. Watchlists use transactions you already have and do not invent charges.
