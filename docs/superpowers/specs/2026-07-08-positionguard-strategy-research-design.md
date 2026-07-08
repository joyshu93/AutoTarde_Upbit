# PositionGuard Strategy Research Design

Date: 2026-07-08
Status: proposed research and implementation gate
Scope: AutoTrade_Upbit, Upbit spot only, KRW-BTC and KRW-ETH only

## Purpose

This note records the evidence and implementation direction for improving the PositionGuard strategy logic after the first public-candle backtest diagnostics.

The objective is not to promise profitability. The objective is to convert external research and local backtest evidence into testable, deterministic changes that can reduce avoidable downside while preserving the repository safety contract.

## Product And Safety Boundaries

The strategy remains deterministic and rule-based. It must not use discretionary LLM judgement, news, sentiment, leverage, margin, futures, or multi-exchange inputs.

All proposed work must keep:

- `DRY_RUN` as the default execution mode.
- live order transmission behind the existing explicit mode and live gate.
- Telegram as operator control and inspection only.
- `/preview BTC|ETH` non-mutating.
- `/run BTC|ETH` and scheduler paths behind the same persisted-health, risk, execution, and reconciliation guards.
- public backtests research-only, with no DB writes, Telegram transport, private exchange reads, order lifecycle mutation, or live order transmission.

## External Research Summary

The external research direction supports trend-following and drawdown-defense ideas, but it also warns against overfitting, high turnover, and naive short-horizon trading.

Relevant findings:

- Long-horizon trend-following has unusually broad evidence across asset classes and long histories. Lemperiere, Deremble, Seager, Potters, and Bouchaud report stable trend-following effects across four asset classes and very long time spans, while also noting that shorter trends have weakened more than longer trends. Source: https://arxiv.org/abs/1404.3274
- Crypto-specific trend-following research finds that cryptocurrency markets can be suitable for trend-following, with bear-market diversification characteristics. Source: https://arxiv.org/abs/2009.12155
- A 2026 crypto trend-following framework emphasizes regime-dependent volatility, dynamic trailing stops, risk-adjusted asset selection, transaction-cost modelling, and regime-conditional performance decomposition. The paper uses 6-hour bars and explicitly reports bear, sideways, and bull performance instead of relying only on headline return. Source: https://arxiv.org/abs/2602.11708
- Hourly BTC trading research shows that transaction costs can break naive sign-based strategies and that cost-aware execution filters are central to whether a signal becomes economically useful. Source: https://arxiv.org/abs/2606.00060
- BTC and ETH both exhibit heavy-tailed return behavior; ETH appears to show more pronounced extreme-value frequency in a BTC-modeled comparison. Source: https://arxiv.org/abs/2507.01983
- Tail-risk research distinguishes sudden crash protection from persistent drawdown protection. Trend following tends to lag the first shock but can become defensive during persistent drawdowns, which argues for keeping hard invalidation exits while improving staged drawdown defense. Source: https://arxiv.org/abs/2607.00883

Implication for this project:

The right first improvement is not a broad ML rewrite or aggressive profit-seeking change. It is a conservative, inspectable rule update that reduces exposure faster when the system is already holding a position and the market regime transitions into weak downtrend, breakdown risk, or range deterioration.

## Local Backtest Evidence

After commit `70ec275 Suppress flat PositionGuard exit intents`, the same H1 public-candle backtests were re-run for 2026-01-01 through 2026-07-07 with KRW 1,000,000 initial cash and `--page-limit 35`.

BTC result:

- final equity: KRW 1,007,328.327279
- total return: +0.7328%
- buy-and-hold return: -25.0080%
- strategy vs buy-and-hold: +25.7408 percentage points
- max drawdown: 6.0125%
- skipped orders: 0
- trade diagnostics: 57 sell trades, 43.8596% sell win rate, 1.1170 profit factor
- negative regime contribution: RANGE -12.7745%, WEAK_DOWNTREND -27.5990%, BREAKDOWN_RISK -9.1590%

ETH result:

- final equity: KRW 999,456.658719
- total return: -0.0543%
- buy-and-hold return: -37.6701%
- strategy vs buy-and-hold: +37.6158 percentage points
- max drawdown: 9.2223%
- skipped orders: 0
- trade diagnostics: 49 sell trades, 38.7755% sell win rate, 1.0328 profit factor
- negative regime contribution: RANGE -10.0992%, WEAK_DOWNTREND -37.5998%, BREAKDOWN_RISK -12.2134%

Interpretation:

- The strategy preserved capital far better than buy-and-hold during this sample.
- Absolute return is weak, especially after fees and turnover.
- `NO_POSITION` skip noise has been removed, so the diagnostics are now usable.
- The largest actionable loss area is not fresh entry into weak regimes. The core already blocks constructive entries in `WEAK_DOWNTREND` and `BREAKDOWN_RISK`.
- The more likely issue is holding risk too long after an earlier constructive entry transitions into `RANGE`, `WEAK_DOWNTREND`, or `BREAKDOWN_RISK`.

## Design Recommendation

Implement a staged defensive exposure policy before attempting new entry models.

The first implementation should focus on the existing pure `position-guard-core` decision engine, not on exchange execution, Telegram, scheduler, or live wiring.

### Hypothesis 1: Earlier Weak-Downtrend Reduction

When a position is open and the regime becomes `WEAK_DOWNTREND`, the system should require less additional evidence before a staged `REDUCE`.

Rationale:

- Local BTC and ETH backtests show the largest negative contribution in `WEAK_DOWNTREND`.
- External trend-following research supports drawdown persistence defense.
- Existing core logic already treats `WEAK_DOWNTREND` as independent reduce evidence, but the threshold can still keep losing positions on hold too long when weakness is clear enough to justify risk reduction.

Expected shape:

- Keep immediate `EXIT` for broken invalidation, 1d breakdown, or 4h breakdown plus bearish momentum.
- Add a defensive staged reduction path when `regime === "WEAK_DOWNTREND"` and at least one additional weakening signal exists, such as failed reclaim, bearish momentum expansion, ATR shock, elevated breakdown pressure, or `weakeningStage !== "NONE"`.
- Use a modest reduction fraction first, not a full exit, unless the existing immediate-exit condition already fires.

### Hypothesis 2: Breakdown-Risk Priority Over Holding Comfort

When a position is open and the regime becomes `BREAKDOWN_RISK`, the strategy should prioritize reducing risk unless the structure is still clearly constructive and invalidation remains safe.

Rationale:

- `BREAKDOWN_RISK` is negative in both BTC and ETH backtests.
- Trend following can be late on the first shock, so hard invalidation exits must remain. But persistent breakdown risk should also reduce exposure before the full exit line is crossed.

Expected shape:

- Treat `BREAKDOWN_RISK` with elevated breakdown pressure as stronger independent reduce evidence.
- Do not create new ADD decisions in breakdown-risk context.
- Prefer staged `REDUCE` over `HOLD` when the asset is already held and deterioration is no longer borderline.

### Hypothesis 3: Profit-Protection In Range Deterioration

When a position has unrealized profit and the regime deteriorates into range or soft weakening, the strategy should allow a small protective `REDUCE` earlier.

Rationale:

- Range contribution is negative for both assets.
- Trend-following literature favors letting winners run, but the crypto-specific research emphasizes dynamic trailing stops and regime-conditioned exits.
- This project does not yet maintain a stateful trailing high or ATR stop record, so the first version should use existing analysis fields and `pnlPct` rather than adding new persisted strategy state.

Expected shape:

- Keep the current no-chase and confirmation logic.
- If the position is profitable and weakening has begun, allow a modest reduction to protect open gains.
- Avoid forcing a loss-taking reduce in range unless independent deterioration evidence is present.

## Non-Goals For The First Implementation

Do not implement these in the first change:

- machine-learning model selection
- discretionary LLM trading
- leverage, shorting, futures, options, or derivatives
- news or sentiment inputs
- aggressive parameter optimization on one half-year sample
- stateful trailing stop persistence
- BTC/ETH separate parameter sets
- scheduler or live-gate behavior changes

Those may become later research tracks only after the staged defensive policy is tested.

## Validation Plan

The first implementation is acceptable only if it passes both contract tests and offline research checks.

Required pure tests:

- Immediate invalidation still creates `EXIT` for open positions.
- Flat positions still do not emit `EXIT`.
- Weak-downtrend with an open position and independent deterioration evidence can create `REDUCE`.
- Weak-downtrend without enough evidence remains `HOLD`.
- Range profit-protection can create a modest `REDUCE` only when profit and weakening evidence exist.
- ADD/ENTER logic remains blocked in weak or breakdown contexts.

Required verification:

- `npm.cmd run check`
- `git diff --check`
- BTC and ETH public backtests over 2026-01-01 to 2026-07-07, same settings as the baseline.

Backtest acceptance gates:

- `skipped_orders` remains 0 for BTC and ETH.
- `NO_POSITION` skip reason remains 0.
- max drawdown does not increase for either asset.
- combined negative contribution from `RANGE`, `WEAK_DOWNTREND`, and `BREAKDOWN_RISK` improves for at least one asset and does not materially worsen for the other.
- total return does not deteriorate by more than 0.30 percentage points for either asset.
- turnover increase is reviewed explicitly. A defensive policy that reduces drawdown by tiny amounts while sharply increasing turnover should be rejected.

Robustness gates before live use:

- Re-run at least one additional historical window, such as 2025-H2 or a rolling six-month window, before promoting the logic beyond DRY_RUN.
- Use `/preview BTC|ETH` and DRY_RUN scheduler evidence before any live-scheduler use.
- Keep any live operation behind existing readiness, reconciliation, risk, execution, and operator controls.

## Implementation Sequence

1. Add focused failing tests for the defensive reduce cases.
2. Update only the pure PositionGuard core decision logic.
3. Keep order lifecycle, execution, exchange, reconciliation, Telegram, scheduler, and live configuration untouched.
4. Run the full test suite.
5. Re-run BTC and ETH public backtests for the baseline window.
6. Compare the new report against the baseline recorded in this note.
7. If the change passes, update the root documentation and commit.

## Decision

Proceed with a conservative staged defensive exposure policy as the next implementation plan.

The primary target is reducing avoidable holding losses in `WEAK_DOWNTREND`, `BREAKDOWN_RISK`, and deteriorating profitable range positions. The implementation must remain deterministic, explainable, offline-testable, and compatible with the existing safety boundaries.
