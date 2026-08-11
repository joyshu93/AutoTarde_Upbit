# Integrated Strategy Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every task uses TDD and receives an independent review before integration.

**Goal:** Build one read-only evaluation CLI that presents observed LIVE attribution, BASELINE/NO_ADD counterfactual replay, explicit cost sensitivity, existing-regime results, and MAE/MFE without mixing evidence classes or changing production strategy behavior.

**Architecture:** Extend the current pure performance modules and pure PositionGuard backtest boundary. Load immutable local candle datasets through a new validated adapter, replay each scenario independently from the same frames, convert simulated trades into the existing FIFO matcher, and compose observed and simulated sections in a research-only CLI. Nothing is imported by app creation, execution, scheduler, Telegram, reconciliation, or live strategy runtime.

**Tech Stack:** TypeScript strict mode, Node.js built-ins, `node:sqlite` read-only adapter, existing test harness, existing PositionGuard backtest and performance matcher.

## Global Constraints

- Do not call Upbit, Telegram, sync, scheduler ticks, strategy runtime, migrations, or order APIs.
- Open the operational SQLite database only with `readOnly: true`.
- Do not modify local secret files, live settings, execution state, strategy rules, or runtime wiring.
- Do not commit or push until the user separately requests it.
- Preserve `exchange_account_id`, `execution_mode`, `origin`, and `[from,to)` observed filters.
- Keep `OBSERVED_LIVE_ATTRIBUTION`, `SIMULATED_COUNTERFACTUAL`, and `MODELED_COST_SCENARIO` separate.
- Never report independent BTC and ETH simulations as one shared-capital portfolio return.
- All timestamp ordering uses `performance-timestamp.ts` exact epoch nanoseconds.
- No `NaN`, `Infinity`, `BigInt`, missing fee, missing cost, or missing dataset is silently serialized as a numeric result.

---

### Task 1: Observed Attribution And Evidence Contracts

**Files:**
- Create: `src/modules/performance/performance-attribution.ts`
- Create: `tests/performance-attribution.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `PerformanceMatchResult`, `PerformanceDiagnosticGroup`, `Metric<T>`.
- Produces: `buildObservedAttribution(input): ObservedAttributionResult`.

- [ ] **Step 1: Write failing tests for sample support and action dimensions**

```ts
assert.deepEqual(classifySampleSupport("COMPLETED_POSITION_EPISODE", 9), {
  unit: "COMPLETED_POSITION_EPISODE",
  observedCount: 9,
  requiredCount: 30,
  status: "INSUFFICIENT",
  policyId: "OBSERVATION_COUNT_V1",
});
assert.equal(result.entryAttribution.ADD.distinctFillCount, 2);
assert.equal(result.entryAttribution.ADD.realizationSliceCount, 3);
assert.equal(result.exitAttribution.EXIT.dimension, "EXIT_FILL_ATTRIBUTION");
```

- [ ] **Step 2: Run the suite and confirm the new module is missing**

Run: `npm.cmd test`
Expected: FAIL on unresolved `performance-attribution` imports.

- [ ] **Step 3: Implement stable types and pure attribution**

```ts
export type SampleSupportStatus = "INSUFFICIENT" | "PRELIMINARY" | "SUPPORTED";
export type EvidenceKind = "OBSERVED_LIVE_ATTRIBUTION";
export function classifySampleSupport(unit: AnalysisUnit, observedCount: number): SampleSupport;
export function buildObservedAttribution(input: {
  matchResult: PerformanceMatchResult;
  diagnostics: PerformanceDiagnosticsResult;
}): ObservedAttributionResult;
```

Count unique non-null fill IDs and decision IDs with `Set`. Keep entry and exit dimensions as separate maps and add `doubleCountWarning` to the result contract.

- [ ] **Step 4: Add holding-bucket and structured-gap tests**

Use exact boundaries `24h`, `3d`, `7d`, and `14d`. Assert open episodes are excluded and opening inventory emits `LEFT_CENSORED_OPENING_INVENTORY`.

- [ ] **Step 5: Implement holding buckets and `EvidenceGap`**

Produce stable codes, severity, scope, affected metrics, evidence IDs, and message. Metrics remain numeric when complete even if sample support is insufficient.

- [ ] **Step 6: Run focused and full tests**

Run: `npm.cmd test`
Expected: all existing and new tests PASS.

---

### Task 2: Immutable Local Candle Dataset

**Files:**
- Create: `src/modules/performance/research-candle-dataset.ts`
- Create: `tests/research-candle-dataset.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: a local JSON string or path supplied by the research CLI.
- Produces: `parseResearchCandleDataset(json): ResearchCandleDataset` and `readResearchCandleDataset(path): Promise<ResearchCandleDataset>`.

- [ ] **Step 1: Write failing validation tests**

Cover BTC/ETH market consistency, exact ISO timestamps, finite positive OHLC, `low <= open/close <= high`, nonnegative volume, strictly ordered unique candle times, required 1h/4h/1d groups, and declared checksum mismatch.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test`
Expected: FAIL because dataset parser does not exist.

- [ ] **Step 3: Implement pure schema validation and canonical checksum**

```ts
export type ResearchDatasetProvenance = {
  schemaVersion: 1;
  asset: SupportedAsset;
  market: SupportedMarket;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  source: string;
  sha256: string;
};
```

Canonicalize validated fields before SHA-256. Do not include the declared checksum itself in checksum input.

- [ ] **Step 4: Implement read-only file adapter**

Use `node:fs/promises.readFile` only. Reject directories, empty files, malformed UTF-8 JSON, and unsupported schema versions. Do not add a collector or network client.

- [ ] **Step 5: Verify fixture determinism**

Assert equivalent JSON whitespace produces the same checksum and a one-price change produces a different checksum.

---

### Task 3: Research Execution Policy And Counterfactual Replay

**Files:**
- Modify: `src/modules/strategy/position-guard-backtest.ts`
- Create: `src/modules/performance/strategy-counterfactual.ts`
- Modify: `tests/position-guard-backtest.test.ts`
- Create: `tests/strategy-counterfactual.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: one immutable `PositionGuardBacktestFrame[]`, initial state, settings, and explicit scenario.
- Produces: `runCounterfactualScenarios(input): CounterfactualScenarioResult[]`.

- [ ] **Step 1: Write failing policy tests**

```ts
const noAdd = runPositionGuardBacktest({
  ...input,
  researchExecutionPolicy: { id: "NO_ADD", suppressedActions: ["ADD"] },
});
assert.equal(addFrame.decision.action, "ADD");
assert.equal(addFrame.executed, false);
assert.equal(addFrame.researchSuppression?.reason, "ACTION_SUPPRESSED");
```

- [ ] **Step 2: Verify RED and add the minimal optional backtest hook**

Add optional `researchExecutionPolicy` only to the backtest input. Evaluate it after the untouched core decision and before `applyDecision`. When absent, preserve byte-for-byte equivalent legacy behavior and output shape.

- [ ] **Step 3: Test full path dependence**

Assert suppressing ADD changes later state/context naturally, while BASELINE equals the existing engine result. Do not remove fills after replay.

- [ ] **Step 4: Implement scenario orchestration**

```ts
export type CounterfactualScenario = "BASELINE" | "NO_ADD";
export function runCounterfactualScenarios(input: CounterfactualInput): readonly CounterfactualScenarioResult[];
```

Clone initial inputs for every scenario and reuse the same frame array. Record evidence kind and scenario policy explicitly.

- [ ] **Step 5: Convert simulated trades to FIFO evidence**

Generate deterministic synthetic fill/order/decision IDs from scenario, asset, frame timestamp, and frame index. Feed those fills to `matchPerformanceTrades` and `diagnosePerformance`.

- [ ] **Step 6: Run parity and complete tests**

Run: `npm.cmd test`
Expected: existing PositionGuard tests and new counterfactual tests PASS.

---

### Task 4: Cost Sensitivity Grid

**Files:**
- Create: `src/modules/performance/performance-sensitivity.ts`
- Create: `tests/performance-sensitivity.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: counterfactual base input plus explicit fee/slippage cells.
- Produces: `runCostSensitivity(input): CostSensitivityResult`.

- [ ] **Step 1: Write failing grid tests**

Assert deterministic cell order, duplicate-cell rejection, nonnegative finite rates, one shared frame reference, and independent replay state.

- [ ] **Step 2: Implement explicit cells without hidden defaults**

```ts
export type CostScenario = {
  id: string;
  feeRate: number;
  slippageRate: number;
};
```

Return final equity, return, drawdown, turnover, fees, completed episodes, episode win rate, and profit factor for every strategy/cost pair.

- [ ] **Step 3: Test path-dependent costs**

Use a fixture where higher fees reduce later available cash and alter a later order quantity. Assert the result is replayed, not obtained by subtracting a final fee estimate.

- [ ] **Step 4: Run full tests**

Run: `npm.cmd test`
Expected: PASS.

---

### Task 5: Regime And Excursion Analysis

**Files:**
- Create: `src/modules/performance/performance-regimes.ts`
- Create: `src/modules/performance/performance-excursions.ts`
- Create: `tests/performance-regimes.test.ts`
- Create: `tests/performance-excursions.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: scenario frame results, FIFO match results, and validated local 1h candles.
- Produces: regime aggregates and completed-episode MAE/MFE.

- [ ] **Step 1: Write regime tests using frame-time regimes**

Assert aggregation uses `frame.regime` already calculated at decision time. Include decision counts, execution counts, turnover, gross/net realized PnL, win rate, and sample support.

- [ ] **Step 2: Implement regime attribution**

Map each synthetic fill to its source frame. Keep entry-regime and exit-regime PnL views separate to avoid double counting.

- [ ] **Step 3: Write MAE/MFE boundary tests**

Assert candles before entry and after exit are excluded, incomplete intervals produce `UNKNOWN`, open episodes are excluded, and intrabar ordering is never inferred.

- [ ] **Step 4: Implement excursion analysis**

```ts
export type EpisodeExcursion = {
  episodeId: string;
  market: PerformanceMarket;
  maeKrw: Metric<number>;
  mfeKrw: Metric<number>;
  maePct: Metric<number>;
  mfePct: Metric<number>;
  candleCount: number;
};
```

Use completed 1h OHLC evidence observable no later than the exit decision. Preserve the no-intrabar-ordering warning.

- [ ] **Step 5: Run full tests**

Run: `npm.cmd test`
Expected: PASS.

---

### Task 6: Integrated Report And CLI

**Files:**
- Create: `src/research/integrated-strategy-evaluation.ts`
- Create: `tests/integrated-strategy-evaluation.test.ts`
- Modify: `package.json`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: required observed DB filters, optional BTC/ETH dataset paths, explicit initial state, scenario list, and explicit cost cells.
- Produces: stable text/JSON report with separate evidence sections.

- [ ] **Step 1: Write failing argument and output-contract tests**

Require database/account/mode/origin. Dataset paths are optional; absent paths must not call a reader and must produce `DATASET_UNAVAILABLE`. Reject duplicate scenarios/cost cells and non-finite numbers.

- [ ] **Step 2: Implement report composition**

```ts
export type IntegratedStrategyEvaluationReport = {
  provenance: IntegratedProvenance;
  observedLive: ObservedEvaluationSection;
  simulatedCounterfactuals: SimulationSection;
  costSensitivity: CostSensitivitySection;
  regimeAnalysis: RegimeAnalysisSection;
  excursionAnalysis: ExcursionAnalysisSection;
  evidenceGaps: readonly EvidenceGap[];
  interpretation: readonly InterpretationFinding[];
};
```

Do not produce a combined observed/simulated return or a combined BTC/ETH portfolio return.

- [ ] **Step 3: Implement stable interpretation rules**

Findings may state concentration, direction, sample support, and scenario delta. Each finding records evidence kind, metric IDs, sample status, and language that avoids causal or profitability claims.

- [ ] **Step 4: Implement readable text and finite JSON**

Include provenance, evidence labels, sample warnings, dataset checksums, scenario assumptions, observed/action/holding summaries, scenario deltas, cost tables, regime tables, excursions, and gaps.

- [ ] **Step 5: Add the package script**

```json
"report:strategy-evaluation": "npm run build && node dist/src/research/integrated-strategy-evaluation.js"
```

- [ ] **Step 6: Verify absent-dataset and fixture-dataset modes**

Run both JSON and text paths. Confirm absent datasets remain network-free and fixture datasets produce deterministic simulation output.

---

### Task 7: Documentation And Safety Contracts

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `docs/superpowers/specs/2026-08-11-integrated-strategy-evaluation-design.md`

- [ ] **Step 1: Document commands and evidence meanings**

Add exact CLI examples for observed-only and local-dataset modes. Explain independent capital, no network fallback, cost assumptions, sample support, and MAE/MFE limitations.

- [ ] **Step 2: Document module isolation**

State that integrated evaluation is research-only and absent from execution, scheduler, Telegram, reconciliation, and app dependency graphs.

- [ ] **Step 3: Cross-check documentation against output fields**

Search for stale names and ensure every documented field exists in stable JSON.

---

### Task 8: Independent Review And Final Verification

**Files:**
- Review all files changed by Tasks 1 through 7.

- [ ] **Step 1: Dispatch independent correctness review**

Review FIFO/episode separation, fee allocation, opening inventory, action double counting, exact timestamps, look-ahead, simulation path dependence, independent BTC/ETH capital, and finite serialization.

- [ ] **Step 2: Fix findings with new failing tests first**

Every accepted finding receives a regression test before implementation changes.

- [ ] **Step 3: Run required verification**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
git diff --check
```

Expected: zero failures.

- [ ] **Step 4: Run observed LIVE evaluation read-only**

Use `./var/company-live.sqlite`, `primary`, `LIVE`, `STRATEGY`. Record state before and after with a separate read-only connection. Do not call sync or runtime controls.

- [ ] **Step 5: Run fixture counterfactual evaluation**

Use only repository fixture datasets. Confirm BASELINE/NO_ADD, cost, regime, and MAE/MFE sections are deterministic.

- [ ] **Step 6: Report unavailable actual counterfactual evidence honestly**

If no immutable real candle dataset has been provided, report actual counterfactual results as `DATASET_UNAVAILABLE`; do not call the public API.

- [ ] **Step 7: Confirm no commit or push**

Show worktree status and leave all changes uncommitted for user review.
