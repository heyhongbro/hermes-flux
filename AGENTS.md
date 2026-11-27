# AGENTS.md — Hermes Flux Engineering Rules & Fast Workflow

## 1. Core Rules

- **One-way monorepo layering**: `packages/core` (platform-agnostic) -> `packages/ui` (React components, design tokens, i18n) -> `packages/desktop` & `packages/mobile` (thin shells). Never add DOM/Electron imports in `core` or desktop imports in `ui`.
- **Strict typing & explicit errors**: Forbid `as any` and `: any`. Never swallow errors in an empty `catch {}` — degraded catches require `// gate-degrade: <reason>`.
- **Real test coverage**: Every behavior change in `packages/*/src/` must add or update unit tests (no fake assertions, no real `setTimeout` sleeps in unit tests, `<= 1500` lines/file, `npm run coverage:new` at 100%).
- **Zero secrets or PII**: Never commit `.env`, API keys, signing credentials, private local paths, or personal emails/names.
- **Single source of truth**: `package-lock.json` is the sole lockfile. Never weaken gate rules or expand `scripts/gates/.baseline.json`. Always regenerate `docs/invariants.md` (`npm run invariants:render`) and `docs/gateway/*.md` (`npm run contract:doc`).

## 2. Tiered Verification Workflow

Run only the smallest tier that covers your change; leave full cross-platform regression to PR CI.

| Tier | Scope | Local Commands |
| --- | --- | --- |
| **S** | Docs, templates, license | `npm run gates:changed` (+ `npm run gates:invariants` or `npm run contract:doc:check` if touched) |
| **M** | Single-package feature or fix | `npm run gates:changed`, `npm run typecheck`, `npm run build:<pkg>`, targeted `node --test <files>`, and `npm run coverage:new` |
| **L** | Cross-package, FSM, or RPC contract | Tier M + `npm run verify:formal` and `npm run contract:verify` |

- **Pre-commit & CI split**: `.githooks/pre-commit.mjs` runs tiered local checks (`docs` / `tests` / `scoped`; set `PRECOMMIT_FULL=1` only when full local pre-commit is explicitly required). Full `ubuntu-latest` + `windows-latest` matrices, perf budgets, and `Gate 5` Stryker mutation testing run on PR CI — do not run Stryker locally on Windows unless reproducing a failing CI domain (`npm run mutation:stryker -- --domain=<name>`).

## 3. Review Policy

- **Default (no subagent review)**: Rely on Tier S/M/L checks and PR CI for routine changes.
- **When to run read-only review**: Invoke an independent read-only review only for major refactors, protocol/security-sensitive changes, or explicit user requests. Reviewers inspect `git diff` and test completeness only and must not re-run full builds or full test suites.

## 4. References

- [Quality Gates Reference](docs/quality-gates.md)
- [Testing Strategy & Gate Architecture](docs/testing-strategy.md)
- [Formal Invariants Map](docs/invariants.md)
- [Gateway RPC Contract Index](docs/gateway/README.md)
- [Cross-Platform Release Signing Guide](docs/testing/cross-platform-release-signing.md)
