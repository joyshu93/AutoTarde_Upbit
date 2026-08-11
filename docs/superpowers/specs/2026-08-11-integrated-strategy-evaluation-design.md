# Integrated Strategy Evaluation Design

Date: 2026-08-11
Status: implemented; documentation contract reconciled with Task 6 CLI/tests

## Goal

Extend the read-only performance diagnostics into one professional evaluation report that presents observed LIVE attribution and simulated counterfactual research together without combining their evidence or returns.

The implementation diagnoses strategy behavior. It does not change strategy rules, runtime wiring, execution state, orders, scheduler behavior, Telegram polling, migrations, secrets, or live-order configuration.

## Safety And Evidence Boundaries

- The operational SQLite database is opened only with `readOnly: true`.
- The observed filter accepts only `execution_mode=LIVE`; `DRY_RUN` is rejected because this report's observed evidence kind is `OBSERVED_LIVE_ATTRIBUTION`.
- No Upbit endpoint, sync, scheduler tick, strategy run, Telegram poll, order mutation, migration, or runtime graph is invoked.
- Observed LIVE results are labelled `OBSERVED_LIVE_ATTRIBUTION`.
- Backtest results are labelled `SIMULATED_COUNTERFACTUAL`.
- Modeled fee and slippage results are labelled `MODELED_COST_SCENARIO`.
- Observed, simulated, and modeled values are never summed into one return.
- BTC and ETH simulations use independent capital and are not presented as one portfolio return.
- The report remains selected-order-stream attribution, not total account return.
- Missing candle datasets, marks, fees, costs, decisions, or lifecycle evidence produce structured gaps rather than zero-valued assumptions.

## Data Sources

### Observed Evidence

The existing SQLite performance reader supplies selected fills, strategy decisions, opening inventory, and persisted position marks under explicit `exchange_account_id`, LIVE-only `execution_mode`, `origin`, and `[from,to)` filters.

### Simulation Evidence

Counterfactual analysis consumes immutable local candle datasets outside the operational database. A schema-version-1 dataset contains normalized completed `1h`, `4h`, and `1d` candles; asset and matching KRW market; `historyStartAt`, `endAt`, `collectedAt`, and non-empty source provenance; and a lowercase SHA-256 checksum of canonical validated content excluding the declared checksum. Candles use explicit-timezone timestamps, exact timeframe durations, positive OHLC, nonnegative volume, and strict exact-instant ordering.

The integrated evaluator does not collect candles. The existing public-candle reader remains a separate research acquisition path and is not called by this work. An omitted asset dataset returns `DATASET_UNAVAILABLE`. A supplied schema-valid dataset that cannot build frames returns `DATASET_UNUSABLE` across the simulated, cost, regime, and excursion asset sections, with `reasonCode` `EMPTY_TIMEFRAME_CANDLES`, `INSUFFICIENT_COMPLETED_CANDLES`, or `NO_OVERLAPPING_REPLAY_WINDOW`, plus a structured `DATASET_UNUSABLE` gap. Malformed JSON, invalid provenance/checksum, or asset/market mismatch remains an explicit error.

## Observed LIVE Analysis

The existing FIFO and episode definitions remain authoritative:

- Default win rate uses completely closed flat-to-flat position episodes.
- FIFO realization-slice win rate remains separate.
- Partial sells do not become completed episodes.
- Opening inventory remains separate and creates `LEFT_CENSORED_OPENING_INVENTORY` evidence.
- Open episodes are excluded from realized win rate and average realized PnL.

Action contribution gains explicit dimensions:

- `ENTRY_LOT_ATTRIBUTION` attributes each FIFO realization slice to `ENTER`, `ADD`, or unknown entry evidence.
- `EXIT_FILL_ATTRIBUTION` attributes the same realized PnL to `REDUCE`, `EXIT`, or unknown exit evidence.
- These are alternative views of the same PnL and must never be added together.
- Every action result includes realization-slice count, distinct fill count, distinct decision count, completed-episode count, realized quantity, gross PnL, observed fee impact, and net PnL.

The emitted source totals follow the same boundary. `observedLive.attribution.totals` is selected-stream only and `openingInventoryTotals` is opening-inventory only. `actionDimensions.entry.sourceContributions.SELECTED_STREAM` contains selected entries; `actionDimensions.exit.sourceContributions.SELECTED_STREAM` and `.OPENING` retain separate exit views. None of these source totals or alternative attribution views may be summed.

Completed episodes are grouped into explicit holding buckets: under 24 hours, 1 to under 3 days, 3 to under 7 days, 7 to under 14 days, and 14 days or longer. Bucket boundaries use exact epoch timestamps.

## Sample Support And Evidence Gaps

Metrics remain numerically available when evidence is complete, while interpretation support is reported separately:

- fewer than 10 observations: `INSUFFICIENT`
- 10 through 29: `PRELIMINARY`
- 30 or more: `SUPPORTED`

This policy is an operator interpretation aid, not a statistical significance claim.

Warnings become structured evidence gaps with code, severity, scope, affected metrics, evidence IDs, and a stable message. Required codes include opening-inventory censoring, open episodes, missing fees, missing decisions, attribution failures, missing or unusable marks, sparse marks, unavailable candle datasets, and ambiguous timestamps.

Mark diagnostics distinguish `persistedObservationCount` from `usableObservationCount` on `observedLive.diagnostics.markPnlCurve` and each `marketMarkPnlCurves` entry. Zero persisted observations produce `MARK_DATA_UNAVAILABLE` and `NOT_APPLICABLE`; persisted but zero usable observations produce `MARK_DATA_UNUSABLE` and `UNKNOWN`; a usable strict subset produces `MARK_DATA_PARTIAL` and retains `UNKNOWN`. Drawdown reports usable `sampleCount` and `maxObservationGapMs`, with no interpolation or future mark.

## Counterfactual Scenarios

The same immutable frames are replayed independently for every scenario.

- `BASELINE` executes the unmodified PositionGuard decisions.
- `NO_ADD` preserves each original `ADD` decision and diagnostics but blocks only its simulated execution through an explicit research execution policy.

Suppressing an ADD can change later balances, exposure, average entry, decisions, and order sizes. Therefore every scenario replays the full path from the same initial state; it does not delete ADD fills from an already-produced baseline result.

The runtime strategy function and settings are not changed. Research policy exists only in the pure backtest boundary.

Frame `generatedAt` and source close-time provenance preserve the decision candle's original explicit offset and up-to-nine-digit fraction. Frame filtering, completed-candle cutoffs, counterfactual ordering, and FIFO matching compare exact epoch nanoseconds. Counterfactual fills retain the exact frame timestamp; FIFO uses stable fill-ID ordering for same-side ties and rejects opposite-side fills for one market at the same exact instant.

Simulated trades are converted to the professional FIFO matcher input so episode win rate, partial sells, profit factor, holding time, and realized PnL use the same definitions as observed diagnostics. Legacy average-cost backtest metrics remain available but are identified as legacy simulation fields.

## Cost Sensitivity

Each strategy scenario is replayed for an explicit grid of fee and slippage rates. There are no hidden cost defaults in the integrated report. The initial grid is supplied by the caller. Every `costSensitivity.assets[].cells[]` row records `costScenario`, `tradeCount`, `finalEquityKrw`, `totalReturnPct`, `maxDrawdownPct`, `turnoverKrw`, `modeledFeesKrw`, `completedEpisodeCount`, `episodeWinRate`, and `profitFactor`. `costMetricScope: ALL_SIMULATED_FILLS` means turnover and modeled fees include every simulated fill, including opening-inventory exits. `fifoOutcomeMetricScope: SELECTED_STREAM_FIFO` means completed episodes, episode win rate, and profit factor remain selected-stream FIFO outcomes.

Cost cells reuse one loaded dataset and one frame set. They do not fetch data again. Changes in cash, future sizing, and future decisions caused by costs are retained as valid path dependence.

## Market Regime Analysis

The evaluator uses the existing deterministic `analysis.regime` created at each historical decision frame. It does not introduce a second regime classifier.

For each asset, scenario, cost cell, and regime, the report provides frame count, decision counts, executed trades, completed realization evidence, turnover, gross/net realized PnL, win rate, and sample support. A regime is assigned only from information available at that frame.

## MAE And MFE

MAE/MFE is computed only for completed simulated episodes with local 1h OHLC evidence. Candles must be completed and observable before the exit decision. No post-exit high/low, future frame, interpolation, or inferred tick path is used.

Because candle OHLC cannot reveal intrabar ordering, MAE/MFE is descriptive excursion evidence and is not used to simulate stops or alter execution. Missing interval coverage produces `UNKNOWN` with evidence gaps.

## Integrated Output

Stable JSON and readable text contain these top-level sections:

1. `provenance`
2. `observedLive`
3. `simulatedCounterfactuals`
4. `costSensitivity`
5. `regimeAnalysis`
6. `excursionAnalysis`
7. `evidenceGaps`
8. `interpretation`

Interpretation may identify descriptive loss concentrations and robust scenario differences. It must not claim causality, profitability, statistical significance, or recommend a production strategy change from insufficient samples.

The concrete CLI is `npm run report:strategy-evaluation --`. It requires `--database`, `--exchange-account-id`, `--execution-mode LIVE`, and `--origin`; accepts optional exact `[from,to)` filters and `--format text|json`; and enters simulation mode only when at least one of `--btc-dataset` or `--eth-dataset` is supplied. Each supplied dataset requires its paired `--btc-initial-state` or `--eth-initial-state` JSON object (`cashKrw`, `quantity`, `averageEntryPriceKrw`), plus explicit `--scenarios`, `--minimum-order-value-krw`, and `--cost-cells`. Supported scenarios are `BASELINE` and `NO_ADD`; each cost cell has exact `id`, `feeRate`, and `slippageRate` fields. The first caller-ordered cost cell is recorded as the base simulation assumption.

The stable report sections are `provenance`, `observedLive`, `simulatedCounterfactuals`, `costSensitivity`, `regimeAnalysis`, `excursionAnalysis`, `evidenceGaps`, and `interpretation`. `observedLive` is always `AVAILABLE` with evidence kind `OBSERVED_LIVE_ATTRIBUTION`; absent BTC/ETH datasets produce per-asset `DATASET_UNAVAILABLE`, while supplied valid-but-inadequate datasets produce `DATASET_UNUSABLE`. Report serialization rejects non-finite values, `BigInt`, `undefined`, cycles, and unsupported values, while individual metrics retain explicit `KNOWN`, `UNKNOWN`, and `NOT_APPLICABLE` states. `COUNTERFACTUAL_SCENARIO_DELTA` resolves its two `metrics.totalReturnPct` JSON Pointers, computes `(NO_ADD - BASELINE) * 100`, and states the absolute difference in percentage points.

## Proposed Modules

- `performance-attribution.ts`: observed action dimensions, holding buckets, sample support, evidence gaps.
- `strategy-counterfactual.ts`: pure BASELINE/NO_ADD execution policy and scenario orchestration.
- `performance-sensitivity.ts`: explicit fee/slippage grid replay.
- `performance-regimes.ts`: existing-regime aggregation.
- `performance-excursions.ts`: completed-episode MAE/MFE from local completed candles.
- `research-candle-dataset.ts`: immutable local dataset validation and checksum provenance.
- `integrated-strategy-evaluation.ts`: report composition and text/JSON formatting.

No module is imported by execution, strategy runtime, scheduler, reconciliation, Telegram, or app creation code.

The integrated CLI is additionally absent from exchange, order, migration, and database-write graphs. Its only operational-database access is through the existing `readOnly: true` SQLite performance reader; local candle files are read through the immutable-dataset adapter only.

## Testing Requirements

- TDD for every pure module.
- Observed action counts distinguish slices, fills, decisions, and episodes.
- Entry and exit attribution cannot be accidentally summed.
- Holding bucket boundaries and open-episode exclusion.
- Structured gap stability and sample-support thresholds.
- BASELINE parity with the existing replay engine.
- NO_ADD preserves decisions while suppressing only simulated ADD execution.
- Full path replay after suppressed ADD.
- One dataset/frame set reused across cost cells.
- Existing regime assignment without future data.
- MAE/MFE interval and incomplete-coverage boundaries.
- Same-timestamp deterministic ordering and mixed timezone handling.
- BTC/ETH independent-capital warning.
- Stable finite JSON without `NaN`, `Infinity`, or `BigInt` leakage.
- Full migrated-schema compatibility and operational DB read-only verification.

## Acceptance Criteria

- Existing performance and backtest behavior remains backward compatible.
- The integrated report clearly separates observed, simulated, and modeled evidence.
- The current LIVE database produces the observed section without mutation.
- Missing local candle data does not trigger network access and produces `DATASET_UNAVAILABLE`.
- Supplied empty, underfilled, or non-overlapping candle data produces structured `DATASET_UNUSABLE` rather than empty scenario output or a thrown replay-frame error.
- Fixture datasets produce deterministic BASELINE/NO_ADD, sensitivity, regime, and MAE/MFE output.
- Typecheck, the full test suite, `git diff --check`, and independent review pass.
- Current LIVE execution state remains unchanged.
