# Using BudgetCents

## Start

Create a household with an email and a password of at least 10 characters, or open the sample household. The sample people and balances are fictional. A banner stays on screen while that household is open.

Setup then asks who the plan is for and saves the household name, currency, locale, time zone, week start, and budget approach. Accounts, import, categories, expected income, bills, a goal, and invitations can be skipped and opened again. Bank linking is not available. Expected income is not cash. The sample household is not this wizard. Email verification and password recovery use the local outbox in development. That outbox is not proof that SMTP delivered the message.

Add the account where cash sits and an opening balance. On-budget accounts are the ones the plan can assign. Loans, cards you are only tracking, and investments can stay off the plan and still appear in net worth.

Tab through the page. Skip to content jumps past the sidebar. Escape closes a dialog and returns to the button that opened it. Hide amounts is announced as hidden, including the name of the amount.

Customize dashboard changes the order, visibility, and width of the home cards for this window size. A phone-width browser and a wider window keep separate arrangements, and the Android app keeps its own. Drag the handle or use Up and Down. Standard and Wide change the width of This month, Upcoming, Alerts, and Recent when the window is wide enough; a narrow window still shows the whole card. Reset layout returns that window’s cards to the starting order. Undo puts the previous arrangement back, including after a reload in the same tab, and does not undo a transaction. The change is saved when the status says so. If it says the change was not saved, the cards stay as they were and Try again sends the same change. Another signed-in person has a separate arrangement.

A production site served over HTTPS can be installed from the browser. The installed window is the same BudgetCents app. After one online load it can open offline. The last dashboard this sign-in was allowed to see can be kept on this device for seven days, labeled with the time it was saved. Those figures are not the current ledger. Signing out, switching households, or losing access removes that copy from view. A transaction or assignment saved while offline waits until the connection returns and is not on the ledger until the server accepts it. Signing out does not send someone else’s waiting transactions. The Android app can show a summary or a widget set to a category, flexible spending, an upcoming bill, a goal, or quick add. Amounts stay hidden while privacy mode or the app lock is on. On a device that does not allow the app to bind a widget, the placement screen says the home-screen launcher has to place it. Reconcile can compare a statement, preview an adjustment, post it once, lock at zero, correct a locked amount with a reason, and unlock with a reason. Cancel and a comparison that you do not lock leave the register unchanged. A goal’s target date can be edited. A transaction saved while the phone is offline stays on the phone until one successful retry.

## Plan

Ready to Assign is cash that has arrived and has no job. Give it a category. Envelopes and flex groups are the same balances with different labels. Moving money between categories does not move it at the bank. If someone else saves the plan first, your number stays in the box and the server keeps their assignment. Reload replaces the box with the saved plan.

The income plan compares expected pay with amounts you intend to give each category. Saving it does not fund anything. Funding happens when you assign cash that is already in Ready to Assign.

Underfunded targets can be previewed. The preview will not spend expected income and will not assign more than Ready to Assign.

## Import

Open Import, choose the file type, and pick a source when the export came from Mint, YNAB, Monarch, Simplifi, Rocket Money, EveryDollar, Empower, or Goodbudget. Map only columns the file has. Preview lists every row, the categories it found, and a balance from the file. Nothing is posted yet. A balance is not turned into a transaction. A row whose splits do not add up to the amount stays out, and the difference is not given to the last category. Categories, notes, tags, and splits are kept when the export has them. Fields the export does not have stay blank. This is not a complete copy of the other app.

Choose the account, leave a possible match unchecked unless you mean to add it, and confirm. One confirmed file creates the selected transactions once. Confirming the same selection again does not add them a second time. A different selection after confirmation is refused. Undo removes rows that were not edited, reconciled, locked, or tied to a receipt. A category created for the import is archived only when nothing else uses it.

## Activity

Record an expense, income, refund, transfer, or card payment. Split an expense across categories. Each split can stay Ours or name a current member. The split amounts still have to add up to the transaction, and naming an owner does not change that total or count the purchase twice. A card payment is not a second expense. A refund lowers spending and is not income.

Attach a JPEG, PNG, or PDF receipt if you want the file kept. Open Receipts to read it. The BudgetCents server reads the file with Tesseract. The image is not sent to an external OCR service, and the phone does not read it on the device. The confidence score does not prove the total or the categories. Correct each line, add a missing line, or remove a false one, and assign a category. Several lines can share a category. Preview tax, tip, discount, and other charges before you confirm. Upload, reading, and corrections do not change cash or a saved transaction. Confirmation creates one expense with those categories. Linking can keep the existing categories or, if you allow it, replace them. Notes, tags, and a provider id stay. A reconciled transaction can receive the file and is not overwritten.

## Ahead and behind

Forecast shows cash you already have. A second line can include expected income and is labeled that way. A what-if copies the forecast and does not post.

Debts can be ordered smallest-balance-first or highest-APR-first. A paid-off minimum stays in the monthly debt budget. Debts can also save an extra-payment plan or a refinance comparison. Saving or calculating that plan does not change the loan or Ready to Assign. A payment you record is a separate step. The schedule is a monthly model, not a lender quote. A lower payment is not savings when the longer loan costs more.

Goals point at one envelope. The available amount is the progress, so it is not also free to spend.

## Other people

Invite someone by email. They must accept with that same address. Private accounts stay hidden from them, including on net worth and in a backup. You can also add a personal space only you see, or a business space with its own plan.

Home has a household ownership activity view. All shows records you may see, Mine uses your ownership label, Ours uses shared ownership, and Yours asks which other member. The summary uses posted income and spending after refunds for the displayed dates. When a purchase has split owners, Mine, Yours, and Ours count only those portions. Shared budget assignments and Ready to Assign stay combined. A transaction with no split owner still uses its whole-transaction label.

In Activity, open Manage people for a transaction to change its ownership label or reviewer. Changing the reviewer requests a new review, including when you choose Unassigned. Choose Assigned to me to see your unfinished reviews. Mark reviewed records the person and time; Reopen review keeps the audit history. A reviewer needs a role that can review and existing access to that record. A read-only member cannot be assigned a review. If the reviewer leaves, is removed, or becomes read-only, unfinished work returns to Unassigned. Labels and assignments do not reveal private accounts or alter money.

## Alerts

Open Alerts from Planning, or from More on a narrow window. The settings belong to you in this household. Another member has a separate copy. They do not change a transaction, a balance, an assignment, or a total.

You can watch bills, trials, renewals, low balance, a projected overdraft, large transactions, unusual spending, overspending, missing expected pay, underfunded goals, debt milestones, and a card reserve gap. A trial or renewal is used only when that date is saved. Unusual spending waits until the category has two earlier months. A goal without a target date is skipped. Price increases, credit-bureau changes, and a broken bank connection appear only after a connected provider stores that event. BudgetCents does not invent those events. A background refresh does not check alerts again.

Quiet hours can cross midnight. The end minute is not included. A digest waits for the next local time you chose. A clock time that does not exist when daylight saving starts is skipped. Snooze and a digest keep the same alert instead of making another one. Checking again does not repeat an unchanged condition. Mark read, snooze, or resolve from the history. Resolve does not bring the same condition back.

In app is the channel that delivers from the ledger. Email, SMS, and remote push can store consent and a test-sink result. Accepted by that sink is not proof that a person received the message. Quiet hours hold the test instead of sending it. Opting out stops that channel. The development outbox is not email delivery. A notification the Android app creates on the phone is not remote push, and the lock screen shows a generic line. Live SMTP, SMS, and push stay off until those providers are configured.

An alert link opens the related record after you are signed in and only when you can still see it. A private account, payee, amount, or id is not shown to someone else. Hide amounts masks the figure on the page. If you are offline, the page says so and does not save. If someone saves newer settings first, your unsaved copy stays and you can load the saved one.

## Assistant and connections

The assistant repeats figures the ledger already calculated. If a figure is missing, it says so. Turning it off leaves the plan and the register working. On the web and on Android, a proposal for a transaction, category, tag, rule, goal, or plan assignment shows the fields before anything is saved. Confirm writes it once. Confirming the same proposal again is refused. If you edit the fields after the preview, confirm waits for a new preview. Undo removes that change only while it is still the one the action wrote and, for a transaction, while it is not reconciled or locked. A person with read-only access cannot preview a change. A contributor cannot preview a plan, goal, or category change.

Help searches articles written for BudgetCents. Learn also keeps tour steps and a practice answer on your account. Checking the practice answer does not post a transaction. Saving a support request stores it, including a small text or image file. Closing it is your status. It does not mean a person has replied, and it is not an appointment.

Connections lists what is live. Connect sandbox imports the built-in test history into Sandbox Checking. Sync updates a pending line to posted and adds the next fixture. Repeating the same bank id does not add a second row. Revoking stops further imports until you reconnect. That history is not your bank. A stored price, credit, or connection event does not create a transaction. A cancellation, transfer, booking, tax, or estate request is stored as authorization only. It is not a completed service. A credit score you add is manual. A retirement month and a tax lot are records you enter. They do not post to the register. Fund look-through stays empty until licensed holdings are configured.

## Your account

Settings changes theme, hides amounts, manages the authenticator, lists sessions, downloads a backup, and can delete the account. Turning the authenticator on or off asks for the password again. A recovery code is shown once and works once. Another session can be signed out from the list. Deletion asks for the password and the word DELETE. It removes the server account. Signing out, or removing the app, does not. A household you own with other members stays until ownership is transferred. Mail for verification and reset stays in the server outbox until email delivery is configured and tested. Sign in with an identity provider is available when the server has an issuer, client id, and secret. A local test provider can complete that exchange. The callback checks the signature, the audience, and the one-time sign-in state. An existing email is not signed in until you enter that account’s password. An authenticator code is still required when it is turned on. The return path can bring you back to an invitation, and the sign-in does not accept it. Production provider credentials may still be absent.
