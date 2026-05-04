# AutoTrade_Upbit

`AutoTrade_Upbit` is a successor project to `PositionGuard`, but it is a different product.

This repository is building an Upbit-only BTC/ETH spot execution system with explicit order, fill, balance, risk, and reconciliation state. It is not a coaching bot and it does not accept manual cash or position input through Telegram.

The current default runtime path is SQLite-backed local persistence via `DATABASE_PATH` (default: `./var/autotrade-upbit.sqlite`).
Persisted `execution_state` in that database is the operator authority for pause, resume, kill-switch, and live-order gating decisions.

## What This Project Is

- a deterministic, inspectable execution stack for `KRW-BTC` and `KRW-ETH`
- an operator-visible modular monolith
- a system whose truth comes from Upbit state plus the local execution database
- a Telegram reporting and control surface
- a `DRY_RUN`-first implementation that can evolve toward live trading without replacing the core data model

## What This Project Is Not

- a record-only assistant
- a manual portfolio tracker
- a discretionary or LLM-driven trader
- a futures, margin, leverage, or derivatives system
- a multi-exchange router

## Reference Review

`C:\Users\D-\Documents\Codex_Project\PositionGuard` was reviewed as a read-only reference.

Safe reuse direction:
- public Upbit normalization patterns
- modular adapter boundaries
- deterministic pure logic utilities
- repository layering style

Explicitly rejected carryover:
- Telegram manual cash and position capture
- coaching outputs and review-needed decision contracts
- onboarding/readiness flows tied to manual state
- screenshot import and any inferred portfolio truth

## Current Stage

This first slice establishes:
- product and safety documents
- strict TypeScript project scaffolding
- execution-native core types
- initial SQLite migration plus draft SQLite statement shapes for durable order lifecycle tables
- interface-first modules for exchange, execution, reconciliation, risk, Telegram, and DB
- configuration that defaults local persistence to `DATABASE_PATH=./var/autotrade-upbit.sqlite`
- a `DRY_RUN` default runtime
- pure-logic tests around risk, configuration, and Telegram command parsing

Current remaining gaps:
- the strategy engine is a deterministic stub that returns `HOLD`
- live exchange submission is implemented as an adapter contract, but the app still wires a dry-run adapter by default
- `/sync` now persists read-only balance and position snapshots using Upbit public ticker prices when available, with explicit `avg_buy_price` fallback
- exchange-backed reconciliation now covers active orders, startup recovery sweep, paginated recent open/closed exchange-order history recovery into local `RECOVERY` records, checkpointed archival closed-order recovery with an explicit stop-before boundary, coverage status, and confidence classification, terminal-order fill/status backfill, balance/position drift detection against prior snapshots plus local fills, and per-run lookup budgeting
- execution pre-trade validation now checks Upbit `orders/chance` and `orders/test` before any order record is persisted for submission
- automatic Telegram reporting now persists durable `operator_notifications`, attempts best-effort Telegram delivery when explicitly enabled, and records `PENDING` / `SENT` / `FAILED`
- Telegram delivery now keeps durable retry metadata such as `attempt_count`, `last_attempt_at`, `next_attempt_at`, and `failure_class`
- Telegram delivery now claims due notifications with a durable lease and finalizes delivery transitions by matching the claimed `lease_token`
- Telegram delivery now also persists a separate `operator_notification_delivery_attempts` audit trail, and `/alerts` shows recent delivery attempt outcomes alongside the current notification rows
- `/alerts` now exposes delivery-worker queue metrics such as pending totals, due/scheduled counts, active/expired leases, abandoned-lease candidates, recent attempt outcome counts, and latest/oldest timestamps
- startup recovery can now mark persisted operator state `DEGRADED` when unresolved portfolio drift remains after exchange-backed bootstrap checks

Current risk-policy framing is budget-first rather than asset-count-first:
- total exposure cap is the main reserve control
- per-asset allocation caps act as concentration backstops
- future strategy sizing should be derived from total equity / exposure budgets, not from a simplistic “two assets means split in half” rule

## Runtime Shape

1. A deterministic strategy emits a `StrategyDecision`.
2. If Upbit read credentials are configured, startup runs an exchange-backed recovery sweep before showing the banner.
3. The execution layer derives an order intent plus idempotency key.
4. The risk layer applies explicit guards.
5. Exchange pre-trade validation checks `orders/chance` and `orders/test`.
6. The order is persisted before exchange submission is considered complete.
7. In the current default path, a dry-run adapter simulates acceptance without sending a live order.
8. The default local store is SQLite-backed persistence at `DATABASE_PATH`.
9. `execution_state` and `execution_state_transitions` provide the operator control ledger.
10. Telegram inspection currently includes `/status`, `/statehistory`, `/synchistory`, `/recovery`, `/alerts`, `/risks`, `/balances`, `/positions`, `/orders`, and `/sync` for operator visibility, with `/status` also summarizing the latest persisted reconciliation run, recent issue codes, checkpointed history-recovery progress, and persisted degraded metadata when present.
11. `/sync` connects to reconciliation so snapshot and reconciliation records are persisted, using read-only public ticker valuation when available.
12. Reconciliation records now carry source metadata such as `STARTUP_RECOVERY` and `OPERATOR_SYNC`, and use a per-run lookup budget to avoid unbounded private order reads.
13. Risk inspection reads persisted `risk_events`, and automatic reporting persists durable `operator_notifications`, then non-blockingly kicks best-effort Telegram delivery behind a separate gate.
14. Telegram delivery claims due `PENDING` notifications with a lease token, then only finalizes rows that still match that lease.
15. Each delivery attempt now also writes a durable `operator_notification_delivery_attempts` record so `/alerts` can show recent delivery outcomes separately from the summary row in `operator_notifications`.
16. Retryable Telegram delivery failures stay `PENDING` with a later `next_attempt_at`, while permanent failures become `FAILED`.
17. Reconciliation and Telegram inspection surfaces operate on persisted state.

## Folder Layout

- `src/domain/*`: core execution-native types
- `src/app/*`: configuration and bootstrap
- `src/modules/db/*`: repository contracts, SQLite-backed persistence, and in-memory test scaffolding
- `src/modules/exchange/*`: exchange adapter contracts and Upbit private auth/client code
- `src/modules/execution/*`: idempotency and execution service
- `src/modules/reconciliation/*`: reconciliation contracts and service
- `src/modules/risk/*`: pure guardrails
- `src/modules/strategy/*`: deterministic strategy contracts
- `src/modules/telegram/*`: operator command parsing and formatting
- `migrations/*`: SQLite-friendly schema
- `tests/*`: pure-logic and command-surface tests

## Safe Defaults

- `APP_EXECUTION_MODE` defaults to `DRY_RUN`
- `ENABLE_LIVE_ORDERS` defaults to disabled
- `GLOBAL_KILL_SWITCH` defaults to off, but can block execution immediately when enabled
- Telegram is treated as an operator interface only
- live order transmission requires both `APP_EXECUTION_MODE=LIVE` and `ENABLE_LIVE_ORDERS=true`

## Getting Started

Use Node.js `22.13.0` or newer so the built-in `node:sqlite` runtime module is available without extra flags.

1. Install dependencies with `npm install`.
2. Run `npm run typecheck`.
3. Run `npm run test`.
4. Start the scaffold with `npm run start`.

At startup the app prints the effective execution mode, live gate, configured `databasePath`, and supported Telegram operator commands.

## Configuration

Environment variables currently recognized:

- `APP_SERVICE_NAME`
- `APP_EXECUTION_MODE`
- `ENABLE_LIVE_ORDERS`
- `GLOBAL_KILL_SWITCH`
- `UPBIT_BASE_URL`
- `UPBIT_ACCESS_KEY`
- `UPBIT_SECRET_KEY`
- `DATABASE_PATH`
- `ENABLE_TELEGRAM_DELIVERY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OPERATOR_CHAT_ID`
- `TELEGRAM_DELIVERY_MAX_ATTEMPTS`
- `TELEGRAM_DELIVERY_BASE_BACKOFF_MS`
- `TELEGRAM_DELIVERY_MAX_BACKOFF_MS`
- `TELEGRAM_DELIVERY_LEASE_MS`
- `RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN`
- `RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET`
- `RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS`
- `RECONCILIATION_HISTORY_STOP_BEFORE_DAYS`
- `STALE_PRICE_THRESHOLD_MS`
- `MINIMUM_ORDER_VALUE_KRW`
- `MAX_ALLOCATION_BTC`
- `MAX_ALLOCATION_ETH`
- `TOTAL_EXPOSURE_CAP`

Telegram delivery stays disabled unless all three conditions are true:
- `ENABLE_TELEGRAM_DELIVERY=true`
- `TELEGRAM_BOT_TOKEN` is configured
- `TELEGRAM_OPERATOR_CHAT_ID` is configured

If any of those are missing, notifications remain durable in `operator_notifications` as `PENDING` and `/alerts` remains the inspection surface.
When Telegram delivery is enabled, due notifications are claimed behind a lease, retryable transport failures remain `PENDING` with a scheduled `next_attempt_at`, permanent errors become `FAILED`, and each outcome is appended to `operator_notification_delivery_attempts` for inspection.
`/alerts` also derives delivery-worker queue metrics from persisted rows, including active leases, expired leases, abandoned-lease candidates, and recent attempt outcome counts.

Exchange-backed startup recovery runs only when `UPBIT_ACCESS_KEY` and `UPBIT_SECRET_KEY` are configured. Without them, startup recovery is skipped and the app stays in local-inspection mode.
Order reconciliation also respects `RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN` so `/sync` and startup recovery do not burst unbounded `getOrder` reads.
Recent and archival exchange-history recovery also respect `RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET`, `RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS`, and `RECONCILIATION_HISTORY_STOP_BEFORE_DAYS` so recovery sweeps page through Upbit order history in bounded windows, checkpoint deeper archive progress per market, and report whether archive coverage is still `IN_PROGRESS` or `COMPLETE`.
History recovery summaries also separate coverage from confidence: `confidenceLevel` can be `HIGH`, `PARTIAL`, or `FAILED`, with reasons such as `ARCHIVE_COMPLETE`, `ARCHIVE_IN_PROGRESS`, `PAGE_LIMIT_REACHED`, or `LOOKUP_FAILED`.
If startup recovery finds unresolved portfolio drift against the prior persisted snapshots and local fill history, bootstrap can mark the persisted operator state `DEGRADED` with explicit `degraded_reason` / `degraded_at`.

## Immediate Next Steps

- extend exchange-history recovery confidence with richer exchange-side retention semantics beyond local page-limit and lookup-failure classification
- add durable delivery-worker run records if Telegram delivery becomes a long-running scheduled worker instead of best-effort kicks
