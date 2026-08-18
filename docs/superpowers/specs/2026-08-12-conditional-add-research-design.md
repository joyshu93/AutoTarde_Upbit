# Conditional ADD Research Design

## Goal

Evaluate whether deterministic, inspectable ADD eligibility rules improve the
PositionGuard strategy after fees and slippage without changing the LIVE strategy or
execution graph.

This is an offline research feature. It must not call Upbit, open the operational
SQLite database for writing, run Telegram polling, invoke reconciliation, install
scheduler timers, or submit, cancel, or query orders.

## Evidence Boundary

Each candidate policy is evaluated by replaying the complete strategy path from the
same immutable candle dataset and initial state. Suppressing an ADD changes cash,
position quantity, average entry price, and later decisions, so results must not be
constructed by filtering BASELINE trades after the replay.

Policy decisions may use only fields present at the decision timestamp. Future fills,
episode closes, later regimes, MAE/MFE, and the outcome of another scenario are not
policy inputs. MAE/MFE is diagnostic evidence after a policy has been frozen; it is
not a rule-selection input.

Results remain descriptive counterfactual evidence. They do not establish that ADD
caused a historical outcome or predict future returns.

## Scenarios

The experiment compares five independently replayed paths:

- `BASELINE`: execute every eligible strategy action under the existing replay model.
- `NO_ADD`: suppress every ADD while preserving the original ADD decision evidence.
- `ADD_RISK_CLEAR`: allow ADD only when `atrShock=false` and
  `weakeningStage=NONE`.
- `ADD_HIGH_ALIGNMENT`: apply `ADD_RISK_CLEAR` and additionally require
  `trendAlignmentScore >= 4`.
- `ADD_CORE_TREND`: apply `ADD_HIGH_ALIGNMENT` and additionally require regime
  `BULL_TREND` or `PULLBACK_IN_UPTREND`.

The candidate hierarchy is intentional. Each stricter policy is a deterministic
subset of the preceding policy, which keeps interpretation inspectable and limits
the first experiment matrix to three hypotheses.

## Architecture

### Research policy contract

The backtest accepts a research-only ADD eligibility policy with a stable ID and a
pure predicate over the current frame analysis and current ADD decision. The policy
returns either `ALLOW` or `SUPPRESS` with an explicit reason code.

The existing `NO_ADD` behavior is represented through the same contract. BASELINE
continues to use no research policy, preserving the legacy golden path.

### Replay evidence

When a policy suppresses an ADD, the replay stores:

- policy ID;
- original action `ADD`;
- reason code;
- decision timestamp; and
- contemporaneous fields needed to explain the policy result.

The original strategy decision remains unchanged. Only simulated execution is
suppressed. Subsequent frames use the resulting counterfactual state.

### Evaluation integration

The integrated strategy evaluator accepts the five named scenarios and reports each
asset independently. Existing BASELINE/NO_ADD ADD diagnostics remain available and
must not silently reinterpret conditional-policy evidence as NO_ADD evidence.

Stability validation compares every candidate against both BASELINE and NO_ADD over
the same caller-supplied, non-overlapping `[from,to)` windows. All windows slice one
continuous replay path; capital and position state are never reset at a boundary.

## Cost Matrix

The first experiment uses two explicit cells:

- base: 5 bp fee and the configured base slippage assumption;
- stress: 10 bp fee plus 20 bp slippage.

BTC and ETH are evaluated separately. Cost cells and assets are not treated as
independent statistical samples.

## Acceptance Gates

A candidate is not eligible for later strategy-design consideration unless all of
the following hold for an asset:

1. Full-path net return exceeds both BASELINE and NO_ADD in both cost cells.
2. Base-cost return delta versus BASELINE is positive in every complete validation
   window.
3. Stress-cost return delta versus BASELINE is positive in at least two of three
   complete validation windows, and no window is below `-0.5` percentage points.
4. Full-path maximum drawdown does not exceed BASELINE.
5. No stress window exceeds BASELINE drawdown by more than `1.0` percentage point.
6. At least 30 completed policy-exposed episodes exist across the evaluation period
   and at least 10 exist in each evaluable window.
7. Full-path cadence, each window cadence, each window's upstream replay-state
   continuity, and the exact multi-timeframe feature-input continuity are complete,
   and all required cost metrics are finite.

Multiple ADD decisions in one completed position episode count as one episode outcome
for the sample gate. A policy with insufficient support remains `INSUFFICIENT` even
when its observed return is favorable.

## Data Quality and Leakage Controls

- Require strict explicit-timezone ISO-8601 timestamps and epoch ordering.
- Preserve half-open `[from,to)` boundaries.
- Reject duplicate scenario IDs, invalid policy fields, non-finite values, and
  contradictory lifecycle relationships.
- Do not interpolate missing candles.
- Report exact missing ranges, duplicate frames, and off-grid frames. A validation
  window with complete local cadence is still insufficient when a prior gap makes
  its continuous replay start state uncertain.
- Require continuous `1h`, `4h`, and `1d` feature inputs. Although 200 completed
  candles is the minimum eligibility threshold, the current EMA, ATR, RSI, and MACD
  implementations consume the full completed prefix from the first dataset candle;
  therefore a gap remains feature-affecting for later frames rather than being
  treated as outside a rolling 200-candle window.
- Keep incomplete excursion evidence `UNKNOWN`.
- Do not tune validation windows after inspecting candidate results.
- Do not exclude open episodes merely because they are unfavorable.
- Do not use full-sample PnL, future episode closure, or future regime information to
  construct a candidate rule.
- Keep opening inventory and selected strategy flow attribution separate.

## Testing

Implementation follows TDD and includes:

- legacy BASELINE and NO_ADD golden compatibility;
- each policy boundary immediately below and at its threshold;
- policy hierarchy and explicit suppression reasons;
- stateful replay divergence after a suppressed ADD;
- deterministic repeated execution and immutable source frames;
- BTC/ETH and base/stress matrix output;
- continuous walk-forward windows without capital reset;
- candidate-versus-BASELINE and candidate-versus-NO_ADD comparisons;
- policy-exposed episode support gates;
- mixed timezone, `[from,to)` boundaries, missing coverage, non-finite data, and
  malformed policy input;
- import-graph checks proving the feature remains outside runtime and execution
  wiring.

## Delivery Boundary

This work ends with an offline report and an evidence-based recommendation. It does
not alter PositionGuard LIVE rules, scheduler behavior, risk limits, local secret
files, execution state, or order transmission. A later strategy change requires a
separate design, review, DRY_RUN/shadow validation, and explicit deployment decision.
