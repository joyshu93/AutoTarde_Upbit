# Order Lifecycle

## Goal

Define one explicit lifecycle that works for both `DRY_RUN` and future `LIVE` execution.

The system must never treat “strategy said buy” as equivalent to “order exists.” Orders need explicit lifecycle records.

A `DEFERRED_CONFIRMATION` strategy decision is persisted as `PENDING_CONFIRMATION` but does not create an order intent or `orders` row. A later matching `EXECUTED_AFTER_CONFIRMATION` decision must pass the full lifecycle independently.

Before an eligible strategy decision enters this lifecycle, stale-price age is measured from the exchange ticker timestamp used as its reference price to the local submission time. The explicit stale threshold applies to the absolute timestamp difference so materially future-dated exchange evidence is blocked without introducing a hidden clock-skew allowance.

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
6. immediately settle supported dry-run orders as `FILLED` with a durable synthetic fill and `ORDER_FILLED` event

The dry-run path must still use the real order tables so that the operational shape matches the future live path.
Dry-run settlement must never mutate exchange state and must remain visibly marked as simulated evidence.
If an older dry-run adapter artifact remains active or `RECONCILIATION_REQUIRED`, reconciliation must repair it locally instead of querying Upbit for its `dryrun_*` UUID. When price and volume evidence are available, the repair records a synthetic local fill and moves the order to `FILLED`; otherwise it moves the local dry-run artifact to `CANCELED` with explicit repair evidence.
Synthetic dry-run fills are lifecycle evidence only and must be excluded from exchange-backed portfolio drift explanation.
Exchange-backed fill windows used for portfolio drift explanation compare parsed instants rather than raw timestamp strings, because Upbit fill timestamps may include explicit timezone offsets.

## Live Path

The intended live path is:

1. create intent
2. reject an existing idempotency match
3. acquire the account-scoped execution lease before validation or persistence
4. risk approve and run Upbit order-chance and order-test validation
5. atomically persist `PERSISTED` plus `ORDER_PERSISTED`
6. transition the durable order to `SUBMITTING`
7. renew and verify lease ownership, re-read account-wide active orders, then make authoritative execution state the final awaited check before calling the tagged execution adapter exactly once with no intervening await; the `LIVE` adapter requires persisted `LIVE`/`ENABLED` both initially and finally, while the `DRY_RUN` adapter accepts any unchanged non-fully-live tuple, including `DRY_RUN`/`ENABLED` and `LIVE`/`DISABLED`
8. atomically store accepted, definitive rejection, or uncertain-submission evidence; every immediate `FILLED` result includes distinct submitted and terminal event ids plus fill evidence in the same transaction
9. reconcile until terminal state is consistent

`ACCOUNT_EXECUTION_LEASE_MS` is a positive explicit setting with a `30000` default. Safe pre-send exits and definitive terminal outcomes release the lease. Uncertain, active, and post-send persistence-failure outcomes retain it. A lease conflict creates no order row or exchange send, persists `ACCOUNT_EXECUTION_LEASE_BLOCKED`, and requires an automatic pause; pause, renewal, acquisition, or release ambiguity fails closed with fatal safety evidence.

The real Upbit order-create adapter distinguishes a clear exchange rejection from an outcome that needs recovery. Only a clear `4xx` creation rejection is definitive; timeouts, disconnects, redirects, `5xx` responses, malformed successful responses (including optional fields), mapping failures, and other dispatched-request failures remain uncertain. Typed submission failures retain only HTTP status, sanitized exchange code/name, and whether a response was received. They never retain request credentials, JWTs, access keys, secret keys, token-shaped/reflected metadata, or raw error responses. Private requests use manual redirect handling so a `3xx` response remains observable. A confirmed authenticated order lookup `404` remains an absent (`null`) lookup result.

`duplicate_identifier` is reconciliation-required rather than a simple rejection because identifier recovery must establish whether the matching exchange order is locally represented before any later send. The system never retries `createOrder` merely because the original response was lost.

Uncertain `SUBMITTING`, `RECONCILIATION_REQUIRED`, `FAILED`, and `REJECTED` recovery is lookup-only and persists every UUID-first/identifier-fallback observation using an injected clock. A first not-found remains uncertain; only the configured persisted not-found count and persisted elapsed-time bounds together can atomically compare-and-set terminal absence, its order event, and a fail-closed pause. Transient lookup failures never count as absence. Found recovery records the exchange snapshot but never resumes execution, clears pause/degraded/kill-switch state, or releases an uncertainty-retained lease. A recovered snapshot whose terminal projection fails is explicitly faulted and paused rather than reported as a plain recovery.

After terminal order and fill evidence is durable, the BTC candidate projector may process an eligible `STRATEGY` order once through its atomic candidate evidence/state-CAS/audit repository contract. A bounded terminal sweep, separate from exchange lookup budgeting, replays terminal rows in persisted fill execution-instant and stable-ID order so immediate terminal results and crash windows are recovered. Projection requires a valid persisted immutable deployment binding and PositionGuard decision, matching provenance, terminal `FILLED` or `CANCELED` status, nonzero aggregate fills, exact decimal quantities/values, and a genuinely confirmed per-fill KRW fee for every fill. Terminal no-fill cancellation persists a replay-safe no-op marker; legacy, allocated, invalid, missing, or conflicting evidence records a fault and pauses without any send or execution resumption.
The sweep treats a candidate fault as disposed only when the immutable event has a matching automatic fault-pause transition. On restart, an event-written/pause-missing standard or recovered-projection fault retains its original event timestamp while the atomic pause operation records a transition no earlier than either current execution state or the explicit repair attempt. A no-fill marker with no fills remains a no-op, but later durable fills make the row eligible for projection until exact evidence or an explicit fault is durable. Malformed deployment activation persistence remains eligible for this fail-closed repair path. Separately, a `FAILED` order already finalized with `ORDER_SUBMISSION_ABSENCE_CONFIRMED` is excluded before reconciliation lookup candidates and budgets are built.

The live send path is selected only when mode, live gate, and credentials are explicitly configured.
The adapter carries the live/dry discriminant; it is not paired with an independent caller-supplied label. Persisted `order.executionMode`, submission and terminal event sources, simulated-fill creation, and the submit outcome follow this discriminant. A dry adapter cannot be reported as a real exchange submission, and a live adapter cannot synthesize a dry-run terminal fill.
Upbit `price` market buys may return exchange state `cancel` after a successful fill when only dust-sized KRW or fee lock remains. In that specific filled `bid`/`price` case, the local lifecycle records the order as `FILLED` and preserves the raw exchange `cancel` payload plus fill and fee evidence. Ordinary canceled orders without this filled market-buy pattern remain `CANCELED`.
If an older local row already stored that filled market-buy dust-cancel pattern as `CANCELED`, terminal reconciliation must recheck the order and repair it to local `FILLED` rather than leaving misleading operator evidence.

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
- an operator runs `/run BTC|ETH` and the resulting strategy decision creates or updates an order lifecycle record
- the disabled-by-default scheduler runs a deterministic cycle and the resulting strategy decision creates or updates an order lifecycle record

The current scaffold now uses both process startup recovery and operator-triggered `/sync` as explicit reconciliation entry points.
If scheduler startup is requested in `LIVE` mode, an automatic preflight runs before scheduler timers are installed. It requires fresh persisted account-health evidence, including balance snapshot, position snapshot, and latest reconciliation data, using the shortest configured scheduler interval as the maximum acceptable age. A blocked startup is scheduler runtime state, not an order lifecycle transition; no order is created unless a later deterministic runner cycle passes preflight, risk, validation, and persistence.
Each `LIVE` scheduled tick first runs an exchange-backed account-health refresh that may persist fresh snapshots and reconciliation evidence with source `SCHEDULER_PREFLIGHT`. It then re-runs that persisted-health preflight before invoking the strategy runner. A blocked tick is recorded as scheduler audit state and operator notification only; it must not create a strategy decision, order intent, cancellation, or order lifecycle mutation by itself.
If multiple scheduled market timers become due together, the scheduler queues those market cycles for the exchange account before invoking the strategy runner, so a healthy second market does not become a skipped lifecycle-adjacent audit record solely due to the account-scoped runner lock.
In `LIVE`, if a scheduled market cycle submits an order, remaining market cycles from that same one-second scheduler batch are persisted as `SKIPPED` and deferred to the next interval. This is scheduler audit state, not an order lifecycle transition, and it prevents another strategy decision from being created before account health is refreshed after the exchange mutation.
Each manual `LIVE` `/run BTC|ETH` also runs persisted-health preflight before invoking the strategy runner. A blocked manual run is an operator response only; it must not create a strategy decision, order intent, cancellation, or reconciliation mutation by itself.
The locale-aware `/run BTC|ETH` response is presentation over that single runner result. It may explain the action, submission outcome, and known local lifecycle status, but submission acceptance is not fill evidence and every canonical lifecycle value plus exact controller detail remains available.
`/preview BTC|ETH` may compute a strategy decision and order-intent preview, but because it does not persist the decision or create an order intent, it is not a reconciliation trigger.
If the strategy is flat for an asset, bearish invalidation evidence is represented as no-order `HOLD` rather than an `EXIT` or `REDUCE` lifecycle trigger.
Defensive PositionGuard `REDUCE` decisions for open positions become normal order-intent candidates only after the strategy runner emits a profit-protective, above-minimum reduce intent; the regime evidence itself is not a reconciliation, scheduler, or cancellation trigger.

Restart recovery currently prioritizes persisted non-terminal orders first, then limited terminal backfill candidates, and respects a per-run exchange lookup budget.
Exchange-history recovery advances per-market archive checkpoints only until the configured stop-before boundary, then reports that archive coverage as complete instead of continuing unbounded historical fetches.
Its confidence metadata stays separate from coverage so page-limit truncation, assumed exchange-history retention boundaries, and exchange-history lookup failure remain explicit operator-visible evidence.
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
- one-shot strategy runner outcomes from `/run BTC|ETH`, including HOLD/no-order decisions and risk-blocked submissions
- non-mutating strategy previews from `/preview BTC|ETH`, including computed action and order intent when present
- scheduled strategy runner outcomes when `STRATEGY_SCHEDULER_ENABLED=true`
- same-batch scheduled market deferrals after a live scheduled order submission
- live scheduler startup preflight blocks before automatic timers are installed
- scheduler-triggered failures, overlapping-run skips, and scheduler-triggered order submission/rejection outcomes
- static operator command help through `/help`
- non-secret runtime configuration inspection through `/config`
- read-only operator readiness inspection through `/readiness`, including bounded local persistence health
- single-order lifecycle detail through `/order <order-id|identifier>`, including persisted order events and fills
- runtime scheduler status plus persisted scheduler run history through `/scheduler`
- bounded `/orders` summaries with `/order <order-id|identifier>` for details

Notifications are derived from lifecycle state, not treated as lifecycle state.
`/help` is static command-contract inspection and must not create an order-lifecycle transition or trigger sync, strategy runs, scheduler ticks, exchange reads, or order mutation.
`/config` is runtime configuration inspection and must not create an order-lifecycle transition or expose raw secrets. It may show ignored deprecated environment variable names so stale local scripts do not fail silently.
`/statehistory`, `/synchistory`, and `/recovery` are locale-aware persisted-evidence inspection only. Their readable summaries and KST times do not create, retry, reconcile, cancel, or otherwise mutate an order lifecycle.
`/readiness` is operator readiness inspection and may summarize active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count from local persistence, but it must not create an order-lifecycle transition, call Upbit, poll Telegram, mutate offsets, trigger sync, run strategies, tick schedulers, submit orders, cancel orders, or deliver notifications.
`/preview BTC|ETH` is strategy inspection over live public market data and local persisted context; it must not create an order-lifecycle transition, persist a strategy decision, submit an order, or run reconciliation.
`/order <order-id|identifier>` is a lifecycle inspection view over persisted `orders`, `order_events`, and `fills`; it does not create, cancel, retry, or reconcile orders by itself.
Scheduler runtime status and scheduler run history are likewise operational audit state, not order lifecycle truth; orders and fills remain the durable lifecycle records.
Scheduler startup, scheduled account refresh, and per-run preflight state is also operational control state, not order lifecycle truth. It may block timers or scheduled ticks because health evidence is missing or stale, be shown in `/status` or `/readiness`, and persist scheduler operator notifications, but it must not create, cancel, retry, or reconcile an order by itself.
Manual live `/run` preflight state is likewise operational control state, not order lifecycle truth; if it blocks, no strategy decision or order lifecycle record is created.
Inbound Telegram update offsets are durable transport progress state, not order lifecycle truth.
Typed Telegram callback acknowledgements, bounded read-only repository views, pagination, and originating-message edits are transport and presentation behavior only. They do not create an order intent or lifecycle transition, and the callback parser cannot represent execution or operator-state mutation commands. Order callback detail reads persisted order, event, and fill evidence only after a valid sorted index resolves; expired indexes do not read event or fill history.
The `/inbound` command may inspect that transport progress, but it must not become an order-lifecycle transition.
The `smoke:telegram:inbound` script may route at most one fetched operator update through the command router, but it remains transport validation and must not become an order-lifecycle transition by itself.
The `smoke:dryrun:readiness` script reads local runtime configuration and persisted readiness evidence only; it must not run `/sync`, run strategies, start background workers, deliver notifications, call Upbit, or create order-lifecycle records.
The `smoke:dryrun:sync` script may persist exchange-backed DRY_RUN balance snapshots, position snapshots, reconciliation runs, drift risk evidence, and recovery records through `/sync`, but it must not run strategy, start background workers, deliver notifications, transmit orders, or create a new order intent.
The `smoke:dryrun:operator` script may persist local DRY_RUN reconciliation snapshots and strategy decisions while rehearsing `/sync` and `/run BTC|ETH` with fixture market data, but it clears Upbit private read credentials and disables live-send, scheduler, Telegram delivery, and inbound polling for the process. Its fixture path expects `HOLD` decisions and no order lifecycle delta.
The local DRY_RUN scheduler launcher can create scheduler-run audit records, strategy decisions, simulated DRY_RUN order lifecycle records, and scheduler notifications after the runtime starts. It must first pass exchange-backed DRY_RUN sync/readiness checks, keep live orders disabled, and keep any resulting fills visibly simulated rather than exchange-backed truth.
The `smoke:dryrun:completion` script reads persisted snapshots, reconciliation, risk, notification, and scheduler-run audit records to decide whether the DRY_RUN automatic scheduler rehearsal is complete. It must not run `/sync`, run strategy, start background workers, deliver notifications, call Upbit, create order intents, or create order lifecycle records.
They should be persisted first into `operator_notifications`, then delivered through a separate `PENDING -> SENT/FAILED` path.
Notification delivery failure must never be treated as an order-lifecycle transition.
Retryable Telegram failures may keep the notification in `PENDING` with a scheduled `next_attempt_at`, but that retry state is still separate from order lifecycle.
Delivery workers may also claim a notification behind a lease token before transport, but that lease is still operator-notification state rather than order-lifecycle state.
Recent delivery outcomes are now also kept in `operator_notification_delivery_attempts` so operator observability can grow without turning Telegram delivery into lifecycle truth.
Delivery-worker executions are now also kept in `operator_notification_delivery_runs` so skipped, completed, and failed delivery kicks are inspectable without making Telegram delivery part of the order lifecycle.
If a notification is persisted and kicked while another inline delivery worker is already running, the follow-up delivery pass is still operator-notification state and does not create or alter any order lifecycle transition.
Derived `/alerts` queue metrics expose pending totals, active or expired leases, abandoned-lease candidates, and recent worker-run summaries without making Telegram delivery part of the order lifecycle.
