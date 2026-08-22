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

## Review Fix: Descriptor-Safe Resolver Authority

The review found that the scheduler retained the caller-supplied dependency
object and re-read `resolveRunPreparationOwner` for every accepted run. A
post-construction replacement could therefore change a scheduler-owned run to
controller-owned and bypass both scheduler hooks.

The constructor now snapshots the resolver's own property descriptor and, for
an accepted own data-property resolver, its function identity without reading
the property. This means an accessor is never invoked merely by construction.
The accepted resolver is invoked exactly once per accepted run only after the
current descriptor is proven unchanged.

Before either preparation hook or the controller is reached, a run now fails
through the existing persisted and reported preparation-ownership `FAILED`
path when the authority is an accessor, inherited, initially invalid, added,
removed, replaced, or descriptor-mutated after construction. An absent own
property remains the explicit default `SCHEDULER` authority.

### Review TDD Evidence

RED: After adding the review tests, the focused scheduler suite built but
failed four assertions against the previous implementation:

- the initial resolver accessor was invoked during the accepted run;
- replacing `SCHEDULER` with `CONTROLLER` after construction completed instead
  of failing;
- adding a resolver after an omitted baseline completed instead of failing;
- deleting the original resolver completed instead of failing.

GREEN: The focused scheduler suite passes all existing and review tests after
descriptor authority snapshotting and runtime comparison.

Review validation completed successfully:

- `npm.cmd run typecheck`
- `npm.cmd run build`
- focused compiled scheduler suite through `tests/harness.ts` (29 passing)
- `git diff --check`

### Review Scope and Safety

Changed only `src/app/strategy-scheduler.ts`,
`tests/strategy-scheduler.test.ts`, and this report. No `createApp`, runtime,
configuration, database, API, network, Telegram, script, scheduler process,
sync, secret, push, or merge operation was performed.

## Final Independent Review

- A fresh independent reviewer inspected the full Task 9C2d3 diff through
  `21b15af` and returned `CLEAN` with no actionable P0-P2 findings.
- The review confirmed descriptor-safe resolver authority, non-invocation of
  accessors, fail-closed inherited/invalid/late-mutated authority, exact-once
  accepted resolution, controller-owned hook isolation, scheduler refresh
  sharing, same-market and same-batch ordering, and sequential run-on-start.
- Build, typecheck, the 29-test focused scheduler suite, and diff-check passed.
  The known unrelated prospective-shadow bundle environment failure remains
  outside this task's files and contract.
- The reviewer made no file changes and used no operational database, Upbit,
  Telegram, LIVE runtime, scheduler/sync operation, script, push, or merge.
