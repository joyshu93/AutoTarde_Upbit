# Holdout Episode Component Ablation Design

## Purpose

Explain the rejected ETH `COMBINED_CONSERVATIVE` retrospective holdout result without changing the LIVE strategy. The analysis connects comparable completed position episodes and replays four fixed leave-one-component-out variants to identify descriptive component associations.

## Safety Boundary

- Read-only research only. No Upbit or Telegram API calls.
- Do not start or resume LIVE, invoke strategy runs, sync, scheduler ticks, orders, cancellations, migrations, or runtime wiring.
- Do not open the operational SQLite database except through an explicitly read-only adapter; this feature does not require SQLite access.
- Do not modify execution graph behavior, strategy defaults, secrets, or LIVE configuration.
- Preserve the existing frozen `BROAD_LOSS_CAUSE_V1` authority and the existing `COMBINED_CONSERVATIVE` result exactly.
- Results set `readOnly: true`, `causalClaim: false`, `deploymentApproval: false`, and `prospectiveApproval: false`.

## Alternatives Considered

### Aggregate-only diagnostics

This is small but cannot explain which loss episodes disappear, remain, or change. The existing aggregate failure diagnostics already cover this level.

### Overlapping-interval episode matching

This increases match count but can pair unrelated entries after path divergence. It is rejected because it overstates comparability.

### Exact decision-entry matching plus leave-one-component-out replay

This is selected. Episodes are directly compared only when their first executed `ENTER` decisions have the same epoch instant within the same asset, timing model, and cost cell. Unmatched paths remain explicit.

## Frozen Ablation Matrix

`COMBINED_CONSERVATIVE` contains exactly:

1. `HTF_TREND_GATE`
2. `EARLY_THESIS_FAILURE`
3. `ADD_LIMITED`
4. `COOLDOWN_CONTROL`

`STRICT_PULLBACK` is not a combined component and is not an ablation target.

The analysis adds exactly four retrospective variants:

- `COMBINED_MINUS_HTF_TREND_GATE`
- `COMBINED_MINUS_EARLY_THESIS_FAILURE`
- `COMBINED_MINUS_ADD_LIMITED`
- `COMBINED_MINUS_COOLDOWN_CONTROL`

Each variant uses the existing component thresholds and precedence with one component disabled. No threshold search or additional combination is permitted. BTC and ETH are both replayed across `SAME_CLOSE_MODELED` and `NEXT_FRAME_MODELED`, and across `BASE` and `STRESS`, from the frozen development start through the holdout end. Only `[holdoutFrom,holdoutTo)` evidence is reported.

## Policy Composition

The combined research intervention evaluator is factored into a pure active-component evaluator. Existing `COMBINED_CONSERVATIVE` calls it with all four components. Ablation variants call it with one component omitted. A regression test requires the original combined path to remain byte-for-byte equivalent for representative inputs and replay outputs.

The precedence remains:

1. preserve core `EXIT` and `REDUCE`
2. `EARLY_THESIS_FAILURE`
3. `COOLDOWN_CONTROL`
4. `HTF_TREND_GATE`
5. `ADD_LIMITED`

## Episode Evidence

Each replay episode is normalized into an envelope containing:

- scenario, asset, market, timing model, and cost cell
- persisted dataset and replay provenance
- first executed `ENTER` decision epoch and execution epoch
- episode ID, fill IDs, open and close instants
- gross and net realized PnL, fees, quantity, and holding duration
- carry-in and open-at-holdout-end state
- intervention and modeled fill attribution evidence IDs

Fill IDs and episode IDs are scenario-specific and are never used as cross-scenario keys. Timestamp comparison uses epoch nanoseconds from explicit-timezone ISO-8601 values.

## Matching Contract

Matching occurs only inside one `asset x timing x cost` cell.

- `EXACT_ENTRY_MATCH`: unique first executed `ENTER` decision epoch exists on both paths.
- `EXIT_TIMING_CHANGED`: an exact entry match exists but close instant or exit structure differs.
- `REFERENCE_ONLY_LOSS`: a known-loss episode exists only on the full combined path.
- `REFERENCE_ONLY_GAIN`: a known-gain episode exists only on the full combined path.
- `ABLATION_ONLY`: an episode exists only on the ablation path.
- `PATH_DIVERGED`: no unique exact entry relationship can be established.
- `CARRY_IN`: the episode started before `holdoutFrom`.
- `OPEN_AT_TO`: the episode is not completely closed before `holdoutTo`.
- `NET_OUTCOME_UNKNOWN`: fee or lifecycle evidence is incomplete.

Reference-only classifications are observations, not claims that a component suppressed or caused the outcome. Partial exits remain part of one position episode. Open and carry-in episodes are reported separately and excluded from closed-episode win/loss comparisons.

## Component Classification

Each ablation is compared with full `COMBINED_CONSERVATIVE` across the four timing/cost cells for each asset. Metrics are net return, maximum drawdown, turnover, modeled fees, and completed episode count.

- `PROTECTIVE_ASSOCIATION`: removal consistently worsens net return and does not produce a contradictory risk/cost improvement large enough to make direction ambiguous.
- `HARM_ASSOCIATION`: removal consistently improves net return and does not worsen maximum drawdown, turnover, or modeled fees.
- `MIXED_ASSOCIATION`: direction differs across timing/cost cells or return and risk/cost evidence conflict.
- `NO_MEASURABLE_DIFFERENCE`: all metric deltas are within the frozen tolerances.
- `INSUFFICIENT_EVIDENCE`: coverage, lifecycle, fees, finite metrics, carry-in provenance, or episode support is incomplete.

Because this analysis was designed after observing the ETH failure, no classification authorizes shadow or LIVE use. At most it may nominate a component for a fresh future prospective test.

## Output

The integrated JSON report adds an optional section with stable ordering:

- authority and interpretation boundary
- BTC and ETH asset results
- timing/cost cell metrics
- episode relationships and unmatched counts
- four component classifications
- data-quality warnings and provenance

Text output summarizes ETH first because it motivated the diagnosis, then reports BTC as the required anti-selection-bias control. Technical values and evidence IDs remain available.

## Test Strategy

TDD covers exact entry matching, timezone-equivalent instants, `[from,to)` boundaries, partial exits, carry-in, open episodes, unknown fees, path divergence, deterministic ordering, opposite-side ambiguity rejection, provenance isolation, the exact four ablations, combined-path regression equivalence, all timing/cost cells, no future evidence, and non-approval flags.
