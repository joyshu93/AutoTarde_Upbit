# AGENTS.md

## Mandatory Reading Order
Before writing or modifying code in this repository, every agent must read these files first:
1. `PRODUCT_BOUNDARY.md`
2. `ARCHITECTURE.md`
3. `RISK_POLICY.md`
4. `ORDER_LIFECYCLE.md`
5. `README.md`

Treat those files as authoritative for product scope, module boundaries, risk controls, and execution safety.

## Reference Repository Rule
`C:\Users\D-\Documents\Codex_Project\PositionGuard` is a read-only reference repository.

Agents may inspect it to selectively reuse:
- deterministic pure logic
- reusable TypeScript type patterns
- public Upbit normalization patterns
- modular repository boundaries

Agents must not carry over any record-only or coaching-first product assumptions from that repository.
Agents must never modify the reference repository.

## Product Boundary
This project is an Upbit-only BTC/ETH spot execution system.

It is:
- a deterministic rule-based execution stack
- an operator-visible trading system with explicit persistence
- a Telegram reporting and control surface
- a local-database-backed execution and reconciliation service

It is not:
- a coaching bot
- a manual cash or position recorder
- a discretionary LLM trading system
- a futures, margin, or leveraged product
- a multi-exchange router

## Execution-Safe Contract
The default execution mode must remain `DRY_RUN`.

Agents must not enable live order transmission unless the user explicitly requests it. Even when live mode is implemented in code, it must remain gated behind explicit configuration that defaults to disabled.

Required safety expectations:
- global kill switch support
- explicit pause and resume semantics
- duplicate order protection
- stale price protection
- minimum order value protection
- explicit failure recording over silent recovery
- persistence-aware recovery for request and exchange-state mismatches

## Architecture Expectations
- Use TypeScript with strict typing.
- Prefer a modular monolith.
- Keep pure logic separate from side effects.
- Keep modules isolated: `domain`, `strategy`, `risk`, `exchange`, `execution`, `reconciliation`, `telegram`, `db`.
- Avoid hidden defaults for money, quantities, prices, markets, or execution behavior.
- Model orders, fills, balances, positions, risk events, and execution state with explicit types and tables.

## Supported Scope
- Exchange: Upbit only
- Assets: BTC and ETH only
- Markets: `KRW-BTC`, `KRW-ETH`
- Venue type: spot only

## Telegram Boundary
Telegram is an operator interface only. It may:
- report execution and reconciliation outcomes
- notify order acceptance, rejection, cancellation, and fills
- expose inspection commands
- expose operator control commands such as `/pause`, `/resume`, `/killswitch`, `/sync`

Telegram must not:
- accept manual cash inputs
- accept manual position inputs
- act as the system of record for balances or positions

## Subagent Policy
- Use subagents aggressively for non-trivial work.
- Split separable streams unless there is a clear blocking reason not to.
- Give each subagent a clear file ownership scope.
- Keep the main agent responsible for product boundary decisions, live-trading safety review, contract consistency, final integration, and final verification.
- Final reporting must identify which subagents were used, what each one handled, which files they changed in their scope, and what validation was run after integration.

## Documentation Rule
When behavior, safety, or interfaces change, update the relevant root docs in the mandatory reading list.
