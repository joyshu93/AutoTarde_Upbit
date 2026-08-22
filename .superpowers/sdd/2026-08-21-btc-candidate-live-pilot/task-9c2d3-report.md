# Task 9C2d3 Report: Market-Aware Scheduler Preparation Ownership

## Scope

Changed only the isolated scheduler contract and its focused tests. No runtime,
configuration, `createApp`, database, network, exchange, Telegram, sync,
secret, script, scheduler-process, or LIVE activation path was touched.

## TDD Evidence

RED: `npm.cmd run build` failed after the new tests were added because
`resolveRunPreparationOwner` was not yet a scheduler dependency.

GREEN: Added the exported `StrategySchedulerRunPreparationOwner` union and an
optional synchronous resolver. The resolver defaults to `SCHEDULER`, is read
once after the same-market running guard, and rejects unexpected runtime output.

## Contract Covered

- Omitted resolver preserves refresh, preflight, then controller ordering.
- Controller-owned BTC skips both scheduler hooks and does not join the shared
  account-refresh promise.
- Scheduler-owned ETH retains the existing shared refresh behavior.
- Resolver exceptions and invalid runtime values persist/report a failed run
  before either hook or the controller is invoked.
- Same-market already-running and same-batch order deferral occur before a
  second/deferred market ownership resolution.
- `runOnStart` remains sequential and resolves ownership separately per market
  before installing the existing later timers.

## Validation

- `npm.cmd run build`
- `node dist/tests/run-all.js`
- `npm.cmd run typecheck`
- `git diff --check`

All validation above is offline-only in the isolated worktree.
