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

## Exchange Validation Requirements

Before the live path is considered production-ready, the system should validate orders through:
- Upbit order chance data
- Upbit order test where appropriate
- explicit response handling for rejected or offline markets

## Recovery Requirements

- local persistence must happen before an order is considered safely handled
- failures between persistence and exchange acknowledgement must remain visible
- reconciliation runs must produce durable records
- partial fills, cancel requests, rejects, and unresolved states must remain queryable

## Operator Controls

The operator surface should expose:
- `/status`
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
- kill-switch or pause transitions

## Current Implementation Note

This repository currently enforces the policy through pure guard logic and configuration defaults. Exchange-backed enforcement and durable SQLite persistence are the next integration step, not yet the completed state.
