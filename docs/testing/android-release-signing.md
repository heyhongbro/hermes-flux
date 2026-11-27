# Android Release Signing & Developer Verification Guide

## 1. Why Sideloaded APKs Show "Unverified Developer"

Two separate layers control whether Android trusts an installed APK:

1. **Build Layer: Release APK Signed with Debug Keystore (Fixed in Repo)**
   - Previously `packages/mobile/android/app/build.gradle` hardcoded `signingConfig signingConfigs.debug` in `buildTypes.release`.
   - Android, Google Play Protect, and OEM package installers automatically reject or warn on debug-signed builds.
2. **OS / Distribution Layer: Platform Developer Identity Registration**
   - Under **Android 15/16+ Google Android Developer Verification** and OEM security policies (Xiaomi HyperOS, OPPO ColorOS, vivo OriginOS, Huawei HarmonyOS, etc.), even a properly signed release APK triggers an unverified developer prompt during sideloading unless the pair **`com.hermesflux.app` + release certificate SHA-256 fingerprint** is registered with those developer consoles.
   - Always sign releases with a persistent Release Keystore and register its **SHA-256 fingerprint** to enable smooth future upgrades without signature mismatches.

---

## 2. Generate a Release Keystore (One-Time Setup)

Generate a `.keystore` using JDK `keytool` and back up both the keystore file and passwords securely (losing them prevents upgrading existing installs):

```bash
keytool -genkeypair -v \
  -keystore packages/mobile/android/release.keystore \
  -alias hermes-flux-release \
  -keyalg RSA -keysize 2048 -validity 10000
```

> `*.keystore`, `*.jks`, and `keystore.properties` are ignored by [`packages/mobile/android/.gitignore`](../../packages/mobile/android/.gitignore) and must never be committed to Git.

---

## 3. Configuration Options (Choose One)

### Option 1: Local `keystore.properties` (Recommended for Local Builds)

```bash
cp packages/mobile/android/keystore.properties.example packages/mobile/android/keystore.properties
```

Fill in:

```properties
storeFile=release.keystore
storePassword=YOUR_KEYSTORE_PASSWORD
keyAlias=hermes-flux-release
keyPassword=YOUR_KEY_PASSWORD
```

### Option 2: Environment Variables (Recommended for CI / Automation)

Set these variables in your environment (or `.env` / GitHub Secrets):

- `ANDROID_KEYSTORE_PATH` (absolute path or relative to `packages/mobile/android`)
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

When any field is missing, `assembleRelease` and `npm run package:mobile:android` (or `npm run build:android` in `packages/mobile`) print a warning and fall back to `signingConfigs.debug` so local development builds remain unblocked.

For release builds (strict fail-closed verification that exits non-zero if credentials are missing or the output still uses `CN=Android Debug`):

```bash
# Option A: Root workspace strict release command
npm run package:mobile:android:release

# Option B: Strict mode via environment variable
FLUX_REQUIRE_SIGNING=1 npm run package:mobile:android

# Option C: Check readiness across platforms
npm run signing:check -- --platform=android --strict
```

> See [`cross-platform-release-signing.md`](cross-platform-release-signing.md) for iOS, macOS, and Windows signing instructions.

---

## 4. Inspect Release Certificate SHA-256 Fingerprint

```bash
keytool -list -v -keystore packages/mobile/android/release.keystore -alias hermes-flux-release
```

Or verify the packaged APK directly:

```bash
apksigner verify --print-certs packages/mobile/release/Hermes-Flux-0.1.0-release.apk
```

Submit the **`SHA-256`** fingerprint together with package ID `com.hermesflux.app` to Google Developer Verification and OEM app consoles.
