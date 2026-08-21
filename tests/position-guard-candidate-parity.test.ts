import assert from "node:assert/strict";

import type {
  PositionGuardBacktestFrame,
  PositionGuardBacktestResearchState,
  PositionGuardBacktestState,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  evaluatePositionGuardResearchIntervention,
  runPositionGuardBacktest,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  evaluatePositionGuardCandidate,
  POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS,
} from "../src/modules/strategy/position-guard-candidate-policy.js";
import {
  parsePositionGuardCandidateTimestamp,
  POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE,
  projectPositionGuardCandidateState,
  type PositionGuardCandidateExecutionEvidence,
  type PositionGuardCandidateState,
} from "../src/modules/strategy/position-guard-candidate-state.js";
import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

const OBSERVATION_WINDOW_START = "2026-08-23T08:00:00.000Z";
const OBSERVATION_WINDOW_START_NANOSECONDS = parsePositionGuardCandidateTimestamp(
  OBSERVATION_WINDOW_START,
  "observation window start",
);
const FROZEN_REGISTERED_CANDIDATE_POLICY_IDS = [
  "COMBINED_CONSERVATIVE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;

type GoldenFixture = Readonly<{
  name: string;
  generatedAt: string;
  decision: PositionGuardEngineDecision;
  positionQuantity: number;
  averageEntryPrice: number;
  candidateState: PositionGuardCandidateState;
  analysis: PositionGuardStructureAnalysis;
}>;

const GOLDEN_FIXTURES: readonly GoldenFixture[] = [
  fixture("preserves exit before all overlays", { decision: decision({ action: "EXIT", targetQuantityFraction: 1 }), positionQuantity: 0.01, averageEntryPrice: 100, analysis: analysis({ failedReclaim: true, weakeningStage: "FAILURE", recoveryQualityScore: 0, breakdown1d: true }) }),
  fixture("preserves reduce before all overlays", { decision: decision({ action: "REDUCE", targetQuantityFraction: 0.5 }), positionQuantity: 0.01, averageEntryPrice: 100, analysis: analysis({ breakdownPressureScore: 2, bearishMomentumExpansion: true, pnlPct: -0.1, atrShock: true }) }),
  fixture("exits an early failed reclaim", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 100, analysis: analysis({ failedReclaim: true, weakeningStage: "CLEAR", recoveryQualityScore: 1, currentPrice: 101 }) }),
  fixture("exits a bearish loss", { decision: decision({ action: "HOLD" }), positionQuantity: 0.01, averageEntryPrice: 100, analysis: analysis({ breakdownPressureScore: 2, bearishMomentumExpansion: true, pnlPct: -0.05 }) }),
  fixture("suppresses non-positive exit cooldown before htf", { generatedAt: "2026-08-20T01:00:00.000000001Z", candidateState: candidateState({ lastFullExitAt: "2026-08-20T00:00:00Z", lastFullExitRealizedPnlKrw: 0 }), analysis: analysis({ trendAlignmentScore: 0 }) }),
  fixture("suppresses same entry path cooldown", { generatedAt: "2026-08-20T23:59:59.999999999Z", candidateState: candidateState({ lastFullExitAt: "2026-08-20T00:00:00Z", lastFullExitRealizedPnlKrw: 1, lastEntryPath: "PULLBACK" }) }),
  fixture("suppresses non-positive cooldown one nanosecond before twelve-hour release", { generatedAt: "2026-08-20T11:59:59.999999999Z", candidateState: candidateState({ lastFullExitAt: "2026-08-20T00:00:00Z", lastFullExitRealizedPnlKrw: 0, lastEntryPath: "RECLAIM" }) }),
  fixture("releases non-positive cooldown at exactly twelve hours", { generatedAt: "2026-08-20T12:00:00.000000000Z", candidateState: candidateState({ lastFullExitAt: "2026-08-20T00:00:00Z", lastFullExitRealizedPnlKrw: 0, lastEntryPath: "RECLAIM" }) }),
  fixture("releases same-path cooldown at exactly twenty-four hours", { generatedAt: "2026-08-21T00:00:00.000000000Z", candidateState: candidateState({ lastFullExitAt: "2026-08-20T00:00:00Z", lastFullExitRealizedPnlKrw: 1, lastEntryPath: "PULLBACK" }) }),
  fixture("suppresses enter for htf breakdown", { analysis: analysis({ breakdown1d: true }) }),
  fixture("suppresses enter for low htf trend alignment", { analysis: analysis({ trendAlignmentScore: 2 }) }),
  fixture("suppresses enter for htf weakening", { analysis: analysis({ weakeningStage: "SOFT" }) }),
  fixture("suppresses enter for non-entry htf regime", { analysis: analysis({ regime: "RECLAIM_ATTEMPT" }) }),
  fixture("suppresses add at a loss", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 100, analysis: analysis({ currentPrice: 99 }) }),
  fixture("suppresses carry-in add count", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, candidateState: candidateState({ currentEpisodeAddCount: 1 }) }),
  fixture("suppresses add for atr shock", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, analysis: analysis({ atrShock: true }) }),
  fixture("suppresses add for weakening", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, analysis: analysis({ weakeningStage: "SOFT" }) }),
  fixture("suppresses add for low trend alignment", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, analysis: analysis({ trendAlignmentScore: 3 }) }),
  fixture("suppresses add for low recovery quality", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, analysis: analysis({ recoveryQualityScore: 2 }) }),
  fixture("suppresses add for non-core regime", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, analysis: analysis({ regime: "EARLY_RECOVERY" }) }),
  fixture("allows enter when every enter-only control passes"),
  fixture("allows add when every add-only control passes", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99 }),
  fixture("does not apply htf controls to add", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, analysis: analysis({ breakdown1d: true }) }),
  fixture("does not apply add controls to enter", { analysis: analysis({ atrShock: true }) }),
  fixture("evaluates cooldown ordering only for enter", { generatedAt: "2026-08-20T00:00:00Z", decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 99, candidateState: candidateState({ lastFullExitAt: "2026-08-20T01:00:00Z", lastFullExitRealizedPnlKrw: -1 }) }),
  fixture("early failure wins an add collision", { decision: decision({ action: "ADD" }), positionQuantity: 0.01, averageEntryPrice: 100, candidateState: candidateState({ currentEpisodeAddCount: 1 }), analysis: analysis({ failedReclaim: true, weakeningStage: "CLEAR", recoveryQualityScore: 0, atrShock: true, currentPrice: 101 }) }),
];

test("candidate golden fixtures are synthetic and predate the observation window", () => {
  for (const fixtureCase of GOLDEN_FIXTURES) {
    for (const timestamp of fixtureTimestamps(fixtureCase)) {
      assert.ok(
        parsePositionGuardCandidateTimestamp(timestamp, `fixture ${fixtureCase.name}`) < OBSERVATION_WINDOW_START_NANOSECONDS,
        `${fixtureCase.name} uses a fixture timestamp at or after ${OBSERVATION_WINDOW_START}: ${timestamp}`,
      );
    }
  }
});

test("candidate matches frozen research intervention for every registered policy and golden branch", () => {
  assert.deepEqual(POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS, FROZEN_REGISTERED_CANDIDATE_POLICY_IDS);

  for (const policyId of FROZEN_REGISTERED_CANDIDATE_POLICY_IDS) {
    for (const fixtureCase of GOLDEN_FIXTURES) {
      const research = evaluatePositionGuardResearchIntervention({
        policyId,
        generatedAt: fixtureCase.generatedAt,
        decision: fixtureCase.decision,
        state: backtestState(fixtureCase),
        researchState: fixtureCase.candidateState,
        analysis: fixtureCase.analysis,
      });
      const candidate = evaluatePositionGuardCandidate({
        policyId,
        generatedAt: fixtureCase.generatedAt,
        decision: fixtureCase.decision,
        positionQuantity: fixtureCase.positionQuantity,
        averageEntryPrice: fixtureCase.averageEntryPrice,
        candidateState: fixtureCase.candidateState,
        analysis: fixtureCase.analysis,
      });

      const label = `${policyId}: ${fixtureCase.name}`;
      assert.equal(candidate.policyId, policyId, label);
      assert.equal(candidate.originalAction, fixtureCase.decision.action, label);
      assert.equal(candidate.effectiveAction, research?.effectiveAction ?? fixtureCase.decision.action, label);
      assert.equal(candidate.outcome, research?.outcome ?? "ALLOW", label);
      assert.equal(candidate.reason, research?.reason ?? "NO_INTERVENTION", label);
      assert.equal(candidate.precedence, frozenPrecedence(research?.reason ?? "NO_INTERVENTION", fixtureCase.decision.action), label);
    }
  }
});

test("candidate state projection matches frozen pre-window execution state through closure and cooldown", () => {
  const entryAnalysis = {
    regime: "EARLY_RECOVERY",
    currentPrice: 100_000,
    entryPath: "RECLAIM",
    reclaimStructure: true,
    trendAlignmentScore: 4,
    recoveryQualityScore: 4,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
  } satisfies Partial<PositionGuardStructureAnalysis>;
  const weakAnalysis = {
    regime: "WEAK_DOWNTREND",
    currentPrice: 80_000,
    weakeningStage: "CLEAR",
    failedReclaim: true,
    bearishMomentumExpansion: true,
  } satisfies Partial<PositionGuardStructureAnalysis>;
  const frames: readonly PositionGuardBacktestFrame[] = [
    transitionFrame("2026-04-20T01:00:00.000000001Z", entryAnalysis),
    transitionFrame("2026-04-20T02:00:00.000000002Z", {
      ...entryAnalysis,
      regime: "BULL_TREND",
      currentPrice: 100_001,
    }),
    transitionFrame("2026-04-20T03:00:00.000000003Z", weakAnalysis),
    transitionFrame("2026-04-20T04:00:00.000000004Z", {
      ...weakAnalysis,
      currentPrice: 90_000,
    }),
    transitionFrame("2026-04-20T05:00:00.000000005Z", {
      currentPrice: 110_000,
      invalidationState: "BROKEN",
      breakdown1d: true,
      breakdown4h: true,
      bearishMomentumExpansion: true,
    }),
    transitionFrame("2026-04-20T06:00:00.000000006Z", entryAnalysis),
  ];
  for (const frame of frames) {
    assert.ok(
      parsePositionGuardCandidateTimestamp(frame.generatedAt, "state parity fixture") <
        OBSERVATION_WINDOW_START_NANOSECONDS,
      `state parity fixture must predate ${OBSERVATION_WINDOW_START}`,
    );
  }

  const frozen = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 1_000_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    execution: {
      feeRate: 0.0005,
      slippageRate: 0.00000123,
      minimumTradeValueKrw: 5_000,
    },
    researchExecutionPolicy: { id: "COMBINED_CONSERVATIVE" },
    frames,
  });
  assert.deepEqual(
    frozen.frames.map((frame) => frame.decision.action),
    ["ENTER", "ADD", "REDUCE", "REDUCE", "EXIT", "ENTER"],
  );
  assert.equal(frozen.frames[5]?.researchIntervention?.reason, "NON_POSITIVE_EXIT_12H_COOLDOWN");

  const authorityStates = [1, 2, 3, 4, 5].map((frameIndex) => {
    const state = frozen.frames[frameIndex]?.researchIntervention?.evidence.researchState;
    assert.ok(state, `frozen frame ${frameIndex} must expose pre-decision research state`);
    return state;
  });
  const normalizedEvidence: PositionGuardCandidateExecutionEvidence[] = frozen.frames
    .slice(0, 5)
    .map((frame, index) => {
      const trade = frame.trade;
      assert.ok(trade, `frozen transition ${index} must execute`);
      return {
        evidenceId: `transition-${String(index + 1).padStart(3, "0")}`,
        executedAt: frame.generatedAt,
        // Frozen replay models partial risk reduction as REDUCE; normalize the second one as EXIT to test non-closure.
        action: index === 3 ? "EXIT" : trade.action,
        entryPath: frames[index]!.analysis.entryPath,
        terminalStatus: "FILLED",
        executedQuantity: trade.quantity,
        grossQuoteValueKrw: trade.grossNotionalKrw,
        confirmedFeeKrw: trade.feeKrw,
        remainingQuantity: index === 4
          ? POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE
          : frame.endingState.quantity,
      };
    });
  assert.deepEqual(
    normalizedEvidence.map((item) => item.action),
    ["ENTER", "ADD", "REDUCE", "EXIT", "EXIT"],
  );
  assert.ok(normalizedEvidence[3]!.remainingQuantity > POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE);
  assert.equal(normalizedEvidence[4]!.remainingQuantity, POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE);

  let projected: Readonly<PositionGuardCandidateState> = candidateState();
  for (const [index, item] of normalizedEvidence.entries()) {
    projected = projectPositionGuardCandidateState({
      initialState: projected,
      evidence: [item],
    });
    assert.equal(
      projected.currentEpisodeAddCount,
      authorityStates[index]?.currentEpisodeAddCount,
      `frozen state parity after ${item.action} ${item.evidenceId}`,
    );
    assert.equal(
      projected.lastEntryPath,
      authorityStates[index]?.lastEntryPath,
      `frozen state parity after ${item.action} ${item.evidenceId}`,
    );
    assert.deepEqual(candidateCursor(projected), {
      lastEvidenceAt: item.executedAt,
      lastEvidenceId: item.evidenceId,
    });
  }

  assert.equal(projected.currentEpisodeInventoryQuantity, 0);
  assert.equal(projected.currentEpisodeCostBasisKrw, 0);
  assert.equal(projected.currentEpisodeRealizedPnlKrw, 0);
  assert.ok((projected.lastFullExitRealizedPnlKrw ?? 0) < 0);
  assert.ok((frozen.finalResearchState?.lastFullExitRealizedPnlKrw ?? 0) < 0);

  const frozenCooldown = frozen.frames[5]!.researchIntervention;
  assert.ok(frozenCooldown);
  const candidateCooldown = evaluatePositionGuardCandidate({
    policyId: "COMBINED_CONSERVATIVE",
    generatedAt: frames[5]!.generatedAt,
    decision: frozen.frames[5]!.decision,
    positionQuantity: frozen.frames[5]!.startingState.quantity,
    averageEntryPrice: frozen.frames[5]!.startingState.averageEntryPrice,
    candidateState: projected,
    analysis: frames[5]!.analysis,
  });
  assert.deepEqual(
    [candidateCooldown.outcome, candidateCooldown.effectiveAction, candidateCooldown.reason],
    [frozenCooldown.outcome, frozenCooldown.effectiveAction, frozenCooldown.reason],
  );
});

function fixture(
  name: string,
  overrides: Partial<Omit<GoldenFixture, "name">> = {},
): GoldenFixture {
  return {
    name,
    generatedAt: "2026-08-20T12:00:00.000000000Z",
    decision: decision({ action: "ENTER" }),
    positionQuantity: 0,
    averageEntryPrice: 0,
    candidateState: candidateState(),
    analysis: analysis(),
    ...overrides,
  };
}

function frozenPrecedence(reason: string, originalAction: PositionGuardEngineDecision["action"]): string {
  if (reason === "RISK_REDUCING_DECISION_PRESERVED") return "PRESERVE_RISK_REDUCTION";
  if (reason === "FAILED_RECLAIM_THESIS" || reason === "BEARISH_LOSS_THESIS") return "EARLY_THESIS_FAILURE";
  if (reason === "NON_POSITIVE_EXIT_12H_COOLDOWN" || reason === "SAME_ENTRY_PATH_24H_COOLDOWN") return "COOLDOWN_CONTROL";
  if (["HTF_BREAKDOWN", "TREND_ALIGNMENT_BELOW_3", "WEAKENING_PRESENT", "REGIME_NOT_ENTRY_TREND"].includes(reason) && originalAction === "ENTER") {
    return "HTF_TREND_GATE";
  }
  if (reason === "CONDITIONS_MET" || originalAction === "ADD") return "ADD_LIMITED";
  return "NO_INTERVENTION";
}

function fixtureTimestamps(fixtureCase: GoldenFixture): readonly string[] {
  return [
    fixtureCase.generatedAt,
    ...(fixtureCase.candidateState.lastFullExitAt === null
      ? []
      : [fixtureCase.candidateState.lastFullExitAt]),
  ];
}

function backtestState(fixtureCase: GoldenFixture): PositionGuardBacktestState {
  return {
    cashKrw: 1_000_000,
    quantity: fixtureCase.positionQuantity,
    averageEntryPrice: fixtureCase.averageEntryPrice,
  };
}

function decision(overrides: Partial<PositionGuardEngineDecision> = {}): PositionGuardEngineDecision {
  return {
    action: "ENTER",
    summary: "Synthetic baseline decision.",
    reasons: ["Synthetic baseline reason."],
    targetNotionalKrw: 10_000,
    targetQuantityFraction: null,
    referencePrice: 100,
    executionDisposition: "IMMEDIATE",
    signalQuality: { score: 8, bucket: "HIGH", confirmationRequired: false, confirmationSatisfied: true, reentryPenaltyApplied: false },
    exposureGuardrails: { perAssetMaxAllocation: 0.45, totalPortfolioMaxExposure: 0.75, remainingAssetCapacity: 100_000, remainingPortfolioCapacity: 100_000 },
    diagnostics: { regime: "BULL_TREND", riskLevel: "LOW", invalidationState: "CLEAR", invalidationLevel: null, entryPath: "PULLBACK", trendAlignmentScore: 4, recoveryQualityScore: 3, breakdownPressureScore: 0, weakeningStage: "NONE", upperRangeChase: false, pullbackZone: true, reclaimStructure: false, breakoutHoldStructure: false },
    ...overrides,
  };
}

function analysis(overrides: Partial<PositionGuardStructureAnalysis> = {}): PositionGuardStructureAnalysis {
  return {
    regime: "BULL_TREND",
    riskLevel: "LOW",
    invalidationState: "CLEAR",
    invalidationLevel: null,
    pullbackZone: true,
    reclaimStructure: false,
    breakoutHoldStructure: false,
    upperRangeChase: false,
    currentPrice: 100,
    entryPath: "PULLBACK",
    trendAlignmentScore: 4,
    recoveryQualityScore: 3,
    breakdownPressureScore: 0,
    weakeningStage: "NONE",
    breakdown1d: false,
    breakdown4h: false,
    failedReclaim: false,
    bearishMomentumExpansion: false,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
    atrShock: false,
    averageEntryPrice: 0,
    pnlPct: 0,
    ...overrides,
  };
}

function candidateState(overrides: Partial<PositionGuardCandidateState> = {}): PositionGuardCandidateState {
  const result: PositionGuardCandidateState = {
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: 0,
    currentEpisodeInventoryQuantity: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
    ...overrides,
  };
  if (result.currentEpisodeAddCount > 0) {
    result.currentEpisodeInventoryQuantity = result.currentEpisodeInventoryQuantity || 0.01;
    result.currentEpisodeCostBasisKrw = result.currentEpisodeCostBasisKrw || 100;
    result.lastEntryPath ??= "PULLBACK";
    result.lastEvidenceAt ??= "2026-01-01T00:00:00Z";
    result.lastEvidenceId ??= "fixture-open-evidence";
  }
  if (result.lastFullExitAt !== null) {
    result.lastEvidenceAt ??= result.lastFullExitAt;
    result.lastEvidenceId ??= "fixture-full-exit";
  }
  result.stateVersion = Math.max(result.stateVersion, minimumReachableStateVersion(result));
  return result;
}

function minimumReachableStateVersion(state: PositionGuardCandidateState): number {
  let minimum = state.lastFullExitAt === null ? 0 : 2;
  if (state.currentEpisodeInventoryQuantity > 1e-12) {
    minimum += 1 + state.currentEpisodeAddCount;
    if (state.currentEpisodeRealizedPnlKrw !== 0) minimum += 1;
  }
  return minimum;
}

function transitionFrame(
  generatedAt: string,
  overrides: Partial<PositionGuardStructureAnalysis>,
): PositionGuardBacktestFrame {
  return {
    generatedAt,
    analysis: analysis({
      invalidationLevel: 95_000,
      currentPrice: 100_000,
      ...overrides,
    }),
  };
}

function semanticCandidateState(
  state: Readonly<PositionGuardCandidateState>,
): PositionGuardBacktestResearchState {
  return {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw,
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw,
    lastEntryPath: state.lastEntryPath,
  };
}

function candidateCursor(state: Readonly<PositionGuardCandidateState>): Readonly<{
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
}> {
  const value = state as PositionGuardCandidateState & {
    lastEvidenceAt: string | null;
    lastEvidenceId: string | null;
  };
  return {
    lastEvidenceAt: value.lastEvidenceAt,
    lastEvidenceId: value.lastEvidenceId,
  };
}
