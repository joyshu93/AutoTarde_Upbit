# Architecture

## Core Principles

- TypeScript strict mode everywhere
- modular monolith first
- pure logic separated from side effects
- explicit state transitions for orders, fills, balances, positions, risk, and execution control
- no hidden defaults for execution behavior
- exchange and strategy boundaries designed for later replacement

## Module Map

### `domain`

Holds the explicit contracts that the rest of the system shares:
- supported assets and markets
- execution mode and operator state
- strategy decision records
- order, order-event, and fill records
- risk and reconciliation records

### `strategy`

Produces deterministic decisions only.

It must:
- be inspectable
- avoid discretionary judgment
- emit inputs suitable for execution and audit

It must not:
- talk directly to Telegram
- submit orders
- mutate persistence

### `risk`

Applies hard guardrails before an order can proceed.

Current guard families:
- global kill switch
- paused execution
- live-mode gate
- stale price guard
- duplicate order guard
- minimum order value guard
- per-asset allocation cap
- total exposure cap

The intended policy framing is budget-first:
- total exposure cap is the primary reserve control
- per-asset allocation caps are concentration backstops
- future strategy sizing should key off total equity / exposure budgets rather than a simplistic equal-slot asset count rule

### `execution`

Owns:
- order intent construction
- idempotency key generation
- persistence-before-submit behavior
- adapter invocation
- explicit failure recording
- pre-trade validation via Upbit `orders/chance` and `orders/test`

The execution layer is where `DRY_RUN` and `LIVE` diverge operationally, while still preserving the same durable order model.

### `exchange`

Owns exchange-specific behavior:
- Upbit private authentication
- request signing
- balance queries
- order chance and order test paths
- create, cancel, and get-order methods

The exchange layer should not own portfolio policy or strategy behavior.

### `reconciliation`

Owns recovery-oriented comparison between persisted local lifecycle state and exchange-backed truth.

Current slice:
- exchange-backed active-order reconciliation through `/sync`
- terminal-order fill backfill during `/sync`
- balance and position drift detection by comparing new exchange-backed snapshots against the prior persisted snapshots plus local fill history
- startup recovery sweep when exchange-backed Upbit reads are configured
- per-run reconciliation lookup budgeting with oldest-first processing inside each priority tier
- checkpointed exchange-history recovery with an explicit stop-before boundary, `IN_PROGRESS` / `COMPLETE` coverage status, and separate `HIGH` / `PARTIAL` / `FAILED` confidence classification
- startup policy that can mark persisted operator state `DEGRADED` when unresolved portfolio drift remains after startup recovery

It should eventually reconcile:
- active orders
- fills
- balances
- positions
- execution failures that occurred between local persistence and exchange acknowledgement

### `telegram`

Telegram is an operator surface only.

It provides:
- inspection commands
- pause/resume/killswitch controls
- reporting-friendly formatters
- persisted-status inspection that can summarize recent operator-state transitions
- `/status` summary that includes the latest persisted reconciliation run health
- `/status` summary that now also includes checkpointed exchange-history recovery progress, coverage status, and confidence classification from the latest persisted reconciliation run
- `/statehistory` for read-only execution_state transition history
- `/synchistory` for read-only persisted reconciliation_runs inspection
- `/recovery` for read-only checkpointed exchange-history recovery progress inspection
- `/alerts` for read-only persisted operator_notifications inspection, including `PENDING` / `SENT` / `FAILED` plus retry metadata such as `attempt_count`, `next_attempt_at`, and `failure_class`
- `/alerts` now also shows recent rows from the separate persisted `operator_notification_delivery_attempts` audit trail
- `/alerts` now derives delivery-worker queue metrics including pending totals, due/scheduled counts, active/expired leases, abandoned-lease candidates, and recent attempt outcome counts
- `/risks` for read-only persisted risk_events inspection
- `/sync` for reconciliation-triggered snapshot and reconciliation record persistence with read-only public ticker valuation
- future reconciliation inspection as a read-only operator view
- `/synchistory` summaries that expose bounded archival recovery progress such as checkpoint window movement, page counts, stop-before boundary, coverage status, truncation flags, and confidence classification
- execution_state transition history inspection from persisted state
- outbox-based Telegram delivery that persists first, then attempts best-effort send behind `ENABLE_TELEGRAM_DELIVERY`

It does not provide:
- portfolio truth entry
- cash recording
- manual position recording

### `db`

Owns repository interfaces and storage adapters.

The default runtime path is SQLite-backed local persistence via `DATABASE_PATH` (default: `./var/autotrade-upbit.sqlite`).
Persisted `execution_state` is the operator authority for runtime control, including pause, resume, kill-switch, and live-order gating decisions.
It also carries persisted `degraded_reason` / `degraded_at` metadata so startup health signals survive `/pause -> /resume` without being conflated with pause semantics.

This slice contains:
- the initial migration
- SQLite statement/type shapes
- repository contracts
- SQLite-backed runtime repositories
- in-memory implementations kept for isolated tests and temporary scaffolding

## Durable Records

The schema is centered on recovery and auditability:
- `users`
- `exchange_accounts`
- `execution_state`
- `execution_state_transitions`
- `strategy_decisions`
- `balance_snapshots`
- `position_snapshots`
- `orders`
- `order_events`
- `fills`
- `reconciliation_runs`
- `operator_notifications`
- `operator_notification_delivery_attempts`
- `risk_events`

The important design choice is that order lifecycle data is first-class. Balance or position drift must be explainable through orders, fills, cancellations, failures, reconciliation runs, and explicit operator-state transitions.
`operator_notifications` follow the same philosophy: delivery status is durable and separate from execution or reconciliation state.
Retry metadata is durable too, so delivery workers can reschedule without mutating execution or reconciliation records.
Lease metadata is durable as well, so workers can claim rows and finalize only when the claimed `lease_token` still matches.
`operator_notification_delivery_attempts` add append-oriented delivery observability without changing the current-summary semantics of `operator_notifications`.
Delivery-worker queue metrics are currently derived from persisted notification and attempt rows rather than stored in a separate worker-run table.

## Execution Modes

### `DRY_RUN`

- default runtime mode
- order intents are persisted to the active repository
- risk is evaluated
- the dry-run exchange adapter simulates submission without live transmission
- operator surfaces still see realistic lifecycle records

### `LIVE`

- not wired as the default application path
- requires both `APP_EXECUTION_MODE=LIVE` and `ENABLE_LIVE_ORDERS=true`
- must still use the same order lifecycle tables and risk gates

## Runtime Flow

1. Bootstrap configuration.
2. Optionally run an exchange-backed startup recovery sweep when Upbit read credentials are configured.
3. During startup recovery, persist fresh balance and position snapshots, reconcile orders/fills, detect unexplained portfolio drift, then apply the bootstrap-only `DEGRADED` policy if needed.
4. Load execution policy and operator state.
5. Build a deterministic strategy decision.
6. Convert the decision into an order intent with an idempotency key.
7. Run risk guards.
8. Run exchange pre-trade validation through `orders/chance` and `orders/test`.
9. Persist the order record and append an order event.
10. Call the exchange adapter.
11. Persist the updated order state.
12. Persist operator_notifications for significant operator-facing outcomes.
13. Kick best-effort Telegram delivery without letting network delivery alter execution outcomes.
14. Due notifications are claimed with a lease token so concurrent workers do not finalize the same row blindly.
15. Delivery attempt outcomes are also written to `operator_notification_delivery_attempts` so operators can inspect recent send behavior separately from the summary row.
16. Retryable Telegram delivery failures stay `PENDING` with future `next_attempt_at`, while permanent failures become `FAILED`.
17. Expose inspection and reconciliation surfaces.

## Failure Posture

The system prefers explicit failure records over silent suppression.

Examples:
- if risk blocks an order, persist a `risk_event`
- if exchange submission fails after local persistence, keep the order and mark it `FAILED`
- if order state cannot be reconciled, mark it for recovery rather than pretending success
- if exchange-backed snapshots move in a way the local fill ledger cannot explain, persist both reconciliation issues and `risk_events`, then consider `DEGRADED` during startup bootstrap
- if Telegram delivery fails, keep the notification and mark it `FAILED` rather than mutating execution or reconciliation outcomes

## Current Gaps

- exchange-history recovery now includes bounded recent windows, checkpointed archival closed-order sweeps, a configured stop-before boundary, page-limit truncation detection, lookup-failure confidence records, and a dedicated `/recovery` inspection view; remaining confidence work is richer classification of Upbit-side retention semantics
- reconciliation is still only partially exchange-backed today
- delivery-attempt history and derived queue metrics exist, but there is not yet a durable delivery-worker run table for scheduled worker execution history
- strategy logic is intentionally stubbed
