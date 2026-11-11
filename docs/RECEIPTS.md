# Receipt reading

BudgetCents reads a JPEG, PNG, or PDF on the API server. The phone and the browser upload the file and review the result. They do not run OCR themselves. This is not on-device recognition, and the file is not sent to an external OCR service.

## Engine

The reader is [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) invoked through `execFile`, plus Poppler for PDFs. This environment used Tesseract 5.3.4 (leptonica 1.82.0) and Poppler 24.02.0. The language pack is English (`eng`) from the distribution’s traineddata. No other language is loaded.

Install the packages on the API host:

```bash
sudo apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils
```

`pdftotext`, `pdftoppm`, and `pdfinfo` come from `poppler-utils`. The test fixtures are drawn with Pillow (`python3-pil`). Pillow is not part of the reader and is not required in production.

Override the binaries with `BUDGETCENTS_TESSERACT`, `BUDGETCENTS_PDFTOTEXT`, `BUDGETCENTS_PDFTOPPM`, and `BUDGETCENTS_PDFINFO` when they are not on `PATH`. No bank credential, SMTP setting, wording-model key, or Android signing secret is involved.

## What the server does

`GET /api/health` reports `ocr.available`, `ocr.version`, `ocr.languages`, `ocr.pdfText`, and `ocr.onDevice`. `onDevice` is false. If Tesseract is missing, `available` is false and the note says the reader is not available. The app still accepts a file so the merchant, date, currency, and total can be typed.

An image is written to a generated directory under the system temp path and passed to Tesseract as an argument. The original filename is not a command. Tesseract first uses page segmentation mode 4. If the text has fewer than eight letters, it tries mode 1, which can use orientation detection. The stored confidence is the mean of Tesseract’s word scores that are zero or higher, rounded to four decimal places. If no such word exists, confidence is null. The server does not invent a percentage.

A PDF is limited to 8 pages. `pdftotext` reads the first three pages. If that text has at least twenty letters, the draft uses it and confidence stays null, because embedded text has no Tesseract score. Otherwise the first two pages are rasterized with `pdftoppm` and read as images. Each command stops after 20 seconds. An image side may not exceed 8,000 pixels, and the image may not exceed 12,000,000 pixels. Uploads remain capped at 8 MB. The stored name is `receipt.jpg`, `receipt.png`, or `receipt.pdf` from the sniffed type. The storage key is the household id and the attachment id.

A failed or unreadable file stays a draft. The person can type the fields. Upload, reading, retry, correction, and discard do not change cash, Ready to Assign, spending, income, net worth, or a confirmed transaction. Creating or linking an expense is a separate confirmation. Re-reading does not replace corrections, a confirmed draft, or a discarded draft.

## Production

Install the same packages on the API host. Keep `BUDGETCENTS_UPLOADS` on durable storage and back it up with the database. Leave the reader on that host. Do not point it at a third-party OCR URL. The health check is the status to show: a missing binary is an unavailable reader, not a successful connection.
