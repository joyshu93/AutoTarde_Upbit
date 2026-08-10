# Performance Report Design

## Goal

Provide a deterministic, read-only performance calculation that can be reused by live-trading inspection and later backtests without adding a Telegram command.

## Boundaries

- Read only the local SQLite database; never call Upbit, Telegram, reconciliation, strategy, scheduler, or execution paths.
- Require the database path, exchange account, execution mode, and order origin explicitly at the CLI boundary.
- Calculate from persisted fills and an explicitly reported opening-position snapshot.
- Separate PnL attributed to opening inventory from PnL attributed to lots bought by the selected order stream.
- Never infer missing fees or silently price unmatched sells.
- Report warnings for missing fees, missing opening cost, unmatched sell quantity, and unavailable marks.

## Components

### Pure calculator

`src/modules/performance/performance-calculator.ts` accepts normalized fills, optional opening positions, and optional marks. It uses FIFO lots per market. Buy fees become lot cost; sell fees reduce proceeds and are allocated proportionally when one sell consumes multiple lot sources.

The result exposes per-market and total realized PnL, opening-inventory realized PnL, selected-stream realized PnL, paid fees, turnover, remaining quantity and cost, market value, gross unrealized PnL, and explicit warnings. Hypothetical future exit fees are not estimated.

### SQLite reader

`src/modules/performance/sqlite-performance-reader.ts` opens SQLite with `readOnly: true` and loads only matching persisted orders and fills. Report periods use `[from, to)` semantics. Period inputs must be ISO-8601 timestamps with explicit timezone offsets and are normalized to canonical UTC ISO before comparison or provenance output. Matching-stream fill timestamps and selected-account snapshot timestamps are validated before period filtering so malformed persisted rows cannot disappear silently. Fill market and side must match their parent order. When `from` is present, opening inventory comes from the latest position snapshot at or before `from`; otherwise it comes from the latest snapshot before the first included fill. Marks come from the latest snapshot at or before `to`, or the latest snapshot when `to` is absent. Every selected filter and snapshot timestamp is returned as provenance.

### CLI report

`src/research/performance-report.ts` requires:

```text
--database <path> --exchange-account <id> --mode LIVE|DRY_RUN --origin STRATEGY|OPERATOR|RECOVERY
```

Optional `--from`, `--to`, and valueless `--json` arguments bound the period and output. Unknown or duplicate arguments, invalid timestamps, and `from >= to` are rejected. The command prints a stable report and exits non-zero for invalid arguments, an unreadable database, or invalid persisted numeric data. It never mutates state.

## Testing

- Pure tests cover profitable and losing FIFO round trips, partial sells, opening inventory separation, fees, open marks, and unmatched sells.
- SQLite/CLI tests use a temporary migrated database and verify filters, opening/latest snapshot provenance, stable output, and read-only behavior.
- Full typecheck and repository tests remain required.
