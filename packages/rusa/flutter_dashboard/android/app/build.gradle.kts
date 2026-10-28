import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Instance branding (#1191). `pnpm --filter rusa run build:android` resolves the
// application id and a generated resource directory (launcher label and icon)
// from config.yaml and passes them here; a plain `flutter build apk` keeps the
// unbranded scaffold.
val rusaApplicationId = project.findProperty("rusaApplicationId") as String? ?: "org.mek.rusa.dashboard"
val rusaBrandingRes = project.findProperty("rusaBrandingRes") as String?

android {
    namespace = "org.mek.rusa.dashboard"
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = rusaApplicationId
        minSdk = 29
        targetSdk = 34
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["rusaAppLabel"] =
            if (rusaBrandingRes != null) "@string/rusa_app_label" else "Rusa"
        manifestPlaceholders["rusaAppIcon"] =
            if (rusaBrandingRes != null) "@mipmap/rusa_launcher" else "@mipmap/ic_launcher"
    }

    if (rusaBrandingRes != null) {
        sourceSets.getByName("main").res.srcDir(rusaBrandingRes)
    }

    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("key.properties")
            if (keystorePropertiesFile.exists()) {
                val keystoreProperties = Properties()
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
                keyAlias = keystoreProperties["keyAlias"].toString()
                keyPassword = keystoreProperties["keyPassword"].toString()
                storeFile = file(keystoreProperties["storeFile"].toString())
                storePassword = keystoreProperties["storePassword"].toString()
            } else {
                initWith(getByName("debug"))
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}
