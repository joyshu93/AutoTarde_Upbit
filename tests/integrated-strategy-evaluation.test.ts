import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  type ResearchCandle,
  type ResearchCandleDataset,
  type ResearchCandleTimeframe,
} from "../src/modules/performance/research-candle-dataset.js";
import {
  classifyIndependentNoTradeCoverage,
  computeResearchNoTradeEvidenceSha256,
  type ResearchNoTradeEvidence,
  type ResearchNoTradeEvidenceWithoutChecksum,
} from "../src/modules/performance/research-no-trade-evidence.js";
import type {
  CombinedConservativeHoldoutAssetResult,
  CombinedConservativeHoldoutMatrixCell,
} from "../src/modules/performance/performance-combined-conservative-holdout.js";
import { parsePerformanceTimestamp } from
  "../src/modules/performance/performance-timestamp.js";
import { buildPositionGuardBacktestFrames } from
  "../src/modules/strategy/position-guard-backtest-frames.js";
import {
  assertFrozenBroadShadowDevelopmentAuthority,
  buildInterpretation,
  buildIntegratedStrategyEvaluation,
  calculateConditionalAddCadenceCoverage,
  extractAddPolicySuppressionEvidence,
  formatIntegratedStrategyEvaluation,
  hasCompleteHourlyCadenceForScope,
  parseIntegratedStrategyEvaluationArgs,
  resolveBroadCadenceFrom,
  scopeResearchDatasetForFeatureCoverage,
  type IntegratedStrategyEvaluationReport,
} from "../src/research/integrated-strategy-evaluation.js";

import * as integratedStrategyEvaluation from "../src/research/integrated-strategy-evaluation.js";
import { test } from "./harness.js";

test("broad shadow authority rejects any mutation of the frozen development evidence", () => {
  const frozen = [
    {
      asset: "BTC" as const,
      market: "KRW-BTC" as const,
      developmentFrom: "2025-01-01T00:00:00Z",
      developmentTo: "2026-04-12T19:00:00Z",
      initialStateFingerprint: "c3b0808c2e13030640f814f4460149ac10310b083b1c94a26fe235262e098727",
      developmentFrameFingerprint: "a25338aefe0495c484ad5c1b687518ff53705c0533f41f534e2fd3e9b3eb9494",
      developmentFrameCount: 6395,
      firstDevelopmentFrameAt: "2025-07-20T00:00:00.000Z",
      lastDevelopmentFrameAt: "2026-04-12T18:00:00.000Z",
      developmentCadenceComplete: true,
      featureCoverageStatus: "COMPLETE" as const,
    },
    {
      asset: "ETH" as const,
      market: "KRW-ETH" as const,
      developmentFrom: "2025-01-01T00:00:00Z",
      developmentTo: "2026-04-12T19:00:00Z",
      initialStateFingerprint: "c3b0808c2e13030640f814f4460149ac10310b083b1c94a26fe235262e098727",
      developmentFrameFingerprint: "ad79770791df803903490b5060782f487490bff00646a98773efa015a70a7776",
      developmentFrameCount: 6395,
      firstDevelopmentFrameAt: "2025-07-20T00:00:00.000Z",
      lastDevelopmentFrameAt: "2026-04-12T18:00:00.000Z",
      developmentCadenceComplete: true,
      featureCoverageStatus: "COMPLETE" as const,
    },
  ];

  assert.doesNotThrow(() => assertFrozenBroadShadowDevelopmentAuthority(frozen));
  assert.throws(
    () => assertFrozenBroadShadowDevelopmentAuthority([
      { ...frozen[0]!, developmentFrameCount: frozen[0]!.developmentFrameCount - 1 },
      frozen[1]!,
    ]),
    /does not match the frozen development authority/i,
  );
});

test("broad cadence verifies the leading and trailing [from,to) boundaries", () => {
  const frames = [
    { generatedAt: "2026-01-01T01:00:00Z" },
    { generatedAt: "2026-01-01T02:00:00Z" },
  ];
  const leading = {
    firstMissingCloseTime: "2026-01-01T00:00:00Z",
    lastMissingCloseTime: "2026-01-01T00:00:00Z",
    missingCandleCount: 1,
    previousObservedCloseTime: null,
    nextObservedCloseTime: "2026-01-01T01:00:00Z",
  };

  assert.equal(hasCompleteHourlyCadenceForScope({
    frames,
    verifiedNoTradeRanges: [],
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-01T03:00:00Z",
  }), false);
  assert.equal(hasCompleteHourlyCadenceForScope({
    frames,
    verifiedNoTradeRanges: [leading],
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-01T03:00:00Z",
  }), true);
  assert.equal(hasCompleteHourlyCadenceForScope({
    frames,
    verifiedNoTradeRanges: [leading],
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-01T04:00:00Z",
  }), false);
});

test("broad cadence excludes warmup only for the full path", () => {
  const scopeFrom = "2025-01-01T00:00:00Z";
  const firstReplayFrameAt = "2025-07-20T00:00:00Z";

  assert.equal(resolveBroadCadenceFrom(null, scopeFrom, firstReplayFrameAt), firstReplayFrameAt);
  assert.equal(resolveBroadCadenceFrom("W1", scopeFrom, firstReplayFrameAt), scopeFrom);
});

test("feature coverage scope excludes candles after the last analyzed frame", () => {
  const dataset = createDataset("BTC", {
    candleCounts: { "1h": 48, "4h": 12, "1d": 2 },
    endAt: "2026-08-03T00:00:00.000Z",
  });
  const lastAnalyzedFrameAt = "2026-08-02T12:00:00.000Z";

  const scoped = scopeResearchDatasetForFeatureCoverage(dataset, [
    { generatedAt: "2026-08-02T11:00:00.000Z" },
    { generatedAt: lastAnalyzedFrameAt },
  ]);

  assert.equal(scoped.provenance.endAt, lastAnalyzedFrameAt);
  for (const candles of Object.values(scoped.candles) as ResearchCandle[][]) {
    assert.ok(candles.every((candle) => Date.parse(candle.closeTime) <= Date.parse(lastAnalyzedFrameAt)));
  }
  assert.ok(dataset.candles["1h"].some((candle) =>
    Date.parse(candle.closeTime) > Date.parse(lastAnalyzedFrameAt)));
});

test("broad combined conservative holdout requires an explicit post-development [from,to) range", () => {
  const args = broadStrategyHypothesisArgs(
    "btc.json",
    "eth.json",
    "btc.no-trade.json",
    "eth.no-trade.json",
  );
  const parsed = parseIntegratedStrategyEvaluationArgs([
    ...args,
    "--broad-shadow-holdout-from", "2026-04-12T19:00:00Z",
    "--broad-shadow-holdout-to", "2026-08-11T00:00:00Z",
  ]);

  assert.deepEqual(parsed.broadStrategyShadowHoldout, {
    from: "2026-04-12T19:00:00.000Z",
    to: "2026-08-11T00:00:00.000Z",
  });
  assert.throws(() => parseIntegratedStrategyEvaluationArgs([
    ...args,
    "--broad-shadow-holdout-from", "2026-04-12T19:00:00Z",
  ]), /holdout-from.*holdout-to.*together/i);
  assert.throws(() => parseIntegratedStrategyEvaluationArgs([
    ...args,
    "--broad-shadow-holdout-from", "2026-04-12T18:00:00Z",
    "--broad-shadow-holdout-to", "2026-08-11T00:00:00Z",
  ]), /must not overlap the frozen development range/i);
});

const TMP_ROOT = path.resolve(".tmp-db-tests", "integrated-strategy-evaluation");
const OBSERVED_MARK_CASES = [
  {
    label: "unavailable",
    marks: [] as const,
    persisted: 0,
    usable: 0,
    gapCode: "MARK_DATA_UNAVAILABLE",
    metricStatus: "NOT_APPLICABLE",
    excludedSnapshotIds: [] as const,
  },
  {
    label: "unusable",
    marks: [null] as const,
    persisted: 1,
    usable: 0,
    gapCode: "MARK_DATA_UNUSABLE",
    metricStatus: "UNKNOWN",
    excludedSnapshotIds: ["mark-snapshot-1"] as const,
  },
  {
    label: "partial",
    marks: [null, "120"] as const,
    persisted: 2,
    usable: 1,
    gapCode: "MARK_DATA_PARTIAL",
    metricStatus: "UNKNOWN",
    excludedSnapshotIds: ["mark-snapshot-1"] as const,
  },
  {
    label: "complete",
    marks: ["110", "120"] as const,
    persisted: 2,
    usable: 2,
    gapCode: null,
    metricStatus: "KNOWN",
    excludedSnapshotIds: [] as const,
  },
] as const;

test("integrated evaluation CLI requires explicit observed filters and preserves exact [from,to)", () => {
  const parsed = parseIntegratedStrategyEvaluationArgs(requiredArgs(
    "--from",
    "2026-08-01T09:00:00.000000100+09:00",
    "--to",
    "2026-08-01T00:00:00.000000200Z",
    "--format",
    "json",
  ));

  assert.deepEqual(parsed.observed, {
    databasePath: "./fixture.sqlite",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    origin: "STRATEGY",
    from: "2026-08-01T00:00:00.000000100Z",
    to: "2026-08-01T00:00:00.000000200Z",
  });
  assert.equal(parsed.format, "json");
  assert.equal(parsed.simulation, null);

  for (const key of ["--database", "--exchange-account-id", "--execution-mode", "--origin"] as const) {
    assert.throws(() => parseIntegratedStrategyEvaluationArgs(removeArg(requiredArgs(), key)), /Missing required argument/);
  }
  assert.throws(() => parseIntegratedStrategyEvaluationArgs(requiredArgs("--unknown", "value")), /Unknown argument/);
  assert.throws(() => parseIntegratedStrategyEvaluationArgs(requiredArgs("--origin", "STRATEGY")), /Duplicate argument --origin/);
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--execution-mode", "PAPER")),
    /Invalid --execution-mode/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--execution-mode", "DRY_RUN")),
    /OBSERVED_LIVE_ATTRIBUTION requires --execution-mode LIVE/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--origin", "MANUAL")),
    /Invalid --origin/,
  );
  assert.throws(() => parseIntegratedStrategyEvaluationArgs(requiredArgs("--format", "yaml")), /Invalid --format/);
  assert.throws(() => parseIntegratedStrategyEvaluationArgs(requiredArgs("--from", "2026-08-01T00:00:00")), /explicit ISO-8601 timezone/);
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(requiredArgs(
      "--from",
      "2026-08-01T00:00:00.000000200Z",
      "--to",
      "2026-08-01T00:00:00.000000100Z",
    )),
    /--from must be earlier than --to/,
  );
});

test("integrated evaluation builder rejects non-LIVE observed evidence before reading persistence", async () => {
  const parsed = parseIntegratedStrategyEvaluationArgs(requiredArgs());
  let readerCalled = false;

  await assert.rejects(
    buildIntegratedStrategyEvaluation(
      {
        ...parsed,
        observed: { ...parsed.observed, executionMode: "DRY_RUN" },
      },
      {
        readObserved: () => {
          readerCalled = true;
          throw new Error("reader must not be called");
        },
      },
    ),
    /OBSERVED_LIVE_ATTRIBUTION requires executionMode LIVE/,
  );
  assert.equal(readerCalled, false);
});

test("integrated evaluation CLI validates explicit simulation JSON without monetary defaults", () => {
  const parsed = parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json"));
  assert.deepEqual(parsed.simulation, {
    scenarios: ["BASELINE", "NO_ADD"],
    minimumOrderValueKrw: 5_000,
    costScenarios: [
      { id: "observed-fee", feeRate: 0.0005, slippageRate: 0 },
      { id: "stress", feeRate: 0.001, slippageRate: 0.002 },
    ],
    assets: {
      BTC: {
        datasetPath: "./btc.json",
        initialState: { cashKrw: 1_000_000, quantity: 0, averageEntryPriceKrw: 0 },
      },
    },
  });

  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(requiredArgs("--btc-dataset", "./btc.json")),
    /Missing required simulation argument --btc-initial-state/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json", "--scenarios", "not-json")),
    /--scenarios must be valid JSON/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json", "--scenarios", "[\"BASELINE\",\"BASELINE\"]")),
    /Duplicate scenario BASELINE/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json", "--cost-cells", "[{\"id\":\"x\",\"feeRate\":0,\"slippageRate\":0},{\"id\":\"x\",\"feeRate\":0.1,\"slippageRate\":0}]")),
    /Duplicate cost scenario id x/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json", "--cost-cells", "[{\"id\":\"x\",\"feeRate\":1e309,\"slippageRate\":0}]")),
    /feeRate must be a finite non-negative number/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json", "--minimum-order-value-krw", "NaN")),
    /minimum-order-value-krw must be a finite non-negative number/,
  );
  for (const emptyValue of ["", "   "]) {
    assert.throws(
      () => parseIntegratedStrategyEvaluationArgs(simulationArgs(
        "BTC",
        "./btc.json",
        "--minimum-order-value-krw",
        emptyValue,
      )),
      /minimum-order-value-krw must be a non-empty finite non-negative number/,
    );
  }
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(requiredArgs("--scenarios", "[\"BASELINE\"]")),
    /Simulation arguments require at least one local dataset/,
  );
});

test("integrated evaluation CLI requires a complete explicit stability validation configuration", () => {
  const args = [
    ...simulationArgs("BTC", "./btc.json"),
    "--validation-windows",
    '[{"id":"w1","from":"2026-07-30T09:00:00+09:00","to":"2026-07-31T09:00:00+09:00"}]',
    "--validation-frame-interval-ms", "3600000",
    "--validation-comparison-tolerance-pp", "0.000001",
    "--validation-minimum-windows", "1",
  ];
  const parsed = parseIntegratedStrategyEvaluationArgs(args);

  assert.deepEqual(parsed.stabilityValidation, {
    windows: [{
      id: "w1",
      from: "2026-07-30T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
    }],
    expectedFrameIntervalMs: 3_600_000,
    comparisonTolerancePercentagePoints: 0.000001,
    minimumEvaluableWindows: 1,
  });
  assert.equal(parseIntegratedStrategyEvaluationArgs(requiredArgs()).stabilityValidation, null);
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs([
      ...simulationArgs("BTC", "./btc.json"),
      "--validation-windows", "[]",
    ]),
    /requires --validation-frame-interval-ms/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs([
      ...requiredArgs(),
      "--validation-windows", '[{"id":"w","from":"2026-01-01T00:00:00Z","to":"2026-01-02T00:00:00Z"}]',
      "--validation-frame-interval-ms", "3600000",
      "--validation-comparison-tolerance-pp", "0",
      "--validation-minimum-windows", "1",
    ]),
    /requires simulation datasets/,
  );
});

test("integrated evaluation CLI accepts the complete conditional ADD research matrix explicitly", () => {
  const parsed = parseIntegratedStrategyEvaluationArgs(conditionalSimulationArgs("BTC", "./btc.json"));

  assert.deepEqual(parsed.simulation?.scenarios, [
    "BASELINE",
    "NO_ADD",
    "ADD_RISK_CLEAR",
    "ADD_HIGH_ALIGNMENT",
    "ADD_CORE_TREND",
  ]);
  assert.equal(parsed.stabilityValidation?.windows.length, 3);
  assert.deepEqual(parsed.simulation?.costScenarios, [
    { id: "base", feeRate: 0.0005, slippageRate: 0.0003 },
    { id: "stress", feeRate: 0.001, slippageRate: 0.002 },
  ]);
});

test("integrated evaluation CLI enables broad strategy hypotheses only for the exact frozen profile", () => {
  const parsed = parseIntegratedStrategyEvaluationArgs(broadStrategyHypothesisArgs(
    "./btc.json",
    "./eth.json",
    "./btc.no-trade.json",
    "./eth.no-trade.json",
  ));

  assert.equal(
    (parsed as { broadStrategyHypothesisProfile?: unknown }).broadStrategyHypothesisProfile,
    "BROAD_LOSS_CAUSE_V1",
  );
  assert.deepEqual(parsed.simulation?.scenarios, [
    "BASELINE",
    "NO_ADD",
    "HTF_TREND_GATE",
    "STRICT_PULLBACK",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COOLDOWN_CONTROL",
    "COMBINED_CONSERVATIVE",
  ]);
  assert.deepEqual(parsed.simulation?.costScenarios, [
    { id: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
    { id: "STRESS", feeRate: 0.001, slippageRate: 0.002 },
  ]);
  assert.deepEqual(parsed.stabilityValidation?.windows.map((window) => window.id), ["W1", "W2", "W3"]);
  assert.equal(parsed.simulation?.assets.BTC?.noTradeEvidencePath, "./btc.no-trade.json");
  assert.equal(parsed.simulation?.assets.ETH?.noTradeEvidencePath, "./eth.no-trade.json");

  const legacy = parseIntegratedStrategyEvaluationArgs(simulationArgs("BTC", "./btc.json"));
  assert.equal("broadStrategyHypothesisProfile" in legacy, false);

  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(replaceArg(
      broadStrategyHypothesisArgs("./btc.json", "./eth.json"),
      "--scenarios",
      '["BASELINE","NO_ADD","STRICT_PULLBACK","HTF_TREND_GATE","EARLY_THESIS_FAILURE","ADD_LIMITED","COOLDOWN_CONTROL","COMBINED_CONSERVATIVE"]',
    )),
    /exact frozen 8-scenario matrix/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(replaceArg(
      broadStrategyHypothesisArgs("./btc.json", "./eth.json"),
      "--cost-cells",
      '[{"id":"BASE","feeRate":0.0005,"slippageRate":0},{"id":"STRESS","feeRate":0.001,"slippageRate":0.002}]',
    )),
    /exact frozen BASE\/STRESS cost cells/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs(removeArg(
      removeArg(broadStrategyHypothesisArgs("./btc.json", "./eth.json"), "--eth-dataset"),
      "--eth-initial-state",
    )),
    /requires both BTC and ETH datasets/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs([
      ...broadStrategyHypothesisArgs("./btc.json", "./eth.json"),
      "--btc-no-trade-evidence",
      "./btc.no-trade.json",
    ]),
    /requires both BTC and ETH no-trade evidence paths/,
  );
  assert.throws(
    () => parseIntegratedStrategyEvaluationArgs([
      ...requiredArgs(),
      "--btc-no-trade-evidence",
      "./btc.no-trade.json",
    ]),
    /--btc-no-trade-evidence requires --btc-dataset/,
  );
});

test("programmatic broad-profile builder validates exact frozen scenarios and costs before persistence", async () => {
  const exact = parseIntegratedStrategyEvaluationArgs(broadStrategyHypothesisArgs(
    "./btc.json",
    "./eth.json",
    "./btc.no-trade.json",
    "./eth.no-trade.json",
  ));
  const mutations: Array<[string, (options: typeof exact) => void, RegExp]> = [
    ["altered rate", (options) => replaceProgrammaticCosts(options, (costs) => [
      { ...costs[0]!, feeRate: 0.123 },
      ...costs.slice(1),
    ]), /exact frozen BASE\/STRESS cost cells/i],
    ["missing cost", (options) => replaceProgrammaticCosts(options, (costs) => costs.slice(0, -1)), /exact frozen BASE\/STRESS cost cells/i],
    ["extra cost", (options) => replaceProgrammaticCosts(options, (costs) => [
      ...costs,
      { id: "EXTRA", feeRate: 0, slippageRate: 0 },
    ]), /exact frozen BASE\/STRESS cost cells/i],
    ["reordered cost", (options) => replaceProgrammaticCosts(options, (costs) => [...costs].reverse()), /exact frozen BASE\/STRESS cost cells/i],
    ["mislabeled cost", (options) => replaceProgrammaticCosts(options, (costs) => [
      { ...costs[0]!, id: "base" },
      ...costs.slice(1),
    ]), /exact frozen BASE\/STRESS cost cells/i],
    ["missing scenario", (options) => replaceProgrammaticScenarios(options, (scenarios) => scenarios.slice(0, -1)), /exact frozen 8-scenario matrix/i],
    ["extra scenario", (options) => replaceProgrammaticScenarios(options, (scenarios) => [
      ...scenarios,
      "ADD_RISK_CLEAR",
    ]), /exact frozen 8-scenario matrix/i],
    ["reordered scenario", (options) => replaceProgrammaticScenarios(options, (scenarios) => [...scenarios].reverse()), /exact frozen 8-scenario matrix/i],
    ["mislabeled scenario", (options) => replaceProgrammaticScenarios(options, (scenarios) => [
      ...scenarios.slice(0, 2),
      "ADD_RISK_CLEAR",
      ...scenarios.slice(3),
    ]), /exact frozen 8-scenario matrix/i],
  ];

  for (const [name, mutate, expected] of mutations) {
    const options = structuredClone(exact);
    mutate(options);
    let persistenceRead = false;
    await assert.rejects(
      buildIntegratedStrategyEvaluation(options, {
        readObserved: () => {
          persistenceRead = true;
          throw new Error("PERSISTENCE_MUST_NOT_BE_READ");
        },
      }),
      expected,
      name,
    );
    assert.equal(persistenceRead, false, name);
  }

  let exactAuthorityReachedPersistence = false;
  await assert.rejects(
    buildIntegratedStrategyEvaluation(structuredClone(exact), {
      readObserved: () => {
        exactAuthorityReachedPersistence = true;
        throw new Error("EXACT_FROZEN_AUTHORITY_ACCEPTED");
      },
    }),
    /EXACT_FROZEN_AUTHORITY_ACCEPTED/,
  );
  assert.equal(exactAuthorityReachedPersistence, true);
});

test("broad replay keeps the detached frozen cost snapshot across an async caller mutation", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("broad-async-cost-snapshot"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "broad-async-cost-snapshot", {
        candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
        endAt: "2026-04-20T00:00:00.000Z",
        spacingMs: 36 * 60 * 60 * 1_000,
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const ethPath = await writeDatasetFixture("ETH", "broad-async-cost-snapshot", {
          candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
          endAt: "2026-04-20T00:00:00.000Z",
          spacingMs: 36 * 60 * 60 * 1_000,
        });
        const btcEvidence = await writeNoTradeEvidenceFixture(btcPath, "btc-async-cost");
        const ethEvidence = await writeNoTradeEvidenceFixture(ethPath, "eth-async-cost");
        const exact = parseIntegratedStrategyEvaluationArgs(replaceArg([
          ...broadStrategyHypothesisArgs(btcPath, ethPath, btcEvidence, ethEvidence),
          "--broad-shadow-holdout-from", "2026-04-12T19:00:00Z",
          "--broad-shadow-holdout-to", "2026-04-19T00:00:00Z",
        ], "--database", databasePath));
        const clean = await buildIntegratedStrategyEvaluation(structuredClone(exact), {
          verifyBroadShadowDevelopmentAuthority: () => undefined,
        });
        const racedOptions = structuredClone(exact);
        const simulation = racedOptions.simulation;
        assert.ok(simulation);
        const callerCosts: ProgrammaticCost[] = simulation.costScenarios.map((cost) => ({ ...cost }));
        const callerScenarios: ProgrammaticScenario[] = [...simulation.scenarios];
        racedOptions.simulation = {
          ...simulation,
          scenarios: callerScenarios,
          costScenarios: callerCosts,
        };

        let releaseReader!: () => void;
        const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
        let markReaderEntered!: () => void;
        const readerEntered = new Promise<void>((resolve) => { markReaderEntered = resolve; });
        let firstRead = true;
        const racedPromise = buildIntegratedStrategyEvaluation(racedOptions, {
          readDataset: async (datasetPath) => {
            if (firstRead) {
              firstRead = false;
              markReaderEntered();
              await readerGate;
            }
            return parseResearchCandleDataset(await readFile(datasetPath, "utf8"));
          },
          verifyBroadShadowDevelopmentAuthority: () => undefined,
        });

        await readerEntered;
        callerCosts[0]!.feeRate = 0.25;
        callerCosts[0]!.slippageRate = 0.5;
        callerCosts[0]!.id = callerCosts[1]!.id;
        callerCosts.reverse();
        callerScenarios.reverse();
        callerScenarios[0] = "NO_ADD";
        releaseReader();
        const raced = await racedPromise;

        assert.deepEqual(raced.provenance.scenarioAssumptions, clean.provenance.scenarioAssumptions);
        assert.deepEqual(raced.provenance.costCells, clean.provenance.costCells);
        assert.deepEqual(
          raced.broadStrategyHypothesisEvaluation,
          clean.broadStrategyHypothesisEvaluation,
        );
        assert.deepEqual(
          raced.broadStrategyShadowHoldoutEvaluation,
          clean.broadStrategyShadowHoldoutEvaluation,
        );
        assert.deepEqual(
          raced.broadStrategyShadowHoldoutComponentDiagnostics,
          clean.broadStrategyShadowHoldoutComponentDiagnostics,
        );
        const diagnostics = raced.broadStrategyShadowHoldoutComponentDiagnostics;
        assert.ok(diagnostics);
        for (const asset of diagnostics.assets) {
          for (const component of asset.components) {
            for (const delta of component.deltas) {
              const expected = delta.cost === "BASE"
                ? { feeRate: 0.0005, slippageRate: 0.0003 }
                : { feeRate: 0.001, slippageRate: 0.002 };
              assert.equal(delta.provenance.feeRate, expected.feeRate);
              assert.equal(delta.provenance.slippageRate, expected.slippageRate);
            }
          }
        }
      },
    ),
  );
});

type ParsedIntegratedOptions = ReturnType<typeof parseIntegratedStrategyEvaluationArgs>;
type ProgrammaticCost = NonNullable<ParsedIntegratedOptions["simulation"]>["costScenarios"][number];
type ProgrammaticScenario = NonNullable<ParsedIntegratedOptions["simulation"]>["scenarios"][number];

function replaceProgrammaticCosts(
  options: ParsedIntegratedOptions,
  transform: (costs: ProgrammaticCost[]) => readonly ProgrammaticCost[],
): void {
  const simulation = options.simulation;
  if (simulation === null) throw new Error("Test fixture requires simulation options.");
  options.simulation = {
    ...simulation,
    costScenarios: transform(simulation.costScenarios.map((cost) => ({ ...cost }))),
  };
}

function replaceProgrammaticScenarios(
  options: ParsedIntegratedOptions,
  transform: (scenarios: ProgrammaticScenario[]) => readonly ProgrammaticScenario[],
): void {
  const simulation = options.simulation;
  if (simulation === null) throw new Error("Test fixture requires simulation options.");
  options.simulation = {
    ...simulation,
    scenarios: transform([...simulation.scenarios]),
  };
}

test("broad strategy hypothesis report authenticates independent no-trade evidence", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("broad-independent-no-trade"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "broad-independent-no-trade", {
        candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
        endAt: "2026-04-20T00:00:00.000Z",
        spacingMs: 36 * 60 * 60 * 1_000,
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const ethPath = await writeDatasetFixture("ETH", "broad-independent-no-trade", {
          candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
          endAt: "2026-04-20T00:00:00.000Z",
          spacingMs: 36 * 60 * 60 * 1_000,
        });
        const btcEvidencePath = await writeNoTradeEvidenceFixture(btcPath, "btc");
        const ethEvidencePath = await writeNoTradeEvidenceFixture(ethPath, "eth");
        const args = broadStrategyHypothesisArgs(
          btcPath,
          ethPath,
          btcEvidencePath,
          ethEvidencePath,
        );
        const report = await buildIntegratedStrategyEvaluation(
          parseIntegratedStrategyEvaluationArgs(replaceArg(args, "--database", databasePath)),
        );
        const section = report.broadStrategyHypothesisEvaluation;

        assert.ok(section);
        assert.equal(section.independentNoTradeProofAvailable, true);
        assert.ok(section.datasets.every((dataset) =>
          dataset.noTradeEvidence !== null
          && dataset.noTradeEvidence.coverageStatus === "VERIFIED_SPARSE"
          && dataset.noTradeEvidence.uncoveredRangeCount === 0));
        assert.ok(section.evaluations.every((evaluation) =>
          evaluation.dataSufficiency.reasons.every((reason) =>
            !reason.endsWith("INDEPENDENTLY_VERIFIED_NO_TRADE_FALSE")
            && !reason.endsWith("CADENCE_INCOMPLETE"))));
      },
    ),
  );
});

test("integrated evaluation rejects no-trade evidence for a different parent dataset", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("mismatched-independent-no-trade"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "mismatched-independent-no-trade", {
        candleCounts: { "1h": 240, "4h": 240, "1d": 240 },
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const otherBtcPath = await writeDatasetFixture("BTC", "mismatched-independent-no-trade-other", {
          candleCounts: { "1h": 241, "4h": 241, "1d": 241 },
        });
        const evidencePath = await writeNoTradeEvidenceFixture(otherBtcPath, "mismatch");
        const args = [
          ...simulationArgs("BTC", btcPath),
          "--btc-no-trade-evidence",
          evidencePath,
        ];

        await assert.rejects(
          buildIntegratedStrategyEvaluation(
            parseIntegratedStrategyEvaluationArgs(replaceArg(args, "--database", databasePath)),
          ),
          /parent sha256 does not match the dataset/,
        );
      },
    ),
  );
});

test("broad strategy hypothesis report uses frozen continuous paths and excludes post-cutoff evidence", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("broad-strategy-hypothesis"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "broad-strategy-hypothesis", {
        candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
        endAt: "2026-04-20T00:00:00.000Z",
        spacingMs: 36 * 60 * 60 * 1_000,
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const ethPath = await writeDatasetFixture("ETH", "broad-strategy-hypothesis", {
          candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
          endAt: "2026-04-20T00:00:00.000Z",
          spacingMs: 36 * 60 * 60 * 1_000,
        });
        const args = broadStrategyHypothesisArgs(btcPath, ethPath);
        const options = parseIntegratedStrategyEvaluationArgs(
          replaceArg(args, "--database", databasePath),
        );

        const first = await buildIntegratedStrategyEvaluation(options);
        const second = await buildIntegratedStrategyEvaluation(options);
        const section = (first as unknown as {
          broadStrategyHypothesisEvaluation?: {
            profileId: string;
            readOnly: boolean;
            deploymentApproval: boolean;
            developmentCutoffExclusive: string;
            independentNoTradeProofAvailable: boolean;
            datasets: Array<{
              asset: string;
              datasetSha256: string;
              developmentFrameCount: number;
              lastDevelopmentFrameAt: string | null;
              excludedPostCutoffCandleCount: number;
              initialStateFingerprint: string;
              frameFingerprint: string;
            }>;
            executionTimingProvenance: Array<{ timingModel: string; caveat: string }>;
            evaluations: Array<{
              asset: string;
              candidate: string;
              status: string;
              pathProvenance: Array<{
                timingModel: string;
                datasetSha256: string;
                initialStateFingerprint: string;
                frameFingerprint: string;
              }>;
              dataSufficiency: { status: string; reasons: string[] };
              directionalGateOutcome: { status: string; reasons: string[] };
            }>;
            crossAssetSummary: Array<{ candidate: string; adjudicative: boolean }>;
            pathDiagnostics: Array<{
              asset: string;
              scenario: string;
              timingModel: string;
              costCellId: string;
              backtestMetrics: { turnoverKrw: number; feesKrw: number; timeInMarketFrames: number };
              fifoAndEpisodeDiagnostics: {
                combined: { maxConsecutiveLosses: { status: string } };
              };
              regimeAnalysis: { regimes: Record<string, unknown> };
              excursionAnalysis: { episodes: unknown[] };
              windows: Array<{
                windowId: string;
                frameCount: number;
                returnAndDrawdown: { status: string };
                completedEpisodes: unknown[];
                realizationSlices: unknown[];
                fills: unknown[];
                excursionEpisodes: unknown[];
              }>;
              interventions: { total: number; outcomes: Record<string, number> };
            }>;
          };
        }).broadStrategyHypothesisEvaluation;

        assert.ok(section);
        assert.equal(section.profileId, "BROAD_LOSS_CAUSE_V1");
        assert.equal(section.readOnly, true);
        assert.equal(section.deploymentApproval, false);
        assert.equal(section.developmentCutoffExclusive, "2026-04-12T19:00:00Z");
        assert.equal(section.independentNoTradeProofAvailable, false);
        assert.deepEqual(section.executionTimingProvenance.map((item) => item.timingModel), [
          "SAME_CLOSE_MODELED",
          "NEXT_FRAME_MODELED",
        ]);
        assert.deepEqual(section.datasets.map((item) => item.asset), ["BTC", "ETH"]);
        assert.ok(section.datasets.every((item) => item.developmentFrameCount > 0));
        assert.ok(section.datasets.every((item) => item.excludedPostCutoffCandleCount > 0));
        assert.ok(section.datasets.every((item) =>
          item.lastDevelopmentFrameAt !== null
          && Date.parse(item.lastDevelopmentFrameAt) < Date.parse(section.developmentCutoffExclusive)));
        assert.deepEqual(section.evaluations.map((item) => `${item.asset}:${item.candidate}`), [
          "BTC:HTF_TREND_GATE",
          "BTC:STRICT_PULLBACK",
          "BTC:EARLY_THESIS_FAILURE",
          "BTC:ADD_LIMITED",
          "BTC:COOLDOWN_CONTROL",
          "BTC:COMBINED_CONSERVATIVE",
          "ETH:HTF_TREND_GATE",
          "ETH:STRICT_PULLBACK",
          "ETH:EARLY_THESIS_FAILURE",
          "ETH:ADD_LIMITED",
          "ETH:COOLDOWN_CONTROL",
          "ETH:COMBINED_CONSERVATIVE",
        ]);
        assert.ok(section.evaluations.every((item) => item.pathProvenance.length === 2));
        for (const evaluation of section.evaluations) {
          assert.equal(evaluation.dataSufficiency.status, "INSUFFICIENT");
          assert.ok(evaluation.dataSufficiency.reasons.some((reason) =>
            reason.endsWith("INDEPENDENTLY_VERIFIED_NO_TRADE_FALSE")));
          const dataset = section.datasets.find((item) => item.asset === evaluation.asset);
          assert.ok(dataset);
          assert.ok(evaluation.pathProvenance.every((pathIdentity) =>
            pathIdentity.datasetSha256 === dataset.datasetSha256
            && pathIdentity.initialStateFingerprint === dataset.initialStateFingerprint
            && pathIdentity.frameFingerprint === dataset.frameFingerprint));
        }
        assert.ok(section.crossAssetSummary.every((item) => item.adjudicative === false));
        assert.equal(section.pathDiagnostics.length, 64);
        assert.deepEqual(
          [...new Set(section.pathDiagnostics.map((item) => item.timingModel))],
          ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"],
        );
        assert.ok(section.pathDiagnostics.every((item) =>
          Number.isFinite(item.backtestMetrics.turnoverKrw)
          && Number.isFinite(item.backtestMetrics.feesKrw)
          && Number.isFinite(item.backtestMetrics.timeInMarketFrames)
          && item.fifoAndEpisodeDiagnostics.combined.maxConsecutiveLosses.status !== undefined
          && typeof item.regimeAnalysis.regimes === "object"
          && Array.isArray(item.excursionAnalysis.episodes)
          && item.windows.length === 3
          && item.windows.every((window) =>
            ["AVAILABLE", "UNAVAILABLE"].includes(window.returnAndDrawdown.status)
            && Array.isArray(window.completedEpisodes)
            && Array.isArray(window.realizationSlices)
            && Array.isArray(window.fills)
            && Array.isArray(window.excursionEpisodes))
          && item.interventions.total === Object.values(item.interventions.outcomes)
            .reduce((sum, count) => sum + count, 0)));
        assert.equal(
          formatIntegratedStrategyEvaluation(first, "json"),
          formatIntegratedStrategyEvaluation(second, "json"),
        );
        const text = formatIntegratedStrategyEvaluation(first, "text");
        assert.match(text, /Broad Strategy Hypothesis Evaluation/);
        assert.match(text, /SAME_CLOSE_MODELED/);
        assert.match(text, /NEXT_FRAME_MODELED/);
        assert.match(text, /INDEPENDENTLY_VERIFIED_NO_TRADE_FALSE/);
        assert.match(text, /not deployment approval/i);
        assert.deepEqual(JSON.parse(formatIntegratedStrategyEvaluation(first, "json")), first);
      },
    ),
  );
});

test("broad combined conservative holdout is a separate continuous read-only evaluation", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("broad-combined-holdout"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "broad-combined-holdout", {
        candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
        endAt: "2026-04-20T00:00:00.000Z",
        spacingMs: 36 * 60 * 60 * 1_000,
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const ethPath = await writeDatasetFixture("ETH", "broad-combined-holdout", {
          candleCounts: { "1h": 400, "4h": 400, "1d": 400 },
          endAt: "2026-04-20T00:00:00.000Z",
          spacingMs: 36 * 60 * 60 * 1_000,
        });
        const btcEvidence = await writeNoTradeEvidenceFixture(btcPath, "btc-holdout");
        const ethEvidence = await writeNoTradeEvidenceFixture(ethPath, "eth-holdout");
        const options = parseIntegratedStrategyEvaluationArgs(replaceArg([
          ...broadStrategyHypothesisArgs(btcPath, ethPath, btcEvidence, ethEvidence),
          "--broad-shadow-holdout-from", "2026-04-12T19:00:00Z",
          "--broad-shadow-holdout-to", "2026-04-19T00:00:00Z",
        ], "--database", databasePath));

        const report = await buildIntegratedStrategyEvaluation(options, {
          verifyBroadShadowDevelopmentAuthority: () => undefined,
        });
        const holdout = report.broadStrategyShadowHoldoutEvaluation;
        assert.ok(holdout);
        assert.equal(holdout.analysisKind, "COMBINED_CONSERVATIVE_HOLDOUT");
        assert.equal(holdout.phase, "RETROSPECTIVE_HOLDOUT");
        assert.equal(holdout.readOnly, true);
        assert.equal(holdout.deploymentApproval, false);
        assert.equal(holdout.authority.version, "UNVERIFIED_TEST_OVERRIDE");
        assert.ok(holdout.assets.every((asset) => asset.status === "INSUFFICIENT"));
        const failureDiagnostics = report.broadStrategyShadowHoldoutDiagnostics;
        assert.ok(failureDiagnostics);
        assert.equal(failureDiagnostics.readOnly, true);
        assert.equal(failureDiagnostics.causalClaim, false);
        assert.deepEqual(failureDiagnostics.assets.map((asset) => asset.asset), ["BTC", "ETH"]);
        const componentDiagnostics = report.broadStrategyShadowHoldoutComponentDiagnostics;
        assert.ok(componentDiagnostics);
        assert.equal(componentDiagnostics.analysisKind, "PERFORMANCE_COMPONENT_ABLATION");
        assert.equal(componentDiagnostics.authorityId, "COMBINED_CONSERVATIVE_ABLATION_V1");
        assert.equal(componentDiagnostics.readOnly, true);
        assert.equal(componentDiagnostics.causalClaim, false);
        assert.equal(componentDiagnostics.deploymentApproval, false);
        assert.equal(componentDiagnostics.prospectiveApproval, false);
        assert.match(componentDiagnostics.interpretationBoundary, /retrospective association/i);
        assert.match(componentDiagnostics.interpretationBoundary, /cannot authorize shadow or LIVE/i);
        assert.match(componentDiagnostics.interpretationBoundary, /fresh prospective test/i);
        assert.deepEqual(componentDiagnostics.assets.map((asset) => asset.asset), ["BTC", "ETH"]);
        const expectedAblations = [
          "COMBINED_MINUS_HTF_TREND_GATE",
          "COMBINED_MINUS_EARLY_THESIS_FAILURE",
          "COMBINED_MINUS_ADD_LIMITED",
          "COMBINED_MINUS_COOLDOWN_CONTROL",
        ];
        const validClassifications = new Set([
          "PROTECTIVE_ASSOCIATION",
          "HARM_ASSOCIATION",
          "MIXED_ASSOCIATION",
          "NO_MEASURABLE_DIFFERENCE",
          "INSUFFICIENT_EVIDENCE",
        ]);
        const expectedCoverageKeys = [
          "ablationFeeComplete",
          "ablationFiniteMetricsComplete",
          "ablationLifecycleComplete",
          "cadenceComplete",
          "carryInStateComplete",
          "featureCoverageComplete",
          "referenceFeeComplete",
          "referenceFiniteMetricsComplete",
          "referenceLifecycleComplete",
        ];
        const ablationCells = componentDiagnostics.assets.flatMap((asset) => {
          assert.deepEqual(asset.components.map((component) => component.ablationScenario), expectedAblations);
          assert.ok(asset.components.every((component) =>
            validClassifications.has(component.classification)));
          return asset.components.flatMap((component) => component.deltas.map((delta) => ({
            asset: asset.asset,
            scenario: component.ablationScenario,
            delta,
          })));
        });
        assert.equal(ablationCells.length, 32);
        assert.equal(new Set(ablationCells.map(({ asset, scenario, delta }) =>
          `${asset}:${scenario}:${delta.timing}:${delta.cost}`)).size, 32);
        const expectedReplayFrameFingerprints = new Map(await Promise.all(
          (["BTC", "ETH"] as const).map(async (asset) => {
            const datasetPath = options.simulation?.assets[asset]?.datasetPath;
            assert.ok(datasetPath);
            const dataset = parseResearchCandleDataset(await readFile(datasetPath, "utf8"));
            const holdoutTo = parsePerformanceTimestamp(options.broadStrategyShadowHoldout!.to);
            assert.ok(holdoutTo);
            const replayFrames = buildPositionGuardBacktestFrames({
              asset,
              market: dataset.provenance.market,
              oneHourCandles: dataset.candles["1h"],
              fourHourCandles: dataset.candles["4h"],
              oneDayCandles: dataset.candles["1d"],
            }).filter((frame) => {
              const generatedAt = parsePerformanceTimestamp(frame.generatedAt);
              assert.ok(generatedAt);
              return generatedAt.epochNanoseconds
                >= parsePerformanceTimestamp("2025-01-01T00:00:00Z")!.epochNanoseconds
                && generatedAt.epochNanoseconds < holdoutTo.epochNanoseconds;
            });
            return [
              asset,
              createHash("sha256").update(JSON.stringify(replayFrames)).digest("hex"),
            ] as const;
          }),
        ));
        for (const ablationCell of ablationCells) {
          const assetId = ablationCell.asset;
          const scenarioId = ablationCell.scenario;
          const delta = ablationCell.delta;
          const holdoutAsset: CombinedConservativeHoldoutAssetResult | undefined =
            holdout.assets.find((candidate) => candidate.asset === assetId);
          assert.ok(holdoutAsset);
          const referenceCell: CombinedConservativeHoldoutMatrixCell | undefined =
            holdoutAsset.matrix.find((cell) =>
              cell.scenario === "COMBINED_CONSERVATIVE"
              && cell.timing === delta.timing
              && cell.cost === delta.cost);
          assert.ok(referenceCell);
          assert.deepEqual(delta.reference, {
            scenario: "COMBINED_CONSERVATIVE",
            netReturnPct: referenceCell.netReturnPct,
            maxDrawdownPct: referenceCell.maxDrawdownPct,
            turnoverKrw: referenceCell.turnoverKrw,
            feesKrw: referenceCell.feesKrw,
            completedEpisodeCount: referenceCell.completedEpisodeCount,
          });
          assert.equal(delta.ablation.scenario, scenarioId);
          assert.deepEqual(Object.keys(delta.coverage).sort(), expectedCoverageKeys);
          assert.ok(Object.values(delta.coverage).every((value) => typeof value === "boolean"));
          assert.equal(delta.coverage.carryInStateComplete, false);
          assert.equal(
            delta.episodeAttribution.ablationScenario,
            scenarioId,
          );
          assert.equal(
            delta.episodeAttribution.referenceScenario,
            "COMBINED_CONSERVATIVE",
          );
          assert.deepEqual(delta.episodeAttribution.provenance, delta.provenance);
          assert.equal(
            delta.episodeAttribution.counts.totalRelationships,
            delta.episodeAttribution.relationships.length,
          );
          assert.deepEqual(delta.provenance, {
            authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1",
            asset: assetId,
            market: holdoutAsset.market,
            timingModel: delta.timing,
            costCellId: delta.cost,
            costRole: delta.cost,
            feeRate: delta.cost === "BASE" ? 0.0005 : 0.001,
            slippageRate: delta.cost === "BASE" ? 0.0003 : 0.002,
            holdoutFrom: holdoutAsset.holdout.from,
            holdoutTo: holdoutAsset.holdout.to,
            datasetSha256: holdoutAsset.dataset.checksum,
            datasetFingerprint: holdoutAsset.dataset.fingerprint,
            initialStateFingerprint: holdoutAsset.dataset.initialStateFingerprint,
            developmentFrameFingerprint: holdoutAsset.dataset.developmentFrameFingerprint,
            replayFrameFingerprint: holdoutAsset.dataset.replayFrameFingerprint,
          });
          assert.equal(
            delta.provenance.replayFrameFingerprint,
            expectedReplayFrameFingerprints.get(assetId),
          );
          const holdoutTo = parsePerformanceTimestamp(delta.provenance.holdoutTo);
          assert.ok(holdoutTo);
          assert.ok(
            parsePerformanceTimestamp(holdoutAsset.dataset.endAt)!.epochNanoseconds
              > holdoutTo.epochNanoseconds,
            "The fixture must contain future source evidence beyond the exclusive holdout end.",
          );
        }
        assert.deepEqual(holdout.assets.map((asset) => asset.asset), ["BTC", "ETH"]);
        assert.ok(holdout.assets.every((asset) =>
          asset.holdout.from === "2026-04-12T19:00:00.000Z"
          && asset.holdout.to === "2026-04-19T00:00:00.000Z"
          && asset.matrix.length === 12));
        assert.equal(
          report.broadStrategyHypothesisEvaluation?.developmentCutoffExclusive,
          "2026-04-12T19:00:00Z",
        );
        const text = formatIntegratedStrategyEvaluation(report, "text");
        assert.match(text, /Combined Conservative Shadow Holdout/);
        assert.match(text, /Aggregate Failure Diagnostics/);
        assert.match(text, /no causal or deployment claim/i);
        assert.match(text, /retrospective association/i);
        assert.match(text, /non-causal/i);
        assert.match(text, /cannot authorize shadow\/LIVE/i);
        assert.match(text, /fresh prospective test/i);
        assert.ok(text.indexOf("ETH component ablation:") < text.indexOf("BTC component ablation:"));
        assert.match(text, /\[Combined Conservative Component Ablation Diagnostics\]/);
        assert.deepEqual(JSON.parse(formatIntegratedStrategyEvaluation(report, "json")), report);
        const repeated = await buildIntegratedStrategyEvaluation(options, {
          verifyBroadShadowDevelopmentAuthority: () => undefined,
        });
        assert.equal(
          formatIntegratedStrategyEvaluation(report, "json"),
          formatIntegratedStrategyEvaluation(repeated, "json"),
        );
        const originalBtcDataset = parseResearchCandleDataset(await readFile(btcPath, "utf8"));
        const originalEthDataset = parseResearchCandleDataset(await readFile(ethPath, "utf8"));
        const selectedHoldout = options.broadStrategyShadowHoldout;
        assert.ok(selectedHoldout);
        const mutatedBtcDataset = mutateDatasetAtOrAfter(
          originalBtcDataset,
          selectedHoldout.to,
        );
        const mutatedEthDataset = mutateDatasetAtOrAfter(
          originalEthDataset,
          selectedHoldout.to,
        );
        await writeFile(btcPath, JSON.stringify(mutatedBtcDataset), "utf8");
        await writeFile(ethPath, JSON.stringify(mutatedEthDataset), "utf8");
        await writeFile(
          btcEvidence,
          `${JSON.stringify(createNoTradeEvidenceFixture(mutatedBtcDataset), null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          ethEvidence,
          `${JSON.stringify(createNoTradeEvidenceFixture(mutatedEthDataset), null, 2)}\n`,
          "utf8",
        );
        const futureMutated = await buildIntegratedStrategyEvaluation(options, {
          verifyBroadShadowDevelopmentAuthority: () => undefined,
        });
        const futureDiagnostics = futureMutated.broadStrategyShadowHoldoutComponentDiagnostics;
        assert.ok(futureDiagnostics);
        assert.notDeepEqual(
          futureMutated.broadStrategyShadowHoldoutEvaluation?.assets.map((asset) =>
            asset.dataset.checksum),
          holdout.assets.map((asset) => asset.dataset.checksum),
        );
        const originalIdentity = componentDiagnostics.assets[0]!.components[0]!.deltas[0]!.provenance;
        const futureIdentity = futureDiagnostics.assets[0]!.components[0]!.deltas[0]!.provenance;
        assert.notEqual(futureIdentity.datasetSha256, originalIdentity.datasetSha256);
        assert.notEqual(futureIdentity.datasetFingerprint, originalIdentity.datasetFingerprint);
        assert.equal(
          futureIdentity.replayFrameFingerprint,
          originalIdentity.replayFrameFingerprint,
        );
        assert.equal(
          JSON.stringify(withoutWholeDatasetIdentity(futureDiagnostics)),
          JSON.stringify(withoutWholeDatasetIdentity(componentDiagnostics)),
          "future-only candles must not alter pre-to metrics, attribution, classifications, counts, or replay provenance",
        );
      },
    ),
  );
});

test("conditional ADD suppression evidence comes only from candidate replay researchSuppression", () => {
  const evidence = extractAddPolicySuppressionEvidence("BTC", [
    {
      policyId: "ADD_RISK_CLEAR",
      frames: [
        {
          generatedAt: "2026-08-01T09:00:00+09:00",
          researchSuppression: {
            policyId: "ADD_RISK_CLEAR",
            originalAction: "ADD",
            reason: "ATR_SHOCK",
            generatedAt: "2026-08-01T00:00:00.000Z",
            analysisSnapshot: {
              atrShock: true,
              weakeningStage: "NONE",
              trendAlignmentScore: 5,
              regime: "BULL_TREND",
            },
          },
        },
        {
          generatedAt: "2026-08-01T01:00:00.000Z",
          researchSuppression: null,
        },
      ],
    },
    {
      policyId: "ADD_HIGH_ALIGNMENT",
      frames: [{
        generatedAt: "2026-08-01T02:00:00.000Z",
        researchSuppression: {
          policyId: "ADD_HIGH_ALIGNMENT",
          originalAction: "ADD",
          reason: "TREND_ALIGNMENT_BELOW_4",
          generatedAt: "2026-08-01T11:00:00+09:00",
          analysisSnapshot: {
            atrShock: false,
            weakeningStage: "NONE",
            trendAlignmentScore: 3,
            regime: "PULLBACK_IN_UPTREND",
          },
        },
      }],
    },
    {
      policyId: "ADD_CORE_TREND",
      frames: [],
    },
  ]);

  assert.deepEqual(evidence, [
    {
      policyId: "ADD_RISK_CLEAR",
      suppressedDecisions: [{
        generatedAt: "2026-08-01T00:00:00.000Z",
        evidenceIds: [
          "research-suppression:BTC:KRW-BTC:ADD_RISK_CLEAR:2026-08-01T00:00:00.000Z:ATR_SHOCK",
        ],
      }],
    },
    {
      policyId: "ADD_HIGH_ALIGNMENT",
      suppressedDecisions: [{
        generatedAt: "2026-08-01T02:00:00.000Z",
        evidenceIds: [
          "research-suppression:BTC:KRW-BTC:ADD_HIGH_ALIGNMENT:2026-08-01T02:00:00.000Z:TREND_ALIGNMENT_BELOW_4",
        ],
      }],
    },
    {
      policyId: "ADD_CORE_TREND",
      suppressedDecisions: [],
    },
  ]);
});

test("conditional ADD suppression evidence ids cannot collide across BTC and ETH", () => {
  const replay = [{
    policyId: "ADD_RISK_CLEAR" as const,
    frames: [{
      generatedAt: "2026-08-01T00:00:00.000Z",
      researchSuppression: {
        policyId: "ADD_RISK_CLEAR" as const,
        originalAction: "ADD" as const,
        reason: "ATR_SHOCK" as const,
        generatedAt: "2026-08-01T00:00:00.000Z",
        analysisSnapshot: {
          atrShock: true,
          weakeningStage: "NONE" as const,
          trendAlignmentScore: 5,
          regime: "BULL_TREND" as const,
        },
      },
    }],
  }];

  const btcId = extractAddPolicySuppressionEvidence("BTC", replay)[0]!.suppressedDecisions[0]!.evidenceIds[0];
  const ethId = extractAddPolicySuppressionEvidence("ETH", replay)[0]!.suppressedDecisions[0]!.evidenceIds[0];

  assert.equal(btcId, "research-suppression:BTC:KRW-BTC:ADD_RISK_CLEAR:2026-08-01T00:00:00.000Z:ATR_SHOCK");
  assert.equal(ethId, "research-suppression:ETH:KRW-ETH:ADD_RISK_CLEAR:2026-08-01T00:00:00.000Z:ATR_SHOCK");
  assert.notEqual(btcId, ethId);
});

test("conditional ADD cadence coverage detects an off-grid replacement at exact epoch instants", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    from: "2026-07-30T09:00:00+09:00",
    to: "2026-07-30T04:00:00Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T01:00:00.000Z" },
      { generatedAt: "2026-07-30T02:30:00.000Z" },
      { generatedAt: "2026-07-30T03:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [],
  });

  assert.deepEqual(coverage, {
    status: "INCOMPLETE",
    expectedFrameIntervalMs: 3_600_000,
    firstExpectedFrameAt: "2026-07-30T00:00:00.000Z",
    endExclusiveAt: "2026-07-30T04:00:00.000Z",
    expectedFrameCount: 4,
    observedFrameCount: 3,
    noTradeFrameCount: 0,
    noTradeRanges: [],
    missingFrameCount: 1,
    duplicateFrameCount: 0,
    offGridFrameCount: 1,
    missingRanges: [{
      firstMissingAt: "2026-07-30T02:00:00.000Z",
      lastMissingAt: "2026-07-30T02:00:00.000Z",
      missingFrameCount: 1,
      previousObservedAt: "2026-07-30T01:00:00.000Z",
      nextObservedAt: "2026-07-30T03:00:00.000Z",
    }],
    duplicateInstants: [],
    offGridInstants: [{ observedAt: "2026-07-30T02:30:00.000Z", occurrenceCount: 1 }],
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "ANOMALOUS",
    upstreamStateContinuityStatus: "COMPLETE",
    featureLookbackContinuityStatus: "COMPLETE",
    upstreamExpectedFrameCount: 0,
    upstreamObservedFrameCount: 0,
    upstreamSequenceContinuityStatus: "COMPLETE",
    upstreamClockGridStatus: "DENSE",
    upstreamNoTradeFrameCount: 0,
    upstreamNoTradeRanges: [],
    upstreamFirstExpectedFrameAt: null,
    upstreamEndExclusiveAt: null,
    upstreamMissingFrameCount: 0,
    upstreamDuplicateFrameCount: 0,
    upstreamOffGridFrameCount: 0,
    upstreamMissingRanges: [],
    upstreamDuplicateInstants: [],
    upstreamOffGridInstants: [],
    featureLookbackAffectedFrameCount: 0,
    featureLookbackAffectedRanges: [],
  });
});

test("conditional ADD cadence coverage keeps duplicate actual frames blocking", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T03:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T01:00:00.000Z" },
      { generatedAt: "2026-07-30T01:00:00.000Z" },
      { generatedAt: "2026-07-30T02:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [],
  });

  assert.equal(coverage.status, "INCOMPLETE");
  assert.equal(coverage.windowSequenceContinuityStatus, "INCOMPLETE");
  assert.equal(coverage.windowClockGridStatus, "ANOMALOUS");
  assert.equal(coverage.observedFrameCount, 3);
  assert.equal(coverage.duplicateFrameCount, 1);
  assert.deepEqual(coverage.duplicateInstants, [{
    observedAt: "2026-07-30T01:00:00.000Z",
    occurrenceCount: 2,
  }]);
});

test("conditional ADD cadence coverage groups consecutive missing frames without interpolation", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T08:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T03:00:00.000Z" },
      { generatedAt: "2026-07-30T04:00:00.000Z" },
      { generatedAt: "2026-07-30T07:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [],
  });

  assert.deepEqual(coverage, {
    status: "INCOMPLETE",
    expectedFrameIntervalMs: 3_600_000,
    firstExpectedFrameAt: "2026-07-30T00:00:00.000Z",
    endExclusiveAt: "2026-07-30T08:00:00.000Z",
    expectedFrameCount: 8,
    observedFrameCount: 4,
    noTradeFrameCount: 0,
    noTradeRanges: [],
    missingFrameCount: 4,
    duplicateFrameCount: 0,
    offGridFrameCount: 0,
    missingRanges: [
      {
        firstMissingAt: "2026-07-30T01:00:00.000Z",
        lastMissingAt: "2026-07-30T02:00:00.000Z",
        missingFrameCount: 2,
        previousObservedAt: "2026-07-30T00:00:00.000Z",
        nextObservedAt: "2026-07-30T03:00:00.000Z",
      },
      {
        firstMissingAt: "2026-07-30T05:00:00.000Z",
        lastMissingAt: "2026-07-30T06:00:00.000Z",
        missingFrameCount: 2,
        previousObservedAt: "2026-07-30T04:00:00.000Z",
        nextObservedAt: "2026-07-30T07:00:00.000Z",
      },
    ],
    duplicateInstants: [],
    offGridInstants: [],
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "ANOMALOUS",
    upstreamStateContinuityStatus: "COMPLETE",
    featureLookbackContinuityStatus: "COMPLETE",
    upstreamExpectedFrameCount: 0,
    upstreamObservedFrameCount: 0,
    upstreamSequenceContinuityStatus: "COMPLETE",
    upstreamClockGridStatus: "DENSE",
    upstreamNoTradeFrameCount: 0,
    upstreamNoTradeRanges: [],
    upstreamFirstExpectedFrameAt: null,
    upstreamEndExclusiveAt: null,
    upstreamMissingFrameCount: 0,
    upstreamDuplicateFrameCount: 0,
    upstreamOffGridFrameCount: 0,
    upstreamMissingRanges: [],
    upstreamDuplicateInstants: [],
    upstreamOffGridInstants: [],
    featureLookbackAffectedFrameCount: 0,
    featureLookbackAffectedRanges: [],
  });
});

test("conditional ADD cadence coverage rejects a complete window with incomplete upstream replay state", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    replayStartAt: "2026-07-30T00:00:00.000Z",
    from: "2026-07-30T03:00:00.000Z",
    to: "2026-07-30T06:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T03:00:00.000Z" },
      { generatedAt: "2026-07-30T04:00:00.000Z" },
      { generatedAt: "2026-07-30T05:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [],
  });

  assert.equal(coverage.windowCadenceStatus, "COMPLETE");
  assert.equal(coverage.missingFrameCount, 0);
  assert.equal(coverage.upstreamStateContinuityStatus, "INCOMPLETE");
  assert.equal(coverage.upstreamMissingFrameCount, 2);
  assert.deepEqual(coverage.upstreamMissingRanges.map(({ firstMissingAt, lastMissingAt }) => ({
    firstMissingAt,
    lastMissingAt,
  })), [{
    firstMissingAt: "2026-07-30T01:00:00.000Z",
    lastMissingAt: "2026-07-30T02:00:00.000Z",
  }]);
  assert.equal(
    coverage.upstreamMissingRanges[0]?.nextObservedAt,
    "2026-07-30T03:00:00.000Z",
  );
  assert.equal(coverage.status, "INCOMPLETE");
});

test("conditional ADD cadence treats approved sparse 1h closes as no-trade evidence", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T06:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T03:00:00.000Z" },
      { generatedAt: "2026-07-30T04:00:00.000Z" },
      { generatedAt: "2026-07-30T05:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [{
      firstMissingCloseTime: "2026-07-30T01:00:00.000Z",
      lastMissingCloseTime: "2026-07-30T02:00:00.000Z",
      missingCandleCount: 2,
      previousObservedCloseTime: "2026-07-30T00:00:00.000Z",
      nextObservedCloseTime: "2026-07-30T03:00:00.000Z",
    }],
  });

  assert.equal(coverage.status, "COMPLETE");
  assert.equal(coverage.windowCadenceStatus, "INCOMPLETE");
  assert.equal(coverage.windowSequenceContinuityStatus, "COMPLETE");
  assert.equal(coverage.windowClockGridStatus, "SPARSE_BY_CONTRACT");
  assert.equal(coverage.observedFrameCount, 4);
  assert.equal(coverage.noTradeFrameCount, 2);
  assert.equal(coverage.missingFrameCount, 0);
  assert.deepEqual(coverage.noTradeRanges.map((range) => ({
    firstMissingAt: range.firstMissingAt,
    lastMissingAt: range.lastMissingAt,
    missingFrameCount: range.missingFrameCount,
  })), [{
    firstMissingAt: "2026-07-30T01:00:00.000Z",
    lastMissingAt: "2026-07-30T02:00:00.000Z",
    missingFrameCount: 2,
  }]);
  assert.deepEqual(coverage.missingRanges, []);
});

test("conditional ADD cadence rejects no-trade collisions before inside and after the selected replay range", () => {
  const base = {
    from: "2026-07-30T03:00:00.000Z",
    to: "2026-07-30T06:00:00.000Z",
    replayStartAt: "2026-07-30T03:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T03:00:00.000Z" },
      { generatedAt: "2026-07-30T04:00:00.000Z" },
      { generatedAt: "2026-07-30T05:00:00.000Z" },
      { generatedAt: "2026-07-30T06:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
  };
  for (const closeTime of [
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T03:00:00.000Z",
    "2026-07-30T06:00:00.000Z",
  ]) {
    assert.throws(
      () => calculateConditionalAddCadenceCoverage({
        ...base,
        noTradeFrameRanges: [{
          firstMissingCloseTime: closeTime,
          lastMissingCloseTime: closeTime,
          missingCandleCount: 1,
          previousObservedCloseTime: null,
          nextObservedCloseTime: null,
        }],
      }),
      /cannot classify an observed frame as no-trade/,
    );
  }
});

test("conditional ADD cadence rejects malformed and non-canonical no-trade range evidence", () => {
  const base = {
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T06:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T03:00:00.000Z" },
      { generatedAt: "2026-07-30T04:00:00.000Z" },
      { generatedAt: "2026-07-30T05:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
  };
  const range = (firstMissingCloseTime: string, lastMissingCloseTime: string, missingCandleCount: number) => ({
    firstMissingCloseTime,
    lastMissingCloseTime,
    missingCandleCount,
    previousObservedCloseTime: null,
    nextObservedCloseTime: null,
  });

  assert.throws(() => calculateConditionalAddCadenceCoverage({
    ...base,
    noTradeFrameRanges: [range("2026-07-30T01:00:00.000Z", "2026-07-30T02:00:00.000Z", 1)],
  }), /timestamp span must match missingCandleCount/);
  assert.throws(() => calculateConditionalAddCadenceCoverage({
    ...base,
    noTradeFrameRanges: [range("2026-07-30T01:30:00.000Z", "2026-07-30T01:30:00.000Z", 1)],
  }), /must align to expectedFrameIntervalMs/);
  assert.throws(() => calculateConditionalAddCadenceCoverage({
    ...base,
    noTradeFrameRanges: [
      range("2026-07-30T01:00:00.000Z", "2026-07-30T02:00:00.000Z", 2),
      range("2026-07-30T02:00:00.000Z", "2026-07-30T02:00:00.000Z", 1),
    ],
  }), /strictly ordered and non-overlapping/);
  assert.throws(() => calculateConditionalAddCadenceCoverage({
    ...base,
    noTradeFrameRanges: [
      range("2026-07-30T01:00:00.000Z", "2026-07-30T01:00:00.000Z", 1),
      range("2026-07-30T02:00:00.000Z", "2026-07-30T02:00:00.000Z", 1),
    ],
  }), /must be canonical and non-adjacent/);
});

test("conditional ADD cadence clips no-trade evidence at selected boundaries without creating frames", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    from: "2026-07-30T03:00:00.000Z",
    to: "2026-07-30T06:00:00.000Z",
    replayStartAt: "2026-07-30T00:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [{
      firstMissingCloseTime: "2026-07-30T01:00:00.000Z",
      lastMissingCloseTime: "2026-07-30T07:00:00.000Z",
      missingCandleCount: 7,
      previousObservedCloseTime: "2026-07-30T00:00:00.000Z",
      nextObservedCloseTime: null,
    }],
  });

  assert.equal(coverage.status, "COMPLETE");
  assert.equal(coverage.observedFrameCount, 0);
  assert.equal(coverage.noTradeFrameCount, 3);
  assert.equal(coverage.missingFrameCount, 0);
  assert.deepEqual(coverage.noTradeRanges, [{
    firstMissingAt: "2026-07-30T03:00:00.000Z",
    lastMissingAt: "2026-07-30T05:00:00.000Z",
    missingFrameCount: 3,
    previousObservedAt: null,
    nextObservedAt: null,
  }]);
  assert.equal(coverage.upstreamNoTradeFrameCount, 2);
  assert.deepEqual(coverage.upstreamNoTradeRanges, [{
    firstMissingAt: "2026-07-30T01:00:00.000Z",
    lastMissingAt: "2026-07-30T02:00:00.000Z",
    missingFrameCount: 2,
    previousObservedAt: "2026-07-30T00:00:00.000Z",
    nextObservedAt: null,
  }]);
});

test("conditional ADD cadence ignores wholly outside no-trade ranges without synthesizing evidence", () => {
  const coverage = calculateConditionalAddCadenceCoverage({
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T03:00:00.000Z",
    expectedFrameIntervalMs: 3_600_000,
    frames: [
      { generatedAt: "2026-07-30T00:00:00.000Z" },
      { generatedAt: "2026-07-30T01:00:00.000Z" },
      { generatedAt: "2026-07-30T02:00:00.000Z" },
    ],
    featureLookbackAffectedRanges: [],
    noTradeFrameRanges: [{
      firstMissingCloseTime: "2026-07-30T07:00:00.000Z",
      lastMissingCloseTime: "2026-07-30T08:00:00.000Z",
      missingCandleCount: 2,
      previousObservedCloseTime: null,
      nextObservedCloseTime: null,
    }],
  });

  assert.equal(coverage.status, "COMPLETE");
  assert.equal(coverage.noTradeFrameCount, 0);
  assert.deepEqual(coverage.noTradeRanges, []);
});

test("Task 6 candle fixtures use exact timeframe durations", () => {
  const dataset = createDataset("BTC");
  const expectedDurationMs: Record<ResearchCandleTimeframe, number> = {
    "1h": 60 * 60 * 1_000,
    "4h": 4 * 60 * 60 * 1_000,
    "1d": 24 * 60 * 60 * 1_000,
  };

  for (const timeframe of ["1h", "4h", "1d"] as const) {
    assert.ok(dataset.candles[timeframe].every((candle) =>
      Date.parse(candle.closeTime) - Date.parse(candle.openTime) === expectedDurationMs[timeframe]
    ));
  }
});

test("fixture resource guard releases acquired setup when a later step fails", async () => {
  const released: string[] = [];
  await assert.rejects(
    withFixtureResource(
      async () => "database",
      async (resource) => { released.push(resource); },
      async () => { throw new Error("later fixture setup failed"); },
    ),
    /later fixture setup failed/,
  );
  assert.deepEqual(released, ["database"]);
});

test("observed-only mode never calls the dataset reader and reports unavailable datasets", async () => {
  const databasePath = await createDisposableDatabase("observed-only");
  try {
    const options = parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--database", databasePath));
    let datasetReadCount = 0;
    const before = await sha256File(databasePath);
    const report = await buildIntegratedStrategyEvaluation(options, {
      readDataset: async () => {
        datasetReadCount += 1;
        throw new Error("dataset reader must not be called");
      },
    });
    const after = await sha256File(databasePath);

    assert.equal(datasetReadCount, 0);
    assert.equal(before, after, "read-only evaluation must not mutate the disposable SQLite fixture");
    assert.equal(report.observedLive.evidenceKind, "OBSERVED_LIVE_ATTRIBUTION");
    assert.equal(report.observedLive.provenance.filters.periodSemantics, "[from,to)");
    assert.deepEqual(
      report.simulatedCounterfactuals.assets.map((asset) => [asset.asset, asset.status]),
      [["BTC", "DATASET_UNAVAILABLE"], ["ETH", "DATASET_UNAVAILABLE"]],
    );
    assert.deepEqual(
      report.evidenceGaps.filter((gap) => gap.code === "DATASET_UNAVAILABLE").map((gap) => gap.asset),
      ["BTC", "ETH"],
    );
    assert.equal(
      report.evidenceGaps.find((gap) => gap.code === "MARK_DATA_UNAVAILABLE")?.evidenceKind,
      "OBSERVED_LIVE_ATTRIBUTION",
    );
    assert.match(formatIntegratedStrategyEvaluation(report, "text"), /DATASET_UNAVAILABLE/);
  } finally {
    await cleanupFixture(databasePath);
  }
});

for (const fixture of OBSERVED_MARK_CASES) {
  test(`observed mark gap maps ${fixture.label} diagnostics evidence`, async () => {
    await withFixtureResource(
      () => createDisposableDatabase(
        `mark-${fixture.label}`,
        (db) => seedObservedMarkFixture(db, fixture.marks),
      ),
      cleanupFixture,
      async (databasePath) => {
        const report = await buildIntegratedStrategyEvaluation(
          parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--database", databasePath)),
        );
        const curve = report.observedLive.diagnostics.markPnlCurve;
        const markGaps = report.evidenceGaps.filter((gap) => gap.code.startsWith("MARK_DATA_"));

        assert.equal(curve.persistedObservationCount, fixture.persisted);
        assert.equal(curve.usableObservationCount, fixture.usable);
        assert.equal(curve.gross.status, fixture.metricStatus);
        assert.deepEqual(
          curve.excludedObservations.map((exclusion) => exclusion.snapshotId),
          fixture.excludedSnapshotIds,
        );
        assert.deepEqual(markGaps.map((gap) => gap.code), fixture.gapCode === null ? [] : [fixture.gapCode]);
        if (fixture.gapCode !== null) {
          const gap = markGaps[0];
          assert.deepEqual(gap?.affectedMetrics, [
            "observedLive.diagnostics.markPnlCurve",
            "observedLive.diagnostics.marketMarkPnlCurves",
          ]);
          assert.deepEqual(gap?.evidenceIds, fixture.excludedSnapshotIds);
          assert.match(gap?.message ?? "", new RegExp(`persisted=${fixture.persisted}, usable=${fixture.usable}`));
          if (fixture.excludedSnapshotIds.length > 0) {
            assert.match(gap?.message ?? "", /MISSING_ACTIVE_POSITION_MARK=1/);
            const text = formatIntegratedStrategyEvaluation(report, "text");
            assert.doesNotMatch(text, /Observed mark exclusions:/);
            assert.doesNotMatch(text, /Observed mark exclusion:/);
          }
        }
        if (fixture.metricStatus === "UNKNOWN") {
          assert.deepEqual(curve.gross, { status: "UNKNOWN", reasons: ["MISSING_MARK_OR_COST"] });
          assert.match(formatIntegratedStrategyEvaluation(report, "text"), /MISSING_MARK_OR_COST/);
        }
      },
    );
  });
}

test("same-epoch mark coalescing does not create a false partial-evidence gap", async () => {
  await withFixtureResource(
    () => createDisposableDatabase(
      "mark-same-epoch-coalescing",
      (db) => seedObservedMarkFixture(db, ["110", "110"], {
        capturedAts: ["2026-08-01T02:00:00.000Z", "2026-08-01T11:00:00.000+09:00"],
      }),
    ),
    cleanupFixture,
    async (databasePath) => {
      const report = await buildIntegratedStrategyEvaluation(
        parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--database", databasePath)),
      );
      const curve = report.observedLive.diagnostics.markPnlCurve;

      assert.equal(curve.persistedObservationCount, 2);
      assert.equal(curve.usableObservationCount, 1);
      assert.deepEqual(
        curve.excludedObservations.filter((item) => item.metricScopes.includes("GROSS")),
        [],
      );
      assert.deepEqual(
        report.evidenceGaps.filter((gap) => gap.code.startsWith("MARK_DATA_")),
        [],
      );
    },
  );
});

test("gross mark gaps do not attribute NET-only fee reasons", async () => {
  await withFixtureResource(
    () => createDisposableDatabase(
      "mark-gross-reason-scope",
      (db) => seedObservedMarkFixture(db, [null], { feeAmount: null }),
    ),
    cleanupFixture,
    async (databasePath) => {
      const report = await buildIntegratedStrategyEvaluation(
        parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--database", databasePath)),
      );
      const gap = report.evidenceGaps.find((item) => item.code === "MARK_DATA_UNUSABLE");

      assert.match(gap?.message ?? "", /MISSING_ACTIVE_POSITION_MARK=1/);
      assert.doesNotMatch(gap?.message ?? "", /INCOMPLETE_REMAINING_BUY_FEE/);
    },
  );
});

test("observed attribution keeps selected-stream and opening-inventory evidence separate", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("observed-separation", seedObservedSeparationFixture),
    cleanupFixture,
    async (databasePath) => {
      const report = await buildIntegratedStrategyEvaluation(
        parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--database", databasePath)),
      );
      const attribution = report.observedLive.attribution as unknown as {
        totals: unknown;
        openingInventoryTotals: unknown;
        actionDimensions: {
          exit: {
            sourceContributions: Record<string, Record<string, { realizedQuantity: number }>>;
          };
        };
      };

      assert.deepEqual(attribution.totals, {
        realizedQuantity: 1,
        grossPnlKrw: { status: "KNOWN", value: 20 },
        observedFeeImpactKrw: { status: "KNOWN", value: 2 },
        netPnlKrw: { status: "KNOWN", value: 18 },
      });
      assert.deepEqual(attribution.openingInventoryTotals, {
        realizedQuantity: 1,
        grossPnlKrw: { status: "KNOWN", value: 20 },
        observedFeeImpactKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
        netPnlKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
      });
      assert.equal(
        attribution.actionDimensions.exit.sourceContributions.SELECTED_STREAM?.EXIT?.realizedQuantity,
        1,
      );
      assert.equal(
        attribution.actionDimensions.exit.sourceContributions.OPENING?.EXIT?.realizedQuantity,
        1,
      );
      assert.match(formatIntegratedStrategyEvaluation(report, "text"), /"openingInventoryTotals"/);
    },
  );
});

test("supplied empty insufficient and non-overlapping datasets are structured as unusable", async () => {
  const unusableCases = [
    {
      label: "empty",
      reasonCode: "EMPTY_TIMEFRAME_CANDLES",
      dataset: createDataset("BTC", {
        candleCounts: { "1h": 0, "4h": 0, "1d": 0 },
      }),
    },
    {
      label: "insufficient",
      reasonCode: "INSUFFICIENT_COMPLETED_CANDLES",
      dataset: createDataset("BTC", {
        candleCounts: { "1h": 199, "4h": 199, "1d": 199 },
      }),
    },
    {
      label: "non-overlap",
      reasonCode: "NO_OVERLAPPING_REPLAY_WINDOW",
      dataset: createDataset("BTC", {
        endOffsetsMs: { "1h": -400 * 24 * 60 * 60 * 1_000 },
      }),
    },
  ] as const;

  await withFixtureResource(
    () => createDisposableDatabase("unusable-datasets"),
    cleanupFixture,
    async (databasePath) => {
      for (const fixture of unusableCases) {
        const options = parseIntegratedStrategyEvaluationArgs(
          replaceArg(simulationArgs("BTC", `${fixture.label}.json`), "--database", databasePath),
        );
        const report = await buildIntegratedStrategyEvaluation(options, {
          readDataset: async () => fixture.dataset,
        });
        const sectionGroups = [
          report.simulatedCounterfactuals.assets,
          report.costSensitivity.assets,
          report.regimeAnalysis.assets,
          report.excursionAnalysis.assets,
        ];

        for (const sections of sectionGroups) {
          const section = requireAssetSection(sections, "BTC");
          assert.equal(section.status, "DATASET_UNUSABLE");
          assert.equal(section.reasonCode, fixture.reasonCode);
          assert.equal(Object.hasOwn(section, "scenarios"), false);
          assert.equal(Object.hasOwn(section, "cells"), false);
          assert.equal(Object.hasOwn(section, "analyses"), false);
        }
        const gap = report.evidenceGaps.find((item) => item.code === "DATASET_UNUSABLE");
        assert.equal(gap?.asset, "BTC");
        assert.match(gap?.message ?? "", new RegExp(fixture.reasonCode));
        assert.match(formatIntegratedStrategyEvaluation(report, "text"), /DATASET_UNUSABLE/);
      }
    },
  );
});

test("fixture datasets produce deterministic independent-capital evidence in text and JSON", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("fixture-mode"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC"),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        // The outer resource owns the shared dataset directory if ETH setup fails.
        const ethPath = await writeDatasetFixture("ETH");
        const options = parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(requiredArgs(), "--database", databasePath),
          "--btc-dataset", btcPath,
          "--btc-initial-state", "{\"cashKrw\":1000000,\"quantity\":0,\"averageEntryPriceKrw\":0}",
          "--eth-dataset", ethPath,
          "--eth-initial-state", "{\"cashKrw\":2000000,\"quantity\":0,\"averageEntryPriceKrw\":0}",
          ...sharedSimulationArgs(),
        ]);

        const first = await buildIntegratedStrategyEvaluation(options);
        const second = await buildIntegratedStrategyEvaluation(options);
        const firstJson = formatIntegratedStrategyEvaluation(first, "json");
        const secondJson = formatIntegratedStrategyEvaluation(second, "json");
        const text = formatIntegratedStrategyEvaluation(first, "text");

        assert.equal(firstJson, secondJson);
        assert.equal(first.provenance.capitalSemantics, "INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO");
        assert.deepEqual(first.provenance.datasets.map((dataset) => dataset.asset), ["BTC", "ETH"]);
        assert.deepEqual(first.provenance.datasets.map((dataset) => dataset.initialState.cashKrw), [1_000_000, 2_000_000]);
        assert.ok(first.provenance.datasets.every((dataset) => dataset.sha256.length === 64));
        assert.ok(first.simulatedCounterfactuals.assets.every((asset) => asset.status === "AVAILABLE"));
        assert.ok(first.costSensitivity.assets.every((asset) => asset.status === "AVAILABLE"));
        assert.ok(first.regimeAnalysis.assets.every((asset) => asset.status === "AVAILABLE"));
        assert.ok(first.excursionAnalysis.assets.every((asset) => asset.status === "AVAILABLE"));
        assert.ok(first.addDiagnostics.assets.every((asset) => asset.status === "AVAILABLE"));
        for (const asset of first.addDiagnostics.assets) {
          if (asset.status !== "AVAILABLE") continue;
          assert.equal(asset.analyses.length, 2);
          assert.ok(asset.analyses.every((entry) => entry.analysis.causalClaim === false));
          assert.ok(asset.analyses.every((entry) => entry.postDecisionExcursions.causalClaim === false));
          assert.ok(asset.analyses.every((entry) =>
            entry.postDecisionExcursions.exposures.length === entry.analysis.exposures.length));
        }
        assert.equal(first.evidenceGaps.some((gap) =>
          gap.code === "POST_DECISION_EXCURSION_NOT_IMPLEMENTED"), false);
        assert.equal(first.evidenceGaps.some((gap) =>
          gap.code === "COST_FEE_ATTRIBUTION_NOT_IMPLEMENTED"), false);
        assert.equal(Object.hasOwn(first.simulatedCounterfactuals, "portfolioReturnPct"), false);
        assert.equal(Object.hasOwn(first.costSensitivity, "portfolioReturnPct"), false);
        assert.match(text, /OBSERVED_LIVE_ATTRIBUTION/);
        assert.match(text, /SIMULATED_COUNTERFACTUAL/);
        assert.match(text, /MODELED_COST_SCENARIO/);
        assert.match(text, /ADD Decision Diagnostics/);
        assert.match(text, /INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO/);
        for (const finding of first.interpretation) {
          for (const metricId of finding.metricIds) {
            assert.notEqual(resolveJsonPointer(first, metricId), undefined, `Unresolved metricId ${metricId}`);
          }
        }
        assert.match(text, /Human Summary/);
        assert.match(text, /Observed selected stream: fills=0; completed_episodes=0; sample_support=INSUFFICIENT/);
        assert.match(text, /BTC simulation: status=AVAILABLE; base_cost=observed-fee/);
        assert.match(text, /BTC cost observed-fee\/BASELINE: return_pct=/);
        assert.match(text, /Evidence gaps: count=/);
        assert.match(text, /Technical Sections \(complete JSON facts\)/);
        for (const checksum of first.provenance.datasets.map((dataset) => dataset.sha256)) {
          assert.match(text, new RegExp(checksum));
        }
        const parsedJson = JSON.parse(firstJson) as IntegratedStrategyEvaluationReport;
        assert.deepEqual(parsedJson, first);
        assert.match(firstJson, /"NOT_APPLICABLE"|"UNKNOWN"/);
        assert.doesNotMatch(firstJson, /NaN|Infinity/);
      },
    ),
  );
});

test("counterfactual return ratios are described as scaled percentage-point deltas", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("percentage-point-delta"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "percentage-point-delta"),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const options = parseIntegratedStrategyEvaluationArgs(
          replaceArg(simulationArgs("BTC", btcPath), "--database", databasePath),
        );
        const report = await buildIntegratedStrategyEvaluation(options);
        const simulationAssets = structuredClone(report.simulatedCounterfactuals.assets);
        const btc = simulationAssets.find((item) => item.asset === "BTC");
        if (btc?.status !== "AVAILABLE") throw new Error("Expected an available BTC fixture.");
        const baseline = btc.scenarios.find((item) => item.scenario === "BASELINE");
        const noAdd = btc.scenarios.find((item) => item.scenario === "NO_ADD");
        if (!baseline || !noAdd) throw new Error("Expected BASELINE and NO_ADD fixture scenarios.");
        baseline.metrics.totalReturnPct = 0.01;
        noAdd.metrics.totalReturnPct = 0.03;

        const finding = buildInterpretation(report.observedLive.attribution, simulationAssets)
          .find((item) => item.code === "COUNTERFACTUAL_SCENARIO_DELTA" && item.asset === "BTC");

        assert.equal(baseline.metrics.totalReturnPct, 0.01);
        assert.equal(noAdd.metrics.totalReturnPct, 0.03);
        assert.match(finding?.text ?? "", /higher than BASELINE by 2 percentage points/);
      },
    ),
  );
});

test("summarized cost cells retain cost and FIFO outcome metric scopes", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("cost-cell-scopes"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "cost-cell-scopes"),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const options = parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(requiredArgs(), "--database", databasePath),
          "--btc-dataset", btcPath,
          "--btc-initial-state", "{\"cashKrw\":1000000,\"quantity\":0,\"averageEntryPriceKrw\":0}",
          ...sharedSimulationArgs(),
        ]);

        const report = await buildIntegratedStrategyEvaluation(options);
        const btc = report.costSensitivity.assets.find((asset) => asset.asset === "BTC");
        assert.equal(btc?.status, "AVAILABLE");
        if (btc?.status !== "AVAILABLE") throw new Error("Expected available BTC cost sensitivity.");
        assert.ok(btc.cells.length > 0);
        for (const cell of btc.cells) {
          assert.equal(cell.costMetricScope, "ALL_SIMULATED_FILLS");
          assert.equal(cell.fifoOutcomeMetricScope, "SELECTED_STREAM_FIFO");
        }
      },
    ),
  );
});

test("ADD diagnostics reports a missing BASELINE or NO_ADD pair instead of an empty available analysis", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("add-scenario-pair"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "add-scenario-pair"),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const options = parseIntegratedStrategyEvaluationArgs(
          replaceArg(
            replaceArg(simulationArgs("BTC", btcPath), "--database", databasePath),
            "--scenarios",
            '["BASELINE"]',
          ),
        );

        const report = await buildIntegratedStrategyEvaluation(options);
        const btc = report.addDiagnostics.assets.find((asset) => asset.asset === "BTC");

        assert.equal(btc?.status, "SCENARIO_PAIR_UNAVAILABLE");
        assert.match(btc?.message ?? "", /BASELINE and NO_ADD/);
      },
    ),
  );
});

test("integrated evaluation exposes optional anchored forward stability by asset and cost cell", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("stability-integration"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "stability-integration", {
        candleCounts: { "1h": 230, "4h": 230, "1d": 230 },
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const options = parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(simulationArgs("BTC", btcPath), "--database", databasePath),
          "--validation-windows",
          '[{"id":"w1","from":"2026-07-30T00:00:00Z","to":"2026-07-31T00:00:00Z"},{"id":"w2","from":"2026-07-31T00:00:00Z","to":"2026-08-01T00:00:00Z"}]',
          "--validation-frame-interval-ms", "3600000",
          "--validation-comparison-tolerance-pp", "0.000001",
          "--validation-minimum-windows", "2",
        ]);

        const report = await buildIntegratedStrategyEvaluation(options);
        assert.equal(report.stabilityValidation?.evidenceKind, "SIMULATED_COUNTERFACTUAL_STABILITY");
        const btc = report.stabilityValidation?.assets.find((item) => item.asset === "BTC");
        assert.equal(btc?.status, "AVAILABLE");
        if (btc?.status !== "AVAILABLE") throw new Error("Expected available BTC stability.");
        assert.equal(btc.analyses.length, 2);
        assert.ok(btc.analyses.every((analysis) => analysis.windows.length === 2));
        assert.equal(btc.analyses[0]?.pathSemantics, "CONTINUOUS_FORWARD_PATH_NO_WINDOW_RESET");
        const textReport = formatIntegratedStrategyEvaluation(report, "text");
        assert.match(textReport, /BTC stability cost observed-fee: overall=/);
        assert.match(textReport, /BTC stability observed-fee\/w1: classification=/);
        assert.match(textReport, /completed_episodes=baseline:\d+,no_add:\d+/);
        assert.match(textReport, /policy_exposure=\d+; coverage=/);
        assert.match(textReport, /Anchored Forward Stability/);
        assert.deepEqual(JSON.parse(formatIntegratedStrategyEvaluation(report, "json")), report);
      },
    ),
  );
});

test("conditional ADD evaluation reports a stable BTC and ETH candidate matrix without changing legacy analyses", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("conditional-add-integration"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "conditional-add-integration", {
        commonCoverageDays: 260,
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const ethPath = await writeDatasetFixture("ETH", "conditional-add-integration", {
          commonCoverageDays: 260,
        });
        const options = parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(requiredArgs(), "--database", databasePath),
          "--btc-dataset", btcPath,
          "--btc-initial-state", '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}',
          "--eth-dataset", ethPath,
          "--eth-initial-state", '{"cashKrw":2000000,"quantity":0,"averageEntryPriceKrw":0}',
          ...conditionalResearchArgs(),
        ]);

        const first = await buildIntegratedStrategyEvaluation(options);
        const second = await buildIntegratedStrategyEvaluation(options);
        const firstJson = formatIntegratedStrategyEvaluation(first, "json");
        const section = requireConditionalAddPolicyEvaluation(first);
        const addLossAttribution = first.addLossAttribution;

        assert.equal(firstJson, formatIntegratedStrategyEvaluation(second, "json"));
        assert.equal(section.status, "AVAILABLE");
        assert.equal(section.deploymentApproval, false);
        assert.match(section.warning, /not deployment approval/i);
        assert.deepEqual(section.windows.map((window) => window.id), ["W1", "W2", "W3"]);
        assert.deepEqual(section.assets.map((asset) => [asset.asset, asset.status]), [
          ["BTC", "AVAILABLE"],
          ["ETH", "AVAILABLE"],
        ]);
        assert.ok(first.provenance.datasets.every((dataset) =>
          dataset.featureCoverage !== undefined
          && dataset.featureCoverage.status === "COMPLETE"
          && dataset.featureCoverage.continuityPolicy === "GENERATED_CANDLES_SINCE_DATASET_START"));
        for (const asset of section.assets) {
          if (asset.status !== "AVAILABLE") continue;
          assert.deepEqual(asset.candidates.map((candidate) => candidate.candidate), [
            "ADD_RISK_CLEAR",
            "ADD_HIGH_ALIGNMENT",
            "ADD_CORE_TREND",
          ]);
          for (const candidate of asset.candidates) {
            assert.deepEqual(Object.keys(candidate.costAnchors), ["BASE", "STRESS"]);
            assert.equal(candidate.costAnchors.BASE.feeRate, 0.0005);
            assert.equal(candidate.costAnchors.BASE.slippageRate, 0.0003);
            assert.equal(candidate.costAnchors.STRESS.feeRate, 0.001);
            assert.equal(candidate.costAnchors.STRESS.slippageRate, 0.002);
            assert.equal(candidate.observations.fullPath.observations.length, 6);
            assert.equal(candidate.observations.windows.length, 3);
            assert.ok(Number.isSafeInteger(
              candidate.gates.policyExposedCompletedEpisodes.fullPathObservedCount,
            ));
            assert.ok(candidate.gates.policyExposedCompletedEpisodes.windows.every((window) =>
              Number.isSafeInteger(window.observedCount)));
            assert.equal(candidate.gates.frameCoverage.fullPath.missingFrameCount, 0);
            assert.deepEqual(candidate.gates.frameCoverage.fullPath.missingRanges, []);
            assert.equal(candidate.gates.frameCoverage.fullPath.featureLookbackContinuityStatus, "COMPLETE");
            assert.equal(candidate.gates.frameCoverage.fullPath.featureLookbackAffectedFrameCount, 0);
            assert.ok(candidate.gates.frameCoverage.windows.every((window) =>
              window.upstreamStateContinuityStatus === "COMPLETE"));
          }
        }

        const legacyStabilityScenarios = first.stabilityValidation?.assets.flatMap((asset) =>
          asset.status === "AVAILABLE"
            ? asset.analyses.flatMap((analysis) => analysis.windows.flatMap((window) => [
                window.baseline.scenario,
                window.noAdd.scenario,
              ]))
            : []
        ) ?? [];
        assert.ok(legacyStabilityScenarios.every((scenario) =>
          scenario === "BASELINE" || scenario === "NO_ADD"));
        assert.ok(first.addDiagnostics.assets.every((asset) =>
          asset.status !== "AVAILABLE" || asset.analyses.length === 2));

        assert.ok(addLossAttribution, "full BTC/ETH conditional matrix must include ADD loss attribution");
        assert.equal(addLossAttribution.selectedFlowAttribution, true);
        assert.equal(addLossAttribution.causalClaim, false);
        assert.equal(addLossAttribution.deploymentApproval, false);
        assert.deepEqual(addLossAttribution.assets.map((item) => item.asset), ["BTC", "ETH"]);
        assert.deepEqual(addLossAttribution.provenance.candidateIds, [
          "ADD_RISK_CLEAR",
          "ADD_HIGH_ALIGNMENT",
          "ADD_CORE_TREND",
        ]);
        assert.deepEqual(addLossAttribution.provenance.validationWindowIds, ["W1", "W2", "W3"]);
        assert.deepEqual(addLossAttribution.provenance.costScenarioIds, ["base", "stress"]);
        assert.equal(addLossAttribution.provenance.attributionCostScenarioId, "base");
        assert.equal(addLossAttribution.provenance.selectedFlow.databasePath, databasePath);
        assert.deepEqual(
          addLossAttribution.provenance.policySuppressionEvidence.map((item) => item.asset),
          ["BTC", "ETH"],
        );
        assert.ok(addLossAttribution.provenance.policySuppressionEvidence.every((item) =>
          item.policies.map((policy) => policy.policyId).join(",")
            === "ADD_RISK_CLEAR,ADD_HIGH_ALIGNMENT,ADD_CORE_TREND"));
        assert.deepEqual(
          addLossAttribution.assets.flatMap((item) =>
            item.policySuppressedCohorts.flatMap((policy) => policy.suppressionEvidenceIds)
          ),
          addLossAttribution.provenance.suppressionEvidenceIds,
        );
        assert.deepEqual(
          addLossAttribution.holdoutHypotheses.hypotheses.map((item) => item.candidate),
          ["ADD_CORE_TREND", "ADD_HIGH_ALIGNMENT", "ADD_RISK_CLEAR"],
        );
        const emptySuppressionCases = addLossAttribution.assets.flatMap((asset) =>
          asset.policySuppressedCohorts
            .filter((cohort) => cohort.suppressionEvidenceIds.length === 0)
            .map((cohort) => ({ asset: asset.asset, policyId: cohort.policyId }))
        );
        assert.ok(emptySuppressionCases.length > 0, "fixture must exercise a configured policy with zero suppressions");
        for (const empty of emptySuppressionCases) {
          const hypothesis: (typeof addLossAttribution.holdoutHypotheses.hypotheses)[number] | undefined =
            addLossAttribution.holdoutHypotheses.hypotheses.find(
            (item) => item.candidate === empty.policyId,
          );
          assert.ok(hypothesis);
          assert.equal(hypothesis.status, "INSUFFICIENT");
          assert.ok(hypothesis.reasonCodes.includes(
            empty.asset === "BTC"
              ? "BTC_SUPPRESSED_CONTRIBUTION_INCOMPLETE"
              : "ETH_SUPPRESSED_CONTRIBUTION_INCOMPLETE",
          ));
        }

        const text = formatIntegratedStrategyEvaluation(first, "text");
        assert.match(text, /Conditional ADD Policy Evaluation/);
        assert.match(text, /ADD_RISK_CLEAR/);
        assert.match(text, /policy_exposed_completed_episodes=/);
        assert.match(text, /not deployment approval/i);
        assert.match(text, /ADD Loss Attribution/);
        assert.match(text, /BTC ADD totals:/);
        assert.match(text, /ETH ADD totals:/);
        assert.match(text, /known_net_denominator=/);
        assert.match(text, /policy suppressed ADD_RISK_CLEAR:/);
        assert.match(text, /Cross-asset holdout ADD_CORE_TREND:/);
        assert.match(text, /selected-flow attribution; not account return/i);
        assert.match(text, /not causal proof/i);
        assert.doesNotMatch(text, /\n\[ADD Loss Attribution\]\n/);
        assert.doesNotMatch(text, /"analysisKind": "ADD_LOSS_ATTRIBUTION_AND_HOLDOUT_HYPOTHESIS"/);
        assert.deepEqual(JSON.parse(firstJson), first);

        const boundedReport = structuredClone(first);
        const boundedBtc = boundedReport.addLossAttribution?.assets.find((item) => item.asset === "BTC");
        assert.ok(boundedBtc);
        const negativeCohorts: Array<(typeof boundedBtc.cohorts.byRegime)[number]> = [1, 2, 3, 4].map((index) => ({
          ...structuredClone(boundedBtc.aggregate),
          dimension: "REGIME" as const,
          value: `LOSS_${index}`,
          executedAddCount: 1,
          knownNetContributionCount: 1,
          netRealizedContributionKrw: {
            completeness: "COMPLETE" as const,
            knownCount: 1,
            unknownCount: 0,
            knownSubtotal: { status: "KNOWN" as const, value: -index },
            total: { status: "KNOWN" as const, value: -index },
          },
        }));
        negativeCohorts.push({
          ...structuredClone(boundedBtc.aggregate),
          dimension: "REGIME" as const,
          value: "PARTIAL_KNOWN_LOSS",
          executedAddCount: 2,
          knownNetContributionCount: 1,
          netRealizedContributionKrw: {
            completeness: "PARTIAL" as const,
            knownCount: 1,
            unknownCount: 1,
            knownSubtotal: { status: "KNOWN" as const, value: -10 },
            total: { status: "UNKNOWN" as const, reasons: ["INCOMPLETE_CONTRIBUTION_EVIDENCE"] },
          },
        });
        (boundedBtc.cohorts as unknown as { byRegime: typeof negativeCohorts }).byRegime = negativeCohorts;
        const boundedText = formatIntegratedStrategyEvaluation(boundedReport, "text");
        const boundedLossLines = boundedText.split("\n").filter((line) =>
          line.startsWith("BTC loss cohort REGIME="));
        assert.equal(boundedLossLines.length, 3);
        assert.match(boundedLossLines[0] ?? "", /PARTIAL_KNOWN_LOSS/);
        assert.match(boundedLossLines[0] ?? "", /known_net_denominator=1\/2/);
        assert.match(boundedLossLines[0] ?? "", /known_net_subtotal=-10/);
        assert.match(boundedLossLines[0] ?? "", /net_completeness=PARTIAL/);
        assert.match(boundedLossLines[1] ?? "", /LOSS_4/);
        assert.match(boundedLossLines[2] ?? "", /LOSS_3/);
        assert.doesNotMatch(boundedText, /BTC loss cohort REGIME=LOSS_2/);
        assert.doesNotMatch(boundedText, /BTC loss cohort REGIME=LOSS_1/);
      },
    ),
  );
});

test("conditional ADD evaluation preserves sparse source evidence without making no-trade intervals insufficient", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("conditional-add-sparse-source"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("BTC", "conditional-add-sparse-source", {
        commonCoverageDays: 260,
        missingCloseTimes: {
          "1h": ["2026-07-30T01:00:00.000Z", "2026-07-30T02:00:00.000Z"],
        },
      }),
      (btcPath) => rm(path.dirname(btcPath), { recursive: true, force: true }),
      async (btcPath) => {
        const ethPath = await writeDatasetFixture("ETH", "conditional-add-sparse-source", {
          commonCoverageDays: 260,
        });
        const options = parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(requiredArgs(), "--database", databasePath),
          "--btc-dataset", btcPath,
          "--btc-initial-state", '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}',
          "--eth-dataset", ethPath,
          "--eth-initial-state", '{"cashKrw":2000000,"quantity":0,"averageEntryPriceKrw":0}',
          ...conditionalResearchArgs(),
        ]);

        const first = await buildIntegratedStrategyEvaluation(options);
        const second = await buildIntegratedStrategyEvaluation(options);
        const firstJson = formatIntegratedStrategyEvaluation(first, "json");
        const text = formatIntegratedStrategyEvaluation(first, "text");
        const btcDataset = first.provenance.datasets.find((dataset) => dataset.asset === "BTC");
        const section = requireConditionalAddPolicyEvaluation(first);
        const btcCandidates = section.assets.find((asset) => asset.asset === "BTC")?.candidates;

        assert.ok(btcDataset?.featureCoverage);
        assert.equal(btcDataset.featureCoverage.status, "COMPLETE");
        assert.equal(btcDataset.featureCoverage.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
        assert.equal(btcDataset.featureCoverage.timeframes["1h"].clockGridStatus, "SPARSE_BY_CONTRACT");
        assert.equal(btcDataset.featureCoverage.timeframes["1h"].sourceMissingCandleCount, 2);
        assert.equal(btcDataset.featureCoverage.timeframes["1h"].sourceNoTradeIntervalCount, 2);
        const expectedSourceNoTradeRange = [{
          firstMissingCloseTime: "2026-07-30T01:00:00.000Z",
          lastMissingCloseTime: "2026-07-30T02:00:00.000Z",
          missingCandleCount: 2,
          previousObservedCloseTime: "2026-07-30T00:00:00.000Z",
          nextObservedCloseTime: "2026-07-30T03:00:00.000Z",
        }];
        assert.deepEqual(
          btcDataset.featureCoverage.timeframes["1h"].sourceMissingRanges,
          expectedSourceNoTradeRange,
        );
        assert.deepEqual(
          btcDataset.featureCoverage.timeframes["1h"].sourceNoTradeRanges,
          expectedSourceNoTradeRange,
        );
        assert.ok(btcCandidates && btcCandidates.length > 0);
        for (const candidate of btcCandidates) {
          assert.equal(candidate.gates.frameCoverage.status, "PASS");
          assert.equal(candidate.gates.frameCoverage.fullPath.missingFrameCount, 0);
          assert.equal(candidate.gates.frameCoverage.fullPath.noTradeFrameCount, 2);
          assert.equal(candidate.gates.frameCoverage.fullPath.windowCadenceStatus, "INCOMPLETE");
          assert.equal(candidate.gates.frameCoverage.fullPath.windowSequenceContinuityStatus, "COMPLETE");
          assert.equal(candidate.gates.frameCoverage.fullPath.windowClockGridStatus, "SPARSE_BY_CONTRACT");
          assert.deepEqual(candidate.gates.frameCoverage.fullPath.noTradeRanges, [{
            firstMissingAt: "2026-07-30T01:00:00.000Z",
            lastMissingAt: "2026-07-30T02:00:00.000Z",
            missingFrameCount: 2,
            previousObservedAt: "2026-07-30T00:00:00.000Z",
            nextObservedAt: "2026-07-30T03:00:00.000Z",
          }]);
          const window = candidate.gates.frameCoverage.windows.find((item) => item.windowId === "W2");
          assert.equal(window?.missingFrameCount, 0);
          assert.equal(window?.noTradeFrameCount, 2);
          assert.equal(window?.windowCadenceStatus, "INCOMPLETE");
          assert.equal(window?.windowSequenceContinuityStatus, "COMPLETE");
          assert.equal(window?.windowClockGridStatus, "SPARSE_BY_CONTRACT");
          assert.deepEqual(window?.noTradeRanges, candidate.gates.frameCoverage.fullPath.noTradeRanges);
          const laterWindow = candidate.gates.frameCoverage.windows.find((item) => item.windowId === "W3");
          assert.equal(laterWindow?.windowCadenceStatus, "COMPLETE");
          assert.equal(laterWindow?.windowSequenceContinuityStatus, "COMPLETE");
          assert.equal(laterWindow?.windowClockGridStatus, "DENSE");
          assert.equal(laterWindow?.upstreamStateContinuityStatus, "COMPLETE");
          assert.equal(laterWindow?.upstreamSequenceContinuityStatus, "COMPLETE");
          assert.equal(laterWindow?.upstreamClockGridStatus, "SPARSE_BY_CONTRACT");
          assert.equal(laterWindow?.upstreamNoTradeFrameCount, 2);
          assert.deepEqual(laterWindow?.upstreamNoTradeRanges, candidate.gates.frameCoverage.fullPath.noTradeRanges);
        }
        assert.match(text, /source_cadence=INCOMPLETE/);
        assert.match(text, /sequence=COMPLETE/);
        assert.match(text, /clock_grid=SPARSE_BY_CONTRACT/);
        assert.match(text, /no_trade_intervals=2/);
        assert.match(text, /raw_missing=2/);
        assert.deepEqual(
          first.evidenceGaps.filter((gap) =>
            gap.code === "MISSING_INTERNAL_CANDLE_COVERAGE"
            || gap.code === "ADD_POST_DECISION_EXCURSION_MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE"
          ),
          [],
          "verified source no-trade intervals must not surface as unexplained excursion gaps",
        );
        assert.equal(firstJson, formatIntegratedStrategyEvaluation(second, "json"));
        assert.equal(text, formatIntegratedStrategyEvaluation(second, "text"));
        assert.deepEqual(JSON.parse(firstJson), first);
      },
    ),
  );
});

test("conditional ADD evaluation stays unavailable until every explicit prerequisite exists", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("conditional-add-unavailable"),
    cleanupFixture,
    async (databasePath) => {
      const options = parseIntegratedStrategyEvaluationArgs(replaceArg([
        ...replaceArg(simulationArgs("BTC", "btc.json"), "--database", databasePath),
        "--validation-windows",
        '[{"id":"W1","from":"2026-07-29T12:00:00Z","to":"2026-07-30T00:00:00Z"},{"id":"W2","from":"2026-07-30T00:00:00Z","to":"2026-07-30T12:00:00Z"},{"id":"W3","from":"2026-07-30T12:00:00Z","to":"2026-07-31T00:00:00Z"}]',
        "--validation-frame-interval-ms", "3600000",
        "--validation-comparison-tolerance-pp", "0.000001",
        "--validation-minimum-windows", "3",
      ], "--scenarios", '["BASELINE","NO_ADD","ADD_RISK_CLEAR"]'));
      const report = await buildIntegratedStrategyEvaluation(options, {
        readDataset: async () => createDataset("BTC", {
          candleCounts: { "1h": 0, "4h": 0, "1d": 0 },
        }),
      });
      const section = requireConditionalAddPolicyEvaluation(report);

      assert.equal(section.status, "UNAVAILABLE");
      assert.deepEqual(section.reasonCodes, [
        "ALL_CONDITIONAL_SCENARIOS_REQUIRED",
      ]);
      assert.equal(section.assets.length, 0);
      assert.match(section.warning, /not deployment approval/i);
    },
  );
});

test("ADD loss attribution stays absent when the full conditional matrix is missing either asset", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("add-loss-single-asset"),
    cleanupFixture,
    async (databasePath) => {
      const options = parseIntegratedStrategyEvaluationArgs(
        replaceArg(conditionalSimulationArgs("BTC", "fixture-btc.json"), "--database", databasePath),
      );
      const report = await buildIntegratedStrategyEvaluation(options, {
        readDataset: async () => createDataset("BTC", { commonCoverageDays: 260 }),
      });

      assert.equal(report.conditionalAddPolicyEvaluation?.status, "AVAILABLE");
      assert.equal(Object.hasOwn(report, "addLossAttribution"), false);
    },
  );
});

test("conditional ADD evaluation requires the first caller-ordered cost cell as its base", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("conditional-add-base-provenance"),
    cleanupFixture,
    async (databasePath) => {
      const options = parseIntegratedStrategyEvaluationArgs([
        ...replaceArg(requiredArgs(), "--database", databasePath),
        "--btc-dataset", "fixture-btc.json",
        "--btc-initial-state", '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}',
        ...conditionalResearchArgs().flatMap((value, index, values) => value === "--cost-cells"
          ? [value, '[{"id":"not-base","feeRate":0.0004,"slippageRate":0.0001},{"id":"later-base","feeRate":0.0005,"slippageRate":0.0003},{"id":"stress","feeRate":0.001,"slippageRate":0.002}]']
          : index > 0 && values[index - 1] === "--cost-cells" ? [] : [value]),
      ]);
      const report = await buildIntegratedStrategyEvaluation(options, {
        readDataset: async () => createDataset("BTC", {
          candleCounts: { "1h": 260, "4h": 260, "1d": 260 },
        }),
      });
      const section = requireConditionalAddPolicyEvaluation(report);

      assert.equal(section.status, "UNAVAILABLE");
      assert.deepEqual(section.reasonCodes, ["BASE_COST_CELL_REQUIRED"]);
    },
  );
});

test("legacy report JSON shape is unchanged when conditional scenarios are absent", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("legacy-shape", undefined, true),
    cleanupFixture,
    async (databasePath) => {
      const report = await buildIntegratedStrategyEvaluation(
        parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(requiredArgs(), "--database", databasePath),
          "--btc-dataset", "fixture-btc.json",
          "--btc-initial-state", '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}',
          ...sharedSimulationArgs(),
        ]),
        {
          readDataset: async () => createDataset("BTC", {
            candleCounts: { "1h": 260, "4h": 260, "1d": 260 },
          }),
        },
      );
      assert.equal(Object.hasOwn(report, "conditionalAddPolicyEvaluation"), false);
      assert.equal(Object.hasOwn(report, "addLossAttribution"), false);
      assert.equal(Object.hasOwn(report, "broadStrategyShadowHoldoutComponentDiagnostics"), false);
      assert.deepEqual(Object.keys(report), [
        "provenance",
        "observedLive",
        "simulatedCounterfactuals",
        "costSensitivity",
        "regimeAnalysis",
        "excursionAnalysis",
        "addDiagnostics",
        "evidenceGaps",
        "interpretation",
      ]);
      assert.doesNotMatch(
        formatIntegratedStrategyEvaluation(report, "text"),
        /Component Ablation Diagnostics/,
      );
      assert.equal(
        report.provenance.datasets.some((dataset) => Object.hasOwn(dataset, "featureCoverage")),
        false,
      );
      const text = formatIntegratedStrategyEvaluation(report, "text");
      const json = formatIntegratedStrategyEvaluation(report, "json");
      assert.equal(
        sha256Text(json),
        "17197df314ba4ed614b175498983152759dca6b39be1f228d582026316e070dd",
        "legacy full JSON serialization changed",
      );
      assert.equal(
        sha256Text(text),
        "5f2ca657f7a778eaf4da76ccd4a69878ace5a76f2ca62b8537df509374cc1d37",
        "legacy full text report changed",
      );
      const legacyProjection = text.split("\n").filter((line) =>
        !line.startsWith("Observed mark exclusions:")
        && !line.startsWith("Observed mark exclusion:"),
      ).join("\n");
      assert.equal(text, legacyProjection, "optional ADD attribution must not change legacy text bytes");
      assert.equal(
        formatIntegratedStrategyEvaluation(structuredClone(report), "text"),
        legacyProjection,
      );
    },
  );
});

test("performance research integration imports stay outside execution and writable runtime graphs", async () => {
  const files = [
    "src/research/integrated-strategy-evaluation.ts",
    "src/modules/performance/performance-add-loss-attribution.ts",
    "src/modules/performance/performance-add-holdout-hypothesis.ts",
    "src/modules/performance/performance-holdout-failure-diagnostics.ts",
    "src/modules/performance/performance-component-ablation.ts",
    "src/modules/performance/performance-holdout-episode-attribution.ts",
  ];
  const forbidden = /(?:^|\/)(?:app|execution|exchange|reconciliation|telegram|runtime|db)(?:\/|$)/;
  for (const file of files) {
    const source = await readFile(path.resolve(file), "utf8");
    const importSpecifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
    for (const specifier of importSpecifiers) {
      assert.equal(
        forbidden.test(specifier.replaceAll("\\", "/")),
        false,
        `${file} must not import execution, exchange, reconciliation, Telegram, app/runtime, or writable DB modules: ${specifier}`,
      );
    }
  }

  const integratedSource = await readFile(
    path.resolve("src/research/integrated-strategy-evaluation.ts"),
    "utf8",
  );
  assert.match(
    integratedSource,
    /from "\.\.\/modules\/performance\/performance-add-loss-attribution\.js"/,
  );
  assert.match(
    integratedSource,
    /from "\.\.\/modules\/performance\/performance-add-holdout-hypothesis\.js"/,
  );
  assert.match(
    integratedSource,
    /from "\.\.\/modules\/performance\/performance-holdout-failure-diagnostics\.js"/,
  );
  assert.match(
    integratedSource,
    /from "\.\.\/modules\/performance\/performance-component-ablation\.js"/,
  );
  assert.match(
    integratedSource,
    /from "\.\.\/modules\/performance\/performance-holdout-episode-attribution\.js"/,
  );
});

test("dataset asset mismatch fails explicitly and finite JSON rejects unsupported values", async () => {
  await withFixtureResource(
    () => createDisposableDatabase("invalid-output"),
    cleanupFixture,
    async (databasePath) => withFixtureResource(
      () => writeDatasetFixture("ETH", "mismatch"),
      (ethPath) => rm(path.dirname(ethPath), { recursive: true, force: true }),
      async (ethPath) => {
        const mismatchOptions = parseIntegratedStrategyEvaluationArgs([
          ...replaceArg(requiredArgs(), "--database", databasePath),
          "--btc-dataset", ethPath,
          "--btc-initial-state", "{\"cashKrw\":1000000,\"quantity\":0,\"averageEntryPriceKrw\":0}",
          ...sharedSimulationArgs(),
        ]);
        await assert.rejects(
          buildIntegratedStrategyEvaluation(mismatchOptions),
          /dataset asset ETH does not match CLI asset BTC/,
        );

        const report = await buildIntegratedStrategyEvaluation(
          parseIntegratedStrategyEvaluationArgs(replaceArg(requiredArgs(), "--database", databasePath)),
        );
        const withInfinity = structuredClone(report);
        withInfinity.observedLive.performance.totals.turnoverKrw = Number.POSITIVE_INFINITY;
        assert.throws(() => formatIntegratedStrategyEvaluation(withInfinity, "json"), /must be finite/);

        const withBigInt = structuredClone(report) as IntegratedStrategyEvaluationReport & { invalid?: unknown };
        withBigInt.invalid = 1n;
        assert.throws(() => formatIntegratedStrategyEvaluation(withBigInt, "json"), /BigInt is not supported/);

        const withUndefined = structuredClone(report) as IntegratedStrategyEvaluationReport & { invalid?: unknown };
        withUndefined.invalid = undefined;
        assert.throws(() => formatIntegratedStrategyEvaluation(withUndefined, "json"), /undefined is not supported/);
      },
    ),
  );
});

function requiredArgs(...extra: string[]): string[] {
  return [
    "--database", "./fixture.sqlite",
    "--exchange-account-id", "primary",
    "--execution-mode", "LIVE",
    "--origin", "STRATEGY",
    ...extra,
  ];
}

function simulationArgs(asset: "BTC" | "ETH", datasetPath: string, ...extra: string[]): string[] {
  const key = asset.toLowerCase();
  let args = [
    ...requiredArgs(),
    `--${key}-dataset`, datasetPath,
    `--${key}-initial-state`, "{\"cashKrw\":1000000,\"quantity\":0,\"averageEntryPriceKrw\":0}",
    ...sharedSimulationArgs(),
  ];
  for (let index = 0; index < extra.length; index += 2) {
    args = replaceArg(args, extra[index]!, extra[index + 1]!);
  }
  return args;
}

function sharedSimulationArgs(): string[] {
  return [
    "--scenarios", "[\"BASELINE\",\"NO_ADD\"]",
    "--minimum-order-value-krw", "5000",
    "--cost-cells", "[{\"id\":\"observed-fee\",\"feeRate\":0.0005,\"slippageRate\":0},{\"id\":\"stress\",\"feeRate\":0.001,\"slippageRate\":0.002}]",
  ];
}

function conditionalSimulationArgs(asset: "BTC" | "ETH", datasetPath: string): string[] {
  return [
    ...simulationArgs(asset, datasetPath),
    ...conditionalResearchArgs(),
  ].reduce<string[]>((args, value, index, values) => {
    if (!value.startsWith("--")) return args;
    return replaceArg(args, value, values[index + 1]!);
  }, simulationArgs(asset, datasetPath));
}

function conditionalResearchArgs(): string[] {
  return [
    "--scenarios",
    '["BASELINE","NO_ADD","ADD_RISK_CLEAR","ADD_HIGH_ALIGNMENT","ADD_CORE_TREND"]',
    "--cost-cells",
    '[{"id":"base","feeRate":0.0005,"slippageRate":0.0003},{"id":"stress","feeRate":0.001,"slippageRate":0.002}]',
    "--minimum-order-value-krw", "5000",
    "--validation-windows",
    '[{"id":"W1","from":"2026-07-29T12:00:00Z","to":"2026-07-30T00:00:00Z"},{"id":"W2","from":"2026-07-30T00:00:00Z","to":"2026-07-30T12:00:00Z"},{"id":"W3","from":"2026-07-30T12:00:00Z","to":"2026-07-31T00:00:00Z"}]',
    "--validation-frame-interval-ms", "3600000",
    "--validation-comparison-tolerance-pp", "0.000001",
    "--validation-minimum-windows", "3",
  ];
}

function broadStrategyHypothesisArgs(
  btcDatasetPath: string,
  ethDatasetPath: string,
  btcNoTradeEvidencePath?: string,
  ethNoTradeEvidencePath?: string,
): string[] {
  const args = [
    ...requiredArgs(),
    "--btc-dataset", btcDatasetPath,
    "--btc-initial-state", '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}',
    "--eth-dataset", ethDatasetPath,
    "--eth-initial-state", '{"cashKrw":1000000,"quantity":0,"averageEntryPriceKrw":0}',
    "--broad-strategy-hypothesis-profile", "BROAD_LOSS_CAUSE_V1",
    "--scenarios",
    '["BASELINE","NO_ADD","HTF_TREND_GATE","STRICT_PULLBACK","EARLY_THESIS_FAILURE","ADD_LIMITED","COOLDOWN_CONTROL","COMBINED_CONSERVATIVE"]',
    "--minimum-order-value-krw", "5000",
    "--cost-cells",
    '[{"id":"BASE","feeRate":0.0005,"slippageRate":0.0003},{"id":"STRESS","feeRate":0.001,"slippageRate":0.002}]',
    "--validation-windows",
    '[{"id":"W1","from":"2025-07-20T00:00:00Z","to":"2025-10-25T19:00:00Z"},{"id":"W2","from":"2025-10-26T00:00:00Z","to":"2025-12-31T19:00:00Z"},{"id":"W3","from":"2026-01-01T00:00:00Z","to":"2026-04-12T19:00:00Z"}]',
    "--validation-frame-interval-ms", "3600000",
    "--validation-comparison-tolerance-pp", "0.000001",
    "--validation-minimum-windows", "3",
  ];
  if (btcNoTradeEvidencePath !== undefined) {
    args.push("--btc-no-trade-evidence", btcNoTradeEvidencePath);
  }
  if (ethNoTradeEvidencePath !== undefined) {
    args.push("--eth-no-trade-evidence", ethNoTradeEvidencePath);
  }
  return args;
}

async function writeNoTradeEvidenceFixture(datasetPath: string, label: string): Promise<string> {
  const dataset = parseResearchCandleDataset(await readFile(datasetPath, "utf8"));
  const evidence = createNoTradeEvidenceFixture(dataset);
  const outputPath = path.join(path.dirname(datasetPath), `${label}.no-trade.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return outputPath;
}

function createNoTradeEvidenceFixture(
  dataset: ResearchCandleDataset,
): ResearchNoTradeEvidence {
  const coverage = classifyIndependentNoTradeCoverage(dataset);
  const unsigned: ResearchNoTradeEvidenceWithoutChecksum = {
    provenance: {
      schemaVersion: 1,
      evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1",
      asset: dataset.provenance.asset,
      market: dataset.provenance.market,
      parentDatasetSha256: dataset.provenance.sha256,
      from: dataset.provenance.historyStartAt,
      to: dataset.provenance.endAt,
      source: "fixture-independent-no-trade",
      lowerTimeframe: "1m",
      collectorVersion: "fixture-v1",
      collectedAt: dataset.provenance.collectedAt,
    },
    querySegments: coverage.missingRanges.map((range, index) => ({
      ...range,
      paginationComplete: true,
      responseFingerprint: (index % 16).toString(16).repeat(64),
    })),
    verifiedNoTradeRanges: coverage.missingRanges.map((range) => ({ ...range })),
  };
  const evidence = {
    ...unsigned,
    provenance: {
      ...unsigned.provenance,
      sha256: computeResearchNoTradeEvidenceSha256(unsigned),
    },
  };
  return evidence;
}

function mutateDatasetAtOrAfter(
  dataset: ResearchCandleDataset,
  from: string,
): ResearchCandleDataset {
  const boundary = parsePerformanceTimestamp(from);
  assert.ok(boundary);
  let mutationCount = 0;
  const candles = Object.fromEntries(
    (Object.entries(dataset.candles) as Array<[
      ResearchCandleTimeframe,
      readonly ResearchCandle[],
    ]>).map(([timeframe, rows]) => [
      timeframe,
      rows.map((candle) => {
        const close = parsePerformanceTimestamp(candle.closeTime);
        assert.ok(close);
        if (close.epochNanoseconds < boundary.epochNanoseconds) return { ...candle };
        mutationCount += 1;
        return {
          ...candle,
          openPrice: candle.openPrice + 10_000,
          highPrice: candle.highPrice + 10_000,
          lowPrice: candle.lowPrice + 10_000,
          closePrice: candle.closePrice + 10_000,
          quoteVolume: candle.quoteVolume + 10_000,
        };
      }),
    ]),
  ) as Record<ResearchCandleTimeframe, ResearchCandle[]>;
  assert.ok(mutationCount > 0, "Future-evidence fixture must mutate at least one candle.");
  const { sha256: _datasetSha256, ...provenance } = dataset.provenance;
  const unsigned = { provenance, candles };
  return {
    provenance: {
      ...provenance,
      sha256: calculateResearchCandleDatasetChecksum(unsigned),
    },
    candles,
  };
}

function withoutWholeDatasetIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWholeDatasetIdentity);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "datasetSha256" && key !== "datasetFingerprint")
    .map(([key, nested]) => [key, withoutWholeDatasetIdentity(nested)]));
}

type ConditionalAddPolicyEvaluationFixture = {
  status: "AVAILABLE" | "UNAVAILABLE";
  reasonCodes: string[];
  deploymentApproval: false;
  warning: string;
  windows: Array<{ id: string; from: string; to: string }>;
  assets: Array<{
    asset: "BTC" | "ETH";
    status: "AVAILABLE" | "DATASET_UNAVAILABLE" | "DATASET_UNUSABLE";
    candidates: Array<{
      candidate: string;
      costAnchors: Record<"BASE" | "STRESS", {
        feeRate: number;
        slippageRate: number;
      }>;
      observations: {
        fullPath: { observations: unknown[] };
        windows: unknown[];
      };
      gates: {
        policyExposedCompletedEpisodes: {
          fullPathObservedCount: number;
          windows: Array<{ observedCount: number }>;
        };
        frameCoverage: {
          status: "PASS" | "INSUFFICIENT";
          fullPath: {
            missingFrameCount: number;
            noTradeFrameCount: number;
            missingRanges: unknown[];
            noTradeRanges: Array<{
              firstMissingAt: string;
              lastMissingAt: string;
              missingFrameCount: number;
              previousObservedAt: string | null;
              nextObservedAt: string | null;
            }>;
            windowCadenceStatus: "COMPLETE" | "INCOMPLETE";
            windowSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
            windowClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
            featureLookbackContinuityStatus: "COMPLETE" | "INCOMPLETE";
            featureLookbackAffectedFrameCount: number;
          };
          windows: Array<{
            windowId: string;
            missingFrameCount: number;
            noTradeFrameCount: number;
            noTradeRanges: Array<{
              firstMissingAt: string;
              lastMissingAt: string;
              missingFrameCount: number;
              previousObservedAt: string | null;
              nextObservedAt: string | null;
            }>;
            windowCadenceStatus: "COMPLETE" | "INCOMPLETE";
            windowSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
            windowClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
            upstreamStateContinuityStatus: "COMPLETE" | "INCOMPLETE";
            upstreamSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
            upstreamClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
            upstreamNoTradeFrameCount: number;
            upstreamNoTradeRanges: Array<{
              firstMissingAt: string;
              lastMissingAt: string;
              missingFrameCount: number;
              previousObservedAt: string | null;
              nextObservedAt: string | null;
            }>;
          }>;
        };
      };
    }>;
  }>;
};

function requireConditionalAddPolicyEvaluation(
  report: IntegratedStrategyEvaluationReport,
): ConditionalAddPolicyEvaluationFixture {
  const section = (report as IntegratedStrategyEvaluationReport & {
    conditionalAddPolicyEvaluation?: ConditionalAddPolicyEvaluationFixture;
  }).conditionalAddPolicyEvaluation;
  assert.ok(section, "Missing conditional ADD policy evaluation section.");
  return section;
}

function replaceArg(args: readonly string[], key: string, value: string): string[] {
  const result = [...args];
  const index = result.indexOf(key);
  if (index < 0) return [...result, key, value];
  result[index + 1] = value;
  return result;
}

function removeArg(args: readonly string[], key: string): string[] {
  const index = args.indexOf(key);
  return index < 0 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
}

async function createDisposableDatabase(
  label: string,
  seed?: (db: DatabaseSync) => void,
  stablePath = false,
): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  const databasePath = stablePath
    ? `.tmp-db-tests/integrated-strategy-evaluation/${label}.sqlite`
    : path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}.sqlite`);
  if (stablePath) await rm(databasePath, { force: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE strategy_decisions (
        id TEXT PRIMARY KEY,
        exchange_account_id TEXT NOT NULL,
        market TEXT NOT NULL,
        action TEXT NOT NULL
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        strategy_decision_id TEXT,
        exchange_account_id TEXT NOT NULL,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        origin TEXT NOT NULL,
        execution_mode TEXT NOT NULL
      );
      CREATE TABLE fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        price TEXT NOT NULL,
        volume TEXT NOT NULL,
        fee_currency TEXT,
        fee_amount TEXT,
        filled_at TEXT NOT NULL
      );
      CREATE TABLE position_snapshots (
        id TEXT PRIMARY KEY,
        exchange_account_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source TEXT NOT NULL,
        positions_json TEXT NOT NULL
      );
    `);
    seed?.(db);
  } finally {
    db.close();
  }
  return databasePath;
}

function seedObservedSeparationFixture(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO position_snapshots (id, exchange_account_id, captured_at, source, positions_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "opening-position",
    "primary",
    "2026-08-01T00:00:00.000Z",
    "RECONCILIATION",
    JSON.stringify([{
      asset: "BTC",
      market: "KRW-BTC",
      quantity: "1",
      averageEntryPrice: "100",
      markPrice: "120",
      marketValue: null,
      exposureRatio: null,
      capturedAt: "2026-08-01T00:00:00.000Z",
    }]),
  );
  const insertDecision = db.prepare(`
    INSERT INTO strategy_decisions (id, exchange_account_id, market, action)
    VALUES (?, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, strategy_decision_id, exchange_account_id, market, side, origin, execution_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFill = db.prepare(`
    INSERT INTO fills (
      id, order_id, market, side, price, volume, fee_currency, fee_amount, filled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertDecision.run("decision-entry", "primary", "KRW-BTC", "ENTER");
  insertDecision.run("decision-exit", "primary", "KRW-BTC", "EXIT");
  insertOrder.run("order-entry", "decision-entry", "primary", "KRW-BTC", "bid", "STRATEGY", "LIVE");
  insertOrder.run("order-exit", "decision-exit", "primary", "KRW-BTC", "ask", "STRATEGY", "LIVE");
  insertFill.run(
    "selected-entry",
    "order-entry",
    "KRW-BTC",
    "bid",
    "100",
    "1",
    "KRW",
    "1",
    "2026-08-01T01:00:00.000Z",
  );
  insertFill.run(
    "shared-exit",
    "order-exit",
    "KRW-BTC",
    "ask",
    "120",
    "2",
    "KRW",
    "2",
    "2026-08-01T02:00:00.000Z",
  );
}

function seedObservedMarkFixture(
  db: DatabaseSync,
  marks: readonly (string | null)[],
  options: {
    capturedAts?: readonly string[];
    feeAmount?: string | null;
  } = {},
): void {
  db.prepare(`
    INSERT INTO strategy_decisions (id, exchange_account_id, market, action)
    VALUES (?, ?, ?, ?)
  `).run("mark-decision-entry", "primary", "KRW-BTC", "ENTER");
  db.prepare(`
    INSERT INTO orders (
      id, strategy_decision_id, exchange_account_id, market, side, origin, execution_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "mark-order-entry",
    "mark-decision-entry",
    "primary",
    "KRW-BTC",
    "bid",
    "STRATEGY",
    "LIVE",
  );
  db.prepare(`
    INSERT INTO fills (
      id, order_id, market, side, price, volume, fee_currency, fee_amount, filled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "mark-selected-entry",
    "mark-order-entry",
    "KRW-BTC",
    "bid",
    "100",
    "1",
    "KRW",
    options.feeAmount === undefined ? "1" : options.feeAmount,
    "2026-08-01T01:00:00.000Z",
  );

  const insertSnapshot = db.prepare(`
    INSERT INTO position_snapshots (id, exchange_account_id, captured_at, source, positions_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [index, markPrice] of marks.entries()) {
    const capturedAt = options.capturedAts?.[index] ?? `2026-08-01T0${index + 2}:00:00.000Z`;
    insertSnapshot.run(
      `mark-snapshot-${index + 1}`,
      "primary",
      capturedAt,
      "RECONCILIATION",
      JSON.stringify([{
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "1",
        averageEntryPrice: "100",
        markPrice,
        marketValue: null,
        exposureRatio: null,
        capturedAt,
      }]),
    );
  }
}

async function cleanupFixture(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function withFixtureResource<T, R>(
  acquire: () => Promise<T>,
  release: (resource: T) => Promise<unknown>,
  use: (resource: T) => Promise<R>,
): Promise<R> {
  const resource = await acquire();
  try {
    return await use(resource);
  } finally {
    await release(resource);
  }
}

async function writeDatasetFixture(
  asset: "BTC" | "ETH",
  suffix = "fixture-mode",
  options: Parameters<typeof createDataset>[1] = {},
): Promise<string> {
  const directory = path.join(TMP_ROOT, suffix);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${asset.toLowerCase()}.json`);
  await writeFile(filePath, JSON.stringify(createDataset(asset, options)), "utf8");
  return filePath;
}

function createDataset(
  asset: "BTC" | "ETH",
  options: {
    candleCounts?: Partial<Record<ResearchCandleTimeframe, number>>;
    endOffsetsMs?: Partial<Record<ResearchCandleTimeframe, number>>;
    commonCoverageDays?: number;
    missingCloseTimes?: Partial<Record<ResearchCandleTimeframe, readonly string[]>>;
    endAt?: string;
    spacingMs?: number;
  } = {},
): ResearchCandleDataset {
  const market: ResearchCandle["market"] = asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
  const endMs = Date.parse(options.endAt ?? "2026-08-01T00:00:00.000Z");
  const durationMs: Record<ResearchCandleTimeframe, number> = {
    "1h": 60 * 60 * 1_000,
    "4h": 4 * 60 * 60 * 1_000,
    "1d": 24 * 60 * 60 * 1_000,
  };
  const candles = Object.fromEntries((["1h", "4h", "1d"] as const).map((timeframe) => {
    const count = options.commonCoverageDays === undefined
      ? options.candleCounts?.[timeframe] ?? 200
      : options.commonCoverageDays * (timeframe === "1h" ? 24 : timeframe === "4h" ? 6 : 1);
    const timeframeEndMs = endMs + (options.endOffsetsMs?.[timeframe] ?? 0);
    const spacingMs = options.spacingMs ?? durationMs[timeframe];
    const generated = [
      timeframe,
      Array.from({ length: count }, (_, index) => fixtureCandle(
        market,
        timeframe,
        new Date(timeframeEndMs - (count - index) * spacingMs).toISOString(),
        new Date(
          timeframeEndMs - (count - index) * spacingMs + durationMs[timeframe],
        ).toISOString(),
        100_000 + index * 100,
      )),
    ] as const;
    const missingCloseTimes = new Set(options.missingCloseTimes?.[timeframe] ?? []);
    return [timeframe, generated[1].filter((candle) => !missingCloseTimes.has(candle.closeTime))];
  })) as Record<ResearchCandleTimeframe, ResearchCandle[]>;
  const allCandles = Object.values(candles).flat();
  const historyStartMs = allCandles.length === 0
    ? endMs - durationMs["1d"]
    : Math.min(...allCandles.map((candle) => Date.parse(candle.openTime)));
  const datasetEndMs = allCandles.length === 0
    ? endMs
    : Math.max(...allCandles.map((candle) => Date.parse(candle.closeTime)));
  const unsigned = {
    provenance: {
      schemaVersion: 1 as const,
      asset,
      market,
      historyStartAt: new Date(historyStartMs).toISOString(),
      endAt: new Date(datasetEndMs).toISOString(),
      collectedAt: new Date(datasetEndMs + durationMs["1h"]).toISOString(),
      source: "task-6-deterministic-local-fixture",
    },
    candles,
  };
  return {
    ...unsigned,
    provenance: {
      ...unsigned.provenance,
      sha256: calculateResearchCandleDatasetChecksum(unsigned),
    },
  };
}

function requireAssetSection(sections: readonly unknown[], asset: "BTC" | "ETH"): Record<string, unknown> {
  const section = sections.find((item) =>
    item !== null && typeof item === "object" && (item as { asset?: unknown }).asset === asset
  );
  assert.ok(section !== null && typeof section === "object", `Missing ${asset} report section.`);
  return section as Record<string, unknown>;
}

function fixtureCandle(
  market: "KRW-BTC" | "KRW-ETH",
  timeframe: ResearchCandleTimeframe,
  openTime: string,
  closeTime: string,
  openPrice: number,
): ResearchCandle {
  return {
    market,
    timeframe,
    openTime,
    closeTime,
    openPrice,
    highPrice: openPrice + 150,
    lowPrice: openPrice - 50,
    closePrice: openPrice + 100,
    volume: 1,
    quoteVolume: openPrice + 100,
  };
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  assert.match(pointer, /^\//, `metricId must be an RFC 6901 JSON Pointer: ${pointer}`);
  return pointer.slice(1).split("/").reduce<unknown>((current, rawToken) => {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      return /^\d+$/.test(token) ? current[Number(token)] : undefined;
    }
    if (current !== null && typeof current === "object") {
      return (current as Record<string, unknown>)[token];
    }
    return undefined;
  }, value);
}
