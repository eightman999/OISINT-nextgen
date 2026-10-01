import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Supabase 接続値は local.properties（gitignore 済み）または環境変数から注入する。
// リポジトリへ値をコミットしない（spec.md §34。anon key は公開可能だが運用を Web の .env 方式に合わせる）
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun prop(name: String): String =
    (localProps.getProperty(name) ?: System.getenv(name) ?: "")

// -PdataProviderMode=live|mock で debug ビルドの既定 (mock) を上書きできる（計画書 §2.7）
val dataProviderModeOverride: String? = (project.findProperty("dataProviderMode") as String?)

// Google Play と Test Store の公開 SDK key は別の注入名で管理する。
// 空 key は既存の Unavailable 境界を維持し、credential のない CI も許容する。
val revenueCatGoogleKey = prop("REVENUECAT_PUBLIC_API_KEY").trim()
require(revenueCatGoogleKey.isEmpty() || revenueCatGoogleKey.matches(Regex("goog_[A-Za-z0-9]+"))) {
    "REVENUECAT_PUBLIC_API_KEY must be a Google Play public SDK key (goog_) or empty"
}

// Release署名資格は local.properties（gitignore済み）または CI の secret manager から注入する。
// keystore・パスワード・aliasはリポジトリへ置かない（spec.md §34）。
// 4値のいずれかが欠けた場合は署名設定を作らず「未署名のまま出力」する。
// debug keystoreへ暗黙fallbackさせない（#572 / scripts/check-native-release-readiness.mjs）。
val releaseStoreFilePath = prop("OISINT_RELEASE_STORE_FILE")
val releaseStorePassword = prop("OISINT_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = prop("OISINT_RELEASE_KEY_ALIAS")
val releaseKeyPassword = prop("OISINT_RELEASE_KEY_PASSWORD")
val hasReleaseSigningMaterial = listOf(
    releaseStoreFilePath,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).none { it.isEmpty() } && rootProject.file(releaseStoreFilePath).exists()

android {
    namespace = "com.oisint.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.oisint.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "OISINT_SUPABASE_URL", "\"${prop("OISINT_SUPABASE_URL")}\"")
        buildConfigField("String", "OISINT_SUPABASE_ANON_KEY", "\"${prop("OISINT_SUPABASE_ANON_KEY")}\"")
        buildConfigField("String", "OISINT_API_URL", "\"${prop("OISINT_API_URL").ifEmpty { "https://api.oisint.com" }}\"")
        buildConfigField("String", "OISINT_APP_URL", "\"${prop("OISINT_APP_URL").ifEmpty { "https://oisint.com" }}\"")
        buildConfigField("String", "REVENUECAT_PUBLIC_API_KEY", "\"$revenueCatGoogleKey\"")
    }

    signingConfigs {
        if (hasReleaseSigningMaterial) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFilePath)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField(
                "String",
                "DATA_PROVIDER_MODE",
                "\"${dataProviderModeOverride ?: "mock"}\"",
            )
        }
        release {
            // 資格が注入されていない環境では null（＝未署名）。debug署名は使わない。
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Releaseは常にlive境界。-PdataProviderMode=mockを指定しても、
            // 公開ビルドへMockData/MockEntitlementを混入させない。
            buildConfigField(
                "String",
                "DATA_PROVIDER_MODE",
                "\"live\"",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("main").kotlin.srcDir("src/main/kotlin")
        getByName("debug").kotlin.srcDir("src/debug/kotlin")
        getByName("release").kotlin.srcDir("src/release/kotlin")
        // Release artifactへローカルfixture実装を含めない。debug variantだけがMock factoryを提供する。
        getByName("test").kotlin.srcDir("src/test/kotlin")
        getByName("androidTest").kotlin.srcDir("src/androidTest/kotlin")
    }

    testOptions {
        unitTests.all { it.systemProperty("oisint.repo.root", rootProject.projectDir.parentFile.absolutePath) }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.window.size)

    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)

    implementation(platform(libs.supabase.bom))
    implementation(libs.supabase.auth)
    implementation(libs.supabase.postgrest)
    implementation(libs.supabase.realtime)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.revenuecat.purchases)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)
}
