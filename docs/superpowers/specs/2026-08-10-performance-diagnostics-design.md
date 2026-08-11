# Performance Diagnostics Design

## Goal

Extend the read-only performance report into an auditable live-strategy diagnostic tool without changing strategy, execution, reconciliation, Telegram, scheduler, or LIVE state.

## Truth And Scope

- Inputs are persisted fills, parent orders, linked strategy decisions, the explicit opening-position snapshot, and persisted position snapshots used only as historical mark observations.
- Selection remains explicit: `exchange_account_id`, `execution_mode`, `origin`, and optional `[from,to)`.
- Results describe the selected order stream and its observed opening inventory. They are not account return and do not attribute deposits, withdrawals, other origins, or external trades to the strategy.
- The reader opens the existing SQLite file with `readOnly: true`; no migration, exchange call, runtime wiring, or mutation path is imported.

## Analysis Units

### FIFO realization slice

One slice records a quantity consumed from one FIFO lot by one sell fill. It preserves opening-versus-selected source, entry and exit fill/order/decision evidence, gross PnL before fees, allocated buy and sell fees, net PnL, and holding time. Opening-inventory slices never become selected-strategy episodes.

### Position episode

A selected-strategy episode starts when selected-stream inventory changes from zero to positive and completes only when it returns to zero. Multiple entry/add fills and partial reduce/exit fills remain one episode. Open episodes are reported but excluded from completed-episode win rate, averages, payoff ratio, profit factor, and holding-duration summaries.

The default win rate uses completed position episodes. FIFO-slice outcome statistics are reported separately and labelled as slice statistics.

## Metrics

Per market and combined selected stream:

- completed/open episode counts and episode WIN/LOSS/BREAKEVEN counts
- completed-episode win rate, average win, average loss, average net PnL, payoff ratio, and profit factor
- FIFO realization-slice WIN/LOSS/BREAKEVEN counts and win rate
- gross realized PnL before fees, realized fee impact, and net realized PnL after fees
- turnover and confirmed paid fees
- maximum consecutive completed-episode wins and losses
- average, minimum, and maximum completed-episode holding duration
- best and worst completed episode
- cumulative selected-stream realized PnL observations at sell-fill instants
- maximum selected-stream realized drawdown in KRW
- snapshot-mark selected-stream attributed PnL observations and observed maximum drawdown when marks and costs are complete
- contribution grouped separately by entry action (`ENTER`, `ADD`, unknown) and exit action (`REDUCE`, `EXIT`, unknown)

Maximum realized drawdown is based on sell-fill observations of cumulative selected-stream net realized PnL. It excludes unrealized movement, opening inventory, cash flows, and account-wide equity. Snapshot drawdown is an irregularly observed selected-stream attributed PnL drawdown; no interpolation is performed and the sample count plus maximum observation gap are reported.

No percentage account return, strategy MDD percentage, or buy-and-hold benchmark is claimed because the local evidence does not provide a complete cash-flow ledger, a continuous equity curve, or an explicit BTC/ETH benchmark allocation.

## Completeness And Unknowns

Metrics use explicit `KNOWN`, `UNKNOWN`, or `NOT_APPLICABLE` states where a scalar can be unavailable.

- Missing selected buy or allocated sell fee makes the affected slice and episode net PnL unknown. Any aggregate that requires every selected net outcome, including net win rate, averages, payoff ratio, profit factor, net cumulative curve, and net drawdown, becomes unknown.
- Gross-before-fee metrics remain available when prices, quantities, and FIFO relations are valid.
- Missing opening cost affects opening-inventory attribution only.
- Unmatched sells make subsequent selected-stream attribution for that market unknown.
- Missing marks affect snapshot-valued metrics only.
- Profit factor is not applicable when gross loss is zero; payoff ratio is not applicable when no known winning or losing episode exists.
- Breakeven classification uses an explicit KRW tolerance included in report policy provenance.
- Opposite-side fills for the same market at the same parsed instant are rejected as an ambiguous economic sequence. Stable IDs only break ties between fills of the same side.
- All analysis timestamps require an explicit timezone and accept zero through nine fractional-second digits. Ordering and `[from,to)` boundaries use exact epoch nanoseconds so persisted microsecond timestamps are not silently truncated by the runtime clock representation.
- Existing quantity tolerance is applied consistently to lot exhaustion and episode completion.

## Persisted Evidence

The reader enriches normalized fills with order ID, strategy-decision ID, and linked decision action. A missing linked decision remains explicit `unknown` metadata rather than being inferred. Order/fill market and side consistency remains mandatory. Selected decision/order lifecycle relationships that contradict each other are rejected.

Position snapshots inside the report boundary become mark observations using only their own persisted `captured_at` and `markPrice`. A diagnostic observation replays only fills at or before that instant; future fills and snapshots are never used. Snapshot prices are never interpolated.

## Output

The existing `report:performance` command retains its required arguments and adds a stable `diagnostics` section to text and JSON output. It includes summary, BTC/ETH metrics, recent completed episodes, best/worst episodes, curves, completeness, warnings, filters, fill range, and snapshot provenance.

## Testing

Implementation is test-driven. Pure tests cover profitable, losing, breakeven, partial-exit, multi-entry FIFO, opening-inventory, open episode, missing fee, fee-flipped outcome, streak, holding duration, mixed timezone, timestamp tie, decimal residue, realized drawdown, snapshot drawdown, and strategy-action contribution cases. SQLite/CLI tests cover `[from,to)`, linked evidence, corruption, full migrations, stable output, and read-only operation.
