# PositionGuard Defensive Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conservative staged defensive exposure policy so open PositionGuard positions reduce risk sooner in weak downtrend, breakdown-risk, and profitable range-deterioration states.

**Architecture:** Keep the change inside the pure `position-guard-core` decision engine. Add focused regression tests first, then adjust only the REDUCE planning helper so execution, exchange, Telegram, scheduler, reconciliation, and live-gate behavior remain untouched.

**Tech Stack:** TypeScript strict mode, Node.js >=22.13.0, built-in `node:assert/strict`, existing custom test harness, existing PositionGuard public backtest command.

## Global Constraints

- Default execution mode remains `DRY_RUN`.
- Live order transmission remains behind explicit `APP_EXECUTION_MODE=LIVE` and `ENABLE_LIVE_ORDERS=true`.
- Scope remains Upbit spot only, `KRW-BTC` and `KRW-ETH` only.
- Telegram remains an operator surface only and must not accept manual cash or position truth.
- Strategy logic remains deterministic and rule-based; no discretionary LLM, news, sentiment, futures, margin, leverage, or multi-exchange inputs.
- `/preview BTC|ETH` remains non-mutating.
- `/run BTC|ETH` and scheduler paths keep the same persisted-health, risk, execution, and reconciliation guards.
- Public backtests remain research-only: no DB writes, Telegram transport, private exchange reads, order lifecycle mutation, or live order transmission.
- Before implementation code changes, read `PRODUCT_BOUNDARY.md`, `ARCHITECTURE.md`, `RISK_POLICY.md`, `ORDER_LIFECYCLE.md`, and `README.md`.

---

## File Structure

- Modify `tests/position-guard-core-strategy.test.ts`
  - Responsibility: pure behavior coverage for PositionGuard decisions.
  - Add failing tests for defensive REDUCE conditions and one non-regression test that weak downtrend without extra evidence remains HOLD.
- Modify `src/modules/strategy/position-guard-core.ts`
  - Responsibility: deterministic PositionGuard decision logic.
  - Add small helper predicates and one defensive reduce-plan helper used by `getStructuredReducePlan`.
- Modify `ARCHITECTURE.md`
  - Responsibility: root architecture contract for strategy behavior.
  - Add one bullet under current strategy direction.
- Modify `RISK_POLICY.md`
  - Responsibility: root safety and risk contract.
  - Add one policy sentence for staged defensive reductions.
- Modify `ORDER_LIFECYCLE.md`
  - Responsibility: order lifecycle trigger semantics.
  - Clarify that these new REDUCE signals are normal strategy decisions, not scheduler or reconciliation triggers by themselves.
- Modify `README.md`
  - Responsibility: operator-facing project summary.
  - Add one current-stage bullet describing the defensive exposure policy.

---

### Task 1: Add Defensive Exposure Contract Tests

**Files:**
- Modify: `tests/position-guard-core-strategy.test.ts`

**Interfaces:**
- Consumes: `decidePositionGuardCore(context: PositionGuardStrategyContext): PositionGuardEngineDecision`
- Consumes: `toStrategyDecision(context: PositionGuardStrategyContext, decision: PositionGuardEngineDecision): StrategyDecision`
- Consumes: existing local `createContext(...)` test helper.
- Produces: failing test expectations for Task 2.

- [ ] **Step 1: Add the weak-downtrend defensive REDUCE test**

Insert this test after `position guard core reduces a profitable position on soft weakening`:

```ts
test("position guard core reduces weak-downtrend exposure when deterioration is confirmed", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "WEAK_DOWNTREND",
      invalidationState: "CLEAR",
      currentPrice: 94_000_000,
      pnlPct: -0.06,
      weakeningStage: "NONE",
      failedReclaim: true,
      bearishMomentumExpansion: false,
      atrShock: false,
      breakdownPressureScore: 1,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) >= 0.25);
  assert.ok((decision.targetQuantityFraction ?? 0) <= 0.45);
  assert.match(decision.reasons.join(" "), /Weak downtrend/);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});
```

- [ ] **Step 2: Add the weak-downtrend HOLD guard test**

Insert this test immediately after the previous test:

```ts
test("position guard core holds weak-downtrend exposure without additional deterioration", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "WEAK_DOWNTREND",
      invalidationState: "CLEAR",
      currentPrice: 98_500_000,
      pnlPct: -0.015,
      weakeningStage: "NONE",
      failedReclaim: false,
      bearishMomentumExpansion: false,
      atrShock: false,
      breakdownPressureScore: 0,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.equal(decision.targetQuantityFraction, null);
  assert.equal(strategyDecision.action, "HOLD");
  assert.equal(strategyDecision.requestedQuantity, null);
});
```

- [ ] **Step 3: Add the breakdown-risk defensive REDUCE test**

Insert this test after the weak-downtrend tests:

```ts
test("position guard core reduces breakdown-risk exposure before full invalidation", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "BREAKDOWN_RISK",
      invalidationState: "CLEAR",
      currentPrice: 95_000_000,
      pnlPct: -0.05,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      atrShock: false,
      breakdownPressureScore: 2,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) >= 0.3);
  assert.ok((decision.targetQuantityFraction ?? 0) <= 0.55);
  assert.match(decision.reasons.join(" "), /Breakdown risk/);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});
```

- [ ] **Step 4: Add the profitable range protection test**

Insert this test after the breakdown-risk test:

```ts
test("position guard core protects profitable range exposure on soft momentum deterioration", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 90_000_000,
    analysis: {
      regime: "RANGE",
      invalidationState: "CLEAR",
      currentPrice: 99_000_000,
      pnlPct: 0.10,
      weakeningStage: "SOFT",
      failedReclaim: false,
      bearishMomentumExpansion: true,
      atrShock: false,
      upperRangeChase: false,
      breakdownPressureScore: 0,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) >= 0.15);
  assert.ok((decision.targetQuantityFraction ?? 0) <= 0.28);
  assert.match(decision.reasons.join(" "), /protects open gains/);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});
```

- [ ] **Step 5: Run the tests and verify the intended failures**

Run:

```powershell
npm.cmd run test
```

Expected result before Task 2:

- `position guard core reduces weak-downtrend exposure when deterioration is confirmed` fails with actual `HOLD`.
- `position guard core reduces breakdown-risk exposure before full invalidation` fails with actual `HOLD`.
- `position guard core protects profitable range exposure on soft momentum deterioration` fails with actual `HOLD`.
- `position guard core holds weak-downtrend exposure without additional deterioration` passes.

- [ ] **Step 6: Commit the failing test set only if working in a branch that allows red commits**

Use this only when intentionally committing a red TDD checkpoint:

```powershell
git add tests/position-guard-core-strategy.test.ts
git commit -m "test: define PositionGuard defensive exposure behavior"
```

If red commits are not desired, leave the tests uncommitted and continue to Task 2.

---

### Task 2: Implement Defensive REDUCE Planning In The Pure Core

**Files:**
- Modify: `src/modules/strategy/position-guard-core.ts`
- Test: `tests/position-guard-core-strategy.test.ts`

**Interfaces:**
- Consumes: `PositionGuardStrategyContext`
- Consumes: `PositionGuardStructureAnalysis`
- Consumes: `computeWeaknessScore(analysis: PositionGuardStructureAnalysis): number`
- Produces: `getDefensiveExposureReducePlan(context: PositionGuardStrategyContext, weaknessScore: number): StructuredReducePlan | null`
- Produces: helper predicates used only by the pure core.

- [ ] **Step 1: Add a local reduce-plan type alias**

In `src/modules/strategy/position-guard-core.ts`, insert this type alias immediately before `function getStructuredReducePlan(...)`:

```ts
type StructuredReducePlan = {
  reduceFraction: number;
  qualityBucket: StrategySignalQualityBucket;
  reasons: string[];
};
```

- [ ] **Step 2: Change `getStructuredReducePlan` to use the alias and call the defensive helper first**

Replace the `getStructuredReducePlan` signature and first lines with this:

```ts
function getStructuredReducePlan(
  context: PositionGuardStrategyContext,
  weaknessScore: number,
): StructuredReducePlan | null {
  const defensivePlan = getDefensiveExposureReducePlan(context, weaknessScore);
  if (defensivePlan) {
    return defensivePlan;
  }

  const analysis = context.analysis;
  const hasProfitBuffer = analysis.pnlPct >= 0.02;
  const hasIndependentEvidence = hasIndependentReduceEvidence(analysis);
```

Keep the existing `SOFT`, `NONE`, threshold, and return logic below those lines unchanged.

- [ ] **Step 3: Add the defensive reduce helper below `getStructuredReducePlan`**

Insert this function immediately after `getStructuredReducePlan(...)` and before `getGraduatedReduceFraction(...)`:

```ts
function getDefensiveExposureReducePlan(
  context: PositionGuardStrategyContext,
  weaknessScore: number,
): StructuredReducePlan | null {
  const analysis = context.analysis;

  if (hasWeakDowntrendDeterioration(analysis)) {
    return {
      reduceFraction: Math.min(0.45, Math.max(0.25, context.settings.reduceFraction * 0.9)),
      qualityBucket: weaknessScore >= 4 ? "MEDIUM" : "BORDERLINE",
      reasons: ["Weak downtrend has independent deterioration, so the position shifts to defensive reduction."],
    };
  }

  if (hasBreakdownRiskDeterioration(analysis)) {
    return {
      reduceFraction: Math.min(0.55, Math.max(0.3, context.settings.reduceFraction)),
      qualityBucket: weaknessScore >= 5 ? "MEDIUM" : "BORDERLINE",
      reasons: ["Breakdown risk is elevated, so exposure is reduced before full invalidation is reached."],
    };
  }

  if (hasProfitableRangeProtectionEvidence(analysis)) {
    return {
      reduceFraction: Math.min(0.28, Math.max(0.15, context.settings.reduceFraction * 0.5)),
      qualityBucket: "BORDERLINE",
      reasons: ["Profitable range exposure has soft deterioration, so a modest reduction protects open gains."],
    };
  }

  return null;
}
```

- [ ] **Step 4: Add helper predicates below the defensive reduce helper**

Insert these functions immediately after `getDefensiveExposureReducePlan(...)`:

```ts
function hasWeakDowntrendDeterioration(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.regime === "WEAK_DOWNTREND" &&
    (
      analysis.failedReclaim ||
      analysis.bearishMomentumExpansion ||
      analysis.atrShock ||
      analysis.breakdownPressureScore >= 2 ||
      analysis.weakeningStage !== "NONE"
    );
}

function hasBreakdownRiskDeterioration(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.regime === "BREAKDOWN_RISK" &&
    (
      analysis.breakdownPressureScore >= 2 ||
      analysis.failedReclaim ||
      analysis.bearishMomentumExpansion ||
      analysis.atrShock ||
      analysis.weakeningStage !== "NONE"
    );
}

function hasProfitableRangeProtectionEvidence(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.regime === "RANGE" &&
    analysis.pnlPct >= 0.02 &&
    analysis.weakeningStage === "SOFT" &&
    (
      analysis.failedReclaim ||
      analysis.bearishMomentumExpansion ||
      analysis.atrShock ||
      analysis.upperRangeChase ||
      analysis.breakdownPressureScore >= 1
    );
}
```

- [ ] **Step 5: Run tests and verify the new tests pass**

Run:

```powershell
npm.cmd run test
```

Expected result:

- All existing tests pass.
- The four tests added in Task 1 pass.

- [ ] **Step 6: Run typecheck**

Run:

```powershell
npm.cmd run typecheck
```

Expected result:

- TypeScript exits with code 0.

- [ ] **Step 7: Commit core implementation**

Run:

```powershell
git add src/modules/strategy/position-guard-core.ts tests/position-guard-core-strategy.test.ts
git commit -m "Add PositionGuard defensive exposure reductions"
```

---

### Task 3: Document, Verify, And Backtest The Strategy Change

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `RISK_POLICY.md`
- Modify: `ORDER_LIFECYCLE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 pure strategy behavior.
- Produces: updated root documentation and verification evidence.

- [ ] **Step 1: Update `ARCHITECTURE.md`**

In the `Current strategy direction:` bullet list, add this bullet near the existing PositionGuard REDUCE notes:

```md
- PositionGuard now applies a staged defensive exposure policy for open positions in weak downtrend, breakdown-risk, and profitable range-deterioration states, while preserving immediate invalidation exits.
```

- [ ] **Step 2: Update `RISK_POLICY.md`**

Near the existing PositionGuard `/run BTC|ETH` and no-open-position policy text, add this sentence:

```md
For open positions, PositionGuard may create staged risk-reducing `REDUCE` decisions when weak-downtrend, breakdown-risk, or profitable range-deterioration evidence appears; these are deterministic sell intents and must still pass the normal execution and risk pipeline.
```

- [ ] **Step 3: Update `ORDER_LIFECYCLE.md`**

Near the strategy trigger and flat-position lifecycle text, add this sentence:

```md
Defensive PositionGuard `REDUCE` decisions for open positions become normal order-intent candidates only after the strategy runner emits them; the regime evidence itself is not a reconciliation, scheduler, or cancellation trigger.
```

- [ ] **Step 4: Update `README.md`**

In `Current remaining gaps:`, near the PositionGuard bullets, add this bullet:

```md
- PositionGuard now applies staged defensive reductions for open positions when weak-downtrend, breakdown-risk, or profitable range-deterioration evidence appears, while keeping immediate invalidation exits and no-position HOLD behavior intact.
```

- [ ] **Step 5: Run full project verification**

Run:

```powershell
npm.cmd run check
```

Expected result:

- Typecheck passes.
- Full test suite passes.

- [ ] **Step 6: Run whitespace validation**

Run:

```powershell
git diff --check
```

Expected result:

- Exit code 0.

- [ ] **Step 7: Run BTC baseline-window public backtest**

Run:

```powershell
npm.cmd run backtest:positionguard -- --asset BTC --start 2026-01-01T00:00:00Z --end 2026-07-07T00:00:00Z --initial-cash-krw 1000000 --label BTC-2026-H1-defensive-exposure --page-limit 35
```

Expected acceptance checks against the recorded baseline:

- `skipped_orders: 0`
- `skipped_order_reasons: BELOW_MINIMUM_TRADE_VALUE=0 INSUFFICIENT_CASH=0 NO_POSITION=0`
- `max_drawdown_pct` is less than or equal to `6.0125`
- `total_return_pct` is not lower than `0.4328`
- `turnover_krw` is not above `32905076.158920` unless `max_drawdown_pct` improves by at least `0.50`
- combined negative contribution from `RANGE`, `WEAK_DOWNTREND`, and `BREAKDOWN_RISK` is greater than `-49.5325`, or ETH improves while BTC stays greater than or equal to `-50.5325`

- [ ] **Step 8: Run ETH baseline-window public backtest**

Run:

```powershell
npm.cmd run backtest:positionguard -- --asset ETH --start 2026-01-01T00:00:00Z --end 2026-07-07T00:00:00Z --initial-cash-krw 1000000 --label ETH-2026-H1-defensive-exposure --page-limit 35
```

Expected acceptance checks against the recorded baseline:

- `skipped_orders: 0`
- `skipped_order_reasons: BELOW_MINIMUM_TRADE_VALUE=0 INSUFFICIENT_CASH=0 NO_POSITION=0`
- `max_drawdown_pct` is less than or equal to `9.2223`
- `total_return_pct` is not lower than `-0.3543`
- `turnover_krw` is not above `27766416.031039` unless `max_drawdown_pct` improves by at least `0.50`
- combined negative contribution from `RANGE`, `WEAK_DOWNTREND`, and `BREAKDOWN_RISK` is greater than `-59.9124`, or BTC improves while ETH stays greater than or equal to `-60.9124`

- [ ] **Step 9: Decide whether the backtest gate passes**

Use this gate:

```text
PASS if:
- BTC and ETH skipped_orders remain 0.
- BTC and ETH max_drawdown_pct do not increase.
- Total return deterioration is within 0.30 percentage points for both assets.
- Combined negative contribution from RANGE + WEAK_DOWNTREND + BREAKDOWN_RISK improves for at least one asset by more than 0.00 percentage points and the other asset worsens by no more than 1.00 percentage point.
- Turnover stays within the 15% turnover cap for each asset, unless that asset's max drawdown improves by at least 0.50 percentage points.

REJECT if:
- Either asset produces skipped_orders > 0.
- Either asset increases max_drawdown_pct.
- Either asset loses more than 0.30 percentage points of total_return_pct.
- Turnover exceeds the 15% turnover cap for an asset while that asset's max drawdown improves by less than 0.50 percentage points.
```

- [ ] **Step 10: Commit documentation and verification-ready changes**

If the gate passes, run:

```powershell
git add ARCHITECTURE.md RISK_POLICY.md ORDER_LIFECYCLE.md README.md
git commit -m "Document PositionGuard defensive exposure policy"
```

If the gate fails, do not commit the documentation update as final behavior. Revert only your own Task 2 and Task 3 changes, or adjust the pure strategy implementation with new tests that explain the revised gate.

- [ ] **Step 11: Push accepted commits**

Run:

```powershell
git push origin main
```

Expected result:

- The branch updates `origin/main`.

---

## Final Reporting Checklist

After implementation, report:

- Which tasks were completed.
- Whether any subagents were used.
- Exact tests and commands run.
- BTC and ETH backtest summary after the change.
- Whether the acceptance gate passed or failed.
- Commit hashes pushed.
- Any remaining live-use cautions.
