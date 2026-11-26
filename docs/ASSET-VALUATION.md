# Physical asset identification and valuation

Open **Assets → Add from photo** to review several objects from one image. The photo can be uploaded without AI and split into manual records. AI-assisted review is opt-in and requires a configured provider. Each photo draft can be edited, cropped, skipped, or split into another item before confirmation. Confirmed records reference the same uploader-only original. Use quantity and deselect the duplicate when several detections represent an identical group.

Use **Help identify this item** to send a description, a close-up, or both for suggestions. A VIN lookup sends the entered VIN to NHTSA on request. Confirm the returned identification and add any missing details. Suggested grades, authenticity, and condition are unverified. Photos selected for close-up identification can be attached separately if you want to keep them with the record.

| Source | What the app shows |
| --- | --- |
| Recent fleet auction matches | U.S. completed fleet sales by model year, make, and model. Compare mileage, trim, and condition yourself. |
| Resale retailers and optional eBay Browse | Active asking prices. Separate from completed sales. |
| Optional WatchCharts | Exact reference and the provider's used-with-box-and-papers market guide. |
| Optional Numista | Exact type and issue ID by grade, for coins and banknotes. |
| Optional SportsCardsPro | Exact product ID and a supported grade, in USD. |
| Completed sales you enter | Median and range from at least three different recent sales of the same variant and comparable condition. Original currency, dates, URLs and conversion dates are retained. Frankfurter provides dated exchange rates for supported currencies. |
| Manual entry | Personal estimate, independent appraisal, or replacement value. Regulated items use private records and manual or appraisal values. |

Specialty guides cover common categories even when an automatic provider is unavailable, including powersports, watercraft, cameras and lenses. Coverage depends on the exact item and source. There is no estimate when evidence is too sparse or the reviewed sales differ widely.

Provider settings are server-only. The `.env.example` lists the environment variables. For photo or text identification, configure `ASSET_VISION_OPENAI_API_KEY`. For eBay and specialist pricing, configure credentials only after confirming production access and display rights. No credentials are bundled with the web app or Android. A resized, metadata-stripped copy of each opted-in photo is sent to the configured identification provider.

## Measure accuracy

Use `node scripts/asset-benchmark.mjs benchmark.json` against independently reviewed cases. Match each proposed object to the actual item it depicts and assign both the same `itemKey`. Use the complete variant as the identity, for example a reference and dial variant or a print run and grade. Give extraneous proposals their own keys. Keep the actual sale out of the comparables used for the estimate. Use the same currency and fee convention for the estimate and the holdout sale.

```json
[
  {
    "category": "camera",
    "expected": [
      {"itemKey":"left","identity":"verified body variant","saleMinor":60100,"currency":"USD"},
      {"itemKey":"right","identity":"verified lens variant","saleMinor":12900,"currency":"USD"}
    ],
    "observed": [
      {"itemKey":"left","identity":"verified body variant","estimateMinor":59000,"currency":"USD"}
    ]
  }
]
```

Compare exact-match precision and recall, the share of known sales for which the app returned an exact-identity estimate, and mean absolute percentage error across eligible estimates. Report coverage with error so a feature cannot look accurate by valuing only a few easy items. A small synthetic test exercises the calculations and does not establish market accuracy.
