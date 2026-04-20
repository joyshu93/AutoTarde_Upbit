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

### `execution`

Owns:
- order intent construction
- idempotency key generation
- persistence-before-submit behavior
- adapter invocation
- explicit failure recording

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

It does not provide:
- portfolio truth entry
- cash recording
- manual position recording

### `db`

Owns repository interfaces and storage adapters.

This first slice contains:
- the initial migration
- repository contracts
- an in-memory implementation used for compilation and tests

The intended next adapter is SQLite-backed local persistence.

## Durable Records

The schema is centered on recovery and auditability:
- `users`
- `exchange_accounts`
- `execution_state`
- `strategy_decisions`
- `balance_snapshots`
- `position_snapshots`
- `orders`
- `order_events`
- `fills`
- `reconciliation_runs`
- `risk_events`

The important design choice is that order lifecycle data is first-class. Balance or position drift must be explainable through orders, fills, cancellations, failures, and reconciliation runs.

## Execution Modes

### `DRY_RUN`

- default runtime mode
- order intents are persisted
- risk is evaluated
- the dry-run exchange adapter simulates submission without live transmission
- operator surfaces still see realistic lifecycle records

### `LIVE`

- not wired as the default application path
- requires both `APP_EXECUTION_MODE=LIVE` and `ENABLE_LIVE_ORDERS=true`
- must still use the same order lifecycle tables and risk gates

## Runtime Flow

1. Bootstrap configuration.
2. Load execution policy and operator state.
3. Build a deterministic strategy decision.
4. Convert the decision into an order intent with an idempotency key.
5. Run risk guards.
6. Persist the order record and append an order event.
7. Call the exchange adapter.
8. Persist the updated order state.
9. Expose inspection and reconciliation surfaces.

## Failure Posture

The system prefers explicit failure records over silent suppression.

Examples:
- if risk blocks an order, persist a `risk_event`
- if exchange submission fails after local persistence, keep the order and mark it `FAILED`
- if order state cannot be reconciled, mark it for recovery rather than pretending success

## Current Gaps

- SQLite repository implementation is still pending
- exchange-backed snapshot ingestion is still pending
- reconciliation is local-first rather than exchange-backed
- Telegram reporting is command-oriented and not yet event-push oriented
- strategy logic is intentionally stubbed
