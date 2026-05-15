# Product Boundary

## Mission
Build an Upbit-based BTC/ETH spot execution system that can progress from `DRY_RUN` validation toward live trading without changing the core contracts for orders, fills, balances, risk, reconciliation, and operator control.

## In Scope
- Upbit private authentication and request signing
- BTC and ETH spot trading against KRW markets only
- deterministic, inspectable, rule-based strategy decisions
- order validation via exchange metadata and order-test path
- order create, cancel, and status inquiry interfaces
- balance and position snapshot persistence
- balance and position drift detection against persisted local state and fill history
- order, fill, reconciliation, and risk event persistence
- startup recovery and operator-triggered reconciliation entry points
- Telegram reporting and operator controls
- execution recovery and reconciliation loops

## Out of Scope
- manual balance or position entry through Telegram
- leveraged, margin, futures, or derivatives trading
- discretionary or LLM-based trade decisions
- news, sentiment, or narrative-based trading inputs
- multi-exchange support in the first release
- hidden fallbacks that silently alter execution behavior

## Truth Sources
The system of record is:
1. exchange state from Upbit
2. the local execution database

Telegram is not a truth source for balances, positions, or fills.

## Execution Modes
- `DRY_RUN`: default mode; no live order transmission is permitted
- `LIVE`: implemented as a gated capability but disabled by default

Live mode requires both:
- explicit user intent
- explicit configuration enabling live order submission

The application may wire the live Upbit adapter only when `APP_EXECUTION_MODE=LIVE`, `ENABLE_LIVE_ORDERS=true`, and Upbit credentials are configured. If any condition is missing, the runtime must fall back to the dry-run send path.
`MAX_LIVE_ORDER_VALUE_KRW` is an optional live-only guardrail that caps a single live order without changing the ratio-based strategy model.

## Asset And Market Limits
- assets: `BTC`, `ETH`
- markets: `KRW-BTC`, `KRW-ETH`
- spot only

## Operator Interface
Telegram may expose:
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

Telegram commands are operational controls and inspection requests, not portfolio data entry.
`/help` may list supported Telegram commands from static command contracts and safety boundaries, but it must not trigger exchange reads, sync, strategy runs, scheduler ticks, order mutation, or live order transmission.
`/config` may inspect non-secret runtime configuration, explicit risk limits, and live-send blockers, but it must render only configured/not-configured booleans for secrets and must not mutate runtime or exchange state.
`/readiness` may summarize read-only operator readiness from runtime configuration, persisted execution state, runtime worker status, latest persisted health records, active-order counts, recent risk-block counts, and pending notification counts, but it must not perform active probes, poll Telegram, call Upbit, trigger sync, run strategies, tick schedulers, mutate offsets, submit/cancel orders, or deliver notifications.
Telegram inbound polling is a transport for those commands only; it is disabled by default, accepts only the configured operator chat, and persists only update-offset transport progress.
Telegram `/start` is treated as a `/help` alias for first-run bot UX and does not add a separate execution command.
`/inbound` may inspect runtime inbound polling status and persisted offset progress, but it must not poll Telegram or route commands by itself.
`npm run smoke:telegram:inbound` may perform one bounded Telegram `getUpdates` poll for operator validation, but it forcibly uses `DRY_RUN`, disables live-send and scheduler paths, and never starts the long-running polling loop.
`/alerts` may summarize persisted operator notifications, recent delivery-run rows, recent delivery-attempt audit rows, and derived delivery-worker queue metrics, but none of them become trading truth sources.
`/order <order-id|identifier>` may inspect one persisted order, its local lifecycle events, and its fills, but it must not query Telegram as truth or trigger exchange-side mutation.
`/run BTC|ETH` may request one deterministic PositionGuard strategy cycle for a supported asset, but it must route through the configured execution path and inherits the default `DRY_RUN` live-send blockers.
`/scheduler` may inspect persisted `strategy_scheduler_runs`, but it must not trigger execution or mutate portfolio truth.
The strategy scheduler may run the same deterministic cycle automatically only when `STRATEGY_SCHEDULER_ENABLED=true`; it is disabled by default and does not bypass execution-state, risk, or live-send gates.
Any local script that enables the live scheduler must keep automatic startup execution disabled by default and require a separate explicit confirmation that scheduled live orders are understood.
Startup recovery is read-only against exchange truth and must never create or cancel orders.
When startup recovery confirms unresolved portfolio drift against persisted state, the operator state may move into `DEGRADED` without enabling any live path.

## Design Consequences
- every order must have an explicit lifecycle record
- every fill must be recoverable from reconciliation
- every exchange-history recovery uncertainty must remain explicit through coverage, retention-assumption, and confidence metadata
- every risk rejection must be persisted
- every unexplained balance or position drift must be persisted as both reconciliation evidence and risk evidence
- every transition into pause or kill-switch state must be explicit and inspectable
- every transition into or out of `DEGRADED` must be explicit and inspectable
- every scheduler-triggered cycle must leave inspectable run history without becoming portfolio truth
- live-send capability must stay behind a separate safety gate even after implementation exists
