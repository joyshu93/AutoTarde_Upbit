# ADD Loss Attribution And Holdout Hypothesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, deterministic diagnostic that attributes realized ADD-fill losses to predeclared contemporaneous conditions and identifies only cross-asset-consistent existing policies as frozen future-holdout hypotheses.

**Architecture:** Two new pure modules perform per-asset ADD contribution aggregation and cross-asset holdout classification. The existing integrated strategy-evaluation report supplies immutable diagnostic, excursion, candidate-gate, and `researchSuppression` evidence; it renders an optional bounded text section and full stable JSON without entering the execution graph.

**Tech Stack:** TypeScript strict mode, Node.js built-in test/assert tooling, existing SQLite read-only research adapters, existing integrated strategy-evaluation CLI.

## Global Constraints

- Do not start or resume LIVE, call `/resume`, `/run`, `/sync`, a scheduler tick, order mutation, Upbit API, Telegram API, migration, runtime wiring, or Telegram polling.
- Open the operational SQLite database only through existing `readOnly: true` research paths; never modify DB/WAL/SHM files.
- Do not change PositionGuard strategy rules, thresholds, execution state, live-order settings, secret files, or the read-only reference repository.
- Use only `ADD_RISK_CLEAR`, `ADD_HIGH_ALIGNMENT`, and `ADD_CORE_TREND`; consume their existing `researchSuppression` evidence instead of duplicating policy predicates.
- Keep ADD-fill contribution signs separate from FIFO-lot and position-episode win rates; partial inventory must remain visible.
- Missing fee, lifecycle, excursion, cadence, or finite evidence remains explicit and cannot be replaced by zero.
- A known net contribution requires the existing diagnostic's `costAndFeeImpact.completeness === "COMPLETE"` evidence. Never synthesize entry or exit fees from aggregate/model values; preserve realization-slice IDs and keep net unknown when either required fee component is unknown.
- Compare timestamps by exact epoch with explicit timezone and use stable fill-ID tie-breaking.
- Do not commit or push unless the user separately requests it.
- The broader HTF/pullback/thesis-failure/cooldown scenario prompt is deferred and out of scope.

---

### Task 1: Pure ADD Loss Attribution

**Files:**
- Create: `src/modules/performance/performance-add-loss-attribution.ts`
- Create: `tests/performance-add-loss-attribution.test.ts`
- Read: `src/modules/performance/performance-add-diagnostics.ts`
- Read: `src/modules/performance/performance-add-excursions.ts`

**Interfaces:**
- Consumes: `AddDecisionDiagnosticsResult`, `AddPostDecisionExcursionResult`, and caller-provided `AddPolicySuppressionEvidence[]` extracted from existing candidate replay frames.
- Produces: `analyzeAddLossAttribution(input: AddLossAttributionInput): AddLossAttributionResult` with stable per-exposure records, dimension cohorts, policy-suppressed cohorts, completeness, and evidence IDs.

- [ ] **Step 1: Write failing validation and ordering tests**

Test explicit timezone validation, duplicate/mismatched exposure IDs, negative or non-finite monetary/quantity values, mixed timezone ordering, same-epoch fill-ID tie-breaks, and deterministic ADD ordinals within one episode. Test that only `COMPLETE` existing fee evidence with realization-slice IDs produces known net, while either missing entry/exit allocation or any other completeness state produces unknown net. The expected failure is a missing module/export before implementation.

- [ ] **Step 2: Run the focused test and verify RED**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/performance-add-loss-attribution.test.js`

Expected: FAIL because `performance-add-loss-attribution.js` or `analyzeAddLossAttribution` does not exist.

- [ ] **Step 3: Implement validated normalized contribution records**

Define immutable JSON-compatible records that preserve asset, market, decision/fill/episode IDs, regime, `atrShock`, `weakeningStage`, integer `trendAlignmentScore`, ADD ordinal, lifecycle state, notional, quantities, gross/net/fee metrics, excursion metrics, and provenance. Derive ordinals by exact decision epoch and stable fill ID only among executed ADD fills linked to the same episode.

- [ ] **Step 4: Write failing aggregation tests**

Cover positive/negative/breakeven fully realized ADDs, partial realization, open inventory, missing fees, missing excursions, every cohort dimension, and BTC/ETH isolation. Assert explicit denominators, known counts, totals, means, min/max MAE/MFE, and exact evidence IDs.

- [ ] **Step 5: Run focused tests and verify RED for aggregation behavior**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/performance-add-loss-attribution.test.js`

Expected: FAIL on absent cohort and metric output while the validation cases pass.

- [ ] **Step 6: Implement stable cohorts and policy-suppressed sets**

Aggregate only predeclared dimensions: regime, ATR shock, weakening stage, exact alignment score, ADD ordinal, and supplied policy suppression sets. A cohort with no known net observation is never ranked. Unknown fee evidence prevents a known net contribution; absent excursions remain distinct from zero.

- [ ] **Step 7: Run focused tests and refactor while green**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/performance-add-loss-attribution.test.js`

Expected: PASS with no runtime, DB, exchange, or strategy imports in the new module.

### Task 2: Cross-Asset Future-Holdout Classification

**Files:**
- Create: `src/modules/performance/performance-add-holdout-hypothesis.ts`
- Create: `tests/performance-add-holdout-hypothesis.test.ts`
- Read: `src/modules/performance/performance-add-policy-evaluation.ts`
- Consume: `src/modules/performance/performance-add-loss-attribution.ts`

**Interfaces:**
- Consumes: BTC and ETH `AddLossAttributionResult` plus each asset's existing `AddPolicyCandidateEvaluationResult[]`.
- Produces: `classifyAddHoldoutHypotheses(input: AddHoldoutHypothesisInput): AddHoldoutHypothesisResult` with one result per existing candidate and statuses `READY_FOR_FUTURE_HOLDOUT | CONFLICTING | INSUFFICIENT | NOT_APPLICABLE`.

- [ ] **Step 1: Write failing precedence tests**

Create one test for each status and prove precedence: missing scenarios/candidate gives `NOT_APPLICABLE`; incomplete cadence/lifecycle/fee/finite evidence or no known suppressed realization gives `INSUFFICIENT`; cross-asset gate or contribution disagreement gives `CONFLICTING`; only frozen support insufficiency with all other gates passing and negative known suppressed net contribution for both assets gives `READY_FOR_FUTURE_HOLDOUT`.

- [ ] **Step 2: Run focused tests and verify RED**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/performance-add-holdout-hypothesis.test.js`

Expected: FAIL because the classifier module/export does not exist.

- [ ] **Step 3: Implement exhaustive deterministic classification**

Reference existing candidate gate objects and approved thresholds; do not recalculate replay performance or copy policy predicates. Return exact reason codes, source candidate statuses, gate references, both asset suppressed-set totals/completeness, and evidence IDs. `READY_FOR_FUTURE_HOLDOUT` must not mutate or reinterpret the existing `INSUFFICIENT` candidate status.

- [ ] **Step 4: Add failing corruption and stability tests**

Reject duplicate asset/candidate inputs, missing BTC/ETH separation, non-finite known totals, and candidate-ID mismatches. Assert candidate order and reason order are stable and JSON-safe.

- [ ] **Step 5: Implement validation and run focused tests**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/performance-add-holdout-hypothesis.test.js`

Expected: PASS for all status, precedence, corruption, and ordering cases.

### Task 3: Integrated Research CLI And Report

**Files:**
- Modify: `src/research/integrated-strategy-evaluation.ts`
- Modify: `tests/integrated-strategy-evaluation.test.ts`
- Modify: `tests/run-all.ts`
- Consume: both new performance modules.

**Interfaces:**
- Extracts `AddPolicySuppressionEvidence` from each existing candidate cell's replay frames where `researchSuppression?.originalAction === "ADD"`; this is the single policy-membership source.
- Adds optional `addLossAttribution` to the integrated result only when BASELINE, NO_ADD, all three candidate scenarios, diagnostics, excursions, and candidate gate evaluations are available for both assets.

- [ ] **Step 1: Write failing legacy-boundary and assembly tests**

Assert legacy scenario sets omit the section unchanged. For the full scenario matrix, assert exact suppression evidence is joined to baseline ADD exposures, BTC/ETH attribution remains separate, and candidate classification is assembled without strategy execution or DB writes.

- [ ] **Step 2: Run focused tests and verify RED**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/integrated-strategy-evaluation.test.js`

Expected: FAIL because `addLossAttribution` is absent.

- [ ] **Step 3: Implement optional integration and provenance**

Build the section from already-produced in-memory evidence. Record dataset hashes, read-only DB/report provenance, filters, cost-cell IDs, W1/W2/W3 IDs, candidate IDs, and source evidence IDs. Never use wall-clock time for ordering or conclusions.

- [ ] **Step 4: Write failing text/JSON output tests**

Text must show BTC/ETH totals, at most three highest-known-loss cohorts per asset, denominator/completeness/fee impact, candidate suppressed-set summaries, cross-asset statuses/reasons, and the selected-flow/non-causal/non-deployment warning. JSON must retain every cohort, metric state, gate reference, and evidence ID with stable ordering.

- [ ] **Step 5: Implement bounded text and stable JSON rendering**

Preserve existing output exactly when the optional section is absent. Do not hide raw technical values or rank cohorts without known net observations.

- [ ] **Step 6: Register tests and run integration suite**

Run first: `npm.cmd run build`

Then, only after success: `node --test dist/tests/performance-add-loss-attribution.test.js dist/tests/performance-add-holdout-hypothesis.test.js dist/tests/integrated-strategy-evaluation.test.js`

Expected: PASS.

- [ ] **Step 7: Prove the import boundary**

Add a static assertion that the two new pure modules import no exchange, execution, reconciliation, Telegram, DB, app, or runtime module. Also inspect the new dependency edges added to `integrated-strategy-evaluation.ts` and prove they lead only to the existing read-only research/performance graph, never to execution, reconciliation, Telegram, app/runtime, or writable DB modules. Run the focused suite and expect PASS.

### Task 4: Documentation, Independent Review, And Read-Only Validation

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `README.md`
- Preserve: operational DB, WAL, SHM, local secret scripts, and runtime state.

**Interfaces:**
- Documents the ADD-fill attribution unit, cross-asset-only holdout rule, explicit incompleteness, deferred broad research phase, CLI output, and non-deployment meaning.

- [ ] **Step 1: Update authoritative documentation**

State that this feature is read-only selected-flow attribution, not account return, causal proof, a strategy modification, or permission to resume LIVE. Document the exact four holdout statuses and the deferred broader scenario prompt.

- [ ] **Step 2: Run an independent code review and fix validated findings through TDD**

Review metric definitions, fee completeness, partial inventory, timestamp/ordinal ordering, candidate precedence, cross-asset agreement, policy evidence reuse, output stability, and import boundaries. Any behavior fix begins with a failing regression test.

- [ ] **Step 3: Capture safety baselines**

Before the operational report, record SHA-256 hashes and sizes for the selected LIVE DB plus existing WAL/SHM files, and record the AutoTrade Node process count. Do not launch or stop any process.

- [ ] **Step 4: Run repository verification**

Run: `npm.cmd run typecheck`

Run: `npm.cmd test`

Run: `git diff --check`

Expected: all commands PASS.

- [ ] **Step 5: Run the integrated report against the LIVE DB through the read-only CLI**

Use the existing frozen research command inputs and immutable candle datasets; write output only beneath `var/research/`. Do not call acquisition, sync, runtime, scheduler, exchange, or Telegram commands. Confirm the report contains BTC/ETH attribution, all three candidate classifications, completeness warnings, and provenance.

- [ ] **Step 6: Recheck safety invariants**

Recompute DB/WAL/SHM hashes, sizes, and process count. Expected: operational files and LIVE process state are unchanged from Step 3.

- [ ] **Step 7: Report without commit or push**

Summarize implemented definitions, changed files, real read-only findings, unknown evidence, subagents and file ownership, review findings/fixes, verification commands, unchanged LIVE state, and the separately deferred research prompt. Do not commit or push.
