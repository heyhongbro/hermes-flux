# Hermes Flux Testing Strategy & Gate Architecture

> Design and enforcement manual for the verification pipeline.
> Implementations live in `scripts/gates/`, `scripts/verify/`, and `.github/workflows/quality-gates.yml`;
> see [`quality-gates.md`](quality-gates.md) for gate rules and [`invariants.json`](invariants.json) for the single source of formal invariants.

---

## 0. Core Principles

1. **Tests prove breakage sensitivity, not mere existence.** A test is valuable only if deliberately breaking the code under test causes the test to fail. A test that always passes offers zero protection.
2. **"Command exited 0" is distinct from "tests actually ran".** Exit code `0` alone cannot distinguish real execution from empty globs, skipped files, or premature exits—hence the execution census layer.
3. **100% incremental coverage on new production code; ratchet-only on legacy code.** Requiring 80% global coverage immediately encourages trivial tests on legacy files, whereas enforcing 100% line and branch coverage on newly added/modified production code ensures every change carries its own proof.
4. **Tools cannot infer missing features**, only verify existing implementations. New domain logic must ship with unit tests, formal invariant mappings, and coverage evidence.
5. **File size is a maintainability boundary.** Files over 1,500 lines resist safe refactoring and are guarded automatically.

---

## 1. Why Multiple Verification Layers Are Needed

No single check catches every failure mode:

| Technique | Catches | Misses |
|---|---|---|
| Unit tests | Behavior on known inputs | Unanticipated edge inputs |
| Code coverage | Unexecuted lines/branches | Executed lines without assertions |
| Mutation testing | Weak or non-falsifying assertions | Entirely missing features |
| Property-based testing (`fast-check`) | Invariant violations over arbitrary inputs | Incorrectly specified invariants |
| Execution census | Tests silently skipped or dropped by globs | Tests that run with vacuous assertions |
| Manual / visual review | Requirement or UX mismatches | Regressions across large codebases |

### 1.1 Why Incremental 100% Coverage

Global coverage averages hide unverified new code behind well-tested legacy modules and incentivize padding simple legacy paths. Focusing strictly on `git diff` / new files makes each commit accountable for its own additions.

### 1.2 Why Mutation Testing Is Required

Coverage answers "did this line execute?"; mutation testing answers "would a bug on this line fail a test?". `scripts/gates/mutation-check.mjs` verifies anchor uniqueness strictly (must match exactly once) so refactored anchors fail loudly rather than skipping silently.

### 1.3 Scan Scope Hygiene

A broken rule errors visibly; an incomplete scan scope stays silent. Every static gate rule must verify it actually reaches its target files (`packages/core/src`, `packages/ui/src`, `packages/desktop/src`, `packages/mobile/src`, and `testAware` targets).

---

## 2. Measured Baselines & False-Green Failure Modes

### 2.1 False-Green Patterns Blocked by Execution Census

| Technique | Raw `node --test` Behavior | Caught by Census? |
|---|---|---|
| Empty glob (`node --test "empty/**/*.test.mjs"`) | `exit=0`, `tests=0` | **Yes** |
| Directory rename breaking glob | `exit=0`, `tests=0` | **Yes** |
| Top-level `process.exit(0)` | `exit=0`, `tests=1`, `pass=1` | **Yes** (`tests < minFiles` / count ratio) |
| `process.exit(0)` inside `uncaughtException` | `exit=0`, `tests=1`, `pass=1` | **Yes** |
| Assertion followed by `process.exit(0)` | `exit=1`, `fail=1` | Handled natively by Node 24 |
| Whole-file `t.skip()` | `exit=0`, `pass=0`, `skipped=N` | **Yes** (capped by `SKIP_BUDGET`) |

### 2.2 Reference Coverage Snapshot (Measured Pre-Refactor)

> Coverage percentages depend directly on which test suite is executed:

| Scope | Statements | Branches | Functions |
|---|---|---|---|
| Full unit suite | 91.25% | 81.54% | 81.64% |
| `verify:formal` alone | 64.48% | 74.55% | 19.95% |
| Single file (`cache-merge.test.mjs`) | 52.08% | 69.62% | 3.09% |

---

## 3. Layered Gate Architecture

```
L0  Static gates       gates / typecheck / contract                          Rule compliance
L0' CI self-guard      gates:ci (workflow portability) / workspace-links     Judge credibility
L1  Execution census   census (files / tests / fails / skips)                Proof of execution
L2  Unit & integration npm test (node:test)                                  Functional behavior
L3  Formal invariants  verify:formal (fast-check) + invariant-map            Universal properties
L4  Coverage           node --experimental-test-coverage + incremental diff  Execution completeness
L5  Effectiveness      Mutation testing (gates:mutation / Stryker domains)   Assertion strength
L6  Real rendering     CDP / headless browser probes                         Wiring & layout geometry
```

Checks run cheapest-first: L0/L1 complete in seconds, while L5/L6 run in minutes.

---

## 4. Mechanism 1: Execution Census (L1)

### 4.1 Verification Formula

Parsed from TAP summary lines (`{tests, pass, fail, cancelled, skipped, todo}`):

```
files >= registered minFiles
tests > 0
tests >= files
fail === 0 && cancelled === 0
skipped <= registered SKIP_BUDGET
```

### 4.2 Authoritative Test File Enumeration

`SUITES` in `scripts/gates/lib/test-targets.mjs` defines explicit roots and `minFiles` lower bounds. Rather than relying on shell glob expansion (where POSIX `bash` without `globstar` collapses `**` to `*` and silently skips root-level files), Node recursively enumerates files consistently across Linux, macOS, and Windows. `npm run gates:targets` validates enumeration before running tests.

### 4.3 `NODE_TEST_CONTEXT` Environment Isolation

Child processes spawned with `NODE_TEST_CONTEXT` inherited suppress TAP summary output. Any script spawning `node --test` must delete `env.NODE_TEST_CONTEXT` before spawning.

---

## 5. Mechanism 2: 100% Incremental Coverage (L4)

### 5.1 Verification Flow

```
A. Added lines    git diff -U0 <base> ∪ untracked source files
B. Executed lines node --experimental-test-coverage -> lcov -> sourcemap-mapped src lines
C. Enforcement    Any executable line/branch in A ∩ B with hits === 0 -> FAIL
```

### 5.2 Critical Implementation Details

1. **Sourcemap reversal (`dist/*.js` -> `src/*.ts`)**: Coverage instruments compiled outputs while diffs are in TypeScript sources. `new-code-coverage.mjs` uses `@jridgewell/trace-mapping` to resolve back to original source lines.
2. **Untracked files**: `git diff` omits newly created untracked files; they are collected separately and treated as 100% newly added lines.
3. **Pure-type exclusion**: TypeScript `interface` and `type`-only files are excluded from executable denominators.
4. **Distinguishing missing builds vs. missing tests**: Unbuilt modules vs. unimported modules produce separate actionable errors.

---

## 6. Mechanism 3: Formal Invariants Map (L3)

`docs/invariants.json` is the single source of truth; `docs/invariants.md` is generated via `npm run invariants:render` and verified with `npm run gates:invariants`.

| Rule | Enforcement |
|---|---|
| `id` unique and matches `INV-<AREA>-<NN>` | FAIL on violation |
| `test` is a single existing file path | FAIL on violation |
| `test` file contains `fc.assert(` | FAIL on violation |
| `source` is an existing source file path | FAIL on violation |
| `source` + `symbol` pair is unique | FAIL on violation (disambiguate with `symbol#aspect`) |
| `docs/invariants.md` matches JSON render | FAIL on `--check` mismatch |

Areas explicitly tracked as not yet covered by formal invariants include `core/src/queue/` and `core/src/group/`.

---

## 7. Mechanism 4: Maintainability & Test Performance (L0 / `testAware`)

### 7.1 Source File Line Limits

Production files are capped at **1,500 physical lines**. Legacy files above this limit are frozen in `KNOWN_OVERSIZE` (`scripts/gates/rules/maintainability.mjs`) and may only shrink.

### 7.2 Inline Allowance Budget

`scripts/gates/allow-budget.mjs` enforces a strict cap (`BUDGET`) across all `gate-*-allow` comments in source files. Documentation blocks (`* ...`) and string literals are excluded from the count.

### 7.3 Test Integrity Rules

- `test-integrity/c8-ignore`: Forbids `/* c8 ignore */` comments that hide uncovered lines from LCOV.
- `test-integrity/test-exit`: Forbids `process.exit(0)` in test files that could mask failures.

### 7.4 Test Execution Performance & Size Guard (`testAware`)

Because `@stryker-mutator/tap-runner` executes tests at file granularity, oversized or sleep-heavy unit tests multiply mutation test runtime across hundreds of mutants. `scripts/gates/run.mjs` scans all unit/formal tests and `unit/helpers/*.mjs` via `listAllTestAndHelperFiles()`:

- **Unit test file size cap**: 1,500 physical lines (legacy files frozen in `KNOWN_OVERSIZE`, shrink-only).
- **`test-perf/no-real-sleep`**: Blocks `timers/promises` imports and real `setTimeout(..., >=20ms)` delays (legacy counts frozen in `KNOWN_REAL_SLEEP_TESTS`; real-I/O integration tests listed in `REAL_IO_SLEEP_TESTS` are exempt from sleep checks while still bound by line limits).
- **`test-perf/mock-timers-cleanup`**: Requires matching `mock.timers.reset()` whenever `mock.timers.enable()` is used.
- **`test-perf/no-helper-dist-import` & `no-helper-global-patch`**: Prevents test helpers from coupling directly to `dist/` artifacts or mutating `globalThis`.

---

## 8. CI Orchestration & Cross-Platform Portability

### 8.1 Workflow Triggers

`.github/workflows/quality-gates.yml` runs on `push` to `[main, 'dev/**']`, all `pull_request` events targeting those branches, and `workflow_dispatch`.

### 8.2 Cross-Platform Shell Portability (`gates:ci`)

The CI matrix executes on both `ubuntu-latest` (`bash`) and `windows-latest` (`pwsh`). `scripts/gates/verify-ci-workflow.mjs` statically prevents three classes of platform divergence:

| ID | Hazard | Rule |
|---|---|---|
| P-01 | Calling `require.resolve('@hermes-flux/*')` before `npm run build` | `ci/no-prebuild-artifact-read` |
| P-02 | Inline bash syntax (`for ... in ...; do`, `test -f`, `export VAR=`) without `shell: bash` | `ci/no-bash-only-syntax` |
| P-03 | Multi-line `run: \|` blocks executing multiple fallible commands (where `pwsh` only exits with the last command's status) | `ci/no-masked-command` |

Cross-platform logic belongs in Node scripts (`scripts/gates/*.mjs`) or separate single-command steps.

### 8.3 Known Scope Notes

- `test-integrity/*` rules are validated by unit tests and `gates:self-proof`, while the default `SCAN_ROOTS` covers `packages/*/src` and `scripts/gates` (whereas `testAware` covers `size` and `test-perf/*` across all test files).
- `test:cdp` GUI suites require local Chromium/Edge binaries and run separately from headless CI.

---

## 9. Limitations

1. **100% coverage does not guarantee zero bugs**: Coverage proves execution, not assertion completeness.
2. **Automated metrics prevent regressions, not requirement errors**: Correctness of product behavior still requires human judgment.
3. **Missing test cases cannot be inferred mathematically**: Layered checks (unit + property + mutation + CDP) minimize blind spots while making explicitly skipped probes visible.
