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
- `position-guard-runner` also supports a non-mutating preview path that computes the same decision and order intent without persisting strategy decisions or submitting orders
- the port preserves invalidation-first exits, no-chase entries, staged entry/add sizing, soft reduce logic, and borderline hourly confirmation semantics
- REDUCE decisions avoid double-counting derived `riskLevel` summaries and require independent weakening evidence when the structure stage is still `NONE`, so borderline bearish momentum alone remains a HOLD
- Telegram `/run BTC|ETH` now exposes a controlled operator trigger for one runner cycle without enabling live order transmission
- Telegram `/preview BTC|ETH` exposes the same deterministic decision and order intent without persistence or order submission
- Telegram `/run BTC|ETH` runs a manual live persisted-health preflight before invoking the runner when the runtime is in `LIVE`
- the disabled-by-default strategy scheduler now uses the same runner/controller path and still inherits the default live-order blockers
- scheduler `RUN_ON_START` runs configured markets sequentially so the account-scoped strategy runner lock does not skip the second market at startup
- live-mode scheduler startup now has an automatic preflight gate before timers are installed
- live-mode scheduled ticks first refresh exchange-backed account-health evidence with reconciliation source `SCHEDULER_PREFLIGHT`, then re-run the persisted-health preflight before invoking the strategy runner
- regular scheduler timer ticks are queued across configured markets for the exchange account, so simultaneous BTC/ETH timers do not produce account-lock `ALREADY_RUNNING` skips
- in `LIVE`, once a scheduled market tick submits an order, remaining market ticks from that same scheduler batch are persisted as `SKIPPED` and deferred to the next interval

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
- exposure cap checks apply to exposure-increasing orders; `ask` orders are modeled as risk-reducing exposure decreases for cap projection

### `execution`

Owns:
- order intent construction
- idempotency key generation
- persistence-before-submit behavior
- adapter invocation
- explicit failure recording
- pre-trade validation via Upbit `orders/chance` and `orders/test`

The execution layer is where `DRY_RUN` and `LIVE` diverge operationally, while still preserving the same durable order model.
The runtime wires the live Upbit adapter only when execution mode is `LIVE`, the live gate is enabled, and Upbit credentials are present; otherwise the send path remains the dry-run adapter.
For market sell intents where Upbit order input carries volume but no price, execution derives notional value from the strategy reference price and requested volume before applying local and exchange minimum-total guards.

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
- local dry-run order repair during reconciliation, so `dryrun_*` UUIDs are never queried against Upbit as real exchange orders
- terminal-order fill backfill during `/sync`
- balance and position drift detection by comparing new exchange-backed snapshots against the prior persisted snapshots plus local fill history, using parsed timestamp instants rather than raw timestamp text
- portfolio drift detection excludes simulated `DRY_RUN` fills because they do not mutate exchange balances
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
- `/start` as a transport-friendly alias to `/help`
- `/config` for non-secret runtime configuration, ignored deprecated environment variables, live blockers, and explicit risk-limit inspection
- `/readiness` for read-only operator readiness over runtime config, execution state, worker status, latest persisted health records, and bounded local persistence health
- `/readiness` classifies reconciliation recovery progress as warnings while keeping portfolio drift and unresolved order recovery as blockers
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
- `/preview BTC|ETH` for one non-mutating PositionGuard decision and order-intent preview
- `/run BTC|ETH` for one deterministic PositionGuard strategy runner cycle through the configured safe execution path
- `/status` strategy-scheduler lines for disabled/enabled state, configured intervals, next run timestamps, recent in-memory scheduler outcomes, and persisted recent scheduler run history
- `/status` strategy-scheduler lines also expose startup preflight status, scope, detail, and check results
- `/readiness` warns when a `LIVE` scheduler is running while the latest persisted balance snapshot, position snapshot, or reconciliation run is older than the shortest configured scheduler interval
- live scheduler startup preflight blocks are persisted as operator notifications before startup can close local persistence
- live scheduler per-run account-refresh or preflight blocks are persisted as failed `strategy_scheduler_runs` plus operator notifications before any strategy decision or order intent is created
- scheduler-triggered failures, overlapping-run skips, and scheduler-triggered order submission/rejection outcomes are persisted as operator notifications so automatic operation does not fail silently
- Windows Task Scheduler helpers register manual-only launch wrappers around ignored local startup scripts; they never store secrets in task definitions or add startup/logon triggers
- `/order <order-id|identifier>` for one persisted order plus order-event and fill detail without exchange mutation
- `/scheduler` for current in-memory scheduler status plus fuller read-only persisted `strategy_scheduler_runs` history without triggering scheduler execution
- `/inbound` for read-only runtime inbound polling status and persisted `telegram_inbound_offsets` inspection
- future reconciliation inspection as a read-only operator view
- `/synchistory` summaries that expose bounded archival recovery progress such as checkpoint window movement, page counts, stop-before boundary, retention-assumption boundary, coverage status, truncation flags, and confidence classification
- execution_state transition history inspection from persisted state
- outbox-based Telegram delivery that persists first, then attempts best-effort send behind `ENABLE_TELEGRAM_DELIVERY`
- delivery kicks received while an inline delivery worker is already running are coalesced into a follow-up pass, so due notifications created during an in-flight pass are not stranded as `PENDING`
- disabled-by-default inbound polling that accepts only `TELEGRAM_OPERATOR_CHAT_ID` messages and routes them through the existing command router
- inbound polling splits long routed replies into bounded Telegram messages so large inspection views such as `/alerts` do not fail the command update
- a bounded `smoke:telegram:inbound` operator validation script that forces `DRY_RUN`, disables live orders and scheduler ticks, and calls only one inbound `pollOnce()` without starting the runtime loop
- a non-mutating `smoke:dryrun:readiness` local preflight that forces DRY_RUN/live-disabled/scheduler-disabled startup settings, reads local readiness evidence, and reports next actions before the local DRY_RUN runtime starts
- an exchange-backed `smoke:dryrun:sync` local rehearsal that forces DRY_RUN/live-disabled/Telegram-disabled/scheduler-disabled settings, runs `/sync`, then inspects balances, positions, readiness, and sync history without running strategy or transmitting orders
- a fixture-backed `smoke:dryrun:operator` command rehearsal that forces offline `DRY_RUN`, clears Upbit private read credentials for the process, disables Telegram delivery/inbound polling and the scheduler, then routes `/config`, `/status`, `/readiness`, `/sync`, `/balances`, `/positions`, `/run BTC|ETH`, `/orders`, `/scheduler`, and `/alerts`
- a local DRY_RUN scheduler launcher that keeps live-send disabled, runs `smoke:dryrun:sync` and `smoke:dryrun:readiness` before startup, then starts the runtime with the scheduler enabled and `RUN_ON_START=true` for an automatic scheduled-path rehearsal
- a persisted-evidence `smoke:dryrun:completion` gate that forces live-send, Telegram transport, and scheduler startup disabled, then reads local snapshots, reconciliation, risk, notification, and `strategy_scheduler_runs` evidence to decide whether the DRY_RUN automatic scheduler rehearsal is complete without mutating execution state

`/help` is intentionally contract-derived and does not read repositories, poll Telegram, inspect exchange state, start sync, start strategy runs, start scheduler ticks, mutate orders, or enable live order transmission.
`/config` is intentionally non-secret and runtime-derived; it renders configured/not-configured booleans for secrets, exposes ignored deprecated environment variable names when present, and never prints raw credentials, tokens, or chat identifiers.
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
- submitted dry-run orders are immediately settled with simulated `FILLED` lifecycle evidence and synthetic fills when the order shape supports it
- reconciliation repairs older local dry-run artifacts to terminal local states without issuing Upbit private order lookups
- operator surfaces still see realistic lifecycle records

### `LIVE`

- not wired as the default application path
- requires both `APP_EXECUTION_MODE=LIVE` and `ENABLE_LIVE_ORDERS=true`
- requires configured Upbit credentials before the live adapter can become the send path
- must still use the same order lifecycle tables and risk gates

## Runtime Flow

1. Bootstrap configuration.
2. Optionally run an exchange-backed startup recovery sweep when Upbit read credentials are configured.
3. During startup recovery, persist fresh balance and position snapshots, reconcile orders/fills, detect unexplained portfolio drift, then apply the bootstrap-only `DEGRADED` policy if needed.
4. Load execution policy and operator state.
5. If the scheduler is enabled, build a scheduler startup preflight; in `LIVE` scope, block timer installation unless live-send configuration, execution state, fresh persisted snapshots, fresh latest reconciliation, and active-order state are safe.
6. Before each `LIVE` scheduled tick, run an exchange-backed account-health refresh that persists balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`.
7. After that refresh, re-run the same persisted-health preflight and fail the scheduler run without creating a strategy decision if the account-health evidence is stale or unsafe.
8. If multiple configured market timers become due together, queue their scheduled strategy cycles for the exchange account instead of letting the account-scoped runner lock skip one market.
9. If a `LIVE` scheduled tick submits an order, record remaining ticks from the same scheduler batch as `SKIPPED` and defer them to the next interval.
10. Build a deterministic strategy decision, either from an explicit operator `/run BTC|ETH` request or the disabled-by-default scheduler.
11. Convert the decision into an order intent with an idempotency key.
12. Run risk guards.
13. Run exchange pre-trade validation through `orders/chance` and `orders/test`.
14. Persist the order record and append an order event.
15. Call the exchange adapter.
16. Persist the updated order state.
17. Persist operator_notifications for significant operator-facing outcomes.
18. Kick best-effort Telegram delivery without letting network delivery alter execution outcomes.
19. If another delivery kick arrives while the inline worker is in flight, record a follow-up request and run one more delivery pass after the current pass finishes.
20. Due notifications are claimed with a lease token so concurrent workers do not finalize the same row blindly.
21. Delivery attempt outcomes are also written to `operator_notification_delivery_attempts` so operators can inspect recent send behavior separately from the summary row.
22. Delivery worker executions are written to `operator_notification_delivery_runs` with completed, skipped, or failed status.
23. Retryable Telegram delivery failures stay `PENDING` with future `next_attempt_at`, while permanent failures become `FAILED`.
24. Expose inspection and reconciliation surfaces.
25. If scheduler or inbound polling background timers are started, install signal handlers that stop Telegram inbound polling, stop scheduler timers, and close SQLite persistence on `SIGINT` / `SIGTERM`.
26. If no background runtime is started, close SQLite persistence immediately after the startup banner is printed.

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
- if the dry-run readiness smoke detects live mode, live order gate, live send path, or scheduler startup settings after its forced environment patch, block startup preflight and report the blocker explicitly
- if the dry-run sync smoke detects live mode, live order gate, live send path, Telegram delivery/inbound, or scheduler startup settings after its forced environment patch, block the exchange-backed sync rehearsal and report the blocker explicitly
- if the dry-run operator smoke detects live, exchange-backed, Telegram-delivery, inbound-polling, or scheduler-enabled settings after its forced environment patch, block the rehearsal and report the blocker explicitly
- if the local DRY_RUN scheduler launcher sees missing placeholders, failed exchange-backed sync smoke, or failed readiness smoke, it refuses to start the scheduler runtime
- if the dry-run completion smoke detects live mode, live order gate, live send path, Telegram transport, scheduler startup settings, missing sync evidence, unresolved risk/notification/order state, or missing latest BTC/ETH scheduler completion evidence, block the promotion gate and report the blocker explicitly
- if a local LIVE startup script sees a blocking live readiness or scheduler-preflight smoke result, refuse to start the long-running runtime
- if live scheduler startup is requested while live-send configuration or persisted account health is unsafe, block scheduler timers and expose the startup preflight detail
- if live scheduler startup preflight blocks timers, persist an operator notification with the preflight detail and failed checks before startup shutdown can close persistence
- if live scheduler startup preflight is checked by a smoke command, report the same preflight result without starting timers, polling Telegram, calling Upbit, running `/sync`, running strategy, or submitting orders
- if live scheduler per-run account refresh or preflight blocks a tick, persist a failed scheduler run and operator notification without creating a strategy decision or order intent
- if a scheduled strategy run fails, overlaps a still-running market cycle, submits an order, or has its order rejected, persist an operator notification without changing the scheduler run outcome
- if runtime shutdown cleanup fails, report a partial shutdown failure instead of silently skipping resource cleanup

## Current Gaps

- exchange-history recovery now includes bounded recent windows, checkpointed archival closed-order sweeps, a configured stop-before boundary, explicit retention-assumption confidence semantics, page-limit truncation detection, lookup-failure confidence records, and a dedicated `/recovery` inspection view
- reconciliation is still only partially exchange-backed today
- runtime startup does not auto-run trading cycles unless `STRATEGY_SCHEDULER_ENABLED=true`; `/run BTC|ETH` and the scheduler both trigger the first `PositionGuard_PaperTrade` runner and submit eligible decisions into the default `DRY_RUN` execution lifecycle
