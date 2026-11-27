<p align="center">
  <img src="packages/ui/src/icons/brand/hermes-flux-badge.svg" alt="Hermes Flux" width="120" />
</p>

<h1 align="center">Hermes Flux</h1>

<p align="center">
  Cross-platform desktop and mobile workspace for Hermes Agent
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-lightgrey.svg" alt="Platforms" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.18.0-339933.svg" alt="Node.js >= 22.18.0" />
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<!-- Preview screenshots will be embedded here once media assets are ready -->

---

## Features

- **Cross-Platform Desktop & Mobile**: Native desktop (Electron 34: Windows, macOS, Linux) and mobile (Capacitor 8: iOS, Android) shells sharing the same TypeScript core (`@hermes-flux/core`) and React 19 UI (`@hermes-flux/ui`), connecting to local or remote Hermes Gateways.
- **Workspace File Tree, Multi-Format Preview & Download**: Live workspace file tree (filter, refresh, collapse) and session deliverables/artifacts list; multi-tab preview with Raw/Rendered Markdown toggle, in-file search (`Ctrl+F`), line numbers, fullscreen view, image lightbox, and streaming video playback; one-click save/download locally, open in default app, copy path/content, plus binary and >1 MB safe-download guards (including remote gateway workspaces).
- **Flexible Conversations & Organization**: Standalone sessions and multi-agent group rooms; message rollback and session forking from any turn; prompt queueing while a turn is running and instant turn interruption; isolated `/btw` side consultations (no main-context pollution, one-click quote to composer); prompt navigator timeline, session search, pin/rename/archive/done states, project & folder grouping, and Markdown export.
- **Subagent Monitoring & Live Steering**: Real-time subagent spawn tree, execution stream and terminal output inspection, live mid-flight steering instructions to active subagents, manual interruption, and one-click quoting of subagent summaries back into the main conversation.
- **Interactive Approvals & Memory-Only Credentials**: Native cards for command and file-edit approvals (with diff preview and `Once / Session / Workspace / Always / Deny` scopes) plus `Manual / Smart / Off` approval modes; multi-question clarification forms; memory-only secret, `sudo`, and 2FA/vault prompts (never written to disk or logs); external OAuth/connector authorization with security scan status; and background waiting banners that jump straight to blocked conversations.
- **Cognitive Memory & Skill Constellation**: Interactive constellation map on both desktop and mobile to browse, inspect, edit, and clean up long-term agent memories and learned skills.
- **Context Telemetry & Composer Ergonomics**: Real-time token usage (input, output, reasoning, cache hits), generation throughput (TPS), context window gauge with injected-file breakdown, manual and threshold-based context compaction; model picker with favorites/recents, reasoning effort controls (`Off / Low / High / Max`), `@` mentions, `/` slash-command and file-path autocomplete, plus drag-and-drop and clipboard image/file attachments.
- **Model Providers, Custom Endpoints, MCP & Skills**: In-app configuration for model providers and OpenAI-compatible custom endpoints (reachability probe and automatic model discovery), MCP server management (add, test, remove, inline OAuth, hot-reload), and Skills installation/reload.
- **Offline Snapshot Cache, Themes & Bilingual UI**: Startup snapshot cache for instant launch and offline reading, resilient WebSocket reconnection with foreground sync, system tray and sleep/wake awareness, 5 built-in dark/light themes (`obsidian-gold`, `ayu-dark`, `ayu-light`, `warm-paper`, `jade-white`), customizable fonts/reading width/activity indicators, and instant English / Simplified Chinese switching.

---

## Platform Support

| Platform | Runtime | Package Targets | Command |
| --- | --- | --- | --- |
| Windows (`x64`) | Electron 34 | NSIS setup, portable, zip | `npm run package:desktop:win` |
| macOS (`arm64` / `x64`) | Electron 34 | `.dmg`, `.zip` (Hardened Runtime) | `npm run package:desktop:mac` |
| Linux (`x64`) | Electron 34 | `AppImage`, `tar.gz` | `npm --workspace=@hermes-flux/desktop run package:linux` |
| Android | Capacitor 8 | APK / AAB | `npm run package:mobile:android` |
| iOS | Capacitor 8 | Xcode archive / IPA | `npm run package:mobile:ios` |

Run `npm run signing:check` for cross-platform release signing preflight checks. See the [Cross-Platform Release Signing Guide](docs/testing/cross-platform-release-signing.md) for signing configuration and strict release flags.

---

## Getting Started

### Prerequisites

- A running Hermes Agent Gateway.
- Prebuilt binaries will be published on [GitHub Releases](https://github.com/heyhongbro/hermes-flux/releases).
- For building from source: **Node.js** `>= 22.18.0` and **npm** (`package-lock.json` is the single authoritative lockfile).

### Install, Build & Run Desktop

```bash
npm ci
npm run build
npm --workspace=@hermes-flux/desktop run start
```

### Connect to a Gateway

Enter your Hermes Gateway URL and credentials in **Settings -> Connection**, or copy [`.env.example`](.env.example) to `.env` for local development and live gateway testing (`.env` is gitignored and must never be committed).

---

## Monorepo Structure

```text
hermes-flux/
├── packages/
│   ├── core/       # Pure TypeScript headless core (JSON-RPC, WS FSM, token coalescer, cache, domain models)
│   ├── ui/         # Shared React 19 UI components, design tokens, styles, and bilingual dictionaries
│   ├── desktop/    # Electron 34 desktop host (Windows / macOS / Linux)
│   └── mobile/     # Capacitor 8 mobile host (iOS / Android)
├── scripts/        # Automated quality gates, gateway contract verification, and visual checks
└── docs/           # Quality gates guide, formal invariants map, release signing guide, and gateway contract docs
```

---

## Verification & Documentation

Run the full quality gates, invariant checks, gateway contract verification, typecheck, test suite, formal checks, and performance benchmark with:

```bash
npm run verify
```

Engineering documentation under `docs/`:

- [Quality Gates Reference](docs/quality-gates.md)
- [Testing Strategy & Gate Architecture](docs/testing-strategy.md)
- [Formal Invariants Map](docs/invariants.md)
- [Gateway RPC Contract Index](docs/gateway/README.md)
- [Cross-Platform Release Signing Guide](docs/testing/cross-platform-release-signing.md)

---

## Contributing

Issues and pull requests are welcome. Please ensure `npm run verify` passes before opening a pull request.

---

## License

Licensed under the [MIT License](LICENSE).
