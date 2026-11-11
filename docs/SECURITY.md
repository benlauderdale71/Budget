# Security and privacy

This is a description of what the code does. It is not a certification, a penetration test, or a promise that a deployment is safe.

## Accounts

Passwords are stored with scrypt. Sessions and API tokens are stored as SHA-256 hashes. The browser sends `Authorization: Bearer`. There is no cookie session. Login of an unknown email still runs a password check so the response time is closer to a real account.

TOTP uses the standard 30-second window with one step of skew. Recovery codes are hashed and shown once. Resetting a password revokes sessions.

`DELETE /api/me` requires the password and the word `DELETE`. It refuses while the user owns a household that still has someone else in it.

## Households

The server decides what a person can do from the current membership row. A role in the request body or an older session is not used.

| Capability | Who has it |
|---|---|
| View shared records | Every member |
| Change financial records | Owner, admin, editor, contributor |
| Change the shared plan | Owner, admin, editor |
| Comment on a visible transaction | Every member. A comment does not change the amount, category, or balance |
| Mark a visible transaction reviewed | Owner, admin, editor, contributor, coach, planner, accountant. Read-only cannot |
| Invite, revoke, reissue, change a role, or remove a member | Owner, admin |
| Transfer ownership | Owner only. An admin cannot grant or take this role |

A person’s own dashboard layout, privacy mode, and security settings stay available when the household role cannot change money.

A private account is visible only to `owner_user_id`. An admin, a coach, a planner, or an accountant does not override that. The same check is used for the dashboard, net worth, activity, reports, forecasts, investments, search, the assistant, CSV, PDF, backup, widgets, direct edits, and holdings. A transfer that touches a hidden account is shown to the other person as a redacted stub so the shared side of the transfer still balances, without the private balance or payee. An audit row for a private account or transaction is stored with `visibility = private` and that owner. Other members receive the action `private.change` and the summary “A private record changed.” The account name, payee, note, reason, and private id are omitted. The owner of the record still receives the original summary.

Personal spaces are limited to their owner. Invitation tokens are stored as SHA-256 hashes and are not written into audit rows. The public preview returns the household name, the proposed role, the capability list, and the disclosure. It does not return balances, transactions, or other members’ email addresses. Acceptance requires the signed-in email to match the invitation and to be verified. It runs in one transaction that locks the household and then the invitation, and it can be repeated without adding a second membership. The return path after sign-in, registration, verification, or MFA has to be a single relative path on this site.

The member limit defaults to 12. `BUDGETCENTS_MEMBER_LIMIT` can set a server cap from 6 through 100. A household can set a lower limit, still at least 6 and no higher than that cap. Pending invitations do not count. Revoking a link does not remove someone who already joined. Removing a member blocks later requests, including a transaction that was queued under the old role. Shared records stay. The last owner has to transfer ownership before leaving.

## Money and reports

Amounts are integers in minor units. The assistant answers from figures the ledger already computed and says when a figure is missing. Pasted text is not treated as an instruction to post money. Exports omit accounts the caller cannot see.

## Devices

The Android client stores the session token in encrypted shared preferences (AES-256 via the Android Keystore). Biometric unlock is optional and only gates the screen; it is not a second factor on the server. The web app stores the bearer token in `localStorage`, which is convenient and weaker than an httpOnly cookie. Treat a shared browser as a shared session.

## Attachments

Uploads are sniffed as JPEG, PNG, or PDF and rejected past 8 MB. The API reads an accepted file with local Tesseract and Poppler. The file is not sent to an external OCR service. See `docs/RECEIPTS.md`. A receipt the caller cannot access is rejected before any transaction edit. Applying a receipt does not overwrite a reconciled transaction, and a mismatched total does not change the amount unless the person accepts that difference and the transaction is not reconciled. Confirmation uses an operation id so a repeated submit does not create a second expense.

## What this does not do

There is no external audit, no bug-bounty program, and no claim of PCI or SOC compliance. Bank passwords are never requested because bank aggregation is not connected. Rate limits on register, login, and password reset are in-memory and reset when the process restarts.
