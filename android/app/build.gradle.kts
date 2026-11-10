plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.budgetcents.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.budgetcents.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    val productionKeystore = System.getenv("BUDGETCENTS_KEYSTORE")
    val productionStorePassword = System.getenv("BUDGETCENTS_STORE_PASSWORD")
    val productionAlias = System.getenv("BUDGETCENTS_KEY_ALIAS")
    val productionKeyPassword = System.getenv("BUDGETCENTS_KEY_PASSWORD")
    val productionSigning = listOf(productionKeystore, productionStorePassword, productionAlias, productionKeyPassword).all { !it.isNullOrBlank() }

    signingConfigs {
        create("development") {
            val store = System.getenv("BUDGETCENTS_DEV_KEYSTORE") ?: "${System.getProperty("user.home")}/budgetcents-release.jks"
            storeFile = file(store)
            storePassword = System.getenv("BUDGETCENTS_DEV_STORE_PASSWORD") ?: "budgetcents-dev"
            keyAlias = System.getenv("BUDGETCENTS_DEV_KEY_ALIAS") ?: "budgetcents"
            keyPassword = System.getenv("BUDGETCENTS_DEV_KEY_PASSWORD") ?: "budgetcents-dev"
        }
        if (productionSigning) {
            create("production") {
                storeFile = file(productionKeystore!!)
                storePassword = productionStorePassword
                keyAlias = productionAlias
                keyPassword = productionKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (productionSigning) signingConfig = signingConfigs.getByName("production")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        create("devRelease") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("development")
            matchingFallbacks += listOf("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

gradle.taskGraph.whenReady {
    val production = listOf("BUDGETCENTS_KEYSTORE", "BUDGETCENTS_STORE_PASSWORD", "BUDGETCENTS_KEY_ALIAS", "BUDGETCENTS_KEY_PASSWORD").all { !System.getenv(it).isNullOrBlank() }
    val wantsProduction = allTasks.any { it.name == "assembleRelease" || it.name == "bundleRelease" || it.name == "packageRelease" || it.name == "signReleaseBundle" }
    if (wantsProduction && !production) {
        throw GradleException("A production release needs BUDGETCENTS_KEYSTORE, BUDGETCENTS_STORE_PASSWORD, BUDGETCENTS_KEY_ALIAS, and BUDGETCENTS_KEY_PASSWORD. It does not use the development keystore. Use assembleDevRelease or bundleDevRelease for a locally signed build.")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
