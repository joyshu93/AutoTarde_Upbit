# ADD Loss Attribution And Holdout Hypothesis Design

## Goal

Explain which predeclared, contemporaneous ADD conditions contributed to losses and
identify whether one existing conditional ADD policy is suitable to freeze for a
future independent holdout. This is a read-only research diagnostic. It does not
change PositionGuard rules, thresholds, runtime wiring, scheduler behavior, risk
limits, execution state, or live-order transmission.

## Evidence Boundary

The analysis consumes only evidence already produced by the integrated strategy
evaluation:

- BASELINE executed ADD decision and fill evidence;
- FIFO realization slices attributed to each executed ADD fill;
- confirmed persisted or modeled fee evidence;
- completed-episode links and post-decision excursion evidence;
- BASELINE, NO_ADD, and the three existing conditional ADD replay results; and
- existing full-path and W1/W2/W3 candidate gate results.

No Upbit API, Telegram transport, reconciliation, scheduler tick, strategy run,
order mutation, migration, or writable database access is permitted. The operational
SQLite database remains `readOnly: true`. Future candles, future marks, interpolated
OHLC, missing fees treated as zero, and account-wide PnL inferred from selected
strategy fills are prohibited.

## Attribution Units

An executed ADD fill is the contribution unit. Its FIFO realization slices may be
partially realized, fully realized, or still open. The report must not call an ADD
fill a completed trade and must not mix its contribution outcome with flat-to-flat
position-episode win rate.

Each ADD contribution retains:

- asset, market, decision time, fill ID, and linked episode ID;
- contemporaneous regime, ATR-shock flag, weakening stage, and trend-alignment score;
- deterministic ADD ordinal within the linked episode, ordered by exact decision
  epoch and then stable fill ID;
- entry notional, realized quantity, remaining quantity, gross realized contribution,
  allocated entry and exit fees, and net realized contribution;
- post-decision MAE/MFE state and exact evidence provenance; and
- explicit completeness for lifecycle, fee, and excursion evidence.

Missing evidence remains `UNKNOWN` or `NOT_APPLICABLE`. A partially realized ADD may
contribute known realized slices, but its remaining inventory must remain visible and
must not be included in completed contribution averages as if it were closed.

## Cohort Dimensions

The pure diagnostic builds only predeclared, inspectable cohorts. It does not search
arbitrary combinations or tune thresholds:

- asset and market;
- regime;
- ATR shock (`true` or `false`);
- weakening stage;
- exact integer trend-alignment score; and
- ADD ordinal within the position episode.

For every dimension value, and for each existing policy's exact suppressed set, the
report provides:

- executed ADD count;
- fully realized, partially realized, and unrealized counts;
- known gross and net contribution counts;
- positive, negative, and breakeven realized contribution counts;
- gross realized contribution, confirmed fee impact, and net realized contribution;
- mean known gross and net contribution per executed ADD;
- realized and remaining quantity;
- known MAE/MFE count and descriptive mean/min/max values; and
- exact contributing decision, fill, episode, and excursion evidence IDs.

The positive/negative counts describe ADD-fill FIFO contribution signs, not trade
wins or position-episode wins. Aggregate values must expose their denominator and
completeness state.

## Existing Policy Mapping

Only the existing frozen candidates may become holdout hypotheses:

- `ADD_RISK_CLEAR` suppresses ADD when ATR shock is present or weakening stage is not
  `NONE`.
- `ADD_HIGH_ALIGNMENT` applies `ADD_RISK_CLEAR` and also suppresses trend-alignment
  scores below 4.
- `ADD_CORE_TREND` applies `ADD_HIGH_ALIGNMENT` and also suppresses regimes other than
  `BULL_TREND` and `PULLBACK_IN_UPTREND`.

The diagnostic must use the strategy module's existing policy evaluation evidence or
an exhaustive shared mapping. It must not copy predicates into a second divergent
implementation.

## Cross-Asset Holdout Classification

The cross-asset result for each existing candidate is one of:

- `READY_FOR_FUTURE_HOLDOUT`
- `CONFLICTING`
- `INSUFFICIENT`
- `NOT_APPLICABLE`

Classification precedence is deterministic:

1. `NOT_APPLICABLE` when either asset lacks the required candidate, BASELINE, or
   NO_ADD scenario.
2. `INSUFFICIENT` when either asset lacks complete cadence, lifecycle, fee, or
   finite comparison evidence, or has no known realized contribution in the
   candidate's suppressed ADD set.
3. `CONFLICTING` when required evidence exists but BTC and ETH do not both satisfy
   every frozen performance and drawdown gate, or when the candidate-suppressed ADD
   contribution is not negative for both assets.
4. `READY_FOR_FUTURE_HOLDOUT` only when both assets satisfy every frozen full-path,
   window-return, drawdown, cost, and coverage gate, the candidate-suppressed ADD set
   has negative known net contribution in both assets, and the only unmet existing
   eligibility gate is the frozen 30 full-path / 10 per-window episode-support gate.

This classification never changes the existing candidate status. In particular,
`READY_FOR_FUTURE_HOLDOUT` does not turn `INSUFFICIENT` into
`ELIGIBLE_FOR_FURTHER_RESEARCH`, lower a threshold, authorize DRY_RUN or LIVE changes,
or make a causal claim. It only freezes an existing hypothesis and its evidence IDs
for evaluation on data collected after the frozen W1/W2/W3 windows.

## Architecture

### Pure loss-attribution module

Create `src/modules/performance/performance-add-loss-attribution.ts`. It validates
and aggregates existing ADD diagnostics without database, runtime, exchange, or
strategy side effects. It returns immutable, finite, stable-order JSON-compatible
results.

### Integrated research report

Extend `report:strategy-evaluation` with an optional
`addLossAttribution` section whenever the required ADD diagnostics and conditional
candidate matrix are present. Legacy output remains unchanged when those inputs are
absent. Text output shows bounded highest-loss cohorts and exact warnings; JSON keeps
the full cohort and evidence manifests.

### Provenance

The section records dataset hashes, operational database path as report provenance,
selected account/mode/origin filters, cost-cell IDs, frozen validation-window IDs,
candidate policy IDs, and source evidence IDs. It uses persisted provenance rather
than wall-clock execution time for reproducible ordering and conclusions.

## Error And Data-Quality Rules

- Require explicit-timezone ISO-8601 timestamps and compare exact epochs.
- Reject duplicate ADD fill IDs, contradictory market or episode links, invalid
  ordinal relationships, non-finite numbers, negative quantities, and negative fees.
- Reject a known net contribution when required fee components are unknown.
- Keep absent excursion evidence separate from zero excursion.
- Preserve deterministic tie-breaking by exact epoch and stable fill ID.
- Do not rank a cohort with zero known net-contribution observations.
- Do not silently omit damaged selected evidence.
- Do not let corruption outside the selected evidence block unrelated cohorts when
  the existing reader contract already excludes it safely.

## Text And JSON Output

The text report includes:

- BTC and ETH ADD contribution totals;
- the three largest known loss cohorts per asset, with dimension, denominator, net
  contribution, fee impact, and evidence completeness;
- each existing candidate's suppressed-set contribution summary;
- cross-asset holdout classification and exact reasons; and
- an explicit statement that the result is selected-flow attribution and not account
  return, causal proof, or deployment approval.

JSON retains all cohorts, exact metric states, thresholds, candidate gate references,
and evidence IDs. No technical raw value is hidden or replaced by a friendly summary.

## Testing

Implementation follows strict TDD and covers:

- one positive and one negative fully realized ADD;
- partial realization and remaining inventory;
- missing fee and missing excursion evidence;
- regime, ATR shock, weakening stage, alignment score, and ADD ordinal cohorts;
- same-timestamp stable fill-ID ordering;
- mixed timezone epoch ordering;
- BTC/ETH separation;
- exact existing policy suppressed-set mapping;
- every holdout classification and precedence rule;
- support-only insufficiency becoming `READY_FOR_FUTURE_HOLDOUT` without changing
  the original candidate status;
- performance, drawdown, coverage, fee, and cross-asset conflicts;
- non-finite, negative, duplicate, and contradictory evidence rejection;
- stable text and JSON output;
- legacy integrated-report compatibility; and
- import-graph checks proving no runtime or execution wiring.

## Delivery Boundary

The deliverable is a read-only diagnostic and a frozen future-holdout hypothesis
classification. No strategy rule is modified. A later holdout evaluation must use
new, separately identified data without rewriting W1/W2/W3 or the current report.
Any eventual strategy change requires a separate design, backtest review, DRY_RUN or
shadow validation, and explicit deployment approval.

## Deferred Follow-up Research

The broader loss-cause research prompt supplied on 2026-08-14 is intentionally
deferred until this diagnostic is complete and verified. That later phase owns the
frozen `BASELINE`, `NO_ADD`, `HTF_TREND_GATE`, `STRICT_PULLBACK`,
`EARLY_THESIS_FAILURE`, `ADD_LIMITED`, `COOLDOWN_CONTROL`, and
`COMBINED_CONSERVATIVE` scenarios, including three fixed validation windows and
base/stress cost comparisons.

Those scenarios are not part of this delivery and must not be partially introduced
here. The current work may produce a frozen future-holdout hypothesis for one of the
three existing conditional ADD candidates, but it must not alter strategy rules,
invent thresholds, select a broad scenario, or start that deferred experiment. The
deferred phase remains subject to the same read-only operational boundary and
requires a separate design and implementation plan after this feature is complete.
