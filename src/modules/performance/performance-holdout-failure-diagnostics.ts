import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";
import type {
  CombinedConservativeCost,
  CombinedConservativeHoldoutAssetStatus,
  CombinedConservativeHoldoutComparison,
  CombinedConservativeMetric,
  CombinedConservativeTiming,
} from "./performance-combined-conservative-holdout.js";

const ASSET_ORDER = ["BTC", "ETH"] as const satisfies readonly SupportedAsset[];
const TIMING_ORDER = ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"] as const satisfies readonly CombinedConservativeTiming[];
const COST_ORDER = ["BASE", "STRESS"] as const satisfies readonly CombinedConservativeCost[];
const ANCHOR_ORDER = ["BASELINE", "NO_ADD"] as const;
const METRIC_ORDER = ["NET_RETURN_PCT", "MAX_DRAWDOWN_PCT", "TURNOVER_KRW", "FEES_KRW"] as const satisfies readonly CombinedConservativeMetric[];
const STATUS_ORDER = ["REJECTED", "INSUFFICIENT", "SUPPORTS_CONTINUED_SHADOW"] as const satisfies readonly CombinedConservativeHoldoutAssetStatus[];
const OUTCOME_ORDER = ["PASS", "FAIL", "UNKNOWN"] as const;

type HoldoutFailureDiagnosticAnchor = (typeof ANCHOR_ORDER)[number];
type HoldoutFailureDiagnosticOutcome = (typeof OUTCOME_ORDER)[number];

export type HoldoutFailureDiagnosticAssetInput = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: CombinedConservativeHoldoutAssetStatus;
  comparisons: readonly CombinedConservativeHoldoutComparison[];
};

export type HoldoutFailureDiagnosticSignal =
  | "RETURN_UNDERPERFORMANCE"
  | "HIGHER_MAX_DRAWDOWN"
  | "HIGHER_TURNOVER"
  | "HIGHER_MODELED_FEES"
  | "RETURN_SHORTFALL_WITHOUT_HIGHER_TURNOVER_OR_MODELED_FEES"
  | "RETURN_SHORTFALL_WITH_COST_DRAG_ASSOCIATION";

export type HoldoutFailureDiagnosticCell = {
  timing: CombinedConservativeTiming;
  cost: CombinedConservativeCost;
  anchor: HoldoutFailureDiagnosticAnchor;
  comparisons: readonly CombinedConservativeHoldoutComparison[];
  signals: readonly HoldoutFailureDiagnosticSignal[];
};

export type HoldoutFailureDiagnosticAssetResult = {
  asset: SupportedAsset;
  market: SupportedMarket;
  holdoutStatus: CombinedConservativeHoldoutAssetStatus;
  comparisonCount: number;
  passedComparisonCount: number;
  failedComparisonCount: number;
  unknownComparisonCount: number;
  failedByMetric: Record<CombinedConservativeMetric, number>;
  returnFailureTimingModels: readonly CombinedConservativeTiming[];
  returnFailureCostCells: readonly CombinedConservativeCost[];
  returnFailureAnchors: readonly HoldoutFailureDiagnosticAnchor[];
  returnFailureAgainstNoAddAcrossAllCells: boolean;
  returnFailureAcrossAllCells: boolean;
  cells: readonly HoldoutFailureDiagnosticCell[];
};

export type HoldoutFailureDiagnosticsResult = {
  analysisKind: "COMBINED_CONSERVATIVE_AGGREGATE_FAILURE_DIAGNOSTICS";
  readOnly: true;
  causalClaim: false;
  deploymentApproval: false;
  interpretationBoundary: "Aggregate holdout associations are descriptive and do not establish strategy-rule causality.";
  assets: readonly HoldoutFailureDiagnosticAssetResult[];
};

export function diagnoseCombinedConservativeHoldoutFailures(
  inputs: readonly HoldoutFailureDiagnosticAssetInput[],
): HoldoutFailureDiagnosticsResult {
  const validated = validateAssets(inputs);

  return {
    analysisKind: "COMBINED_CONSERVATIVE_AGGREGATE_FAILURE_DIAGNOSTICS",
    readOnly: true,
    causalClaim: false,
    deploymentApproval: false,
    interpretationBoundary: "Aggregate holdout associations are descriptive and do not establish strategy-rule causality.",
    assets: ASSET_ORDER.map((asset) => diagnoseAsset(validated.get(asset)!)),
  };
}

function validateAssets(
  inputs: readonly HoldoutFailureDiagnosticAssetInput[],
): ReadonlyMap<SupportedAsset, HoldoutFailureDiagnosticAssetInput> {
  if (!Array.isArray(inputs)) throw new Error("Holdout failure diagnostic assets must be an array.");

  const validated = new Map<SupportedAsset, HoldoutFailureDiagnosticAssetInput>();
  for (const rawInput of inputs) {
    if (!isRecord(rawInput)) throw new Error("Each holdout failure diagnostic asset must be an object.");
    const input = rawInput as HoldoutFailureDiagnosticAssetInput;
    if (!isSupportedAsset(input.asset)) throw new Error(`Unsupported holdout failure diagnostic asset ${String(input.asset)}.`);
    if (validated.has(input.asset)) throw new Error(`Duplicate holdout failure diagnostic asset ${input.asset}.`);

    const expectedMarket = getMarketForAsset(input.asset);
    if (input.market !== expectedMarket) {
      throw new Error(`Holdout failure diagnostic market ${String(input.market)} does not match asset ${input.asset}.`);
    }
    if (!STATUS_ORDER.includes(input.status)) {
      throw new Error(`Unsupported holdout failure diagnostic status ${String(input.status)} for ${input.asset}.`);
    }
    if (!Array.isArray(input.comparisons)) {
      throw new Error(`Holdout failure diagnostic comparisons for ${input.asset} must be an array.`);
    }

    const comparisons = validateComparisons(input.asset, input.comparisons);
    const hasFailure = comparisons.some((comparison) => comparison.outcome === "FAIL");
    const hasUnknown = comparisons.some((comparison) => comparison.outcome === "UNKNOWN");
    if (hasFailure && input.status !== "REJECTED") {
      throw new Error(
        `${input.asset} comparison FAIL requires status REJECTED; received ${input.status}.`,
      );
    }
    if (!hasFailure && hasUnknown && input.status !== "INSUFFICIENT") {
      throw new Error(
        `${input.asset} comparison UNKNOWN requires status INSUFFICIENT when no comparison FAIL exists; received ${input.status}.`,
      );
    }
    if (!hasFailure && !hasUnknown && input.status === "REJECTED") {
      throw new Error(`${input.asset} status REJECTED requires at least one comparison FAIL.`);
    }

    validated.set(input.asset, {
      asset: input.asset,
      market: expectedMarket,
      status: input.status,
      comparisons,
    });
  }

  for (const asset of ASSET_ORDER) {
    if (!validated.has(asset)) throw new Error(`Missing holdout failure diagnostic asset ${asset}.`);
  }
  if (validated.size !== ASSET_ORDER.length) {
    throw new Error("Holdout failure diagnostics must contain only BTC and ETH assets.");
  }
  return validated;
}

function validateComparisons(
  asset: SupportedAsset,
  comparisons: readonly CombinedConservativeHoldoutComparison[],
): readonly CombinedConservativeHoldoutComparison[] {
  const expectedCount = TIMING_ORDER.length * COST_ORDER.length * ANCHOR_ORDER.length * METRIC_ORDER.length;
  const byKey = new Map<string, CombinedConservativeHoldoutComparison>();
  for (const rawComparison of comparisons) {
    const comparison = validateComparison(asset, rawComparison);
    const key = comparisonKey(comparison.timing, comparison.cost, comparison.anchor, comparison.metric);
    if (byKey.has(key)) throw new Error(`Duplicate comparison ${asset}:${key}.`);
    byKey.set(key, comparison);
  }
  if (comparisons.length !== expectedCount) {
    throw new Error(`${asset} must contain exactly one comparison for each of the ${expectedCount} timing/cost/anchor/metric combinations.`);
  }

  const ordered = TIMING_ORDER.flatMap((timing) => COST_ORDER.flatMap((cost) =>
    ANCHOR_ORDER.flatMap((anchor) => METRIC_ORDER.map((metric) => {
      const key = comparisonKey(timing, cost, anchor, metric);
      const comparison = byKey.get(key);
      if (!comparison) throw new Error(`${asset} must contain exactly one comparison for ${key}.`);
      return comparison;
    })),
  ));
  if (byKey.size !== expectedCount) {
    throw new Error(`${asset} comparisons contain an unsupported timing/cost/anchor/metric combination.`);
  }
  return ordered;
}

function validateComparison(
  asset: SupportedAsset,
  rawComparison: CombinedConservativeHoldoutComparison,
): CombinedConservativeHoldoutComparison {
  if (!isRecord(rawComparison)) throw new Error(`${asset} comparison must be an object.`);
  const comparison = rawComparison as CombinedConservativeHoldoutComparison;
  if (!TIMING_ORDER.includes(comparison.timing)) throw new Error(`${asset} comparison has unsupported timing ${String(comparison.timing)}.`);
  if (!COST_ORDER.includes(comparison.cost)) throw new Error(`${asset} comparison has unsupported cost ${String(comparison.cost)}.`);
  if (!ANCHOR_ORDER.includes(comparison.anchor)) throw new Error(`${asset} comparison has unsupported anchor ${String(comparison.anchor)}.`);
  if (!METRIC_ORDER.includes(comparison.metric)) throw new Error(`${asset} comparison has unsupported metric ${String(comparison.metric)}.`);
  if (!OUTCOME_ORDER.includes(comparison.outcome)) throw new Error(`${asset} comparison has unsupported outcome ${String(comparison.outcome)}.`);

  requireFinite(comparison.candidateValue, `${asset} comparison candidateValue`);
  requireFinite(comparison.anchorValue, `${asset} comparison anchorValue`);
  requireFinite(comparison.delta, `${asset} comparison delta`);
  requireFinite(comparison.tolerance, `${asset} comparison tolerance`);
  if (comparison.tolerance < 0) throw new Error(`${asset} comparison tolerance must be non-negative.`);

  const monetary = comparison.metric === "TURNOVER_KRW" || comparison.metric === "FEES_KRW";
  const expectedValueUnit = monetary ? "KRW" : "RATIO";
  const expectedDeltaUnit = monetary ? "KRW" : "PERCENTAGE_POINTS";
  if (comparison.valueUnit !== expectedValueUnit || comparison.deltaUnit !== expectedDeltaUnit) {
    throw new Error(`${asset} comparison units do not match metric ${comparison.metric}.`);
  }
  if (monetary && (comparison.candidateValue < 0 || comparison.anchorValue < 0)) {
    throw new Error(`${asset} comparison ${comparison.metric} values must be non-negative.`);
  }
  if (
    comparison.metric === "MAX_DRAWDOWN_PCT"
    && (comparison.candidateValue < 0 || comparison.anchorValue < 0)
  ) {
    throw new Error(`${asset} comparison MAX_DRAWDOWN_PCT values must be non-negative.`);
  }

  const ratioMetric = comparison.metric === "NET_RETURN_PCT" || comparison.metric === "MAX_DRAWDOWN_PCT";
  const expectedDelta = normalizeComparisonNumber(
    (comparison.candidateValue - comparison.anchorValue) * (ratioMetric ? 100 : 1),
  );
  if (normalizeComparisonNumber(comparison.delta) !== expectedDelta) {
    throw new Error(
      `${asset} comparison delta must equal normalized (candidateValue - anchorValue) for ${comparison.metric}.`,
    );
  }
  if (comparison.outcome !== "UNKNOWN") {
    const expectedOutcome = comparison.metric === "NET_RETURN_PCT"
      ? expectedDelta >= -comparison.tolerance ? "PASS" : "FAIL"
      : expectedDelta <= comparison.tolerance ? "PASS" : "FAIL";
    if (comparison.outcome !== expectedOutcome) {
      throw new Error(
        `${asset} comparison outcome ${comparison.outcome} contradicts delta and tolerance for ${comparison.metric}; expected ${expectedOutcome}.`,
      );
    }
  }

  return { ...comparison };
}

function diagnoseAsset(input: HoldoutFailureDiagnosticAssetInput): HoldoutFailureDiagnosticAssetResult {
  const comparisons = input.comparisons;
  const cells = TIMING_ORDER.flatMap((timing) => COST_ORDER.flatMap((cost) =>
    ANCHOR_ORDER.map((anchor) => buildCell(comparisons, timing, cost, anchor)),
  ));
  const failed = comparisons.filter((comparison) => comparison.outcome === "FAIL");
  const returnFailures = failed.filter((comparison) => comparison.metric === "NET_RETURN_PCT");

  return {
    asset: input.asset,
    market: input.market,
    holdoutStatus: input.status,
    comparisonCount: comparisons.length,
    passedComparisonCount: countOutcome(comparisons, "PASS"),
    failedComparisonCount: failed.length,
    unknownComparisonCount: countOutcome(comparisons, "UNKNOWN"),
    failedByMetric: {
      NET_RETURN_PCT: countFailures(failed, "NET_RETURN_PCT"),
      MAX_DRAWDOWN_PCT: countFailures(failed, "MAX_DRAWDOWN_PCT"),
      TURNOVER_KRW: countFailures(failed, "TURNOVER_KRW"),
      FEES_KRW: countFailures(failed, "FEES_KRW"),
    },
    returnFailureTimingModels: TIMING_ORDER.filter((timing) => returnFailures.some((item) => item.timing === timing)),
    returnFailureCostCells: COST_ORDER.filter((cost) => returnFailures.some((item) => item.cost === cost)),
    returnFailureAnchors: ANCHOR_ORDER.filter((anchor) => returnFailures.some((item) => item.anchor === anchor)),
    returnFailureAgainstNoAddAcrossAllCells: TIMING_ORDER.every((timing) =>
      COST_ORDER.every((cost) => outcomeFor(comparisons, timing, cost, "NO_ADD", "NET_RETURN_PCT") === "FAIL")),
    returnFailureAcrossAllCells: TIMING_ORDER.every((timing) =>
      COST_ORDER.every((cost) => ANCHOR_ORDER.every((anchor) =>
        outcomeFor(comparisons, timing, cost, anchor, "NET_RETURN_PCT") === "FAIL"))),
    cells,
  };
}

function buildCell(
  comparisons: readonly CombinedConservativeHoldoutComparison[],
  timing: CombinedConservativeTiming,
  cost: CombinedConservativeCost,
  anchor: HoldoutFailureDiagnosticAnchor,
): HoldoutFailureDiagnosticCell {
  const cellComparisons = METRIC_ORDER.map((metric) => {
    const comparison = comparisons.find((item) =>
      item.timing === timing && item.cost === cost && item.anchor === anchor && item.metric === metric);
    if (!comparison) throw new Error(`Validated comparison missing for ${timing}:${cost}:${anchor}:${metric}.`);
    return comparison;
  });
  const fails = (metric: CombinedConservativeMetric): boolean =>
    cellComparisons.some((comparison) => comparison.metric === metric && comparison.outcome === "FAIL");
  const returnFails = fails("NET_RETURN_PCT");
  const turnoverFails = fails("TURNOVER_KRW");
  const feeFails = fails("FEES_KRW");
  const turnoverPasses = outcomeFor(cellComparisons, timing, cost, anchor, "TURNOVER_KRW") === "PASS";
  const feePasses = outcomeFor(cellComparisons, timing, cost, anchor, "FEES_KRW") === "PASS";
  const signals: HoldoutFailureDiagnosticSignal[] = [
    ...(returnFails ? ["RETURN_UNDERPERFORMANCE" as const] : []),
    ...(fails("MAX_DRAWDOWN_PCT") ? ["HIGHER_MAX_DRAWDOWN" as const] : []),
    ...(turnoverFails ? ["HIGHER_TURNOVER" as const] : []),
    ...(feeFails ? ["HIGHER_MODELED_FEES" as const] : []),
    ...(returnFails && turnoverPasses && feePasses
      ? ["RETURN_SHORTFALL_WITHOUT_HIGHER_TURNOVER_OR_MODELED_FEES" as const]
      : []),
    ...(returnFails && (turnoverFails || feeFails)
      ? ["RETURN_SHORTFALL_WITH_COST_DRAG_ASSOCIATION" as const]
      : []),
  ];
  return { timing, cost, anchor, comparisons: cellComparisons, signals };
}

function outcomeFor(
  comparisons: readonly CombinedConservativeHoldoutComparison[],
  timing: CombinedConservativeTiming,
  cost: CombinedConservativeCost,
  anchor: HoldoutFailureDiagnosticAnchor,
  metric: CombinedConservativeMetric,
): HoldoutFailureDiagnosticOutcome {
  const comparison = comparisons.find((item) =>
    item.timing === timing && item.cost === cost && item.anchor === anchor && item.metric === metric);
  if (!comparison) throw new Error(`Validated comparison missing for ${timing}:${cost}:${anchor}:${metric}.`);
  return comparison.outcome;
}

function countOutcome(
  comparisons: readonly CombinedConservativeHoldoutComparison[],
  outcome: HoldoutFailureDiagnosticOutcome,
): number {
  return comparisons.filter((comparison) => comparison.outcome === outcome).length;
}

function countFailures(
  failed: readonly CombinedConservativeHoldoutComparison[],
  metric: CombinedConservativeMetric,
): number {
  return failed.filter((comparison) => comparison.metric === metric).length;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new Error(`${label} must be finite, JSON-safe, and not negative zero.`);
  }
}

function normalizeComparisonNumber(value: number): number {
  const normalized = Number(value.toFixed(12));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function comparisonKey(
  timing: CombinedConservativeTiming,
  cost: CombinedConservativeCost,
  anchor: HoldoutFailureDiagnosticAnchor,
  metric: CombinedConservativeMetric,
): string {
  return `${timing}:${cost}:${anchor}:${metric}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedAsset(value: unknown): value is SupportedAsset {
  return typeof value === "string" && ASSET_ORDER.includes(value as SupportedAsset);
}
