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

## Asset And Market Limits
- assets: `BTC`, `ETH`
- markets: `KRW-BTC`, `KRW-ETH`
- spot only

## Operator Interface
Telegram may expose:
- `/status`
- `/statehistory`
- `/synchistory`
- `/recovery`
- `/alerts`
- `/risks`
- `/balances`
- `/positions`
- `/orders`
- `/pause`
- `/resume`
- `/killswitch`
- `/sync`

Telegram commands are operational controls and inspection requests, not portfolio data entry.
`/alerts` may summarize persisted operator notifications, recent delivery-attempt audit rows, and derived delivery-worker queue metrics, but none of them become trading truth sources.
Startup recovery is read-only against exchange truth and must never create or cancel orders.
When startup recovery confirms unresolved portfolio drift against persisted state, the operator state may move into `DEGRADED` without enabling any live path.

## Design Consequences
- every order must have an explicit lifecycle record
- every fill must be recoverable from reconciliation
- every exchange-history recovery uncertainty must remain explicit through coverage and confidence metadata
- every risk rejection must be persisted
- every unexplained balance or position drift must be persisted as both reconciliation evidence and risk evidence
- every transition into pause or kill-switch state must be explicit and inspectable
- every transition into or out of `DEGRADED` must be explicit and inspectable
- live-send capability must stay behind a separate safety gate even after implementation exists
