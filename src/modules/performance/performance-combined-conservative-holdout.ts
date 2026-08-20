import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";

const ASSET_ORDER: readonly SupportedAsset[] = ["BTC", "ETH"];
const TIMING_ORDER = ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"] as const;
const COST_ORDER = ["BASE", "STRESS"] as const;
const SCENARIO_ORDER = ["BASELINE", "NO_ADD", "COMBINED_CONSERVATIVE"] as const;
const METRIC_ORDER = ["NET_RETURN_PCT", "MAX_DRAWDOWN_PCT", "TURNOVER_KRW", "FEES_KRW"] as const;
const COVERAGE_KEYS = [
  "cadenceComplete",
  "independentlyVerifiedNoTrade",
  "lifecycleComplete",
  "feeComplete",
  "finiteMetricsComplete",
  "carryInStateComplete",
] as const;
const NON_FEE_COVERAGE_KEYS = COVERAGE_KEYS.filter((key) => key !== "feeComplete");

export type CombinedConservativeTiming = (typeof TIMING_ORDER)[number];
export type CombinedConservativeCost = (typeof COST_ORDER)[number];
export type CombinedConservativeScenario = (typeof SCENARIO_ORDER)[number];
export type CombinedConservativeMetric = (typeof METRIC_ORDER)[number];

export type CombinedConservativeHoldoutCoverage = {
  cadenceComplete: boolean;
  independentlyVerifiedNoTrade: boolean;
  lifecycleComplete: boolean;
  feeComplete: boolean;
  finiteMetricsComplete: boolean;
  carryInStateComplete: boolean;
};

export type CombinedConservativeHoldoutMatrixCell = {
  asset: SupportedAsset;
  market: SupportedMarket;
  timing: CombinedConservativeTiming;
  cost: CombinedConservativeCost;
  scenario: CombinedConservativeScenario;
  holdoutFrom: string;
  holdoutTo: string;
  datasetChecksum: string;
  noTradeEvidenceChecksum: string;
  datasetFingerprint: string;
  initialStateFingerprint: string;
  developmentFrameFingerprint: string;
  replayFrameFingerprint: string;
  netReturnPct: number;
  maxDrawdownPct: number;
  turnoverKrw: number;
  feesKrw: number;
  completedEpisodeCount: number;
  coverage: CombinedConservativeHoldoutCoverage;
};

export type CombinedConservativeHoldoutInput = {
  authority: {
    version: string;
    frozenAt: string;
    developmentCutoff: string;
  };
  policy: {
    candidate: "COMBINED_CONSERVATIVE";
    minimumCompletedEpisodes: number;
    comparisonTolerancePercentagePoints: number;
    comparisonToleranceKrw: number;
  };
  assets: Array<{
    asset: SupportedAsset;
    market: SupportedMarket;
    authorityVersion: string;
    authorityFrozenAt: string;
    holdout: {
      from: string;
      to: string;
    };
    dataset: {
      asset: SupportedAsset;
      market: SupportedMarket;
      collectedAt: string;
      endAt: string;
      checksum: string;
      fingerprint: string;
      holdoutFrom: string;
      holdoutTo: string;
      noTradeEvidenceChecksum: string;
      initialStateFingerprint: string;
      developmentFrameFingerprint: string;
      replayFrameFingerprint: string;
    };
    matrix: CombinedConservativeHoldoutMatrixCell[];
  }>;
};

export type CombinedConservativeHoldoutComparison = {
  timing: CombinedConservativeTiming;
  cost: CombinedConservativeCost;
  anchor: "BASELINE" | "NO_ADD";
  metric: CombinedConservativeMetric;
  candidateValue: number;
  anchorValue: number;
  delta: number;
  tolerance: number;
  valueUnit: "RATIO" | "KRW";
  deltaUnit: "PERCENTAGE_POINTS" | "KRW";
  outcome: "PASS" | "FAIL" | "UNKNOWN";
};

export type CombinedConservativeHoldoutAssetStatus =
  | "REJECTED"
  | "INSUFFICIENT"
  | "SUPPORTS_CONTINUED_SHADOW";

export type CombinedConservativeHoldoutResult = {
  analysisKind: "COMBINED_CONSERVATIVE_HOLDOUT";
  candidate: "COMBINED_CONSERVATIVE";
  readOnly: true;
  deploymentApproval: false;
  interpretationBoundary: "Research holdout evidence only; not deployment approval.";
  authority: {
    version: string;
    frozenAt: string;
    developmentCutoff: string;
  };
  phase: "PROSPECTIVE_SHADOW" | "RETROSPECTIVE_HOLDOUT";
  assets: readonly CombinedConservativeHoldoutAssetResult[];
};

export type CombinedConservativeHoldoutAssetResult = {
  asset: SupportedAsset;
  market: SupportedMarket;
  holdout: {
    from: string;
    to: string;
  };
  dataset: {
    collectedAt: string;
    endAt: string;
    checksum: string;
    fingerprint: string;
    holdoutFrom: string;
    holdoutTo: string;
    noTradeEvidenceChecksum: string;
    initialStateFingerprint: string;
    developmentFrameFingerprint: string;
    replayFrameFingerprint: string;
  };
  matrix: readonly CombinedConservativeHoldoutMatrixCell[];
  evidenceComplete: boolean;
  candidateCompletedEpisodeCountComplete: boolean;
  anchorCompletedEpisodeCountComplete: boolean;
  status: CombinedConservativeHoldoutAssetStatus;
  reasonCodes: readonly CombinedConservativeHoldoutReasonCode[];
  comparisons: readonly CombinedConservativeHoldoutComparison[];
};

export type CombinedConservativeHoldoutReasonCode =
  | "KNOWN_DIRECTIONAL_FAILURE"
  | "INCOMPLETE_COVERAGE"
  | "CANDIDATE_COMPLETED_EPISODES_BELOW_MINIMUM"
  | "ANCHOR_COMPLETED_EPISODES_BELOW_MINIMUM";

type ParsedTimestamp = {
  epochMs: number;
  normalized: string;
};

type ValidatedAsset = {
  asset: SupportedAsset;
  market: SupportedMarket;
  holdout: {
    from: ParsedTimestamp;
    to: ParsedTimestamp;
  };
  dataset: {
    collectedAt: ParsedTimestamp;
    endAt: ParsedTimestamp;
    checksum: string;
    fingerprint: string;
    holdoutFrom: ParsedTimestamp;
    holdoutTo: ParsedTimestamp;
    noTradeEvidenceChecksum: string;
    initialStateFingerprint: string;
    developmentFrameFingerprint: string;
    replayFrameFingerprint: string;
  };
  matrix: readonly CombinedConservativeHoldoutMatrixCell[];
};

export function evaluateCombinedConservativeHoldout(
  input: CombinedConservativeHoldoutInput,
): CombinedConservativeHoldoutResult {
  const authority = validateAuthority(input.authority);
  validatePolicy(input.policy);
  const assets = validateAssets(input.assets, input.authority.version, authority.frozenAt, authority.developmentCutoff);

  const evaluatedAssets = ASSET_ORDER.map((asset) => evaluateAsset(asset, assets.get(asset)!, input.policy));
  const phase = evaluatedAssets.every((asset) => asset.holdout.from >= authority.frozenAt.normalized)
    ? "PROSPECTIVE_SHADOW"
    : "RETROSPECTIVE_HOLDOUT";

  return {
    analysisKind: "COMBINED_CONSERVATIVE_HOLDOUT",
    candidate: "COMBINED_CONSERVATIVE",
    readOnly: true,
    deploymentApproval: false,
    interpretationBoundary: "Research holdout evidence only; not deployment approval.",
    authority: {
      version: input.authority.version,
      frozenAt: authority.frozenAt.normalized,
      developmentCutoff: authority.developmentCutoff.normalized,
    },
    phase,
    assets: evaluatedAssets,
  };
}

function validateAuthority(authority: CombinedConservativeHoldoutInput["authority"]): {
  frozenAt: ParsedTimestamp;
  developmentCutoff: ParsedTimestamp;
} {
  if (authority.version.trim().length === 0) throw new Error("Authority version must be non-blank.");
  const frozenAt = parseIsoTimestamp(authority.frozenAt, "authority frozenAt");
  const developmentCutoff = parseIsoTimestamp(authority.developmentCutoff, "development cutoff");
  if (frozenAt.epochMs < developmentCutoff.epochMs) {
    throw new Error("Authority frozenAt must be at or after development cutoff.");
  }
  return { frozenAt, developmentCutoff };
}

function validatePolicy(policy: CombinedConservativeHoldoutInput["policy"]): void {
  if (policy.candidate !== "COMBINED_CONSERVATIVE") {
    throw new Error("Holdout policy candidate must be COMBINED_CONSERVATIVE.");
  }
  if (policy.minimumCompletedEpisodes !== 10) {
    throw new Error("Holdout policy minimumCompletedEpisodes must be exactly 10.");
  }
  if (policy.comparisonTolerancePercentagePoints !== 0.000001) {
    throw new Error("Holdout policy comparisonTolerancePercentagePoints must be exactly 0.000001.");
  }
  if (policy.comparisonToleranceKrw !== 0.000000001) {
    throw new Error("Holdout policy comparisonToleranceKrw must be exactly 0.000000001.");
  }
}

function validateAssets(
  inputs: readonly CombinedConservativeHoldoutInput["assets"][number][],
  authorityVersion: string,
  authorityFrozenAt: ParsedTimestamp,
  developmentCutoff: ParsedTimestamp,
): ReadonlyMap<SupportedAsset, ValidatedAsset> {
  const assets = new Map<SupportedAsset, ValidatedAsset>();
  for (const input of inputs) {
    if (!isSupportedAsset(input.asset)) throw new Error(`Unsupported holdout asset ${String(input.asset)}.`);
    if (assets.has(input.asset)) throw new Error(`Duplicate holdout asset ${input.asset}.`);
    const expectedMarket = getMarketForAsset(input.asset);
    if (input.market !== expectedMarket) {
      throw new Error(`Holdout market ${input.market} does not match asset ${input.asset}.`);
    }
    if (input.authorityVersion !== authorityVersion) {
      throw new Error(`Holdout authority version for ${input.asset} does not match authority version.`);
    }
    const assetFrozenAt = parseIsoTimestamp(input.authorityFrozenAt, `${input.asset} authorityFrozenAt`);
    if (assetFrozenAt.normalized !== authorityFrozenAt.normalized) {
      throw new Error(`Holdout authority frozenAt for ${input.asset} does not match authority frozenAt.`);
    }
    const holdout = {
      from: parseIsoTimestamp(input.holdout.from, `${input.asset} holdout from`),
      to: parseIsoTimestamp(input.holdout.to, `${input.asset} holdout to`),
    };
    if (holdout.from.epochMs >= holdout.to.epochMs) {
      throw new Error(`${input.asset} holdout [from,to) range must have from before to.`);
    }
    if (holdout.from.epochMs < developmentCutoff.epochMs) {
      throw new Error(`${input.asset} holdout [from,to) range overlaps development.`);
    }
    const dataset = validateDataset(input, expectedMarket, holdout);
    if (holdout.to.epochMs > dataset.endAt.epochMs) {
      throw new Error(`${input.asset} holdout to is beyond dataset end.`);
    }
    const matrix = validateMatrix(input, expectedMarket, dataset);
    assets.set(input.asset, { asset: input.asset, market: expectedMarket, holdout, dataset, matrix });
  }
  for (const asset of ASSET_ORDER) {
    if (!assets.has(asset)) throw new Error(`Missing holdout asset ${asset}.`);
  }
  if (assets.size !== ASSET_ORDER.length) throw new Error("Holdout input must contain only BTC and ETH assets.");
  const btc = assets.get("BTC")!;
  const eth = assets.get("ETH")!;
  if (btc.holdout.from.epochMs !== eth.holdout.from.epochMs || btc.holdout.to.epochMs !== eth.holdout.to.epochMs) {
    throw new Error("BTC and ETH must have identical holdout [from,to) ranges.");
  }
  if (btc.holdout.from.epochMs < authorityFrozenAt.epochMs && btc.holdout.from.epochMs !== developmentCutoff.epochMs) {
    throw new Error("Retrospective holdout ranges must start exactly at development cutoff.");
  }
  return assets;
}

function validateDataset(
  input: CombinedConservativeHoldoutInput["assets"][number],
  expectedMarket: SupportedMarket,
  holdout: ValidatedAsset["holdout"],
): ValidatedAsset["dataset"] {
  if (input.dataset.asset !== input.asset || input.dataset.market !== expectedMarket) {
    throw new Error(`Dataset provenance for ${input.asset} does not match asset and market.`);
  }
  if (!isSha256(input.dataset.checksum)) {
    throw new Error(`Dataset checksum for ${input.asset} must be a lowercase SHA-256 hex digest.`);
  }
  if (input.dataset.fingerprint.trim().length === 0) {
    throw new Error(`Dataset fingerprint for ${input.asset} must be non-blank.`);
  }
  if (!isSha256(input.dataset.noTradeEvidenceChecksum)) {
    throw new Error(`No-trade evidence checksum for ${input.asset} must be a lowercase SHA-256 hex digest.`);
  }
  const holdoutFrom = parseIsoTimestamp(input.dataset.holdoutFrom, `${input.asset} dataset holdoutFrom`);
  const holdoutTo = parseIsoTimestamp(input.dataset.holdoutTo, `${input.asset} dataset holdoutTo`);
  if (holdoutFrom.epochMs !== holdout.from.epochMs || holdoutTo.epochMs !== holdout.to.epochMs) {
    throw new Error(`Dataset holdout range for ${input.asset} does not match holdout provenance.`);
  }
  const collectedAt = parseIsoTimestamp(input.dataset.collectedAt, `${input.asset} dataset collectedAt`);
  const endAt = parseIsoTimestamp(input.dataset.endAt, `${input.asset} dataset endAt`);
  if (collectedAt.epochMs < endAt.epochMs || endAt.epochMs < holdout.to.epochMs) {
    throw new Error(`Dataset collectedAt >= endAt >= holdout.to is required for ${input.asset}.`);
  }
  for (const [label, value] of [
    ["initialStateFingerprint", input.dataset.initialStateFingerprint],
    ["developmentFrameFingerprint", input.dataset.developmentFrameFingerprint],
    ["replayFrameFingerprint", input.dataset.replayFrameFingerprint],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`Dataset ${label} for ${input.asset} must be non-blank.`);
  }
  return {
    collectedAt,
    endAt,
    checksum: input.dataset.checksum,
    fingerprint: input.dataset.fingerprint,
    holdoutFrom,
    holdoutTo,
    noTradeEvidenceChecksum: input.dataset.noTradeEvidenceChecksum,
    initialStateFingerprint: input.dataset.initialStateFingerprint,
    developmentFrameFingerprint: input.dataset.developmentFrameFingerprint,
    replayFrameFingerprint: input.dataset.replayFrameFingerprint,
  };
}

function validateMatrix(
  input: CombinedConservativeHoldoutInput["assets"][number],
  expectedMarket: SupportedMarket,
  dataset: ValidatedAsset["dataset"],
): readonly CombinedConservativeHoldoutMatrixCell[] {
  const byKey = new Map<string, CombinedConservativeHoldoutMatrixCell>();
  for (const cell of input.matrix) {
    validateCell(cell, input.asset, expectedMarket, dataset);
    const key = cellKey(cell.timing, cell.cost, cell.scenario);
    if (byKey.has(key)) throw new Error(`Duplicate matrix cell ${input.asset}:${key}.`);
    byKey.set(key, copyCell(cell));
  }
  for (const timing of TIMING_ORDER) {
    for (const cost of COST_ORDER) {
      for (const scenario of SCENARIO_ORDER) {
        const key = cellKey(timing, cost, scenario);
        if (!byKey.has(key)) throw new Error(`Matrix must contain exactly one ${scenario} cell for ${input.asset}:${timing}:${cost}.`);
      }
    }
  }
  if (byKey.size !== TIMING_ORDER.length * COST_ORDER.length * SCENARIO_ORDER.length) {
    throw new Error(`Matrix for ${input.asset} contains an unsupported cell.`);
  }
  return TIMING_ORDER.flatMap((timing) => COST_ORDER.flatMap((cost) =>
    SCENARIO_ORDER.map((scenario) => byKey.get(cellKey(timing, cost, scenario))!),
  ));
}

function validateCell(
  cell: CombinedConservativeHoldoutMatrixCell,
  asset: SupportedAsset,
  market: SupportedMarket,
  dataset: ValidatedAsset["dataset"],
): void {
  if (cell.asset !== asset || cell.market !== market) {
    throw new Error(`Matrix cell market or asset does not match ${asset}.`);
  }
  if (!isTiming(cell.timing) || !isCost(cell.cost) || !isScenario(cell.scenario)) {
    throw new Error(`Matrix cell for ${asset} has an unsupported timing, cost, or scenario.`);
  }
  if (cell.datasetChecksum !== dataset.checksum) {
    throw new Error(`Matrix cell dataset checksum for ${asset} does not match dataset provenance.`);
  }
  if (cell.noTradeEvidenceChecksum !== dataset.noTradeEvidenceChecksum) {
    throw new Error(`Matrix cell no-trade evidence checksum for ${asset} does not match dataset provenance.`);
  }
  if (cell.datasetFingerprint !== dataset.fingerprint) {
    throw new Error(`Matrix cell dataset fingerprint for ${asset} does not match dataset provenance.`);
  }
  const holdoutFrom = parseIsoTimestamp(cell.holdoutFrom, `${asset} matrix holdoutFrom`);
  const holdoutTo = parseIsoTimestamp(cell.holdoutTo, `${asset} matrix holdoutTo`);
  if (holdoutFrom.epochMs !== dataset.holdoutFrom.epochMs || holdoutTo.epochMs !== dataset.holdoutTo.epochMs) {
    throw new Error(`Matrix cell holdout range for ${asset} does not match dataset provenance.`);
  }
  for (const [label, value, expected] of [
    ["initialStateFingerprint", cell.initialStateFingerprint, dataset.initialStateFingerprint],
    ["developmentFrameFingerprint", cell.developmentFrameFingerprint, dataset.developmentFrameFingerprint],
    ["replayFrameFingerprint", cell.replayFrameFingerprint, dataset.replayFrameFingerprint],
  ] as const) {
    if (value !== expected) throw new Error(`Matrix cell ${label} for ${asset} does not match dataset provenance.`);
  }
  if (!isSha256(cell.noTradeEvidenceChecksum)) {
    throw new Error(`Matrix cell no-trade evidence checksum for ${asset} must be a lowercase SHA-256 hex digest.`);
  }
  requireJsonSafeFinite(cell.netReturnPct, "netReturnPct");
  requireJsonSafeFiniteNonNegative(cell.maxDrawdownPct, "maxDrawdownPct");
  requireJsonSafeFiniteNonNegative(cell.turnoverKrw, "turnoverKrw");
  requireJsonSafeFiniteNonNegative(cell.feesKrw, "feesKrw");
  if (Object.is(cell.completedEpisodeCount, -0)) {
    throw new Error("completedEpisodeCount must not be negative zero.");
  }
  if (!Number.isSafeInteger(cell.completedEpisodeCount) || cell.completedEpisodeCount < 0) {
    throw new Error("completedEpisodeCount must be a non-negative safe integer.");
  }
  const coverageKeys = Object.keys(cell.coverage).sort();
  const expectedCoverageKeys = [...COVERAGE_KEYS].sort();
  if (coverageKeys.length !== expectedCoverageKeys.length || coverageKeys.some((key, index) => key !== expectedCoverageKeys[index])) {
    throw new Error("Coverage must contain exactly the six required boolean keys.");
  }
  for (const name of COVERAGE_KEYS) {
    if (typeof cell.coverage[name] !== "boolean") throw new Error(`Coverage ${name} must be boolean.`);
  }
}

function evaluateAsset(
  asset: SupportedAsset,
  validated: ValidatedAsset,
  policy: CombinedConservativeHoldoutInput["policy"],
): CombinedConservativeHoldoutAssetResult {
  const cells = validated.matrix;
  const comparisons = TIMING_ORDER.flatMap((timing) => COST_ORDER.flatMap((cost) => {
    const candidate = findCell(cells, timing, cost, "COMBINED_CONSERVATIVE");
    return (["BASELINE", "NO_ADD"] as const).flatMap((anchor) => {
      const anchorCell = findCell(cells, timing, cost, anchor);
      return METRIC_ORDER.map((metric) => compare(timing, cost, anchor, metric, candidate, anchorCell, policy));
    });
  }));
  const evidenceComplete = cells.every(hasCompleteCoverage);
  const candidateCompletedEpisodeCountComplete = cells
    .filter((cell) => cell.scenario === "COMBINED_CONSERVATIVE")
    .every((cell) => cell.completedEpisodeCount >= policy.minimumCompletedEpisodes);
  const anchorCompletedEpisodeCountComplete = cells
    .filter((cell) => cell.scenario !== "COMBINED_CONSERVATIVE")
    .every((cell) => cell.completedEpisodeCount >= policy.minimumCompletedEpisodes);
  const reasonCodes: CombinedConservativeHoldoutReasonCode[] = [
    ...(comparisons.some((comparison) => comparison.outcome === "FAIL") ? ["KNOWN_DIRECTIONAL_FAILURE" as const] : []),
    ...(!evidenceComplete ? ["INCOMPLETE_COVERAGE" as const] : []),
    ...(!candidateCompletedEpisodeCountComplete ? ["CANDIDATE_COMPLETED_EPISODES_BELOW_MINIMUM" as const] : []),
    ...(!anchorCompletedEpisodeCountComplete ? ["ANCHOR_COMPLETED_EPISODES_BELOW_MINIMUM" as const] : []),
  ];
  const status = comparisons.some((comparison) => comparison.outcome === "FAIL")
    ? "REJECTED"
    : !evidenceComplete || comparisons.some((comparison) => comparison.outcome === "UNKNOWN")
      || !candidateCompletedEpisodeCountComplete || !anchorCompletedEpisodeCountComplete
      ? "INSUFFICIENT"
      : "SUPPORTS_CONTINUED_SHADOW";

  return {
    asset,
    market: validated.market,
    holdout: {
      from: validated.holdout.from.normalized,
      to: validated.holdout.to.normalized,
    },
    dataset: {
      collectedAt: validated.dataset.collectedAt.normalized,
      endAt: validated.dataset.endAt.normalized,
      checksum: validated.dataset.checksum,
      fingerprint: validated.dataset.fingerprint,
      holdoutFrom: validated.dataset.holdoutFrom.normalized,
      holdoutTo: validated.dataset.holdoutTo.normalized,
      noTradeEvidenceChecksum: validated.dataset.noTradeEvidenceChecksum,
      initialStateFingerprint: validated.dataset.initialStateFingerprint,
      developmentFrameFingerprint: validated.dataset.developmentFrameFingerprint,
      replayFrameFingerprint: validated.dataset.replayFrameFingerprint,
    },
    matrix: cells,
    evidenceComplete,
    candidateCompletedEpisodeCountComplete,
    anchorCompletedEpisodeCountComplete,
    status,
    reasonCodes,
    comparisons,
  };
}

function findCell(
  cells: readonly CombinedConservativeHoldoutMatrixCell[],
  timing: CombinedConservativeTiming,
  cost: CombinedConservativeCost,
  scenario: CombinedConservativeScenario,
): CombinedConservativeHoldoutMatrixCell {
  const cell = cells.find((item) => item.timing === timing && item.cost === cost && item.scenario === scenario);
  if (!cell) throw new Error(`Validated matrix cell missing for ${timing}:${cost}:${scenario}.`);
  return cell;
}

function compare(
  timing: CombinedConservativeTiming,
  cost: CombinedConservativeCost,
  anchor: "BASELINE" | "NO_ADD",
  metric: CombinedConservativeMetric,
  candidate: CombinedConservativeHoldoutMatrixCell,
  anchorCell: CombinedConservativeHoldoutMatrixCell,
  policy: CombinedConservativeHoldoutInput["policy"],
): CombinedConservativeHoldoutComparison {
  const candidateValue = metricValue(candidate, metric);
  const anchorValue = metricValue(anchorCell, metric);
  const isRatioMetric = metric === "NET_RETURN_PCT" || metric === "MAX_DRAWDOWN_PCT";
  const valueUnit = isRatioMetric ? "RATIO" : "KRW";
  const deltaUnit = isRatioMetric ? "PERCENTAGE_POINTS" : "KRW";
  const tolerance = isRatioMetric
    ? policy.comparisonTolerancePercentagePoints
    : policy.comparisonToleranceKrw;
  const delta = normalizeComparisonNumber((candidateValue - anchorValue) * (isRatioMetric ? 100 : 1));
  if (!Number.isFinite(delta)) throw new Error(`Comparison delta for ${timing}:${cost}:${anchor}:${metric} must be finite.`);
  const outcome = !hasCompleteCoverageForMetric(candidate, metric) || !hasCompleteCoverageForMetric(anchorCell, metric)
    ? "UNKNOWN"
    : metric === "NET_RETURN_PCT"
      ? delta >= -tolerance ? "PASS" : "FAIL"
      : delta <= tolerance ? "PASS" : "FAIL";
  return { timing, cost, anchor, metric, candidateValue, anchorValue, delta, tolerance, valueUnit, deltaUnit, outcome };
}

function metricValue(cell: CombinedConservativeHoldoutMatrixCell, metric: CombinedConservativeMetric): number {
  switch (metric) {
    case "NET_RETURN_PCT": return cell.netReturnPct;
    case "MAX_DRAWDOWN_PCT": return cell.maxDrawdownPct;
    case "TURNOVER_KRW": return cell.turnoverKrw;
    case "FEES_KRW": return cell.feesKrw;
  }
}

function copyCell(cell: CombinedConservativeHoldoutMatrixCell): CombinedConservativeHoldoutMatrixCell {
  return { ...cell, coverage: { ...cell.coverage } };
}

function parseIsoTimestamp(value: string, label: string): ParsedTimestamp {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must be a valid ISO timestamp with explicit timezone.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const timezone = match[7]!;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const timezoneHour = timezone === "Z" ? 0 : Number(timezone.slice(1, 3));
  const timezoneMinute = timezone === "Z" ? 0 : Number(timezone.slice(4, 6));
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 || month > 12 || day < 1 || utcDate.getUTCFullYear() !== year || utcDate.getUTCMonth() !== month - 1
    || utcDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || timezoneHour > 23 || timezoneMinute > 59
  ) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) throw new Error(`${label} must be a valid ISO timestamp.`);
  return { epochMs, normalized: new Date(epochMs).toISOString() };
}

function hasCompleteCoverage(cell: CombinedConservativeHoldoutMatrixCell): boolean {
  return COVERAGE_KEYS.every((key) => cell.coverage[key]);
}

function hasCompleteCoverageForMetric(
  cell: CombinedConservativeHoldoutMatrixCell,
  metric: CombinedConservativeMetric,
): boolean {
  const keys = metric === "FEES_KRW" ? COVERAGE_KEYS : NON_FEE_COVERAGE_KEYS;
  return keys.every((key) => cell.coverage[key]);
}

function requireJsonSafeFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite and JSON-safe.`);
  if (Object.is(value, -0)) throw new Error(`${label} must not be negative zero.`);
}

function requireJsonSafeFiniteNonNegative(value: number, label: string): void {
  requireJsonSafeFinite(value, label);
  if (value < 0) throw new Error(`${label} must be finite and non-negative.`);
}

function normalizeComparisonNumber(value: number): number {
  const normalized = Number(value.toFixed(12));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function cellKey(timing: CombinedConservativeTiming, cost: CombinedConservativeCost, scenario: CombinedConservativeScenario): string {
  return `${timing}:${cost}:${scenario}`;
}

function isSupportedAsset(value: string): value is SupportedAsset {
  return ASSET_ORDER.includes(value as SupportedAsset);
}

function isTiming(value: string): value is CombinedConservativeTiming {
  return TIMING_ORDER.includes(value as CombinedConservativeTiming);
}

function isCost(value: string): value is CombinedConservativeCost {
  return COST_ORDER.includes(value as CombinedConservativeCost);
}

function isScenario(value: string): value is CombinedConservativeScenario {
  return SCENARIO_ORDER.includes(value as CombinedConservativeScenario);
}
