# Combined Conservative Deployment-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an execution-disconnected, versioned pure implementation of the three registered `PCS-2026-001` candidate policies, including deterministic episode state transitions, frozen-evaluator parity tests, and static runtime reachability guards.

**Architecture:** New candidate modules live in `src/modules/strategy` but are not imported by `createApp`, the strategy runner, scheduler, Telegram, execution, exchange, reconciliation, or DB modules. The modules consume only explicit pure inputs, duplicate the registered thresholds under a versioned authority constant, and are compared with the unchanged frozen research evaluator using synthetic pre-window fixtures. No environment selector, repository, migration, or operational adapter is added.

**Tech Stack:** TypeScript 5.8 strict mode, Node.js 22, the repository custom test harness, static import traversal tests.

**Spec:** `docs/superpowers/specs/2026-08-20-combined-conservative-deployment-readiness-design.md`

## Global Constraints

- Do not modify `docs/research/prospective-shadow/PCS-2026-001.registration.json`, `docs/research/prospective-shadow/registry.jsonl`, `.github/workflows/prospective-shadow-registration.yml`, registered thresholds, costs, timing models, scenario set, or observation window.
- Do not inspect or derive fixtures from prospective-window observations, signals, virtual PnL, or outcomes.
- Do not add candidate imports to app, runner, scheduler, Telegram, execution, exchange, reconciliation, DB, smoke, migration, or prospective evaluation modules.
- Do not add an environment variable, runtime selector, strategy-runner branch, Telegram command, repository, migration, operational SQLite access, Upbit call, sync, scheduler tick, or order path.
- Do not start or alter an operational process, LIVE mode, Telegram poller, scheduler, Upbit client, or operational database.
- Keep `APP_EXECUTION_MODE` defaulting to `DRY_RUN`, `ENABLE_LIVE_ORDERS` defaulting to disabled, and the current percentage-based order sizing unchanged.
- Use exact ISO-8601 timestamps with explicit timezone and nanosecond-aware epoch ordering.
- Reject missing realized PnL for risk-reducing fills, non-finite numbers, negative quantities, invalid timestamps, duplicate evidence IDs, and non-canonical evidence ordering.
- Use the frozen quantity tolerance `1e-12`.
- Do not commit or push from worker agents; the controller owns final integration decisions.

---

### Task 1: Candidate Episode State Contract

**Files:**
- Create: `src/modules/strategy/position-guard-candidate-state.ts`
- Create: `tests/position-guard-candidate-state.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `StrategyEntryPath` and `StrategyDecisionAction` from existing domain/strategy types.
- Produces:

```ts
export const POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE = 1e-12;

export interface PositionGuardCandidateState {
  currentEpisodeAddCount: number;
  currentEpisodeRealizedPnlKrw: number;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: number | null;
  lastEntryPath: StrategyEntryPath | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
}

export interface PositionGuardCandidateExecutionEvidence {
  evidenceId: string;
  executedAt: string;
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  entryPath: StrategyEntryPath;
  realizedPnlKrw: number | null;
  remainingQuantity: number;
}

export function createEmptyPositionGuardCandidateState(): Readonly<PositionGuardCandidateState>;
export function validatePositionGuardCandidateState(state: PositionGuardCandidateState): void;
export function parsePositionGuardCandidateTimestamp(value: string, label: string): bigint;
export function advancePositionGuardCandidateState(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): Readonly<PositionGuardCandidateState>;
export function projectPositionGuardCandidateState(input: {
  initialState: PositionGuardCandidateState;
  evidence: readonly PositionGuardCandidateExecutionEvidence[];
}): Readonly<PositionGuardCandidateState>;
```

- [ ] **Step 1: Write failing state validation and transition tests**

Add tests that prove:

```ts
const entered = advancePositionGuardCandidateState(emptyState(), {
  evidenceId: "fill-001",
  executedAt: "2026-08-20T00:00:00.000000001Z",
  action: "ENTER",
  entryPath: "PULLBACK",
  realizedPnlKrw: null,
  remainingQuantity: 0.001,
});
assert.equal(entered.lastEntryPath, "PULLBACK");

const reduced = advancePositionGuardCandidateState(entered, {
  evidenceId: "fill-002",
  executedAt: "2026-08-20T01:00:00+00:00",
  action: "REDUCE",
  entryPath: "PULLBACK",
  realizedPnlKrw: -125.5,
  remainingQuantity: 0.0005,
});
assert.equal(reduced.currentEpisodeRealizedPnlKrw, -125.5);
```

Cover ENTER path capture, ADD count, REDUCE accumulation, full EXIT reset,
residual quantity at `1e-12`, residual above `1e-12`, exact timezone parsing,
mixed timezone epoch ordering, equal timestamp `evidenceId` ordering, duplicate
IDs, missing REDUCE/EXIT realized PnL, invalid action state, non-finite values,
negative remaining quantity, invalid timestamps, out-of-order evidence, and
input/output immutability. Also cover symmetric cursor validation, cursor updates
for every action, and rejection of evidence that overlaps or regresses against
an already-projected initial state.

- [ ] **Step 2: Register the test and verify RED**

Add `await import("./position-guard-candidate-state.test.js");` before
`runRegisteredTests()` in `tests/run-all.ts`.

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript compilation fails because
`position-guard-candidate-state.ts` and its exports do not exist.

- [ ] **Step 3: Implement strict state validation and one-evidence transition**

Implement exact timestamp parsing with the repository-compatible explicit-zone
shape, preserving up to nine fractional digits as epoch nanoseconds. Clone every
input before mutation, round accumulated money only with the same deterministic
money precision used by the backtest, and freeze returned state objects. Both
cursor properties are required. They may both be null only for the pristine
empty state; every carry-in or returned non-empty state must contain the latest
accepted evidence timestamp and ID.

Rules:

```ts
if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
if (evidence.action === "REDUCE" || evidence.action === "EXIT") {
  if (evidence.realizedPnlKrw === null) throw new Error("...");
  next.currentEpisodeRealizedPnlKrw = roundMoney(
    next.currentEpisodeRealizedPnlKrw + evidence.realizedPnlKrw,
  );
}
if (
  evidence.action === "EXIT" &&
  evidence.remainingQuantity <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE
) {
  next.currentEpisodeAddCount = 0;
  next.lastFullExitAt = evidence.executedAt;
  next.lastFullExitRealizedPnlKrw = next.currentEpisodeRealizedPnlKrw;
  next.currentEpisodeRealizedPnlKrw = 0;
}
```

- [ ] **Step 4: Implement canonical projection and verify GREEN**

`projectPositionGuardCandidateState()` must validate that evidence is ordered by
epoch nanoseconds and then `evidenceId`, reject duplicates or regressions, and
fold through `advancePositionGuardCandidateState()`. Ordering starts from the
initial state's canonical cursor, and one-step advancement enforces the same
strict tuple comparison.

Run:

```powershell
npm.cmd run test
```

Expected: the new state tests and all existing tests pass.

- [ ] **Step 5: Review Task 1 without committing**

Review only the Task 1 diff for strict validation, deterministic ordering,
immutability, and absence of runtime/DB imports. Record tests and findings in the
task report.

---

### Task 2: Registered Candidate Decision Overlay

**Files:**
- Create: `src/modules/strategy/position-guard-candidate-policy.ts`
- Create: `tests/position-guard-candidate-policy.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `PositionGuardEngineDecision`, `PositionGuardStructureAnalysis`, and `PositionGuardCandidateState`.
- Produces:

```ts
export const POSITION_GUARD_CANDIDATE_POLICY_VERSION =
  "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const;

export const POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS = [
  "COMBINED_CONSERVATIVE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;

export type PositionGuardRegisteredCandidatePolicyId =
  typeof POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS[number];

export type PositionGuardCandidateOutcome = "ALLOW" | "SUPPRESS" | "OVERRIDE_EXIT";
export type PositionGuardCandidatePrecedence =
  | "PRESERVE_RISK_REDUCTION"
  | "EARLY_THESIS_FAILURE"
  | "COOLDOWN_CONTROL"
  | "HTF_TREND_GATE"
  | "ADD_LIMITED"
  | "NO_INTERVENTION";

export interface PositionGuardCandidateEvaluation {
  policyId: PositionGuardRegisteredCandidatePolicyId;
  policyVersion: typeof POSITION_GUARD_CANDIDATE_POLICY_VERSION;
  generatedAt: string;
  originalAction: StrategyDecisionAction;
  effectiveAction: StrategyDecisionAction;
  outcome: PositionGuardCandidateOutcome;
  reason: PositionGuardCandidateReason;
  precedence: PositionGuardCandidatePrecedence;
  effectiveDecision: Readonly<PositionGuardEngineDecision>;
}

export function evaluatePositionGuardCandidate(input: {
  policyId: PositionGuardRegisteredCandidatePolicyId;
  generatedAt: string;
  decision: PositionGuardEngineDecision;
  positionQuantity: number;
  averageEntryPrice: number;
  candidateState: PositionGuardCandidateState;
  analysis: PositionGuardStructureAnalysis;
}): Readonly<PositionGuardCandidateEvaluation>;
```

- [ ] **Step 1: Write failing policy tests**

Use synthetic structure analyses and baseline decisions to assert all exact
frozen cases: preserve `EXIT`/`REDUCE`, failed-reclaim exit, bearish-loss exit,
12-hour non-positive-exit cooldown, 24-hour same-path cooldown, HTF breakdown,
trend score below 3, weakening, disallowed entry regime, position-at-loss ADD,
episode ADD count, ATR shock, ADD trend score below 4, recovery score below 3,
disallowed ADD regime, all-conditions-allowed, and policy component omission.

Add precedence collision cases proving early failure beats cooldown/HTF/ADD,
cooldown beats HTF, HTF beats ADD, and preserved risk reduction beats all
overrides. Assert SUPPRESS produces `HOLD`, zero notional, null quantity fraction,
and `SKIPPED`; OVERRIDE_EXIT produces `EXIT`, zero notional, quantity fraction 1,
and `IMMEDIATE`.

- [ ] **Step 2: Register the test and verify RED**

Add `await import("./position-guard-candidate-policy.test.js");` before the
harness runs. Run `npm.cmd run build` and confirm failure is caused only by the
missing candidate policy module.

- [ ] **Step 3: Implement the frozen authority constant and validator**

Define and deeply freeze these exact values inside the candidate module:

```ts
{
  quantityTolerance: 1e-12,
  htf: { minimumTrendAlignmentScore: 3,
    allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND", "EARLY_RECOVERY"] },
  earlyFailure: { maximumFailedReclaimRecoveryQualityScore: 1,
    minimumBearishBreakdownPressureScore: 2 },
  add: { maxAddsPerEpisode: 1, minimumTrendAlignmentScore: 4,
    minimumRecoveryQualityScore: 3,
    allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND"] },
  cooldown: { nonPositiveExitHours: 12, sameEntryPathHours: 24 },
}
```

Reject unsupported policy IDs, invalid timestamps, invalid/non-finite quantity
or average price, and invalid candidate state before evaluating components.

- [ ] **Step 4: Implement precedence and immutable effective decisions**

Implement the selected policy component map exactly:

```ts
COMBINED_CONSERVATIVE: [
  "HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "ADD_LIMITED", "COOLDOWN_CONTROL",
],
COMBINED_MINUS_EARLY_THESIS_FAILURE: [
  "HTF_TREND_GATE", "ADD_LIMITED", "COOLDOWN_CONTROL",
],
COMBINED_MINUS_COOLDOWN_CONTROL: [
  "HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "ADD_LIMITED",
],
```

Evaluate in the frozen precedence order and return explicit `ALLOW` with
`NO_INTERVENTION` when no component intervenes. Deeply clone and freeze the
effective decision and nested arrays/objects without mutating the baseline
decision or analysis.

- [ ] **Step 5: Verify GREEN and review Task 2**

Run `npm.cmd run test`. Expected: all policy and existing tests pass. Review the
Task 2 diff for exact thresholds, policy component sets, precedence, immutable
output, and no operational dependency.

---

### Task 3: Golden Research Parity and Runtime Isolation

**Files:**
- Create: `tests/position-guard-candidate-parity.test.ts`
- Create: `tests/position-guard-candidate-dependency-boundary.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `evaluatePositionGuardResearchIntervention()` as unchanged frozen authority and `evaluatePositionGuardCandidate()` from Task 2.
- Produces: regression evidence that all registered candidate decisions match and that candidate modules remain unreachable from runtime.

- [ ] **Step 1: Write golden parity fixtures and verify RED**

Create synthetic fixtures whose timestamps are all before
`2026-08-23T08:00:00.000Z`. For every registered policy ID compare:

```ts
const research = evaluatePositionGuardResearchIntervention(researchInput);
const candidate = evaluatePositionGuardCandidate(candidateInput);
assert.equal(candidate.effectiveAction, research?.effectiveAction ?? baseline.action);
assert.equal(candidate.outcome, research?.outcome ?? "ALLOW");
assert.equal(candidate.reason, research?.reason ?? "NO_INTERVENTION");
```

Cover risk preservation, early failed reclaim, bearish loss, both cooldowns,
HTF suppression, ADD suppression, allowed ENTER/ADD, precedence collisions,
carry-in state, and exact cooldown boundaries. Add a fixture provenance assertion
that rejects any fixture timestamp at or after the observation-window start.
Add a synthetic continuous frozen-backtest state-parity fixture for ENTER, ADD,
REDUCE, non-closing partial EXIT, full EXIT, six-decimal PnL rounding, quantity
tolerance closure, and cooldown carry state. Compare all shared research-state
fields after every transition and report the candidate cursor separately as
adapter-only provenance.

Run `npm.cmd run build`. Expected: fail until the new test is registered and its
candidate-to-research normalization is complete.

- [ ] **Step 2: Make parity complete and verify GREEN**

Do not alter the frozen research evaluator to satisfy parity. Correct only the
candidate modules or synthetic fixtures. Run `npm.cmd run test` and require all
candidate parity cases to pass.

- [ ] **Step 3: Write bidirectional dependency boundary tests**

Discover candidate files by the filename prefix
`position-guard-candidate-`. Parse TypeScript syntax recursively with the
compiler AST and assert:

```ts
const forbiddenCandidateDependencies = [
  "/app/", "/db/", "/exchange/", "/execution/", "/reconciliation/",
  "/telegram/", "/smoke/", "/migrations/", "performance-prospective-",
];
```

Also scan every TypeScript file under `src/app`, `src/modules/db`,
`src/modules/exchange`, `src/modules/execution`, `src/modules/reconciliation`,
`src/modules/telegram`, and `src/smoke`, plus
`src/modules/strategy/position-guard-runner.ts`, and reject imports resolving to
candidate files. Assert no candidate module references `process.env`,
`node:fs`, `node:child_process`, SQLite, HTTP/fetch, Upbit, Telegram, scheduler,
repository, or order-submission symbols.

The extractor must preserve type-only versus runtime semantics for import,
export, import-equals, and import-type syntax; decode escaped string and
no-substitution template literals; accept literal `import(specifier, options)`;
and reject every non-literal dynamic import or unshadowed bare require in either
guarded closure. It must ignore comments and ordinary strings. It may ignore a
bare require call only when TypeScript symbol resolution identifies the nearest
binding as an in-source function declaration named `require`; nearer parameters,
variables, imports, catch bindings, and loop bindings must keep conservative
runtime-edge treatment. Property calls are outside the CommonJS bare-require
boundary.

- [ ] **Step 4: Register boundary tests and run focused prospective protection**

Add both test imports before `runRegisteredTests()`. Run:

```powershell
npm.cmd run test
node --test dist/tests/prospective-shadow-dependency-boundary.test.js
npm.cmd run check:prospective-commitment-bundle
```

Expected: all candidate tests pass, the existing prospective dependency test
passes, and the commitment bundle remains byte-for-byte current.

- [ ] **Step 5: Review Task 3 without committing**

Review fixture dates, research/candidate normalization, recursive import
coverage, false-negative risks, and confirmation that frozen research and
registration files have no diff.

---

### Task 4: Product Documentation and Final Verification

**Files:**
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `RISK_POLICY.md`
- Modify: `README.md`
- Existing: `docs/superpowers/specs/2026-08-20-combined-conservative-deployment-readiness-design.md`
- Existing: `docs/superpowers/plans/2026-08-20-combined-conservative-deployment-readiness.md`

**Interfaces:**
- Consumes: the implemented pure modules and dependency guarantees from Tasks 1-3.
- Produces: accurate public registration status and explicit deployment-readiness/non-activation documentation.

- [ ] **Step 1: Correct stale registration-status sentences**

Update only the stale statements claiming no registration exists. State that
`PCS-2026-001` is publicly registered with the immutable window
`[2026-08-23T08:00:00.000Z,2026-12-21T08:00:00.000Z)` and that registration does
not grant deployment or LIVE authority. Do not change authority values or
procedure semantics.

- [ ] **Step 2: Document the preparation boundary**

Document that candidate policy/state modules are pure, have no runtime
reachability, do not expose configuration, and exist only for post-closure
deployment readiness. Record that current percentage-based order sizing and all
execution guards are unchanged.

- [ ] **Step 3: Run final static and full verification**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run check:prospective-commitment-bundle
npm.cmd run test
git diff --check
git status --short
```

Expected: every command exits 0; only planned source, test, and documentation
files are changed; registration, registry, workflow, runtime wiring, env config,
runner, execution, DB, Telegram, and migration files have no diff.

- [ ] **Step 4: Run an independent whole-change review**

Review the complete branch diff against the spec. Findings must prioritize:
policy divergence, observation-window leakage, incomplete state validation,
runtime reachability, silent unknown-PnL handling, timestamp ordering, mutation,
and missing tests. Fix every Critical or Important issue through a test-first
change and re-run the covering tests.

- [ ] **Step 5: Produce the handoff without LIVE execution**

Report implemented contracts, exact parity scope, changed files, test commands,
review findings, subagents and ownership, and confirmation that no operational
process or LIVE test ran. Leave commit, merge, push, runtime wiring, DRY_RUN,
no-order shadow, and LIVE canary as separate future decisions.
