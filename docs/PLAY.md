# Android release

The project is `android/`. Application id `com.budgetcents.app`. Version `1.0.0` (`versionCode` 1).

## SDK

Checked against Google Play’s target API page on November 10, 2026: new phone and tablet apps must target Android 16 (API 36). The extension window cited on that page ended November 1, 2026. This project sets `compileSdk` and `targetSdk` to 36 and `minSdk` to 26.

The build used Android Gradle Plugin 8.7.3, which prints a warning that it was tested through compile SDK 35. The release tasks still completed against the installed Android 36 platform and build-tools 36.0.0. Revisit the plugin before a Play upload so the toolchain matches the SDK you submit.

## Artifacts

`./gradlew assembleRelease` writes `android/app/build/outputs/apk/release/app-release.apk`.

`./gradlew bundleRelease` writes `android/app/build/outputs/bundle/release/app-release.aab`.

Both are signed with the keystore from `BUDGETCENTS_KEYSTORE` or `~/budgetcents-release.jks`, alias `budgetcents`. The keystore used for the build in this workspace is a development key. It is not in git. Replace it with the key you will enroll in Play App Signing before you upload. These files are not published to Google Play.

## What the app does

It is a native client, not a website shortcut. It signs in to the BudgetCents API, including the sample household, and shows Home, Plan, Activity, Wealth, and More. It can assign a category, save an expense, attach a JPEG receipt, queue an expense when the network fails, lock the screen with biometrics when the device has them, post an in-app alert as a notification, open `budgetcents://home`, `plan`, `activity`, or `wealth`, and place a home-screen widget. Privacy mode hides amounts in the app and the widget. The session token is stored with encrypted shared preferences.

Screens that exist on the web and not as their own Android page — import, rules, reports, retirement, debts, sharing, and provider setup — are called out in `docs/REQUIREMENTS.md`.

## Play Console, not filled in here

This repository does not create a Play listing. Before anyone submits the AAB they still need:

- A Play Console app and the real upload key.
- A privacy policy URL. Describe the bearer token, household data, optional receipt photos, and the fact that bank and credit providers are not connected.
- Data safety: financial info the user enters, account identifiers, and photos if they attach receipts. No advertising id. Data is not sold.
- An account-deletion URL or in-app path. The web app and `DELETE /api/me` delete the user after the password and the confirmation word. The Android app signs out locally; deletion of the server account is the web Settings screen in this build.
- Screenshots from a device or emulator running this app, a feature graphic, and a content rating.
- Confirmation that cleartext HTTP is acceptable only for local testing. Production traffic should be HTTPS.

Do not mark the store listing as published from this repository.
