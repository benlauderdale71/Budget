# Security and privacy

This is a description of what the code does. It is not a certification, a penetration test, or a promise that a deployment is safe.

## Accounts

Passwords are stored with scrypt. Sessions and API tokens are stored as SHA-256 hashes. The browser sends `Authorization: Bearer`. There is no cookie session. Login of an unknown email still runs a password check so the response time is closer to a real account.

TOTP uses the standard 30-second window with one step of skew. Recovery codes are hashed and shown once. Resetting a password revokes sessions.

`DELETE /api/me` requires the password and the word `DELETE`. It refuses while the user owns a household that still has someone else in it.

## Households

Roles are owner, admin, editor, contributor, readonly, coach, planner, and accountant. Editors can change the plan. Contributors can record transactions. Read-only roles cannot write.

A private account is visible only to `owner_user_id`. An admin does not override that. The same filter is used for the dashboard, net worth, backup, direct edits, and holdings. A transfer that touches a hidden account is shown to the other person as a redacted stub so the shared side of the transfer still balances, without the private balance or payee.

Personal spaces are limited to their owner. Invitations store a hash of the token. The accept call checks that the signed-in email matches. A household stops at 12 members.

## Money and reports

Amounts are integers in minor units. The assistant answers from figures the ledger already computed and says when a figure is missing. Pasted text is not treated as an instruction to post money. Exports omit accounts the caller cannot see.

## Devices

The Android client stores the session token in encrypted shared preferences (AES-256 via the Android Keystore). Biometric unlock is optional and only gates the screen; it is not a second factor on the server. The web app stores the bearer token in `localStorage`, which is convenient and weaker than an httpOnly cookie. Treat a shared browser as a shared session.

## Attachments

Uploads are sniffed as JPEG, PNG, or PDF and rejected past 8 MB. The API reads an accepted file with local Tesseract and Poppler. The file is not sent to an external OCR service. See `docs/RECEIPTS.md`. A receipt the caller cannot access is rejected before any transaction edit. Applying a receipt does not overwrite a reconciled transaction, and a mismatched total does not change the amount unless the person accepts that difference and the transaction is not reconciled. Confirmation uses an operation id so a repeated submit does not create a second expense.

## What this does not do

There is no external audit, no bug-bounty program, and no claim of PCI or SOC compliance. Bank passwords are never requested because bank aggregation is not connected. Rate limits on register, login, and password reset are in-memory and reset when the process restarts.
