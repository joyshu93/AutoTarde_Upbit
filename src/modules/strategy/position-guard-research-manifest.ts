export const FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER = [
  "HTF_TREND_GATE",
  "STRICT_PULLBACK",
  "EARLY_THESIS_FAILURE",
  "ADD_LIMITED",
  "COOLDOWN_CONTROL",
  "COMBINED_CONSERVATIVE",
] as const;

export type FrozenBroadLossCauseScenario =
  typeof FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER[number];

export const FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER = [
  "COMBINED_MINUS_HTF_TREND_GATE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_ADD_LIMITED",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;

export type FrozenCombinedConservativeAblationScenario =
  typeof FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER[number];

export const BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY = deepFreeze({
  id: "BROAD_LOSS_CAUSE_V1",
  developmentRange: {
    from: "2025-01-01T00:00:00Z",
    to: "2026-04-12T19:00:00Z",
  },
  validationWindows: [
    { id: "W1", from: "2025-07-20T00:00:00Z", to: "2025-10-25T19:00:00Z" },
    { id: "W2", from: "2025-10-26T00:00:00Z", to: "2025-12-31T19:00:00Z" },
    { id: "W3", from: "2026-01-01T00:00:00Z", to: "2026-04-12T19:00:00Z" },
  ],
  costCells: [
    { id: "BASE", role: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
    { id: "STRESS", role: "STRESS", feeRate: 0.001, slippageRate: 0.002 },
  ],
  executionTimingModels: ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"],
  anchors: ["BASELINE", "NO_ADD"],
  scenarioOrder: FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER,
  evaluationThresholds: {
    minimumFullPathCompletedEpisodes: 30,
    minimumWindowPolicyExposedCompletedEpisodes: 10,
    minimumImprovedWindowCount: 2,
  },
  policy: {
    quantityTolerance: 1e-12,
    scenarios: {
      HTF_TREND_GATE: {
        minimumTrendAlignmentScore: 3,
        allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND", "EARLY_RECOVERY"],
      },
      STRICT_PULLBACK: {
        requiredEntryPath: "PULLBACK",
        requiredRegime: "PULLBACK_IN_UPTREND",
        minimumTrendAlignmentScore: 4,
        minimumRecoveryQualityScore: 3,
        allowedOneHourLocations: ["LOWER", "MIDDLE"],
      },
      EARLY_THESIS_FAILURE: {
        maximumFailedReclaimRecoveryQualityScore: 1,
        minimumBearishBreakdownPressureScore: 2,
      },
      ADD_LIMITED: {
        maxAddsPerEpisode: 1,
        minimumTrendAlignmentScore: 4,
        minimumRecoveryQualityScore: 3,
        allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND"],
      },
      COOLDOWN_CONTROL: {
        nonPositiveExitHours: 12,
        sameEntryPathHours: 24,
      },
      COMBINED_CONSERVATIVE: {
        components: ["HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "ADD_LIMITED", "COOLDOWN_CONTROL"],
        precedence: [
          "PRESERVE_RISK_REDUCTION",
          "EARLY_THESIS_FAILURE",
          "COOLDOWN_CONTROL",
          "HTF_TREND_GATE",
          "ADD_LIMITED",
        ],
      },
    },
  },
} as const);

export const COMBINED_CONSERVATIVE_COMPONENTS =
  BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy.scenarios.COMBINED_CONSERVATIVE.components;

export type CombinedConservativeComponent =
  typeof COMBINED_CONSERVATIVE_COMPONENTS[number];

export const COMBINED_CONSERVATIVE_ABLATION_RESEARCH_AUTHORITY = deepFreeze({
  id: "COMBINED_CONSERVATIVE_ABLATION_V1",
  components: COMBINED_CONSERVATIVE_COMPONENTS,
  precedence: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy.scenarios.COMBINED_CONSERVATIVE.precedence,
  scenarioOrder: FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER,
  scenarios: {
    COMBINED_MINUS_HTF_TREND_GATE: {
      inactiveComponent: "HTF_TREND_GATE",
      activeComponents: ["EARLY_THESIS_FAILURE", "ADD_LIMITED", "COOLDOWN_CONTROL"],
    },
    COMBINED_MINUS_EARLY_THESIS_FAILURE: {
      inactiveComponent: "EARLY_THESIS_FAILURE",
      activeComponents: ["HTF_TREND_GATE", "ADD_LIMITED", "COOLDOWN_CONTROL"],
    },
    COMBINED_MINUS_ADD_LIMITED: {
      inactiveComponent: "ADD_LIMITED",
      activeComponents: ["HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "COOLDOWN_CONTROL"],
    },
    COMBINED_MINUS_COOLDOWN_CONTROL: {
      inactiveComponent: "COOLDOWN_CONTROL",
      activeComponents: ["HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "ADD_LIMITED"],
    },
  },
} as const);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
