# Excursion No-Trade and Mark Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove verified no-trade false positives from excursion analysis and expose deterministic persisted-mark exclusion provenance without changing trading behavior.

**Architecture:** Add one pure hourly-coverage partitioner fed only by already-verified source no-trade ranges. General and ADD excursion analyzers consume that partition without synthesizing OHLC, while performance diagnostics expose typed per-snapshot mark exclusions and the integrated report renders their provenance. All work remains offline and read-only.

**Tech Stack:** TypeScript strict mode, Node.js built-in test harness, Node built-in SQLite read-only adapter, immutable local JSON candle datasets.

## Global Constraints

- Do not modify strategy rules, execution wiring, scheduler behavior, risk rules, Telegram behavior, Upbit adapters, orders, or runtime configuration.
- Do not call Upbit, Telegram, sync, strategy runs, scheduler ticks, or order endpoints.
- Open the operational SQLite database with `readOnly: true` only; do not run migrations.
- Do not synthesize, interpolate, or forward-fill candles, OHLCV, marks, fills, fees, positions, or orders.
- Only verified `sourceNoTradeRanges` from authoritative candle coverage may excuse a nominal hourly gap.
- Duplicate, off-grid, future, post-boundary, acquisition-boundary, corrupt, or contradictory evidence remains blocking.
- Existing JSON fields and their meanings remain stable; all new output is additive and deterministically ordered.
- Existing W1/W2/W3 boundaries and 30 full-path / 10 per-window support thresholds remain unchanged.
- Candidate status must not become eligible solely because coverage evidence improves.
- Do not commit or push until the user explicitly requests it.

---

## File Structure

- Create `src/modules/performance/performance-hourly-coverage.ts`: pure exact-instant partitioning and no-trade range validation.
- Create `tests/performance-hourly-coverage.test.ts`: focused partition, range, boundary, timezone, and contradiction tests.
- Modify `src/modules/performance/performance-excursions.ts`: consume verified no-trade coverage for completed position episodes.
- Modify `tests/performance-excursions.test.ts`: general excursion behavior and compatibility tests.
- Modify `src/modules/performance/performance-add-excursions.ts`: consume the same coverage contract for ADD exposures.
- Modify `tests/performance-add-excursions.test.ts`: ADD excursion behavior and unchanged non-comparable reasons.
- Modify `src/modules/performance/performance-diagnostics.ts`: typed mark valuation failures and exclusion manifest.
- Modify `tests/performance-diagnostics.test.ts`: mark exclusion reasons, ordering, and defensive-copy tests.
- Modify `src/research/performance-report.ts`: readable mark exclusion summary.
- Modify `tests/performance-report.test.ts`: stable text and JSON-compatible output.
- Modify `src/research/integrated-strategy-evaluation.ts`: pass authoritative no-trade evidence and map mark evidence IDs/reasons.
- Modify `tests/integrated-strategy-evaluation.test.ts`: integrated no-trade and mark provenance tests.
- Modify `tests/run-all.ts`: register the new focused test module.
- Modify `PRODUCT_BOUNDARY.md`, `ARCHITECTURE.md`, and `README.md`: document evidence semantics and holdout boundary.

---

### Task 1: Pure Hourly Coverage Partition

**Files:**
- Create: `src/modules/performance/performance-hourly-coverage.ts`
- Create: `tests/performance-hourly-coverage.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `CandleCoverageGap` from `performance-candle-coverage.ts` and exact ISO timestamps from `performance-timestamp.ts`.
- Produces:

```ts
export type HourlyObservedInterval = {
  openTime: string;
  closeTime: string;
};

export type HourlyCoveragePartition = {
  from: string;
  to: string;
  expectedIntervalCount: number;
  observedIntervalCount: number;
  verifiedNoTradeIntervalCount: number;
  unexplainedMissingIntervalCount: number;
  observedIntervals: readonly string[];
  verifiedNoTradeIntervals: readonly string[];
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
  unexplainedMissingIntervals: readonly string[];
};

export function partitionHourlyCoverage(input: {
  from: string;
  to: string;
  sourceBoundary: {
    historyStartAt: string;
    endAt: string;
  };
  observedIntervals: readonly HourlyObservedInterval[];
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
}): HourlyCoveragePartition;
```

- [ ] **Step 1: Write failing partition tests**

Add tests proving one expected interval belongs to exactly one category, and
assert:

```ts
assert.equal(
  result.observedIntervalCount
    + result.verifiedNoTradeIntervalCount
    + result.unexplainedMissingIntervalCount,
  result.expectedIntervalCount,
);
```

Cover a single no-trade hour, a canonical multi-hour no-trade range, a genuine
unexplained gap, and exact `[from,to)` clipping.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-hourly-coverage.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL because `performance-hourly-coverage.ts` does not exist.

- [ ] **Step 3: Implement the minimal exact-instant partitioner**

Use `performanceTimestampEpochNanoseconds`, a fixed
`3_600_000_000_000n` interval, and canonical interval keys:

```ts
`${formatTimestamp(openNs)}/${formatTimestamp(closeNs)}`
```

Validate finite safe counts, explicit timezones, `from < to`, exact 1h
alignment, strict range ordering, non-overlap, no adjacent split ranges,
declared `missingCandleCount`, `sourceBoundary.historyStartAt <= from < to <=
sourceBoundary.endAt`, no-trade ranges inside that acquisition boundary,
duplicate observations, and observed/no-trade collisions. Clip valid no-trade
ranges to the requested `[from,to)` window only after validating the full
authoritative range. Return defensive copies.

- [ ] **Step 4: Add rejection and ordering tests**

Cover reversed, off-grid, overlapping, adjacent non-canonical, out-of-bound,
duplicate, and observed-collision inputs; mixed timezone values must sort by
epoch rather than text.

- [ ] **Step 5: Verify GREEN and run related coverage tests**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-hourly-coverage.test.js'); await import('./dist/tests/performance-candle-coverage.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: PASS. Do not commit.

---

### Task 2: General Position-Episode Excursion Integration

**Files:**
- Modify: `src/modules/performance/performance-excursions.ts`
- Modify: `tests/performance-excursions.test.ts`

**Interfaces:**
- Consumes: `partitionHourlyCoverage` and verified 1h `CandleCoverageGap[]`.
- Extends `PerformanceExcursionInput` with optional
  `verifiedNoTradeCoverage?: { sourceBoundary: { historyStartAt: string;
  endAt: string }; ranges: readonly CandleCoverageGap[] }`; omission means no
  interval is excused. The integrated evaluator supplies the immutable
  research dataset provenance as the source boundary.
- Adds this additive evidence to each `EpisodeExcursion`:

```ts
coverage: {
  expectedIntervalCount: number;
  observedIntervalCount: number;
  verifiedNoTradeIntervalCount: number;
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
  unexplainedMissingIntervals: readonly string[];
};
```

- [ ] **Step 1: Write a failing no-trade episode test**

Create a completed episode with observed entry/exit boundary candles and one
internal missing hour covered by a verified no-trade range. Assert MAE/MFE is
`KNOWN`, extrema use only observed candles, no
`MISSING_INTERNAL_CANDLE_COVERAGE` gap is emitted, and coverage records one
verified no-trade interval.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-excursions.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL because the input and output do not yet accept no-trade evidence.

- [ ] **Step 3: Integrate the partitioner without changing OHLC calculation**

Replace `hasInternalGap` as the authority with `partitionHourlyCoverage`.
Continue passing only actual `intervalCandles` to `calculateExcursions`.
Emit `MISSING_INTERNAL_CANDLE_COVERAGE` only when
`unexplainedMissingIntervalCount > 0`.

Reject a verified no-trade interval that covers the entry or exit fill boundary
or collides with an observed candle. Preserve strict entry and exit candle
coverage checks.

- [ ] **Step 4: Add regression tests**

Prove an unexplained gap remains `UNKNOWN`, entry/exit boundary gaps remain
unknown, mixed timezone behavior is unchanged, malformed no-trade ranges fail,
and callers omitting the new input retain legacy conservative behavior.

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-hourly-coverage.test.js'); await import('./dist/tests/performance-excursions.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: PASS. Do not commit.

---

### Task 3: ADD Post-Decision Excursion Integration

**Files:**
- Modify: `src/modules/performance/performance-add-excursions.ts`
- Modify: `tests/performance-add-excursions.test.ts`

**Interfaces:**
- Consumes: `partitionHourlyCoverage` and verified 1h `CandleCoverageGap[]`.
- Extends `AddPostDecisionExcursionInput` with optional
  `verifiedNoTradeCoverage?: { sourceBoundary: { historyStartAt: string;
  endAt: string }; ranges: readonly CandleCoverageGap[] }`.
- Adds `verifiedNoTradeIntervalCount` and `verifiedNoTradeRanges` to
  `AddExcursionCoverage` while retaining `missingIntervals` as unexplained
  missing intervals.

- [ ] **Step 1: Write a failing ADD no-trade test**

Create an executed ADD exposure followed by a completed episode with one
internal verified no-trade hour. Assert `status === "KNOWN"`, reason is null,
extrema use actual candles only, and coverage conserves expected intervals.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-add-excursions.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

- [ ] **Step 3: Integrate shared coverage**

Replace the local expected/observed/missing partition with the shared helper.
Return `MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE` only for unexplained missing
intervals. Never create an OHLC value for a verified no-trade interval.

- [ ] **Step 4: Add unchanged-boundary regression tests**

Assert `BASELINE_PATH_DECISION_DIVERGED`, `BASELINE_ADD_NOT_EXECUTED`, open
episode, same-instant close, and corrupt lifecycle behavior are unchanged.
Add collision and malformed-range rejection tests.

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-hourly-coverage.test.js'); await import('./dist/tests/performance-add-excursions.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: PASS. Do not commit.

---

### Task 4: Persisted Mark Exclusion Provenance

**Files:**
- Modify: `src/modules/performance/performance-diagnostics.ts`
- Modify: `tests/performance-diagnostics.test.ts`

**Interfaces:**
- Produces stable public types:

```ts
export type MarkValuationMetricScope = "GROSS" | "NET";

export type MarkValuationExclusionReason =
  | "MISSING_ACTIVE_POSITION_MARK"
  | "INCOMPLETE_ACQUISITION_COST"
  | "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION"
  | "INCOMPLETE_REMAINING_BUY_FEE"
  | "INCOMPLETE_REALIZED_NET_ATTRIBUTION";

export type MarkObservationExclusion = {
  snapshotId: string;
  capturedAt: string;
  market: PerformanceMarket;
  metricScopes: readonly MarkValuationMetricScope[];
  reasonCodes: readonly MarkValuationExclusionReason[];
};
```

- Adds `excludedObservations: readonly MarkObservationExclusion[]` to
  `MarkPnlCurveDiagnostics`.

- [ ] **Step 1: Write failing mark provenance tests**

Use existing mark fixtures to assert exact exclusion entries for:

- missing ETH mark while an ETH selected-stream quantity is active;
- non-finite selected-stream acquisition/realized attribution;
- missing buy fee where gross is usable and net is unknown.

Assert combined and per-market manifests are deterministically sorted by
captured epoch, snapshot ID, market, metric scope, and reason code.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-diagnostics.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

- [ ] **Step 3: Replace null-only internal valuation with typed evidence**

Make `valueAtObservation` return gross/net values plus market-specific reason
records. Preserve all current curve and count semantics:

```ts
type MarkValuationResult = {
  gross: number | null;
  net: number | null;
  exclusions: readonly MarkObservationExclusion[];
};
```

Do not turn missing fees or marks into zero. Deduplicate identical exclusion
records and return defensive copies.

- [ ] **Step 4: Add compatibility tests**

Assert the existing persisted/usable/sample counts, `KNOWN`/`UNKNOWN` states,
drawdowns, and no-observation `NOT_APPLICABLE` behavior are byte-for-byte
unchanged except for the additive manifest.

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-diagnostics.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: PASS. Do not commit.

---

### Task 5: Integrated Report, Text Output, and Documentation

**Files:**
- Modify: `src/research/integrated-strategy-evaluation.ts`
- Modify: `tests/integrated-strategy-evaluation.test.ts`
- Modify: `src/research/performance-report.ts`
- Modify: `tests/performance-report.test.ts`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`

**Interfaces:**
- Integrated evaluation passes defensive copies of the local
  `featureCoverage.timeframes["1h"].sourceNoTradeRanges`, together with
  `dataset.provenance.historyStartAt` and `dataset.provenance.endAt`, to both
  excursion analyzers only when the same timeframe has
  `sourceSequenceStatus === "COMPLETE"` and
  `sourceBlockingAnomalyCount === 0`.
- `MARK_DATA_PARTIAL` and `MARK_DATA_UNUSABLE` gaps use unique excluded
  snapshot IDs as `evidenceIds` and summarize reason-code counts in `message`.

- [ ] **Step 1: Write failing integrated no-trade tests**

Extend the sparse fixture so a completed episode and executed ADD exposure
cross a verified no-trade range. Assert excursion metrics are known, the
verified range remains visible, and unexplained-gap warnings are absent.

- [ ] **Step 2: Write failing mark gap tests**

Assert `MARK_DATA_PARTIAL.evidenceIds` contains the exact stable snapshot IDs,
the message includes reason-code counts, and JSON exposes the complete
exclusion manifest. Text output shows counts and newest bounded exclusions
without hiding the JSON detail path.

- [ ] **Step 3: Verify RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/integrated-strategy-evaluation.test.js'); await import('./dist/tests/performance-report.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

- [ ] **Step 4: Wire authoritative coverage and mark provenance**

Pass defensive copies of verified no-trade ranges. If the authoritative source
sequence is incomplete or anomalous, pass no approved ranges and preserve
conservative unknown excursion results. Map mark exclusions without performing
new DB or network reads.

- [ ] **Step 5: Update root documentation**

Document:

- no-trade intervals add no OHLC extreme and are never synthesized;
- unexplained gaps remain unknown;
- mark exclusion manifests are persisted-evidence diagnostics only;
- left-censored fees and model divergence remain unresolved; and
- future holdout evaluation is separate from frozen W1/W2/W3 evidence.

- [ ] **Step 6: Verify GREEN and compatibility**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-hourly-coverage.test.js'); await import('./dist/tests/performance-excursions.test.js'); await import('./dist/tests/performance-add-excursions.test.js'); await import('./dist/tests/performance-diagnostics.test.js'); await import('./dist/tests/performance-report.test.js'); await import('./dist/tests/integrated-strategy-evaluation.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: PASS. Do not commit.

---

### Task 6: Full Verification and Immutable Read-Only Report

**Files:**
- Create: `var/research/conditional-add-excursion-mark-20260814.json` as an ignored immutable local artifact.
- Inspect only: `var/company-live.sqlite`, `var/company-live.sqlite-wal`, `var/company-live.sqlite-shm`.

- [ ] **Step 1: Run all static and test verification**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Record DB hashes and runtime process state**

```powershell
Get-FileHash .\var\company-live.sqlite, .\var\company-live.sqlite-wal, .\var\company-live.sqlite-shm -Algorithm SHA256 -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[\\/]src[\\/]index\.js' } | Select-Object ProcessId, Name, CommandLine
```

- [ ] **Step 3: Generate a new report without overwriting prior evidence**

Run the integrated evaluator with:

```text
database=./var/company-live.sqlite
exchange_account_id=primary
execution_mode=LIVE
origin=STRATEGY
btc_dataset=./var/research/krw-btc-20250101-20260811.json
eth_dataset=./var/research/krw-eth-20250101-20260811.json
initial_cash_per_asset=1000000 KRW
initial_quantity_per_asset=0
initial_average_entry_price_per_asset=0 KRW
scenarios=BASELINE,NO_ADD,ADD_RISK_CLEAR,ADD_HIGH_ALIGNMENT,ADD_CORE_TREND
base_cost=fee 0.0005, slippage 0.0003
stress_cost=fee 0.001, slippage 0.002
validation_windows=W1:[2025-07-20T00:00:00Z,2025-10-25T19:00:00Z),W2:[2025-10-26T00:00:00Z,2025-12-31T19:00:00Z),W3:[2026-01-01T00:00:00Z,2026-04-12T19:00:00Z)
validation_frame_interval_ms=3600000
validation_comparison_tolerance_pp=0.000001
validation_minimum_windows=3
format=json
```

Write UTF-8 without BOM to the new path only after successful JSON parsing.

- [ ] **Step 4: Assert report semantics**

Read the new JSON and assert:

```ts
assert.equal(gapCount("MISSING_INTERNAL_CANDLE_COVERAGE"), 0);
assert.equal(gapCount("ADD_POST_DECISION_EXCURSION_MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE"), 0);
assert.equal(btcOneHour.sourceNoTradeIntervalCount, 24);
assert.equal(ethOneHour.sourceNoTradeIntervalCount, 25);
assert.equal(markGapEvidenceIds.length, 5);
assert.ok(markGapEvidenceIds.every((id) => excludedSnapshotIds.has(id)));
assert.ok(report.conditionalAddPolicyEvaluation.assets.every((asset) =>
  asset.candidates.every((candidate) => candidate.status === "INSUFFICIENT")));
```

Also record the remaining left-censored fee, opening episode, mark, and model
comparison warnings without reclassifying them as errors.

- [ ] **Step 5: Prove non-mutation**

Repeat Step 2. DB/WAL/SHM hashes and process state must match unless an
independently running process wrote concurrently. Never stop a runtime to force
stable hashes.

- [ ] **Step 6: Independent final review**

Assign a read-only reviewer to inspect the complete change for:

- no unverified gap accepted as no-trade;
- no synthetic OHLC in excursions;
- exact count conservation and boundary handling;
- additive JSON compatibility;
- correct mark evidence IDs/reasons;
- unchanged candidate thresholds/status logic; and
- no execution or runtime import-graph change.

Fix validated findings through the task review loop, rerun affected tests, and
stop before commit or push.
