# Order Lifecycle

## Goal

Define one explicit lifecycle that works for both `DRY_RUN` and future `LIVE` execution.

The system must never treat “strategy said buy” as equivalent to “order exists.” Orders need explicit lifecycle records.

## Canonical States

- `INTENT_CREATED`
- `RISK_REJECTED`
- `PERSISTED`
- `SUBMITTING`
- `OPEN`
- `PARTIALLY_FILLED`
- `FILLED`
- `CANCEL_REQUESTED`
- `CANCELED`
- `REJECTED`
- `FAILED`
- `RECONCILIATION_REQUIRED`

## State Meaning

### `INTENT_CREATED`

An order intent exists in memory but is not yet durable.

### `RISK_REJECTED`

The intent was blocked by guardrails. A `risk_event` should exist.

### `PERSISTED`

The order record exists durably and is now recoverable even if the process crashes before submission completes.

### `SUBMITTING`

The system is actively calling the exchange adapter.

### `OPEN`

The exchange has accepted the order and it remains active.

### `PARTIALLY_FILLED`

The order has executed in part but is not complete.

### `FILLED`

The order is complete and any fill records should be durable.

### `CANCEL_REQUESTED`

The local system has requested cancellation and is awaiting exchange confirmation.

### `CANCELED`

The exchange has confirmed cancellation.

### `REJECTED`

The exchange rejected the order request.

### `FAILED`

The system failed during submission or persistence of the result. This is not equivalent to “no order exists.”

### `RECONCILIATION_REQUIRED`

The local and exchange views do not line up and recovery work is required.

## Dry-Run Path

In the current scaffold:

1. build the order intent
2. run risk evaluation
3. persist the order
4. call the dry-run adapter
5. record a synthetic accepted state for inspection

The dry-run path must still use the real order tables so that the operational shape matches the future live path.

## Live Path

The intended live path is:

1. create intent
2. risk approve
3. persist
4. submit to Upbit
5. store exchange UUID and raw response
6. ingest order-state changes and fills
7. reconcile until terminal state is consistent

## Idempotency

Every order intent requires:
- a deterministic `idempotency_key`
- a user-facing `identifier`

Idempotency is used to prevent duplicate active orders for the same decision and request fingerprint.

## Cancellation

Cancellation must preserve lifecycle evidence:
- cancellation request event
- exchange response
- terminal state or follow-up reconciliation requirement

## Reconciliation Triggers

Reconciliation should run when:
- a submission fails after local persistence
- an order remains active longer than expected
- a fill is suspected missing locally
- the process restarts with non-terminal orders
- an operator runs `/sync`

The current scaffold now uses both process startup recovery and operator-triggered `/sync` as explicit reconciliation entry points.

Restart recovery currently prioritizes persisted non-terminal orders first, then limited terminal backfill candidates, and respects a per-run exchange lookup budget.
Exchange-history recovery advances per-market archive checkpoints only until the configured stop-before boundary, then reports that archive coverage as complete instead of continuing unbounded historical fetches.
Its confidence metadata stays separate from coverage so page-limit truncation and exchange-history lookup failure remain explicit operator-visible evidence.
When startup recovery also finds unexplained balance or position movement against the prior persisted snapshots and local fill ledger, that result is treated as operator-state health evidence rather than as an order state.

## Notification Expectations

Telegram should report lifecycle outcomes, such as:
- accepted dry-run submission
- exchange rejection
- partial fill
- full fill
- cancel acknowledgement
- reconciliation required
- unexplained portfolio drift detected during reconciliation

Notifications are derived from lifecycle state, not treated as lifecycle state.
They should be persisted first into `operator_notifications`, then delivered through a separate `PENDING -> SENT/FAILED` path.
Notification delivery failure must never be treated as an order-lifecycle transition.
Retryable Telegram failures may keep the notification in `PENDING` with a scheduled `next_attempt_at`, but that retry state is still separate from order lifecycle.
Delivery workers may also claim a notification behind a lease token before transport, but that lease is still operator-notification state rather than order-lifecycle state.
Recent delivery outcomes are now also kept in `operator_notification_delivery_attempts` so operator observability can grow without turning Telegram delivery into lifecycle truth.
Derived `/alerts` queue metrics expose pending totals, active or expired leases, and abandoned-lease candidates without making Telegram delivery part of the order lifecycle.
