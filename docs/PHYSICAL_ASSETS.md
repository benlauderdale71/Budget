# Physical assets — Budget HQ PRO

Open **Physical assets** in the sidebar, **More** on mobile, or from **Wealth**.

## Inventory

Add and edit belongings with a custom category, location, make/model, serial/VIN, condition, quantity, tags, purchase date, unit purchase price and notes. Search these fields, filter by category/location, group by category/location and sort by name/value. Archive and restore records without losing their history. Values are per item; the inventory total multiplies by quantity. Missing values remain missing. Inventory estimates are separate from ledger balances and account-based net worth to prevent double counting assets already represented by accounts.

New assets are private by default. An owner may share them with the household. Existing finance write roles may edit shared assets; only the asset owner can change visibility. Original files are always uploader-only, including multi-item documents attached to shared assets. Private items are excluded from other members' lists and exports.

## Files and import review

Supported: PNG, JPG/JPEG, WebP, PDF (text or scanned), XLS, XLSX, CSV, TSV, TXT and JSON. Maximum 8 MB/file, 8 PDF pages, 500 assets/import, 20 upload previews/hour/user. Workbooks retain existing spreadsheet reader row/cell/memory/time limits. Asset documents have a 100 MB household quota.

Use columns **Name, Category, Location, Brand, Model, Serial number, Condition, Quantity, Purchase price, Purchase date, Estimated value, Source, Source URL, As of, Tags, Notes**. Only Name is required; dates use YYYY-MM-DD and amounts use household currency. Plain text accepts one item per line. JSON accepts an array or an object with an `assets` array. A CSV template is available in the import screen.

Every sheet/page is read. Categories are keyword suggestions, editable before save. OCR reads text, not object identity: an unrecognized photo becomes a filename-based draft with a warning. There is no visual model recognition or inferred appraisal. Original files are retained. Preview rows preserve original fields and extracted text; nothing is added to the inventory until a reviewed selection is confirmed. Rows with warnings need individual review; clean rows can be reviewed together. Repeated confirmations and repeated uploads of the same file by the same user do not duplicate assets. A different file containing the same items still requires user review.

Upload previews expire after 24 hours. Expired previews and unattached documents are cleaned on the next upload in that household. Attached files may be removed; unreferenced original file content is deleted. Household/user deletion cascades to their records and files.

## Optional value research

The asset details page opens web searches, eBay sold/asking listings, and category-specific Kelley Blue Book or Zillow tools. Only the editable search description goes to the chosen site when the user clicks. This is assisted research; no external valuation API or automatic quote retrieval is configured.

Record an estimated unit value, as-of date, source name, optional http/https link, basis (personal estimate, sold comparable, asking price, appraisal or replacement cost) and notes. Older estimates remain in history; the latest valuation date determines the displayed estimate. Record edits and estimate writes check a version to avoid overwriting concurrent changes. Asking prices and replacement costs are explicitly labeled and should not be treated as completed resale prices.

CSV exports current fields/latest values; JSON also includes estimate history. Reimport reviews the latest value and does not restore the complete history. File bytes are downloaded separately. Exports cover every asset visible to the user, including archived assets; Show amounts must be enabled. Spreadsheet formula prefixes are escaped in CSV.

## Validation

API tests cover permission boundaries, original-file access, stale writes, history, ledger invariance, atomic review, concurrent confirmation, duplicate uploads, export/reimport and deletion cascades. Reader tests use real CSV/TSV/TXT/JSON/XLS/XLSX/PDF/image fixtures. The existing bill reader still uses its original header handling unless the asset header callback is explicitly supplied.

This release adds the inventory to the web app and installed web app. The separate native Android client keeps its Budget HQ PRO branding; its inventory screen is not part of this change.
