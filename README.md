# AutoTrade_Upbit

`AutoTrade_Upbit` is a successor project to `PositionGuard`, but it is a different product.

This repository is building an Upbit-only BTC/ETH spot execution system with explicit order, fill, balance, risk, and reconciliation state. It is not a coaching bot and it does not accept manual cash or position input through Telegram.

For a consolidated Korean development list and operator guide, see `PROJECT_GUIDE.md`.

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
- runtime startup still does not auto-run trading cycles by default, but Telegram `/preview BTC|ETH`, `/run BTC|ETH`, and the disabled-by-default scheduler can trigger the first `PositionGuard_PaperTrade` runner surface. `/preview` computes the decision and order intent without persistence or order submission; `/run` persists the strategy decision and routes eligible decisions through the configured execution path.
- live exchange submission is implemented as an adapter contract, but the app still wires a dry-run adapter by default
- `/sync` now persists read-only balance and position snapshots using Upbit public ticker prices when available, with explicit `avg_buy_price` fallback
- exchange-backed reconciliation now covers active orders, startup recovery sweep, paginated recent open/closed exchange-order history recovery into local `RECOVERY` records, checkpointed archival closed-order recovery with an explicit stop-before boundary, coverage status, confidence classification, and explicit exchange-history retention-assumption metadata, terminal-order fill/status backfill, balance/position drift detection against prior snapshots plus local fills, and per-run lookup budgeting
- execution pre-trade validation now checks Upbit `orders/chance` and `orders/test` before any order record is persisted for submission
- automatic Telegram reporting now persists durable `operator_notifications`, attempts best-effort Telegram delivery when explicitly enabled, and records `PENDING` / `SENT` / `FAILED`
- Telegram delivery now keeps durable retry metadata such as `attempt_count`, `last_attempt_at`, `next_attempt_at`, and `failure_class`
- Telegram delivery now claims due notifications with a durable lease and finalizes delivery transitions by matching the claimed `lease_token`
- Telegram delivery now also persists a separate `operator_notification_delivery_attempts` audit trail, and `/alerts` shows recent delivery attempt outcomes alongside the current notification rows
- Telegram delivery now persists `operator_notification_delivery_runs` for each inline worker execution, including skipped/not-configured runs and failed worker runs
- Telegram delivery now coalesces kicks received while an inline worker is already running into a follow-up pass, so notifications created during an in-flight pass are delivered without waiting for an unrelated future alert
- `/alerts` now exposes delivery-worker queue metrics such as pending totals, due/scheduled counts, active/expired leases, abandoned-lease candidates, recent worker-run summaries, recent attempt outcome counts, and latest/oldest timestamps
- Telegram inbound polling is now available behind `ENABLE_TELEGRAM_INBOUND_POLLING=false` by default, uses the existing command router, only accepts messages from `TELEGRAM_OPERATOR_CHAT_ID`, persists `getUpdates` offset progress in `telegram_inbound_offsets`, exposes `/inbound` inspection, and splits long command replies into bounded Telegram messages
- `npm run smoke:dryrun:readiness` now provides a non-mutating local DRY_RUN preflight over runtime config and persisted readiness evidence before the local runtime starts
- `npm run smoke:dryrun:sync` now provides an exchange-backed DRY_RUN `/sync` rehearsal that persists snapshots/reconciliation evidence but does not run strategy, Telegram transport, scheduler, or order transmission
- `npm run smoke:dryrun:operator` now provides an offline, fixture-backed DRY_RUN operator rehearsal for `/config`, `/status`, `/readiness`, `/sync`, `/balances`, `/positions`, `/run BTC|ETH`, `/orders`, `/scheduler`, and `/alerts`
- `scripts/start-company-dryrun-scheduler.example.ps1` now provides a local DRY_RUN scheduler launcher that keeps live orders disabled, runs DRY_RUN sync/readiness smokes, then starts the runtime with scheduler `RUN_ON_START=true`
- `npm run smoke:dryrun:completion` now provides a persisted-evidence gate for marking the DRY_RUN automatic scheduler rehearsal complete without running sync, strategy, Telegram transport, scheduler timers, Upbit calls, or order transmission
- startup recovery can now mark persisted operator state `DEGRADED` when unresolved portfolio drift remains after exchange-backed bootstrap checks
- scheduler-triggered strategy cycles now persist `strategy_scheduler_runs` so scheduled run starts, completions, failures, and skips remain inspectable after process restart, including through `/scheduler`
- `/scheduler` now shows current in-memory scheduler status and startup preflight summary before the persisted scheduler-run history
- scheduler-triggered failures, overlapping-run skips, and scheduler-triggered order submission/rejection outcomes now also persist operator notifications so automatic operation has an alert trail
- `/order <order-id|identifier>` now exposes one persisted order, order events, and fills for read-only lifecycle investigation
- reconciliation now repairs older local dry-run artifacts without querying Upbit for `dryrun_*` UUIDs
- portfolio drift detection ignores simulated `DRY_RUN` fills because those fills do not mutate Upbit balances
- portfolio drift detection compares fill and snapshot timestamps as parsed instants, so Upbit timezone-offset fill timestamps are not reused outside their actual snapshot window
- `/orders` now returns a bounded recent-order summary and points operators to `/order <id|identifier>` for details
- `/readiness` treats exchange-history recovery progress as a warning instead of blocking when no portfolio drift or unresolved order recovery remains
- Telegram `/start` is handled as a `/help` alias
- scheduler startup now records an automatic `strategySchedulerStartupPreflight`; in `LIVE` mode it blocks scheduler timers unless live gate, live adapter wiring, execution state, fresh exchange-backed snapshots, fresh reconciliation health, and active-order state are safe
- live scheduler startup blocks now persist an operator notification before startup can close local persistence
- live scheduler ticks now first refresh exchange-backed account-health evidence with reconciliation source `SCHEDULER_PREFLIGHT`, then re-run the persisted-health preflight before the strategy runner is invoked, so stale or unsafe account-health evidence blocks the scheduled cycle before any strategy decision or order intent is created
- simultaneous scheduler timer ticks are queued across BTC/ETH for the exchange account, so one market is not skipped only because the other market is already inside the account-scoped runner
- in `LIVE`, if one scheduled market tick submits an order, remaining market ticks from that same scheduler batch are persisted as `SKIPPED` and deferred to the next interval
- manual `LIVE` `/run BTC|ETH` now also runs persisted-health preflight before the strategy runner is invoked, even when the scheduler is disabled
- execution minimum-value checks now derive market-sell notional from strategy reference price and requested quantity when the Upbit order shape carries volume but no order price
- exposure cap projection now treats `ask` orders as risk-reducing instead of adding sell notional to current exposure
- the runtime can now derive `LIVE_ADAPTER` send wiring only when mode, live gate, and Upbit credentials are all explicitly configured; otherwise it remains on `DRY_RUN_ADAPTER`
- PositionGuard REDUCE decisions now require independent weakening evidence when `weakeningStage` is still `NONE`; a losing range position with only borderline bearish momentum remains `HOLD` instead of creating a sell intent
- PositionGuard now treats bearish invalidation evidence while flat as a no-order `HOLD`, so backtests and live previews do not emit no-position exit orders
- PositionGuard now applies profit-protective staged defensive reductions for open positions when weak-downtrend, breakdown-risk, or range-deterioration evidence appears, suppresses below-minimum reduce intents, and keeps immediate invalidation exits and no-position HOLD behavior intact.
- PositionGuard now has a pure offline backtest/replay harness. It can fetch paginated Upbit public 1h/4h/1d candles sequentially for a research run, retry bounded Upbit public 429 responses, convert completed historical candle arrays into no-lookahead replay frames, reuse the core decision engine, apply configurable fee/slippage/minimum-trade assumptions, and report cash/buy-and-hold benchmarks, monthly returns, regime return contribution, skip-reason counts, trade diagnostics, action counts, regime counts, turnover, fee drag, drawdown, final equity, time-in-market, skipped order intents, and source-window warnings without touching DB, Telegram, Upbit private endpoints, order lifecycle records, or live-send configuration.

Current risk-policy framing is budget-first rather than asset-count-first:
- total exposure cap is the main reserve control
- per-asset allocation caps act as concentration backstops
- risk-reducing `ask` orders are not blocked solely because current exposure is already above cap
- future strategy sizing should be derived from total equity / exposure budgets, not from a simplistic “two assets means split in half” rule

## Runtime Shape

1. A deterministic strategy emits a `StrategyDecision`.
2. If Upbit read credentials are configured, startup runs an exchange-backed recovery sweep before showing the banner.
3. The execution layer derives an order intent plus idempotency key.
4. The risk layer applies explicit guards.
5. Exchange pre-trade validation checks `orders/chance` and `orders/test`.
6. The order is persisted before exchange submission is considered complete.
7. In the current default path, a dry-run adapter simulates acceptance without sending a live order, then supported dry-run orders are settled locally as simulated `FILLED` orders with durable synthetic fills.
8. If an older local dry-run artifact is later encountered by reconciliation, it is repaired locally instead of being queried against Upbit.
9. The default local store is SQLite-backed persistence at `DATABASE_PATH`.
10. `execution_state` and `execution_state_transitions` provide the operator control ledger.
11. Telegram inspection currently includes `/help`, `/config`, `/readiness`, `/status`, `/statehistory`, `/synchistory`, `/recovery`, `/alerts`, `/risks`, `/balances`, `/positions`, `/orders`, `/order <order-id|identifier>`, `/scheduler`, `/inbound`, and `/sync` for operator visibility, with `/status` also summarizing the latest persisted reconciliation run, recent issue codes, checkpointed history-recovery progress, and persisted degraded metadata when present.
12. `/sync` connects to reconciliation so snapshot and reconciliation records are persisted, using read-only public ticker valuation when available.
13. `/preview BTC|ETH` requests one non-mutating deterministic PositionGuard preview for a supported asset and returns the computed decision, action, reference price, and order intent when present.
14. `/run BTC|ETH` requests one deterministic PositionGuard runner cycle for a supported asset and returns the persisted decision, action, and any order lifecycle result.
15. When `STRATEGY_SCHEDULER_ENABLED=true`, the scheduler uses the same safe runner/controller path as `/run BTC|ETH`; it is disabled by default.
16. In `LIVE` mode, scheduler startup runs an automatic preflight before any timer is installed; this replaces a mandatory manual-first-run ritual with inspectable startup safety checks and rejects stale persisted account-health evidence.
17. In `LIVE` mode, each scheduled tick first runs exchange-backed account-health refresh with reconciliation source `SCHEDULER_PREFLIGHT`, then re-runs persisted-health preflight before invoking the strategy runner; a refresh or preflight block is persisted as scheduler audit state without creating a strategy decision or order intent.
18. Simultaneous configured market ticks are queued for the exchange account before strategy runner invocation so BTC/ETH timers do not collide with the account-scoped runner lock.
19. In `LIVE`, if one scheduled tick submits an order, remaining ticks from the same scheduler batch are persisted as `SKIPPED` and deferred to the next interval.
20. Manual `/run BTC|ETH` in `LIVE` re-runs persisted-health preflight before invoking the strategy runner and returns a block as an operator response without creating a strategy decision or order intent.
21. Scheduler-triggered cycles are persisted in `strategy_scheduler_runs` before runner execution and updated on completion, failure, or skip; `/scheduler` exposes current runtime scheduler status plus a fuller read-only history than the compact `/status` summary.
22. Reconciliation records now carry source metadata such as `STARTUP_RECOVERY`, `OPERATOR_SYNC`, and `SCHEDULER_PREFLIGHT`, compare fill windows by parsed instants, and use a per-run lookup budget to avoid unbounded private order reads.
23. Risk inspection reads persisted `risk_events`, and automatic reporting persists durable `operator_notifications`, then non-blockingly kicks best-effort Telegram delivery behind a separate gate.
24. Telegram delivery claims due `PENDING` notifications with a lease token, then only finalizes rows that still match that lease.
25. Each delivery attempt now also writes a durable `operator_notification_delivery_attempts` record so `/alerts` can show recent delivery outcomes separately from the summary row in `operator_notifications`.
26. Each delivery worker kick also writes a durable `operator_notification_delivery_runs` record so operators can inspect skipped, completed, and failed delivery-worker executions.
27. Delivery kicks received while an inline worker is already in flight are coalesced into a follow-up delivery pass.
28. Retryable Telegram delivery failures stay `PENDING` with a later `next_attempt_at`, while permanent failures become `FAILED`.
29. Telegram inbound polling is disabled by default and, when enabled, only routes messages from the configured operator chat through the existing command router.
30. Telegram inbound offset progress is persisted in `telegram_inbound_offsets` before routing each update, scoped by exchange account and non-secret bot-token fingerprint.
31. Reconciliation and Telegram inspection surfaces operate on persisted state.
32. When scheduler or inbound polling starts background timers, runtime signal handlers stop polling, stop the scheduler, and close SQLite persistence on `SIGINT` / `SIGTERM`; when no background runtime starts, startup closes persistence after printing the banner.

`/help` is static command-contract inspection. It does not read exchange state, query repositories, trigger `/sync`, run strategy cycles, tick the scheduler, mutate orders, or enable live order transmission.
`/config` is non-secret runtime configuration inspection. It shows configured/not-configured booleans for credentials and Telegram identifiers instead of raw secret values, and it lists ignored deprecated environment variable names when stale local scripts still set them.
`/readiness` is read-only operator readiness inspection. It summarizes runtime config, persisted execution state, worker status, latest snapshots, latest reconciliation, and bounded local persistence health: active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count. It does this without active Upbit or Telegram probes, without triggering sync, strategy, or scheduler work, and without mutating offsets, orders, or notification delivery state.
In intentional `LIVE` operation, `/readiness` reports the enabled live send path as a warning so operators remember that `/run` is real-order capable, while true health blockers still produce `BLOCK`. When the `LIVE` scheduler is enabled, `/readiness` also warns if the latest balance snapshot, position snapshot, or reconciliation run is older than the shortest configured scheduler interval.
`/preview BTC|ETH` computes a deterministic strategy decision and order intent without persisting the decision, creating an order, running reconciliation, or submitting to Upbit.
`/run BTC|ETH` persists the deterministic decision and routes eligible order intents through the configured execution path; in `LIVE`, it first runs persisted-health preflight even when the scheduler is disabled.

## Folder Layout

- `src/domain/*`: core execution-native types
- `src/app/*`: configuration and bootstrap
- `src/modules/db/*`: repository contracts, SQLite-backed persistence, and in-memory test scaffolding
- `src/modules/exchange/*`: exchange adapter contracts and Upbit private auth/client code
- `src/modules/execution/*`: idempotency and execution service
- `src/modules/reconciliation/*`: reconciliation contracts and service
- `src/modules/risk/*`: pure guardrails
- `src/modules/strategy/*`: deterministic strategy contracts, PositionGuard analysis, runner, offline replay frame builder, replay harness, offline replay report formatter, and public-candle research backtest runner
- `src/modules/telegram/*`: operator command parsing and formatting
- `migrations/*`: SQLite-friendly schema
- `tests/*`: pure-logic and command-surface tests

## Safe Defaults

- `APP_EXECUTION_MODE` defaults to `DRY_RUN`
- `ENABLE_LIVE_ORDERS` defaults to disabled
- `GLOBAL_KILL_SWITCH` defaults to off, but can block execution immediately when enabled
- Telegram is treated as an operator interface only
- live order transmission requires `APP_EXECUTION_MODE=LIVE`, `ENABLE_LIVE_ORDERS=true`, and configured Upbit credentials

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
- `STRATEGY_SCHEDULER_ENABLED`
- `STRATEGY_SCHEDULER_RUN_ON_START`
- `STRATEGY_SCHEDULER_BTC_INTERVAL_MS`
- `STRATEGY_SCHEDULER_ETH_INTERVAL_MS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OPERATOR_CHAT_ID`
- `TELEGRAM_DELIVERY_MAX_ATTEMPTS`
- `TELEGRAM_DELIVERY_BASE_BACKOFF_MS`
- `TELEGRAM_DELIVERY_MAX_BACKOFF_MS`
- `TELEGRAM_DELIVERY_LEASE_MS`
- `ENABLE_TELEGRAM_INBOUND_POLLING`
- `TELEGRAM_INBOUND_POLL_INTERVAL_MS`
- `TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS`
- `TELEGRAM_INBOUND_POLL_LIMIT`
- `RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN`
- `RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET`
- `RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS`
- `RECONCILIATION_HISTORY_STOP_BEFORE_DAYS`
- `RECONCILIATION_HISTORY_RETENTION_ASSUMPTION_DAYS`
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
Each delivery kick is also appended to `operator_notification_delivery_runs` with worker name, status, counts, skipped reason, and error metadata.
If a delivery kick arrives while the inline delivery worker is already in flight, the worker runs a follow-up pass after the current pass so newly persisted due notifications are not stranded.
`/alerts` also derives delivery-worker queue metrics from persisted rows, including active leases, expired leases, abandoned-lease candidates, recent delivery-run summaries, and recent attempt outcome counts.

Telegram inbound polling stays disabled unless all three conditions are true:
- `ENABLE_TELEGRAM_INBOUND_POLLING=true`
- `TELEGRAM_BOT_TOKEN` is configured
- `TELEGRAM_OPERATOR_CHAT_ID` is configured

Inbound polling is separate from `ENABLE_TELEGRAM_DELIVERY`: delivery controls outbound queued notifications, while inbound polling controls operator command receiving.
Inbound polling persists update offsets before routing each update to avoid replaying the same operator command indefinitely after process restart. Reply or route failures are explicit in the polling status; they do not mutate execution, reconciliation, order, balance, or position truth.

For a bounded real-bot smoke test, use:

```powershell
$env:TELEGRAM_BOT_TOKEN = "<bot-token>"
$env:TELEGRAM_OPERATOR_CHAT_ID = "<operator-chat-id>"
$env:DATABASE_PATH = "./var/telegram-inbound-smoke.sqlite"
npm run smoke:telegram:inbound
```

The smoke script forcibly sets `APP_EXECUTION_MODE=DRY_RUN`, `ENABLE_LIVE_ORDERS=false`, disables the strategy scheduler, enables inbound polling, sets `TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS=0`, and sets `TELEGRAM_INBOUND_POLL_LIMIT=1`. It calls `pollOnce()` only and never starts the long-running inbound loop. If Telegram credentials are missing, the script reports `SKIPPED` instead of polling.

Exchange-backed startup recovery runs only when `UPBIT_ACCESS_KEY` and `UPBIT_SECRET_KEY` are configured. Without them, startup recovery is skipped and the app stays in local-inspection mode.
Order reconciliation also respects `RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN` so `/sync` and startup recovery do not burst unbounded `getOrder` reads.
Recent and archival exchange-history recovery also respect `RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET`, `RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS`, `RECONCILIATION_HISTORY_STOP_BEFORE_DAYS`, and `RECONCILIATION_HISTORY_RETENTION_ASSUMPTION_DAYS` so recovery sweeps page through Upbit order history in bounded windows, checkpoint deeper archive progress per market, and report whether archive coverage is still `IN_PROGRESS` or `COMPLETE`.
`RECONCILIATION_HISTORY_RETENTION_ASSUMPTION_DAYS` is an explicit operator assumption about how far back exchange history is expected to be reliably inspectable; it does not stop scanning by itself, but if the configured recovery range crosses that boundary, confidence becomes `PARTIAL` with reason `BEYOND_ASSUMED_RETENTION`.
History recovery summaries also separate coverage from confidence: `confidenceLevel` can be `HIGH`, `PARTIAL`, or `FAILED`, with reasons such as `ARCHIVE_COMPLETE`, `ARCHIVE_IN_PROGRESS`, `PAGE_LIMIT_REACHED`, `BEYOND_ASSUMED_RETENTION`, or `LOOKUP_FAILED`.
If startup recovery finds unresolved portfolio drift against the prior persisted snapshots and local fill history, bootstrap can mark the persisted operator state `DEGRADED` with explicit `degraded_reason` / `degraded_at`. Fill history is matched to snapshot windows by parsed instants rather than raw timestamp string ordering.

The strategy scheduler is disabled unless `STRATEGY_SCHEDULER_ENABLED=true`.
When enabled, `STRATEGY_SCHEDULER_BTC_INTERVAL_MS` and `STRATEGY_SCHEDULER_ETH_INTERVAL_MS` control the BTC/ETH cadence, and `STRATEGY_SCHEDULER_RUN_ON_START=true` requests an immediate first tick after startup recovery policy has completed.
When `RUN_ON_START=true`, configured markets are run sequentially before their regular interval timers are scheduled, so BTC and ETH do not collide with the account-scoped strategy runner lock at startup.
Regular interval timers are also queued across configured markets when they become due together, so simultaneous BTC/ETH ticks are processed one after the other instead of marking the second market `ALREADY_RUNNING`.
In `LIVE`, if a queued scheduled tick submits an order, later ticks from the same scheduler batch are recorded as `SKIPPED` and wait for their next configured interval.
The scheduler still uses the same runner/controller path as `/run BTC|ETH`, so it does not enable live order transmission by itself.
If the scheduler is enabled while `APP_EXECUTION_MODE=LIVE`, startup first runs an automatic scheduler preflight. It blocks timer installation unless the live gate is enabled, the execution service is wired to the live adapter, operator state is `RUNNING`, Upbit read credentials and fresh persisted snapshots exist, no active local orders require visibility, and the latest reconciliation is fresh and has no blocking issue codes. Freshness uses the shortest configured scheduler interval, so with the default one-hour BTC/ETH intervals a snapshot or reconciliation older than one hour blocks automatic scheduler startup. Non-blocking exchange-history recovery evidence remains a warning.
If that live scheduler startup preflight blocks timer installation, the runtime persists a `SCHEDULER_STARTUP_BLOCKED` operator notification with the preflight detail and failed checks before local persistence can be closed.
Every later `LIVE` scheduled tick first runs an exchange-backed account-health refresh that persists current balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`. The tick then runs the same persisted-health preflight before the strategy runner is invoked. If refresh fails or account-health evidence remains stale or unsafe, the tick is recorded as a failed `strategy_scheduler_runs` row and operator notification, and no strategy decision or order intent is created.
When either scheduler or Telegram inbound polling is running, use normal process signals such as `Ctrl+C` / `SIGINT` or `SIGTERM` to stop the process. Shutdown is explicit: inbound polling is stopped, scheduler timers are cleared, and SQLite persistence is closed before the process exits.

## Local DRY_RUN Script

Before connecting a real Telegram bot or Upbit read credentials, run the fixture-backed offline operator rehearsal:

```powershell
npm run smoke:dryrun:operator
```

By default this uses `DATABASE_PATH=./var/dryrun-operator-smoke.sqlite` when no `DATABASE_PATH` is already set. The smoke forcibly sets `APP_EXECUTION_MODE=DRY_RUN`, `ENABLE_LIVE_ORDERS=false`, disables Telegram delivery and inbound polling, disables the strategy scheduler, clears Upbit private read credentials for the process, and uses deterministic fixture public market data. It routes `/sync` and `/run BTC|ETH`, so it may write local DRY_RUN snapshots and strategy decisions, but it must not call Upbit private endpoints, poll Telegram, start scheduler timers, or transmit live orders.

After filling in the local DRY_RUN script credentials, run the non-mutating readiness preflight against the intended local DB:

```powershell
npm run smoke:dryrun:readiness
```

For repeated checks with the same DRY_RUN environment, copy `scripts/smoke-dryrun-readiness.example.ps1` to `scripts/smoke-dryrun-readiness.local.ps1`, fill in secrets, and run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke-dryrun-readiness.local.ps1
```

This smoke forces `APP_EXECUTION_MODE=DRY_RUN`, `ENABLE_LIVE_ORDERS=false`, `STRATEGY_SCHEDULER_ENABLED=false`, and `STRATEGY_SCHEDULER_RUN_ON_START=false`. It reads local runtime configuration, persisted execution state, latest snapshots, latest reconciliation, active orders, recent risk blocks, and pending notifications. It does not run `/sync`, run strategy, start the scheduler, poll Telegram, call Upbit, deliver notifications, or send orders. A `WARN` is expected on a fresh DB before `/sync`; a `BLOCK` must be resolved before continuing.

After readiness is clean enough to proceed and Upbit read credentials are configured, run one exchange-backed DRY_RUN sync rehearsal:

```powershell
npm run smoke:dryrun:sync
```

For repeated checks with the same DRY_RUN environment, copy `scripts/smoke-dryrun-sync.example.ps1` to `scripts/smoke-dryrun-sync.local.ps1`, fill in the Upbit read credentials, and run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke-dryrun-sync.local.ps1
```

This smoke forces `APP_EXECUTION_MODE=DRY_RUN`, `ENABLE_LIVE_ORDERS=false`, disables Telegram delivery and inbound polling, disables the scheduler, requires `UPBIT_ACCESS_KEY` and `UPBIT_SECRET_KEY`, routes `/sync`, then inspects `/balances`, `/positions`, `/readiness`, and `/synchistory`. It may persist balance snapshots, position snapshots, reconciliation runs, drift risk evidence, and recovery records, but it does not run strategy or transmit orders.

For repeated local operation, copy `scripts/start-company-dryrun.example.ps1` to `scripts/start-company-dryrun.local.ps1`, fill in the Upbit and Telegram secrets in the local copy, then run:

```powershell
.\scripts\start-company-dryrun.local.ps1
```

If Windows blocks local PowerShell scripts, run the local copy with a process-scoped bypass instead:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start-company-dryrun.local.ps1
```

The `*.local.ps1` copy is ignored by Git. Keep `APP_EXECUTION_MODE=DRY_RUN` and `ENABLE_LIVE_ORDERS=false` until live order transmission is explicitly approved.
The example DRY_RUN startup script refuses placeholder credentials and runs `npm run smoke:dryrun:readiness` before `npm run start`.

To rehearse the automatic scheduler path without enabling live orders, copy `scripts/start-company-dryrun-scheduler.example.ps1` to `scripts/start-company-dryrun-scheduler.local.ps1`, fill in the Upbit and Telegram secrets, set:

```powershell
$DryRunSchedulerConfirmation = "I_UNDERSTAND_DRY_RUN_SCHEDULED_ORDERS"
```

Use the same `DATABASE_PATH` as the validated DRY_RUN database when you want the scheduler rehearsal to continue from that baseline. The example defaults to `./var/company-dryrun-scheduler.sqlite`, enables:

```powershell
$env:STRATEGY_SCHEDULER_ENABLED = "true"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "true"
$env:STRATEGY_SCHEDULER_BTC_INTERVAL_MS = "3600000"
$env:STRATEGY_SCHEDULER_ETH_INTERVAL_MS = "3600000"
```

It runs `npm run smoke:dryrun:sync` and `npm run smoke:dryrun:readiness` before `npm run start`. Startup refuses to continue if either smoke exits with `BLOCK`. Once running, inspect the automatic path with:

```text
/scheduler
/status
/alerts
/readiness
```

Because this launcher keeps `APP_EXECUTION_MODE=DRY_RUN` and `ENABLE_LIVE_ORDERS=false`, scheduled cycles can persist strategy decisions and simulated DRY_RUN lifecycle records, but they must not transmit live Upbit orders.

After the automatic DRY_RUN scheduler path has been inspected with `/scheduler`, `/status`, `/alerts`, and `/readiness`, run the persisted-evidence completion gate against the same `DATABASE_PATH`:

```powershell
npm run smoke:dryrun:completion
```

For repeated checks with the same DRY_RUN scheduler database, copy `scripts/smoke-dryrun-completion.example.ps1` to `scripts/smoke-dryrun-completion.local.ps1`, fill in the Upbit and Telegram secrets, keep `DATABASE_PATH` pointed at the scheduler rehearsal DB, and run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke-dryrun-completion.local.ps1
```

This smoke forces `APP_EXECUTION_MODE=DRY_RUN`, `ENABLE_LIVE_ORDERS=false`, disables Telegram delivery and inbound polling, disables scheduler startup, and reads only persisted local evidence: latest balance snapshot, latest position snapshot, latest reconciliation, active orders, recent risk blocks, pending operator notifications, and latest `strategy_scheduler_runs` for `KRW-BTC` and `KRW-ETH`. It does not run `/sync`, run strategy, start the scheduler, poll Telegram, call Upbit, deliver notifications, create orders, or transmit orders.

## Local LIVE Script

For an explicit live validation run, copy `scripts/start-company-live.example.ps1` to `scripts/start-company-live.local.ps1`, fill in secrets, set:

```powershell
$LiveOrderConfirmation = "I_UNDERSTAND_REAL_ORDERS"
```

The example intentionally keeps:
- `STRATEGY_SCHEDULER_ENABLED=false`
- `STRATEGY_SCHEDULER_RUN_ON_START=false`

This means the first LIVE process can receive Telegram commands and run readiness/sync checks without starting automatic scheduled trading. After startup, use Telegram `/sync`, `/readiness`, and `/preview BTC|ETH` to inspect current account health and deterministic order intent before considering `/run BTC|ETH`.
Real order submission is possible only when the app is in `LIVE`, live gate is enabled, Upbit credentials are configured, manual `/run` persisted-health preflight passes, readiness/risk guards pass, and a deterministic `/run BTC|ETH` or later scheduler tick creates an eligible order.

If Windows blocks local PowerShell scripts, run the local live copy with:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start-company-live.local.ps1
```

Before starting the local live copy, run the non-mutating live readiness smoke:

```powershell
npm run smoke:live:readiness
```

For repeated checks with the same LIVE environment, copy `scripts/smoke-live-readiness.example.ps1` to `scripts/smoke-live-readiness.local.ps1`, fill in secrets, set the confirmation string, and run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke-live-readiness.local.ps1
```

This smoke only checks local configuration, persisted execution state, adapter wiring, recent local snapshots, and local active-order visibility. It does not send orders, run strategy, start the scheduler, start Telegram polling, run `/sync`, or call Upbit.
The example live startup script runs this smoke before `npm run start`; if it returns `BLOCK`, the live process is not started.
The output includes `blockingCheckNames`, `warningCheckNames`, and `nextActions` so the operator can fix the local script, persisted execution state, or required `/sync` step without guessing.

After the manual LIVE process is healthy and `/sync` has produced fresh snapshots, check whether the automatic scheduler would pass its startup preflight without actually starting timers:

```powershell
npm run smoke:live:scheduler-preflight
```

For repeated checks with the same LIVE environment, copy `scripts/smoke-live-scheduler-preflight.example.ps1` to `scripts/smoke-live-scheduler-preflight.local.ps1`, fill in secrets, set the confirmation string, and run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke-live-scheduler-preflight.local.ps1
```

This scheduler smoke assumes scheduler-enabled startup preflight internally but does not start the runtime, start scheduler timers, set `RUN_ON_START`, run strategy, run `/sync`, poll Telegram, call Upbit, or send orders. A `PASS` or intentional `WARN` means the scheduler preflight would not block timer installation; starting the scheduler still requires a separate explicit local script change.

## Local LIVE Scheduler Script

After the LIVE process has been validated manually and `smoke:live:scheduler-preflight` has been reviewed, copy `scripts/start-company-live-scheduler.example.ps1` to `scripts/start-company-live-scheduler.local.ps1`, fill in secrets, and set both confirmation strings:

```powershell
$LiveSchedulerConfirmation = "I_UNDERSTAND_REAL_ORDERS"
$LiveSchedulerSecondConfirmation = "I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS"
```

The example intentionally keeps:
- `STRATEGY_SCHEDULER_ENABLED=true`
- `STRATEGY_SCHEDULER_RUN_ON_START=false`
- `STRATEGY_SCHEDULER_BTC_INTERVAL_MS=3600000`
- `STRATEGY_SCHEDULER_ETH_INTERVAL_MS=3600000`

Run the local copy with:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start-company-live-scheduler.local.ps1
```

The scheduler startup still runs the same automatic preflight before timers are installed. `RUN_ON_START=false` means startup itself does not immediately trigger a strategy cycle; the first scheduled cycle occurs after the configured interval. Real Upbit order submission remains possible on later scheduled cycles only if execution state, reconciliation health, risk guards, exchange validation, and live-send wiring all pass.

## Windows Task Scheduler Manual Launchers

For a company PC that must keep the process easy to restart, use the Task Scheduler helpers only as manual launchers. They do not add startup or logon triggers, do not store Upbit or Telegram secrets in the task definition, and do not start the task immediately after registration.

To register a manual DRY_RUN launcher:

```powershell
Copy-Item .\scripts\register-autotrade-dryrun-task.example.ps1 .\scripts\register-autotrade-dryrun-task.local.ps1
notepad .\scripts\register-autotrade-dryrun-task.local.ps1
powershell.exe -ExecutionPolicy Bypass -File .\scripts\register-autotrade-dryrun-task.local.ps1
```

To register a manual LIVE scheduler launcher:

```powershell
Copy-Item .\scripts\register-autotrade-live-scheduler-task.example.ps1 .\scripts\register-autotrade-live-scheduler-task.local.ps1
notepad .\scripts\register-autotrade-live-scheduler-task.local.ps1
powershell.exe -ExecutionPolicy Bypass -File .\scripts\register-autotrade-live-scheduler-task.local.ps1
```

The LIVE scheduler task points to `scripts/start-company-live-scheduler.local.ps1`, so that local startup script must already be filled in, keep `STRATEGY_SCHEDULER_RUN_ON_START=false`, and run `smoke:live:scheduler-preflight`.

Start a registered task manually from PowerShell:

```powershell
Start-ScheduledTask -TaskName "AutoTrade_Upbit_LIVE_Scheduler_Manual"
```

To unregister one of the approved tasks, copy `scripts/unregister-autotrade-task.example.ps1` to `scripts/unregister-autotrade-task.local.ps1`, set the confirmation string and desired task name in the local copy, then run it with `powershell.exe -ExecutionPolicy Bypass -File`.

## Immediate Next Steps

- run `npm run smoke:dryrun:operator`, then `npm run smoke:dryrun:readiness` or the local DRY_RUN readiness script, then `npm run smoke:dryrun:sync` or the local DRY_RUN sync script, then start the local `DRY_RUN` runtime and confirm `/readiness`, `/sync`, `/balances`, `/positions`, and `/run BTC|ETH` behavior against the intended local DB and credentials
- after the manual DRY_RUN path is reviewed, use the local DRY_RUN scheduler launcher to confirm scheduler `RUN_ON_START` behavior through `/scheduler`, `/status`, `/alerts`, and `/readiness`, then run `npm run smoke:dryrun:completion` or the local completion script against the same DB
- only then run `npm run smoke:live:readiness`, followed by the local `LIVE` script with scheduler disabled
- after a clean live validation run, run `npm run smoke:live:scheduler-preflight`
- only after reviewing that output, use the local LIVE scheduler script if automatic scheduled operation is intended
