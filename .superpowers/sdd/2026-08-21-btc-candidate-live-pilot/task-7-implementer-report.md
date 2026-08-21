# Task 7 Implementer Report

## Scope

- Implemented Task 7 only in `btc-candidate-live-pilot`.
- Added account-scoped send authority to `ExecutionService` after idempotency duplicate detection and before execution, risk, exchange validation, or persistence.
- Preserved `ExecutionService` as the sole production `.createOrder(` caller.
- Kept all work offline with in-memory fakes and temporary SQLite test data. No operational database, Upbit, Telegram, LIVE process, scheduler, sync, secrets, local scripts, network, or activation settings were accessed.
- No subagents were used.

## RED Evidence

1. `npm.cmd run test`
   - Result: expected compile failure.
   - Evidence: `AppConfig.accountExecutionLeaseMs` and `ExecutionService` lease dependencies were absent from the production contracts.
2. `npm.cmd run build`, then the focused env harness command below.
   - Result: expected runtime failure.
   - Evidence: `ACCOUNT_EXECUTION_LEASE_MS="1.5"` produced `1.5` instead of the safe `30000` fallback, proving generic positive-number parsing was insufficient for lease storage.

## GREEN Evidence

1. `npm.cmd run typecheck`
   - Result: exit `0`.
2. `npm.cmd run build`
   - Result: exit `0`.
3. `node --input-type=module -e "await import('./dist/tests/env.test.js'); await import('./dist/tests/execution-service.test.js'); await import('./dist/tests/execution-send-authority.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"`
   - Result: all focused environment, lifecycle, lease, uncertain-send, duplicate-identifier, post-send failure, and static-authority tests passed.
4. `npm.cmd run test`
   - Result: exit `0`; complete aggregate suite passed.
   - Note: Node emitted its existing experimental SQLite warning only.
5. `git diff --check`
   - Result: exit `0`; only informational CRLF conversion warnings were emitted.

## Changed Files

- `src/modules/execution/execution-service.ts`: required lease injection, atomic intent/result persistence, `SUBMITTING` boundary, typed definitive/uncertain outcome handling, duplicate-identifier recovery posture, automatic fault pause attempts, and fatal post-send persistence failure.
- `src/modules/execution/interfaces.ts`: required discriminated `SubmitOrderFromDecisionResult`.
- `src/app/env.ts`, `src/app/create-app.ts`: explicit positive-safe-integer `ACCOUNT_EXECUTION_LEASE_MS`, default `30000`, and lease-store wiring.
- `src/domain/types.ts`, `src/modules/db/repositories/sqlite-database.ts`, `src/modules/telegram/presentation/risks.ts`: required `ACCOUNT_EXECUTION_LEASE_BLOCKED` risk vocabulary and persistence/presentation exhaustiveness.
- `tests/execution-send-authority.test.ts`: new focused authority tests.
- Updated direct config fixtures, execution test construction, run-all registration, risk presentation expectation, and required root safety documentation.

## Safety Analysis

- Duplicate detection occurs before lease acquisition. Lease conflict creates no order row and sends no exchange request; it persists `ACCOUNT_EXECUTION_LEASE_BLOCKED` and attempts a fault pause.
- Lease ownership is acquired before execution-state, risk, chance, order-test, or persistence work. Proven-safe pre-send exits and definitive terminal outcomes release it; accepted non-terminal, uncertain, and post-send persistence-failure paths retain it.
- Intent persistence is atomic as `PERSISTED` plus `ORDER_PERSISTED`; the local row moves to `SUBMITTING` before the only exchange create call. A pre-send transition failure makes no send.
- Typed definitive rejections persist as `REJECTED`. `duplicate_identifier`, typed uncertainty, and untyped create-order exceptions all persist as `RECONCILIATION_REQUIRED`, reserve the identifier, attempt automatic pause, and never resend.
- If post-send atomic persistence fails, the durable row remains `SUBMITTING`, the lease remains held, automatic pause is attempted, and a fatal safety error is thrown.
- DRY_RUN uses the same general account lease and releases it only after atomic simulated terminal evidence is durable.

## Self-Review

- Confirmed no production TypeScript file other than `src/modules/execution/execution-service.ts` contains `.createOrder(`.
- Confirmed live execution remains configuration-gated and defaults remain `DRY_RUN`/live-disabled.
- Confirmed configuration requires a positive safe integer lease duration, preventing an invalid duration from reaching lease persistence.
- Confirmed no changes to pilot identity or activation parsing.

## Commit

- Implementation commit: `6af3cca feat: serialize account order submission`.

## Fix Round 1/5 Scope

- Repaired the pre-send lease safety boundary: acquisition arithmetic is safe-integer checked, acquisition ambiguity records `ACCOUNT_EXECUTION_LEASE_BLOCKED` and requires a persisted fault pause, acquired leases inspect all account active/uncertain local orders, and ownership is renewed immediately before the sole send.
- Added named fatal safety errors for lease acquisition, renewal, and release ambiguity, and for an automatic pause persistence failure. A failed pause can no longer return a safe blocked outcome.
- Made terminal `FILLED` evidence atomic: `persistExchangeSubmission` now accepts a terminal event and both repositories write/retry/rollback the submitted event, terminal event, fills, and order as one lifecycle operation.
- Propagated `submissionOutcome` through the Telegram controller and scheduler. Reconciliation and lease blocking become failed runs; duplicates are explicit skips; only `REJECTED` receives scheduler rejection wording.
- Added `ACCOUNT_EXECUTION_LEASE_MS` to the README canonical environment list and ignored `.superpowers/sdd/`. The two historical scratch reports are removed from Git tracking but preserved locally.

## Fix Round 1/5 RED Evidence

1. `npm.cmd run test -- execution-send-authority`
   - Result: expected failures before the implementation.
   - Evidence: lease acquisition errors escaped without risk/pause evidence; cross-market `RECONCILIATION_REQUIRED` did not block; renewal was missing; pause failure was swallowed; release failure was ignored.
2. `npm.cmd run test -- execution-send-authority`
   - Result: expected integration failures after the first implementation increment.
   - Evidence: deterministic clocks did not extend the renewed lease, and scheduler fixtures exposed the old acceptance-only rejection vocabulary.

## Fix Round 1/5 GREEN Evidence

1. `npm.cmd run build`
   - Result: exit `0`.
2. `npm.cmd run test -- execution-send-authority strategy-run-controller strategy-scheduler db-sqlite-wiring`
   - Result: exit `0`; requested lease, controller/scheduler, and in-memory/SQLite lifecycle coverage passed. The harness loads the full registry, so this command also completed the aggregate registered suite.
3. `npm.cmd run test`
   - Result: exit `0`; complete aggregate suite passed.
4. `git diff --check`
   - Result: exit `0`; no whitespace errors.

## Fix Round 1/5 Safety Analysis And Self-Review

- Validation can overrun the original lease. The service now renews and verifies the owner with a fresh clock instant after durable `SUBMITTING`; lost or thrown renewal sends zero requests, retains `SUBMITTING` and the lease, records lease risk, requires pause, and throws.
- Once the lease is acquired, any account-wide active or uncertain local order blocks before validation, intent persistence, or send. This prevents a different market or idempotency key from bypassing recovery.
- Release is attempted exactly once only for safe pre-send and definitive terminal outcomes. A false or thrown release records risk, requires pause, and throws without recursively releasing.
- DRY_RUN and an immediately `FILLED` exchange response atomically contain `ORDER_SUBMITTED`, `ORDER_FILLED`, fills, and the terminal order; neither backend can commit a partial terminal lifecycle.
- Static send authority remains solely `src/modules/execution/execution-service.ts`. No operational services, network, secrets, activation settings, or subagents were used.

## Fix Round 1/5 Commit

- `ed6304f fix: fail closed on lease uncertainty`

## Fix Round 2/5 Scope

- Added a final pre-send authority guard after lease renewal. It reads account-wide active/uncertain orders first, then authoritative execution state last; there is no awaited authority-changing operation between that final state result and the only `createOrder` call.
- A concurrent `SUBMITTING` takeover or final active/state read ambiguity now records `ACCOUNT_EXECUTION_LEASE_BLOCKED` where persistence is available, requires pause, retains the local `SUBMITTING` recovery evidence, and sends zero orders.
- `recordLeaseBlockedAndPause` now attempts the load-bearing pause even if risk-event persistence fails, with explicit fatal errors for lost evidence and aggregated lost-evidence-plus-pause failures.
- Shared lifecycle validation now rejects identical submission and terminal event ids before either persistence backend can write.
- Corrected the pause-failure fixture to seed a contemporaneous, unexpired lease conflict rather than an expired epoch lease.

## Fix Round 2/5 RED Evidence

1. `npm.cmd run test -- execution-send-authority`
   - Result: exit `1` before edits, with the independently reproduced failure `FAIL automatic pause failure after lease conflict is fatal rather than a safe blocked result` caused by the expired-epoch fixture.
2. `npm.cmd run test -- execution-send-authority db-sqlite-wiring`
   - Result: exit `1` before production edits.
   - Evidence: the new in-memory shared-contract case reported `Missing expected rejection` for `submissionEvent.id === terminalEvent.id`; the new final-authority and risk/pause tests were added to fail against the missing final re-read and save-risk short circuit.

## Fix Round 2/5 GREEN Evidence

1. `npm.cmd run typecheck`
   - Result: exit `0`.
2. `npm.cmd run test -- execution-send-authority db-sqlite-wiring strategy-run-controller strategy-scheduler`
   - Result: exit `0`; focused Task 7 coverage passed. The harness loads the complete registry, so the registered aggregate tests also completed.
3. `npm.cmd run test`
   - Result: exit `0`; full aggregate suite passed.

## Fix Round 2/5 Self-Review

- Re-checked all prior reviewer verdicts: lease acquisition, account-wide blocking, renewal, release ambiguity, required pauses, terminal atomicity, outcome propagation, environment documentation, scratch hygiene, and sole-send authority remain intact.
- The final guard excludes the service's own durable `SUBMITTING` row but blocks every other active/uncertain row; a concurrent takeover also pauses execution, and the final execution-state read catches that pause before send.
- Both final-read failure tests prove zero `createOrder` calls and a persisted lease-block risk plus automatic pause. Both in-memory and SQLite paths share the new duplicate-event rejection and prove no partial mutation.
- No Upbit, Telegram, operational database/process, secrets, network, `.ps1`, or subagents were accessed.

## Fix Round 2/5 Commit

- `ce9a97a fix: close pre-send authority race`

## Fix Round 3/5 Scope

- Bound `ExecutionService` to the configured adapter path with a required `sendPath` dependency supplied by `createApp`.
- Extended the final pre-send authority guard to require persisted `LIVE` mode plus `ENABLED` gate for `LIVE_ADAPTER`, or persisted `DRY_RUN` mode plus `DISABLED` gate for `DRY_RUN_ADAPTER`.
- Made initial post-acquisition account-active and execution-state reads fail closed: either read exception retains the lease, writes `ACCOUNT_EXECUTION_LEASE_BLOCKED` where possible, requires the existing durable automatic pause path, and prevents every send.
- Updated lifecycle/risk documentation to state the exact final mode-and-gate authority pairing.

## Fix Round 3/5 RED Evidence

1. Added focused final-LIVE-mode, final-LIVE-gate, final-DRY_RUN-mismatch, initial-active-read-failure, and initial-state-read-failure cases in `tests/execution-send-authority.test.ts` before production edits.
   - `npm.cmd run typecheck`
   - Result: exit `2` as expected.
   - Evidence: the focused tests required an explicit `sendPath`, but `ExecutionService` had no such production dependency (`TS2353` in `tests/execution-send-authority.test.ts`). This exposed the missing configured-send-path authority contract.
2. First complete-suite check after adding the explicit contract:
   - `npm.cmd run test`
   - Result: exit `1` as expected from a stale fixture.
   - Evidence: `execution service records order mode from persisted operator state` intentionally seeded persisted `LIVE`/`ENABLED` but declared `DRY_RUN_ADAPTER`; the new final guard blocked it. The fixture was corrected to declare `LIVE_ADAPTER`, preserving the exact test intent.

## Fix Round 3/5 GREEN Evidence

1. `npm.cmd run typecheck`
   - Result: exit `0`.
2. `npm.cmd run build; node --input-type=module -e "const harness = await import('./dist/tests/harness.js'); await import('./dist/tests/db-sqlite-wiring.test.js'); await import('./dist/tests/strategy-run-controller.test.js'); await import('./dist/tests/strategy-scheduler.test.js'); await import('./dist/tests/execution-service.test.js'); await import('./dist/tests/execution-send-authority.test.js'); await harness.runRegisteredTests();"`
   - Result: exit `0`; focused SQLite, controller, scheduler, execution-service, and Task 7 authority coverage passed, including all new final-state and initial-read failure cases.
3. `npm.cmd run test`
   - Result: exit `0`; complete serial aggregate suite passed. Node emitted its existing experimental SQLite warning only.
4. `git diff --check`
   - Result: exit `0`; no whitespace errors (only informational CRLF conversion warnings).
5. `rg -n "\.createOrder\s*\(" src -g "*.ts"`
   - Result: exactly one production caller: `src/modules/execution/execution-service.ts`.

## Fix Round 3/5 Safety Analysis And Self-Review

- Final authority now binds the persisted state to the actual configured adapter path. A running state with an independently changed mode or gate cannot pass through to a LIVE or DRY_RUN send.
- The final account-wide active-order read remains before the final execution-state read; the state read is the final await before the sole `createOrder` call. The only following await is the create call itself.
- Initial post-acquisition read exceptions no longer take the safe-release path. They retain the lease and use the round-2 risk-plus-required-pause aggregation behavior, so risk evidence loss and/or pause persistence loss remains fatal.
- Focused tests prove all three final path mismatches and both initial read exceptions make zero `createOrder` calls, persist lease-block evidence when available, and pause execution.
- Re-checked earlier reviewer verdicts: lease acquisition/renewal/release ambiguity, active-order blocking, atomic terminal evidence, pause ordering, controller/scheduler semantics, environment configuration, scratch hygiene, and single send authority are unchanged.
- No Upbit, Telegram, operational database/process, secrets, network, `.ps1`, activation settings, or subagents were accessed.

## Fix Round 3/5 Changed Files

- `src/modules/execution/execution-service.ts`
- `src/app/create-app.ts`
- `tests/execution-send-authority.test.ts`
- `tests/execution-service.test.ts`
- `tests/position-guard-runner.test.ts`
- `RISK_POLICY.md`
- `ORDER_LIFECYCLE.md`

## Fix Round 3/5 Commit

- `9620e8a fix: bind final send authority to state`

## Fix Round 4/5 Scope

- Replaced the independently supplied exchange adapter and send-path label with a required discriminated execution adapter. `DryRunExchangeAdapter` carries `DRY_RUN_ADAPTER`, `UpbitPrivateClient` carries `LIVE_ADAPTER`, and production wiring selects the union as one dependency.
- Captured the exact initial persisted `executionMode`/`liveExecutionGate` tuple and require both fields to remain unchanged at the final authoritative read immediately before the sole send. Any drift retains `SUBMITTING` recovery evidence, records lease-block evidence where possible, requires pause, and sends zero orders.
- A live channel now requires exact persisted `LIVE`/`ENABLED` authority initially and finally. A dry channel accepts every non-fully-live stable tuple, including `DRY_RUN`/`ENABLED` and `LIVE`/`DISABLED`, but rejects a fully-live tuple and every tuple transition.
- Bound persisted order mode, lifecycle event source, simulated terminal fills, and `SubmitOrder` outcomes to the actual tagged channel. A dry channel is always simulated/local; a live channel is always exchange-backed and never synthesizes a fill.
- Preserved the round-3 initial-read ambiguity handling and the earlier lease, active-order, atomic-lifecycle, recovery, controller, and scheduler invariants.

## Fix Round 4/5 RED Evidence

1. Added focused authority cases before production edits and ran the compiled Task 7 test directly.
   - Result: five expected failures.
   - Evidence: `DRY_RUN`/`DISABLED` could upgrade to `LIVE`/`ENABLED` and send; stable `DRY_RUN`/`ENABLED` faulted; stable `LIVE`/`DISABLED` was rejected; and isolated mode-only and gate-only drift between accepted dry tuples was not blocked.
2. Changed the test constructors to require a discriminated execution channel before changing production constructors.
   - `npm.cmd run typecheck`
   - Result: expected compile failures in stale `exchangeAdapter`/`sendPath` constructors and production-wiring test fakes, proving the independent-label API still existed.

## Fix Round 4/5 GREEN Evidence

1. `npm.cmd run typecheck`
   - Result: exit `0`.
2. Direct compiled Task 7/controller/scheduler/SQLite bundle covering `create-app`, `db-sqlite-wiring`, `execution-service`, `execution-send-authority`, `strategy-run-controller`, and `strategy-scheduler`.
   - Result: exit `0`; all focused cases passed, including isolated mode-only and gate-only drift, both channel incompatibility directions, both accepted mixed dry tuples, and stable live authority.
3. `npm.cmd run test`
   - Result: exit `0` on the complete serial run; the prospective child reported `102` tests, `102` passed, `0` failed. The first sandboxed attempt reached green main tests but its esbuild child was denied filesystem access, so the same offline command was rerun with approved filesystem access and passed.
4. `rg -n "\.createOrder\s*\(" src -g "*.ts"`
   - Result: exactly one production caller in `src/modules/execution/execution-service.ts`.
5. `git diff --check`
   - Result: exit `0`; no whitespace errors, with informational CRLF conversion warnings only.

## Fix Round 4/5 Safety Analysis And Self-Review

- The final state read remains the last await before `executionAdapter.createOrder`; there is no intervening asynchronous operation.
- The initial persisted tuple is copied before risk/order work and both mode and gate are compared independently at the final read, so removing either comparison breaks focused tests.
- Economic and risk calculations may use the initial snapshot, but no post-send transmission classification or exchange evidence reads stale persisted mode. The shared atomic validator also enforces event-source consistency with the channel-bound order mode.
- Test fakes implement the tagged interfaces structurally; no unsafe casts or weakened adapter types were introduced.
- No Upbit, Telegram, operational database/process, secrets, network, `.ps1`, activation settings, push, merge, or subagents were accessed.

## Fix Round 4/5 Changed Files

- `src/modules/execution/execution-service.ts`
- `src/modules/exchange/interfaces.ts`
- `src/modules/exchange/upbit/private-client.ts`
- `src/app/create-app.ts`
- `src/modules/db/repositories/atomic-lifecycle-validation.ts`
- `tests/execution-send-authority.test.ts`
- `tests/execution-service.test.ts`
- `tests/create-app.test.ts`
- `tests/position-guard-runner.test.ts`
- `tests/db-sqlite-wiring.test.ts`
- `PRODUCT_BOUNDARY.md`
- `ARCHITECTURE.md`
- `RISK_POLICY.md`
- `ORDER_LIFECYCLE.md`
- `README.md`

## Fix Round 4/5 Commit

- This report is committed with the round-4 implementation under `fix: bind execution channel authority`.
