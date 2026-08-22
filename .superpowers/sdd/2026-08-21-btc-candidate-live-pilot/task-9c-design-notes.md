# Task 9C Design Notes: Common BTC Candidate Run Routing

## Status and gate

This is a read-only implementation decomposition. It does not activate the pilot, add an
operator activation surface, change defaults, start runtime services, open an operational
database, or call Upbit/Telegram.

Task 9C must not start until Task 9B2b2 (candidate final pre-send revalidation) has an
implementation report and passes its focused review. The current head contains Task 9B2b1
and its fixes, but Task 9B2b2 has only a brief/design/dispatch note. Wiring candidate
authority before 9B2b2 would expose a runtime path whose final persisted authority is not
yet reread immediately before the sole send.

Recommended order:

1. Complete and review Task 9B2b2.
2. Implement 9C1 (common runner/pure routing and audit contract).
3. Independently review 9C1.
4. Implement 9C2 (controller-level account preparation and runtime wiring).
5. Run focused, full, and static safety verification over 9B2b2 + 9C1 + 9C2.

## Current-state findings

- `PositionGuardStrategyRunner.runOnce()` currently computes, persists, and submits only
  the baseline decision. It has no policy selection, verified-pilot input, router call,
  candidate audit, or `candidateAuthority` propagation.
- `InlineTelegramStrategyRunController` currently runs a LIVE persisted-health preflight
  only for Telegram requests. It has no exchange-backed refresh or candidate recovery.
- `StrategyScheduler` currently owns per-run LIVE refresh and preflight before calling the
  same controller. Therefore manual and scheduled runs do not presently share one
  controller-level preparation path.
- `createApp()` does not pass `candidatePilots` to `ExecutionService`, construct
  `PositionGuardPilotRecovery`, validate local abandonment authority, or use
  `config.positionGuardPolicySelection` when constructing the runner.
- `PositionGuardPilotRecovery` is implemented and heavily reviewed, but its constructor
  requires a deployment ID that `AppConfig` does not contain, and its `READY` result
  returns exact decimal state rather than the number-based strategy state expected by the
  pure router.
- `PortfolioSyncService.run()` returns exact balance/position records but only a
  reconciliation summary, not the exact persisted reconciliation-run ID/timestamps needed
  to build `PositionGuardPilotRefreshReceipt` without a race-prone latest-row inference.
- `validatePositionGuardPilotAbandonment()` is pure and tested but has no runtime caller.
- The candidate dependency-boundary test currently forbids all runtime reachability to
  candidate modules. That was correct before Task 9C, but it must become an exact reviewed
  allowlist rather than simply being deleted or broadly weakened.

## Required execution sequence

For an explicitly configured candidate selection and `KRW-BTC`, both Telegram and
scheduler requests must follow this one sequence:

1. The controller performs one exchange-backed account refresh through
   `PortfolioSyncService`, persisting balance snapshot, position snapshot, and the exact
   reconciliation run.
2. The controller runs one common persisted-health preflight against those refreshed rows,
   including execution state, live gate/send path, kill switch, freshness, reconciliation,
   and active-order checks.
3. The runner builds the unchanged baseline market snapshot, context, engine decision, and
   baseline `StrategyDecision`. Nothing is persisted and no order input exists yet.
4. The runner invokes the candidate recovery verifier with the exact refresh receipt. A
   `BLOCKED_FAULT` result ends the run with no strategy decision row and no execution input;
   the recovery service has already durably applied the required pilot/global pause.
5. On `READY`, the runner calls `routePositionGuardPolicy()` exactly once.
6. The runner converts only `route.executionDecision` to the effective
   `StrategyDecision`. The baseline decision is never passed to order conversion after a
   candidate route.
7. The runner persists one `strategy_decisions` row whose action/status/notional/quantity
   describe the effective decision and whose audit contains baseline, candidate, effective,
   selection, deployment, phase, reason, state version, and refresh provenance.
8. For an executable `ACTIVE` candidate route only, the runner derives a typed
   `CandidateExecutionAuthority` exclusively from verified recovery output plus the route
   reason and attaches it to the execution input. `ExecutionService` continues to own every
   order/wire/binding field.
9. The existing execution service performs lease/risk/chance/test, atomic bound-intent
   persistence, final pre-send revalidation, final operator-state read, and its sole send.

This ordering resolves the apparent wording conflict in the plan: account refresh and
ordinary persisted preflight occur before strategy evaluation, but the unchanged baseline
decision is computed before verified pilot state is consumed by the router. Recovery is
therefore close to routing while the baseline context still uses the just-refreshed account
snapshots.

For baseline selection and every `KRW-ETH` run:

- no account-refresh receipt is required by candidate code;
- no candidate deployment/state/evidence/audit repository read occurs;
- the runner routes once through the baseline/ETH branch (or preserves the existing
  baseline result through an equivalent common helper);
- no `CandidateExecutionAuthority` or binding is created; and
- existing baseline LIVE/manual/scheduler behavior remains unchanged.

## Minimal interface seams that must be resolved

### 1. Exact reconciliation receipt (required)

Do not construct a recovery receipt by reading a merely-latest reconciliation row after
`PortfolioSyncService.run()`. Another process can persist a reconciliation between those
operations.

Preferred minimal seam: add a result-preserving reconciliation API that returns both the
existing `ReconciliationSummary` and the exact `ReconciliationRunRecord` it persisted, then
include that record in `PortfolioSyncRunResult`. Keep existing generic reconciliation
callers on their current summary API if necessary. The candidate preparer can then build:

```ts
type PositionGuardPilotRefreshReceipt = Readonly<{
  exchangeAccountId: string;
  requestedAt: string;
  balanceSnapshotId: string;
  balanceCapturedAt: string;
  positionSnapshotId: string;
  positionCapturedAt: string;
  reconciliationRunId: string;
  reconciliationStartedAt: string;
  reconciliationCompletedAt: string;
  reconciliationSource: "SCHEDULER_PREFLIGHT";
}>;
```

The source name is inherited from the current closed trigger vocabulary. Either document
that `SCHEDULER_PREFLIGHT` now denotes the common strategy-run refresh, or add a separately
reviewed `STRATEGY_RUN_PREFLIGHT` trigger everywhere (interfaces, persistence validation,
recovery allowlist, tests, and root docs). Do not silently use different sources for manual
and scheduler candidate runs.

### 2. Deployment discovery (required)

`PositionGuardPilotRecovery` requires `deploymentId`, while configuration identifies only
the approved pilot. Do not invent a deployment ID or assume it equals the pilot ID.

Preferred minimal seam: give recovery an explicit discriminated lookup mode and add
`getDeploymentForExchangeAccount` to its narrow repository dependency:

```ts
type CandidateRecoveryDeploymentTarget =
  | Readonly<{ kind: "EXACT_DEPLOYMENT"; deploymentId: string }>
  | Readonly<{ kind: "CONFIGURED_ACCOUNT_PILOT" }>;
```

Production uses `CONFIGURED_ACCOUNT_PILOT`; existing focused tests may retain
`EXACT_DEPLOYMENT`. The account lookup must establish the exact configured account,
pilot/market/policy/version identity before later reads switch to exact deployment ID. A
missing row uses the existing global-only deterministic fault path; it must not synthesize
a deployment. More than one/ambiguous row must fail closed.

### 3. Exact state to routing state (required)

The recovery result's exact decimal strings are the verified authority; rereading
`candidatePilots.getState()` after recovery would create a stale-read gap. Add one pure,
canonical conversion helper at the already-approved persistence projector bridge
(`pilot-interfaces.ts` is the natural location), return a detached/frozen
`PositionGuardCandidateState`, and validate every finite conversion. Both repositories'
private `approximateState` implementations should delegate to the same helper so runtime,
in-memory, and SQLite semantics cannot drift.

The runner receives this converted state only from the successful recovery adapter. It must
never accept caller-supplied candidate state independently of verified recovery output.

### 4. Local abandonment authority and dependency boundary (required)

Candidate-configured app construction must validate the exact checked-in ABANDONED registry
event before installing candidate hooks. Baseline construction must not read candidate
authority. Use a narrow loader/override that can be fixture-driven in tests; do not import
research evaluators or make network/Git/GitHub calls. A missing, malformed, mutated, or
non-exact event rejects candidate startup or prevents candidate hooks from being installed.

Update `position-guard-candidate-dependency-boundary.test.ts` from blanket runtime
disconnection to an exact graph allowlist. Permit only the reviewed runner/persistence
bridge to reach the pure router/evaluator/projector chain. Continue forbidding candidate
modules from environment, filesystem, DB, exchange, reconciliation, Telegram, scheduler,
network, and order-submission APIs. Do not broadly allow all strategy or app modules.

### 5. Startup recovery ambiguity (plan gap)

The design spec says candidate recovery runs at startup and before every BTC candidate run,
but Task 9's owned files and tests describe only per-run integration. `main()` currently
runs generic startup portfolio recovery without creating a candidate receipt or invoking
`PositionGuardPilotRecovery`.

Minimal ruling needed before implementation: either (a) explicitly scope 9C to per-run and
create a separately owned startup-candidate verification task before any pilot operation,
or (b) expand 9C2 ownership to `src/index.ts`/startup-recovery tests and pass the exact
startup refresh receipt through the same recovery verifier. Do not claim full spec coverage
while leaving this unresolved.

## Task 9C1: Common runner, routing, audit, and authority

### Disjoint ownership

- Modify `src/domain/pilot-types.ts` only for neutral refresh/verified-run DTOs if needed.
- Modify `src/modules/db/pilot-interfaces.ts` only for the pure exact-to-routing-state bridge.
- Modify `src/modules/strategy/position-guard-runner.ts`.
- Modify `tests/position-guard-runner.test.ts`.
- Modify `tests/position-guard-candidate-dependency-boundary.test.ts`.
- Add one focused runner test file only if keeping candidate cases separate materially
  improves readability; register it in `tests/run-all.ts`.

9C1 must not modify controller, scheduler, create-app, recovery orchestration,
reconciliation, portfolio sync, execution service, repository persistence methods,
configuration parsing, scripts, or docs.

### Runner contract

Add an optional candidate runtime dependency installed only by 9C2. Keep default runner
configuration baseline:

```ts
interface PositionGuardCandidateRunVerifier {
  verifyAndPrepareBtcRun(
    receipt: PositionGuardPilotRefreshReceipt,
  ): Promise<PositionGuardRunnerPilotVerificationResult>;
}

type PositionGuardRunnerPilotVerificationResult =
  | Readonly<{
      status: "READY";
      deployment: PositionGuardPilotDeploymentRecord;
      phase: "PENDING_FLAT" | "ACTIVE";
      activation: Readonly<{ activationAt: string; activationEpochNs: bigint }> | null;
      candidateState: Readonly<PositionGuardCandidateState>;
      stateVersion: number;
      refreshProvenance: Readonly<PositionGuardPilotRefreshReceipt>;
    }>
  | Readonly<{
      status: "BLOCKED_FAULT";
      reasonCode: CandidatePilotRecoveryFaultReason;
      faultId: string;
      executableAuthority: false;
    }>;
```

`PositionGuardRunInput` may carry a refresh receipt, but never a deployment, phase, state,
route result, candidate authority, order material, or precomputed decision. The verifier
output is the only candidate authority input.

The runner's candidate-capable path is:

```text
build baseline snapshot/context/engine/strategy decision
-> verify exact refresh/recovery authority
-> routePositionGuardPolicy exactly once
-> convert executionDecision only
-> persist one complete audit
-> derive candidate authority only when eligible
-> convert effective decision only to order input
-> submit through existing ExecutionService
```

On `BLOCKED_FAULT`, return/throw an explicit pre-persistence blocked result that the
controller maps to `FAILED`. Do not persist a normal strategy decision representing a
candidate route that never occurred, and never create an execution input.

### Audit schema

Keep the existing top-level `strategyDecision`, `engineDecision`, `context`, and metadata
compatible, but make them represent the effective decision. Add one stable object such as:

```ts
policyRoute: {
  schemaVersion: "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1";
  configuredSelection: PositionGuardPolicySelection;
  resolvedSelection: "BASELINE" | "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  baselineDecision: PositionGuardEngineDecision;
  baselineStrategyDecision: StrategyDecision;
  candidateEvaluation: PositionGuardCandidateEvaluation | null;
  effectiveDecision: PositionGuardEngineDecision;
  effectiveStrategyDecision: StrategyDecision;
  executionBlocked: boolean;
  executionDecision: PositionGuardEngineDecision | null;
  deploymentId: string | null;
  pilotId: string | null;
  policyId: string | null;
  policyVersion: string | null;
  phase: PositionGuardPilotPhase;
  activationAt: string | null;
  stateVersion: number | null;
  reasonCode: PositionGuardPolicyRouteReason;
  refreshProvenance: PositionGuardPilotRefreshReceipt | null;
}
```

Persist canonical detached data; do not serialize bigint directly. The decision row's
`action`, `status`, `intendedNotionalKrw`, and `intendedQuantity` must match
`effectiveStrategyDecision`, because Task 9B binding validation rereads those columns.

### Candidate authority rules

- `ACTIVE` + executable `CANDIDATE_ALLOWED`: attach authority.
- `ACTIVE` + executable `CANDIDATE_EARLY_THESIS_FAILURE` (EXIT only): attach authority.
- `PENDING_FLAT` risk reduction: execute baseline reduction without candidate authority or
  binding, as required by Task 9B's exclusion matrix.
- `CANDIDATE_SUPPRESSED`, any HOLD, deferred confirmation, blocked route, baseline, and ETH:
  no execution input or no candidate authority as applicable.
- Authority fields come from verified deployment/activation/state plus route reason. The
  runner cannot set order ID, binding ID, identifier, action/side/order type, price, volume,
  TIF, SMP, mode, material version/hash, or execution-attempt timestamps.

### 9C1 TDD RED matrix

1. Baseline engine decision is built before the verifier is called.
2. Successful candidate BTC verification calls the router exactly once.
3. Blocked recovery calls the router zero times, persists no decision, creates no execution
   input, and submits no order.
4. Candidate allow preserves baseline entry/add sizing exactly.
5. Candidate suppression persists effective HOLD while retaining complete baseline and
   candidate audit.
6. Candidate override-exit persists/executes EXIT, never the baseline action.
7. Only `executionDecision` reaches `toStrategyDecision`/`toOrderSubmissionInput`.
8. Effective decision columns and full audit agree exactly.
9. ACTIVE executable routes attach exact candidate authority; excluded routes do not.
10. PENDING_FLAT ENTER/ADD becomes HOLD; REDUCE/EXIT remains baseline and unbound.
11. ETH under candidate selection reads no verifier/candidate repository and remains
    baseline with `ETH_BASELINE` audit.
12. Baseline selection needs no verifier or receipt and preserves existing execution and
    preview behavior.
13. Exact-to-routing-state conversion is detached/frozen, validates finite representability,
    and has in-memory/SQLite parity through one helper.
14. Dependency-boundary tests allow only the exact reviewed runtime bridge and still reject
    all side-effect imports from candidate modules.

### 9C1 review gate

A reviewer can approve 9C1 independently because tests use fake verifier/router/execution
dependencies and no runtime wiring. Required output is a runner that is candidate-capable
but unreachable from default production construction until 9C2.

## Task 9C2: Controller preparation and runtime integration

### Disjoint ownership

- Modify `src/app/position-guard-pilot-recovery.ts` for explicit account-pilot deployment
  lookup mode and/or neutral DTO adaptation only.
- Modify `src/app/scheduler-preflight.ts` to expose one common per-run persisted-health
  preflight/freshness policy while preserving existing wrapper outputs.
- Modify `src/app/strategy-run-controller.ts`.
- Modify `src/app/create-app.ts`.
- Modify the smallest reconciliation/portfolio-sync interfaces and services needed to
  return the exact persisted reconciliation record.
- Modify `tests/position-guard-pilot-recovery.test.ts`,
  `tests/scheduler-preflight.test.ts`, `tests/strategy-run-controller.test.ts`,
  `tests/create-app.test.ts`, and the focused portfolio/reconciliation tests.
- Modify `tests/strategy-scheduler.test.ts` only to prove the candidate wiring does not
  duplicate scheduler-level per-run hooks and batch behavior remains unchanged.
- Modify `src/index.ts` and startup tests only if the controller rules that startup candidate
  verification is part of 9C2.

9C2 must not modify runner files/tests, execution service, candidate binding persistence,
candidate policy/router behavior, configuration defaults/parser, migrations, scripts,
Telegram commands/presentation, or activation/rollback APIs.

### Controller preparation contract

Add one dependency installed only for exact configured candidate selection:

```ts
interface CandidateBtcRunPreparation {
  prepare(request: TelegramStrategyRunRequest): Promise<
    | Readonly<{ status: "READY"; refreshReceipt: PositionGuardPilotRefreshReceipt }>
    | Readonly<{ status: "BLOCKED"; detail: string }>
  >;
}
```

The implementation performs refresh then common persisted preflight. It is called for both
`requestedBy: "TELEGRAM"` and `requestedBy: "SCHEDULER"` when market is `KRW-BTC`.
`KRW-ETH` and baseline selection never call it. A refresh/preflight failure returns before
`runner.runOnce()`; a recovery mismatch occurs later inside the runner verifier and uses
the atomic recovery fault path.

Use the same explicit freshness threshold for preflight and recovery. Export one helper
from `scheduler-preflight.ts` (currently the minimum configured market cadence) rather than
duplicating arithmetic in `create-app.ts`.

### Conditional scheduler wiring

- Baseline selection: preserve current scheduler `beforeRunAccountRefresh` and
  `beforeRunPreflight` wiring byte-for-byte.
- Candidate selection: omit scheduler per-run refresh/preflight hooks; the scheduler calls
  the shared controller, which performs the candidate BTC preparation. Keep scheduler
  startup preflight unchanged.
- Keep scheduler queue serialization, shared-account refresh behavior, run records,
  notifications, and one-order-per-batch deferral unchanged.
- Candidate `KRW-ETH` remains baseline. It must not accidentally inherit BTC candidate
  preparation merely because selection is globally configured.

### `createApp()` wiring

Only when `config.positionGuardPolicySelection.kind === "BTC_CANDIDATE_PILOT"`:

1. Validate the exact local abandonment authority.
2. Install the candidate controller preparation dependency.
3. Install the runner verifier adapter that calls `PositionGuardPilotRecovery` and converts
   exact state through the canonical bridge.
4. Pass `persistence.candidatePilots` to `ExecutionService` for Task 9B authority checks.
5. Pass the explicit policy selection to the runner.

Baseline app construction must not perform steps 1-3 and must preserve DRY_RUN/live-send
selection. Step 4 may be installed unconditionally if it has no behavior without
`candidateAuthority`, but tests must prove baseline submissions remain identical.

No code may create/activate a deployment, enable LIVE orders, enable scheduler timers,
change `STRATEGY_SCHEDULER_RUN_ON_START`, add an env default, add a Telegram command, or
create a checked-in activation script.

### 9C2 TDD RED matrix

1. Manual and scheduled candidate BTC requests call the same preparation object and produce
   the same ordered trace: refresh -> persisted preflight -> baseline -> recovery -> router
   -> decision persistence -> optional execution.
2. Each request uses the exact balance, position, and reconciliation identities returned by
   its own refresh; latest-row substitution fails closed.
3. Refresh failure and persisted preflight block occur before baseline/decision/order input.
4. Recovery identity/replay/inventory/freshness/reconciliation/order mismatch atomically
   pauses pilot/global state and produces no execution input.
5. Manual and scheduler successful runs persist the same audit schema and provenance fields.
6. Candidate hooks are installed only for exact candidate selection plus valid abandonment
   authority; malformed/missing authority fails startup closed.
7. Missing/ambiguous deployment uses the deterministic global-only fault behavior and never
   synthesizes or mutates a deployment.
8. `createApp()` supplies `candidatePilots` to `ExecutionService`; valid authority reaches
   atomic bound-intent persistence, while baseline/ETH remains unbound.
9. Candidate scheduler wiring has no scheduler-owned per-run refresh/preflight calls; the
   controller path is called once.
10. Baseline scheduler tests retain current refresh/preflight behavior.
11. ETH under candidate config performs no candidate refresh/recovery/state mutation and
    remains baseline.
12. Existing simultaneous-market serialization and one-order-per-batch deferral remain
    unchanged.
13. Default config, missing pilot env, scheduler disabled, and RUN_ON_START false leave the
    candidate unreachable and automatic/live behavior off.
14. No new operational/Telegram activation surface exists.
15. If startup verification is included, it consumes the exact startup refresh receipt and
    can only verify/pause; it never creates orders, decisions, or implicit resume.

## Safety invariants for both subtasks

- Default policy remains `BASELINE`; default execution remains `DRY_RUN`; scheduler and
  inbound polling remain disabled by default.
- Candidate selection remains BTC-only, exact policy/version-only, LIVE-mode-only, and
  explicitly confirmed. ETH is always baseline.
- Account refresh/reconciliation/recovery never persists a strategy decision, order intent,
  first order event, binding, or send.
- Recovery success never resumes operator/global state. Recovery faults are deterministic,
  durable, restart-idempotent, and atomic where a legitimate deployment exists.
- Router invocation is exactly one on a prepared route and zero on pre-route failure.
- Baseline is computed before verified state is consumed; only effective decision fields are
  persisted as executable decision columns and converted to an execution input.
- Candidate authority is immutable verified provenance, not caller-selected order material.
- `ExecutionService` remains the sole production `.createOrder(` caller.
- Task 9B2b2 candidate rereads all persisted authority before the final
  `operatorState.getState()`; that state read remains the final await before the sole send.
- Candidate binding/order/event persistence remains atomic. A committed bound order is
  lookup-only after a later fault and is never automatically resent.
- Lease, duplicate protection, stale-price, minimum-order, risk/chance/test, uncertain-send,
  post-send persistence, and scheduler batch protections remain unchanged.
- No migration is expected. Stop and report rather than editing migrations if an actual RED
  test proves otherwise.
- No checked-in script/default may set pilot ID/confirmation, enable live orders, enable the
  scheduler, or enable run-on-start.

## Expected commands

Establish focused RED and GREEN separately for each subtask. Example focused harness form:

```powershell
npx.cmd tsx -e "(async () => { await import('./tests/position-guard-runner.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"
```

For 9C2, import the focused controller, scheduler-preflight, create-app, recovery, and exact
receipt test modules in the same harness form. Then run:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
rg -n "\.createOrder\(" src
rg -n "POSITION_GUARD_PILOT_(ID|CONFIRMATION)|BTC_COMBINED_CONSERVATIVE_PILOT_V1" .env.example scripts src
git diff --check
git status --short
```

Expected static results:

- exactly one production `.createOrder(` call, in `ExecutionService`;
- no checked-in activation value/default/script;
- no runner/controller/scheduler candidate wiring when policy selection is baseline;
- no unexpected files outside each subtask's ownership; and
- full test suite passes after 9B2b2 + 9C1 + 9C2 integration.

## Review checkpoints

9C1 review should focus on call order, one router call, audit-column consistency, effective
decision-only conversion, authority exclusion, and the exact dependency allowlist.

9C2 review should focus on exact refresh receipt identity, one controller preparation path,
conditional scheduler wiring, candidate-only app construction, deployment/abandonment
authority, atomic mismatch pause, ETH isolation, and preservation of baseline/scheduler
behavior.

The integrated review must reapply the original Task 9 checklist and specifically verify
that Task 9B2b2 is present; 9C must not be approved merely because routing tests pass.
