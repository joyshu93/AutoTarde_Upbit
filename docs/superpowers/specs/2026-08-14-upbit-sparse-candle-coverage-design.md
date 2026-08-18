# Upbit Sparse Candle Coverage Design

## Goal

Align offline research candle coverage with the behavior of the LIVE PositionGuard
strategy without weakening acquisition-integrity checks. Upbit does not generate a
candle for an interval with no trades. A missing clock-grid interval is therefore
reported as an expected no-trade interval, not automatically treated as missing
source evidence.

This work changes research evidence classification only. It does not change the LIVE
strategy, scheduler, execution graph, risk policy, order lifecycle, Telegram runtime,
operational database, or local secret configuration.

## Confirmed Evidence

- The LIVE snapshot path requests the latest 200 actual Upbit candles per timeframe
  and does not synthesize clock-grid candles.
- Indicators consume the returned candle sequence in timestamp order.
- The research collector reuses the same Upbit normalization and guarantees that
  pagination reaches the requested history boundary or fails explicitly.
- Two independent collections of each BTC and ETH dataset produced identical candle
  arrays and checksums.
- The 60-minute datasets contain 24 BTC and 25 ETH empty clock intervals. Direct
  one-minute checks found no generated one-minute candles in all 49 intervals.
- [Upbit's documented candle contract](https://global-docs.upbit.com/docs/upbit-quotation-restful-api)
  states that a candle is generated only when a trade occurs in that interval.

## Considered Approaches

### Separate sequence validity from clock-grid sparsity (selected)

Use the actual generated-candle sequence for strategy fidelity. Preserve clock-grid
gaps as explicit no-trade observations, but do not allow those observations alone to
invalidate recursive feature inputs.

This matches LIVE behavior, preserves all source facts, and introduces no synthetic
prices or volumes.

### Synthesize zero-volume candles (rejected)

Carry forward the preceding close as OHLC and set volume to zero. This creates a
regular grid but changes EMA, ATR, RSI, MACD, and volume calculations relative to the
LIVE implementation. The generated values would be assumptions rather than Upbit
evidence.

### Restart analysis after every sparse interval (rejected)

Discard a new warm-up period after each clock-grid gap. This remains more restrictive
than LIVE behavior, wastes valid data, and does not distinguish expected no-trade
intervals from actual acquisition failures.

## Coverage Model

Coverage has two independent dimensions.

### Source sequence validity

`SOURCE_SEQUENCE_CONTINUITY` determines whether candles are safe inputs to the
strategy. It validates:

- strict timestamp parsing and epoch ordering;
- market and timeframe consistency already enforced by the dataset parser;
- exact open/close duration;
- no duplicate candle instants;
- no off-grid candle instants;
- no candle after the persisted dataset boundary;
- no frame referencing a future candle;
- at least the configured number of completed generated candles; and
- the latest completed generated candle visible at each decision instant.

Any failure makes feature coverage `INCOMPLETE` and remains candidate-gate blocking.
Collector pagination that cannot reach the requested history boundary continues to
fail before an artifact is written.

### Clock-grid coverage

`CLOCK_GRID_COVERAGE` compares observed candle instants with nominal timeframe
boundaries. Empty boundaries are retained as `NO_TRADE_INTERVAL` ranges with:

- first and last absent close time;
- interval count;
- previous observed close time; and
- next observed close time.

Clock-grid sparsity is descriptive evidence. It does not make feature coverage
incomplete when source-sequence validity passes. Duplicate and off-grid observations
are not reclassified as no-trade intervals and remain blocking anomalies.

## Runtime Fidelity

Backtest frames continue to be generated from observed 1-hour candle closes. Each
frame receives all completed generated candles for 1h, 4h, and 1d, matching the
runtime indicator input model. No artificial frame is created during an interval in
which Upbit generated no 1-hour candle.

This design does not claim full scheduler-clock equivalence. LIVE scheduler timers
can wake during a no-trade interval, while the current research replay is
candle-close-driven. A scheduler-time replay would be a separate experiment requiring
explicit ticker freshness and exchange-availability semantics.

## Output Contract

The report keeps raw observed and nominal expected counts so existing evidence is not
hidden. It adds explicit, stable meanings:

- sequence validity status used by candidate acceptance gates;
- clock-grid status distinguishing dense and sparse-by-contract data;
- no-trade interval count and ranges; and
- blocking anomaly count and ranges where applicable.

Existing `sourceMissing*` fields remain present and retain their current raw values in
this change, but are documented as nominal empty clock intervals and must not drive
feature validity by themselves. Removing or renaming those fields requires a separate
report schema-version change. New code consumes the explicit sequence and clock-grid
fields. Text output uses `no_trade_intervals` rather than implying acquisition loss.

The integrated report continues to expose dataset path, checksum, collection time,
history boundaries, and all anomaly details.

## Conditional ADD Evaluation

Candidate evaluation may proceed when:

- source-sequence validity is complete for every required timeframe;
- enough completed generated candles exist at each frame;
- window and upstream replay-state continuity pass under the same sequence model;
- cost and sample gates pass; and
- no other blocking evidence gap exists.

`NO_TRADE_INTERVAL` alone is non-blocking. Actual sequence corruption, unavailable
datasets, insufficient generated candles, and invalid lifecycle or cost evidence
remain blocking.

## Error Handling

- Never interpolate, forward-fill, or synthesize OHLCV values.
- Reject malformed, duplicate, off-grid, negative, non-finite, or future candle data.
- Keep acquisition boundary failures explicit rather than converting them to sparse
  intervals.
- Keep excursion metrics `UNKNOWN` when an episode truly lacks the observed candles
  required by that metric; the coverage classification must not manufacture an
  intraperiod path.
- Preserve deterministic ordering and stable JSON field semantics.

## Testing

Implementation follows TDD and covers:

- an internal nominal gap classified as `NO_TRADE_INTERVAL` without blocking feature
  coverage;
- multiple adjacent no-trade intervals grouped deterministically;
- 1h, 4h, and 1d sparse intervals;
- duplicate and off-grid candles remaining blocking;
- insufficient completed generated candles remaining blocking;
- future candle references and malformed timestamps being rejected;
- latest generated-candle selection across a no-trade interval;
- unchanged indicator inputs with no synthetic candle inserted;
- conditional ADD gates accepting sparse-by-contract input when all other gates pass;
- existing unavailable and corrupted-dataset behavior;
- BTC and ETH persisted research artifacts yielding no sequence-continuity block;
- deterministic text and JSON output; and
- import-graph and non-mutation checks proving no runtime integration.

## Verification

After implementation:

1. Run focused coverage and integrated-evaluation tests.
2. Run `npm.cmd run typecheck` and the complete test suite.
3. Run `git diff --check`.
4. Rebuild the conditional ADD report from the immutable BTC and ETH artifacts.
5. Confirm the 24 BTC and 25 ETH intervals remain visible as no-trade evidence while
   no longer invalidating all decision frames.
6. Review candidate results and all remaining evidence gaps without changing strategy
   rules.
7. Confirm operational SQLite files and LIVE process state were not modified.

## Delivery Boundary

This work ends with corrected offline evidence classification and a regenerated
conditional ADD research report. It does not approve a candidate strategy, modify
trading rules, enable orders, or deploy any LIVE behavior. Strategy changes require a
separate design, backtest review, DRY_RUN or shadow validation, and explicit deployment
decision.
