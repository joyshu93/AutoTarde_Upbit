# Task 9C2c Implementation Report

## Scope

Implemented the candidate BTC controller preparation seam and shared strategy-run freshness helper only.
No `createApp` or scheduler runtime wiring was added in this task.

## RED

- Focused controller tests failed because candidate preparation was not called, READY receipts were not passed to the runner, BLOCKED/throw paths still reached the runner, and the running guard did not cover preparation.
- The focused preflight module failed to load because `getStrategyRunFreshnessThresholdMs` was not exported.
- An adversarial invalid-calendar timestamp test failed because `Date.parse` normalized `2026-02-30` instead of rejecting it.
- Independent review reproduced two authority TOCTOU failures: caller-owned controller dependencies could replace the runner after candidate preparation, and a mutable request could change BTC/account/requester values while preparation awaited.
- The new adversarial controller tests failed as expected: the candidate run returned `FAILED` after request mutation instead of using its entry snapshot, and preview reported the mutated `KRW-ETH` market instead of its entry `KRW-BTC` market.

## GREEN

- Added exported `CandidateBtcRunPreparation` and result contracts.
- Candidate BTC requests from both `TELEGRAM` and `SCHEDULER` now use `prepare -> canonical receipt -> runner` with one preserved `requestedAt`.
- Candidate preparation BLOCKED/throw and malformed or mismatched receipts fail before `runner.runOnce`.
- READY receipts require an exact plain enumerable data-property shape, non-empty identity fields, explicit-timezone valid timestamps, exact `SCHEDULER_PREFLIGHT` source, matching account, and matching request time.
- The controller passes a detached frozen receipt snapshot, so later mutation of the preparation-owned object cannot alter runner input.
- Candidate BTC skips the existing manual preflight to avoid duplicate preparation; baseline manual runs retain the previous preflight path.
- ETH and preview requests do not invoke candidate preparation.
- The existing running guard remains held while preparation is pending.
- Exported `getStrategyRunFreshnessThresholdMs`; both manual and scheduler preflight checks use the shortest configured BTC/ETH interval.
- Controller construction now stores a detached frozen shallow snapshot of runner, candidate preparation, manual preflight, and clock references without freezing collaborator objects.
- Run and preview requests now copy their supported primitive fields into frozen entry snapshots before any await; all preparation, runner, result, failure, and `ALREADY_RUNNING` paths use only those snapshots.
- Adversarial tests mutate the caller-owned dependency container and request objects while candidate preparation or preview is pending and prove that only the original constructor authority and entry request values are observed.

## Verification

- Focused controller and preflight tests: 20 passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `git diff --check`: passed.
- Full suite: intentionally not run by task instruction.

## Independent Review

- The two reported P1 findings have focused RED/GREEN coverage and are implemented as closed in this patch.
- Independent review confirmation remains pending before Task 9C2c is considered fully reviewed.

## Safety

- No operational database was opened.
- No Upbit or Telegram API was called.
- No network, LIVE process, sync, scheduler tick, order, migration, script, environment/default, `createApp`, or scheduler runtime wiring was touched.
- No push or merge was performed.
