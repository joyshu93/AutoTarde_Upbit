# Conditional ADD Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline, deterministic conditional-ADD counterfactual scenarios and evidence gates without changing LIVE strategy or execution behavior.

**Architecture:** Extend the research-only backtest execution-policy contract so it evaluates an ADD against current-frame evidence before simulated execution. Reuse the existing full-path counterfactual, cost-sensitivity, and continuous-window infrastructure, then add pure candidate comparison and acceptance-gate reporting in the research layer.

**Tech Stack:** TypeScript strict mode, Node test harness, immutable PositionGuard candle datasets, pure backtest/performance modules.

## Global Constraints

- Never import conditional research policies into runtime, execution, scheduler, Telegram, exchange, or reconciliation modules.
- Never call Upbit or open an operational SQLite database during implementation tests.
- Preserve exact BASELINE and NO_ADD behavior and existing output when new scenarios are absent.
- Use only contemporaneous frame evidence; future fills, closes, regimes, MAE/MFE, and scenario outcomes are forbidden policy inputs.
- Preserve strict timezone timestamps, immutable source frames, full-path state replay, and half-open `[from,to)` windows.
- Do not commit or push unless the user asks separately.

---

### Task 1: Research ADD policy contract and replay

**Files:**
- Modify: `src/modules/strategy/position-guard-backtest.ts`
- Modify: `tests/position-guard-backtest.test.ts`

**Interfaces:**
- Produces: `PositionGuardBacktestResearchExecutionPolicy` with IDs `NO_ADD`, `ADD_RISK_CLEAR`, `ADD_HIGH_ALIGNMENT`, `ADD_CORE_TREND`.
- Produces: suppression evidence with a specific policy reason and contemporaneous analysis snapshot.
- Preserves: no-policy BASELINE output and NO_ADD golden behavior.

- [ ] **Step 1: Write failing boundary tests**

Add tests that construct an otherwise executable ADD and assert suppression at each failing boundary and execution at the exact passing boundary:

```ts
const policyCases = [
  ["ADD_RISK_CLEAR", { atrShock: true }, "ATR_SHOCK"],
  ["ADD_RISK_CLEAR", { weakeningStage: "SOFT" }, "WEAKENING_PRESENT"],
  ["ADD_HIGH_ALIGNMENT", { trendAlignmentScore: 3 }, "TREND_ALIGNMENT_BELOW_4"],
  ["ADD_CORE_TREND", { regime: "EARLY_RECOVERY" }, "REGIME_NOT_CORE_TREND"],
] as const;
```

Also assert that a suppressed ADD changes later replay state, source frames remain unchanged, repeated runs are identical, and malformed policy IDs reject.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd run build && node dist/tests/position-guard-backtest.test.js`

Expected: FAIL because conditional policy IDs and reason fields are unsupported.

- [ ] **Step 3: Implement the minimal pure policy evaluator**

Validate policy IDs explicitly. For an ADD decision, evaluate only `frame.analysis` in this order: ATR shock, weakening stage, trend alignment, regime. Return suppression evidence without changing the strategy decision; otherwise execute normally.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm.cmd run build && node dist/tests/position-guard-backtest.test.js`

Expected: PASS, including the unchanged legacy golden.

---

### Task 2: Counterfactual scenarios and cost matrix

**Files:**
- Modify: `src/modules/performance/strategy-counterfactual.ts`
- Modify: `src/modules/performance/performance-sensitivity.ts`
- Modify: `tests/strategy-counterfactual.test.ts`
- Modify: `tests/performance-sensitivity.test.ts`

**Interfaces:**
- Produces: `CounterfactualScenario = "BASELINE" | "NO_ADD" | "ADD_RISK_CLEAR" | "ADD_HIGH_ALIGNMENT" | "ADD_CORE_TREND"`.
- Consumes: Task 1 policy IDs.
- Preserves: caller scenario order and independent state for every replay.

- [ ] **Step 1: Write failing scenario tests**

Assert all five scenarios map to the expected policy, retain stable order, generate scenario-qualified fill IDs, reject duplicates/unknown IDs, and produce every scenario-by-cost cell exactly once.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd run build && node dist/tests/strategy-counterfactual.test.js && node dist/tests/performance-sensitivity.test.js`

Expected: FAIL because the scenario parser and policy mapping accept only BASELINE/NO_ADD.

- [ ] **Step 3: Extend the scenario mapping**

Use one exhaustive scenario-to-policy function. Do not duplicate policy predicates in the performance layer.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused command from Step 2 and expect PASS.

---

### Task 3: Candidate stability comparison and acceptance gates

**Files:**
- Create: `src/modules/performance/performance-add-policy-evaluation.ts`
- Create: `tests/performance-add-policy-evaluation.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: cost-sensitivity cells and caller-supplied validation windows.
- Produces: per-asset, per-candidate comparisons against BASELINE and NO_ADD.
- Produces: `ELIGIBLE_FOR_FURTHER_RESEARCH | REJECTED | INSUFFICIENT` plus an explicit result for each acceptance gate.

- [ ] **Step 1: Write failing pure evaluation tests**

Cover: all gates pass; base/stress return failure; window delta failure; drawdown failure; fewer than 30 policy-exposed completed episodes; fewer than 10 in one window; incomplete coverage; non-finite values; duplicate/missing anchors; mixed timezone and `[from,to)` boundaries.

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm.cmd run build && node dist/tests/performance-add-policy-evaluation.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement minimal deterministic gate evaluation**

The result must retain every observed value and threshold. `INSUFFICIENT` takes precedence for evidence support or coverage failures; otherwise any failed performance gate yields `REJECTED`; only all passing gates yield `ELIGIBLE_FOR_FURTHER_RESEARCH`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

---

### Task 4: Integrated CLI, text/JSON output, docs, and safety checks

**Files:**
- Modify: `src/research/integrated-strategy-evaluation.ts`
- Modify: `tests/integrated-strategy-evaluation.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `tests/upbit-research-candle-acquisition.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: stable JSON candidate matrix, gate results, provenance, warnings, and readable text summaries.
- Preserves: output shape when conditional scenarios are not requested.

- [ ] **Step 1: Write failing CLI and import-boundary tests**

Assert explicit parsing of the three candidate IDs, candidate output for BTC/ETH and base/stress cells, anchor requirements, policy support counts, stable JSON, readable text, and absence from runtime/operational import graphs.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd run build && node dist/tests/integrated-strategy-evaluation.test.js && node dist/tests/upbit-research-candle-acquisition.test.js`

Expected: FAIL because candidate scenarios and evaluation output are unavailable.

- [ ] **Step 3: Integrate without runtime wiring**

Build candidate evaluation only when conditional scenarios and explicit validation windows are supplied. Emit clear `UNAVAILABLE` or `INSUFFICIENT` evidence instead of inventing defaults. Document that favorable results are not deployment approval.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 5: Run final verification**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
git diff --check
```

Expected: all commands exit 0. Confirm no operational DB checksum, process, execution state, or local secret file changed.

---

### Task 5: Multi-timeframe feature-input continuity

**Files:**
- Create: `src/modules/performance/performance-candle-coverage.ts`
- Create: `tests/performance-candle-coverage.test.ts`
- Modify: `src/modules/performance/performance-add-policy-evaluation.ts`
- Modify: `src/research/integrated-strategy-evaluation.ts`
- Modify: `tests/performance-add-policy-evaluation.test.ts`
- Modify: `tests/integrated-strategy-evaluation.test.ts`

**Interfaces:**
- Produces raw `1h/4h/1d` source cadence and compact affected-frame ranges.
- Requires continuous completed prefixes because recursive indicators consume all prior candles.
- Makes incomplete feature evidence `INSUFFICIENT` without interpolation or runtime wiring.

- [x] **Step 1: Add failing pure source and feature-continuity tests**
- [x] **Step 2: Implement the pure multi-timeframe coverage calculator**
- [x] **Step 3: Preserve duplicate/off-grid and structurally validated gap evidence**
- [x] **Step 4: Integrate feature continuity into candidate gates and report provenance**
- [x] **Step 5: Run final verification and regenerate the real read-only report**
