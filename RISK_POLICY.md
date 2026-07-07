# Risk Policy

## Non-Negotiable Safety Rules

- default execution mode is `DRY_RUN`
- live order transmission stays disabled until explicitly enabled by the user
- only Upbit spot trading is allowed
- only `KRW-BTC` and `KRW-ETH` are allowed
- Telegram cannot mutate balance or position truth
- failures must be recorded explicitly

## Dual Live-Mode Gate

Live trading is considered allowed only when both conditions are true:

1. `APP_EXECUTION_MODE=LIVE`
2. `ENABLE_LIVE_ORDERS=true`

If either condition is missing, the system must behave as non-live, and risk evaluation should block any attempt to treat the run as live.

## Guardrail Set

### Global Kill Switch

- must immediately block new execution
- must be inspectable
- should remain sticky until an operator deliberately resets it

### Pause / Resume

- `PAUSED` blocks new execution while preserving existing records
- resume must be explicit
- pause reason should be preserved for operator visibility

### Degraded Startup Health

- `DEGRADED` is a persisted operator-state signal for unresolved startup health problems, especially unexplained portfolio drift
- `DEGRADED` must be inspectable with explicit reason and timestamp
- `DEGRADED` must not overwrite `PAUSED` or `KILL_SWITCHED`; those states keep priority while degraded metadata remains durable
- resume must restore `DEGRADED` when degraded metadata is still active
- execution guardrails must block new orders while the effective system status is `DEGRADED`

### Duplicate Order Guard

- every order intent requires an idempotency key
- the system must reject duplicate active intents for the same fingerprint
- duplicate suppression must not rely only on message cooldowns or human-readable summaries

### Stale Price Guard

- orders require a recent price snapshot
- missing or stale pricing must block submission
- stale thresholds must be explicit configuration, not hidden constants

### Minimum Order Value Guard

- the system must reject orders below the configured local minimum
- the local minimum is a risk control and must not be confused with exchange-enforced minimums
- market sell orders with quantity but no order price must derive order value from the strategy reference price before local and exchange minimum-total checks

### Exposure Controls

- enforce a per-asset allocation cap
- enforce a total exposure cap
- evaluate projected exposure, not only current exposure
- model `bid` orders as exposure-increasing and `ask` orders as exposure-reducing for projection
- do not block a risk-reducing `ask` solely because the current portfolio is already above a cap
- treat total exposure as the primary reserve-policy anchor
- treat per-asset caps as concentration backstops, not as an equal-split-by-asset budgeting rule

## Exchange Validation Requirements

The execution path should validate orders through:
- Upbit order chance data
- Upbit order test where appropriate
- explicit response handling for rejected or offline markets

## Recovery Requirements

- local persistence must happen before an order is considered safely handled
- failures between persistence and exchange acknowledgement must remain visible
- reconciliation runs must produce durable records
- process startup should attempt a recovery sweep when exchange-backed reads are available
- reconciliation should respect an explicit per-run lookup budget to avoid exchange read bursts
- exchange-history recovery should stop at the configured historical boundary, expose the configured exchange-history retention assumption, report archive coverage as `IN_PROGRESS` or `COMPLETE`, and separately report confidence as `HIGH`, `PARTIAL`, or `FAILED`
- reconciliation should compare new exchange-backed balance/position snapshots against the prior persisted snapshots plus local fill history to surface unexplained portfolio drift
- reconciliation fill windows must compare parsed timestamp instants so exchange timestamps with offsets are not ordered as raw text
- reconciliation must not query Upbit for local `DRY_RUN` adapter artifacts such as `dryrun_*` UUIDs; those records must be repaired locally and remain visibly simulated
- simulated `DRY_RUN` fills must not be used as exchange-balance explanations in portfolio drift detection
- partial fills, cancel requests, rejects, and unresolved states must remain queryable

## Operator Controls

The operator surface should expose:
- `/help`
- `/config`
- `/readiness`
- `/status`
- `/statehistory`
- `/synchistory`
- `/recovery`
- `/alerts`
- `/risks`
- `/balances`
- `/positions`
- `/orders`
- `/order <order-id|identifier>`
- `/scheduler`
- `/inbound`
- `/pause`
- `/resume`
- `/killswitch`
- `/sync`
- `/preview BTC|ETH`
- `/run BTC|ETH`

These commands exist for control and inspection, not for manual portfolio editing.
`/help` is static command-contract inspection only and must not trigger sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission.
`/config` is non-secret runtime configuration inspection only; it may expose live blockers, explicit risk limits, and ignored deprecated environment variable names, but must not print raw credentials, tokens, or chat identifiers.
`/readiness` is read-only operator readiness inspection only; it may summarize blockers, warnings, and bounded local persistence health such as active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count, but must not actively probe Upbit or Telegram, mutate offset state, trigger sync, run strategies, tick schedulers, submit orders, cancel orders, or deliver notifications.
When live order transmission is intentionally configured, `/readiness` should warn that `/run` is real-order capable rather than treating the live send path itself as a blocking health failure. Paused, kill-switched, degraded, active-order, unresolved-order, and blocking reconciliation states must still remain `BLOCK`.
When a `LIVE` scheduler is enabled, `/readiness` must warn if the latest persisted balance snapshot, position snapshot, or reconciliation run is stale relative to the shortest configured scheduler interval. It remains read-only and must not run `/sync` to refresh those records.
Reconciliation recovery progress such as recovered historical exchange orders and fill backfills may be reported as `WARN`; unresolved portfolio drift, missing order references, lookup failures, deferred lookups, or recovery-required orders remain `BLOCK`.
Inbound polling must stay disabled by default, must reject non-operator chat IDs before routing commands, and may persist only Telegram update-offset progress as transport state.
Inbound polling may split long command replies into multiple Telegram messages to satisfy transport limits; such splitting is not execution state and must not change command semantics.
`/inbound` is inspection-only and must not call Telegram polling, trigger command routing, or mutate offset state.
The Telegram inbound smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable scheduler starts, and execute only one bounded poll.
The dry-run readiness smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable scheduler starts, read only local persisted readiness evidence, and never run `/sync`, run strategy, poll Telegram, call Upbit, deliver notifications, or transmit orders.
The dry-run sync smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable Telegram delivery and inbound polling, disable scheduler starts, require Upbit read credentials, and run only exchange-backed `/sync` plus read-only inspection commands. It may persist balance snapshots, position snapshots, reconciliation runs, risk evidence from drift detection, and recovery records, but it must not run strategy or transmit orders.
The dry-run operator smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, clear Upbit private read credentials for the process, disable Telegram delivery and inbound polling, disable scheduler starts, use fixture public market data, and never transmit live orders. It may persist local DRY_RUN snapshots and strategy decisions because it routes `/sync` and `/run BTC|ETH` through the operator surface.
The PositionGuard public backtest command is research-only. It may call Upbit public candle endpoints and run the pure offline replay/report path, including offline diagnostic comparisons such as buy-and-hold benchmark, monthly returns, regime return contribution, skip-reason counts, and trade diagnostics, but it must not read or write the local execution database, poll or deliver Telegram, call Upbit private endpoints, create strategy decisions in persistence, create order intents, mutate order lifecycle records, or transmit live orders. It fetches public timeframe groups sequentially and may use bounded 429 retry/backoff for Upbit public rate limits; this retry behavior is quotation-read handling only, not an execution retry.
The local DRY_RUN scheduler launcher may enable scheduled strategy cycles and `RUN_ON_START=true` only after an explicit local DRY_RUN scheduler confirmation. It must keep `APP_EXECUTION_MODE=DRY_RUN`, keep `ENABLE_LIVE_ORDERS=false`, require Upbit and Telegram credentials locally, run exchange-backed DRY_RUN sync/readiness checks before startup, and stop before runtime startup when either smoke returns `BLOCK`.
The dry-run completion smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable Telegram delivery and inbound polling, disable scheduler starts, require Upbit and Telegram credentials to be configured, and read only persisted completion evidence. It must block when latest snapshots, latest reconciliation, active-order state, recent risk blocks, pending operator notifications, or latest BTC/ETH scheduler-run completion evidence are unsafe or missing.
`/preview BTC|ETH` is a non-mutating strategy preview; it may compute deterministic decision evidence and order intent, but must not persist a strategy decision, create an order intent, run reconciliation, or transmit an order.
`/run BTC|ETH` is a controlled strategy trigger, not discretionary manual trading; it must produce deterministic strategy evidence and pass the same risk and execution guards as any scheduled cycle. In `LIVE`, manual `/run` must first pass persisted-health preflight over live gate, adapter wiring, execution state, Upbit read credentials, fresh balance and position snapshots, fresh latest reconciliation, active-order state, and blocking reconciliation issue codes before invoking the strategy runner.
`/order <order-id|identifier>` is inspection-only and must read persisted order lifecycle evidence without creating, canceling, syncing, or retrying orders.
`/scheduler` is inspection-only; it may read current scheduler runtime status and persisted scheduler run history but must not trigger or retry strategy cycles.
The strategy scheduler is disabled by default, must use explicit intervals, and must share the same deterministic runner, duplicate protection, execution-state guardrails, and live-send blockers as `/run BTC|ETH`.
When the scheduler is enabled in `LIVE` mode, startup must run an automatic preflight before installing timers. It must block on dry-run adapter wiring, disabled live gate, non-running/degraded/paused/killswitched operator state, missing Upbit read credentials, missing or stale balance or position snapshots, missing or stale latest reconciliation evidence, active or reconciliation-required orders, and blocking reconciliation issue codes. The freshness threshold is the shortest configured scheduler interval, so automatic trading cannot start from older account-health evidence than its own cadence. Historical exchange-order recovery progress can remain a warning when no portfolio drift or unresolved order recovery is present.
Before every `LIVE` scheduled tick, the scheduler must run an exchange-backed account-health refresh that may persist balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`. The refresh is not a strategy run and must not create order intents or transmit orders.
The same persisted-health preflight must then run before every `LIVE` scheduled tick. If the refresh fails or the preflight blocks, the scheduler must persist a failed scheduler-run record and operator notification without invoking the strategy runner, creating a strategy decision, or creating an order intent.
When BTC and ETH scheduled timers become due at the same time, scheduler-triggered market cycles must be queued for the exchange account so a healthy second market cycle is not marked `ALREADY_RUNNING` only because the first market is still inside the account-scoped runner.
When a `LIVE` scheduled market cycle submits an order, later market cycles from the same scheduler batch must be persisted as `SKIPPED` and deferred to their next interval before another strategy decision can be created.
The product does not require a ritualized manual first order before scheduler startup; the safety contract is the explicit preflight plus the same per-order risk and execution guards used by `/run BTC|ETH`.
A standalone live scheduler preflight smoke may assume scheduler-enabled startup preflight and report whether timers would be allowed, but it must not start the runtime, install timers, run a strategy cycle, run `/sync`, poll Telegram, call Upbit, or transmit orders.
A live startup script must run the live readiness smoke before runtime startup and refuse to start when the smoke reports a blocking failure.
A live scheduler startup script must require a separate explicit automatic-scheduler confirmation, keep `STRATEGY_SCHEDULER_RUN_ON_START=false` by default, and run the scheduler preflight smoke before starting the runtime.
Windows Task Scheduler registration helpers must remain manual-only. They may point to ignored local launcher scripts, but must not include API keys, Telegram secrets, startup/logon triggers, catch-up triggers, or automatic task starts after registration.

## Audit Expectations

Every important transition should leave a durable trail:
- strategy decision creation
- risk rejection
- order persistence
- exchange submission response
- fill ingestion
- reconciliation summary
- balance drift and position drift findings
- kill-switch or pause transitions
- `DEGRADED` mark/clear transitions during bootstrap health policy
- operator notification delivery attempts, including `SENT` / `FAILED`, `deliveredAt`, and `lastError`
- operator notification delivery attempt history, including `RETRY_SCHEDULED` / `STALE_LEASE`, attempt timestamps, and follow-up retry timing
- operator notification retry metadata, including `attemptCount`, `lastAttemptAt`, `nextAttemptAt`, and `failureClass`
- operator notification lease metadata, so concurrent workers can only finalize rows they claimed
- operator notification delivery-worker run records, including skipped, completed, and failed worker executions
- operator notification follow-up delivery passes when new due notifications are kicked during an in-flight worker run
- derived operator notification queue metrics, including active leases, expired leases, abandoned-lease candidates, recent delivery-run summaries, and recent delivery-attempt outcomes
- strategy scheduler run records, including started, completed, failed, and skipped scheduler-triggered cycles
- scheduler operator notifications for failed scheduled cycles, overlapping-run skips, and scheduler-triggered order submission or rejection
- scheduler startup-block notifications when live scheduler preflight refuses to install automatic timers
- scheduler per-run account-refresh or preflight block notifications before any scheduled strategy decision or order intent is created
- Telegram inbound offset records, including the next update offset and last update id for replay prevention

Telegram delivery failure must not alter execution, reconciliation, or risk outcomes. It is an operator-reporting concern with its own durable state.
Retryable delivery failures should remain explicit as `PENDING` plus future `nextAttemptAt`, not silently disappear.
Concurrent delivery workers should only finalize a notification when the persisted lease token still matches the worker claim.
Delivery kicks requested during an active inline worker run should not strand due `PENDING` notifications; they should trigger a follow-up worker pass.
Long-running runtime shutdown should be explicit: signal handling must stop inbound polling, clear scheduler timers, and close SQLite persistence. Cleanup failures should be visible as partial shutdown failures instead of being swallowed.

## Current Implementation Note

This repository now enforces the policy through pure guard logic, durable SQLite persistence, persisted execution-state controls, startup recovery sweep plus `/sync` reconciliation, checkpointed exchange-history recovery with bounded stop-before coverage reporting, retention-assumption confidence semantics, page-limit truncation flags, and lookup-failure confidence records, startup `DEGRADED` policy for unresolved portfolio drift, instant-based fill/snapshot drift windows, execution prechecks through Upbit `orders/chance` and `orders/test`, reference-price notional derivation for market sell minimum-value checks, exposure cap projection that treats `ask` orders as risk-reducing, immediate simulated `FILLED` settlement for supported `DRY_RUN` orders, local repair for older `DRY_RUN` adapter artifacts, a persisted-evidence DRY_RUN completion gate for the automatic scheduler rehearsal, automatic live scheduler startup preflight, scheduled account-health refresh with `SCHEDULER_PREFLIGHT` reconciliation evidence, per-run preflight with persisted-health freshness checks and durable block notifications, queued scheduled market cycles for simultaneous BTC/ETH timers, same-batch live scheduler deferral after an order submission, manual live `/run` preflight, and durable `operator_notifications` with separately gated Telegram delivery retry/backoff, lease-based compare-and-set finalization, separate delivery-attempt history, delivery-worker run records, and derived claim/abandon queue metrics. The `PositionGuard_PaperTrade` runner can now preview decisions through Telegram `/preview BTC|ETH`, persist decisions and route eligible decisions into the default `DRY_RUN` execution lifecycle through Telegram `/run BTC|ETH`, and run through a disabled-by-default scheduler with persisted scheduler run history. Its REDUCE path treats `riskLevel` as a derived summary rather than a separate weakness score input and keeps losing/range positions on HOLD when only borderline bearish momentum is present without independent weakening evidence. The live send path remains intentionally disabled until explicit runtime configuration enables it.
