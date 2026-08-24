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
- uncertain submission recovery is UUID-first/identifier-fallback and lookup-only for `SUBMITTING`, `RECONCILIATION_REQUIRED`, `FAILED`, and `REJECTED`, with injected-clock persisted observations; first absence remains uncertain, transient errors do not count as absence, and only atomic count-plus-elapsed CAS finalization can fault terminal absence without resending or resuming execution
- finalized `ORDER_SUBMISSION_ABSENCE_CONFIRMED` `FAILED` rows are excluded before later reconciliation lookup candidates and per-run budgets are constructed
- eligible terminal BTC strategy orders now project exact-decimal candidate evidence after durable fill backfill and a separate bounded terminal sweep; immutable deployment bindings and individually confirmed per-fill fees are required, the atomic candidate evidence/state/audit write is restart-idempotent, and a fault is disposed only with its matching automatic-pause transition. Restart sweeps retain immutable fault-event time while atomically deriving a non-backdated repair transition time; terminal no-fill markers stop disposing rows if durable fills later appear, and malformed activation persistence faults and pauses instead of escaping the sweep
- execution pre-trade validation now checks Upbit `orders/chance` and `orders/test` before any order record is persisted for submission
- account order submission now uses a durable account-scoped lease with explicit positive `ACCOUNT_EXECUTION_LEASE_MS` configuration (default `30000`), acquired after idempotency duplicate detection and before validation or persistence; uncertainty retains the lease and requires reconciliation rather than a resend
- every order path now uses the same account-wide submission-blocking classification for lease acquisition and final send authority, and read-only pilot readiness imports that pure classification without runtime composition. `FAILED` and `REJECTED` uncertainty blocks while absence-confirmed `FAILED` does not. After candidate-only decision/deployment/state/binding checks and the authoritative operator-state read, the final all-path account scan and exact account-plus-order-ID `SUBMITTING` read are the last awaited persistence checks before the sole send. Strict descriptor-safe projections prevent accessor/prototype laundering; any competitor, saturation, or authority/material mismatch pauses safely, retains recovery evidence, and transmits no order.
- automatic Telegram reporting now persists durable `operator_notifications`, attempts best-effort Telegram delivery when explicitly enabled, and records `PENDING` / `SENT` / `FAILED`
- Telegram delivery now keeps durable retry metadata such as `attempt_count`, `last_attempt_at`, `next_attempt_at`, and `failure_class`
- Telegram delivery now claims due notifications with a durable lease and finalizes delivery transitions by matching the claimed `lease_token`
- Telegram delivery now also persists a separate `operator_notification_delivery_attempts` audit trail, and `/alerts` shows recent delivery attempt outcomes alongside the current notification rows
- Telegram delivery now persists `operator_notification_delivery_runs` for each inline worker execution, including skipped/not-configured runs and failed worker runs
- Telegram delivery now coalesces kicks received while an inline worker is already running into a follow-up pass, so notifications created during an in-flight pass are delivered without waiting for an unrelated future alert
- `/alerts` now exposes delivery-worker queue metrics such as pending totals, due/scheduled counts, active/expired leases, abandoned-lease candidates, recent worker-run summaries, recent attempt outcome counts, and latest/oldest timestamps
- Telegram inbound polling is now available behind `ENABLE_TELEGRAM_INBOUND_POLLING=false` by default, uses the existing command router, accepts text commands only from the private chat whose source chat ID and sender ID both match `TELEGRAM_OPERATOR_CHAT_ID`, persists `getUpdates` offset progress in `telegram_inbound_offsets`, exposes locale-aware `/inbound` inspection with canonical `/inbound detail`, and splits long command replies into bounded Telegram messages
- `npm run smoke:dryrun:readiness` now provides a non-mutating local DRY_RUN preflight over runtime config and persisted readiness evidence before the local runtime starts
- `npm run smoke:dryrun:sync` now provides an exchange-backed DRY_RUN `/sync` rehearsal that persists snapshots/reconciliation evidence but does not run strategy, Telegram transport, scheduler, or order transmission
- `npm run smoke:dryrun:operator` now provides an offline, fixture-backed DRY_RUN operator rehearsal for `/config`, `/status`, `/readiness`, `/sync`, `/balances`, `/positions`, `/run BTC|ETH`, `/orders`, `/scheduler`, and `/alerts`
- `scripts/start-company-dryrun-scheduler.example.ps1` now provides a local DRY_RUN scheduler launcher that keeps live orders disabled, runs DRY_RUN sync/readiness smokes, then starts the runtime with scheduler `RUN_ON_START=true`
- `npm run smoke:dryrun:completion` now provides a persisted-evidence gate for marking the DRY_RUN automatic scheduler rehearsal complete without running sync, strategy, Telegram transport, scheduler timers, Upbit calls, or order transmission
- startup recovery can now mark persisted operator state `DEGRADED` when unresolved portfolio drift remains after exchange-backed bootstrap checks
- scheduler-triggered strategy cycles now persist `strategy_scheduler_runs` so scheduled run starts, completions, failures, and skips remain inspectable after process restart, including through `/scheduler`
- `/scheduler` now shows current in-memory scheduler status and startup preflight summary before the persisted scheduler-run history
- scheduler-triggered failures, overlapping-run skips, and scheduler-triggered order submission/rejection outcomes now also persist operator notifications so automatic operation has an alert trail
- `/order <order-id|identifier> [detail]` exposes a locale-aware lifecycle summary by default and the canonical order, event, and fill output with `detail`
- reconciliation now repairs older local dry-run artifacts without querying Upbit for `dryrun_*` UUIDs
- portfolio drift detection ignores simulated `DRY_RUN` fills because those fills do not mutate Upbit balances
- portfolio drift detection compares fill and snapshot timestamps as parsed instants, so Upbit timezone-offset fill timestamps are not reused outside their actual snapshot window
- portfolio drift detection uses a bounded one-second start-window grace only when a nearby exchange fill explains an otherwise-drifting window, preventing false drift from Upbit whole-second trade timestamps against millisecond local snapshots
- `/orders` now returns a bounded recent-order summary and points operators to `/order <id|identifier>` for details
- `/readiness` treats exchange-history recovery progress as a warning instead of blocking when no portfolio drift or unresolved order recovery remains
- Telegram `/start` is handled as a `/help` alias
- Telegram `/help` and `/start` use `TELEGRAM_LOCALE`; the explicit default is `ko-KR`, and `en-US` is the only alternative.
- Telegram `/start` now renders a Korean-first read-only dashboard with inline navigation for status, readiness, balances, positions, orders, alerts, risks, and scheduler evidence. Callback polling authenticates both source chat and sender, persists the update offset before handling, acknowledges before lookup, and edits only the originating bot message.
- Telegram startup can register a deterministic Korean fallback command menu plus an English `language_code=en` menu for the configured operator chat. This profile setup is idempotent, non-trading, secret-free in status output, and isolated from scheduler or inbound startup if Telegram rejects it.
- Telegram `/sync` presents the existing reconciliation request result in the configured locale while retaining canonical status, raw request time, and exact detail. Its formatter does not run another sync or infer that a completed request was drift-free.
- scheduler startup now records an automatic `strategySchedulerStartupPreflight`; in `LIVE` mode it blocks scheduler timers unless live gate, live adapter wiring, execution state, fresh exchange-backed snapshots, fresh reconciliation health, and active-order state are safe
- live scheduler startup blocks now persist an operator notification before startup can close local persistence
- live scheduler ticks now first refresh exchange-backed account-health evidence with reconciliation source `SCHEDULER_PREFLIGHT`, then re-run the persisted-health preflight before the strategy runner is invoked, so stale or unsafe account-health evidence blocks the scheduled cycle before any strategy decision or order intent is created
- simultaneous scheduler timer ticks are queued across BTC/ETH for the exchange account, so one market is not skipped only because the other market is already inside the account-scoped runner
- in `LIVE`, if one scheduled market tick submits an order, remaining market ticks from that same one-second scheduler batch are persisted as `SKIPPED` and deferred to the next interval
- manual `LIVE` `/run BTC|ETH` now also runs persisted-health preflight before the strategy runner is invoked, even when the scheduler is disabled
- execution minimum-value checks now derive market-sell notional from strategy reference price and requested quantity when the Upbit order shape carries volume but no order price
- exposure cap projection now treats `ask` orders as risk-reducing instead of adding sell notional to current exposure
- the runtime derives one tagged execution adapter: `LIVE_ADAPTER` only when mode, live gate, and Upbit credentials are all explicitly configured, otherwise `DRY_RUN_ADAPTER`. The adapter and path cannot be supplied independently; initial and final persisted mode/gate authority must match exactly, live requires `LIVE`/`ENABLED`, and dry accepts unchanged non-fully-live tuples while keeping lifecycle evidence simulated
- PositionGuard REDUCE decisions now require independent weakening evidence when `weakeningStage` is still `NONE`; a losing range position with only borderline bearish momentum remains `HOLD` instead of creating a sell intent
- PositionGuard now treats bearish invalidation evidence while flat as a no-order `HOLD`, so backtests and live previews do not emit no-position exit orders
- PositionGuard now applies profit-protective staged defensive reductions for open positions when weak-downtrend, breakdown-risk, or range-deterioration evidence appears, suppresses below-minimum reduce intents, and keeps immediate invalidation exits and no-position HOLD behavior intact.
- PositionGuard live snapshots request each timeframe at its last completed exclusive boundary, preserving 200 completed candles for EMA200 while excluding the active candle.
- borderline entry/add candidates are persisted as `PENDING_CONFIRMATION` without order submission; only a later matching confirmed decision is order-capable, and the backtest follows the same confirmation behavior.
- strategy order inputs carry the exchange ticker timestamp used for the reference price, so the stale-price guard measures actual market-data age instead of resetting it at submission; the explicit stale threshold also rejects materially future-dated evidence while tolerating smaller clock skew.
- PositionGuard now has a pure offline backtest/replay harness. It can fetch paginated Upbit public 1h/4h/1d candles sequentially for a research run, retry bounded Upbit public 429 responses, convert completed historical candle arrays into no-lookahead replay frames, reuse the core decision engine, apply configurable fee/slippage/minimum-trade assumptions, and report cash/buy-and-hold benchmarks, monthly returns, regime return contribution, skip-reason counts, trade diagnostics, action counts, regime counts, turnover, fee drag, drawdown, final equity, time-in-market, skipped order intents, and source-window warnings without touching DB, Telegram, Upbit private endpoints, order lifecycle records, or live-send configuration.
- its default research window now warms up for 220 days, fetches up to 100 pages per timeframe, and starts frames only after 200 completed candles exist in every timeframe so EMA200-dependent live and replay decisions share the same data requirement; exhausting that page limit before reaching the requested history start fails explicitly rather than producing a truncated report.

Current risk-policy framing is budget-first rather than asset-count-first:
- total exposure cap is the main reserve control
- per-asset allocation caps act as concentration backstops
- risk-reducing `ask` orders are not blocked solely because current exposure is already above cap
- future strategy sizing should be derived from total equity / exposure budgets, not from a simplistic “two assets means split in half” rule

## Runtime Shape

### BTC Candidate Pilot Is Available, Not Activated

Baseline remains the default policy and `DRY_RUN` remains the default execution mode. Candidate code availability does not approve or activate the pilot. The exact pilot identity is `BTC_COMBINED_CONSERVATIVE_PILOT_V1`, market `KRW-BTC`, policy `COMBINED_CONSERVATIVE`, version `PCS-2026-001.DEPLOYMENT_READINESS_V1`; ETH always remains baseline during this pilot.

The persisted phases are safety states: `DISABLED` is baseline-only; `PENDING_FLAT` is selected but inactive and suppresses new BTC `ENTER` and `ADD` until exchange-backed flat proof; `ACTIVE` permits candidate influence only through all existing runtime, risk, lease, and LIVE gates; canonical `DRAINING` remains authoritative across restart and permits only risk reduction or exit while rollback inventory remains; and `PAUSED_FAULT` blocks candidate execution pending explicit operator review. No phase enables LIVE orders or automatically resumes execution by itself.

Persisted deployment, state, execution-evidence, and audit records are authoritative. Candidate state must replay exactly, and every executable account decision still requires the account execution lease. Submission uncertainty pauses global execution, recovery faults the pilot, and neither automatically resumes. Rollback starts only while globally paused, uses `DRAINING` while inventory remains, retains that authority on restart, reaches `DISABLED` only after exchange-backed flat evidence, and leaves resume to a separate explicit operator action.

Use `scripts/inspect-btc-pilot-readiness.example.ps1` only with an explicit existing SQLite path, exchange-account ID, deployment ID, and freshness threshold. The checked-in example calls `inspect:btc-pilot:readiness` for direct read-only inspection of that persisted identity while forcing the default `BASELINE` policy selection and using no secrets. It does not select or confirm the candidate, activate the pilot, mutate the database or a `.local.ps1` file, call Upbit or Telegram, start the app or scheduler, invoke sync/strategy/order paths, or enable LIVE orders. Candidate selection and confirmation must remain outside the checked-in example in separate local configuration, followed by no-order validation and operator review; activation still requires a later explicit request.

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\inspect-btc-pilot-readiness.example.ps1 `
  -DatabasePath C:\approved-copy\autotrade-upbit.sqlite `
  -ExchangeAccountId <exchange-account-id> `
  -DeploymentId <deployment-id> `
  -FreshnessThresholdMs 3600000
```

Runtime startup constructs the app first, then always performs persisted pilot-authority inspection before startup recovery or exchange-backed reads, notification delivery, operator-state/preflight reads, scheduler startup/reporting, Telegram polling or menu setup, and signal installation. Under baseline selection, a fresh database or no deployment remains baseline, and one canonical `DISABLED` deployment permits baseline startup; any nonterminal deployment, malformed row, duplicate, or identity mismatch fails closed rather than being ignored. A validated candidate selection then initializes only a newly `CREATED` deployment as pristine `PENDING_FLAT`; valid existing `PENDING_FLAT`, `ACTIVE`, `PAUSED_FAULT`, or canonical `DRAINING` authority is retained unchanged. Startup never activates, resumes, or converts `DRAINING` automatically.

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
11. Telegram inspection currently includes `/help`, `/config`, `/readiness`, `/readiness detail`, `/status`, `/status detail`, `/statehistory`, `/synchistory`, `/recovery`, `/alerts`, `/alerts detail`, `/risks`, `/risks detail`, `/balances`, `/balances detail`, `/positions`, `/positions detail`, `/orders`, `/orders detail`, `/order <order-id|identifier> [detail]`, `/scheduler`, `/scheduler detail`, `/inbound`, `/inbound detail`, and `/sync` for operator visibility. The default portfolio, health, order, risk-history, alert-delivery, scheduler, and inbound-worker views are concise and locale-aware, while their `detail` forms preserve the canonical technical fields. `/pause`, `/resume`, and `/killswitch` also return locale-aware results without changing their existing persisted state-transition semantics.
12. `/sync` connects to reconciliation so snapshot and reconciliation records are persisted, using read-only public ticker valuation when available. Its locale-aware response is presentation over that one controller result and preserves the canonical status, raw request timestamp, and exact detail without adding another sync or side effect.
13. `/preview BTC|ETH` requests one non-mutating deterministic PositionGuard preview for a supported asset and returns the computed decision, action, reference price, and order intent when present. Its locale-aware response preserves every canonical field and the exact no-mutation boundary, distinguishes a no-order result from an order intent, and never implies that an order was persisted or sent.
14. `/run BTC|ETH` requests one deterministic PositionGuard runner cycle for a supported asset and returns the persisted decision, action, and any order lifecycle result. Its locale-aware response defaults to Korean, retains every canonical result field and exact controller detail, warns that LIVE operation can transmit a real order, and never describes submission acceptance as proof of a fill.
15. When `STRATEGY_SCHEDULER_ENABLED=true`, the scheduler uses the same safe runner/controller path as `/run BTC|ETH`; it is disabled by default.
16. In `LIVE` mode, scheduler startup runs an automatic preflight before any timer is installed; this replaces a mandatory manual-first-run ritual with inspectable startup safety checks and rejects stale persisted account-health evidence.
17. In `LIVE` mode, each scheduled tick first runs exchange-backed account-health refresh with reconciliation source `SCHEDULER_PREFLIGHT`, then re-runs persisted-health preflight before invoking the strategy runner; a refresh or preflight block is persisted as scheduler audit state without creating a strategy decision or order intent.
18. Simultaneous configured market ticks are queued for the exchange account before strategy runner invocation so BTC/ETH timers do not collide with the account-scoped runner lock.
19. In `LIVE`, if one scheduled tick submits an order, remaining ticks from the same one-second scheduler batch are persisted as `SKIPPED` and deferred to the next interval.
20. Manual `/run BTC|ETH` in `LIVE` re-runs persisted-health preflight before invoking the strategy runner and returns a block as an operator response without creating a strategy decision or order intent.
21. Scheduler-triggered cycles are persisted in `strategy_scheduler_runs` before runner execution and updated on completion, failure, or skip. `/scheduler` provides a locale-aware view that separates current in-memory state from the bounded latest-20 persisted sample and displays its newest three rows; `/scheduler detail` preserves the canonical runtime, preflight, market, and persisted-run output. Both forms use one bounded history read and one runtime-status snapshot without starting or stopping timers, triggering a tick, running strategy or sync, calling Upbit, mutating orders or execution state, or altering scheduler-run records.
22. Reconciliation records now carry source metadata such as `STARTUP_RECOVERY`, `OPERATOR_SYNC`, and `SCHEDULER_PREFLIGHT`, compare fill windows by parsed instants, and use a per-run lookup budget to avoid unbounded private order reads.
23. `/risks` summarizes recent persisted `risk_events` with localized severity counts, rule explanations, original messages, and linked records; `/risks detail` preserves the canonical technical list. Both commands use the same bounded read and do not treat historical rows as proof of a current active block, evaluate risk, mutate events or orders, call Upbit, or change execution state. Automatic reporting persists durable `operator_notifications`, then non-blockingly kicks best-effort Telegram delivery behind a separate gate.
24. `/inbound` summarizes the current in-memory Telegram polling worker separately from persisted `telegram_inbound_offsets`, including a readable runtime state, process-lifetime counters, recent error, and next-offset agreement. `/inbound detail` preserves the canonical technical runtime and persisted-offset fields. Both forms use at most one runtime snapshot and one offset read and never poll Telegram, route commands, save offsets, call Upbit, run sync or strategy, mutate orders, or change execution state.
25. `/pause`, `/resume`, and `/killswitch` present the accepted persisted state transition in the configured Telegram locale, including canonical status/mode/gate/blocker evidence and a next action. The formatter does not perform another transition, and `/resume` never clears or disguises an active kill switch.
24. `/alerts` summarizes a bounded recent sample with localized status labels, explicitly identifying the read limits and displaying only the newest three notifications, one delivery run, and one delivery attempt; `/alerts detail` preserves the canonical technical notification, delivery-run, delivery-attempt, retry, and queue output. Both commands use the same three bounded local reads and never claim, send, retry, finalize, or mutate notifications. Telegram delivery separately claims due `PENDING` notifications with a lease token, then only finalizes rows that still match that lease.
25. Each delivery attempt now also writes a durable `operator_notification_delivery_attempts` record so `/alerts` can show recent delivery outcomes separately from the summary row in `operator_notifications`.
26. Each delivery worker kick also writes a durable `operator_notification_delivery_runs` record so operators can inspect skipped, completed, and failed delivery-worker executions.
27. Delivery kicks received while an inline worker is already in flight are coalesced into a follow-up delivery pass.
28. Retryable Telegram delivery failures stay `PENDING` with a later `next_attempt_at`, while permanent failures become `FAILED`.
29. Telegram inbound polling is disabled by default and, when enabled, only routes text commands when the private source chat ID and sender ID both match the configured operator ID.
30. Telegram inbound offset progress is persisted in `telegram_inbound_offsets` before routing each update, scoped by exchange account and non-secret bot-token fingerprint.
31. Reconciliation and Telegram inspection surfaces operate on persisted state.
32. When scheduler or inbound polling starts background timers, runtime signal handlers stop polling, stop the scheduler, and close SQLite persistence on `SIGINT` / `SIGTERM`; when no background runtime starts, startup closes persistence after printing the banner.

`/help` is a locale-aware, static command-contract summary. It defaults to Korean, preserves every command usage string and safety boundary, and does not read exchange state, query repositories, trigger `/sync`, run strategy cycles, tick the scheduler, mutate orders, or enable live order transmission.
`/status` is a locale-aware, read-only operator summary of execution mode, live-order availability, blockers, kill-switch state, scheduler timing, and latest reconciliation health. Use `/status detail` for the complete canonical technical output; both forms use the same bounded local reads and do not trigger exchange calls, sync, strategy execution, scheduler ticks, order mutation, notification delivery, or live order transmission.
`/balances` and `/positions` are locale-aware summaries of the latest persisted exchange snapshots, with KST timestamps and readable money and quantity formatting. `/balances detail` and `/positions detail` preserve the canonical technical output. These views do not call Upbit, trigger `/sync`, or accept manual cash or position input; exchange state plus local persistence remain the source of truth.
`/orders` is a locale-aware summary of the latest persisted order lifecycle records, including status counts and exact `/order <id>` follow-up commands. `/orders detail` preserves the canonical bounded technical list. Both commands are inspection-only and do not submit, cancel, retry, reconcile, or mutate orders.
`/order <reference>` is a locale-aware summary of one persisted order with bounded recent event and fill history. `/order <reference> detail` preserves the complete canonical order, event payload, fill, and identifier output. These views do not query Upbit or mutate local or exchange order state, and a missing order does not trigger event or fill reads.
`/config` is locale-aware, non-secret runtime configuration inspection. It shows configured/not-configured booleans for credentials and Telegram identifiers instead of raw secret values, lists only configuration that is required by enabled features as missing, and preserves ignored deprecated environment variable names when stale local scripts still set them.
`/statehistory`, `/synchistory`, and `/recovery` add Korean-first or English operator guidance, KST timestamps, and truthful persisted-evidence explanations while retaining their canonical technical bodies. They keep their existing bounded local reads and do not trigger sync, exchange calls, strategy execution, scheduler actions, order mutation, execution-state changes, or notification delivery.
`/readiness` is a locale-aware read-only summary with human-readable PASS/WARN/BLOCK guidance. It summarizes runtime config, persisted execution state, worker status, latest snapshots, latest reconciliation, and bounded local persistence health: active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count. `/readiness detail` preserves the complete canonical technical check list and safety boundaries. Neither form performs active Upbit or Telegram probes, triggers sync, strategy, or scheduler work, or mutates offsets, orders, or notification delivery state.
In intentional `LIVE` operation, `/readiness` reports the enabled live send path as a warning so operators remember that `/run` is real-order capable, while true health blockers still produce `BLOCK`. When the `LIVE` scheduler is enabled, `/readiness` also warns if the latest balance snapshot, position snapshot, or reconciliation run is older than the shortest configured scheduler interval.
`/preview BTC|ETH` computes a deterministic strategy decision and order intent without persisting the decision, creating an order, running reconciliation, or submitting to Upbit. Its locale-aware presentation explains the action and Upbit order shape without recalculating values; a later `/run` may use newer market and account state and can submit a real order when the runtime is intentionally LIVE.
`/run BTC|ETH` persists the deterministic decision and routes eligible order intents through the configured execution path; in `LIVE`, it first runs persisted-health preflight even when the scheduler is disabled. The readable result distinguishes no-order, rejected, accepted, and lifecycle states; accepted means accepted through the configured path, not filled.

## Folder Layout

- `src/domain/*`: core execution-native types
- `src/app/*`: configuration and bootstrap
- `src/modules/db/*`: repository contracts, SQLite-backed persistence, and in-memory test scaffolding
- `src/modules/exchange/*`: exchange adapter contracts and Upbit private auth/client code
- `src/modules/execution/*`: idempotency and execution service
- `src/modules/reconciliation/*`: reconciliation contracts and service
- `src/modules/risk/*`: pure guardrails
- `src/modules/strategy/*`: deterministic strategy contracts, PositionGuard analysis, runner, offline replay frame builder, replay harness, offline replay report formatter, and public-candle research backtest runner
- `src/modules/telegram/*`: operator command parsing and formatting; `formatter.ts` is the stable compatibility facade and the technical implementation lives under `presentation/technical.ts`
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
- `ACCOUNT_EXECUTION_LEASE_MS`
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
Callback updates follow the same offset-first replay boundary. A callback is authorized only when both its private source chat and sender match the configured operator, and only typed read-only navigation actions are accepted. Unknown, malformed, oversized, or mutation-shaped callbacks are acknowledged without reaching the text command router. Valid callbacks use a dedicated read-only route, then edit the originating message with a final 3,500-character cap. Order pages contain five rows and alert pages contain three; missing capabilities and edit failures remain explicit polling failures without replaying the persisted update.

Inbound polling errors shown by `/inbound` are normalized and bounded after redacting Telegram bot-token paths, bearer credentials, and secret-bearing query values. This diagnostic output remains transport evidence only and never becomes trading truth.

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OPERATOR_CHAT_ID` are configured, runtime startup also calls Telegram `setMyCommands` for that private operator chat. The no-language fallback list uses Korean descriptions and the `en` list uses English descriptions. Repeating startup replaces those lists with the same deterministic values. This changes only Telegram menu metadata; it does not execute a command or alter any trading record. Setup status is included in the startup banner without token, token-bearing URL, or arbitrary transport error text, and a setup failure does not prevent scheduler or inbound polling startup.

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
In `LIVE`, if a queued scheduled tick submits an order, later ticks from the same one-second scheduler batch are recorded as `SKIPPED` and wait for their next configured interval.
Upbit `price` market buys can report exchange state `cancel` after a successful fill when only dust-sized KRW or fee lock remains. The local lifecycle records those filled market-buy dust-cancel snapshots as `FILLED` while preserving the raw exchange payload, fill, and fee evidence for `/order` inspection. If an older local row already stored that pattern as `CANCELED`, terminal reconciliation rechecks and repairs it to `FILLED`.
The scheduler still uses the same runner/controller path as `/run BTC|ETH`, so it does not enable live order transmission by itself.
If the scheduler is enabled while `APP_EXECUTION_MODE=LIVE`, startup first runs an automatic scheduler preflight. It blocks timer installation unless the live gate is enabled, the execution service is wired to the live adapter, operator state is `RUNNING`, Upbit read credentials and fresh persisted snapshots exist, no active local orders require visibility, and the latest reconciliation is fresh and has no blocking issue codes. Freshness uses the shortest configured scheduler interval, so with the default one-hour BTC/ETH intervals a snapshot or reconciliation older than one hour blocks automatic scheduler startup. Non-blocking exchange-history recovery evidence remains a warning.
If that live scheduler startup preflight blocks timer installation, the runtime persists a `SCHEDULER_STARTUP_BLOCKED` operator notification with the preflight detail and failed checks before local persistence can be closed.
Every later `LIVE` scheduled tick first runs an exchange-backed account-health refresh that persists current balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`. The tick then runs the same persisted-health preflight before the strategy runner is invoked. If refresh fails or account-health evidence remains stale or unsafe, the tick is recorded as a failed `strategy_scheduler_runs` row and operator notification, and no strategy decision or order intent is created.
When either scheduler or Telegram inbound polling is running, use normal process signals such as `Ctrl+C` / `SIGINT` or `SIGTERM` to stop the process. Shutdown is explicit: inbound polling is stopped, scheduler timers are cleared, and SQLite persistence is closed before the process exits.

## Read-Only Performance Report

Generate a deterministic performance report from persisted local fills and position snapshots:

```powershell
npm run report:performance -- --database ./var/company-live.sqlite --exchange-account primary --mode LIVE --origin STRATEGY
```

Bound the report to a half-open `[from,to)` period and request stable JSON output when needed:

```powershell
npm run report:performance -- --database ./var/company-live.sqlite --exchange-account primary --mode LIVE --origin STRATEGY --from 2026-08-01T00:00:00.000Z --to 2026-08-10T00:00:00.000Z --json
```

All four selection arguments are required: `--database`, `--exchange-account`, `--mode`, and `--origin`. Optional `--from` is inclusive and `--to` is exclusive. Timestamps require an explicit timezone and support zero through nine fractional-second digits. Ordering and range checks preserve nanosecond precision instead of relying on `Date.parse()` millisecond truncation. The report retains the period-opening snapshot at or before `--from`, but selected-stream attribution uses a separate latest snapshot strictly before the first selected fill. Inventory found there is classified as external/opening inventory rather than selected strategy PnL. Equal-time snapshots are not used as attribution baselines. Marks come from the latest snapshot strictly before `--to`, or the latest snapshot when `--to` is omitted.

The command opens the existing SQLite file directly with `readOnly: true`. It does not apply migrations, create a database, call Upbit or Telegram, run reconciliation or strategy, start scheduler work, mutate order lifecycle state, or transmit orders. `fills.fee_amount` remains authoritative. When it is absent, the reader may derive one KRW fee from persisted `orders.exchange_response_json.paid_fee` only for an exact single-local-fill/single-trade UUID, market, side, price, and volume match. Ambiguous, malformed, or mismatched evidence stays `unknown` with provenance warnings; no value is written back to SQLite.

The professional diagnostics section keeps two analysis units separate. The default win rate and average-trade metrics use only completed flat-to-flat position episodes; FIFO realization-slice outcomes are reported separately so partial exits are not counted as independent completed trades. It reports BTC, ETH, and combined episode statistics, gross and net realized PnL, confirmed fee evidence and completeness, payoff ratio, profit factor, streaks, holding durations, best/worst episodes, strategy entry/exit action contribution, cumulative realized-PnL drawdown, and persisted-snapshot mark drawdown. Mark curves use only each snapshot's own stored mark, never interpolation or a future observation, and expose `persistedObservationCount`, `usableObservationCount`, usable `sampleCount`, and `maxObservationGapMs`.

The JSON output preserves explicit `KNOWN`, `UNKNOWN`, and `NOT_APPLICABLE` metric states and includes auditable FIFO slices, position episodes, per-market curves, recent completed episodes, filters, fill range, and snapshot provenance. The text output summarizes the same definitions without hiding raw identifiers or completeness warnings.

The result is performance attributed to the selected order stream and its reported opening inventory. It is not total account return and does not treat deposits, withdrawals, unrelated order origins, or external balance changes as strategy profit.

## Immutable Research Candle Acquisition

Collect BTC and ETH research evidence independently before running an integrated comparison. Each invocation requires all six acquisition arguments; there are no hidden range or pagination defaults.

```powershell
npm.cmd run research:candles -- --asset BTC --history-start 2025-01-01T00:00:00.000Z --end 2026-08-11T00:00:00.000Z --output ./var/research/krw-btc-20250101-20260811.json --page-size 200 --page-limit 100
npm.cmd run research:candles -- --asset ETH --history-start 2025-01-01T00:00:00.000Z --end 2026-08-11T00:00:00.000Z --output ./var/research/krw-eth-20250101-20260811.json --page-size 200 --page-limit 100
```

The required arguments are `--asset BTC|ETH`, `--history-start <explicit-timezone ISO-8601>`, `--end <explicit-timezone ISO-8601>`, `--output <new local JSON path>`, `--page-size <integer 1..200>`, and `--page-limit <positive integer>`. The command uses only unauthenticated Upbit public candle endpoints, and only when an operator manually invokes it. It does not read credentials or Telegram secrets, open operational SQLite, import the application runtime, or inspect or mutate balances, positions, orders, fills, risk, execution state, reconciliation, scheduler, or Telegram state.

The output is an immutable local JSON artifact containing completed `1h`, `4h`, and `1d` candles plus explicit asset, market, requested range, collection time, fixed source `upbit-public-historical-candles`, and a canonical lowercase SHA-256 checksum. Publication uses a verified temporary artifact and refuses to overwrite an existing destination, including an output-path race. A failure leaves no completed destination artifact.

After both independent artifacts exist, supply those exact paths to `report:strategy-evaluation` as `--btc-dataset` and `--eth-dataset`, together with the required per-asset initial states and explicit `BASELINE`/`NO_ADD` analysis inputs shown below. When authenticated no-trade sidecars also exist, pass them as `--btc-no-trade-evidence` and `--eth-no-trade-evidence`. Collection creates analysis evidence only: it does not run a backtest, recommend a trade, establish trading truth, change strategy rules, or enable live execution.

### Independent No-Trade Evidence

`classifyIndependentNoTradeCoverage(dataset, evidence?)` is a pure, in-memory research helper for an immutable dataset and an optional authenticated sidecar. It returns `DENSE`, `VERIFIED_SPARSE`, or `UNVERIFIED_SPARSE` together with deterministic exact `[from,to)` `missingRanges` and `uncoveredRanges`. It considers only absolute UTC hour-aligned intervals fully contained in the parent range and rejects observed hourly candles outside that grid. Dense valid data needs no sidecar. Sparse data is verified only when valid sidecar evidence covers every missing nominal 1h interval; an invalid sidecar fails explicitly and is never silently downgraded, and partial verified evidence leaves an exact sub-hour uncovered range. This helper neither collects 1m data nor synthesizes/interpolates candles, and it is not wired to deployment, runtime, API, Telegram, SQLite, migrations, or trading behavior. Source tests constrain declared module specifiers and literal relative import edges, not arbitrary runtime-generated loading.

To collect a new V1 sidecar for an existing authenticated parent candle dataset, invoke the standalone public-only command with every argument explicit:

```powershell
npm.cmd run research:no-trade-evidence -- --parent-dataset ./var/research/krw-btc-20250101-20260811.json --output ./var/research/krw-btc-20250101-20260811.no-trade.json --page-size 200 --page-limit 100
```

The parent dataset supplies the asset, market, requested range, and checksum. The command creates an unauthenticated Upbit public `1m` candle client only after local argument validation, parent authentication, and destination availability checks pass. It does not read Upbit private credentials or Telegram secrets, open SQLite, start a runtime, run a scheduler, invoke reconciliation or strategy code, or create, cancel, or inspect orders.

The output is immutable: an existing destination is never overwritten, including a destination created during publication. Every requested missing parent hour must complete its public pagination and contain no valid 1m candle; a malformed page, reader failure, cursor failure, page-limit exhaustion, or parent-gap candle conflict fails the whole acquisition and publishes no completed sidecar. V1 stores a canonical response fingerprint rather than raw 1m response bodies or a retained source-page manifest. The fingerprint is useful provenance, but it is not independently retained source data or a replacement for a future versioned audit manifest.

This collection is research evidence only. It is not a backtest, strategy modification, deployment approval, trade recommendation, or LIVE action, and it does not resume or alter any running trading process.

## Integrated Strategy Evaluation

`report:strategy-evaluation` is a research-only, read-only evaluation that keeps observed order-stream attribution, simulated counterfactuals, and modeled-cost scenarios as separate evidence classes. It diagnoses the available evidence; it does not change PositionGuard rules, runtime wiring, execution state, orders, scheduler work, Telegram, reconciliation, exchange behavior, or live-order configuration. It opens the existing operational SQLite file with `readOnly: true` and never applies migrations, creates a database, calls Upbit or Telegram, or performs a network fallback.

Run the observed-only evaluation with the exact required filters:

```powershell
npm run report:strategy-evaluation -- --database ./var/company-live.sqlite --exchange-account-id primary --execution-mode LIVE --origin STRATEGY --from 2026-08-01T00:00:00.000Z --to 2026-08-10T00:00:00.000Z --format json
```

`--database`, `--exchange-account-id`, `--execution-mode`, and `--origin` are required. The integrated CLI is LIVE-only: `--execution-mode LIVE` is required and `DRY_RUN` is rejected because the observed section is `OBSERVED_LIVE_ATTRIBUTION`. `--origin` is `STRATEGY`, `OPERATOR`, or `RECOVERY`; `--format` is `text` (the default) or `json`. Optional `--from` is inclusive and `--to` is exclusive, forming `[from,to)` with explicit-timezone ISO timestamps compared at nanosecond precision. The result is selected-order-stream attribution, not total account return.

Observed-only mode never reads a candle dataset. Both BTC and ETH instead report `DATASET_UNAVAILABLE` in the simulated, cost, regime, excursion, and ADD-diagnostic sections, and the report records a structured evidence gap rather than fetching candle data.

To evaluate one or both immutable local datasets, provide a paired initial state for every supplied asset plus explicit scenarios, minimum order value, and cost cells. For example:

```powershell
npm run report:strategy-evaluation -- --database ./var/company-live.sqlite --exchange-account-id primary --execution-mode LIVE --origin STRATEGY --btc-dataset ./var/research/krw-btc-20250101-20260811.json --btc-initial-state '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}' --eth-dataset ./var/research/krw-eth-20250101-20260811.json --eth-initial-state '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}' --scenarios '["BASELINE","NO_ADD"]' --minimum-order-value-krw 5000 --cost-cells '[{"id":"base","feeRate":0.0005,"slippageRate":0},{"id":"stress","feeRate":0.001,"slippageRate":0.002}]' --format json
```

`BASELINE` replays the unmodified historical strategy decisions. `NO_ADD` retains an `ADD` decision and diagnostics but suppresses only its simulated execution, then replays the full later path from the same initial state. `MODELED_COST_SCENARIO` results use the caller-supplied fee/slippage grid; the first caller-ordered cost cell is the explicit base simulation assumption. Simulated BTC and ETH use independent capital (`INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO`), and observed, simulated, and modeled results are never summed or presented as a combined portfolio return. A `COUNTERFACTUAL_SCENARIO_DELTA` interpretation compares `metrics.totalReturnPct` ratios and reports `(NO_ADD - BASELINE) * 100` as percentage points, not as an unscaled return ratio or percent change.

Conditional ADD research may additionally request `ADD_RISK_CLEAR`, `ADD_HIGH_ALIGNMENT`, and `ADD_CORE_TREND`. Candidate gate evaluation is produced only when all three candidate IDs, both `BASELINE` and `NO_ADD` anchors, exactly three explicit validation windows, the first caller-ordered cost cell is a base cell with fee `0.0005` and explicit valid slippage, and a distinct stress cell has fee `0.001` and slippage `0.002`. Missing prerequisites produce a stable `UNAVAILABLE` section rather than hidden defaults. The candidate matrix compares each asset and candidate against both anchors at base and stress costs; its full-path and `[from,to)` window observations slice each continuous replay without resetting capital or position state.

When that complete two-asset conditional matrix, ADD diagnostics, and ADD excursions are available, the report also emits an optional `addLossAttribution` section. It is a read-only diagnostic over executed ADD fills, not a new backtest scenario or a live decision path. Each ADD fill keeps its FIFO realization slices, linked position episode, full/partial/unrealized inventory state, entry notional, realized and remaining quantity, gross contribution, allocated entry/exit fees, net contribution, and MAE/MFE evidence. A partially realized or open ADD fill is not counted as a completed position trade. Gross evidence can remain known, but a missing required fee component keeps net contribution and fee-dependent aggregates `UNKNOWN`; the report never substitutes a zero fee.

The section reports the same predeclared ADD cohorts independently for BTC and ETH: regime, ATR shock, weakening stage, exact trend-alignment score, and ADD ordinal within the linked episode. It also reports the exact ADD sets suppressed by the three existing candidate policies using their persisted replay `researchSuppression` evidence, rather than re-evaluating predicates. Text output shows at most the three largest known-net loss cohorts per asset; JSON retains every cohort, denominator, completeness state, and source evidence ID.

For each existing conditional ADD candidate, a cross-asset classifier reports one of `NOT_APPLICABLE`, `INSUFFICIENT`, `CONFLICTING`, or `READY_FOR_FUTURE_HOLDOUT`. A result can be ready only when BTC and ETH agree on the complete frozen evidence and the remaining limitation is the existing support threshold. `READY_FOR_FUTURE_HOLDOUT` means only that the named existing hypothesis and its evidence IDs can be frozen for a separately identified future-data evaluation. It does not change `ELIGIBLE_FOR_FURTHER_RESEARCH`, alter a PositionGuard rule or threshold, authorize DRY_RUN/LIVE execution, or establish that the policy caused the observed result.

Offline PositionGuard feature input follows the actual ordered Upbit generated-candle sequence. A nominal timeframe boundary without a generated candle is preserved as `NO_TRADE_INTERVAL` evidence, not replaced with a synthetic candle and not blocking by itself. The report retains raw nominal-grid compatibility evidence and renders each timeframe using this stable terminology:

```text
source_cadence=<raw compatibility>
sequence=<authoritative>
clock_grid=<DENSE|SPARSE_BY_CONTRACT|ANOMALOUS>
no_trade_intervals=<count>
raw_missing=<count>
```

`sourceCadenceStatus` and `sourceMissing*` describe the nominal clock grid. `sourceSequenceStatus` is authoritative for the feature and candidate gate, and `clockGridStatus` explains whether the raw grid is dense, sparse by the Upbit generated-candle contract, or anomalous. Conditional ADD cadence separately exposes approved no-trade frames and unexplained missing frames; only unexplained candidate-frame loss, duplicate/off-grid/post-boundary evidence, future references, insufficient actual generated candles, acquisition-boundary failure, or corrupted dataset evidence blocks the gate. A candidate frame must still reference the latest actual observed timeframe close at that instant, and recursive EMA, ATR, RSI, and MACD inputs use the full observed prefix with at least 200 actual generated candles per timeframe.

Frames are generated only on observed `1h` closes. This is an offline candle-close replay contract, not a claim of scheduler-clock replay equivalence. No candle, OHLCV value, indicator input, or frame is synthesized, interpolated, or forward-filled. A source-verified no-trade interval contributes no candle and therefore no artificial high or low to MAE/MFE. Unexplained hourly gaps remain `UNKNOWN`; only authoritative no-trade evidence may distinguish a valid empty interval from missing evidence.

Conditional candidate replays record an auditable `ALLOW` or `SUPPRESS` policy result with a stable reason, exact decision time, and contemporaneous analysis snapshot for every ADD decision. Policy support counts use only explicit `ALLOW` records whose ADD trade actually executed, then count a completed position episode once when it contains one or more such trades. A window counts only policy-exposed episodes whose close is observed inside that half-open window, so future episode closure is never borrowed. Incomplete full-path, window, upstream-state, or multi-timeframe recursive feature coverage, or fewer than 30 full-path / 10 per-window policy-exposed completed episodes, remains `INSUFFICIENT` even when returns look favorable. `ELIGIBLE_FOR_FURTHER_RESEARCH` is not deployment approval; changing the live strategy requires a separate design, review, DRY_RUN/shadow validation, and explicit deployment decision.

Optionally add anchored forward subperiod validation. All four validation arguments are required together and have no hidden monetary or timing defaults:

```powershell
npm run report:strategy-evaluation -- --database ./var/company-live.sqlite --exchange-account-id primary --execution-mode LIVE --origin STRATEGY --btc-dataset ./var/research/krw-btc-20250101-20260811.json --btc-initial-state '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}' --eth-dataset ./var/research/krw-eth-20250101-20260811.json --eth-initial-state '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}' --scenarios '["BASELINE","NO_ADD"]' --minimum-order-value-krw 5000 --cost-cells '[{"id":"base","feeRate":0.0005,"slippageRate":0},{"id":"stress","feeRate":0.001,"slippageRate":0.002}]' --validation-windows '[{"id":"W1","from":"2025-07-20T00:00:00Z","to":"2025-10-25T19:00:00Z"},{"id":"W2","from":"2025-10-26T00:00:00Z","to":"2025-12-31T19:00:00Z"}]' --validation-frame-interval-ms 3600000 --validation-comparison-tolerance-pp 0.000001 --validation-minimum-windows 2 --format json
```

Validation windows must be explicit, ordered, non-overlapping `[from,to)` ranges. Select boundaries from persisted dataset coverage. Approved `NO_TRADE_INTERVAL` boundaries remain visible in coverage without being interpolated or treated as unexplained loss; a window with unexplained candidate-frame loss, a blocking sequence anomaly, or an upstream replay-state failure remains insufficient. Each asset and cost cell is replayed once from its supplied initial state, and window metrics slice that continuous path without resetting cash, inventory, or prior decisions. The section reports period return, drawdown, turnover, fees and completeness, completed and carry-in episodes, suppressed-ADD exposure, exact raw/no-trade/unexplained-gap manifests, frame coverage without interpolation, upstream-state continuity, and paired `NO_ADD - BASELINE` percentage-point deltas. Its classification is descriptive and explicitly makes no statistical-significance claim.

A dataset is local JSON with provenance `schemaVersion`, asset, matching KRW market, `historyStartAt`, `endAt`, `collectedAt`, source, and lowercase SHA-256 checksum, plus completed, ordered `1h`, `4h`, and `1d` candles. The checksum covers a canonicalized dataset excluding the declared checksum. Candle times require explicit timezones and exact nominal durations. Frame construction compares exact epoch nanoseconds, preserves the decision candle's original offset/nanosecond `closeTime` in `generatedAt` and source provenance, and includes only candles completed no later than that exact decision instant. Counterfactual fills preserve those exact timestamps. FIFO orders fills by exact instant and then stable fill ID for same-side ties; opposite-side fills for one market at the same exact instant are rejected as ambiguous.

No supplied path produces `DATASET_UNAVAILABLE`; that status means the asset's dataset option was omitted. A supplied, schema-valid dataset that cannot create frames produces structured `DATASET_UNUSABLE` sections in `simulatedCounterfactuals`, `costSensitivity`, `regimeAnalysis`, `excursionAnalysis`, and `addDiagnostics`, plus a `DATASET_UNUSABLE` evidence gap. Its `reasonCode` is `EMPTY_TIMEFRAME_CANDLES`, `INSUFFICIENT_COMPLETED_CANDLES`, or `NO_OVERLAPPING_REPLAY_WINDOW`, and no scenario, cell, or analysis output is fabricated. Malformed JSON, invalid provenance/checksum, or asset/market mismatch still fails explicitly. The evaluator never collects or downloads a replacement.

The JSON report has `provenance`, `observedLive`, `simulatedCounterfactuals`, `costSensitivity`, `regimeAnalysis`, `excursionAnalysis`, `addDiagnostics`, `evidenceGaps`, and `interpretation` sections. ADD diagnostics pair suppressed NO_ADD decisions with BASELINE at the same exact instant, retain the original regime and ATR-shock evidence, count each completed position episode once even when it contains multiple ADD decisions, and always expose `causalClaim: false`. Each executed ADD fill reports only its own FIFO realization slices, entry notional, known entry fee, realized quantity, remaining quantity, gross contribution, allocated entry/exit fees, and net contribution. Missing fee evidence keeps fee-dependent values `UNKNOWN` rather than treating fees as zero. `postDecisionExcursions` separately reports ADD-fill-price MAE/MFE through the completed episode close only when every expected persisted 1h candle interval is present; no future candle or interpolation is used. The report rejects `NaN`, infinity, `BigInt`, `undefined`, cycles, and other non-JSON values before formatting. Metrics preserve `KNOWN`, `UNKNOWN`, and `NOT_APPLICABLE` rather than substituting zero.

Observed source accounting is explicit. `observedLive.attribution.totals` contains only `SELECTED_STREAM` realization slices, while `observedLive.attribution.openingInventoryTotals` contains only left-censored `OPENING` slices. Entry attribution is under `actionDimensions.entry.sourceContributions.SELECTED_STREAM`; exit attribution keeps `actionDimensions.exit.sourceContributions.SELECTED_STREAM` and `.OPENING` separate. These totals and attribution views must not be summed. FIFO realization slices remain distinct from completed flat-to-flat position episodes, which define the default win-rate and average-trade unit.

Persisted mark coverage is reported by `observedLive.diagnostics.markPnlCurve.persistedObservationCount` and `usableObservationCount` (with the same fields on each `marketMarkPnlCurves` entry). No persisted observations emit `MARK_DATA_UNAVAILABLE`; persisted observations with none usable emit `MARK_DATA_UNUSABLE`; a usable strict subset emits `MARK_DATA_PARTIAL`. Unavailable curves are `NOT_APPLICABLE`, while unusable or partial evidence keeps the affected mark metrics `UNKNOWN`; no interpolation or future mark is substituted.

Mark exclusion manifests make that incompleteness inspectable by listing the persisted snapshot ID, observation time, market, affected gross/net scope, and stable exclusion reasons. The manifest explains why stored evidence was omitted; it does not create a replacement mark, fee, cost basis, or valuation. Fees that are left-censored before the selected period and inherent BASELINE/NO_ADD model divergence remain unresolved and continue to limit the claims the report can make.

Each `costSensitivity.assets[].cells[]` row states its scopes. `costMetricScope: "ALL_SIMULATED_FILLS"` means `turnoverKrw` and `modeledFeesKrw` include every simulated fill, including fills against opening inventory. `fifoOutcomeMetricScope: "SELECTED_STREAM_FIFO"` means `completedEpisodeCount`, `episodeWinRate`, and `profitFactor` remain selected-stream FIFO outcomes. `tradeCount`, `totalReturnPct`, `finalEquityKrw`, and `maxDrawdownPct` retain the full replay semantics recorded by the cell.

Sample support is an interpretation aid, not a statistical-significance claim: fewer than 10 observations is `INSUFFICIENT`, 10 through 29 is `PRELIMINARY`, and 30 or more is `SUPPORTED`. MAE/MFE applies only to completed simulated episodes with locally available, completed 1h OHLC evidence; its KRW values are per-unit price deltas from the first entry fill, not total-position PnL. Intrabar ordering is unknowable from OHLC, so excursions do not simulate stops or infer execution paths; incomplete interval coverage remains `UNKNOWN` with an evidence gap.

The current conditional ADD evidence freezes W1 `[2025-07-20T00:00:00Z,2025-10-25T19:00:00Z)`, W2 `[2025-10-26T00:00:00Z,2025-12-31T19:00:00Z)`, W3 `[2026-01-01T00:00:00Z,2026-04-12T19:00:00Z)`, and the 30 full-path / 10 per-window support thresholds. Future data must be evaluated as a separately identified holdout; it must not widen these windows, lower the thresholds, or rewrite the frozen result.

The optional `BROAD_LOSS_CAUSE_V1` profile evaluates `HTF_TREND_GATE`, `STRICT_PULLBACK`, `EARLY_THESIS_FAILURE`, `ADD_LIMITED`, `COOLDOWN_CONTROL`, and `COMBINED_CONSERVATIVE` as read-only execution overlays. It requires the exact eight-scenario matrix including `BASELINE` and `NO_ADD`, both BTC and ETH datasets, the frozen W1/W2/W3 windows, and the exact BASE/STRESS cost cells. Both the CLI and exported programmatic builder validate the scenario order and the ordered `BASE`/`STRESS` cell IDs, fee rates, slippage rates, and exact cell shape before any persistence read or replay construction; altered, missing, extra, reordered, or mislabeled authority input is rejected. Downstream path and component provenance is copied from those validated caller-supplied cells rather than a disconnected manifest lookup. Development replay is truncated at the exclusive `2026-04-12T19:00:00Z` cutoff and is evaluated under both `SAME_CLOSE_MODELED` and `NEXT_FRAME_MODELED` timing. Omitted sidecars leave independent no-trade proof unavailable. If either sidecar option is supplied, both are required; each sidecar must authenticate against its exact parent dataset and completely cover every nominal missing hour. Valid evidence can satisfy cadence and excursion absence coverage without creating a candle, indicator input, frame, high, or low. Partial, mismatched, corrupted, or one-sided evidence fails explicitly; an observable directional failure still produces `REJECTED`.

`broadStrategyHypothesisEvaluation.pathDiagnostics` retains every asset/scenario/timing/cost path's backtest metrics, FIFO and completed-episode diagnostics, realized-PnL curves, fee completeness, action contribution, loss streak and holding-time metrics, regime analysis, MAE/MFE evidence, and intervention outcome/reason counts. Missing evidence remains in the underlying metric and evidence-gap structures rather than being converted to zero.

Enable the section only by adding `--broad-strategy-hypothesis-profile BROAD_LOSS_CAUSE_V1` to `report:strategy-evaluation` together with the exact frozen matrix. For authenticated absence evidence, add `--btc-no-trade-evidence ./var/research/krw-btc-20250101-20260811.no-trade.json --eth-no-trade-evidence ./var/research/krw-eth-20250101-20260811.no-trade.json`. The report preserves dataset and sidecar checksums, source, collection time, coverage classification, verified/missing/uncovered counts, and development-range usage per asset. The report labels cross-asset output non-adjudicative. `ELIGIBLE_FOR_SHADOW_TEST` is a research classification only: it does not modify PositionGuard, start a runtime, call Upbit, submit an order, or approve deployment.

Add `--broad-shadow-holdout-from <ISO-8601>` and `--broad-shadow-holdout-to <ISO-8601>` together to evaluate the frozen `COMBINED_CONSERVATIVE` candidate as a separate holdout. Both authenticated no-trade sidecars are mandatory. A retrospective range must begin exactly at the frozen development cutoff `2026-04-12T19:00:00Z`; BTC and ETH use the same half-open range. The authority is frozen as `BROAD_LOSS_CAUSE_V1_HOLDOUT_AUTHORITY_V2@1c3a223b819e11d08eaac52744d1a29b2de18e2f3381a028b010a42600598e8f` at `2026-08-19T05:54:10.188Z`. The suffix is the canonical SHA-256 of the ordered BTC/ETH development authority observations: initial state, development frame fingerprint/count/bounds, hourly cadence result, and multi-timeframe feature-coverage result. The default CLI path rejects any mismatch instead of silently evaluating a changed development basis. Therefore the existing datasets ending `2026-08-11` are retrospective evidence, not prospective shadow evidence.

The holdout replays continuously from development start and does not reset cash, inventory, or research state at the cutoff. Its matrix contains `BASELINE`, `NO_ADD`, and `COMBINED_CONSERVATIVE` for BASE/STRESS costs and SAME_CLOSE/NEXT_FRAME timing. Candidate and anchor return/drawdown values remain ratios, while their deltas and tolerances are percentage points; turnover and fee values/deltas are KRW. Metric-specific evidence controls `PASS`/`FAIL`/`UNKNOWN`, while any incomplete cell still prevents shadow support. Development carry-in requires complete hourly cadence and complete consumed `1h`/`4h`/`1d` feature coverage, calculated from candles clipped to the last analyzed frame so post-range data cannot change earlier coverage. A test-injected authority verifier is reported as `UNVERIFIED_TEST_OVERRIDE`, keeps carry-in incomplete, and cannot support continued shadow. A known unfavorable comparison yields `REJECTED`; otherwise incomplete cadence, no-trade, lifecycle, fee, finite-metric, or carry-state evidence, or fewer than 10 completed episodes in any candidate or anchor cell yields `INSUFFICIENT`. Only complete favorable evidence yields `SUPPORTS_CONTINUED_SHADOW`, which still does not approve strategy changes, LIVE execution, or deployment.

When the holdout section is present, `broadStrategyShadowHoldoutDiagnostics` summarizes the exact 32 comparisons per asset (`2` timing models x `2` cost cells x `2` anchors x `4` aggregate metrics). This is a read-only descriptive technical summary with `causalClaim: false` and `deploymentApproval: false`. Its failure counts and association signals do not identify which `COMBINED_CONSERVATIVE` component rule caused an outcome and must not be used by themselves as a basis for strategy changes or deployment.

### Holdout Component Ablation Diagnostics

When the frozen combined holdout is evaluated, the optional JSON field `broadStrategyShadowHoldoutComponentDiagnostics` adds a separate retrospective episode/component diagnostic. It runs exactly four leave-one-component-out variants of `COMBINED_CONSERVATIVE` with existing thresholds and precedence unchanged:

- `COMBINED_MINUS_HTF_TREND_GATE`
- `COMBINED_MINUS_EARLY_THESIS_FAILURE`
- `COMBINED_MINUS_ADD_LIMITED`
- `COMBINED_MINUS_COOLDOWN_CONTROL`

`STRICT_PULLBACK` is not a component of `COMBINED_CONSERVATIVE` and is never an ablation target. There is no parameter search and no additional combination. The diagnostic uses exactly 32 continuous replay paths: `2` assets (BTC and ETH) x `2` modeled timings (`SAME_CLOSE_MODELED`, `NEXT_FRAME_MODELED`) x `2` frozen cost cells (`BASE`, `STRESS`) x `4` variants. Each variant is compared only to the full combined reference in the same asset/timing/cost cell; BTC and ETH capital remains independent.

Episodes are not matched by overlapping time ranges, path-local IDs, or fill IDs. The only direct match is a unique exact first executed `ENTER` decision instant, compared as an explicit-timezone epoch-nanosecond timestamp. FIFO realization slices stay distinct from flat-to-flat position episodes. A partial exit remains part of its original position episode. Carry-in episodes, episodes open at the exclusive `holdoutTo`, unknown net outcomes, unmatched reference-only wins/losses, ablation-only episodes, and path divergence are explicitly classified; carry-in and open episodes are reported but excluded from closed known-net-PnL comparisons.

JSON retains all per-cell evidence rather than only aggregate counts. Each episode envelope carries `scenario`, `asset`, `market`, `timingModel`, `costCellId`, `episodeId`, `entryFillIds`, `exitFillIds`, `modeledFillAttributionFillIds`, legacy `interventionFillIds`, `realizationSliceIds`, `interventionEvidenceIds`, decision/execution/open/close timestamps with epoch-nanosecond identities, gross/fee/net realized-PnL fields, `openedQuantity`, `realizedQuantity`, `remainingQuantity`, `holdingDurationMs`, `carryIn`, `openAtTo`, and `netOutcomeKnown`. The separate ordered `referenceInterventions` and `ablationInterventions` records retain a stable ID and evidence type; scenario/asset/market/timing/cost identity; decision evidence ID, time, epoch, and frame index; original/effective action, outcome, and reason; and nullable fill, strategy-decision, and episode links. A suppressed intervention with no fill remains explicit with null fill/decision links. Outputs are detached from replay inputs and deeply frozen. The analysis includes no observations at or after `holdoutTo`, so future evidence cannot enter the result.

Each component classification checks these nine completeness gates for every timing/cost cell:

- `cadenceComplete`
- `featureCoverageComplete`
- `carryInStateComplete`
- `referenceLifecycleComplete`
- `ablationLifecycleComplete`
- `referenceFeeComplete`
- `ablationFeeComplete`
- `referenceFiniteMetricsComplete`
- `ablationFiniteMetricsComplete`

Any incomplete gate, unresolved carry/open/unknown/path-diverged episode evidence, fewer than `10` completed episodes on either path, or no closed known-PnL episode comparison produces `INSUFFICIENT_EVIDENCE`. Complete evidence uses frozen tolerances of `0.000001` percentage points for return/drawdown and `0.000000001` KRW for turnover/fees. It can then report only `PROTECTIVE_ASSOCIATION`, `HARM_ASSOCIATION`, `MIXED_ASSOCIATION`, or `NO_MEASURABLE_DIFFERENCE`; these are descriptive associations, never causal component effects.

This diagnostic was designed after an observed holdout outcome, so it is retrospective and non-causal. It always sets `readOnly: true`, `causalClaim: false`, `deploymentApproval: false`, and `prospectiveApproval: false`. It cannot approve a strategy change, deployment, a prospective test, shadow operation, or LIVE execution. It is not connected to execution, runtime, APIs, Telegram, orders, `/sync`, scheduler, migrations, or database-write paths.

## Prospective Component Shadow Protocol

`PCS-2026-001` is publicly registered. Its immutable no-peek observation window is `[2026-08-23T08:00:00.000Z,2026-12-21T08:00:00.000Z)`, equivalent to 2026-08-23 17:00 KST through 2026-12-21 17:00 KST. Before `window.from` it is registered and awaiting observation; from `window.from` until `window.to`, reports remain `COLLECTING` and expose no outcome metrics. Registration does not grant deployment, `DRY_RUN`, scheduler, order, or `LIVE` authority.

The prospective candidate policy and evaluation graph is pure, execution-disconnected, configuration-free, and has no runtime reachability. This isolation statement does not apply to persisted candidate deployment/state repositories or the runtime candidate initializer. The prospective graph exists only for post-closure deployment readiness; current percentage-based sizing and all execution guards are unchanged.

The public authority chain is:

- implementation publication (`Publication A`): `ed4de872d07f416c77d5f05b9dc657eae676155e`
- registration publication (`Publication B`): `358113dba5cd0425161a4aed0827f496d268d1f5`
- successful GitHub Actions commitment run: `32348730422`
- registration payload SHA-256: `978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40`

The registration artifact and registry entry are `docs/research/prospective-shadow/PCS-2026-001.registration.json` and `docs/research/prospective-shadow/registry.jsonl`. The successful Actions metadata has also been preserved in the Git-ignored local research authority archive because the hosted artifact expires before the observation window ends. Do not change the registration, registered scenarios, thresholds, costs, timing models, observation window, or commitment workflow in response to evidence observed during the window.

The non-binding preview command used before this registration remains documented for provenance. Re-running it now performs only a local hypothetical calculation; it does not replace, update, or create another active registration:

```powershell
npm.cmd run research:prospective-shadow -- preview `
  --implementation-commit-sha <40-character-commit-sha> `
  --development-authority-sha256 <64-character-sha256> `
  --retrospective-report-sha256 <64-character-sha256>
```

`preview` is a local, non-binding pure calculation. It performs no file, Git, network, database, Upbit, Telegram, scheduler, strategy, sync, or order operation, and it does not activate the experiment. It reports the canonical bytes and paths that the subsequent `register` command would write. The completed registration sampled its clock again, so its `registeredAt`, `[from,to)` window, canonical bytes, and payload SHA-256 were not inferred from an earlier preview.

Text is the default output. Add `--output json` for the complete stable machine-readable preview; both formats include the canonical registration and registry bytes.

Activation was deliberately split into two public stages:

1. **Publication A completed:** the complete implementation and `.github/workflows/prospective-shadow-registration.yml` were publicly pushed on canonical `origin/main` at `ed4de872d07f416c77d5f05b9dc657eae676155e`.
2. The registration authority was frozen against Publication A without observing future-window evidence.
3. **Publication B completed:** the separate one-parent commit `358113dba5cd0425161a4aed0827f496d268d1f5` added only `docs/research/prospective-shadow/PCS-2026-001.registration.json` and `docs/research/prospective-shadow/registry.jsonl`. GitHub server time for successful run `32348730422` was `2026-08-20T08:25:23Z`, more than 48 hours before `window.from`.
4. The successful Publication B Actions metadata and validated commitment were preserved locally. Commands that inspect or evaluate the authority must still use the explicit `I_VERIFIED_PUBLIC_GITHUB_COMMITMENT` confirmation rather than inferring trust from local files.

The manually triggered/read-only GitHub Actions workflow is an auditable, non-cryptographic lookup. It has only `contents: read` and `actions: read`, queries the Actions REST endpoint only for its own exact run ID, verifies repository/branch/head identity, and uses the returned GitHub server `created_at`; runner clocks and Git author/committer timestamps are not commitment time. Pinned Actions and credential-free checkout are required. The checked-in `.github/scripts/prospective-shadow-commitment.mjs` validator is regenerated locally with `npm run build:prospective-commitment-bundle`; the workflow performs no package installation, so its only direct network request is the exact own-run Actions lookup. The workflow never receives trading secrets and never runs the app, operational DB, market acquisition, Telegram, scheduler, strategy, sync, or order paths. Because Actions artifacts expire before the 120-day window, the operator must preserve the successful metadata outside ephemeral artifact retention.

The registered no-peek interval is exactly 120 fixed days and uses `[from,to)`. Do not acquire or evaluate the final evidence before `window.to`, interpolate missing candles, tune candidates, or select a winner during the window. At or after `window.to`, acquire immutable BTC and ETH evidence for the exact registered range, then perform the separate manual closure workflow run and confirm its server `created_at` and complete canonical path history with `I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE` before final evaluation. Missing, abandoned, stale, superseded, or manually unconfirmed authority is `REGISTRATION_INVALID`; complete evidence may otherwise resolve to `REJECTED`, `INSUFFICIENT`, or `SUPPORTS_CONTINUED_SHADOW`. These statuses are research classifications only and never approve deployment, strategy changes, API/DB wiring, Upbit access, Telegram behavior, scheduler/runtime startup, orders, DRY_RUN, or LIVE operation.

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
