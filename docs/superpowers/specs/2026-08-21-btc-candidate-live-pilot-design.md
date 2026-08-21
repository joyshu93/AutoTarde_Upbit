# BTC Combined Conservative LIVE Pilot Design

## Status

Approved design for offline implementation planning. The public
`PCS-2026-001` registration was formally abandoned in commit `d7ecfd7`, and the
corresponding GitHub Actions authority run completed successfully. That
abandonment ended only the prospective research registration; it did not make
the candidate reachable from the runtime or activate the LIVE pilot.

This document and its implementation plan must not start an app, modify an
operational database, call Upbit, poll Telegram, send an order, or enable the
pilot. Operational activation remains a later, separately approved step.

## Purpose

Run the exact `COMBINED_CONSERVATIVE` PositionGuard candidate on `KRW-BTC` in a
separately governed LIVE pilot after formally abandoning the prospective shadow
registration. The pilot is intended to obtain operational evidence sooner. It
does not prove that the candidate is profitable and does not preserve the
prospective evidentiary value of `PCS-2026-001`.

## Decision Summary

The selected design is:

1. Formally abandon `PCS-2026-001` in a dedicated public registry-only commit.
2. Keep the default runtime on the existing baseline policy.
3. Add one explicit pilot profile that can select the exact
   `COMBINED_CONSERVATIVE` policy for `KRW-BTC` only.
4. Keep `KRW-ETH` on the existing baseline policy. The ETH candidate is never
   selectable by this pilot.
5. Preserve the existing percentage-based order sizing. Do not add a fixed KRW
   cap or a special reduced pilot percentage.
6. Start the BTC candidate only from a proven flat BTC position with no active
   or uncertain BTC order.
7. Build candidate state exclusively from terminal exchange-backed execution
   evidence, persist it atomically, and verify it after every restart.
8. Add a database-backed account execution lease so two processes cannot submit
   competing orders from the same account.
9. Treat send timeout or lost exchange response as an uncertain order, never as
   a final failure that permits an immediate retry.
10. Automatically pause execution on candidate-state corruption, blocking
    reconciliation drift, uncertain submission, or post-send persistence
    failure. Never resume automatically.

## Authority And Irreversibility

The current public registration authority is:

- experiment: `PCS-2026-001`
- observation window: `[2026-08-23T08:00:00.000Z,2026-12-21T08:00:00.000Z)`
- Publication A: `ed4de872d07f416c77d5f05b9dc657eae676155e`
- Publication B: `358113dba5cd0425161a4aed0827f496d268d1f5`
- registered payload SHA-256:
  `978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40`

Abandonment must use the existing append-only registry writer. The abandonment
commit must have one parent and change only
`docs/research/prospective-shadow/registry.jsonl`. The original registration
JSON and registered event must remain byte-for-byte unchanged. The public
GitHub Actions run must succeed in `ABANDONED` mode.

Abandonment is irreversible. Reverting the registry line later does not restore
the registration because the public authority path will contain a subsequent
mutation. The experiment ID, authority, and observation window cannot be reused.
The evaluator must report the abandoned registration as `REGISTRATION_INVALID`.

Abandonment ends only the research registration. It does not activate the LIVE
pilot. Runtime implementation and operational activation remain separate work.

## Product Boundary

The pilot preserves all existing product boundaries:

- exchange: Upbit only
- markets: `KRW-BTC` and `KRW-ETH` spot only
- no leverage, futures, margin, news, sentiment, or LLM trading decisions
- Telegram remains an operator interface, not the source of balances or
  positions
- exchange state plus the local database remain the truth ledger
- LIVE order transmission remains behind explicit mode, gate, policy, state,
  risk, validation, and operator-confirmation checks

The pilot changes only the policy applied to BTC strategy decisions. ETH keeps
the baseline policy so existing ETH positions are not stranded or silently
liquidated. BTC and ETH still share account cash and exposure limits, and the
existing scheduler one-order-per-batch rule remains in force.

## Policy Selection Contract

### Defaults

The default profile is `BASELINE`. Missing, empty, misspelled, or partially
configured pilot values must fail closed to either baseline or process startup
failure; they must never select the candidate implicitly.

### Explicit pilot identity

The runtime accepts one pilot identity:

`BTC_COMBINED_CONSERVATIVE_PILOT_V1`

It maps exactly to:

- market: `KRW-BTC`
- policy ID: `COMBINED_CONSERVATIVE`
- policy version: `PCS-2026-001.DEPLOYMENT_READINESS_V1`

The runtime must reject:

- any candidate policy for `KRW-ETH`
- either ablation policy
- a version mismatch
- a pilot whose local public registry is not validly `ABANDONED`
- LIVE pilot selection without a separate explicit operator confirmation
- pilot selection when the persisted policy identity disagrees with config

The selected pilot identity and operator confirmation values must be explicit
configuration. Secret values are never rendered. Example scripts remain safe
and default to baseline and `DRY_RUN`; no checked-in script activates the pilot.

## BTC Flat-Start Contract

The candidate must not inherit an existing BTC episode whose cost basis and ADD
history were created by another policy.

The persisted BTC pilot phase is one of:

- `DISABLED`: baseline policy only
- `PENDING_FLAT`: pilot selected but BTC candidate not active
- `ACTIVE`: candidate may influence BTC decisions
- `PAUSED_FAULT`: candidate execution blocked pending operator review
- `DRAINING`: no new BTC risk; existing candidate episode may only reduce or exit

When first selected, the pilot enters `PENDING_FLAT`. In this phase:

- baseline BTC `REDUCE` and `EXIT` decisions are preserved
- baseline BTC `ENTER` and `ADD` decisions become `HOLD`
- no candidate cooldown or ADD state is assumed
- the phase advances to `ACTIVE` only after an exchange-backed refresh proves
  BTC quantity is within the explicit quantity tolerance, no BTC order is active
  or uncertain, and reconciliation has no blocking issue

This permits an existing BTC position to unwind under its original policy while
preventing the candidate from adopting unknown inventory. The transition to
`ACTIVE` is persisted and auditable.

## Decision Flow

The runtime flow for BTC is:

1. Build the unchanged baseline PositionGuard engine decision.
2. Load and validate the persisted pilot phase and candidate state.
3. If `PENDING_FLAT`, apply the flat-start gate.
4. If `ACTIVE`, evaluate the exact pure candidate overlay.
5. Persist the baseline decision, candidate evaluation, effective decision,
   policy identity, policy version, state version, and reason code in
   `strategy_decisions.decision_basis_json`.
6. Send only the effective decision to the existing execution service.

The candidate evaluator may suppress `ENTER` or `ADD`, or override an eligible
decision to `EXIT`, but it does not calculate order size and does not talk to the
exchange. Existing `REDUCE` and `EXIT` decisions remain risk-reducing and take
precedence as defined by the frozen policy.

Manual `/run BTC` and scheduled BTC runs use the same router. Telegram cannot
bypass the candidate state or safety checks. `/run ETH` remains baseline.

## Sizing Contract

The pilot preserves the existing baseline sizing output:

- initial entry target: the existing 30% percentage rule
- add target: the existing 18% percentage rule
- executable notional: the minimum allowed by available KRW, per-asset
  allocation, total exposure, exchange minimums, and the existing risk rules

The candidate only allows, suppresses, or exits a baseline decision. For an
allowed `ENTER` or `ADD`, the candidate must preserve `targetNotionalKrw` and
`targetQuantityFraction` exactly.

No pilot-specific fixed KRW maximum, 5% cap, hidden multiplier, or arbitrary
small-order script is introduced. A small account therefore uses the same
percentage policy, subject to Upbit's minimum order and the existing explicit
risk guards.

## Persisted Candidate State

Candidate state must survive process restarts and be reproducible from persisted
evidence. It must not be derived from strategy intent alone.

### Policy state

A versioned policy-state table stores at least:

- exchange account ID and market
- pilot ID, candidate policy ID, and policy version
- pilot phase and phase reason
- current episode ADD count
- current episode inventory quantity and cost basis
- current episode realized PnL
- last full exit timestamp and realized PnL
- last entry path
- last evidence timestamp and ID
- state version
- activation, update, and fault timestamps

### Execution evidence

An append-only evidence table stores at least:

- stable evidence ID
- exchange account ID, market, order ID, and Upbit UUID or identifier
- strategy decision ID and effective action
- entry path
- terminal order status
- aggregate executed quantity, gross quote value, and confirmed fee
- realized PnL where required
- remaining pilot inventory quantity and cost basis
- exchange execution timestamp
- resulting state version

Evidence is produced once per terminal strategy order with non-zero executed
quantity. Raw partial fills are aggregated so one ADD order cannot increment the
episode ADD count more than once. A terminal canceled order with executed volume
still produces evidence for the executed portion. A terminal order with no fill
does not change candidate state.

Evidence insertion and state advancement occur in one SQLite transaction. The
order ID and evidence ID are unique. Duplicate evidence is idempotent only when
every material field matches; conflicting duplicates are corruption.

## Cost Basis And Realized PnL

Strict flat-start makes the candidate episode self-contained. Candidate buys add
actual executed quote cost plus confirmed fees to the episode cost basis.
Candidate sells remove proportional cost basis and add net sale proceeds minus
removed cost to episode realized PnL.

At a full exit, total episode realized PnL equals all net sell proceeds minus all
buy costs and confirmed fees. This full-episode result controls the candidate
cooldown. Missing or invalid fee, fill, side, price, quantity, order-action, or
lifecycle evidence is not replaced with zero and must block state advancement.

All quantities use the existing explicit `1e-12` tolerance. Negative,
non-finite, duplicate, contradictory, or out-of-order evidence is rejected.
Timestamps require explicit ISO-8601 offsets and are ordered by epoch followed by
stable evidence ID.

## Restart Recovery

At startup and before every BTC candidate run:

1. Load the persisted state and all evidence after the latest trusted checkpoint.
2. Replay evidence through the pure candidate state projector.
3. Compare the projected state with the persisted state and inventory.
4. Compare pilot inventory with the latest exchange-backed BTC snapshot and
   active or uncertain orders.
5. Refuse candidate execution on any mismatch.

Recovery never guesses missing fees, fills, entry path, or PnL. A mismatch sets
the pilot to `PAUSED_FAULT`, persists the reason, pauses global execution, and
emits an operator notification. Recovery never resumes automatically.

## Account Execution Lease

The existing in-process scheduler serialization is not sufficient if two app
processes point at the same SQLite database and Upbit account.

Before order validation or persistence, every executable decision must acquire a
database-backed lease keyed by exchange account ID. The lease contains a unique
owner token, acquisition time, expiry time, and purpose. Acquisition is atomic.
Only the owner may renew or release it.

While a valid lease exists, another manual or scheduled execution attempt is
rejected before creating an order row or calling Upbit. An expired lease is not
silently stolen when an active or uncertain local order exists. Lease conflict
or ambiguity pauses execution rather than permitting two sends.

The lease is a general execution safety control and applies to BTC and ETH. It
does not replace idempotency keys, duplicate-order guards, active-order checks,
or the scheduler one-order-per-batch behavior.

## Uncertain Submission Recovery

An exception after the Upbit request is sent does not prove that no order was
created. Timeout, disconnect, invalid response, or local persistence failure
after send must therefore transition the local order to
`RECONCILIATION_REQUIRED`, not terminal `FAILED`.

The order identifier remains reserved. New matching orders are blocked while
the outcome is uncertain. Recovery queries by UUID or identifier and records one
of:

- exchange order found and reconciled
- exchange definitively reports no matching order after the bounded recovery
  policy
- outcome remains uncertain and execution stays paused

The system never retries `createOrder` merely because the original response was
lost.

## Per-Run Preflight

Every manual or scheduled pilot run performs, in order:

1. exchange-backed account refresh and snapshot persistence
2. reconciliation with blocking versus non-blocking issue classification
3. execution-state, kill-switch, and pilot-phase validation
4. active and uncertain order validation
5. candidate state replay and freshness validation
6. account execution lease acquisition
7. unchanged risk guard evaluation
8. Upbit order-chance validation
9. Upbit order-test validation
10. local order persistence followed by the existing live send path

Any failure before local order persistence produces zero local order rows and
zero `createOrder` calls. The account lease is released only when doing so is
safe; uncertainty keeps execution blocked.

## Automatic Pause Conditions

The application persists an explicit reason, transitions global execution to
`PAUSED`, and notifies the operator when any of these occurs during pilot use:

- candidate state replay mismatch or stale state
- missing or contradictory candidate evidence
- blocking reconciliation drift
- unknown or uncertain order outcome
- execution lease ambiguity
- exchange accepted an order but required local persistence failed
- persisted pilot identity differs from configured identity
- local PCS registry no longer proves valid abandonment

Risk-policy rejection before send remains an ordinary recorded rejection unless
it indicates corrupted state. Automatic pause never automatically resumes.

## Rollback Contract

Changing a policy in the middle of an episode is prohibited.

Rollback proceeds as follows:

1. Pause global execution.
2. Reconcile all active and uncertain orders.
3. If BTC is flat, disable the pilot and return BTC to baseline.
4. If BTC is not flat, move the pilot to `DRAINING`; suppress new `ENTER` and
   `ADD`, but preserve candidate or baseline risk-reducing `REDUCE` and `EXIT`
   according to the persisted episode policy.
5. Return to baseline only after exchange-backed evidence proves BTC is flat.
6. Require an explicit operator resume after readiness passes.

Rollback does not blindly cancel an exchange order and does not discard
candidate evidence.

## Operator Surface

Existing concise Korean-first Telegram responses remain the default. Status and
readiness output must expose:

- pilot ID and phase
- BTC policy ID and version
- candidate state version and last evidence time
- flat-start, active-order, state-replay, lease, and reconciliation readiness
- whether ETH remains baseline
- the effective candidate outcome and reason for the latest BTC decision

Alerts are required for pilot activation, phase transition, candidate state
fault, automatic pause, uncertain submission, reconciliation recovery, rollback
start, and rollback completion. Technical identifiers remain available in detail
views.

Telegram cannot activate the pilot, change its policy, supply balances or
positions, or bypass readiness. Initial pilot activation remains a local
configuration plus startup-confirmation operation.

## Performance Attribution

Every candidate-affected strategy decision records:

- baseline action and sizing
- candidate original and effective action
- candidate outcome, reason, and precedence
- pilot ID, policy ID, policy version, and state version
- flat-start or draining gate result

Orders and fills retain the strategy decision link. Read-only performance tools
can therefore report BTC candidate-attributed results separately from ETH
baseline results and account-wide changes.

The pilot does not guarantee improved returns. Account-wide results can still be
affected by ETH baseline trades, cash sharing, market movement, fees, deposits,
withdrawals, and external account activity.

## Database Changes

The implementation is expected to add one migration with explicit tables for:

- pilot policy state
- append-only candidate execution evidence
- account execution leases

Repository contracts must provide atomic evidence-plus-state advancement and
atomic lease acquisition. In-memory repositories mirror SQLite behavior for
tests. Existing order, fill, execution-state, reconciliation, and notification
tables remain the authoritative lifecycle records.

No performance analysis table is added to the execution graph.

## Strict Read-Only Readiness Tool

Add a pilot readiness command that opens an existing SQLite database with
`readOnly: true`. It must not run migrations, configure WAL, write checkpoints,
start the app, poll Telegram, call Upbit, sync, run a strategy, install scheduler
timers, deliver notifications, or send an order.

It validates persisted evidence, pilot identity, state replay, active and
uncertain orders, latest snapshots, reconciliation classification, registry
abandonment, and configuration. Exchange-backed checks remain the responsibility
of actual runtime preflight after startup.

## TDD Acceptance Matrix

Implementation starts with failing tests for:

1. Default baseline selection and explicit candidate selection.
2. Startup rejection before valid public abandonment.
3. Rejection of candidate selection for ETH and of ablation policies.
4. Exact preservation of baseline percentage sizing.
5. `PENDING_FLAT` suppression of BTC entry and ADD.
6. Exchange-backed flat transition to `ACTIVE`.
7. Candidate policy allow, suppress, and override-exit paths.
8. Decision-basis audit fields and stable reason codes.
9. Partial-fill aggregation into one order evidence record.
10. Terminal canceled orders with and without executed quantity.
11. ADD count advancing once per terminal executed order.
12. Fee-inclusive cost basis and full-exit episode PnL.
13. Missing fees and contradictory lifecycle evidence failing closed.
14. Duplicate, conflicting, and out-of-order evidence rejection.
15. Decimal quantity residual tolerance.
16. Atomic SQLite evidence and state advancement.
17. State replay after restart and mismatch detection.
18. Single-process and multi-process account lease contention.
19. Lease expiry with active or uncertain orders.
20. Send timeout and lost response becoming `RECONCILIATION_REQUIRED`.
21. Identifier recovery without duplicate `createOrder`.
22. Automatic pause and no automatic resume.
23. Mid-episode rollback entering `DRAINING`.
24. Flat rollback returning to baseline.
25. Manual and scheduler routes using the same policy router.
26. Existing scheduler one-order-per-batch behavior.
27. Fake-exchange order chance, order-test, send, partial fill, terminal state,
    state update, and restart recovery lifecycle.
28. Strict read-only readiness causing no SQLite mutation.
29. Full migration compatibility.
30. Static dependency tests allowing only the reviewed runtime bridge while
    continuing to block research/performance imports from execution modules.

## Delivery Sequence

### Phase 0: design approval

- approve this design and its BTC flat-start, ETH-baseline, and rollback rules

### Phase 1: public research abandonment

- create the append-only `ABANDONED` registry event
- verify the registry-only one-parent commit
- push it separately
- require the GitHub Actions `ABANDONED` run to pass
- archive the server-timestamped authority artifact

No candidate runtime code is part of the abandonment commit.

### Phase 2: offline implementation

- add configuration, policy router, persistence, evidence projector, execution
  lease, uncertain-submission recovery, automatic pause, operator inspection,
  and strict read-only readiness
- implement in an isolated worktree with TDD
- update root architecture, risk, lifecycle, and README contracts
- run independent code review and the full test suite

No operational database, Upbit endpoint, Telegram polling, or LIVE process is
touched in this phase.

### Phase 3: no-order validation

- run strict read-only readiness against a copied or read-only LIVE database
- run fake-exchange integration tests
- run the pilot in `DRY_RUN`
- run Upbit order chance and order-test only through an explicitly approved
  validation path

### Phase 4: explicit LIVE approval

- stop any existing runtime cleanly
- confirm no duplicate process, active order, uncertain order, blocking drift,
  or state mismatch
- start with scheduler disabled
- complete `PENDING_FLAT` if necessary
- perform one explicitly approved manual BTC LIVE cycle
- reconcile and review the resulting order, fills, fees, state, and alerts

### Phase 5: BTC candidate scheduler

- require a second explicit operator approval
- start the scheduler with the pilot confirmation and run-on-start disabled
- monitor candidate attribution, reconciliation, risk blocks, state replay, and
  order uncertainty

## Go/No-Go Gates

LIVE pilot activation is `NO-GO` until all of the following are true:

- public `PCS-2026-001` abandonment is valid and archived
- implementation and documentation are committed and reviewed
- typecheck, build, full tests, migration tests, and `git diff --check` pass
- candidate parity tests still match the frozen exact policy
- strict read-only readiness passes
- no active or uncertain order exists
- exchange-backed snapshots and reconciliation pass blocking checks
- candidate state is flat, pristine, persisted, and replayable
- account execution lease tests pass
- uncertain submission and automatic pause tests pass
- operator has explicitly approved the manual LIVE cycle

Scheduler activation has the additional gates of a reconciled manual LIVE cycle
and a separate explicit operator approval.

## Rejected Alternatives

### Immediate candidate LIVE wiring

Rejected because the current prospective registration is still active and
candidate execution state, cross-process serialization, uncertain sends, and
automatic pause are not yet production-safe.

### Candidate adoption of existing BTC inventory

Rejected because it requires reconstructing opening inventory, policy history,
fees, and ADD count across older fills and possible external account activity.

### Memory-only candidate state

Rejected because restart changes policy behavior and can reset ADD limits or
cooldowns.

### Intent-based state updates

Rejected because rejected, canceled, partially filled, and response-lost orders
would corrupt state.

### Fixed pilot order cap or reduced percentage

Rejected because the operator selected the existing percentage sizing and the
account is already small. Existing allocation and exposure guards remain.

### ETH candidate activation

Rejected because the available retrospective evidence contains known ETH
directional failures. ETH remains baseline in this pilot.

## Main-Agent Safety Review

The main integration review must verify:

- no hidden route can activate the candidate
- `ExecutionService` remains the only order-send authority
- no research or performance module enters the execution graph
- baseline sizing is byte-for-byte or value-for-value preserved when allowed
- candidate state changes only from persisted exchange-backed execution evidence
- restart, partial fill, timeout, and duplicate-process behavior fail closed
- rollback cannot switch policy mid-episode
- LIVE scripts default to pilot disabled
- no implementation or validation step starts LIVE without explicit approval
