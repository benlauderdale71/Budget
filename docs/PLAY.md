# Android release

The project is `android/`. Application id `com.budgetcents.app`. Version `1.0.0` (`versionCode` 1).

## SDK

Checked against Google Play’s target API page on November 10, 2026: new phone and tablet apps must target Android 16 (API 36). The extension window cited on that page ended November 1, 2026. This project sets `compileSdk` and `targetSdk` to 36 and `minSdk` to 26.

The release built on November 10, 2026 with Android Gradle Plugin 8.13.0, Gradle 8.13, and Kotlin 2.0.21. That plugin release supports API 36. The command `./gradlew assembleRelease bundleRelease` completed with exit code 0 against the installed Android 36 platform. The log for that run did not print the older warning that plugin 8.7.3 was tested only through compile SDK 35. No emulator or device was available in the build environment, so the release binary was not launched.

## Artifacts

`./gradlew assembleRelease` writes `android/app/build/outputs/apk/release/app-release.apk`.

`./gradlew bundleRelease` writes `android/app/build/outputs/bundle/release/app-release.aab`.

Both are signed with the keystore from `BUDGETCENTS_KEYSTORE` or `~/budgetcents-release.jks`, alias `budgetcents`. The keystore used for the build in this workspace is a development key. It is not in git. Replace it with the key you will enroll in Play App Signing before you upload. These files are not published to Google Play.

## What the app does

It is a native client, not a website shortcut. It signs in to the BudgetCents API, including the sample household, and shows Home, Plan, Activity, Wealth, and More. More opens accounts, categories, bills, paycheck planning, goals, debts, forecasts, investments, retirement, reports, rules, household sharing, connections, security, lessons, the assistant, and CSV import. Activity asks for an account before saving and can edit a transaction’s payee and amount with the stored version. It can assign a category, attach a JPEG or a selected file, queue an expense when the network fails, and replay that queue on a background thread for the signed-in user. It can lock the screen with biometrics when the device has them, post an in-app alert as a notification, open `budgetcents://` links for the tabs and the screens above, and place a home-screen widget. Light, dark, and system themes are available. Privacy mode hides amounts in the app and the widget. The session token is stored with encrypted shared preferences.

Those Android screens are in the release binary. They were not clicked through on an emulator in this environment. See `docs/REQUIREMENTS.md` for what is still partial.

## Play Console, not filled in here

This repository does not create a Play listing. Before anyone submits the AAB they still need:

- A Play Console app and the real upload key.
- A privacy policy URL. The app serves `/privacy`. It describes the bearer token, household records, optional receipt photos, and the fact that bank and credit providers are not connected.
- Data safety: financial info the user enters, account identifiers, and photos if they attach receipts. No advertising id. Data is not sold. Declare financial features as user-entered records. Do not declare live bank linking, credit monitoring, or money movement while those providers are disconnected.
- An account-deletion URL and an in-app path. `/delete-account` explains the steps. Settings on the web and Security on Android call `DELETE /api/me` after the password and the confirmation word. Removing the app from a phone only clears that device’s session.
- Screenshots from a device or emulator running this app, a feature graphic, and a content rating.
- Confirmation that cleartext HTTP is acceptable only for local testing. Production traffic should be HTTPS.

Do not mark the store listing as published from this repository.
