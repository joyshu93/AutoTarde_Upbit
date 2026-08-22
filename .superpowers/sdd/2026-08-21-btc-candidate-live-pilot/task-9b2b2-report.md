# Task 9B2b2 Report

## Outcome

Implemented final candidate authority revalidation immediately before the sole live
`createOrder` call. Candidate sends now re-read and validate the persisted execution
aggregate and fail closed through the dedicated candidate-intent pause capability.
Noncandidate execution retains its existing authority and lease behavior.

The final review fixes additionally move the final state await into
`submitOrderFromDecision`, add bounded active/submission-uncertain and exact-ID
repository contracts with backend parity, and replace unsafe shallow comparison and
spread with strict descriptor-safe projections before aggregate validation.

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
- The exchange call necessarily follows a persisted operator-state snapshot, but its
  invocation now occurs in the same submit-method continuation with no asynchronous
  helper-resolution, callback, report, database, timer, or promise seam.
- No subagent was used because no multi-agent/subagent tool was available in this
  session; integration and safety review were performed locally.

## Final Review Fixes

### Additional Files Changed

- `src/modules/db/interfaces.ts`
- `src/modules/db/repositories/in-memory-repositories.ts`
- `src/modules/db/repositories/sqlite-repositories.ts`
- `src/modules/db/repositories/candidate-bound-order-validation.ts`
- `tests/candidate-bound-order-validation.test.ts`
- `tests/candidate-bound-order-intent-in-memory.test.ts`
- `tests/candidate-bound-order-intent-sqlite.test.ts`
- `tests/telegram-operator-contracts.test.ts`

### Review-Fix RED

After adding tests and before changing production code, `npm.cmd run build` exited
0. The focused execution command documented above exited 1 with 5 expected failures:
`FAILED` competitor, `REJECTED` competitor, exact-ID/reference collision,
helper-resolution microtask seam, and caller-local static invariants. The runtime
seam test observed `PAUSED` at send instead of `RUNNING`.

The equivalent focused validator command exited 1 with 4 failures because the strict
projection seam did not exist. The in-memory and SQLite candidate-bound repository
commands each exited 1 with 2 failures because exact account-plus-order-ID and bounded
candidate submission-blocking methods did not exist.

### Review-Fix GREEN

The same commands exited 0 after implementation:

- execution candidate final authority: 16 passed, 0 failed
- candidate bound-order validation: 20 passed, 0 failed
- in-memory candidate-bound repository: 13 passed, 0 failed
- SQLite candidate-bound repository: 11 passed, 0 failed

The first SQLite GREEN attempt exposed SQL three-valued logic that excluded ordinary
`FAILED` rows with a null failure code. The predicate was made explicitly null-safe;
the same command then passed 11/11. A combined focused regression over candidate
validation, both backends, recovery-fault persistence, execution service, send
authority, candidate intent, and candidate final authority exited 0.

### Final Contracts

- Candidate final read order is bounded account submission-blocking rows, exact
  account-plus-order-ID order, first event, persisted `READY` decision, deployment,
  exact candidate state, binding, then final operator state.
- Candidate blocking rows include active lifecycle states and potentially dispatched
  `FAILED`/`REJECTED` rows. Absence-confirmed `FAILED` is excluded, and a saturated
  101-row read fails closed against the 100-row usable ceiling.
- Candidate self must remain present and exact `SUBMITTING`; all competitor,
  saturation, authority, identity, and material failures retain the lease and use the
  dedicated atomic candidate/global pause with zero sends.
- `findOrderById(exchangeAccountId, orderId)` is exact in both backends. SQLite safely
  reuses its private primary-ID lookup and checks account ownership. The ambiguous
  reference API remains unchanged for consumers that explicitly want references.
- Strict projections reject prototype, accessor, symbol, extra, missing, and
  non-enumerable descriptor injection without invoking accessors. Every mutable order
  lifecycle field is matched before only status is projected from `SUBMITTING` to
  `PERSISTED`; the reviewed aggregate validator still runs unchanged.
- The final `operatorState.getState()` await is directly in
  `submitOrderFromDecision`, immediately followed by synchronous checks and the sole
  `createOrder` invocation.
- Noncandidate behavior, global `listActiveOrders` semantics, and the ordinary strict
  recovery-fault API remain unchanged.

### Final Verification

- `npm.cmd run typecheck`: exit 0.
- `npm.cmd run build`: exit 0.
- focused RED/GREEN and combined regression commands: expected RED, then all GREEN.
- `rg -n "\.createOrder\s*\(" src`: exactly one match at
  `src/modules/execution/execution-service.ts:526`.
- `git diff --check`: exit 0; only existing LF-to-CRLF warnings.
- sandboxed `npm.cmd run test`: main harness passed through the changed tests, while
  the isolated prospective suite reported 101/102 because esbuild was denied linked-
  worktree source traversal.
- authorized local `npm.cmd run test` outside that restriction: exit 0; isolated
  prospective suite reported 102 passed, 0 failed.

No network, Upbit, Telegram, operational database, scheduler, sync, live process,
secret, local operational script, activation default, merge, push, or 9C design note
was touched. The bounded 100-row ceiling deliberately requires operator recovery if
the 101-row probe saturates rather than inferring safety from an incomplete set.
