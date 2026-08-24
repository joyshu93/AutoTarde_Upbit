# Task 15 Final Safety Fix Report

## Outcome

- Scope: BTC candidate LIVE pilot final fix wave, F1-F11.
- Starting HEAD: `525c13c`.
- Result: 11 fixed, 0 evidence-backed rejections, 0 open findings.
- Safety: all work and tests used fakes, in-memory stores, or temporary SQLite files under the isolated worktree. No operational database, network, Upbit, Telegram, scheduler, strategy runtime, order-send process, activation, merge, or push was used.
- Defaults preserved: `BASELINE`, `DRY_RUN`, live disabled, scheduler disabled, ETH baseline behavior, sole `ExecutionService.createOrder()` authority, no uncertain retry, and no automatic resume.

## Logical Commits

- `d689b39cd813c8c9b8090adf777ab6543ffdb060` - candidate startup authority, recovery ordering, and DRAINING routing (F1-F4).
- `3ea6f1b1b6625c087596626b68bbdbfd7dbce62f` - exchange snapshot binding, durable FOUND authority, and own-order final send authority (F5-F7).
- `90c0bd23d88a191d338a763f1552ad6d0a476992` - canonical submission blocker and readiness provenance (F8-F10).
- `ae270f6cd9d71d7e673b7b52480eb4b862c7eb9b` - crash-atomic migrations and deterministic historical repair (F11).
- `4df58b4` - broad-suite fault injector aligned with the canonical final submission-blocker read.

## Focused Commands

All harness commands were preceded by `npm.cmd run build` and explicitly invoked `runRegisteredTests()`.

### Group A: F1-F4

```powershell
node --input-type=module -e "await import('./dist/tests/create-app.test.js'); await import('./dist/tests/index-startup.test.js'); await import('./dist/tests/position-guard-candidate-runner.test.js'); await import('./dist/tests/position-guard-pilot-initializer.test.js'); await import('./dist/tests/position-guard-pilot-lifecycle.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Fresh GREEN result: exit 0, 78 passed, 0 failed.

### Group B: F5-F7

```powershell
node --input-type=module -e "await import('./dist/tests/submission-recovery-state-machine.test.js'); await import('./dist/tests/reconciliation-service.test.js'); await import('./dist/tests/execution-service.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Fresh GREEN result: exit 0, 56 passed, 0 failed.

### Group C: F8-F10

Initial RED command:

```powershell
node --input-type=module -e "await import('./dist/tests/account-execution-lease-contract.test.js'); await import('./dist/tests/position-guard-pilot-readiness.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Final GREEN command:

```powershell
node --input-type=module -e "await import('./dist/tests/submission-blocking-order.test.js'); await import('./dist/tests/account-execution-lease-contract.test.js'); await import('./dist/tests/candidate-bound-order-intent-in-memory.test.js'); await import('./dist/tests/candidate-bound-order-intent-sqlite.test.js'); await import('./dist/tests/execution-candidate-final-authority.test.js'); await import('./dist/tests/execution-service.test.js'); await import('./dist/tests/position-guard-pilot-readiness.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Fresh GREEN result: exit 0, 93 passed, 0 failed.

### Group D: F11

```powershell
node --input-type=module -e "await import('./dist/tests/migration-script.test.js'); await import('./dist/tests/db-candidate-pilot-persistence.test.js'); await import('./dist/tests/db-sqlite-wiring.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Fresh GREEN result: exit 0, 83 passed, 0 failed. The narrower parser plus candidate-persistence harness passed 60/60.

## F1 - Persisted Pilot Authority At Baseline Restart

- Status: fixed.
- Root cause: `createApp` only composed candidate startup checks when environment selection was candidate. A baseline selection therefore had no component that inspected persisted pilot deployments.
- Expected RED command/result: Group A exited 1. The baseline test reached runtime instead of rejecting the first persisted nonterminal phase (`Missing expected rejection`), and did not establish the required global pause.
- Fix: a startup authority is now always composed. Baseline accepts either no deployment or one fully canonical rollback-completed `DISABLED` deployment; `PENDING_FLAT`, `ACTIVE`, `DRAINING`, `PAUSED_FAULT`, malformed `DISABLED`, and persisted/config identity conflicts fail closed before runtime surfaces and pause globally.
- GREEN command/result: Group A, 78/78.
- Files changed: `src/app/create-app.ts`, `src/app/position-guard-pilot-startup-authority.ts`, `src/app/position-guard-pilot-initializer.ts`, `tests/create-app.test.ts`.
- Residual risk: malformed or legacy authority that cannot prove the canonical audit chain blocks startup and requires explicit operator repair. No operational database was opened.

## F2 - DRAINING REDUCE/EXIT Binding

- Status: fixed.
- Root cause: the runner constructed candidate execution authority only for `ACTIVE`; a verified DRAINING reduction therefore reached execution as an ordinary unbound strategy order.
- Expected RED command/result: Group A exited 1. The real-runner DRAINING path produced no execution binding (`binding` was absent), so terminal candidate projection/restart completion could not proceed.
- Fix: verified DRAINING `REDUCE` and `EXIT` decisions carry the same immutable deployment, state-version, action, entry-path, material, and decision authority used by ACTIVE candidate submissions. DRAINING `ENTER` and `ADD` remain suppressed. The real runner test covers binding persistence, terminal projection, restart replay, and flat rollback completion without synthetic authority injection.
- GREEN command/result: Group A, 78/78.
- Files changed: `src/modules/strategy/position-guard-runner.ts`, `src/modules/execution/candidate-evidence-service.ts`, `tests/position-guard-candidate-runner.test.ts`, `tests/position-guard-pilot-lifecycle.test.ts`.
- Residual risk: terminal evidence still fails closed if exact exchange fill/material provenance is unavailable; that condition pauses and requires reconciliation rather than guessing.

## F3 - Canonical DRAINING Restart

- Status: fixed.
- Root cause: the initializer's accepted persisted phase set omitted `DRAINING`, even when activation, rollback-start, state-version, chronology, and risk-reducing evidence were canonical.
- Expected RED command/result: Group A exited 1 because the valid DRAINING fixture threw instead of reconstructing authority.
- Fix: the initializer accepts only a canonical DRAINING lineage, validates the rollback boundary and all post-boundary state advances as risk-reducing, and preserves `PAUSED_FAULT` ancestry from DRAINING. Missing, forged, ambiguous, non-risk-reducing, or misordered audit material still rejects.
- GREEN command/result: Group A, 78/78.
- Files changed: `src/app/position-guard-pilot-initializer.ts`, `src/app/position-guard-pilot-recovery.ts`, `tests/position-guard-pilot-initializer.test.ts`, `tests/position-guard-pilot-lifecycle.test.ts`.
- Residual risk: restart reconstructs authority but never resumes global execution. Operator resume remains explicit after recovery and review.

## F4 - Exchange-Backed Candidate Startup Recovery

- Status: fixed.
- Root cause: `runAppStartup` ran generic startup recovery and then exposed delivery, polling, scheduler, and execution surfaces without candidate-specific replay/inventory/order preparation.
- Expected RED command/result: Group A exited 1. The observed startup order omitted `candidate:recovery`, and an injected candidate recovery failure did not reject or own shutdown before runtime surfaces.
- Fix: selected nonterminal candidate startup now performs preparation/recovery immediately after authority initialization and before generic recovery, policy, delivery, polling, scheduler ownership, or either market. Candidate faults pause globally and use the existing single shutdown owner. Baseline with no deployment composes no exchange-backed candidate recovery.
- GREEN command/result: Group A, 78/78.
- Files changed: `src/app/candidate-pilot-startup-recovery.ts`, `src/app/create-app.ts`, `src/index.ts`, `tests/index-startup.test.ts`, `tests/create-app.test.ts`.
- Residual risk: only fake exchange readers were exercised as required. In live operation, any unavailable or conflicting exchange evidence blocks both markets and requires operator intervention; it does not auto-resume.

## F5 - Snapshot-To-Intent Binding

- Status: fixed.
- Root cause: reconciliation accepted structurally valid snapshots without proving requested UUID/identifier identity or immutable market, side, order type, price, volume, time-in-force, and SMP material against the local order.
- Expected RED command/result: Group B exited 1. A foreign/mutated snapshot returned `RECOVERED` and imported terminal material, and an accessor-backed snapshot invoked its hostile getter.
- Fix: `bindExchangeOrderSnapshot` is the canonical descriptor-safe boundary. It reads only own data descriptors, validates query and local identities, validates all immutable order material, maps TIF/SMP fields from the Upbit adapter, and permits only explicit canonical Upbit decimal normalization for legitimate market-order representations. Conflict follows the existing fail-closed recovery path and imports no fills.
- GREEN command/result: Group B, 56/56. The broad SQLite reconciliation fixture was also corrected to present matching `limit`/volume material in `ae270f6`.
- Files changed: `src/modules/reconciliation/exchange-order-snapshot-binding.ts`, `src/modules/reconciliation/reconciliation-service.ts`, `src/modules/exchange/interfaces.ts`, `src/modules/exchange/upbit/private-client.ts`, `tests/reconciliation-service.test.ts`, `tests/db-sqlite-wiring.test.ts`.
- Residual risk: a future Upbit representation not covered by the explicit normalization contract will fail closed until reviewed; no permissive coercion or foreign-fill fallback exists.

## F6 - Durable FOUND Precedence

- Status: fixed.
- Root cause: bounded-absence evaluation discarded FOUND observations and considered only later NOT_FOUND rows, allowing an exchange-confirmed order to be reclassified absent after local projection trouble.
- Expected RED command/result: Group B exited 1. FOUND at epoch 1000 followed by two bounded NOT_FOUND observations returned `confirmed: true` instead of `false`.
- Fix: any canonical durable FOUND observation permanently prevents bounded absence confirmation for that order identity. FOUND continues through recovery/projection or remains manual reconciliation authority; it can never authorize resend.
- GREEN command/result: Group B, 56/56.
- Files changed: `src/modules/reconciliation/submission-recovery-state-machine.ts`, `src/modules/reconciliation/reconciliation-service.ts`, `tests/submission-recovery-state-machine.test.ts`, `tests/reconciliation-service.test.ts`.
- Residual risk: durable FOUND with failed local projection can remain blocking until manual reconciliation succeeds. This is intentional fail-closed behavior.

## F7 - Exact Own-Order Final Send Authority

- Status: fixed.
- Root cause: only candidate sends required their own final persisted SUBMITTING row. Baseline sends could proceed after their row disappeared, became terminal, or changed, provided no competitor was returned.
- Expected RED command/result: Group B exited 1. The missing baseline-intent fixture reached `createOrder()` instead of rejecting; terminal and immutable mutations had the same authority gap.
- Fix: every send path performs the canonical account-wide blocker read and then an exact own-order re-read immediately before the sole adapter send. The own row must still be the same immutable SUBMITTING intent. Missing, terminal, mutated, duplicate, scan-overflow, or read failure pauses/faults before send.
- GREEN command/result: Group B, 56/56; final broad send-authority harness 34/34.
- Files changed: `src/modules/execution/execution-service.ts`, `tests/execution-service.test.ts`, `tests/execution-send-authority.test.ts`.
- Residual risk: there is an irreducible interval between the final local read and exchange I/O. The account lease, exact identifier, sole send authority, and no-uncertain-retry contract contain that boundary.

## F8 - Canonical Submission Blocking And Lease Acquisition

- Status: fixed.
- Root cause: both lease stores returned a first lease before checking order authority, and active-status-only queries omitted FAILED/REJECTED orders with durable post-dispatch uncertainty. Runtime, stores, and repositories had no shared evidence classifier.
- Expected RED command/result: Group C's initial command exited 1. With no current lease, the in-memory store returned a lease instead of `null` for an unresolved potentially dispatched terminal order; migrated SQLite reproduced the same first-row authority gap.
- Fix: the pure `classifySubmissionBlockingOrder` contract classifies lifecycle plus events, UUID/response evidence, and recovery observations. Active and unresolved potentially dispatched terminal rows block; definitive pre-send terminal failures, exact exchange rejection, and bounded absence do not. Both lease stores check before first insert and takeover. Repositories and final send use the same helper; a bounded final scan overflows closed.
- GREEN command/result: Group C, 93/93; candidate SQLite persistence blocker coverage also passed in Group D.
- Files changed: `src/domain/submission-blocking-order.ts`, `src/modules/db/interfaces.ts`, both account lease stores, both execution repositories, `src/modules/execution/execution-service.ts`, and the account/candidate/final-authority tests.
- Residual risk: classification depends only on persisted evidence. Missing exchange resolution remains blocking, and large final scans fail closed rather than silently truncating authority.

## F9 - Readiness Uses Runtime-Equivalent Blocking Classification

- Status: fixed.
- Root cause: readiness queried active statuses only, so unresolved potentially dispatched FAILED/REJECTED rows could produce a false no-order PASS.
- Expected RED command/result: Group C's initial command exited 1. Temporary SQLite cases containing unresolved FAILED and REJECTED rows reported PASS instead of BLOCK.
- Fix: the read-only inspector imports only the pure classifier, loads exact order events/recovery observations, reports each blocking ID/status/reason code/reason, and counts unresolved terminal authority with active/uncertain orders. Definitive pre-send and durably resolved terminal rows remain non-blocking.
- GREEN command/result: Group C, 93/93.
- Files changed: `src/domain/submission-blocking-order.ts`, `src/inspection/position-guard-pilot-readiness.ts`, `tests/position-guard-pilot-readiness.test.ts`, `tests/submission-blocking-order.test.ts`.
- Residual risk: readiness is deliberately tied to the current schema and blocks on missing/malformed evidence. It performs no exchange lookup or inferred repair.

## F10 - Readiness Source Order And Binding Provenance

- Status: fixed.
- Root cause: readiness neither required `strategy_candidate_execution_bindings` nor linked terminal evidence to the exact source order and immutable candidate binding.
- Expected RED command/result: Group C's initial command exited 1. Dropping the binding table still yielded readiness PASS, and source-less evidence replay could satisfy the prior state/audit-only checks.
- Fix: required schema now includes the complete binding table and immutable update/delete triggers. Every terminal evidence ID must identify its exact source order; readiness validates account/deployment/policy/version/activation, decision relation, market/mode/type/side/exact price and volume/TIF/SMP, action, origin, terminal lifecycle, binding hash/material, and chronology. Missing, foreign, conflicting, future, or inferred data blocks. Inspection remains direct read-only and does not import runtime composition, migrate, or configure WAL.
- GREEN command/result: Group C, 93/93, including missing source, foreign binding, material/hash conflict, terminal conflict, trigger removal, exact chain PASS, and byte/mtime/WAL/SHM non-mutation tests.
- Files changed: `src/inspection/position-guard-pilot-readiness.ts`, `tests/position-guard-pilot-readiness.test.ts`, `tests/telegram-operator-contracts.test.ts`, `ARCHITECTURE.md`, `ORDER_LIFECYCLE.md`, `RISK_POLICY.md`.
- Residual risk: readiness proves persisted provenance, not fresh exchange truth. Any absent exact local chain blocks activation review.

## F11 - Crash-Atomic Migration Ledger

- Status: fixed.
- Root cause: the runner executed a script and then inserted `_schema_migrations`. Transaction-owning scripts committed before the insert; plain DDL auto-committed statement by statement. A ledger failure therefore left schema without its authority row.
- Expected RED command/result: after adding the two crash-window tests, the candidate-persistence harness exited 1 with two failures: 0017's candidate table and 0022's activation columns both remained durable (`true !== false`) after an injected ledger-trigger abort. The parser contract initially produced `TS2307` because the pure parser did not yet exist; additional RED cases proved top-level `END` and `BEGIN EXCLUSIVE` were not safely distinguishable from trigger `END` before trigger-scope tracking.
- Fix: the lexical parser masks strings/comments, tracks CREATE TRIGGER bodies, accepts only one complete `BEGIN IMMEDIATE`/`COMMIT` envelope plus a balanced foreign-key wrapper, preserves the body unchanged, and rejects nested/alias/malformed transaction control. The runner executes that body, foreign-key validation, and ledger insert in one outer immediate transaction for every migration, restoring foreign-key mode after commit or rollback. Historical full-schema/no-ledger states require an exact canonical schema delta plus integrity checks; known additive 0022 partial state is completed and revalidated in the same transaction; incompatible fragments block without a ledger row.
- GREEN command/result: Group D, 83/83; narrower parser plus persistence 60/60. Both injected failures leave neither schema nor ledger, close/reopen recovery applies fully, exact historical 0017 and partial 0022 recover, incompatible 0017 is preserved and rejected, and existing migrations/foreign keys/WAL fixtures pass.
- Files changed: `src/modules/db/migration-script.ts`, `src/modules/db/repositories/sqlite-database.ts`, `tests/migration-script.test.ts`, `tests/db-candidate-pilot-persistence.test.ts`, `tests/db-sqlite-wiring.test.ts`, `ARCHITECTURE.md`, `RISK_POLICY.md`.
- Residual risk: noncanonical historical partial schemas other than the explicitly safe additive 0022 repair are intentionally startup-blocking and require explicit operator/database repair. The runner never silently records them as applied.

## Final Verification

- Focused Group A: 78/78.
- Focused Group B: 56/56.
- Focused Group C: 93/93.
- Focused/broad Group D: 83/83; narrower F11 suite 60/60.
- Aggregate relevant safety harness: 457/457 across startup, candidate lifecycle, execution/send authority, reconciliation, SQLite, readiness, Upbit normalization, and dependency boundaries.
- `npm.cmd run typecheck`: exit 0.
- `npm.cmd run build`: exit 0.
- Exact full offline `npm.cmd run test`: exit 0, 1,564/1,564 shared custom-harness tests plus 102/102 isolated Node tests. The aggregate imports include the new pure classifier and migration-parser suites.
- The first sandboxed full run passed all 1,559 then-registered custom tests and 101/102 isolated tests; its sole failure was esbuild filesystem denial while checking the unrelated prospective validator bundle. The isolated test passed 11/11 with approved read access, and the exact full command then passed as recorded above. No source change was made for that environment-only failure.
- `git diff --check`: required again after this report is written.
- Final worktree cleanliness: required after committing this report.

## Open Concerns

None for F1-F11. The residual risks above are explicit fail-closed operational boundaries, not open findings.
