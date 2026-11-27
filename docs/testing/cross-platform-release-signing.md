# Cross-Platform Release Signing & Developer Verification Overview

## 1. Platform Installation Warnings & Verification Matrix

Installers and mobile packages across Android, iOS, macOS, and Windows trigger OS security warnings unless signed with valid release credentials and registered/notarized with the respective platform ecosystems:

| Platform | OS Warning Without Verification | Build-Layer Cause (Handled in Repo) | Platform / External Requirement (Developer Credentials) |
| --- | --- | --- | --- |
| **Android** | Sideload prompt: "Unknown developer / Unverified developer" or blocked install | Debug keystore fallback when release keystore is unset; `--require-signing` now fails closed and prints `SHA-256` | 1. Stable Release Keystore;<br>2. Register `com.hermesflux.app` + certificate **SHA-256 fingerprint** in **Google Android Developer Verification** and OEM app stores |
| **iOS** | Cannot sideload onto unjailbroken devices; ad-hoc/dev builds expire or show "Untrusted Developer" | Missing export pipeline and deprecated `iPhone Developer` setting in `pbxproj`; fixed via `build-ios.mjs` + `ExportOptions.plist` | 1. **Apple Developer Program ($99/year)**;<br>2. Distribute via **App Store Connect / TestFlight** (Ad-Hoc is capped at 100 UDIDs; Enterprise requires manual trust) |
| **macOS** | Gatekeeper warning: "Developer cannot be verified", "Apple cannot check it for malicious software", or "App is damaged" | Missing Hardened Runtime, `entitlements.mac.plist`, and notarization flow in `electron-builder.json`; fixed via `package-mac.mjs` | 1. **Apple Developer ID Application** certificate ($99/year);<br>2. **Apple Notarization** with stapled ticket on `.app` / `.dmg` |
| **Windows** | Microsoft Defender SmartScreen: "Windows protected your PC / Unknown publisher" | Missing SHA-256 + RFC3161 timestamping and strict signing verification; fixed in `electron-builder.json` & `package-win.mjs` | 1. **Microsoft Azure Artifact Signing (Trusted Signing)** or **EV Code Signing Certificate** for immediate SmartScreen reputation;<br>2. Standard OV `.pfx` builds reputation over download volume (or Microsoft Store) |

> **Note**: Build scripts enforce fail-closed verification (`--require-signing`), Hardened Runtime, entitlements, RFC3161 timestamping, and notarization wiring; actual signing keys, Apple Developer membership, OEM SHA-256 registrations, and Azure/EV certificates must be provisioned by the project owner via `.env` or GitHub Actions Secrets.

---

## 2. Diagnostic Command (`signing:check`)

Run from the repository root (read-only; never prints passwords or private key contents):

```bash
# Inspect signing readiness across all platforms
npm run signing:check

# Machine-readable JSON output
npm run signing:check -- --json

# Strict mode: exit code 1 if any platform is not release-ready (including macOS notarization)
npm run signing:check -- --strict

# Single-platform strict check (android / ios / macos / windows)
npm run signing:check -- --platform=windows --strict
```

---

## 3. Platform Configuration & Packaging Commands

### 1. Android

- **Local configuration**: Create gitignored `packages/mobile/android/keystore.properties` from [`keystore.properties.example`](../../packages/mobile/android/keystore.properties.example), or provide `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` via `.env`.
- **Local test build**: `npm run package:mobile:android` (warns and falls back to debug signing if unconfigured).
- **Strict release build**: `npm run package:mobile:android:release` (fails immediately if credentials are missing or the APK signs as `CN=Android Debug`).
- **Certificate SHA-256 fingerprint**: Printed automatically via `keytool -printcert -jarfile` after packaging. Register this fingerprint with `com.hermesflux.app` on Google/OEM developer consoles. See [`android-release-signing.md`](android-release-signing.md).

### 2. iOS

- **Local configuration**: Copy gitignored `packages/mobile/ios/signing.local.xcconfig` from [`signing.local.xcconfig.example`](../../packages/mobile/ios/signing.local.xcconfig.example), or set environment variables:
  - `IOS_DEVELOPMENT_TEAM` (or `APPLE_TEAM_ID`)
  - `IOS_SIGNING_STYLE=automatic` (or `manual` with `IOS_CODE_SIGN_IDENTITY` and `IOS_PROVISIONING_PROFILE_SPECIFIER`)
  - `IOS_EXPORT_METHOD=app-store-connect` (or `ad-hoc` / `enterprise` / `development`)
  - Optional App Store Connect API Key: `APPLE_API_KEY` (`.p8` path or base64), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- **Commands** (run on macOS / GitHub Actions `macos-latest`):
  - `npm run package:mobile:ios` (runs `CODE_SIGNING_ALLOWED=NO` build verification when Team ID is absent)
  - `npm run package:mobile:ios:release` (enforces release signing, exports `.ipa`, and runs `codesign -dv --verbose=2`)

### 3. macOS Desktop

- **Configured project assets**:
  - [`packages/desktop/build/entitlements.mac.plist`](../../packages/desktop/build/entitlements.mac.plist): Declares Electron V8 JIT, unsigned executable memory, and network entitlements for Hardened Runtime.
  - [`packages/desktop/electron-builder.json`](../../packages/desktop/electron-builder.json): Enables `hardenedRuntime: true` and entitlements.
- **Required environment variables**:
  - Code signing: `CSC_LINK` (`.p12` path or base64) + `CSC_KEY_PASSWORD`, or local Keychain identity `CSC_NAME`.
  - Apple Notarization (choose one):
    1. **App Store Connect API Key (recommended for CI)**: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
    2. **Apple ID**: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
    3. **Local Keychain Profile**: `APPLE_KEYCHAIN_PROFILE`
- **Commands** (requires macOS host):
  - `npm run package:desktop:mac`
  - `npm run package:desktop:mac:release` (requires signing + notarization, then runs `codesign --verify --deep --strict`, `spctl --assess`, and `xcrun stapler validate`)

### 4. Windows Desktop

- **Configured project assets**:
  - [`packages/desktop/electron-builder.json`](../../packages/desktop/electron-builder.json): Sets `win.signtoolOptions` with `signingHashAlgorithms: ["sha256"]` and RFC3161 timestamp server `http://timestamp.digicert.com`.
- **Three signing modes (choose one)**:
  1. **Azure Artifact Signing (recommended for SmartScreen trust)**: `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_SIGNING_CERT_PROFILE_NAME`, `AZURE_SIGNING_PUBLISHER_NAME` plus Entra credentials (`AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` / `AZURE_FEDERATED_TOKEN_FILE` / `AZURE_USE_CLI_AUTH=1`)
  2. **PFX/P12 certificate**: `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`
  3. **Local certificate store / EV hardware token**: `WIN_CSC_SHA1` or `WIN_CSC_SUBJECT_NAME`
- **Commands**:
  - `npm run package:desktop:win` (portable zip; prints a SmartScreen warning if unsigned)
  - `npm run package:desktop:win:release` (strict NSIS installer with `forceCodeSigning: true`, verified via `Get-AuthenticodeSignature` status `Valid`)

---

## 4. Unified GitHub Actions Release Pipeline

[`.github/workflows/release-build.yml`](../../.github/workflows/release-build.yml) triggers on pushing `v*.*.*` tags or `workflow_dispatch` to build and sign Android APK, iOS IPA, macOS DMG/ZIP, and Windows NSIS Setup installers once the corresponding repository secrets are configured.
