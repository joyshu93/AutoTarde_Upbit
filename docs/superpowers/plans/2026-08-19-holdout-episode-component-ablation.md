# Holdout Episode Component Ablation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic read-only episode attribution and leave-one-component-out diagnostics for the rejected combined conservative holdout.

**Architecture:** Keep the frozen broad strategy authority unchanged. Add a separate ablation authority, factor combined policy composition into a pure research-only component set, replay four fixed variants continuously, and analyze exact-entry episode relationships before the holdout paths are reduced to aggregate cells.

**Tech Stack:** TypeScript strict mode, Node test harness, immutable local candle datasets, pure replay and performance modules.

**Spec:** `docs/superpowers/specs/2026-08-19-holdout-episode-component-ablation-design.md`

## Global Constraints

- No LIVE/runtime/API/Telegram/order/sync/scheduler/migration side effects.
- Do not change the existing `BROAD_LOSS_CAUSE_V1` or `COMBINED_CONSERVATIVE` behavior.
- Use exact explicit-timezone timestamps and epoch-nanosecond comparison.
- Preserve independent BTC and ETH capital semantics and isolate timing/cost cells.
- Fix exactly four leave-one-component-out variants with no parameter search.
- All outputs are read-only, non-causal, and not deployment or prospective approval.
- Do not commit or push unless the user separately requests it.

---

### Task 1: Frozen Ablation Policy Composition

**Files:**
- Modify: `src/modules/strategy/position-guard-research-manifest.ts`
- Modify: `src/modules/strategy/position-guard-backtest.ts`
- Modify: `src/modules/performance/strategy-counterfactual.ts`
- Test: `tests/position-guard-backtest.test.ts`
- Test: `tests/strategy-counterfactual.test.ts`

**Interfaces:**
- Produces four exact ablation scenario IDs and an active-component policy evaluator.
- Preserves existing `COMBINED_CONSERVATIVE` behavior and scenario ordering.

- [ ] Write failing tests for the exact four scenario IDs, excluded `STRICT_PULLBACK`, component precedence, and original combined equivalence.
- [ ] Run focused tests and confirm failure is caused by missing ablation scenarios.
- [ ] Implement the immutable ablation manifest and pure active-component composition.
- [ ] Run focused tests and confirm all policy tests pass.

### Task 2: Pure Episode Relationship Diagnostics

**Files:**
- Create: `src/modules/performance/performance-holdout-episode-attribution.ts`
- Test: `tests/performance-holdout-episode-attribution.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes paired `CounterfactualScenarioResult` paths and validated holdout provenance.
- Produces deterministic episode envelopes, exact-entry relationships, unmatched classifications, and quality warnings.

- [ ] Write failing tests for exact matching, timezone equivalence, path divergence, partial exits, carry-in, open-at-to, unknown fees, `[from,to)`, cell isolation, and stable ordering.
- [ ] Run the focused test and confirm the module is missing.
- [ ] Implement input validation and episode envelope construction.
- [ ] Implement exact-entry matching and explicit unmatched classifications.
- [ ] Run focused tests and confirm all episode diagnostics pass.

### Task 3: Component Ablation Statistics

**Files:**
- Create: `src/modules/performance/performance-component-ablation.ts`
- Test: `tests/performance-component-ablation.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes the full combined and four ablation cell metrics plus Task 2 relationships.
- Produces per-component metric deltas and `PROTECTIVE_ASSOCIATION`, `HARM_ASSOCIATION`, `MIXED_ASSOCIATION`, `NO_MEASURABLE_DIFFERENCE`, or `INSUFFICIENT_EVIDENCE`.

- [ ] Write failing tests for every classification, tolerances, incomplete evidence, exact matrix shape, provenance mismatch, and deterministic ordering.
- [ ] Run the focused test and confirm the module is missing.
- [ ] Implement strict validation, cell comparisons, and honest classification.
- [ ] Run focused tests and confirm all ablation statistics pass.

### Task 4: Integrated Holdout and Report Output

**Files:**
- Modify: `src/research/integrated-strategy-evaluation.ts`
- Modify: `tests/integrated-strategy-evaluation.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`

**Interfaces:**
- Consumes continuous replay paths before aggregate holdout reduction.
- Produces optional stable JSON/text `broadStrategyShadowHoldoutComponentDiagnostics` output.

- [ ] Write failing integration tests for 32 ablation paths, full provenance, output flags, report ordering, no future evidence, and unchanged legacy output when diagnostics are absent.
- [ ] Run focused integration tests and confirm expected failure.
- [ ] Build ablation paths in the read-only research graph and attach Tasks 2 and 3 results.
- [ ] Add concise text rendering and complete JSON provenance.
- [ ] Update product and architecture documentation.
- [ ] Run focused integration tests and confirm they pass.

### Task 5: Independent Review and Actual Holdout Verification

**Files:**
- Test: all changed test files
- Output: `var/research/` report artifact only

**Interfaces:**
- Verifies implementation against the design without changing operational state.

- [ ] Run an independent code review and resolve correctness findings through tested changes.
- [ ] Run `npm.cmd run typecheck` and the complete test suite.
- [ ] Run `git diff --check`.
- [ ] Hash and stat the operational LIVE SQLite database before analysis.
- [ ] Run the immutable-dataset holdout report without API or operational DB writes.
- [ ] Hash and stat the operational LIVE SQLite database after analysis and verify equality.
- [ ] Inspect the actual BTC/ETH episode and ablation evidence for plausibility and report limitations.
