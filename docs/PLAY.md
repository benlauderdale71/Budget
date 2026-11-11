# Android release

The project is `android/`. Application id `com.budgetcents.app`. Version `1.0.0` (`versionCode` 1).

## SDK

Checked against Google Play’s target API page on November 10, 2026: new phone and tablet apps must target Android 16 (API 36). The extension window cited on that page ended November 1, 2026. This project sets `compileSdk` and `targetSdk` to 36 and `minSdk` to 26.

The project builds with Android Gradle Plugin 8.13.0, Gradle 8.13, and Kotlin 2.0.21. That plugin release supports API 36. No emulator or `adb` binary was available, so no Android screen was launched.

## Artifacts

`./gradlew assembleRelease` writes `android/app/build/outputs/apk/release/app-release.apk`.

`./gradlew bundleRelease` writes `android/app/build/outputs/bundle/release/app-release.aab`.

Those production tasks require `BUDGETCENTS_KEYSTORE`, `BUDGETCENTS_STORE_PASSWORD`, `BUDGETCENTS_KEY_ALIAS`, and `BUDGETCENTS_KEY_PASSWORD`. They do not fall back to a development keystore. Without all four, the build stops before it signs. `./gradlew assembleDevRelease` and `./gradlew bundleDevRelease` are the explicit development-signed builds. They use `BUDGETCENTS_DEV_KEYSTORE` or `~/budgetcents-release.jks`, alias `budgetcents`, unless `BUDGETCENTS_DEV_STORE_PASSWORD`, `BUDGETCENTS_DEV_KEY_ALIAS`, and `BUDGETCENTS_DEV_KEY_PASSWORD` override the local defaults. That development key is not a Play upload key, it is not in git, and this app is not published.

## What the app does

It is a native client, not a website shortcut. It signs in to the BudgetCents API, including the sample household, and shows Home, Plan, Activity, Wealth, and More. More opens setup, accounts, categories, bills, paychecks, a calendar, goals, debts with saved extra-payment and refinance plans, forecasts, investments, retirement, reports, rules, household sharing, connections, security, lessons, the assistant, and CSV import. Activity asks for an account before saving and can edit a transaction’s payee and amount with the stored version. It can assign a category, attach a JPEG or a selected file, queue an expense when the network fails, and replay that queue on a background thread for the signed-in user. It can lock the screen with biometrics when the device has them, post an in-app alert as a notification, open `budgetcents://` links for the tabs and the screens above, and place a home-screen widget. Light, dark, and system themes are available. Privacy mode hides amounts in the app and the widget. The session token is stored with encrypted shared preferences.

Those Android screens are in the release binary. They were not clicked through on an emulator in this environment. See `docs/REQUIREMENTS.md` for what is still partial.

## Play Console, not filled in here

This repository does not create a Play listing. Before anyone submits the AAB they still need:

- A Play Console app and the real upload key.
- A privacy policy URL. The app serves `/privacy`. It describes the bearer token, household records, optional receipt photos, and the fact that bank and credit providers are not connected.
- Data safety: financial info the user enters, account identifiers, and photos if they attach receipts. A receipt file can be read on the BudgetCents server with Tesseract. It is not sent to an external OCR service. No advertising id. Data is not sold. Declare financial features as user-entered records. Do not declare live bank linking, credit monitoring, or money movement while those providers are disconnected.
- An account-deletion URL and an in-app path. `/delete-account` explains the steps. Settings on the web and Security on Android call `DELETE /api/me` after the password and the confirmation word. Removing the app from a phone only clears that device’s session.
- Screenshots from a device or emulator running this app, a feature graphic, and a content rating.
- Confirmation that cleartext HTTP is acceptable only for local testing. Production traffic should be HTTPS.

Do not mark the store listing as published from this repository.
