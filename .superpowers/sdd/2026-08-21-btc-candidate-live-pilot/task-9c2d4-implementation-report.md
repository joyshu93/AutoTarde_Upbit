# Task 9C2d4 Implementation Report

## Scope

Candidate-only `createApp` composition for the checked-in
`BTC_CANDIDATE_PILOT` policy. This task does not change configuration defaults,
seed a deployment, start a runtime, or activate LIVE operation.

## TDD Evidence

The first focused `create-app` run was RED after the tests were added:

- baseline still constructed `CandidateExecutionEvidenceService`;
- candidate authority fixture was not invoked before SQLite creation; and
- candidate configuration did not route BTC through candidate preparation or
  recovery.

The final focused suite is GREEN. It proves:

1. baseline does not invoke candidate authority and exposes no candidate evidence
   service;
2. throwing and malformed candidate authority both fail before the temporary
   SQLite file exists;
3. a valid candidate authority is read once before composition;
4. a temporary candidate deployment can be recovered from `PENDING_FLAT` and
   yields a candidate-policy BTC decision;
5. candidate BTC performs exactly one controller-owned balance refresh, while
   the following ETH run performs the existing scheduler-owned refresh.

## Implementation

- Candidate selection loads the checked-in PCS-2026-001 abandonment authority
  before `createSqlitePersistence`. The authority is checked again for the exact
  expected plain-data record shape.
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
node --input-type=module -e "await import('./dist/tests/create-app.test.js'); ..."
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

All commands passed. The focused tests used only temporary SQLite databases,
`DryRunExchangeAdapter`-backed fakes, and fixture market data. No runtime timers,
Telegram polling, Upbit request, sync command, operational database, secret file,
LIVE process, merge, or push was invoked.
