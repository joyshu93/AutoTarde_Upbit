# Task 9C2c Implementation Report

## Scope

Implemented the candidate BTC controller preparation seam and shared strategy-run freshness helper only.
No `createApp` or scheduler runtime wiring was added in this task.

## RED

- Focused controller tests failed because candidate preparation was not called, READY receipts were not passed to the runner, BLOCKED/throw paths still reached the runner, and the running guard did not cover preparation.
- The focused preflight module failed to load because `getStrategyRunFreshnessThresholdMs` was not exported.
- An adversarial invalid-calendar timestamp test failed because `Date.parse` normalized `2026-02-30` instead of rejecting it.

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

## Verification

- Focused controller and preflight tests: 18 passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `git diff --check`: passed.
- Full suite: intentionally not run by task instruction.

## Safety

- No operational database was opened.
- No Upbit or Telegram API was called.
- No network, LIVE process, sync, scheduler tick, order, migration, script, environment/default, `createApp`, or scheduler runtime wiring was touched.
- No push or merge was performed.
