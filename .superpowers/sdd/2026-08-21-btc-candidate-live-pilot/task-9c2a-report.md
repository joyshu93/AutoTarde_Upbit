# Task 9C2a Report

## Status

Implemented and review-hardened the exact reconciliation and portfolio refresh receipt capability. No runtime wiring, scheduler behavior, operational configuration, migration, exchange call, Telegram call, or LIVE process was changed or invoked.

## Independent Review Fixes

The initial implementation received two Important findings and was not approved until both were addressed:

- A repository callback could mutate the record passed to persistence while `runWithRecord()` awaited it, making returned provenance differ from the invocation-owned value.
- A callback that persisted a successful row and then threw could cause `PortfolioSyncService` to append a second `ERROR` row for the same logical sync.

The hardened implementation now creates one immutable invocation identity before sync work starts. `ReconciliationService` creates an immutable canonical record before persistence, passes a separate frozen persistence value, and returns a detached copy of the canonical value. `PortfolioSyncService` passes its invocation identity into `runWithRecord()` and uses `updateReconciliationRun()` with that same ID on every failure path, so both repositories upsert one row for the invocation.

A second scoped review found that caller-supplied invocation identities were trusted at runtime. The final hardening projects an external identity only after verifying a plain-object prototype, exactly two own string keys (`id` and `startedAt`), enumerable data descriptors, a non-empty ID, and an explicit-timezone ISO-8601 timestamp through the existing strict nanosecond parser. Accessors are rejected without invocation, hidden, symbol, and extra properties are rejected, and the validated values are snapshotted and frozen before any asynchronous reconciliation work begins. Internally generated identities continue to use the same valid canonical shape.

## TDD Evidence

### RED

After adding the focused tests and before production implementation:

- `reconciliation runWithRecord returns its exact persisted record as a detached value` failed because `runWithRecord` did not exist.
- `portfolio sync propagates the exact reconciliation record from the same invocation` failed because `PortfolioSyncService` still called legacy `run()`.
- `portfolio sync persists an ERROR reconciliation row and rethrows an exact-result failure` failed for the same missing exact-result dependency.
- `reconciliation runWithRecord protects exact provenance from mutation during persistence` failed because explicit invocation identity was unsupported and the persistence argument was mutable.
- `portfolio sync converts a persist-then-throw reconciliation into one ERROR row for the same invocation` failed because the error path generated and appended a different reconciliation ID.
- `reconciliation runWithRecord rejects malformed caller-supplied run identities before reconciliation work` failed because an empty caller ID advanced to the first operator-state read instead of being rejected at the boundary.
- Existing focused reconciliation tests remained green during this RED run.

### GREEN

- Review-fix focused reconciliation and portfolio-sync tests: `39/39` passed.
- Related reconciliation, portfolio-sync, startup-recovery, and sync-controller tests: `51/51` passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `git diff --check`: passed with only existing Windows LF-to-CRLF checkout warnings.

Final caller-supplied identity hardening validation:

- focused `reconciliation-service.test.ts`: all registered cases passed, including the malformed identity matrix
- `npm.cmd run typecheck`: passed
- `npm.cmd run build`: passed
- `git diff --check`: passed with only Windows LF-to-CRLF checkout warnings

### Full-Suite Limitation

The review-fix full suite was attempted once. The main custom-harness suite built successfully and progressed through the new tests and the broader repository tests without a reported failure. The final isolated prospective child-test command returned exit code 1, but the parent output was truncated before exposing the specific failing test or environmental cause. A direct rerun of only that prospective bundle was started to distinguish a code failure from the known child-process/sandbox limitation, then explicitly stopped at the user's request. Therefore no completed full-suite pass is claimed; focused, related, typecheck, build, and diff-check evidence is reported separately.

## Implementation

- Added `ReconciliationService.runWithRecord()` returning `{ summary, reconciliationRun }`.
- Preserved `ReconciliationService.run()` as the legacy summary-only API by delegating to `runWithRecord()`.
- An optional explicit `{ id, startedAt }` invocation identity is accepted while existing callers remain unchanged.
- Caller-supplied invocation identity objects are descriptor-safe projected and strictly validated before any reconciliation dependency is read.
- The successful `ReconciliationRunRecord` is constructed once as an immutable canonical value, persisted through a separate frozen value, and returned as a detached copy.
- `PortfolioSyncRunResult` now requires the exact `reconciliationRun` from the same reconciliation invocation.
- `PortfolioSyncService` depends on `runWithRecord()` and never rereads `listReconciliationRuns()` to infer the latest row.
- `PortfolioSyncService` owns one invocation identity before any fallible work and upserts `ERROR` evidence under that same ID if any stage fails.
- A concurrent newer reconciliation row cannot replace the invocation-owned returned record.
- Existing failure handling still persists explicit `ERROR` evidence and rethrows the original failure without creating a second row for a persist-then-throw ambiguity.

## Changed Files

- `src/modules/reconciliation/reconciliation-service.ts`
- `src/modules/reconciliation/portfolio-sync-service.ts`
- `tests/reconciliation-service.test.ts`
- `tests/portfolio-sync-service.test.ts`
- `tests/run-all.ts`
- `tests/startup-recovery.test.ts`

## Scope Note: startup-recovery.test.ts

`PortfolioSyncRunResult.reconciliationRun` is intentionally a required field, not optional evidence. The existing startup-recovery unit test contains a hand-written fake `PortfolioSyncService.run()` result typed against that public result contract. Once the exact receipt became required, TypeScript correctly rejected the incomplete fake. The test fixture was updated with a deterministic reconciliation record solely to keep the existing consumer contract compiling; production `startup-recovery.ts` was not changed and no startup behavior was altered. Making the field optional would have weakened the Task 9C2a exact-provenance contract merely to avoid a test-fixture update.

## Safety Confirmation

- No operational SQLite database was opened.
- No Upbit or other network API was called.
- No Telegram polling or delivery was started.
- No LIVE runtime, scheduler, reconciliation command, strategy run, order, or sync was invoked.
- No secrets, local launch scripts, activation defaults, migration, push, or merge were changed.
