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
- reconciliation should compare new exchange-backed balance/position snapshots against the prior persisted snapshots plus local fill history to surface unexplained portfolio drift
- partial fills, cancel requests, rejects, and unresolved states must remain queryable

## Operator Controls

The operator surface should expose:
- `/status`
- `/statehistory`
- `/synchistory`
- `/alerts`
- `/risks`
- `/balances`
- `/positions`
- `/orders`
- `/pause`
- `/resume`
- `/killswitch`
- `/sync`

These commands exist for control and inspection, not for manual portfolio editing.

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

Telegram delivery failure must not alter execution, reconciliation, or risk outcomes. It is an operator-reporting concern with its own durable state.
Retryable delivery failures should remain explicit as `PENDING` plus future `nextAttemptAt`, not silently disappear.
Concurrent delivery workers should only finalize a notification when the persisted lease token still matches the worker claim.

## Current Implementation Note

This repository now enforces the policy through pure guard logic, durable SQLite persistence, persisted execution-state controls, startup recovery sweep plus `/sync` reconciliation, startup `DEGRADED` policy for unresolved portfolio drift, execution prechecks through Upbit `orders/chance` and `orders/test`, and durable `operator_notifications` with separately gated Telegram delivery retry/backoff, lease-based compare-and-set finalization, and separate delivery-attempt history. Remaining gaps are deeper exchange-history recovery, richer claim/abandon delivery observability, and keeping the live send path intentionally disabled until the user explicitly requests it.
