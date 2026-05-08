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

Current strategy direction:
- the runtime app still wires a safe `HOLD` stub
- the first pure `PositionGuard_PaperTrade` core port exists in `position-guard-core`
- the first pure `PositionGuard_PaperTrade` market-structure analyzer port exists in `market-structure`
- `position-guard-snapshot` now normalizes Upbit public ticker and 1h/4h/1d candle responses into the analyzer input shape
- `position-guard-context` now assembles persisted balances, positions, latest compatible strategy decisions, and recent filled sell context into the core decision input shape
- `position-guard-runner` now performs one explicit market cycle: public snapshot read, structure analysis, persisted context assembly, core decision, durable strategy-decision persistence, and optional `DRY_RUN` execution submission
- the port preserves invalidation-first exits, no-chase entries, staged entry/add sizing, soft reduce logic, and borderline hourly confirmation semantics
- Telegram `/run BTC|ETH` now exposes a controlled operator trigger for one runner cycle without enabling live order transmission
- the disabled-by-default strategy scheduler now uses the same runner/controller path and still inherits the default live-order blockers

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
- public ticker and candle reads for deterministic strategy inputs
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
- checkpointed exchange-history recovery with an explicit stop-before boundary, explicit exchange-retention assumption metadata, `IN_PROGRESS` / `COMPLETE` coverage status, and separate `HIGH` / `PARTIAL` / `FAILED` confidence classification
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
- `/help` for static command-contract inspection and operator safety boundaries
- `/config` for non-secret runtime configuration, live blockers, and explicit risk-limit inspection
- `/readiness` for read-only operator readiness over runtime config, execution state, worker status, latest persisted health records, and bounded local persistence health
- inspection commands
- pause/resume/killswitch controls
- reporting-friendly formatters
- persisted-status inspection that can summarize recent operator-state transitions
- `/status` summary that includes the latest persisted reconciliation run health
- `/status` summary that now also includes checkpointed exchange-history recovery progress, retention-assumption status, coverage status, and confidence classification from the latest persisted reconciliation run
- `/statehistory` for read-only execution_state transition history
- `/synchistory` for read-only persisted reconciliation_runs inspection
- `/recovery` for read-only checkpointed exchange-history recovery progress inspection
- `/alerts` for read-only persisted operator_notifications inspection, including `PENDING` / `SENT` / `FAILED` plus retry metadata such as `attempt_count`, `next_attempt_at`, and `failure_class`
- `/alerts` now also shows recent rows from the separate persisted `operator_notification_delivery_attempts` audit trail
- `/alerts` now derives delivery-worker queue metrics including pending totals, due/scheduled counts, active/expired leases, abandoned-lease candidates, recent delivery-run summaries, and recent attempt outcome counts
- `/risks` for read-only persisted risk_events inspection
- `/sync` for reconciliation-triggered snapshot and reconciliation record persistence with read-only public ticker valuation
- `/run BTC|ETH` for one deterministic PositionGuard strategy runner cycle through the configured safe execution path
- `/status` strategy-scheduler lines for disabled/enabled state, configured intervals, next run timestamps, recent in-memory scheduler outcomes, and persisted recent scheduler run history
- `/order <order-id|identifier>` for one persisted order plus order-event and fill detail without exchange mutation
- `/scheduler` for fuller read-only persisted `strategy_scheduler_runs` history without triggering scheduler execution
- `/inbound` for read-only runtime inbound polling status and persisted `telegram_inbound_offsets` inspection
- future reconciliation inspection as a read-only operator view
- `/synchistory` summaries that expose bounded archival recovery progress such as checkpoint window movement, page counts, stop-before boundary, retention-assumption boundary, coverage status, truncation flags, and confidence classification
- execution_state transition history inspection from persisted state
- outbox-based Telegram delivery that persists first, then attempts best-effort send behind `ENABLE_TELEGRAM_DELIVERY`
- disabled-by-default inbound polling that accepts only `TELEGRAM_OPERATOR_CHAT_ID` messages and routes them through the existing command router
- a bounded `smoke:telegram:inbound` operator validation script that forces `DRY_RUN`, disables live orders and scheduler ticks, and calls only one inbound `pollOnce()` without starting the runtime loop

`/help` is intentionally contract-derived and does not read repositories, poll Telegram, inspect exchange state, start sync, start strategy runs, start scheduler ticks, mutate orders, or enable live order transmission.
`/config` is intentionally non-secret and runtime-derived; it renders configured/not-configured booleans for secrets and never prints raw credentials, tokens, or chat identifiers.
`/readiness` is intentionally inspection-only; it reads bounded local state and runtime status, including active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count, but does not poll Telegram, call Upbit, start sync, run strategies, tick schedulers, mutate offsets, deliver notifications, or mutate orders.

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
- `strategy_scheduler_runs`
- `operator_notifications`
- `operator_notification_delivery_attempts`
- `operator_notification_delivery_runs`
- `telegram_inbound_offsets`
- `risk_events`

The important design choice is that order lifecycle data is first-class. Balance or position drift must be explainable through orders, fills, cancellations, failures, reconciliation runs, and explicit operator-state transitions.
Single-order inspection reads only persisted `orders`, `order_events`, and `fills`, so it improves recoverability without becoming an execution trigger.
`operator_notifications` follow the same philosophy: delivery status is durable and separate from execution or reconciliation state.
Retry metadata is durable too, so delivery workers can reschedule without mutating execution or reconciliation records.
Lease metadata is durable as well, so workers can claim rows and finalize only when the claimed `lease_token` still matches.
`operator_notification_delivery_attempts` add append-oriented delivery observability without changing the current-summary semantics of `operator_notifications`.
`operator_notification_delivery_runs` add one row per delivery-worker execution so scheduled or inline workers leave a durable summary even when no notification was sent.
Delivery-worker queue metrics are currently derived from persisted notification, delivery-run, and attempt rows.
Readiness-local health metrics are likewise bounded persisted summaries only: active/non-terminal order count from order state, recent risk `BLOCK` count from `risk_events`, and pending operator notification count from `operator_notifications`.
`strategy_scheduler_runs` records scheduler-triggered strategy cycles separately from strategy decisions and orders so operators can inspect scheduler health without treating scheduler state as trading truth.
`telegram_inbound_offsets` records `getUpdates` transport progress, scoped by exchange account and non-secret bot-token fingerprint. It is durable transport state, not portfolio truth.

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
5. Build a deterministic strategy decision, either from an explicit operator `/run BTC|ETH` request or the disabled-by-default scheduler.
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
16. Delivery worker executions are written to `operator_notification_delivery_runs` with completed, skipped, or failed status.
17. Retryable Telegram delivery failures stay `PENDING` with future `next_attempt_at`, while permanent failures become `FAILED`.
18. Expose inspection and reconciliation surfaces.
19. If scheduler or inbound polling background timers are started, install signal handlers that stop Telegram inbound polling, stop scheduler timers, and close SQLite persistence on `SIGINT` / `SIGTERM`.
20. If no background runtime is started, close SQLite persistence immediately after the startup banner is printed.

## Failure Posture

The system prefers explicit failure records over silent suppression.

Examples:
- if risk blocks an order, persist a `risk_event`
- if exchange submission fails after local persistence, keep the order and mark it `FAILED`
- if order state cannot be reconciled, mark it for recovery rather than pretending success
- if exchange-backed snapshots move in a way the local fill ledger cannot explain, persist both reconciliation issues and `risk_events`, then consider `DEGRADED` during startup bootstrap
- if Telegram delivery fails, keep the notification and mark it `FAILED` rather than mutating execution or reconciliation outcomes
- if Telegram inbound reply delivery fails, surface that failure in polling status rather than mutating execution, reconciliation, or order state
- if the Telegram inbound smoke script detects non-smoke safety settings after its forced environment patch, block polling and report the blocker explicitly
- if runtime shutdown cleanup fails, report a partial shutdown failure instead of silently skipping resource cleanup

## Current Gaps

- exchange-history recovery now includes bounded recent windows, checkpointed archival closed-order sweeps, a configured stop-before boundary, explicit retention-assumption confidence semantics, page-limit truncation detection, lookup-failure confidence records, and a dedicated `/recovery` inspection view
- reconciliation is still only partially exchange-backed today
- runtime startup does not auto-run trading cycles unless `STRATEGY_SCHEDULER_ENABLED=true`; `/run BTC|ETH` and the scheduler both trigger the first `PositionGuard_PaperTrade` runner and submit eligible decisions into the default `DRY_RUN` execution lifecycle
