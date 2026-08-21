# Combined Conservative Deployment-Readiness Design

## Purpose

Prepare the exact registered `PCS-2026-001` candidate policies for a later,
separately approved deployment decision without activating them, observing their
prospective outcomes early, or changing the current trading runtime.

This work is preparation only. It does not authorize DRY_RUN, LIVE, scheduler,
Telegram, order, reconciliation, or operational database integration.

## Frozen Authority

The public experiment authority remains unchanged:

- experiment: `PCS-2026-001`
- observation window: `[2026-08-23T08:00:00.000Z,2026-12-21T08:00:00.000Z)`
- Publication A: `ed4de872d07f416c77d5f05b9dc657eae676155e`
- Publication B: `358113dba5cd0425161a4aed0827f496d268d1f5`
- registered payload SHA-256:
  `978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40`

The registration, registry, workflow, thresholds, precedence, costs, timing
models, scenario set, and observation window are immutable inputs. This work
must not rewrite or regenerate them.

## Considered Approaches

### 1. Pure preparation with no runtime reachability

Create a versioned, deterministic candidate evaluator and state-transition
contract outside the prospective subsystem. Compare it against the frozen
research evaluator using pre-registration synthetic fixtures. Prevent runtime
modules from importing it.

This is the selected approach. It provides useful implementation progress while
keeping activation structurally impossible.

### 2. Default-off runtime selector

Add a configuration value that selects the baseline or a candidate policy, but
default it to the baseline.

This was rejected for the active observation period. Even a default-off selector
makes the candidate reachable from the execution graph and creates accidental
activation, configuration drift, and no-peek risk.

### 3. DRY_RUN or LIVE candidate wiring

Wire the candidate into the existing runner and rely on execution mode and live
order gates for safety.

This was rejected. It would activate candidate decisions before the registered
experiment closes and would mix research evidence with operational behavior.

## Scope

The preparation phase may add only:

1. Explicit candidate policy identity and version types.
2. A pure candidate decision overlay that reproduces the registered policies.
3. A pure candidate state validator and post-fill state transition.
4. A pure state-projection contract over normalized historical execution
   evidence.
5. Golden parity fixtures created without prospective-window observations.
6. Static dependency tests that keep the preparation graph outside runtime.
7. Documentation describing the later activation gates.

The preparation phase must not add:

- an environment variable or configuration selector
- `createApp()` or runner wiring
- scheduler or Telegram commands
- execution-service or exchange-adapter imports
- database repositories or migrations
- operational SQLite reads or writes
- Upbit calls
- prospective-window metrics, signals, or virtual PnL inspection
- any code path that can submit or influence an order

## Candidate Contract

The pure evaluator accepts:

- one of the exact registered candidate policy IDs
- the baseline `PositionGuardEngineDecision`
- the structure analysis already used by the baseline decision
- the current strategy position state
- explicit candidate episode state
- an exact ISO-8601 decision timestamp

It returns detached immutable evidence containing:

- policy ID and policy version
- original action
- effective action
- outcome: `ALLOW`, `SUPPRESS`, or `OVERRIDE_EXIT`
- stable reason code
- the precedence branch that produced the result

The evaluator does not calculate order size, persist a strategy decision, or
submit an order. Existing percentage-based sizing remains the responsibility of
the baseline core and is not changed by this preparation.

## Exact Policy Semantics

The evaluator reproduces the frozen component precedence:

1. Preserve existing risk-reducing `REDUCE` and `EXIT` decisions.
2. Apply `EARLY_THESIS_FAILURE` where active.
3. Apply `COOLDOWN_CONTROL` where active.
4. Apply `HTF_TREND_GATE` where active.
5. Apply `ADD_LIMITED` where active.

The supported policy IDs are exactly the registered set:

- `COMBINED_CONSERVATIVE`
- `COMBINED_MINUS_EARLY_THESIS_FAILURE`
- `COMBINED_MINUS_COOLDOWN_CONTROL`

No new candidate, threshold, component combination, or precedence variation is
introduced.

## Candidate State

The explicit state contains:

- `currentEpisodeAddCount`
- `currentEpisodeRealizedPnlKrw`
- `lastFullExitAt`
- `lastFullExitRealizedPnlKrw`
- `lastEntryPath`
- `lastEvidenceAt`
- `lastEvidenceId`

The exact state interface is:

```ts
export interface PositionGuardCandidateState {
  currentEpisodeAddCount: number;
  currentEpisodeRealizedPnlKrw: number;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: number | null;
  lastEntryPath: StrategyEntryPath | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
}
```

The cursor properties are mandatory. Both may be explicitly null only for the
pristine empty state; every non-empty or previously projected state requires
both values. Non-null values form the canonical `(epochNanoseconds, evidenceId)`
cursor. Cursorless carry-in state is rejected because it cannot prove that
newly supplied evidence follows the state it claims to continue.

The state transition occurs only from normalized execution evidence representing
an actual completed fill. A decision alone never advances state.

- `ENTER` stores the entry path.
- `ADD` increments the episode ADD count.
- `REDUCE` and `EXIT` add known realized PnL to the current episode.
- A full `EXIT` within the frozen quantity tolerance records the exit timestamp
  and episode PnL, then resets episode counters.
- Every accepted evidence item updates `lastEvidenceAt` and `lastEvidenceId`.

One-step advancement and projection both require evidence to be strictly after
an existing cursor by exact epoch nanoseconds and then lexicographic evidence
ID. Projection initializes that comparison from the supplied initial state, so
overlapping or regressing evidence cannot be replayed against an already
projected state. Equal instants are accepted only for a greater evidence ID.

Unknown realized PnL, incomplete fill evidence, invalid timestamps, non-finite
values, negative quantities, out-of-order evidence, or an unexplained lifecycle
must fail explicitly. They must not be replaced with zero or silently skipped.

## State Projection Boundary

The preparation module defines a normalized evidence input but does not read the
database. This separates two concerns:

1. Purely prove how ordered evidence produces candidate state.
2. Later, after prospective closure and explicit approval, decide whether an
   operational adapter reconstructs that evidence from orders/fills or persists
   candidate state directly.

No migration is needed in the preparation phase. The later deployment design
must prove restart recovery and partial-fill behavior before selecting either
reconstruction or persistence.

## Parity Strategy

Golden tests pass the same synthetic input vectors to:

- the frozen research evaluator
- the new deployment-readiness evaluator

They compare policy ID, original/effective action, outcome, reason, precedence,
and state transitions. Fixtures must be synthetic or derived only from evidence
available before the prospective observation window. They must never be updated
in response to observed prospective results.

Required cases include:

- existing `REDUCE` and `EXIT` preservation
- HTF entry suppression
- early thesis failure exit
- one-ADD episode limit
- losing-exit cooldown
- same-entry-path cooldown
- component precedence conflicts
- carry-in inventory
- exact cooldown boundary timestamps
- equal timestamps and deterministic evidence ordering
- decimal quantity residual within and outside tolerance
- missing realized PnL
- malformed or non-finite state/evidence
- input immutability
- all three registered policy IDs

The tests prove decision-policy parity only. They do not claim parity between
modeled research fills and real exchange latency, partial fills, cancellation,
fees, or slippage.

State-transition parity additionally uses one synthetic pre-window continuous
replay through the unchanged frozen backtest authority. It compares every shared
state field after `ENTER`, `ADD`, `REDUCE`, a non-closing partial `EXIT`, and a
full `EXIT`, including six-decimal PnL accumulation, the `1e-12` closure
tolerance, and cooldown carry state. The frozen backtest represents partial
risk reduction as `REDUCE`; the test-only normalized adapter presents its second
non-closing reduction as `EXIT` to exercise the candidate partial-EXIT branch.
The candidate-only `lastEvidenceAt`/`lastEvidenceId` cursor is adapter provenance
and has no corresponding frozen research-state field.

## Dependency Safety

A static test must establish both directions:

- candidate preparation modules cannot import app, DB, exchange, execution,
  reconciliation, Telegram, scheduler, smoke, migration, or prospective
  evaluation modules
- app, runner, scheduler, Telegram, execution, exchange, reconciliation, and DB
  modules cannot import candidate preparation modules

The test should discover files by directory and import traversal rather than rely
only on a manually maintained prospective source-file list.

Module edges are extracted with the TypeScript compiler AST, not regular
expressions. Static import/export declarations, inline and declaration-level
type-only syntax, import-equals, and import-type nodes retain `TYPE_ONLY` versus
`RUNTIME` semantics. Literal dynamic `import()`, including an import-options
argument, and unshadowed bare `require()` are runtime edges. Escaped string and
no-substitution template literals use their decoded values. Any computed or
otherwise non-literal dynamic import or unshadowed bare require in a guarded
candidate/runtime closure fails the guard instead of being ignored.

Comments and ordinary strings are not syntax edges. A bare `require()` call is
ignored only when TypeScript symbol resolution identifies its nearest binding
as an in-source function declaration named `require`. A nearer parameter,
variable, import, catch binding, or loop binding prevents a distant declaration
from suppressing the edge; other bare require calls remain conservatively
module-loading. Property calls such as `loader.require()` are not CommonJS
bare-require syntax and are outside this extractor boundary.

The existing prospective dependency boundary remains unchanged and continues to
protect the registered experiment graph.

## Later Activation Gates

Candidate runtime integration is a separate future change and requires all of:

1. The prospective window has ended.
2. Public closure evidence and no-peek validation pass.
3. The registered result supports a specific candidate under its frozen rules.
4. Offline parity and state recovery tests pass.
5. A no-order shadow phase is explicitly approved and completed.
6. DRY_RUN integration is explicitly approved and verified.
7. A limited LIVE canary is separately approved with rollback and kill-switch
   procedures.

None of these gates is satisfied or bypassed by this preparation work.

## Documentation Consistency

`PRODUCT_BOUNDARY.md`, `ARCHITECTURE.md`, `RISK_POLICY.md`, and `README.md` now
consistently record that `PCS-2026-001` is publicly registered for the immutable
window `[2026-08-23T08:00:00.000Z,2026-12-21T08:00:00.000Z)`, with no deployment,
`DRY_RUN`, scheduler, order, or `LIVE` authority. They also document candidate
policy and state modules as pure, configuration-free, execution-disconnected,
runtime-unreachable post-closure deployment-readiness work; current
percentage-based sizing and all execution guards remain unchanged.

## Verification

Implementation will be test-driven and must finish with:

- candidate unit and state-transition tests
- golden parity tests
- candidate dependency-boundary tests
- existing prospective commitment and dependency tests
- `npm.cmd run typecheck`
- the full test suite
- `git diff --check`

No operational process, API, Telegram poller, scheduler, sync, migration, or LIVE
database is started during verification.
