# Hermes Flux Automated Quality Gates

> Reference manual for the automated gate pipeline implemented in `scripts/gates/`.

---

## 1. Overall Architecture

```
Executable Gates  scripts/gates/                            <- Machine-enforced checks
   ├─ rules.mjs          Four rule groups (architecture / theme / i18n / performance)
   ├─ run.mjs            Unified runner (ratchet / reporting / baseline)
   ├─ .baseline.json     Frozen legacy debt fingerprint list (shrink-only)
   └─ lib/
       ├─ scanner.mjs    Comment stripping and line-number mapping (foundation)
       ├─ changed.mjs    Changed-files resolution
       └─ reporter.mjs   Human-readable table + machine-readable JSON output
   │
   ▼
Enforced Triggers  .githooks/pre-commit.mjs   /  .github/workflows/quality-gates.yml
```

**Core Principle: Single Source of Rules.** Both CI and `pre-commit` invoke `node scripts/gates/run.mjs`; there is no second rule implementation.

---

## 2. Quick Commands

| Scenario | Command |
|---|---|
| Daily local check | `npm run gates` |
| Changed files only | `npm run gates:changed` |
| Strict mode (fail on legacy debt too) | `npm run gates:strict` |
| JSON output for automation | `npm run gates:json` |
| Full pre-delivery verification | `npm run verify` |
| Shrink baseline after paying down debt | `npm run gates:freeze` |

Install the local Git hooks on a fresh clone:

```bash
git config core.hooksPath .githooks
```

> The `prepare` script in `package.json` configures this automatically during `npm install`. The hook delegates to `pre-commit.mjs` via Node so it works consistently on both POSIX shells and Windows PowerShell.

---

## 3. Rule Boundaries

### Gate 0 · Architecture & Maintainability

| Rule | Enforcement |
|---|---|
| `arch/layer-direction` | `core` must not depend on `ui`/`desktop`/`electron`; `ui` must not depend on `desktop`/`electron` |
| `arch/type-escape` | Forbids `as any`, `as unknown as`, `: any`, `<any>` |
| `arch/no-bare-transport` | UI and renderer layers must not call bare `fetch`, `new WebSocket`, or `XMLHttpRequest` |

### Gate 4a · Theme Consistency

- Scan targets: `packages/ui/src/components/**`, `packages/desktop/src/renderer/**`, `packages/ui/src/i18n/**`
- Blocked: Any hue-bearing literal color (hex / rgb / hsl)
- Allowed: Neutral scrim colors (`rgba(0,0,0,x)`, `rgba(255,255,255,x)`, `#000`, `#fff`) used solely for neutral darkening/lightening overlays across all themes
- Exempt: `packages/ui/src/tokens/**` (authoritative token definitions)

### Gate 4b · Internationalization (i18n)

- Blocked: Bare Chinese string literals inside UI components and renderer code
- Allowed: `packages/ui/src/i18n/index.ts` (dictionaries) and `tokens/**` (theme metadata labels)
- Masked automatically: `<!-- HTML comments -->` and `/* CSS comments */` inside template literals

### Gate 4c · Performance Invariants

| Rule | Blocked Pattern |
|---|---|
| `perf/infinite-animation` | Unbounded CSS animations (idle 60fps compositor churn) |
| `perf/smooth-scroll` | `scroll-behavior: smooth` (conflicts with scroll anchor compensation) |
| `perf/estimated-height` | `content-visibility` / `contain-intrinsic-size` (breaks pin-to-bottom tracking) |
| `perf/intl-in-hot-path` | `toLocaleTimeString` / `Intl.*` in render hot paths |

---

## 4. Debt Ratchet Mechanism

Rather than immediately failing all legacy findings (which encourages bypassing gates), legacy violations are frozen by content fingerprint and only **new** violations block commits:

```
Each violation -> fingerprint ruleId::file::contentHash
               -> present in .baseline.json -> legacy debt (non-blocking)
               -> absent from .baseline.json -> new violation (blocks commit)
```

Key properties:

1. **Line-number independent fingerprints**: Inserting lines above an existing line does not invalidate fingerprints or create false positives.
2. **Per-fingerprint matching (no net-count hiding)**: Fixing one violation while adding another does not cancel out.
3. **Shrink-only baseline**: Expanding `.baseline.json` is disallowed; only full-repo runs may shrink the baseline via `npm run gates:freeze`.

---

## 5. Inline Allowance Mechanism

Static analysis can produce rare false positives. Exceptions must be documented directly in source comments rather than hidden in script allowlists:

```ts
// gate-theme-allow: runtime brand SVG fill is theme-independent
const brandFill = '#3178C6';
```

| Tag | Target Rule |
|---|---|
| `gate-arch-allow` | Gate 0 |
| `gate-theme-allow` | Gate 4a |
| `gate-i18n-allow` | Gate 4b |
| `gate-perf-allow` | Gate 4c |

Constraint: An allowance comment applies only to the **same line or immediately preceding line** (blank lines break association). Total allowances across the repository are capped by `scripts/gates/allow-budget.mjs`.

---

## 6. Gate Credibility & Self-Verification

Gates must themselves be tested so they cannot silently degrade into no-ops.

`packages/core/__tests__/architecture/gate-engine.test.mjs` and `scripts/verify/gate-self-proof.mjs` verify:

- **Rules actually fail on violations**: Every rule has intentional negative fixtures; mutating a rule to `return []` causes tests to fail (`npm run gates:mutation`).
- **Low false-positive rate**: Neutral scrims, HTML entities (`&#039;`), commented examples, `var(--token)` references, and `t('key')` calls are verified to pass.
- **Scanner state machine accuracy**: Comment masking preserves line numbers and character offsets, URL `//` is not treated as a line comment, template-literal HTML/CSS comments are masked, and escaped quotes do not prematurely close string states.
