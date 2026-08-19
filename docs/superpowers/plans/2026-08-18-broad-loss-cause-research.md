# Broad Loss-Cause Strategy Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six frozen read-only counterfactual strategy hypotheses and classify their BTC/ETH evidence without changing live strategy behavior.

**Architecture:** Generalize the pure backtest-only research intervention contract, add pure scenario evaluation over existing continuous replay paths, and extend the existing strategy-evaluation CLI. Runtime, exchange, Telegram, migration, and writable DB graphs remain disconnected.

**Tech Stack:** TypeScript strict mode, Node test runner, SQLite read-only performance reader, immutable candle artifacts.

**Spec:** `docs/superpowers/specs/2026-08-18-broad-loss-cause-research-design.md`

## Global Constraints

- No Upbit or Telegram API calls, runtime startup, sync, scheduler tick, order mutation, migration execution, or writable operational DB access.
- Preserve the original PositionGuard decision and existing scenario golden behavior.
- Use the frozen development cutoff, exact W1/W2/W3 boundaries, explicit BASE/STRESS
  roles, exact-time ISO-8601 ordering, and continuous replay for every window.
- Keep data sufficiency separate from directional failure; known failure wins status
  precedence and must not be hidden by incomplete support.
- Implement every production behavior only after its focused test fails for the expected missing behavior.

---

### Task 1: Frozen Research Intervention Contract

**Files:**
- Modify: `src/modules/strategy/position-guard-backtest.ts`
- Modify: `src/modules/performance/strategy-counterfactual.ts`
- Test: `tests/position-guard-backtest.test.ts`
- Test: `tests/strategy-counterfactual.test.ts`

**Interfaces:**
- Produces the six scenario IDs, an immutable intervention record, deterministic
  per-replay policy state, explicit carry-in validation, and same-close/next-frame
  modeled execution timing.
- Preserves existing `BASELINE`, `NO_ADD`, and conditional ADD results byte-for-byte where new scenarios are absent.

- [ ] Add failing tests for each frozen allow/suppress/override rule, carry-in state,
  execution-lag sensitivity, and precedence.
- [ ] Run the focused tests and confirm failures are caused by unsupported scenarios.
- [ ] Implement the minimal pure overlay and policy state.
- [ ] Run focused tests and existing golden tests.

### Task 2: Candidate Diagnostics And Classification

**Files:**
- Create: `src/modules/performance/performance-strategy-hypothesis-evaluation.ts`
- Test: `tests/performance-strategy-hypothesis-evaluation.test.ts`

**Interfaces:**
- Consumes continuous scenario paths, exact windows, cost roles, cadence, and completed-episode support.
- Produces per-asset/full-path/window comparisons, separate `dataSufficiency` and
  `directionalGateOutcome`, and `REJECTED | INSUFFICIENT | ELIGIBLE_FOR_SHADOW_TEST`.

- [ ] Add failing tests for complete pass, each rejection gate, known-failure
  precedence over insufficiency, exact manifest/cost roles, and BTC/ETH separation.
- [ ] Confirm focused RED failures.
- [ ] Implement finite validation, comparisons, support gates, and deterministic ordering.
- [ ] Run focused tests through GREEN and refactor without changing behavior.

### Task 3: Integrated Report And CLI

**Files:**
- Modify: `src/research/integrated-strategy-evaluation.ts`
- Modify: `src/research/performance-report.ts` only if shared serialization requires it
- Test: `tests/integrated-strategy-evaluation.test.ts`
- Test: `tests/performance-report.test.ts`

**Interfaces:**
- Accepts the frozen scenario IDs and validates the immutable development manifest,
  exact cost roles, carry-in state, and execution-timing sensitivities.
- Emits stable JSON and text sections with rule manifests, provenance, metrics, interventions, and status.

- [ ] Add failing parser, report-shape, text, JSON, and legacy-compatibility tests.
- [ ] Confirm RED without touching operational data.
- [ ] Integrate pure evaluation and bounded text rendering.
- [ ] Run focused report tests through GREEN.

### Task 4: Safety And Data-Quality Boundaries

**Files:**
- Modify: `tests/research-import-graph.test.ts` or the existing equivalent import-boundary test
- Modify: `tests/run-all.ts`
- Modify: `README.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Proves the new graph cannot reach runtime/exchange/Telegram/writable DB modules.
- Documents statuses as research-only and non-deploying.

- [ ] Add failing import-boundary and malformed-evidence tests.
- [ ] Confirm RED for the new module or scenario surface.
- [ ] Complete test registration and root documentation.
- [ ] Run safety-focused tests through GREEN.

### Task 5: Independent Review And Verification

**Files:** No intended production changes unless review finds a defect.

- [ ] Run an independent correctness and safety review.
- [ ] Fix each accepted finding with a failing regression test first.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run the full test suite with `npm.cmd run check`.
- [ ] Run `git diff --check`.
- [ ] Execute the report only against immutable datasets and the operational DB in read-only mode.
- [ ] Confirm process state and DB file hashes/timestamps were not changed by analysis.
