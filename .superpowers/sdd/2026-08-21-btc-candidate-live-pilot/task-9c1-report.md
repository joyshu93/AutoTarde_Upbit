# Task 9C1 Report: Route Verified BTC Pilot Decisions

## Outcome

Implemented candidate-capable PositionGuard runner routing without wiring the capability into
`createApp`. The default runner branch and preview remain on the original baseline path. Candidate
BTC runs accept only an exact refresh receipt, build baseline first, verify persisted pilot
authority, route once, persist effective decision columns plus a detached route audit, and pass only
the routed execution decision to the existing execution service.

Base HEAD: `6c50af61242cf53125386baa0e5eb15534d2eca7`

Commit message: `feat: route verified btc pilot decisions`

## RED Evidence

The focused Task 9C1 test file was added before production implementation.

```powershell
npx.cmd tsx -e "(async () => { await import('./tests/position-guard-candidate-runner.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"
```

Result: exit `1`, `11` expected failures and `2` existing-behavior passes. Failures covered missing
baseline-before-verifier ordering, router invocation, BLOCKED fault stop, suppression/override,
execution-decision-only input, complete audit, authority, PENDING_FLAT, ETH audit, and exact-state
conversion. Existing baseline sizing and byte-equivalent default behavior already passed.

After the runner implementation, the unchanged dependency-boundary test established a second RED:

```powershell
npx.cmd tsx -e "(async () => { await import('./tests/position-guard-candidate-dependency-boundary.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"
```

Result: exit `1`; `11` passed and the runtime candidate-bridge case failed because the new runner
route was not yet in the exact allowlist.

## GREEN Evidence

```powershell
npx.cmd tsx -e "(async () => { await import('./tests/position-guard-runner.test.ts'); await import('./tests/position-guard-candidate-runner.test.ts'); await import('./tests/position-guard-candidate-dependency-boundary.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"
```

Result: exit `0`, `31/31` passed.

```powershell
npm.cmd run typecheck
```

Result: exit `0`.

```powershell
npm.cmd run build
```

Result: exit `0`.

```powershell
npm.cmd run test
```

The first linked-worktree sandbox run passed the main harness but its isolated prospective-shadow
child exited `1` because required source traversal was denied. The identical command was rerun
outside that restriction and exited `0`; the isolated prospective suite reported `102` passed,
`0` failed.

```powershell
rg -n "\.createOrder\s*\(" src
```

Result: exactly one production match at
`src/modules/execution/execution-service.ts:526`.

```powershell
rg -n "POSITION_GUARD_PILOT_(ID|CONFIRMATION)|BTC_COMBINED_CONSERVATIVE_PILOT_V1" .env.example scripts
```

Result: exit `1`, no activation value/default/script match.

```powershell
rg -n "policySelection|candidateRunVerifier|PositionGuardCandidateRunVerifier|routePositionGuardPolicy" src/app/create-app.ts
```

Result: exit `1`, no current production construction reachability.

```powershell
git diff --check
```

Result: exit `0`; Git emitted only line-ending conversion warnings.

## Changed Files

- `src/domain/pilot-types.ts`
- `src/modules/db/pilot-interfaces.ts`
- `src/modules/strategy/position-guard-runner.ts`
- `tests/position-guard-candidate-runner.test.ts`
- `tests/position-guard-candidate-dependency-boundary.test.ts`
- `tests/run-all.ts`
- `.superpowers/sdd/2026-08-21-btc-candidate-live-pilot/task-9c1-report.md`

## Preserved Invariants

- Default construction uses the original baseline persistence/execution branch; the focused test
  compares its complete decision record bytes except the generated record ID.
- Preview never calls the candidate verifier, persists a decision, submits an order, or derives
  candidate authority.
- ETH under candidate selection calls no verifier and carries no deployment, state, refresh, or
  candidate authority; its audit reason is `ETH_BASELINE`.
- Candidate BTC baseline snapshot/context/engine/strategy decision is complete before verification.
- `BLOCKED_FAULT` throws the explicit pre-persistence blocked error, routes zero times, saves zero
  normal decision rows, and creates zero execution inputs.
- READY routes once. Persisted action/status/notional/quantity describe the effective strategy
  decision and the route audit retains baseline, candidate, effective, selection, identity, phase,
  reason, state version, execution decision, and exact refresh provenance.
- Only the route execution decision can create an order input. ACTIVE executable
  `CANDIDATE_ALLOWED` and EXIT-only `CANDIDATE_EARLY_THESIS_FAILURE` receive authority.
- PENDING_FLAT risk reduction remains baseline and unbound. HOLD, suppressed, deferred, baseline,
  and ETH paths do not attach authority.
- Candidate authority contains verified deployment/activation/state/route provenance only; it has no
  order, binding, identifier, side, order type, price, volume, mode, hash, or attempt timestamp field.
- Exact state conversion rejects non-finite number projection and returns detached frozen routing
  state matching the established repository approximation values.
- The runtime candidate dependency allowlist is exact: runner to router, router to candidate
  policy/state, candidate policy to candidate state, plus the pre-existing persistence projector
  importers. Candidate modules remain forbidden from side-effect and operational imports.
- No controller, scheduler, create-app, recovery, execution service, repository implementation,
  reconciliation, sync, config, script, migration, Telegram, root document, or live surface changed.

## Assumptions And Remaining Risks

- Task 9C2 must supply the exact per-run receipt and verifier dependency and explicitly select the
  candidate policy. Until then, current production construction cannot reach this capability.
- The canonical exact-to-routing conversion is now the runner bridge. Existing in-memory and SQLite
  approximation implementations were intentionally not edited under 9C1 ownership; focused expected
  values and the full backend suite confirm parity for the established representation.
- Startup candidate verification remains a 9C2/controller ownership decision and is not claimed here.
- No subagent tool was available in this session. Implementation, integration, diff review, and
  verification were performed in the main session without expanding ownership.
