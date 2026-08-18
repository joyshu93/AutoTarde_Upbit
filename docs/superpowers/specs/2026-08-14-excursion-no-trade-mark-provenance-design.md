# Excursion No-Trade and Mark Provenance Design

## Status

Approved design direction. Implementation has not started.

## Objective

Improve the read-only performance report without changing strategy rules or
LIVE execution. The change has two bounded goals:

1. stop classifying a verified Upbit no-trade interval as missing candle
   evidence in general and ADD post-decision excursion analysis; and
2. explain exactly which persisted mark observations were excluded from the
   mark PnL curve and why.

The existing conditional ADD result remains research evidence. This work does
not make an `INSUFFICIENT` candidate eligible and does not authorize a strategy
deployment.

## Current Evidence

The immutable report
`var/research/conditional-add-evaluation-sparse-20260814.json` shows:

- 24 repeated `MISSING_INTERNAL_CANDLE_COVERAGE` warnings. They represent six
  unique BTC/ETH episodes repeated across BASELINE/NO_ADD and base/stress cost
  cells. Their nominal gaps are verified source no-trade intervals.
- four repeated
  `ADD_POST_DECISION_EXCURSION_MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE`
  warnings. The affected exposures intersect the same verified no-trade
  intervals.
- 948 persisted mark observations and 943 gross-usable observations. The five
  excluded observations are not identified in the current report.
- one `INCOMPLETE_FEE_EVIDENCE` warning caused by left-censored opening
  inventory. That warning cannot be repaired from the selected local order
  stream.
- baseline path divergence and baseline ADD-not-executed results that are
  model comparison boundaries, not missing evidence.

## Product and Safety Boundaries

- The feature remains under the research/performance module.
- The operational SQLite database is opened with `readOnly: true` only.
- No migration, repository write, runtime wiring, scheduler tick, strategy
  cycle, reconciliation, Telegram polling, Upbit API call, or order action is
  introduced.
- No candle, OHLCV value, mark, fill, or position is synthesized, interpolated,
  forward-filled, or written back.
- Verified no-trade evidence does not excuse duplicate, off-grid, future,
  post-boundary, acquisition-boundary, or corrupted dataset evidence.
- Unknown fee, opening inventory, mark, and model-comparison evidence remains
  unknown.

## Chosen Approach

### Authoritative no-trade input

The existing candle coverage analysis remains the sole authority for source
sequence classification. Excursion code must not independently infer that an
arbitrary clock gap is a no-trade interval.

The integrated evaluator obtains the verified 1h `sourceNoTradeRanges` from
the same immutable dataset coverage result already used by conditional ADD
coverage. It passes a defensive copy of those ranges into both excursion
analyzers.

Each analyzer validates that supplied ranges are:

- aligned to the exact 1h epoch grid;
- ordered and non-overlapping;
- canonical, with adjacent intervals represented as one range;
- inside the dataset acquisition boundary; and
- disjoint from observed candle intervals.

A malformed, contradictory, or unverified range fails explicitly. It never
turns into permissive coverage.

### Pure hourly coverage helper

A shared pure helper partitions every expected hourly interval in a requested
`[from,to)` interval into exactly one of:

- `OBSERVED_CANDLE`;
- `VERIFIED_NO_TRADE`; or
- `UNEXPLAINED_MISSING`.

The helper enforces exact count conservation:

```text
observed + verified_no_trade + unexplained_missing = expected
```

It returns explicit counts and canonical ranges. It does not return synthetic
candles.

### General excursion semantics

General episode MAE/MFE continues to use only actual observed 1h OHLC candles.
An internal verified no-trade interval contributes no OHLC extreme and does
not make the excursion unknown. An unexplained missing interval still produces
`MISSING_INTERNAL_CANDLE_COVERAGE` and keeps affected metrics `UNKNOWN`.

Entry and exit boundary checks remain strict. A no-trade range cannot replace
the actual candle/fill evidence required at a boundary, and a no-trade interval
that collides with a fill or observed candle is rejected as contradictory.

The result adds coverage provenance sufficient to distinguish observed,
verified no-trade, and unexplained intervals without removing existing fields.

### ADD post-decision excursion semantics

ADD post-decision excursion uses the same helper and actual OHLC-only extreme
calculation. A verified no-trade interval no longer produces
`MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE`. An unexplained interval retains that
reason and the result remains `UNKNOWN`.

The following reasons are unchanged and must not be reclassified:

- `BASELINE_PATH_DECISION_DIVERGED`;
- `BASELINE_ADD_NOT_EXECUTED`;
- missing or corrupt baseline fill/episode relationships;
- open episodes; and
- intervals with no completed hourly observation window.

### Mark exclusion provenance

`performance-diagnostics` replaces the current null-only valuation outcome
with a typed pure result that preserves the reason for each unavailable gross
or net valuation. Stable reason codes distinguish at least:

- a missing mark price for an active selected-stream quantity;
- invalid or incomplete selected-stream acquisition cost;
- invalid realized gross attribution;
- incomplete remaining buy-fee evidence; and
- invalid realized net attribution.

The mark curve adds a bounded, deterministic exclusion manifest. Every entry
contains:

- `snapshotId`;
- `capturedAt`;
- affected market when applicable;
- affected metric scope (`GROSS`, `NET`, or both); and
- stable reason codes.

`persistedObservationCount`, `usableObservationCount`, `sampleCount`, curve
metrics, and all existing JSON fields retain their current meaning. The
manifest explains exclusions; it does not make an unusable observation usable.

Integrated `MARK_DATA_UNUSABLE` and `MARK_DATA_PARTIAL` gaps include the exact
excluded snapshot IDs and a reason-code summary. Text output remains concise;
JSON retains the full technical manifest.

## Compatibility

- Existing raw candle cadence and missing-range fields remain present.
- Existing excursion status and reason values remain present.
- Existing mark counts and metric states remain present.
- New fields are additive and deterministically ordered by epoch instant and
  stable identifier.
- Legacy reports without verified no-trade input retain current conservative
  behavior: nominal gaps are unexplained and affected excursion metrics remain
  `UNKNOWN`.

## Holdout Research Protocol

The existing W1, W2, and W3 boundaries and the 30 full-path / 10 per-window
support thresholds are frozen. They must not be widened or reduced after
seeing the current results.

A future holdout is a separate immutable report, not a repair of W2 or W3. Its
asset scope, dataset end boundary, evaluation interval, cost cells, support
thresholds, and candidate set must be recorded before its outcome is read. No
W4 behavior is added in this implementation; this protocol is documentation
for a later independently approved research task.

## Test Strategy

Implementation follows TDD and adds focused pure tests before production code.

Required cases:

- a verified single no-trade interval between observed candles;
- a multi-hour canonical no-trade range;
- an unexplained gap that remains blocking;
- a no-trade range colliding with an observed candle;
- a no-trade range colliding with a fill boundary;
- duplicate, overlapping, adjacent non-canonical, off-grid, reversed, and
  out-of-bound no-trade ranges;
- exact `[from,to)` clipping and mixed timezone epoch ordering;
- general excursion known from observed OHLC plus internal no-trade evidence;
- ADD excursion known under the same contract;
- unchanged baseline-diverged and ADD-not-executed reasons;
- mark exclusion for missing active-position mark price;
- mark exclusion for gross attribution failure;
- mark exclusion for incomplete net fee evidence while gross remains usable;
- deterministic exclusion ordering and defensive copies;
- compatibility of existing text and JSON fields;
- integrated report evidence IDs and reason summaries;
- full migration-compatible read-only DB reporting; and
- operational DB/WAL/SHM hash preservation.

## Acceptance Criteria

- The known no-trade-only excursion false positives disappear from a newly
  generated immutable report.
- No unexplained gap becomes known.
- No synthetic candle or OHLC value is introduced.
- The five currently excluded gross mark observations are individually
  identified with stable reasons from persisted evidence.
- Left-censored fees and model divergence remain explicit warnings or
  non-applicable results.
- Conditional candidate status and thresholds are unchanged.
- Typecheck, the complete test suite, repository checks, and an independent
  review pass.
- Operational database hashes and runtime state are unchanged by report
  generation.
