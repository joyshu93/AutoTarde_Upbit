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

### Exposure Controls

- enforce a per-asset allocation cap
- enforce a total exposure cap
- evaluate projected exposure, not only current exposure
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
- `/run BTC|ETH`

These commands exist for control and inspection, not for manual portfolio editing.
`/help` is static command-contract inspection only and must not trigger sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission.
`/config` is non-secret runtime configuration inspection only; it may expose live blockers, explicit risk limits, and ignored deprecated environment variable names, but must not print raw credentials, tokens, or chat identifiers.
`/readiness` is read-only operator readiness inspection only; it may summarize blockers, warnings, and bounded local persistence health such as active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count, but must not actively probe Upbit or Telegram, mutate offset state, trigger sync, run strategies, tick schedulers, submit orders, cancel orders, or deliver notifications.
When live order transmission is intentionally configured, `/readiness` should warn that `/run` is real-order capable rather than treating the live send path itself as a blocking health failure. Paused, kill-switched, degraded, active-order, unresolved-order, and blocking reconciliation states must still remain `BLOCK`.
Reconciliation recovery progress such as recovered historical exchange orders and fill backfills may be reported as `WARN`; unresolved portfolio drift, missing order references, lookup failures, deferred lookups, or recovery-required orders remain `BLOCK`.
Inbound polling must stay disabled by default, must reject non-operator chat IDs before routing commands, and may persist only Telegram update-offset progress as transport state.
`/inbound` is inspection-only and must not call Telegram polling, trigger command routing, or mutate offset state.
The Telegram inbound smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable scheduler starts, and execute only one bounded poll.
`/run BTC|ETH` is a controlled strategy trigger, not discretionary manual trading; it must produce deterministic strategy evidence and pass the same risk and execution guards as any scheduled cycle.
`/order <order-id|identifier>` is inspection-only and must read persisted order lifecycle evidence without creating, canceling, syncing, or retrying orders.
`/scheduler` is inspection-only; it may read current scheduler runtime status and persisted scheduler run history but must not trigger or retry strategy cycles.
The strategy scheduler is disabled by default, must use explicit intervals, and must share the same deterministic runner, duplicate protection, execution-state guardrails, and live-send blockers as `/run BTC|ETH`.
When the scheduler is enabled in `LIVE` mode, startup must run an automatic preflight before installing timers. It must block on dry-run adapter wiring, disabled live gate, non-running/degraded/paused/killswitched operator state, missing Upbit read credentials, missing balance or position snapshots, active or reconciliation-required orders, and blocking reconciliation issue codes. Historical exchange-order recovery progress can remain a warning when no portfolio drift or unresolved order recovery is present.
The product does not require a ritualized manual first order before scheduler startup; the safety contract is the explicit preflight plus the same per-order risk and execution guards used by `/run BTC|ETH`.
A standalone live scheduler preflight smoke may assume scheduler-enabled startup preflight and report whether timers would be allowed, but it must not start the runtime, install timers, run a strategy cycle, run `/sync`, poll Telegram, call Upbit, or transmit orders.
A live scheduler startup script must require a separate explicit automatic-scheduler confirmation, keep `STRATEGY_SCHEDULER_RUN_ON_START=false` by default, and run the scheduler preflight smoke before starting the runtime.

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
- derived operator notification queue metrics, including active leases, expired leases, abandoned-lease candidates, recent delivery-run summaries, and recent delivery-attempt outcomes
- strategy scheduler run records, including started, completed, failed, and skipped scheduler-triggered cycles
- scheduler operator notifications for failed scheduled cycles, overlapping-run skips, and scheduler-triggered order submission or rejection
- scheduler startup-block notifications when live scheduler preflight refuses to install automatic timers
- Telegram inbound offset records, including the next update offset and last update id for replay prevention

Telegram delivery failure must not alter execution, reconciliation, or risk outcomes. It is an operator-reporting concern with its own durable state.
Retryable delivery failures should remain explicit as `PENDING` plus future `nextAttemptAt`, not silently disappear.
Concurrent delivery workers should only finalize a notification when the persisted lease token still matches the worker claim.
Long-running runtime shutdown should be explicit: signal handling must stop inbound polling, clear scheduler timers, and close SQLite persistence. Cleanup failures should be visible as partial shutdown failures instead of being swallowed.

## Current Implementation Note

This repository now enforces the policy through pure guard logic, durable SQLite persistence, persisted execution-state controls, startup recovery sweep plus `/sync` reconciliation, checkpointed exchange-history recovery with bounded stop-before coverage reporting, retention-assumption confidence semantics, page-limit truncation flags, and lookup-failure confidence records, startup `DEGRADED` policy for unresolved portfolio drift, execution prechecks through Upbit `orders/chance` and `orders/test`, immediate simulated `FILLED` settlement for supported `DRY_RUN` orders, local repair for older `DRY_RUN` adapter artifacts, automatic live scheduler startup preflight with durable startup-block notification, and durable `operator_notifications` with separately gated Telegram delivery retry/backoff, lease-based compare-and-set finalization, separate delivery-attempt history, delivery-worker run records, and derived claim/abandon queue metrics. The `PositionGuard_PaperTrade` runner can now persist decisions and route eligible decisions into the default `DRY_RUN` execution lifecycle through Telegram `/run BTC|ETH` and a disabled-by-default scheduler with persisted scheduler run history. The live send path remains intentionally disabled until explicit runtime configuration enables it.
