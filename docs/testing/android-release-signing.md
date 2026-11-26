# Android Release 签名配置与开发者身份验证说明

## 一、为什么安装 APK 会提示“开发者身份未验证”

Android 侧载安装出现“开发者身份未验证 / Unknown developer / Unverified developer”通常由**两层原因**共同触发：

1. **构建层：Release APK 使用了 Debug Keystore 签名（工程缺陷，已修复）**
   - 此前 `packages/mobile/android/app/build.gradle` 将 `buildTypes.release` 硬编码为 `signingConfig signingConfigs.debug`。
   - Android 系统、Play Protect 及国内各手机厂商安装器会直接把调试签名识别为不可信开发包。
2. **系统 / 分发层：OS 与厂商级开发者身份核验（需要开发者账号备案）**
   - 从 **Android 15 / 16+ Google Android Developer Verification** 以及国内主流厂商（小米 HyperOS、OPPO ColorOS、vivo OriginOS、华为 HarmonyOS 等）的安全安装策略开始，即使包体已经使用了自签名 Release Keystore，**未在对应开发者平台备案绑定“包名 (`com.hermesflux.app`) + 正式发布证书 SHA-256 指纹”的侧载 APK**，系统安装器仍可能弹窗提示开发者身份未验证或风险应用。
   - 因此，**先启用固定 Release Keystore 签名**，再把同一份正式证书的 **SHA-256 指纹** 登记到 Google Play Console / Android Developer Verification 或各厂商开放平台，才能彻底消除警告并保障后续版本覆盖升级签名一致。

---

## 二、生成本地 Release Keystore（仅需执行一次）

使用 JDK 自带的 `keytool` 生成 `.keystore`（请妥善备份文件与口令；一旦丢失，已安装旧版的设备将无法覆盖升级）：

```bash
keytool -genkeypair -v \
  -keystore packages/mobile/android/release.keystore \
  -alias hermes-flux-release \
  -keyalg RSA -keysize 2048 -validity 10000
```

> `*.keystore`、`*.jks` 与 `keystore.properties` 均已被 [`packages/mobile/android/.gitignore`](../../packages/mobile/android/.gitignore) 忽略，严禁强制 `git add -f`。

---

## 三、两种配置方式（任选其一）

### 方式 1：本地 `keystore.properties`（推荐个人本地打包）

```bash
cp packages/mobile/android/keystore.properties.example packages/mobile/android/keystore.properties
```

填入：

```properties
storeFile=release.keystore
storePassword=你的密钥库密码
keyAlias=hermes-flux-release
keyPassword=你的别名密码
```

### 方式 2：环境变量注入（推荐 CI / 自动化脚本）

在环境变量（或 `.env` 并通过 `--env-file` / CI Secret 注入）中设置：

- `ANDROID_KEYSTORE_PATH`（keystore 文件路径，绝对路径或相对 `packages/mobile/android`）
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

未配置上述任意一项时，`assembleRelease` 与 `npm run package:mobile:android`（或 `packages/mobile` 下的 `npm run build:android`）会显式打印告警并安全降级回 `signingConfigs.debug`，保证本地调试构建不阻塞。

若需阻断未签名包流入正式发布（CI 或发版场景），请使用严格模式（缺失凭据或产物证书仍为 `CN=Android Debug` 时立即非零退出）：

```bash
# 方式 A：仓根一键严格打包
npm run package:mobile:android:release

# 方式 B：注入环境变量严格门禁
FLUX_REQUIRE_SIGNING=1 npm run package:mobile:android

# 方式 C：全端统一体检
npm run signing:check -- --platform=android --strict
```

> 更多 iOS / macOS / Windows 四端签名与公证配置见 [`cross-platform-release-signing.md`](cross-platform-release-signing.md)。

---

## 四、查看正式证书 SHA-256 指纹（用于平台认证 / 备案）

```bash
keytool -list -v -keystore packages/mobile/android/release.keystore -alias hermes-flux-release
```

或在打包完成后直接校验证书：

```bash
apksigner verify --print-certs packages/mobile/release/Hermes-Flux-0.1.0-release.apk
```

将输出中的 **`SHA-256`** 指纹与包名 `com.hermesflux.app` 提交至 Google Developer Verification / 各厂商开放平台完成开发者身份认证绑定即可。
