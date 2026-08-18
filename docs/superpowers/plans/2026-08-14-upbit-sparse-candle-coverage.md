# Upbit Sparse Candle Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offline PositionGuard research treat Upbit no-trade clock intervals as explicit, non-blocking evidence while continuing to block true sequence corruption and acquisition failure.

**Architecture:** Keep immutable candle parsing and the observed-candle replay unchanged. Split coverage into (1) source-sequence continuity, which controls feature and candidate eligibility, and (2) nominal clock-grid coverage, which reports dense, sparse-by-contract, or anomalous evidence. Propagate known 1h no-trade ranges into conditional ADD window/upstream cadence checks without synthesizing candles or changing runtime code.

**Tech Stack:** TypeScript 5.8 strict mode, Node.js 22+, custom `tests/harness.ts`, immutable JSON research artifacts, read-only SQLite performance evidence.

## Global Constraints

- Do not call Upbit APIs, Telegram polling, `/sync`, strategy runs, scheduler ticks, or order mutation paths.
- Do not open the operational SQLite database except through the existing read-only reporting path.
- Do not change runtime snapshot, strategy, execution, reconciliation, Telegram, migration, or secret/config files.
- Do not synthesize, forward-fill, or interpolate OHLCV data.
- Preserve existing `sourceCadenceStatus` and `sourceMissing*` fields as raw nominal-grid evidence.
- Add explicit sequence and clock-grid fields; candidate gates must consume sequence validity rather than raw nominal gaps.
- Do not commit or push. The user will request those actions separately.

---

## Task 1: Split Source Sequence Validity From Clock-Grid Sparsity

**Files:**
- Modify: `tests/performance-candle-coverage.test.ts`
- Modify: `tests/position-guard-backtest-frames.test.ts`
- Modify: `src/modules/performance/performance-candle-coverage.ts`

- [ ] **Step 1: Replace the old gap-is-corruption expectations with RED tests**

Add assertions covering an internal one-hour gap, adjacent gaps, sparse `1h`/`4h`/`1d`, and an instant during a no-trade interval:

```ts
assert.equal(result.status, "COMPLETE");
assert.equal(result.continuityPolicy, "GENERATED_CANDLES_SINCE_DATASET_START");
assert.equal(result.timeframes["1h"].sourceCadenceStatus, "INCOMPLETE");
assert.equal(result.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
assert.equal(result.timeframes["1h"].clockGridStatus, "SPARSE_BY_CONTRACT");
assert.equal(result.timeframes["1h"].sourceNoTradeIntervalCount, 2);
assert.deepEqual(result.timeframes["1h"].sourceNoTradeRanges, [{
  firstMissingClose: "2026-01-10T01:00:00.000Z",
  lastMissingClose: "2026-01-10T02:00:00.000Z",
  missingCandleCount: 2,
  previousObservedClose: "2026-01-10T00:00:00.000Z",
  nextObservedClose: "2026-01-10T03:00:00.000Z",
}]);
```

Retain and strengthen blocking tests:

```ts
assert.equal(duplicate.timeframes["1h"].sourceSequenceStatus, "INCOMPLETE");
assert.equal(duplicate.timeframes["1h"].clockGridStatus, "ANOMALOUS");
assert.equal(duplicate.timeframes["1h"].sourceBlockingAnomalyCount, 1);
assert.equal(offGrid.status, "INCOMPLETE");
assert.equal(insufficientActualCandles.status, "INCOMPLETE");
assert.throws(() => analyzePositionGuardFeatureCoverage(futureInput), /future candle/i);
```

Add a frame-builder regression proving the replay remains candle-close-driven:

```ts
assert.deepEqual(frames.map((frame) => frame.generatedAt), observedOneHourCloses);
assert.equal(frames.some((frame) => frame.generatedAt === absentClockClose), false);
assert.equal(frames.at(-1)?.source.candleCounts["1h"], observedOneHourCandles.length);
assert.equal(frames.at(-1)?.source.latestCloseTime["4h"], latestObservedFourHourClose);
assert.equal(frames.at(-1)?.source.latestCloseTime["1d"], latestObservedOneDayClose);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-candle-coverage.test.js'); await import('./dist/tests/position-guard-backtest-frames.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: compile failures for the new fields or assertion failures because nominal gaps still poison all later frames.

- [ ] **Step 3: Add the explicit source coverage contract**

Extend `PositionGuardTimeframeFeatureCoverage` without removing fields:

```ts
export type SourceSequenceStatus = "COMPLETE" | "INCOMPLETE";
export type ClockGridStatus = "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";

export type PositionGuardTimeframeFeatureCoverage = {
  sourceCadenceStatus: "COMPLETE" | "INCOMPLETE"; // compatibility: nominal grid
  sourceSequenceStatus: SourceSequenceStatus;      // authoritative gate
  clockGridStatus: ClockGridStatus;
  sourceNoTradeIntervalCount: number;
  sourceNoTradeRanges: CandleCoverageGap[];
  sourceBlockingAnomalyCount: number;
  // Preserve every existing field below this addition.
};

export type PositionGuardFeatureCoverage = {
  status: "COMPLETE" | "INCOMPLETE";
  continuityPolicy: "GENERATED_CANDLES_SINCE_DATASET_START";
  // Preserve remaining fields.
};
```

Change the private cadence result to retain sorted actual closes and to distinguish blocking anomalies from nominal gaps:

```ts
type SourceCadence = {
  // existing fields
  observedCloses: bigint[];
  firstBlockingAnomalyAt: bigint | null;
  sourceSequenceStatus: SourceSequenceStatus;
  clockGridStatus: ClockGridStatus;
};
```

- [ ] **Step 4: Make frame validity consume generated candles**

For each timeframe and decision frame:

```ts
const completedObservedCloses = source.observedCloses.filter(
  (close) => close <= frame.generatedAtNanoseconds,
);
const latestObservedClose = completedObservedCloses.at(-1) ?? null;
const latestFrameClose = requireTimestamp(
  frame.latestCompletedClose[timeframe],
  `${timeframe} latest completed close`,
).epochNanoseconds;

const affected = completedObservedCloses.length < input.requiredLookbackCandles
  || latestObservedClose === null
  || latestFrameClose !== latestObservedClose
  || (source.firstBlockingAnomalyAt !== null
    && source.firstBlockingAnomalyAt <= latestFrameClose);
```

Do not include `missingRanges` in `firstBlockingAnomalyAt`. Compute statuses deterministically:

```ts
const sourceSequenceStatus = duplicateInstants.length === 0
  && offGridInstants.length === 0
  && observedCloses.length > 0
  ? "COMPLETE"
  : "INCOMPLETE";
const clockGridStatus = duplicateInstants.length > 0 || offGridInstants.length > 0
  ? "ANOMALOUS"
  : missingRanges.length > 0
    ? "SPARSE_BY_CONTRACT"
    : "DENSE";
```

Set `sourceNoTradeRanges` to a defensive copy of nominal missing ranges and sum `sourceNoTradeIntervalCount`. Final feature `status` must require every timeframe's `sourceSequenceStatus` plus zero affected frames, not `sourceCadenceStatus`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Use the Step 2 command. Expected: all coverage and frame-builder tests pass; there are no synthetic frames.

---

## Task 2: Extend the Conditional ADD Coverage Contract

**Files:**
- Modify: `tests/performance-add-policy-evaluation.test.ts`
- Modify: `src/modules/performance/performance-add-policy-evaluation.ts`

- [ ] **Step 1: Add RED tests for no-trade-aware coverage validation**

Extend every coverage fixture with explicit fields:

```ts
windowSequenceContinuityStatus: "COMPLETE",
windowClockGridStatus: "SPARSE_BY_CONTRACT",
noTradeFrameCount: 1,
noTradeRanges: [{
  firstMissingAt: "2026-01-01T01:00:00.000Z",
  lastMissingAt: "2026-01-01T01:00:00.000Z",
  missingFrameCount: 1,
  previousObservedAt: "2026-01-01T00:00:00.000Z",
  nextObservedAt: "2026-01-01T02:00:00.000Z",
}],
upstreamSequenceContinuityStatus: "COMPLETE",
upstreamClockGridStatus: "DENSE",
upstreamNoTradeFrameCount: 0,
upstreamNoTradeRanges: [],
```

Assert that no-trade-only sparsity passes while unexplained gaps, duplicates, off-grid instants, and feature-lookback damage remain insufficient. Also assert validation rejects inconsistent counts and malformed/overlapping ranges:

```ts
assert.equal(result.gates.frameCoverage.status, "PASS");
assert.equal(result.gates.frameCoverage.fullPath.noTradeFrameCount, 1);
assert.throws(() => evaluateAddPolicyCandidate(inconsistent), /noTradeFrameCount/);
```

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/performance-add-policy-evaluation.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: compile failures for the new contract.

- [ ] **Step 3: Add no-trade and sequence fields to `AddPolicyEvaluationCoverage`**

```ts
export type AddPolicyEvaluationCoverage = {
  status: "COMPLETE" | "INCOMPLETE";
  windowCadenceStatus: "COMPLETE" | "INCOMPLETE"; // raw nominal-grid compatibility
  windowSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
  windowClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
  noTradeFrameCount: number;
  noTradeRanges: AddPolicyCadenceGap[];
  upstreamStateContinuityStatus: "COMPLETE" | "INCOMPLETE";
  upstreamSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
  upstreamClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
  upstreamNoTradeFrameCount: number;
  upstreamNoTradeRanges: AddPolicyCadenceGap[];
  // Preserve all existing fields.
};
```

`missingFrameCount` and `missingRanges` now mean unexplained expected-frame loss after subtracting approved source no-trade intervals. Raw source nominal gaps remain available under dataset `featureCoverage.sourceMissing*`.

- [ ] **Step 4: Validate exact evidence accounting and gate semantics**

Reuse `validateGapRanges` for no-trade ranges. Require:

```ts
coverage.observedFrameCount
  + coverage.noTradeFrameCount
  + coverage.missingFrameCount
  === coverage.expectedFrameCount;
```

For upstream evidence use the analogous equality. `windowClockGridStatus` is `ANOMALOUS` for unexplained missing/duplicate/off-grid evidence, `SPARSE_BY_CONTRACT` for no-trade evidence only, otherwise `DENSE`. `windowSequenceContinuityStatus` is complete only when unexplained missing, duplicate, and off-grid counts are zero. Keep `windowCadenceStatus` as raw dense-grid compatibility evidence (`INCOMPLETE` when no-trade intervals exist), but do not use it as the candidate gate.

Candidate frame coverage passes only when `status`, both sequence statuses, upstream state, and feature lookback continuity are complete. Defensively copy both new range arrays in `buildCoverageGate()`.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Use the Step 2 command. Expected: all add-policy contract tests pass.

---

## Task 3: Propagate Known No-Trade Ranges Through Integrated Evaluation

**Files:**
- Modify: `tests/integrated-strategy-evaluation.test.ts`
- Modify: `src/research/integrated-strategy-evaluation.ts`

- [ ] **Step 1: Add an integrated sparse-dataset RED test**

Create a fixture with at least 201 actual generated candles per timeframe, remove deterministic aligned candles, and keep the provenance clock boundaries unchanged. Assert:

```ts
assert.equal(dataset.featureCoverage?.status, "COMPLETE");
assert.equal(dataset.featureCoverage?.timeframes["1h"].sourceMissingCandleCount, 2);
assert.equal(dataset.featureCoverage?.timeframes["1h"].sourceNoTradeIntervalCount, 2);
assert.equal(dataset.featureCoverage?.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
assert.equal(dataset.featureCoverage?.timeframes["1h"].clockGridStatus, "SPARSE_BY_CONTRACT");

assert.equal(candidate.gates.frameCoverage.fullPath.status, "COMPLETE");
assert.equal(candidate.gates.frameCoverage.fullPath.missingFrameCount, 0);
assert.equal(candidate.gates.frameCoverage.fullPath.noTradeFrameCount, 2);
assert.match(text, /sequence=COMPLETE/);
assert.match(text, /clock_grid=SPARSE_BY_CONTRACT/);
assert.match(text, /no_trade_intervals=2/);
```

Run the report twice and deep-compare JSON. Add a corrupt duplicate/off-grid fixture asserting candidate status remains `INSUFFICIENT`.

- [ ] **Step 2: Run the focused integrated test and confirm RED**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/integrated-strategy-evaluation.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: sparse source still yields incomplete candidate cadence or new output fields are absent.

- [ ] **Step 3: Pass source no-trade evidence into candidate cadence calculations**

At `buildConditionalCandidateEvaluations()` select the authoritative 1h source no-trade ranges:

```ts
const noTradeFrameRanges = featureCoverage.timeframes["1h"].sourceNoTradeRanges;
```

Extend the pure API:

```ts
export function calculateConditionalAddCadenceCoverage(input: {
  from: string;
  to: string;
  replayStartAt?: string;
  expectedFrameIntervalMs: number;
  frames: readonly { generatedAt: string }[];
  featureLookbackAffectedRanges: readonly AddPolicyAffectedFrameRange[];
  noTradeFrameRanges: readonly CandleCoverageGap[];
}): AddPolicyEvaluationWindow["coverage"];
```

Add the same range parameter to `calculateFullPathCadenceCoverage()`. Slice/expand ranges only inside each exact `[from,to)` boundary; reject ranges that are malformed or not aligned to `expectedFrameIntervalMs`.

- [ ] **Step 4: Classify expected frame instants without synthesizing frames**

Extend `buildConditionalAddCadenceDetail()` with `noTradeInstants: ReadonlySet<bigint>`. Partition every expected instant into observed, known no-trade, or unexplained missing:

```ts
const noTradeInstants = expectedInstants.filter(
  (instant) => !observedCounts.has(instant) && input.noTradeInstants.has(instant),
);
const missingInstants = expectedInstants.filter(
  (instant) => !observedCounts.has(instant) && !input.noTradeInstants.has(instant),
);
const sequenceComplete = missingInstants.length === 0
  && duplicateFrameCount === 0
  && offGridFrameCount === 0;
```

Group `noTradeInstants` with the existing deterministic gap grouping helper. Set raw `windowCadenceStatus` to complete only when there are no no-trade, missing, duplicate, or off-grid observations. Set sequence and clock-grid statuses according to Task 2. Overall coverage may be complete when raw cadence is sparse but sequence, upstream state, and feature lookback continuity pass.

- [ ] **Step 5: Update stable text and JSON presentation**

Keep raw values and add explicit meanings:

```ts
`${asset} dataset ${timeframe}: source_cadence=${coverage.sourceCadenceStatus}; sequence=${coverage.sourceSequenceStatus}; clock_grid=${coverage.clockGridStatus}; observed=${coverage.sourceObservedCandleCount}; expected=${coverage.sourceExpectedCandleCount}; no_trade_intervals=${coverage.sourceNoTradeIntervalCount}; raw_missing=${coverage.sourceMissingCandleCount}; duplicate=${coverage.sourceDuplicateCandleCount}; off_grid=${coverage.sourceOffGridCandleCount}; recursive_input=${coverage.lookbackContinuityStatus}; affected_frames=${coverage.affectedFrameCount}`
```

Ensure JSON naturally includes the new typed fields and no-trade ranges. Do not rename or remove the old fields.

- [ ] **Step 6: Run focused integrated tests and confirm GREEN**

Use the Step 2 command. Expected: sparse fixtures are eligible on coverage alone; corrupt fixtures remain blocked; repeated text/JSON is deterministic.

---

## Task 4: Align Authoritative Documentation

**Files:**
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Update the product boundary**

Replace the rules that every nominal gap poisons recursive input with these explicit boundaries:

- Upbit-generated candle sequence continuity is authoritative for offline strategy inputs.
- Empty nominal intervals are persisted as no-trade evidence and are non-blocking by themselves.
- Acquisition-boundary failure, insufficient actual candles, duplicate/off-grid/future data, and unexplained candidate-frame loss remain blocking.
- No synthetic candles or scheduler-clock equivalence claim is permitted.

- [ ] **Step 2: Update architecture and operator documentation**

Document the two-dimensional coverage model, compatibility status of raw `sourceMissing*`, candidate cadence accounting, unchanged candle-close replay, and the separate scope of MAE/MFE completeness. Update CLI output examples to use `sequence`, `clock_grid`, `no_trade_intervals`, and `raw_missing` terminology.

- [ ] **Step 3: Check documentation consistency**

```powershell
rg -n "prior source gap|earlier gap|missing expected frame|source cadence|no.trade|synthetic" PRODUCT_BOUNDARY.md ARCHITECTURE.md README.md
```

Expected: no authoritative text still says a confirmed no-trade interval automatically blocks all later recursive inputs.

---

## Task 5: Full Verification and Immutable Research Report

**Files:**
- Create: `var/research/conditional-add-evaluation-sparse-20260814.json` (generated, immutable local artifact; include in Git only if repository policy already tracks comparable artifacts)
- Inspect only: `var/company-live.sqlite`, `var/company-live.sqlite-wal`, `var/company-live.sqlite-shm`

- [ ] **Step 1: Verify type safety and all tests**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run check
git diff --check
```

Expected: all commands exit 0. If `npm.cmd run check` already includes typecheck/tests, retain the explicit runs as auditable evidence.

- [ ] **Step 2: Record operational non-mutation hashes and process state**

Hash every existing operational DB sidecar before the report and inspect the AutoTrade process without stopping or restarting it:

```powershell
Get-FileHash .\var\company-live.sqlite, .\var\company-live.sqlite-wal, .\var\company-live.sqlite-shm -Algorithm SHA256 -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'AutoTrade_Upbit|dist/src/index.js' } | Select-Object ProcessId, Name, CommandLine
```

- [ ] **Step 3: Generate a new report from immutable evidence**

Use the existing LIVE attribution filter and do not overwrite the previous report:

```powershell
npm.cmd run build
node .\dist\src\research\integrated-strategy-evaluation.js --database ./var/company-live.sqlite --exchange-account-id primary --execution-mode LIVE --origin STRATEGY --btc-dataset ./var/research/krw-btc-20250101-20260811.json --btc-initial-state '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}' --eth-dataset ./var/research/krw-eth-20250101-20260811.json --eth-initial-state '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}' --scenarios '["BASELINE","NO_ADD","ADD_RISK_CLEAR","ADD_HIGH_ALIGNMENT","ADD_CORE_TREND"]' --minimum-order-value-krw 5000 --cost-cells '[{"id":"base","feeRate":0.0005,"slippageRate":0.0003},{"id":"stress","feeRate":0.001,"slippageRate":0.002}]' --validation-windows '[{"id":"W1","from":"2025-07-20T00:00:00Z","to":"2025-10-25T19:00:00Z"},{"id":"W2","from":"2025-10-26T00:00:00Z","to":"2025-12-31T19:00:00Z"},{"id":"W3","from":"2026-01-01T00:00:00Z","to":"2026-04-12T19:00:00Z"}]' --validation-frame-interval-ms 3600000 --validation-comparison-tolerance-pp 0.000001 --validation-minimum-windows 3 --format json | Set-Content -LiteralPath .\var\research\conditional-add-evaluation-sparse-20260814.json -Encoding utf8
```

- [ ] **Step 4: Verify report semantics**

Assert with a read-only Node inspection:

```ts
assert.equal(btc.featureCoverage.timeframes["1h"].sourceNoTradeIntervalCount, 24);
assert.equal(eth.featureCoverage.timeframes["1h"].sourceNoTradeIntervalCount, 25);
assert.equal(btc.featureCoverage.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
assert.equal(eth.featureCoverage.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
assert.ok(report.conditionalAddPolicyEvaluation.assets.every((asset) =>
  asset.status !== "AVAILABLE"
  || asset.candidates.every((candidate) =>
    candidate.gates.frameCoverage.fullPath.missingFrameCount === 0)));
```

Record candidate eligibility, sample-support gates, modeled returns, and all remaining evidence warnings without interpreting coverage repair as deployment approval.

- [ ] **Step 5: Prove operational state was not mutated**

Repeat Step 2. Expected: process identity/state is unchanged; DB/WAL/SHM hashes are unchanged unless the independently running LIVE process wrote concurrently. If concurrent writes occur, report that limitation and rely on the reporting adapter's `readOnly: true` plus the absence of mutation commands; never pause or stop LIVE to force stable hashes.

- [ ] **Step 6: Final independent review**

Assign a read-only reviewer to check:

- no nominal no-trade interval can bypass duplicate/off-grid/future or acquisition-boundary checks;
- no synthetic candle enters indicators, candidate replay, or excursion calculations;
- old raw JSON fields remain present;
- new sequence fields are the only coverage gate;
- runtime and execution import graphs are unchanged;
- report claims remain attribution/research only, not deployment approval.

Fix any validated finding, rerun Task 5 Steps 1-5, and stop before commit/push.
