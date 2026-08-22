# Task 9C2a Report

## Status

Implemented the exact reconciliation and portfolio refresh receipt capability. No runtime wiring, scheduler behavior, operational configuration, migration, exchange call, Telegram call, or LIVE process was changed or invoked.

## TDD Evidence

### RED

After adding the focused tests and before production implementation:

- `reconciliation runWithRecord returns its exact persisted record as a detached value` failed because `runWithRecord` did not exist.
- `portfolio sync propagates the exact reconciliation record from the same invocation` failed because `PortfolioSyncService` still called legacy `run()`.
- `portfolio sync persists an ERROR reconciliation row and rethrows an exact-result failure` failed for the same missing exact-result dependency.
- Existing focused reconciliation tests remained green during this RED run.

### GREEN

- Focused reconciliation, portfolio-sync, and startup-recovery tests: `42/42` passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `git diff --check`: passed with only existing Windows LF-to-CRLF checkout warnings.

### Full-Suite Limitation

The full suite was attempted twice. In both attempts the main custom-harness suite progressed through the new tests and the broader repository tests without a reported failure. The first sandboxed attempt failed only when `tests/run-all.ts` launched the isolated prospective child-test process. A second offline run outside that child-process restriction was still running through the long prospective suites when the user explicitly requested that long-running validation stop. It was terminated and is not claimed as a completed full-suite pass.

## Implementation

- Added `ReconciliationService.runWithRecord()` returning `{ summary, reconciliationRun }`.
- Preserved `ReconciliationService.run()` as the legacy summary-only API by delegating to `runWithRecord()`.
- The successful `ReconciliationRunRecord` is constructed once, saved directly, and returned as a detached copy.
- `PortfolioSyncRunResult` now requires the exact `reconciliationRun` from the same reconciliation invocation.
- `PortfolioSyncService` depends on `runWithRecord()` and never rereads `listReconciliationRuns()` to infer the latest row.
- A concurrent newer reconciliation row cannot replace the invocation-owned returned record.
- Existing failure handling still persists an explicit `ERROR` reconciliation row and rethrows the original failure.

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
