# Task 4 Implementer Report

## Status and scope

- Verified the isolated worktree started at exact base commit `5c5ad19d8d0bf468fa563ff1835c97812799904a` before editing.
- Read `task-4-brief.md`, then `PRODUCT_BOUNDARY.md`, `ARCHITECTURE.md`, `RISK_POLICY.md`, `ORDER_LIFECYCLE.md`, and `README.md` in the required order.
- Used only temporary fresh SQLite databases and temporary pre-0017 fixture databases.
- Did not open the operational database or call Upbit, Telegram, scheduler, sync, runtime wiring, order submission, or local activation scripts.
- Did not spawn subagents, as explicitly required by the task controller.
- Kept default execution behavior unchanged; this task adds persistence only and does not enable live order transmission.

## Files

- `migrations/0017_add_btc_candidate_live_pilot.sql`
- `src/domain/pilot-types.ts`
- `src/modules/db/pilot-interfaces.ts`
- `src/modules/db/index.ts`
- `src/modules/db/repositories/contracts.ts`
- `src/modules/db/repositories/sqlite-repositories.ts`
- `src/modules/db/repositories/sqlite-transaction.ts`
- `src/modules/db/repositories/sqlite-candidate-pilot-repository.ts`
- `src/modules/db/repositories/in-memory-candidate-pilot-repository.ts`
- `src/modules/db/repositories/sqlite-account-execution-lease-store.ts`
- `src/modules/db/repositories/in-memory-account-execution-lease-store.ts`
- `tests/candidate-pilot-repository-contract.test.ts`
- `tests/account-execution-lease-contract.test.ts`
- `tests/db-candidate-pilot-persistence.test.ts`
- `tests/db-sqlite-wiring.test.ts`
- `tests/position-guard-candidate-dependency-boundary.test.ts`
- `tests/run-all.ts`
- `.superpowers/sdd/2026-08-21-btc-candidate-live-pilot/task-4-implementer-report.md`

The dependency-boundary test changed only to permit the three reviewed DB persistence modules to import the Task 2 pure projector. All other candidate-to-runtime edges remain prohibited.

## Schema and contracts

Migration 0017 creates:

- `strategy_pilot_deployments`, constrained to the exact published BTC pilot identity and canonical `PositionGuardPilotPhase` values.
- `strategy_candidate_states`, with a state version and evidence cursor.
- `strategy_candidate_execution_evidence`, with canonical material hashes and replay index `(deployment_id, executed_at_epoch_ns, id)`.
- `strategy_pilot_audit_events`, ordered by epoch nanoseconds and ID.
- `account_execution_leases`, constrained to `ORDER_SUBMISSION` and one lease per account.
- `order_submission_recovery_observations`, with `FOUND`, `NOT_FOUND`, and `TRANSIENT_FAILURE` outcomes and index `(order_id, observed_at_epoch_ms, id)`.

Evidence, audit, and recovery-observation tables have `BEFORE UPDATE` and `BEFORE DELETE` abort triggers. Migration rebuilds preserve all prior constrained values and rows, including notification-delivery-attempt foreign keys, while adding `AUTOMATIC_PAUSE`, the five exact reserved notification codes, and the seven exact reserved risk codes. Runtime notification/risk unions in `src/domain/types.ts` were intentionally not changed.

`CandidatePilotRepository` and `AccountExecutionLeaseStore` remain separate from `ExecutionRepository` and are separate `SqlitePersistenceBundle` fields. Both in-memory and SQLite implementations run the same contracts.

State advancement validates exact own data properties, hashes a fixed canonical field sequence, calls the Task 2 pure projector, and performs evidence insert, state-version CAS, and audit insert in one `BEGIN IMMEDIATE` transaction. Only an exact material-hash duplicate is idempotent; conflicting evidence IDs fail closed. Replay sorts by true epoch nanoseconds and then evidence ID.

Lease acquisition, renewal, and release use owner-token CAS semantics. Renewal requires a live matching owner and a strictly later expiry. SQLite acquisition serializes through `BEGIN IMMEDIATE`; expired takeover is blocked while the account has any active or `RECONCILIATION_REQUIRED` order.

## TDD evidence

### RED

Command, run after adding the contract/migration tests and before production implementation:

```powershell
npm.cmd run test
```

Expected result: exit code 1. TypeScript reported missing Task 4 modules and bundle properties, including:

```text
Cannot find module '../src/modules/db/pilot-interfaces.js'
Cannot find module '../src/modules/db/repositories/in-memory-candidate-pilot-repository.js'
Cannot find module '../src/modules/db/repositories/sqlite-candidate-pilot-repository.js'
Property 'candidatePilots' does not exist on type 'SqlitePersistenceBundle'
Property 'accountExecutionLeases' does not exist on type 'SqlitePersistenceBundle'
```

Additional focused RED/GREEN cycles proved that forged extra/accessor identity and evidence shapes were initially accepted, and that lease renewal/in-memory deployment uniqueness were initially too permissive. The minimal validation, monotonic-renewal, and uniqueness changes made those contracts green.

### GREEN

Focused repository/migration command:

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/db-candidate-pilot-persistence.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Result: exit code 0, 13 focused tests passed. These include common in-memory/SQLite contracts, mixed-offset nanosecond replay, exact identity validation, migration preservation and rollback, append-only triggers, atomic rollback, two-connection lease contention, stale-owner CAS, and blocking-order takeover.

Focused existing SQLite wiring command:

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/db-sqlite-wiring.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Result: exit code 0, 11 tests passed, including fresh migration wiring, pre-existing migration preservation/rollback, and separate bundle fields.

Typecheck:

```powershell
npm.cmd run typecheck
```

Result: exit code 0.

Full suite:

```powershell
npm.cmd run test
```

Result: exit code 0. The main registered harness passed all tests, and the separately spawned prospective batch reported `tests 102`, `pass 102`, `fail 0`.

On Windows, the first full-suite attempt exposed an existing byte-level bundle check after Git had checked the generated artifact out with CRLF. A read-only comparison proved the LF-normalized checked artifact and esbuild output had the same SHA-256 (`a8d633e989eb29446724d948ec4ef2356d24379d1e616085b137814d3e373fba`). Running the repository's canonical bundle-generation command restored LF working bytes without changing Git content; the exact full-suite rerun then passed.

## Safety and integrity evidence

- Fresh database: migration runner applied 0017 and exposed all six tables and both separate persistence fields.
- Upgrade: a pre-0017 fixture retained execution transitions, notifications, delivery attempts, risks, and the delivery-attempt-to-notification foreign key.
- Rollback: injected legacy-copy failure left 0017 unapplied, restored original tables and rows, left no `_0017_legacy` tables, and returned `PRAGMA integrity_check = ok`.
- Integrity: focused tests assert `PRAGMA foreign_keys = 1`, `PRAGMA busy_timeout = 5000`, empty `PRAGMA foreign_key_check`, and `PRAGMA integrity_check = ok`.
- Atomicity: injected audit failure rolled back candidate evidence and state CAS together.
- Concurrency: two independent SQLite connections produced exactly one lease owner; stale owner renewal/release failed after takeover.
- Recovery guard: both active and `RECONCILIATION_REQUIRED` orders blocked expired-lease takeover.
- Replay: equivalent/mixed offsets are ordered by parsed epoch nanoseconds, then stable evidence ID.

## Self-review and concerns

- Reviewed the migration value sets against all earlier migrations and the exact controller-reserved codes.
- Reviewed repository boundaries, projector use, CAS predicates, duplicate semantics, append-only enforcement, timestamp ordering, and in-memory/SQLite parity.
- Confirmed `src/domain/types.ts` is unchanged and no runtime activation or external side-effect path was added.
- Root product/runtime documentation is unchanged because this task introduces no runtime behavior; later integration/documentation tasks own operator-visible behavior.
- No unresolved Task 4 code concern remains. The only environment note is the existing Windows CRLF checkout behavior for the generated prospective validator; canonical regeneration produced no Git diff and the full suite passed.
