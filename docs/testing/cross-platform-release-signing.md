# 全平台（Android / iOS / macOS / Windows）发行签名与开发者认证总览

## 一、四端安装拦截机制全景对照

不同操作系统的安装包在未完成**代码签名 + 官方开发者认证 / 公证**时，均会触发或强或弱的安全拦截。以下列出“工程构建层”与“平台开发者认证层”的完整对照：

| 平台 | 未认证时的系统真实提示 | 工程构建层原因（本仓已修复） | 平台 / 外部认证层条件（需开发者账号与证书） |
| --- | --- | --- | --- |
| **Android** | 侧载安装提示“开发者身份未验证 / Unknown developer”或拦截安装 | 未配置 Release Keystore 时回落 Debug 证书；已支持 `--require-signing` 阻断并自动打印 `SHA-256` | 1. 固定 Release Keystore 签名；<br>2. 在 **Google Android Developer Verification** 与国内主流厂商开放平台登记 `com.hermesflux.app` + 证书 **SHA-256 指纹** |
| **iOS** | 未越狱真机无法直接侧载安装；开发/企业包提示“未受信任的开发者”，免费签名 7 天失效 | 原工程缺少分发导出流水线且 `pbxproj` 遗留已废弃的 `iPhone Developer`；已修复并新增 `build-ios.mjs` + `ExportOptions.plist` | 1. 需付费 **Apple Developer Program（$99/年）**；<br>2. 通过 **App Store Connect / TestFlight** 分发即可彻底消除未受信任提示（Ad-Hoc 限 100 台 UDID，Enterprise 仍需用户手动信任） |
| **macOS** | Gatekeeper 提示“无法验证开发者”、“Apple 无法检查是否包含恶意软件”或“已损坏” | 原 `electron-builder.json` 缺失 Hardened Runtime / `entitlements.mac.plist` 与公证流水线；已补齐并新增 `package-mac.mjs` | 1. **Apple Developer ID Application** 证书（$99/年）；<br>2. 完成 **Apple Notarization（公证）** 并装订（Staple）票据至 `.app` / `.dmg` |
| **Windows** | Microsoft Defender SmartScreen 提示“Windows 已保护你的电脑 / 未知发布者” | 原 `electron-builder.json` 未配置 SHA-256 + RFC3161 时间戳，且缺少严格签名与校验门禁；已补齐 | 1. 推荐 **Microsoft Azure Artifact Signing（原 Trusted Signing）** 或 **EV 代码签名证书**（即刻获得 SmartScreen 信任）；<br>2. 普通 OV `.pfx` 需随下载量逐步积累 SmartScreen 声誉；或上架 Microsoft Store |

> **关键区分**：代码本身只能决定**“绝不静默产出未签名或调试签名包”**与**“正确挂载正式签名、Hardened Runtime、Entitlements、Timestamp 和公证流水线”**；真正向终端设备证明开发者身份的私钥证书、Apple Developer Program 资格、Google/厂商 SHA-256 备案及 Azure/EV 证书仍必须由项目所有者申请并在本地 `.env` / GitHub Actions Secrets 中注入。

---

## 二、一键诊断当前签名就绪度

在仓根执行：

```bash
# 查看四端配置现状与缺失项（纯只读，绝不打印密码或私钥内容）
npm run signing:check

# 机器可读 JSON 输出
npm run signing:check -- --json

# 严格模式：任一端未达到可发布态（含 macOS 未配置公证）即退出码 1
npm run signing:check -- --strict

# 仅检查单个平台（android / ios / macos / windows）
npm run signing:check -- --platform=windows --strict
```

---

## 三、各平台详细配置与严格打包命令

### 1. Android

- **本地配置**：推荐创建被 `.gitignore` 忽略的 `packages/mobile/android/keystore.properties`（模板见 [`keystore.properties.example`](../../packages/mobile/android/keystore.properties.example)），或在 `.env` 设置 `ANDROID_KEYSTORE_PATH`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。
- **本地试打**：`npm run package:mobile:android`（未配 keystore 时打印醒目告警并回退 Debug 签名）。
- **严格发行打包**：`npm run package:mobile:android:release`（缺失正式凭据或产物仍为 `CN=Android Debug` 时立即失败退出）。
- **查看证书 SHA-256 指纹**：构建脚本会在打包完成后自动调用 `keytool -printcert -jarfile` 打印 `Owner` 与 `SHA-256`，请将该指纹与 `com.hermesflux.app` 提交至 Google / 手机厂商开发者平台备案。详见 [`android-release-signing.md`](android-release-signing.md)。

### 2. iOS

- **本地配置**：复制并填写被忽略的 `packages/mobile/ios/signing.local.xcconfig`（模板见 [`signing.local.xcconfig.example`](../../packages/mobile/ios/signing.local.xcconfig.example)），或在环境变量中注入：
  - `IOS_DEVELOPMENT_TEAM`（或 `APPLE_TEAM_ID`）
  - `IOS_SIGNING_STYLE=automatic`（或 `manual` 搭配 `IOS_CODE_SIGN_IDENTITY`、`IOS_PROVISIONING_PROFILE_SPECIFIER`）
  - `IOS_EXPORT_METHOD=app-store-connect`（可选 `ad-hoc` / `enterprise` / `development`）
  - 可选自动化认证：`APPLE_API_KEY`（`.p8` 路径或 base64）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`
- **命令**（需在 macOS / `MAC_RUNNER_SSH` / GitHub Actions `macos-latest` 执行）：
  - `npm run package:mobile:ios`（自动检查；未配 Team ID 时仅做 `CODE_SIGNING_ALLOWED=NO` 编译校验）
  - `npm run package:mobile:ios:release`（强制正式签名并导出 `.ipa`，随后执行 `codesign -dv --verbose=2` 校验证书）

### 3. macOS Desktop

- **已配置工程资产**：
  - [`packages/desktop/build/entitlements.mac.plist`](../../packages/desktop/build/entitlements.mac.plist)：声明 Electron V8 JIT、未签名可执行内存与网络权限，满足 Hardened Runtime 要求；
  - [`packages/desktop/electron-builder.json`](../../packages/desktop/electron-builder.json)：已启用 `hardenedRuntime: true` 与 entitlements。
- **所需环境变量**：
  - 代码签名：`CSC_LINK`（`.p12` 路径或 base64）+ `CSC_KEY_PASSWORD`，或本机 Keychain 中的 `CSC_NAME`；
  - Apple 公证（三选一）：
    1. **App Store Connect API Key（推荐 CI）**：`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`；
    2. **Apple ID**：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；
    3. **本机 Keychain Profile**：`APPLE_KEYCHAIN_PROFILE`。
- **命令**（需在 macOS 主机运行）：
  - `npm run package:desktop:mac`
  - `npm run package:desktop:mac:release`（要求同时满足签名 + 公证，并自动运行 `codesign --verify --deep --strict`、`spctl --assess` 与 `xcrun stapler validate`）

### 4. Windows Desktop

- **已配置工程资产**：
  - [`packages/desktop/electron-builder.json`](../../packages/desktop/electron-builder.json)：`win.signtoolOptions` 已锁定 `signingHashAlgorithms: ["sha256"]` 与 RFC3161 时间戳服务器 `http://timestamp.digicert.com`。
- **三种签名方式（三选一）**：
  1. **Azure Artifact Signing（推荐，直接获得 SmartScreen 信任）**：`AZURE_SIGNING_ENDPOINT`、`AZURE_SIGNING_ACCOUNT_NAME`、`AZURE_SIGNING_CERT_PROFILE_NAME`、`AZURE_SIGNING_PUBLISHER_NAME` + Entra 凭据（`AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` / `AZURE_FEDERATED_TOKEN_FILE` / `AZURE_USE_CLI_AUTH=1`）；
  2. **PFX/P12 证书**：`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`；
  3. **本机证书存储 / EV 硬件加密狗**：`WIN_CSC_SHA1` 或 `WIN_CSC_SUBJECT_NAME`。
- **命令**：
  - `npm run package:desktop:win`（便携绿色 zip；未配置证书时给出 SmartScreen 警告但不阻塞本地开发）
  - `npm run package:desktop:win:release`（严格构建 NSIS 安装包，启用 `forceCodeSigning: true`，并在 Windows 上调用 `Get-AuthenticodeSignature` 验证状态必须为 `Valid`）

---

## 四、GitHub Actions 统一发布流水线

仓库已配置 [`.github/workflows/release-build.yml`](../../.github/workflows/release-build.yml)：
- 推送 `v*.*.*` 标签或手动触发 `workflow_dispatch` 时，自动并行构建并签发 Android APK、iOS IPA、macOS DMG/ZIP、Windows NSIS Setup；
- 在 GitHub Repository Secrets 中录入对应平台的变量后，即可一键产出全端已签名/已公证安装包。
