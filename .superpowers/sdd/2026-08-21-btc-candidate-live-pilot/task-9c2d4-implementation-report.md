# Task 9C2d4 Implementation Report

## Scope

Candidate-only `createApp` composition for the checked-in
`BTC_CANDIDATE_PILOT` policy. This task does not change configuration defaults,
seed a deployment, start a runtime, or activate LIVE operation.

## TDD Evidence

The review-fix tests were added before the production fix. The RED build failed
because the old override exposed a replacement authority loader and had no
post-validation observer seam. The new tests also described candidate-selection
shape rejection, immutable snapshots, post-bootstrap SQLite cleanup, and manual
router behavior that the old composition did not provide.

The final focused suite is GREEN. It proves:

1. baseline neither observes checked-in candidate authority nor constructs the
   candidate evidence graph;
2. production always validates the checked-in PCS-2026-001 authority before a
   test-only observer can observe or throw; an observer return value is ignored;
3. candidate selection accessor, inherited, symbol, non-enumerable, and extra
   properties are rejected before the temporary SQLite file exists, without
   invoking an accessor;
4. a validated candidate selection is copied and frozen before composition, so
   mutating the caller-owned object cannot reroute a later BTC run to baseline;
5. a post-bootstrap candidate composition failure closes the SQLite handle before
   the original error is rethrown;
6. scheduler BTC remains controller-owned while ETH remains scheduler-owned;
7. manual `/run BTC` completes its exact `SCHEDULER_PREFLIGHT` refresh and then
   blocks with `IDENTITY_MISMATCH`, before a strategy decision or order, when the
   candidate deployment is absent;
8. manual `/run ETH` remains on the baseline path and creates no additional
   reconciliation run after the baseline manual preflight evidence is present.

## Implementation

- Candidate selection is validated as an exact ordinary own-data object, copied
  into an immutable snapshot, and accepted only with `executionMode=LIVE`.
- Candidate composition always loads the checked-in PCS-2026-001 abandonment
  authority before `createSqlitePersistence`, validates its exact own-data shape,
  and passes only a frozen snapshot to the optional test observer. The observer
  cannot replace authority and its return value is ignored.
- Any error after `createSqlitePersistence` closes the persistence bundle before
  it is rethrown.
- Baseline omits candidate execution repository injection, candidate evidence,
  recovery verifier, candidate BTC preparation, and scheduler ownership resolver.
- Candidate selection injects the candidate repository into execution, adds
  candidate terminal evidence projection to reconciliation, and attaches the
  configured-account recovery verifier to the PositionGuard runner.
- Candidate recovery uses the smaller explicit scheduler interval for freshness
  and `DEFAULT_IDENTIFIER_RECOVERY_POLICY` for bounded identifier absence.
- Candidate BTC is owned by the controller and ETH remains owned by the scheduler.

## Validation

Completed in the isolated worktree only:

```text
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/create-app.test.js'); await import('./dist/tests/candidate-btc-run-preparation.test.js'); await import('./dist/tests/strategy-run-controller.test.js'); await import('./dist/tests/strategy-scheduler.test.js'); await import('./dist/tests/position-guard-pilot-recovery.test.js');"
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

All commands passed. The focused tests used only temporary SQLite databases,
`DryRunExchangeAdapter`-backed fakes, and fixture market data. No runtime timers,
Telegram polling, Upbit request, sync command, operational database, secret file,
LIVE process, merge, or push was invoked.
