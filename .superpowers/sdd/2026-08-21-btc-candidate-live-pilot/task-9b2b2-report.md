# Task 9B2b2 Report

## Outcome

Implemented final candidate authority revalidation immediately before the sole live
`createOrder` call. Candidate sends now re-read and validate the persisted execution
aggregate and fail closed through the dedicated candidate-intent pause capability.
Noncandidate execution retains its existing authority and lease behavior.

## Files Changed

- `src/modules/execution/execution-service.ts`
- `src/modules/db/pilot-interfaces.ts`
- `tests/execution-candidate-final-authority.test.ts`
- `tests/execution-candidate-intent.test.ts`
- `tests/candidate-pilot-recovery-fault-persistence.test.ts`
- `tests/run-all.ts`
- `ARCHITECTURE.md`
- `RISK_POLICY.md`
- `ORDER_LIFECYCLE.md`
- `README.md`
- `.superpowers/sdd/2026-08-21-btc-candidate-live-pilot/task-9b2b2-report.md`

## TDD Evidence

### RED

After adding `tests/execution-candidate-final-authority.test.ts` and registering it,
the following focused command exited 1 with 12 expected failures:

```powershell
node --input-type=module -e "await import('./dist/tests/execution-candidate-final-authority.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

The failures demonstrated that the implementation did not yet perform the six
persisted candidate reads, would send after order/event/decision/deployment/state/
binding mismatches, did not use the dedicated candidate fault pause for competitor
or operator-state races, and lacked the required final-order repository read.

### GREEN

The same focused command exited 0 with all 12 tests passing. A broader focused
execution, candidate binding, candidate persistence, authority, and account-lease
regression command also exited 0. An existing duplicate-binding fixture initially
failed because final revalidation legitimately added a first binding read; the
fixture was corrected to inject its mutation on the second read, and the focused
regression then passed.

## Verification

- `npm.cmd run typecheck`: exit 0.
- `npm.cmd run build`: exit 0.
- `npm.cmd run test`: exit 0; main harness passed and isolated prospective suite reported 102 passed, 0 failed.
- `npm.cmd run check:prospective-commitment-bundle`: exit 0 outside the linked-worktree sandbox; checked-in bundle matched TypeScript source byte-for-byte.
- `git diff --check`: exit 0 (Git emitted only existing line-ending conversion warnings).
- `rg -n "\.createOrder\s*\(" src`: exactly one match, in `execution-service.ts`.

The first sandboxed prospective-bundle/full-suite attempts could not traverse the
linked-worktree source path. They were rerun with the same repository commands
outside that sandbox restriction and passed. No network or operational service was
used.

## Preserved Invariants

- Candidate reads occur strictly in this order: account active orders, exact order,
  first event, READY decision, deployment, exact candidate state, and binding.
- The actual persisted order must still be `SUBMITTING`; immutable order intent and
  related aggregate records must match the service-owned snapshot exactly.
- Only the validated order status is projected back to `PERSISTED` before rerunning
  the reviewed `validateCandidateBoundOrderIntent` aggregate validator.
- A competitor active or uncertain order, missing record, or any mismatch pauses
  through `pauseForCandidateIntentFault`, retains the account lease, and sends zero.
- Every candidate await completes before the final `operatorState.getState()` await.
  No async work, report, database operation, callback, or timer occurs between that
  read and the sole `createOrder` call.
- The strict ordinary recovery-fault shape and chronology remain unchanged.
- No PositionGuard reference, operational database, Upbit, Telegram, live process,
  scheduler, sync path, secret, activation default, or local operational script was
  touched.

## Interface Extension

`CandidateIntentFaultStage` gained only `FINAL_REVALIDATION`, with the existing
`IDENTITY_MISMATCH` reason, for the dedicated candidate-intent fault capability.
Repository contract tests cover both in-memory and SQLite implementations. The
ordinary recovery-fault input and APIs were not broadened.

## Assumptions And Remaining Risks

- The service-owned in-memory order, first event, READY decision, and binding are the
  reviewed immutable snapshots against which the final persisted aggregate is bound.
- The exchange send remains inherently after the final operator-state read, but the
  code deliberately contains no intervening await or side effect, minimizing that
  unavoidable synchronous boundary.
- No subagent was used because no multi-agent/subagent tool was available in this
  session; integration and safety review were performed locally.
