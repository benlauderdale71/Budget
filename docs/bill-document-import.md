# Bill document import

Open **Bills → Upload bills from a file**, or the bill-upload link on **Import**.
The browser supports PNG, JPG/JPEG, WebP, PDF, CSV, XLS and XLSX. The same page
works at phone width. This does not add a native Android upload screen.

The uploader reads the document into a private preview. Review and edit each
name, amount, first due date, repeat frequency, account, category and reference
note; select the schedules to add; then acknowledge the review and confirm.
Changing a value clears the acknowledgment. Offline saving is disabled.

- Ordinal days such as `1st` use the chosen starting month. A `31st` anchor is
  retained when a short month ends earlier. Blank or unreadable dates need input.
- Bills and subscriptions become outflow schedules. Income requires an explicit
  date and selection and becomes an expected inflow schedule, never posted cash.
- Totals are excluded. Variable spending estimates are not scheduled unless the
  user explicitly changes their type and supplies a date.
- Zero amounts are flagged. Negative, missing or fractional-cent amounts cannot
  be confirmed. This importer supports currencies with two decimal places and
  does not convert currency.
- Payment method, Paid, notes, balance owed, unknown columns and cached formula
  references are retained as reference details. They do not initiate autopay,
  settle a bill, create a debt, or change transactions, balances or assignments.
- Images use local Tesseract and Sharp. PDFs use Poppler, with OCR for scanned
  pages. No external document/AI provider receives the upload. OCR is imperfect;
  image readings are never preselected. Full extracted text remains available
  for spotting missing rows and adding them manually.
- XLS/XLSX parsing runs in a worker with a time and memory limit. Excel date
  serials are decoded without a server-time-zone conversion. Formulas and macros
  are not executed. Cached values can be stale and require review.

Limits: 8 MB per file; 8 PDF pages (every page is processed); 10 workbook sheets;
1,000 data rows and 60 columns per sheet; 20,000 filled workbook cells;
4,000 characters per spreadsheet cell; 500 recognized items; 600,000 extracted
characters. The server permits two simultaneous document readers and 20 saved
previews per uploader per hour. Unsupported, encrypted or oversized documents
fail with a message; unrecognized pages/sheets are explicitly reported.

Preview records expire after seven days and are readable only by their uploader
while that person still has access. Original binary files are temporary and are
removed after reading. Saved reference details follow the schedule's account
visibility. Schedules without an account are shared; the review page explains
this before confirmation. Hidden-amount mode hides extracted details as well.

Confirmation rechecks household role, space, account and category access while
holding the household transaction lock. Every selected schedule and its reference
record is saved together, or all writes roll back. Retrying the same confirmed
preview returns its previous result; changing a committed selection returns 409.
Existing matching name/type/amount/frequency/due-day/account combinations are
skipped, including repeat uploads and duplicates within one file. Matching is
limited to schedules the uploader can see and never overwrites an existing bill.

API routes:

- `POST /api/households/:hid/bill-imports`: multipart `file`, `spaceId`, `month`
  (`YYYY-MM`), optional default `accountId`; returns the private preview.
- `GET /api/households/:hid/bill-imports/:draftId`: uploader-only preview/result.
- `POST /api/households/:hid/bill-imports/:draftId/confirm`: reviewed selection.
- `GET /api/households/:hid/schedules/:scheduleId/import-details`: visible saved
  schedule's reference details, or `details: null` for a manually created bill.

Automated coverage uses synthetic fixtures only: mixed table separation, original
cells, short months, ambiguous OCR, invoice credits, PDF/image readers, actual
XLS/XLSX files, bounds, atomic rollback, idempotency, account privacy, role removal,
and unchanged financial records. User-uploaded financial files are not fixtures.
