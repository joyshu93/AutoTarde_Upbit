# Broad Loss-Cause Strategy Research Design

## Goal

Evaluate six frozen, read-only strategy hypotheses against `BASELINE` and `NO_ADD`
without changing the live PositionGuard rules, runtime wiring, operational database,
or order path. The output identifies hypotheses that are rejected, unsupported, or
eligible only for a later shadow test.

## Safety And Evidence Boundary

- The operational SQLite database is opened only with `readOnly: true` by the existing
  performance reader.
- The research command must not call Upbit or Telegram, run sync, tick a scheduler,
  create or cancel an order, apply migrations, or import the application runtime graph.
- Candle artifacts are immutable caller-supplied evidence. Missing Upbit intervals are
  explicit verified no-trade intervals; no synthetic candles or interpolation are allowed.
- Every scenario replays the same continuous frame path, initial state, and cost cell.
  Validation windows slice observations from that path and never reset portfolio state.
- A frame may use only evidence available at or before its exact timestamp.
- BTC and ETH remain independent capital paths. Their results are compared but never
  pooled into a synthetic portfolio.
- The development manifest is frozen to dataset range
  `[2025-01-01T00:00:00Z, 2026-04-12T19:00:00Z)`. Candles after that cutoff are
  excluded from development and reserved for a separately authorized future holdout.
- The fixed validation windows are exactly:
  `W1=[2025-07-20T00:00:00Z,2025-10-25T19:00:00Z)`,
  `W2=[2025-10-26T00:00:00Z,2025-12-31T19:00:00Z)`, and
  `W3=[2026-01-01T00:00:00Z,2026-04-12T19:00:00Z)`.
- The fixed cost cells are exactly `BASE(feeRate=0.0005, slippageRate=0.0003)` and
  `STRESS(feeRate=0.001, slippageRate=0.002)`. Roles are explicit and are not inferred
  from array order.
- The same-close fill model is labeled `SAME_CLOSE_MODELED`, not observed execution.
  Shadow eligibility additionally requires the same directional gates under a
  one-completed-frame delayed `NEXT_FRAME_MODELED` fill sensitivity.

## Frozen Scenarios

`BASELINE` and `NO_ADD` retain their existing behavior. The six new IDs are research
execution overlays. They preserve the original PositionGuard decision and attach an
explicit intervention record when simulated execution is changed.

### `HTF_TREND_GATE`

Suppress an original `ENTER` unless all of the following contemporaneous conditions hold:

- `breakdown1d === false` and `breakdown4h === false`;
- `trendAlignmentScore >= 3`;
- `weakeningStage === "NONE"`; and
- regime is `BULL_TREND`, `PULLBACK_IN_UPTREND`, or `EARLY_RECOVERY`.

This is a direction gate, not a parameter search. Score 3 is the existing core's
inspectable aligned-entry threshold.

### `STRICT_PULLBACK`

Suppress an original `ENTER` unless all of the following hold:

- `entryPath === "PULLBACK"` and `pullbackZone === true`;
- regime is `PULLBACK_IN_UPTREND`;
- both higher-timeframe breakdown flags are false;
- `trendAlignmentScore >= 4` and `recoveryQualityScore >= 3`;
- one-hour location is `LOWER` or `MIDDLE`; and
- `volumeRecovery === true` plus at least one of `macdImproving` or `rsiRecovery`.

The thresholds reuse existing PositionGuard quality bands. This candidate deliberately
tests a narrower pullback thesis and does not reinterpret reclaim or breakout entries.

### `EARLY_THESIS_FAILURE`

When a simulated position is open, replace an original `HOLD` or `ADD` with a full
simulated `EXIT` if either frozen invalidation precursor is present:

- `failedReclaim === true`, `weakeningStage` is `CLEAR` or `FAILURE`, and
  `recoveryQualityScore <= 1`; or
- `breakdownPressureScore >= 2`, `bearishMomentumExpansion === true`, and
  `pnlPct < 0`.

An original `REDUCE` or `EXIT` is never weakened or delayed. No future MAE, MFE, candle,
or episode outcome participates in the decision.

### `ADD_LIMITED`

Suppress an original `ADD` when any of these conditions hold:

- the simulated position is at a loss (`currentPrice < averageEntryPrice`);
- one ADD has already executed in the current flat-to-flat episode;
- `atrShock === true` or `weakeningStage !== "NONE"`;
- `trendAlignmentScore < 4` or `recoveryQualityScore < 3`; or
- regime is neither `BULL_TREND` nor `PULLBACK_IN_UPTREND`.

The ADD count resets only after the simulated quantity reaches the explicit quantity
tolerance for flatness.

### `COOLDOWN_CONTROL`

After a simulated full exit with non-positive realized PnL, suppress original `ENTER`
for 12 elapsed hours. After any full exit, suppress a repeated entry with the same
`entryPath` for 24 elapsed hours. These durations match the existing PositionGuard
re-entry penalty constants and are elapsed-time rules, not frame-count assumptions.

### `COMBINED_CONSERVATIVE`

Apply `HTF_TREND_GATE`, `EARLY_THESIS_FAILURE`, `ADD_LIMITED`, and
`COOLDOWN_CONTROL` together. `STRICT_PULLBACK` remains an independent restrictive
hypothesis and is not included. If several interventions match one frame, precedence is:

1. preserve an original `EXIT` or `REDUCE`;
2. early-thesis full exit;
3. cooldown entry suppression;
4. higher-timeframe entry suppression; and
5. ADD suppression.

## Replay Contract

The backtest exposes a general research intervention record with scenario, original
action, effective action, outcome (`ALLOW`, `SUPPRESS`, or `OVERRIDE_EXIT`), reason,
timestamp, and contemporaneous evidence snapshot. `decision` always remains the
unmodified core decision. Trade records reflect only the effective simulated action.

Research state is local to one replay path and contains only current episode ADD count,
last full-exit timestamp, last full-exit realized PnL, and last entry path. It is
initialized from explicit input state and cannot read runtime or persisted state.
If initial quantity is non-zero, every stateful scenario requires an explicit carry-in
research state. Missing carry-in state makes that scenario `INSUFFICIENT`; it must not
silently assume zero prior ADDs or no recent exit.

## Evaluation And Classification

Each candidate is compared with both anchors for BTC and ETH under the explicit
`BASE` and `STRESS` cells. The report retains full-path metrics
and exactly three caller-supplied, non-overlapping `[from,to)` windows sliced from the
continuous replay.

Required metrics include net return, realized PnL, completed-episode and FIFO-lot win
rates kept separate, payoff ratio, profit factor, average win/loss, drawdown, loss
streak, holding time, turnover, fees, time in market, action contribution, regime,
MAE/MFE, intervention counts, and return deltas in percentage points and KRW.

Each `asset × candidate` result exposes two independent fields:

- `dataSufficiency`: `COMPLETE | INSUFFICIENT` with exact missing evidence; and
- `directionalGateOutcome`: `PASS | FAIL | UNKNOWN` with every observable gate.

Candidate status is derived without hiding known failure:

- `REJECTED`: any observable directional gate is `FAIL`, even when other evidence is
  insufficient. Missing evidence remains visible in `dataSufficiency`.
- `INSUFFICIENT`: no directional failure is observed but cadence, verified-no-trade,
  lifecycle, fee, finite metric, fixed-window, delayed-execution sensitivity, carry-in,
  or completed-episode support is incomplete. The minimum support is 30 completed
  episodes on the full path and 10 policy-exposed completed episodes per window.
- `ELIGIBLE_FOR_SHADOW_TEST`: that asset has complete evidence, every base/stress and
  same-close/next-frame gate passes, base net return improves over `BASELINE`, full-path
  drawdown does not worsen, and at least two of three windows improve.

Cross-asset output is a non-authoritative comparison summary. It must not replace or
weaken the independent BTC and ETH statuses.

`ELIGIBLE_FOR_SHADOW_TEST` is not deployment approval and must not modify LIVE or
DRY_RUN behavior.

## Output And Provenance

Stable JSON and human-readable text include frozen rule definitions, thresholds,
dataset hashes, DB/filter provenance, initial states, cost cells, validation windows,
development cutoff, execution-timing model, per-asset and per-window metrics, exact
intervention counts/reasons, data-quality
warnings, candidate status/reasons, and explicit selected-flow/non-causal boundaries.
No value is rounded in JSON; text may format values while retaining technical detail.

## Testing

TDD covers every allow/suppress/override rule, precedence, episode reset, elapsed-time
cooldown, continuous-window slicing, base/stress comparisons, BTC/ETH isolation,
look-ahead rejection, sparse cadence, same-timestamp ordering, finite validation,
classification precedence, stable text/JSON, import boundaries, full migrations, and
read-only operational DB verification. Missing intervals are `UNEXPLAINED_MISSING`
unless an independent lower-timeframe provenance artifact verifies no trades; a gap
derived only from the same hourly artifact is not verified-no-trade evidence.
