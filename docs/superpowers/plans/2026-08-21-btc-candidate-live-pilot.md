# BTC Combined Conservative LIVE Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly selected, BTC-only `COMBINED_CONSERVATIVE` LIVE pilot with persisted exchange-backed candidate state, duplicate-process protection, uncertain-submission recovery, automatic fault pause, and a strictly read-only readiness surface without activating the pilot.

**Architecture:** Keep `PositionGuardStrategyRunner` as the common manual/scheduler decision path and `ExecutionService` as the only Upbit order-send authority. Introduce a pure BTC policy router, separate pilot-state and account-lease repositories, an idempotent terminal-order evidence service, and fail-closed recovery/preflight services. Runtime configuration remains `BASELINE` by default; implementation and no-order validation are separate from operational activation.

**Tech Stack:** TypeScript 5.8 strict mode, Node.js 22 `node:sqlite`, the existing custom test harness, SQLite migrations, Upbit adapter interfaces, and Korean-first Telegram presentation modules.

**Spec:** `docs/superpowers/specs/2026-08-21-btc-candidate-live-pilot-design.md`

## Global Constraints

- Upbit only; `KRW-BTC` and `KRW-ETH` spot only; no leverage, margin, futures, news, sentiment, or LLM decisions.
- Default selection is `BASELINE`; missing or empty pilot configuration must never select the candidate.
- The only candidate identity is `BTC_COMBINED_CONSERVATIVE_PILOT_V1`, mapped exactly to `KRW-BTC`, `COMBINED_CONSERVATIVE`, and `PCS-2026-001.DEPLOYMENT_READINESS_V1`.
- `KRW-ETH` remains baseline in every pilot phase.
- Existing percentage sizing is preserved exactly: candidate logic may allow, suppress, or exit but may not recalculate notional or quantity.
- `ExecutionService` remains the only production source file allowed to call `ExchangeAdapter.createOrder()`.
- Candidate state advances only from terminal exchange-backed strategy-order evidence with non-zero executed quantity and confirmed fee data.
- Any unknown fee, contradictory evidence, state mismatch, lease ambiguity, uncertain send, or post-send persistence failure fails closed and never triggers an automatic retry or resume.
- Operational SQLite files may not be opened during implementation tests. All migration and integration tests use temporary databases.
- The strict readiness CLI opens an existing database with `readOnly: true` and must not run migrations, WAL configuration, app creation, sync, Telegram, exchange reads, scheduler ticks, or order mutation.
- Checked-in examples remain `DRY_RUN`, baseline-selected, scheduler-disabled, and live-order-disabled.
- No task in this plan starts the operational app, calls Upbit, polls Telegram, sends an order, changes the operational database, or activates the pilot.
- Commit checkpoints are local implementation checkpoints. Do not push or activate LIVE operation without a separate explicit operator request.

## File Map

- `src/domain/pilot-types.ts`: explicit pilot, evidence, state, lease, and fault-pause domain contracts.
- `src/app/position-guard-pilot-config.ts`: fail-closed environment parsing and exact pilot identity mapping.
- `src/modules/strategy/position-guard-pilot-authority.ts`: pure validation of the exact published abandonment record.
- `src/modules/strategy/position-guard-candidate-state.ts`: pure fee-inclusive inventory, cost-basis, realized-PnL, and cursor projection.
- `src/modules/strategy/position-guard-policy-router.ts`: pure baseline/BTC-candidate phase routing.
- `src/modules/db/pilot-interfaces.ts`: separate candidate-pilot and account-execution-lease repository contracts.
- `src/modules/db/repositories/*candidate-pilot*`: SQLite and in-memory candidate deployment/state/evidence implementations.
- `src/modules/db/repositories/*execution-lease*`: SQLite and in-memory account lease implementations.
- `src/modules/exchange/errors.ts`: typed definitive-versus-uncertain exchange submission errors.
- `src/modules/execution/candidate-evidence-service.ts`: terminal strategy-order aggregation and idempotent state advancement.
- `src/modules/execution/execution-service.ts`: lease ownership, atomic lifecycle writes, and uncertain submission handling.
- `src/modules/reconciliation/reconciliation-service.ts`: bounded identifier recovery and terminal evidence handoff.
- `src/modules/strategy/position-guard-runner.ts`: one reviewed runtime bridge to the pure policy router.
- `src/app/position-guard-pilot-recovery.ts`: startup/per-run state replay, flat activation, and fault pause.
- `src/inspection/position-guard-pilot-readiness.ts`: strict read-only inspection CLI.
- `src/modules/telegram/presentation/{status,readiness,run,preview}.ts`: Korean-first pilot visibility only; no activation command.

---

### Task 1: Freeze Pilot Identity, Configuration, and Abandonment Authority

**Files:**
- Create: `src/domain/pilot-types.ts`
- Create: `src/app/position-guard-pilot-config.ts`
- Create: `src/modules/strategy/position-guard-pilot-authority.ts`
- Modify: `src/app/env.ts`
- Test: `tests/position-guard-pilot-config.test.ts`
- Test: `tests/position-guard-pilot-authority.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `PositionGuardPolicySelection`, `POSITION_GUARD_PILOT_ID`, `POSITION_GUARD_PILOT_CONFIRMATION`, `parsePositionGuardPolicySelection()`, and `validatePositionGuardPilotAbandonment()`.
- Consumes: the exact `ABANDONED` registry record in `docs/research/prospective-shadow/registry.jsonl` and existing `POSITION_GUARD_CANDIDATE_POLICY_VERSION`.

- [ ] **Step 1: Write failing tests for the exact allow-list and authority record**

```ts
test("pilot config defaults to baseline and rejects every implicit candidate selection", () => {
  assert.deepEqual(parsePositionGuardPolicySelection({}), { kind: "BASELINE", pilotId: null });
  assert.throws(() => parsePositionGuardPolicySelection({ POSITION_GUARD_PILOT_ID: "combined_conservative" }));
  assert.throws(() => parsePositionGuardPolicySelection({ POSITION_GUARD_PILOT_ID: "COMBINED_MINUS_COOLDOWN_CONTROL" }));
});

test("the only LIVE pilot maps to the frozen BTC policy and exact confirmation", () => {
  const selection = parsePositionGuardPolicySelection({
    APP_EXECUTION_MODE: "LIVE",
    POSITION_GUARD_PILOT_ID: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    POSITION_GUARD_PILOT_CONFIRMATION: "I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT",
  });
  assert.equal(selection.kind, "BTC_CANDIDATE_PILOT");
  if (selection.kind !== "BTC_CANDIDATE_PILOT") throw new Error("expected candidate pilot");
  assert.equal(selection.market, "KRW-BTC");
  assert.equal(selection.policyId, "COMBINED_CONSERVATIVE");
  assert.equal(selection.policyVersion, "PCS-2026-001.DEPLOYMENT_READINESS_V1");
});

test("pilot authority accepts only the exact published abandonment", () => {
  assert.deepEqual(validatePositionGuardPilotAbandonment(EXACT_ABANDONED_EVENT), {
    valid: true,
    experimentId: "PCS-2026-001",
    eventAt: "2026-08-21T03:08:24.756Z",
  });
  assert.throws(() => validatePositionGuardPilotAbandonment({ ...EXACT_ABANDONED_EVENT, event: "REGISTERED" }));
});
```

- [ ] **Step 2: Run the full test entrypoint and verify the new imports fail**

Run: `npm.cmd run test`

Expected: FAIL because the pilot types, parser, and authority validator do not exist.

- [ ] **Step 3: Implement the explicit, fail-closed contracts**

```ts
export const POSITION_GUARD_PILOT_ID = "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const;
export const POSITION_GUARD_PILOT_CONFIRMATION = "I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT" as const;

export type PositionGuardPolicySelection =
  | Readonly<{ kind: "BASELINE"; pilotId: null }>
  | Readonly<{
      kind: "BTC_CANDIDATE_PILOT";
      pilotId: typeof POSITION_GUARD_PILOT_ID;
      market: "KRW-BTC";
      policyId: "COMBINED_CONSERVATIVE";
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
      liveOperatorConfirmed: true;
    }>;
```

The authority validator must compare every material field of the exact published record, including experiment ID, payload hash, publication commit, event timestamp, and reason. It must not accept a later semantic approximation.

- [ ] **Step 4: Run focused typecheck and the full test suite**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with baseline behavior unchanged when pilot variables are absent.

- [ ] **Step 5: Commit the identity boundary**

```powershell
git add src/domain/pilot-types.ts src/app/position-guard-pilot-config.ts src/modules/strategy/position-guard-pilot-authority.ts src/app/env.ts tests/position-guard-pilot-config.test.ts tests/position-guard-pilot-authority.test.ts tests/run-all.ts
git commit -m "feat: freeze btc pilot identity"
```

### Task 2: Extend the Pure Candidate State Projector

**Files:**
- Modify: `src/modules/strategy/position-guard-candidate-state.ts`
- Test: `tests/position-guard-candidate-state.test.ts`

**Interfaces:**
- Produces: fee-inclusive `PositionGuardCandidateState`, `PositionGuardCandidateExecutionEvidence`, `advancePositionGuardCandidateState()`, and `projectPositionGuardCandidateState()`.
- Consumes: `POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE = 1e-12` and explicit-offset ISO timestamps.

- [ ] **Step 1: Add failing projector tests for buy, partial sell, full exit, and invalid evidence**

```ts
test("candidate state uses confirmed fees in cost basis and full-exit pnl", () => {
  const entered = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "e1", executedQuantity: 2, grossQuoteValueKrw: 20_000, confirmedFeeKrw: 10,
  }));
  assert.equal(entered.currentEpisodeInventoryQuantity, 2);
  assert.equal(entered.currentEpisodeCostBasisKrw, 20_010);

  const exited = advancePositionGuardCandidateState(entered, sellEvidence({
    evidenceId: "e2", executedQuantity: 2, grossQuoteValueKrw: 22_000, confirmedFeeKrw: 11,
  }));
  assert.equal(exited.currentEpisodeInventoryQuantity, 0);
  assert.equal(exited.lastFullExitRealizedPnlKrw, 1_979);
});

test("missing fees, conflicting residuals, duplicates, and out-of-order evidence fail closed", () => {
  assert.throws(() => advancePositionGuardCandidateState(emptyState(), buyEvidence({ confirmedFeeKrw: null })));
  assert.throws(() => projectPositionGuardCandidateState({ initialState: emptyState(), evidence: [evidence("e1"), evidence("e1")] }));
});
```

- [ ] **Step 2: Run tests and confirm the old reduced state model fails**

Run: `npm.cmd run test`

Expected: FAIL on missing inventory, cost-basis, fee, and state-version fields.

- [ ] **Step 3: Implement deterministic state advancement**

The state must include `currentEpisodeInventoryQuantity`, `currentEpisodeCostBasisKrw`, `currentEpisodeRealizedPnlKrw`, `currentEpisodeAddCount`, full-exit metadata, entry path, cursor, and `stateVersion`. Buy cost is `grossQuoteValueKrw + confirmedFeeKrw`; sell realized PnL is `grossQuoteValueKrw - confirmedFeeKrw - proportionalRemovedCost`. A remaining quantity within `1e-12` closes the episode. Sort by parsed epoch nanoseconds and stable evidence ID, never by raw ISO text.

- [ ] **Step 4: Verify parity and numerical edge cases**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS for mixed offsets, equal-instant ID tie-break, decimal residuals, canceled-with-fill evidence, and no-fill no-op behavior.

- [ ] **Step 5: Commit the pure projector**

```powershell
git add src/modules/strategy/position-guard-candidate-state.ts tests/position-guard-candidate-state.test.ts
git commit -m "feat: project btc pilot execution state"
```

### Task 3: Add the Pure BTC Policy Router and Phase Gates

**Files:**
- Create: `src/modules/strategy/position-guard-policy-router.ts`
- Modify: `src/modules/strategy/index.ts`
- Test: `tests/position-guard-policy-router.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `routePositionGuardPolicy(input): Readonly<PositionGuardPolicyRouteResult>`.
- Consumes: baseline `PositionGuardEngineDecision`, candidate state, market analysis, policy selection, and persisted pilot phase.

- [ ] **Step 1: Write the full phase matrix as failing tests**

```ts
test("ETH is baseline for every pilot phase", () => {
  for (const phase of ["PENDING_FLAT", "ACTIVE", "PAUSED_FAULT", "DRAINING"] as const) {
    const result = routePositionGuardPolicy(routeInput({ market: "KRW-ETH", phase, baselineAction: "ADD" }));
    assert.equal(result.effectiveDecision.action, "ADD");
    assert.equal(result.reasonCode, "ETH_BASELINE");
  }
});

test("pending-flat and draining suppress new BTC risk without changing risk reduction", () => {
  assert.equal(routePositionGuardPolicy(routeInput({ phase: "PENDING_FLAT", baselineAction: "ENTER" })).effectiveDecision.action, "HOLD");
  assert.equal(routePositionGuardPolicy(routeInput({ phase: "DRAINING", baselineAction: "ADD" })).effectiveDecision.action, "HOLD");
  assert.equal(routePositionGuardPolicy(routeInput({ phase: "DRAINING", baselineAction: "EXIT" })).effectiveDecision.action, "EXIT");
});

test("active candidate preserves baseline sizing byte-for-byte when it allows entry", () => {
  const result = routePositionGuardPolicy(routeInput({ phase: "ACTIVE", baselineAction: "ENTER" }));
  assert.equal(result.effectiveDecision.targetNotionalKrw, result.baselineDecision.targetNotionalKrw);
  assert.equal(result.effectiveDecision.targetQuantityFraction, result.baselineDecision.targetQuantityFraction);
});
```

- [ ] **Step 2: Run the suite and verify the router is missing**

Run: `npm.cmd run test`

Expected: FAIL because the router and stable route reason codes do not exist.

- [ ] **Step 3: Implement the route result contract and gates**

```ts
export interface PositionGuardPolicyRouteResult {
  baselineDecision: Readonly<PositionGuardEngineDecision>;
  effectiveDecision: Readonly<PositionGuardEngineDecision>;
  selection: "BASELINE" | "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  pilotPhase: PositionGuardPilotPhase;
  candidateEvaluation: Readonly<PositionGuardCandidateEvaluation> | null;
  reasonCode: PositionGuardPolicyRouteReason;
  stateVersion: number | null;
}
```

`PAUSED_FAULT` must return a blocked route result that cannot be converted into an order input. `ACTIVE` must call only `evaluatePositionGuardCandidate({ policyId: "COMBINED_CONSERVATIVE", ... })`.

- [ ] **Step 4: Verify policy, parity, and sizing tests**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS without importing app, DB, exchange, execution, reconciliation, Telegram, or performance code into the pure router.

- [ ] **Step 5: Commit the pure router**

```powershell
git add src/modules/strategy/position-guard-policy-router.ts src/modules/strategy/index.ts tests/position-guard-policy-router.test.ts tests/run-all.ts
git commit -m "feat: route btc pilot decisions"
```

### Task 4: Add Migration 0017 and Separate Persistence Contracts

**Files:**
- Create: `migrations/0017_add_btc_candidate_live_pilot.sql`
- Create: `src/modules/db/pilot-interfaces.ts`
- Create: `src/modules/db/repositories/sqlite-transaction.ts`
- Create: `src/modules/db/repositories/sqlite-candidate-pilot-repository.ts`
- Create: `src/modules/db/repositories/sqlite-account-execution-lease-store.ts`
- Create: `src/modules/db/repositories/in-memory-candidate-pilot-repository.ts`
- Create: `src/modules/db/repositories/in-memory-account-execution-lease-store.ts`
- Modify: `src/modules/db/repositories/contracts.ts`
- Modify: `src/modules/db/repositories/sqlite-repositories.ts`
- Modify: `src/modules/db/index.ts`
- Test: `tests/candidate-pilot-repository-contract.test.ts`
- Test: `tests/account-execution-lease-contract.test.ts`
- Test: `tests/db-candidate-pilot-persistence.test.ts`
- Modify: `tests/db-sqlite-wiring.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `CandidatePilotRepository` and `AccountExecutionLeaseStore`, both exposed separately from `ExecutionRepository` in `SqlitePersistenceBundle`.
- Consumes: Task 1 pilot types and Task 2 state/evidence types.

- [ ] **Step 1: Write failing common repository contract tests**

```ts
export async function verifyCandidatePilotRepositoryContract(create: RepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await repository.createDeploymentWithInitialState(initialDeploymentInput());
  const first = await repository.advanceStateWithEvidence(advanceInput(deployment, "e1", 0));
  const duplicate = await repository.advanceStateWithEvidence(advanceInput(deployment, "e1", 0));
  assert.equal(first.state.stateVersion, 1);
  assert.equal(duplicate.state.stateVersion, 1);
  await assert.rejects(() => repository.advanceStateWithEvidence(conflictingDuplicateInput(deployment, "e1")));
}
```

Add two-connection lease tests proving only one owner can acquire an account lease and that an expired lease cannot be taken while an active or `RECONCILIATION_REQUIRED` order exists.

- [ ] **Step 2: Run tests and verify migration/repositories are absent**

Run: `npm.cmd run test`

Expected: FAIL on migration and repository imports.

- [ ] **Step 3: Implement the migration and atomic repositories**

Create these tables with explicit checks, FKs, and indexes:

- `strategy_pilot_deployments`
- `strategy_candidate_states`
- `strategy_candidate_execution_evidence`
- `strategy_pilot_audit_events`
- `account_execution_leases`
- `order_submission_recovery_observations`

Evidence, audit, and recovery-observation rows are append-only via `BEFORE UPDATE` and `BEFORE DELETE` abort triggers. Evidence replay uses `(deployment_id, executed_at_epoch_ns, id)`. Recovery observations use `(order_id, observed_at_epoch_ms, id)` and distinguish `FOUND`, `NOT_FOUND`, and `TRANSIENT_FAILURE`. `advanceStateWithEvidence()` runs evidence insert, state-version compare-and-swap, and audit insert inside `BEGIN IMMEDIATE`; exact material-hash duplicates are idempotent, conflicting duplicates throw.

The migration must also add `AUTOMATIC_PAUSE` to execution-state transition constraints and the new pilot notification/risk codes by rebuilding constrained tables without losing existing rows.

- [ ] **Step 4: Verify migration upgrade and integrity**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS for fresh DB, migration from the pre-0017 schema, `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, rollback injection, mixed-timezone replay, stale-owner lease renewal/release, and in-memory/SQLite contract parity.

- [ ] **Step 5: Commit persistence**

```powershell
git add migrations/0017_add_btc_candidate_live_pilot.sql src/modules/db src/domain/pilot-types.ts tests/candidate-pilot-repository-contract.test.ts tests/account-execution-lease-contract.test.ts tests/db-candidate-pilot-persistence.test.ts tests/db-sqlite-wiring.test.ts tests/run-all.ts
git commit -m "feat: persist btc pilot state and leases"
```

### Task 5: Add Typed Upbit Failure Classification

**Files:**
- Create: `src/modules/exchange/errors.ts`
- Modify: `src/modules/exchange/upbit/private-client.ts`
- Modify: `src/modules/exchange/index.ts`
- Test: `tests/upbit-private-client.test.ts`

**Interfaces:**
- Produces: `ExchangeOrderSubmissionError` with `kind: "DEFINITIVE_REJECTION" | "UNCERTAIN"`, HTTP status, exchange error code, and response-received evidence.
- Consumes: existing Upbit error payload and authenticated request implementation.

- [ ] **Step 1: Add failing transport/error-classification tests**

```ts
test("create-order 400 is a definitive rejection but timeout and 5xx are uncertain", async () => {
  await assert.rejects(() => definitiveClient.createOrder(request), (error: unknown) =>
    error instanceof ExchangeOrderSubmissionError && error.kind === "DEFINITIVE_REJECTION");
  await assert.rejects(() => timeoutClient.createOrder(request), (error: unknown) =>
    error instanceof ExchangeOrderSubmissionError && error.kind === "UNCERTAIN");
  await assert.rejects(() => serverErrorClient.createOrder(request), (error: unknown) =>
    error instanceof ExchangeOrderSubmissionError && error.kind === "UNCERTAIN");
});
```

Cover disconnect, malformed success response, duplicate identifier, authenticated order lookup not-found, and non-order private endpoint behavior.

- [ ] **Step 2: Run tests and capture the current generic-error failure**

Run: `npm.cmd run test`

Expected: FAIL because private-client currently throws an untyped generic error.

- [ ] **Step 3: Implement endpoint-aware error classification**

Only an exchange response that definitively rejects creation is `DEFINITIVE_REJECTION`. Timeout, disconnect, 5xx, malformed success response, or any failure after request dispatch is `UNCERTAIN`. Preserve sanitized Upbit error name/code without logging credentials, JWTs, or raw secrets.

- [ ] **Step 4: Verify private client regression coverage**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with existing balance, chance, test, cancel, and lookup behavior unchanged.

- [ ] **Step 5: Commit exchange classification**

```powershell
git add src/modules/exchange/errors.ts src/modules/exchange/upbit/private-client.ts src/modules/exchange/index.ts tests/upbit-private-client.test.ts
git commit -m "fix: classify uncertain upbit submissions"
```

### Task 6: Make Order Lifecycle Writes Atomic and Add Automatic Fault Pause

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/modules/db/interfaces.ts`
- Modify: `src/modules/db/repositories/in-memory-repositories.ts`
- Modify: `src/modules/db/repositories/sqlite-repositories.ts`
- Modify: `src/modules/execution/interfaces.ts`
- Test: `tests/execution-service.test.ts`
- Test: `tests/db-sqlite-wiring.test.ts`

**Interfaces:**
- Produces: atomic `persistOrderIntent()`, `persistExchangeSubmission()`, `persistUncertainSubmission()`, `pauseForFault()`, and explicit `SubmissionOutcome`.
- Consumes: migration 0017 automatic-pause transition and notification/risk values.

- [ ] **Step 1: Write failing atomicity and pause tests**

```ts
test("uncertain submission is persisted with its event and risk record atomically", async () => {
  const result = await serviceWithTimeout().submitOrderFromDecision(validInput());
  assert.equal(result.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(result.order?.status, "RECONCILIATION_REQUIRED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(exchange.createOrderCalls, 1);
});

test("fault pause never overrides an active kill switch and never auto-resumes", async () => {
  await operatorState.activateKillSwitch("operator");
  await operatorState.pauseForFault(faultInput("UNCERTAIN_ORDER"));
  assert.equal((await operatorState.getState()).systemStatus, "KILL_SWITCHED");
});
```

- [ ] **Step 2: Run tests and verify non-atomic methods fail expectations**

Run: `npm.cmd run test`

Expected: FAIL because order/event/fill writes and fault pause are separate operations.

- [ ] **Step 3: Implement atomic repository methods and result types**

```ts
export type SubmissionOutcome =
  | "SUBMITTED"
  | "SIMULATED_FILLED"
  | "REJECTED"
  | "DUPLICATE"
  | "LEASE_BLOCKED"
  | "RECONCILIATION_REQUIRED";
```

`pauseForFault()` writes `execution_state` and its `AUTOMATIC_PAUSE` transition in one transaction. It is idempotent for the same fault, preserves `KILL_SWITCHED`, and has no resume path.

- [ ] **Step 4: Verify SQLite rollback and in-memory parity**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS when failures injected between order/event/fill/risk writes leave no partial lifecycle.

- [ ] **Step 5: Commit lifecycle atomicity**

```powershell
git add src/domain/types.ts src/modules/db/interfaces.ts src/modules/db/repositories/in-memory-repositories.ts src/modules/db/repositories/sqlite-repositories.ts src/modules/execution/interfaces.ts tests/execution-service.test.ts tests/db-sqlite-wiring.test.ts
git commit -m "feat: persist uncertain orders atomically"
```

### Task 7: Acquire the Account Lease and Handle Uncertain Sends in ExecutionService

**Files:**
- Modify: `src/modules/execution/execution-service.ts`
- Modify: `src/app/create-app.ts`
- Create: `tests/execution-send-authority.test.ts`
- Modify: `tests/execution-service.test.ts`
- Modify: `tests/create-app.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `AccountExecutionLeaseStore`, typed exchange errors, atomic lifecycle methods, and `OperatorStateStore.pauseForFault()`.
- Produces: sole-send execution path with lease ownership and explicit uncertain outcome.

- [ ] **Step 1: Add failing lease/send-authority tests**

```ts
test("a lease conflict creates no order row and calls createOrder zero times", async () => {
  const result = await blockedService.submitOrderFromDecision(validInput());
  assert.equal(result.outcome, "LEASE_BLOCKED");
  assert.equal(result.order, null);
  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).length, 0);
});

test("an uncertain send reserves identifier and never retries createOrder", async () => {
  const first = await uncertainService.submitOrderFromDecision(validInput());
  const second = await uncertainService.submitOrderFromDecision(validInput());
  assert.equal(first.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(exchange.createOrderCalls, 1);
});
```

The static authority test must scan production TypeScript and assert that only `src/modules/execution/execution-service.ts` contains a `.createOrder(` call.

- [ ] **Step 2: Run tests and verify lease/uncertain behavior is absent**

Run: `npm.cmd run test`

Expected: FAIL because `ExecutionService` does not acquire the DB lease and currently converts every send exception to `FAILED`.

- [ ] **Step 3: Refactor the send path around the persisted `SUBMITTING` boundary**

Order of operations: duplicate check, execution/risk/chance/test checks, account lease acquisition, atomic local intent/event persistence, transition to `SUBMITTING`, one `createOrder()` call, then atomic exchange result persistence. Definitive rejection becomes `REJECTED`. An uncertain error becomes `RECONCILIATION_REQUIRED`, retains the identifier, pauses execution, and does not release the lease; after lease expiry, the unresolved active/uncertain order still prevents acquisition. If exchange response persistence fails, the pre-send `SUBMITTING` row and lease remain as recovery evidence, automatic pause is attempted, and a fatal safety error is propagated so the run cannot continue or retry.

- [ ] **Step 4: Verify all execution modes and authority**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS for DRY_RUN, LIVE definitive rejection, LIVE uncertainty, lease contention, duplicate idempotency, and the sole-send static boundary.

- [ ] **Step 5: Commit the hardened send path**

```powershell
git add src/modules/execution/execution-service.ts src/app/create-app.ts tests/execution-send-authority.test.ts tests/execution-service.test.ts tests/create-app.test.ts tests/run-all.ts
git commit -m "feat: serialize account order submission"
```

### Task 8: Build Terminal Candidate Evidence and Bounded Identifier Recovery

**Files:**
- Create: `src/modules/execution/candidate-evidence-service.ts`
- Modify: `src/modules/reconciliation/reconciliation-service.ts`
- Modify: `src/app/create-app.ts`
- Test: `tests/candidate-evidence-service.test.ts`
- Modify: `tests/reconciliation-service.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `CandidateExecutionEvidenceService.processTerminalOrder(orderId)` and bounded recovery state.
- Consumes: orders, decisions, fills, candidate deployment/state repository, UUID/identifier exchange lookup, and fault pause.

- [ ] **Step 1: Write failing evidence and recovery tests**

```ts
test("partial fills aggregate once per terminal order and canceled-with-fill advances once", async () => {
  await service.processTerminalOrder("order-1");
  await service.processTerminalOrder("order-1");
  const evidence = await pilotRepository.listEvidenceAfter(deploymentId, null);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.executedQuantity, "0.25");
  assert.equal((await pilotRepository.getState(deploymentId))?.stateVersion, 1);
});

test("first not-found observation remains uncertain and never causes a duplicate send", async () => {
  const summary = await reconciliation.recoverOrderByIdentifier(uncertainOrder());
  assert.equal(summary.outcome, "STILL_UNCERTAIN");
  assert.equal((await repositories.findOrderByReference("primary", "identifier"))?.status, "RECONCILIATION_REQUIRED");
});
```

- [ ] **Step 2: Run tests and verify services are missing**

Run: `npm.cmd run test`

Expected: FAIL because terminal evidence aggregation and bounded absence tracking do not exist.

- [ ] **Step 3: Implement idempotent evidence and bounded recovery**

Only terminal `FILLED` or `CANCELED` strategy orders with non-zero fills produce evidence. Fee amount must be confirmed for every fill; missing fee blocks advancement. No-fill terminal orders produce no evidence. Identifier recovery records observation count and elapsed time; transient errors do not count as absence, and no code calls `createOrder()` during recovery. Successful recovery never resumes execution automatically.

- [ ] **Step 4: Verify full recovery/evidence lifecycle**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS for UUID found, identifier found, canceled-with-fill, no-fill cancel, missing fee, conflicting duplicate, bounded absence, transient lookup, and restart idempotency.

- [ ] **Step 5: Commit evidence and recovery**

```powershell
git add src/modules/execution/candidate-evidence-service.ts src/modules/reconciliation/reconciliation-service.ts src/app/create-app.ts tests/candidate-evidence-service.test.ts tests/reconciliation-service.test.ts tests/run-all.ts
git commit -m "feat: recover and project btc pilot fills"
```

### Task 9: Add Pilot Recovery, Flat Activation, and Common Runner Routing

**Files:**
- Create: `src/app/position-guard-pilot-recovery.ts`
- Modify: `src/modules/strategy/position-guard-runner.ts`
- Modify: `src/app/scheduler-preflight.ts`
- Modify: `src/app/strategy-run-controller.ts`
- Modify: `src/app/create-app.ts`
- Modify: `tests/position-guard-runner.test.ts`
- Modify: `tests/scheduler-preflight.test.ts`
- Modify: `tests/strategy-run-controller.test.ts`
- Modify: `tests/strategy-scheduler.test.ts`

**Interfaces:**
- Produces: `PositionGuardPilotRecovery.verifyAndPrepareBtcRun()` and a runner audit payload containing baseline, candidate, effective decision, policy identity, phase, reason, and state version.
- Consumes: policy router, exchange-backed snapshots already persisted by preflight refresh, reconciliation classification, active/uncertain orders, and candidate evidence/state repositories.

- [ ] **Step 1: Write failing recovery and shared-route tests**

```ts
test("pending-flat activates only from fresh exchange-backed flat evidence", async () => {
  const result = await recovery.verifyAndPrepareBtcRun(flatInput({ quantity: "0.0000000000005", activeOrders: [] }));
  assert.equal(result.phase, "ACTIVE");
});

test("manual and scheduled BTC runs persist the same policy audit contract", async () => {
  const manual = await manualController.run("primary", "BTC");
  const scheduled = await scheduler.runMarketNow("KRW-BTC");
  assert.equal(readAudit(manual).policyVersion, "PCS-2026-001.DEPLOYMENT_READINESS_V1");
  assert.equal(readAudit(scheduled).policyVersion, "PCS-2026-001.DEPLOYMENT_READINESS_V1");
});
```

- [ ] **Step 2: Run tests and verify no runtime bridge exists**

Run: `npm.cmd run test`

Expected: FAIL because the runner always sends the baseline decision.

- [ ] **Step 3: Implement one reviewed runtime bridge**

Before a candidate-capable BTC run, both the manual controller and scheduler invoke the same account-refresh function, persist exchange-backed snapshots, and complete reconciliation before recovery checks. The runner then computes the unchanged baseline decision, obtains verified pilot state, calls the pure router once, persists the complete decision audit, and converts only the effective decision to an execution input. ETH bypasses candidate state and remains baseline. Replay mismatch, stale snapshot, blocking reconciliation, active/uncertain order, or identity mismatch atomically sets `PAUSED_FAULT`, pauses global execution, and returns no execution input.

- [ ] **Step 4: Verify manual/scheduler parity and one-order-per-batch**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with existing scheduler batch deferral behavior unchanged and uncertainty preventing the second market from submitting.

- [ ] **Step 5: Commit the runtime bridge**

```powershell
git add src/app/position-guard-pilot-recovery.ts src/modules/strategy/position-guard-runner.ts src/app/scheduler-preflight.ts src/app/strategy-run-controller.ts src/app/create-app.ts tests/position-guard-runner.test.ts tests/scheduler-preflight.test.ts tests/strategy-run-controller.test.ts tests/strategy-scheduler.test.ts
git commit -m "feat: connect verified btc pilot routing"
```

### Task 10: Implement Rollback Phases and Automatic Fault Notifications

**Files:**
- Modify: `src/app/position-guard-pilot-recovery.ts`
- Modify: `src/modules/db/pilot-interfaces.ts`
- Modify: candidate pilot repository implementations
- Modify: `src/domain/types.ts`
- Modify: `src/modules/telegram/reporter.ts`
- Test: `tests/position-guard-pilot-recovery.test.ts`
- Test: `tests/telegram-delivery.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: audited `PENDING_FLAT -> ACTIVE`, `ACTIVE -> DRAINING`, `DRAINING -> DISABLED`, and `* -> PAUSED_FAULT` transitions plus operator notifications.
- Consumes: exchange-backed flat evidence and global fault-pause contracts.

- [ ] **Step 1: Add failing transition and notification tests**

```ts
test("mid-episode rollback enters draining and flat rollback returns baseline", async () => {
  const draining = await recovery.requestRollback(nonFlatState());
  assert.equal(draining.phase, "DRAINING");
  const disabled = await recovery.completeRollback(flatState());
  assert.equal(disabled.phase, "DISABLED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("recovery success never resumes an automatic fault pause", async () => {
  await recovery.verifyAndPrepareBtcRun(repairedInput());
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});
```

- [ ] **Step 2: Run tests and confirm transition APIs are missing**

Run: `npm.cmd run test`

Expected: FAIL on rollback/fault transition methods and notification types.

- [ ] **Step 3: Implement explicit transition rules**

No Telegram command activates or changes the pilot. Local configuration can request rollback, but the repository enforces legal phase transitions and writes an append-only audit event. Every activation, fault, uncertain send, rollback start, and rollback completion creates an operator notification without delivering it synchronously inside the state transaction.

- [ ] **Step 4: Verify illegal transitions and no-auto-resume**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with illegal mid-episode baseline switching rejected.

- [ ] **Step 5: Commit transition governance**

```powershell
git add src/app/position-guard-pilot-recovery.ts src/modules/db/pilot-interfaces.ts src/modules/db/repositories src/domain/types.ts src/modules/telegram/reporter.ts tests/position-guard-pilot-recovery.test.ts tests/telegram-delivery.test.ts tests/run-all.ts
git commit -m "feat: govern btc pilot transitions"
```

### Task 11: Add Strict Read-Only Pilot Readiness

**Files:**
- Create: `src/inspection/position-guard-pilot-readiness.ts`
- Create: `tests/position-guard-pilot-readiness.test.ts`
- Modify: `package.json`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `inspectPositionGuardPilotReadiness(options)` and `inspect:btc-pilot:readiness` CLI with stable text/JSON output.
- Consumes: an existing SQLite path, explicit pilot configuration, local authority record, and persisted state/evidence only.

- [ ] **Step 1: Write failing read-only boundary tests**

```ts
test("pilot readiness leaves database bytes, mtime, wal, and shm unchanged", async () => {
  const before = await captureSqliteFiles(databasePath);
  const result = inspectPositionGuardPilotReadiness({ databasePath, format: "JSON", env: baselineEnv });
  const after = await captureSqliteFiles(databasePath);
  assert.deepEqual(after, before);
  assert.equal(result.nonMutationBoundary.readOnly, true);
});
```

Also statically reject imports of `createApp`, writable SQLite bootstrap, exchange adapters, Telegram polling/delivery, sync controllers, scheduler, and execution service.

- [ ] **Step 2: Run tests and verify the inspection module is absent**

Run: `npm.cmd run test`

Expected: FAIL on missing inspection exports and script.

- [ ] **Step 3: Implement a direct read-only SQLite adapter**

Use `new DatabaseSync(databasePath, { readOnly: true })` directly. Do not call `openSqliteDatabase()`. Validate table presence, exact identity, phase, replay equality, active/uncertain orders, latest persisted snapshots, reconciliation classification, lease state, and authority record. JSON includes DB path, filters, state/evidence provenance, check names, and next actions without secrets.

- [ ] **Step 4: Verify no-mutation and stable output**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS for missing DB, pre-0017 DB, baseline DB, pending-flat, active, fault, stale lease, replay mismatch, and byte/mtime/WAL/SHM invariance.

- [ ] **Step 5: Commit read-only readiness**

```powershell
git add src/inspection/position-guard-pilot-readiness.ts tests/position-guard-pilot-readiness.test.ts package.json tests/run-all.ts
git commit -m "feat: inspect btc pilot readiness safely"
```

### Task 12: Expose Korean-First Operator Visibility Without Activation Controls

**Files:**
- Modify: `src/modules/telegram/commands.ts`
- Modify: `src/modules/telegram/presentation/status.ts`
- Modify: `src/modules/telegram/presentation/readiness.ts`
- Modify: `src/modules/telegram/presentation/run.ts`
- Modify: `src/modules/telegram/presentation/preview.ts`
- Modify: `tests/telegram-commands.test.ts`
- Modify: `tests/telegram-presentation.test.ts`
- Modify: `tests/telegram-operator-contracts.test.ts`

**Interfaces:**
- Produces: read-only pilot details in `/status`, `/readiness`, `/run` result, and `/preview`; no new mutation command.
- Consumes: runtime pilot status DTO and latest persisted decision audit.

- [ ] **Step 1: Add failing Korean presentation and command-boundary tests**

```ts
test("status shows btc pilot and eth baseline without exposing confirmation", () => {
  const message = formatStatusSummary(statusWithActivePilot(), { locale: "ko-KR" });
  assert.match(message, /BTC 후보 파일럿: 활성/);
  assert.match(message, /ETH 정책: 기존 기준 전략/);
  assert.doesNotMatch(message, /I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT/);
});

test("Telegram exposes no pilot activation or phase mutation command", () => {
  assert.equal(SUPPORTED_COMMANDS.includes("/pilot" as never), false);
});
```

- [ ] **Step 2: Run tests and verify pilot status is not displayed**

Run: `npm.cmd run test`

Expected: FAIL on missing status/readiness fields.

- [ ] **Step 3: Implement concise and detail views**

Summary views show pilot ID, phase, policy version, state version, last evidence, flat/replay/lease/reconciliation checks, latest BTC candidate outcome, and explicit ETH baseline status. Detail views retain technical IDs and raw stable reason codes. Never render secrets or operator confirmation values.

- [ ] **Step 4: Verify Korean/English presentation and operator boundaries**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with manual cash/position input and pilot activation still absent.

- [ ] **Step 5: Commit operator visibility**

```powershell
git add src/modules/telegram/commands.ts src/modules/telegram/presentation tests/telegram-commands.test.ts tests/telegram-presentation.test.ts tests/telegram-operator-contracts.test.ts
git commit -m "feat: report btc pilot state to operator"
```

### Task 13: Update Dependency Boundaries and Run Fake-Exchange Lifecycle Tests

**Files:**
- Modify: `tests/position-guard-candidate-dependency-boundary.test.ts`
- Create: `tests/position-guard-pilot-lifecycle.test.ts`
- Modify: `tests/create-app.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: one documented runtime bridge from the runner to the pure router and end-to-end fake-exchange lifecycle coverage.
- Consumes: all previous tasks.

- [ ] **Step 1: Write failing static and fake lifecycle tests**

The lifecycle test must execute only in-memory/fake adapters and cover: pending-flat suppression, exchange-backed flat activation, order chance, order test, one send, partial fills, terminal cancel-with-fill, evidence/state advancement, process reconstruction, replay equality, and no automatic resume after an uncertainty fault.

```ts
test("only the reviewed runner bridge reaches candidate runtime modules", async () => {
  const edges = await discoverCandidateRuntimeEdges();
  assert.deepEqual(edges, [
    "src/modules/strategy/position-guard-runner.ts -> src/modules/strategy/position-guard-policy-router.ts",
  ]);
});
```

- [ ] **Step 2: Run tests and capture existing dependency-guard failure**

Run: `npm.cmd run test`

Expected: FAIL because the old guard blocks every runtime candidate edge.

- [ ] **Step 3: Narrow the dependency exception**

Allow only the exact runner-to-router edge. Continue to block direct candidate imports from app wiring, DB, exchange, execution, reconciliation, Telegram, smoke, research, and performance modules. Continue to forbid candidate modules from reading `process.env`, filesystem, network, clock, or DB.

- [ ] **Step 4: Run the complete fake lifecycle and static boundary suite**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with zero real API calls and zero operational DB access.

- [ ] **Step 5: Commit integration boundaries**

```powershell
git add tests/position-guard-candidate-dependency-boundary.test.ts tests/position-guard-pilot-lifecycle.test.ts tests/create-app.test.ts tests/run-all.ts
git commit -m "test: verify btc pilot lifecycle boundaries"
```

### Task 14: Update Safety Documentation and Safe Examples

**Files:**
- Modify: `README.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `RISK_POLICY.md`
- Modify: `ORDER_LIFECYCLE.md`
- Create: `scripts/inspect-btc-pilot-readiness.example.ps1`
- Test: `tests/windows-task-scripts.test.ts`

**Interfaces:**
- Documents: default baseline, explicit pilot identity, BTC-only policy, ETH baseline, state/evidence truth, lease, uncertain submission, automatic pause, rollback, read-only readiness, and separate activation approval.

- [ ] **Step 1: Add failing example-script safety assertions**

```ts
test("btc pilot readiness example is read-only and cannot start live runtime", () => {
  const source = readScript("scripts/inspect-btc-pilot-readiness.example.ps1");
  assert.match(source, /inspect:btc-pilot:readiness/);
  assert.doesNotMatch(source, /npm\.cmd run start/);
  assert.doesNotMatch(source, /STRATEGY_SCHEDULER_ENABLED\s*=\s*["']true/);
});
```

- [ ] **Step 2: Run tests and verify the example is absent**

Run: `npm.cmd run test`

Expected: FAIL on missing script.

- [ ] **Step 3: Update authoritative docs and create the inspection example**

The example must default to `BASELINE`, require an explicit database path, never contain secrets, and run only the strict read-only CLI. Documentation must state that code availability is not activation and that pilot activation requires separate local configuration, confirmation, no-order validation, operator review, and a later explicit request.

- [ ] **Step 4: Verify docs and script contracts**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Expected: PASS with checked-in startup examples still default-safe.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md PRODUCT_BOUNDARY.md ARCHITECTURE.md RISK_POLICY.md ORDER_LIFECYCLE.md scripts/inspect-btc-pilot-readiness.example.ps1 tests/windows-task-scripts.test.ts
git commit -m "docs: define btc pilot operations"
```

### Task 15: Independent Review and No-Order Validation Gate

**Files:**
- Modify only files required to fix independently confirmed findings.
- Create: `docs/superpowers/reports/2026-08-21-btc-candidate-live-pilot-validation.md`

**Interfaces:**
- Produces: review findings, verification evidence, and an explicit statement that the pilot remains inactive.
- Consumes: the complete implementation.

- [ ] **Step 1: Run independent contract and safety reviews**

Assign separate reviewers to:

- policy identity, phase routing, sizing preservation, and ETH-baseline behavior;
- SQLite atomicity, state replay, evidence idempotency, lease contention, and read-only inspection;
- uncertain submission, bounded recovery, automatic pause, no-auto-resume, and sole-send authority.

- [ ] **Step 2: Fix validated findings with a red test first**

For every accepted finding, add the smallest reproducing test, run it to FAIL, apply the minimal fix, and rerun it to PASS. Record rejected findings and reasons in the validation report.

- [ ] **Step 3: Run final repository verification**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run test`

Run: `npm.cmd run check`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 4: Run no-order readiness only against a temporary migrated database**

Run: `npm.cmd run inspect:btc-pilot:readiness -- --database-path .\var\btc-pilot-readiness-test.sqlite --format JSON`

Expected: the report proves `readOnly: true`, no mutation, baseline selection unless exact pilot values are supplied, and zero order/API/Telegram/runtime actions. Do not point this command at the operational LIVE database during implementation.

- [ ] **Step 5: Record the activation boundary and commit the validation report**

The report must state:

- implementation is present but candidate selection remains `BASELINE` by default;
- no operational DB, Upbit, Telegram, scheduler, sync, or order path was invoked;
- no checked-in script enables the candidate or starts LIVE scheduling;
- operational readiness against the real DB and any LIVE activation require separate explicit operator approval.

```powershell
git add docs/superpowers/reports/2026-08-21-btc-candidate-live-pilot-validation.md
git commit -m "test: validate btc pilot safety gates"
```

## Parallel Ownership Waves

Implementation should use subagents with disjoint write scopes and main-agent integration between waves:

- Wave A, agent 1: Task 1 files only.
- Wave A, agent 2: Task 2 files only.
- Wave A, agent 3: Task 5 files only.
- Wave B, agent 1: Task 3 files only after Tasks 1-2.
- Wave B, agent 2: Task 4 DB/persistence files only.
- Wave C, agent 1: Tasks 6-7 execution files only after Tasks 4-5.
- Wave C, agent 2: Task 8 evidence/reconciliation files only after Task 4.
- Wave D, agent 1: Task 9 runner/recovery files only after Tasks 3, 7, and 8.
- Wave D, agent 2: Task 11 inspection files only after Task 4.
- Wave E, agent 1: Task 10 transition/notification files only.
- Wave E, agent 2: Task 12 Telegram presentation files only.
- Wave E, agent 3: Task 14 documentation/script files only.
- Main agent: product boundary, schema/interface consistency, merge conflict resolution, live-trading safety review, Task 13 integration boundary, Task 15 final verification, and confirmation that operational state was not touched.

## Activation Exclusion

This implementation plan ends at offline implementation and no-order validation. It intentionally excludes:

- editing any `.local.ps1` secret/startup file;
- setting `POSITION_GUARD_PILOT_ID` on the operational machine;
- setting the pilot confirmation value on the operational machine;
- opening the operational LIVE database during implementation;
- starting or restarting the app;
- `/resume`, `/run`, `/sync`, scheduler ticks, Telegram polling, notification delivery, Upbit reads, order tests, or order sends;
- enabling the LIVE scheduler or candidate policy.

Operational DB readiness, process startup, manual LIVE validation, and scheduler activation are separate approval gates after this plan is implemented and independently reviewed.
