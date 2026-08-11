import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  calculateResearchCandleDatasetChecksum,
  type ResearchCandle,
  type ResearchCandleDataset,
  type ResearchCandleTimeframe,
} from "../src/modules/performance/research-candle-dataset.js";
import {
  buildInterpretation,
  buildIntegratedStrategyEvaluation,
  formatIntegratedStrategyEvaluation,
  parseIntegratedStrategyEvaluationArgs,
  type IntegratedStrategyEvaluationReport,
} from "../src/research/integrated-strategy-evaluation.js";
import { test } from "./harness.js";

const TMP_ROOT = path.resolve(".tmp-db-tests", "integrated-strategy-evaluation");
const OBSERVED_MARK_CASES = [
  {
    label: "unavailable",
    marks: [] as const,
    persisted: 0,
    usable: 0,
    gapCode: "MARK_DATA_UNAVAILABLE",
    metricStatus: "NOT_APPLICABLE",
  },
  {
    label: "unusable",
    marks: [null] as const,
    persisted: 1,
    usable: 0,
    gapCode: "MARK_DATA_UNUSABLE",
    metricStatus: "UNKNOWN",
  },
  {
    label: "partial",
    marks: [null, "120"] as const,
    persisted: 2,
    usable: 1,
    gapCode: "MARK_DATA_PARTIAL",
    metricStatus: "UNKNOWN",
  },
  {
    label: "complete",
    marks: ["110", "120"] as const,
    persisted: 2,
    usable: 2,
    gapCode: null,
    metricStatus: "KNOWN",
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
        assert.deepEqual(markGaps.map((gap) => gap.code), fixture.gapCode === null ? [] : [fixture.gapCode]);
        if (fixture.gapCode !== null) {
          const gap = markGaps[0];
          assert.deepEqual(gap?.affectedMetrics, [
            "observedLive.diagnostics.markPnlCurve",
            "observedLive.diagnostics.marketMarkPnlCurves",
          ]);
          assert.match(gap?.message ?? "", new RegExp(`persisted=${fixture.persisted}, usable=${fixture.usable}`));
        }
        if (fixture.metricStatus === "UNKNOWN") {
          assert.deepEqual(curve.gross, { status: "UNKNOWN", reasons: ["MISSING_MARK_OR_COST"] });
          assert.match(formatIntegratedStrategyEvaluation(report, "text"), /MISSING_MARK_OR_COST/);
        }
      },
    );
  });
}

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
        assert.equal(Object.hasOwn(first.simulatedCounterfactuals, "portfolioReturnPct"), false);
        assert.equal(Object.hasOwn(first.costSensitivity, "portfolioReturnPct"), false);
        assert.match(text, /OBSERVED_LIVE_ATTRIBUTION/);
        assert.match(text, /SIMULATED_COUNTERFACTUAL/);
        assert.match(text, /MODELED_COST_SCENARIO/);
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
): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  const databasePath = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}.sqlite`);
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
    "1",
    "2026-08-01T01:00:00.000Z",
  );

  const insertSnapshot = db.prepare(`
    INSERT INTO position_snapshots (id, exchange_account_id, captured_at, source, positions_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [index, markPrice] of marks.entries()) {
    insertSnapshot.run(
      `mark-snapshot-${index + 1}`,
      "primary",
      `2026-08-01T0${index + 2}:00:00.000Z`,
      "RECONCILIATION",
      JSON.stringify([{
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "1",
        averageEntryPrice: "100",
        markPrice,
        marketValue: null,
        exposureRatio: null,
        capturedAt: `2026-08-01T0${index + 2}:00:00.000Z`,
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

async function writeDatasetFixture(asset: "BTC" | "ETH", suffix = "fixture-mode"): Promise<string> {
  const directory = path.join(TMP_ROOT, suffix);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${asset.toLowerCase()}.json`);
  await writeFile(filePath, JSON.stringify(createDataset(asset)), "utf8");
  return filePath;
}

function createDataset(
  asset: "BTC" | "ETH",
  options: {
    candleCounts?: Partial<Record<ResearchCandleTimeframe, number>>;
    endOffsetsMs?: Partial<Record<ResearchCandleTimeframe, number>>;
  } = {},
): ResearchCandleDataset {
  const market: ResearchCandle["market"] = asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
  const endMs = Date.parse("2026-08-01T00:00:00.000Z");
  const durationMs: Record<ResearchCandleTimeframe, number> = {
    "1h": 60 * 60 * 1_000,
    "4h": 4 * 60 * 60 * 1_000,
    "1d": 24 * 60 * 60 * 1_000,
  };
  const candles = Object.fromEntries((["1h", "4h", "1d"] as const).map((timeframe) => {
    const count = options.candleCounts?.[timeframe] ?? 200;
    const timeframeEndMs = endMs + (options.endOffsetsMs?.[timeframe] ?? 0);
    return [
      timeframe,
      Array.from({ length: count }, (_, index) => fixtureCandle(
        market,
        timeframe,
        new Date(timeframeEndMs - (count - index) * durationMs[timeframe]).toISOString(),
        new Date(timeframeEndMs - (count - 1 - index) * durationMs[timeframe]).toISOString(),
        100_000 + index * 100,
      )),
    ];
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
