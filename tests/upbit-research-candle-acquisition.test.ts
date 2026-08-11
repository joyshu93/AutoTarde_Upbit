import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { UpbitCandleSnapshot } from "../src/modules/exchange/upbit/contracts.js";
import {
  acquireUpbitResearchCandleDataset,
} from "../src/modules/performance/upbit-research-candle-acquisition.js";
import type {
  PositionGuardBacktestCandleReader,
} from "../src/modules/strategy/position-guard-public-backtest.js";
import { test } from "./harness.js";

test("research candle acquisition requests all public timeframes and returns a verified dataset", async () => {
  const calls: string[] = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      calls.push(`minute:${request.market}:${request.unit}:${request.count}:${request.to}`);
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
    getDayCandles: async (request) => {
      calls.push(`day:${request.market}:${request.count}:${request.to}`);
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
  };
  const result = await acquireUpbitResearchCandleDataset(reader, {
    asset: "ETH",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    collectedAt: "2026-08-03T00:00:00.000Z",
    pageSize: 200,
    pageLimit: 3,
  });

  assert.deepEqual(calls, [
    "minute:KRW-ETH:60:200:2026-08-02T00:00:00.000Z",
    "minute:KRW-ETH:240:200:2026-08-02T00:00:00.000Z",
    "day:KRW-ETH:200:2026-08-02T00:00:00.000Z",
  ]);
  assert.equal(result.asset, "ETH");
  assert.equal(result.market, "KRW-ETH");
  assert.equal(result.source, "upbit-public-historical-candles");
  assert.deepEqual(result.candleCounts, { "1h": 1, "4h": 1, "1d": 1 });
  assert.equal(JSON.parse(result.json).provenance.sha256, result.dataset.provenance.sha256);
  assert.deepEqual(result.boundary, {
    sqlite: false,
    privateExchange: false,
    telegram: false,
    scheduler: false,
    strategyExecution: false,
    orders: false,
  });
  assert.equal(Object.isFrozen(result.boundary), true);
});

test("research candle acquisition reuses backward pagination and de-duplicates overlap", async () => {
  const oneHourPages = [
    [
      createCandle("KRW-ETH", "2026-08-01T03:00:00", 103),
      createCandle("KRW-ETH", "2026-08-01T02:00:00", 102),
    ],
    [
      createCandle("KRW-ETH", "2026-08-01T02:00:00", 102),
      createCandle("KRW-ETH", "2026-07-31T23:00:00", 99),
    ],
  ];
  const minute60To: Array<string | undefined> = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      if (request.unit === 60) {
        minute60To.push(request.to);
        return oneHourPages.shift() ?? [];
      }
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
    getDayCandles: async () => [
      createCandle("KRW-ETH", "2026-08-01T00:00:00", 100),
    ],
  };

  const result = await acquireUpbitResearchCandleDataset(reader, acquisitionInput({
    pageSize: 2,
    pageLimit: 2,
  }));

  assert.deepEqual(minute60To, [
    "2026-08-02T00:00:00.000Z",
    "2026-08-01T02:00:00.000Z",
  ]);
  assert.deepEqual(result.dataset.candles["1h"].map(({ openTime }) => openTime), [
    "2026-08-01T02:00:00.000Z",
    "2026-08-01T03:00:00.000Z",
  ]);
});

test("research candle acquisition rejects explicit page-limit coverage exhaustion", async () => {
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async () => [
      createCandle("KRW-BTC", "2026-08-01T03:00:00", 103),
      createCandle("KRW-BTC", "2026-08-01T02:00:00", 102),
    ],
    getDayCandles: async () => [],
  };

  await assert.rejects(
    acquireUpbitResearchCandleDataset(reader, acquisitionInput({
      asset: "BTC",
      historyStartAt: "2026-01-01T00:00:00.000Z",
      pageSize: 2,
      pageLimit: 1,
    })),
    /coverage did not reach historyStartAt.*pageLimit=1/i,
  );
});

test("research candle acquisition rejects short and empty source exhaustion before historyStartAt for every timeframe", async () => {
  const timeframes = ["1h", "4h", "1d"] as const;
  const exhaustionKinds = ["short", "empty"] as const;

  for (const timeframe of timeframes) {
    for (const exhaustionKind of exhaustionKinds) {
      const exhaustedCandles = exhaustionKind === "short"
        ? [createCandle("KRW-BTC", "2026-08-01T00:00:00", 100)]
        : [];
      const coveredCandles = [createCandle("KRW-BTC", "2026-01-01T00:00:00", 90)];
      const reader: PositionGuardBacktestCandleReader = {
        getMinuteCandles: async (request) => {
          const requestedTimeframe = request.unit === 60 ? "1h" : "4h";
          return requestedTimeframe === timeframe ? exhaustedCandles : coveredCandles;
        },
        getDayCandles: async () => timeframe === "1d" ? exhaustedCandles : coveredCandles,
      };

      await assert.rejects(
        acquireUpbitResearchCandleDataset(reader, acquisitionInput({
          asset: "BTC",
          historyStartAt: "2026-01-01T00:00:00.000Z",
          pageSize: 2,
          pageLimit: 3,
        })),
        new RegExp(`${timeframe} candle coverage did not reach historyStartAt.*source exhausted`, "i"),
        `${timeframe} ${exhaustionKind} exhaustion must not publish overstated provenance`,
      );
    }
  }
});

test("research candle acquisition rejects an injected timeframe failure without partial success", async () => {
  const calls: string[] = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      calls.push(`minute:${request.unit}`);
      if (request.unit === 240) {
        throw new Error("fixture 4h failure");
      }
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
    getDayCandles: async () => {
      calls.push("day");
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
  };

  await assert.rejects(
    acquireUpbitResearchCandleDataset(reader, acquisitionInput()),
    /fixture 4h failure/i,
  );
  assert.deepEqual(calls, ["minute:60", "minute:240"]);
});

test("research candle acquisition rejects when range filtering empties a timeframe", async () => {
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => request.unit === 60
      ? [createCandle("KRW-ETH", "2026-07-31T23:00:00", 99)]
      : [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)],
    getDayCandles: async () => [
      createCandle("KRW-ETH", "2026-08-01T00:00:00", 100),
    ],
  };

  await assert.rejects(
    acquireUpbitResearchCandleDataset(reader, acquisitionInput()),
    /builder 1h must contain at least one completed candle in range/i,
  );
});

test("research candle acquisition statically imports only its approved pure and public boundaries", async () => {
  const source = await readFile(
    join(process.cwd(), "src/modules/performance/upbit-research-candle-acquisition.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(imports, [
    "../../domain/types.js",
    "../strategy/position-guard-public-backtest.js",
    "./research-candle-dataset-builder.js",
    "./performance-timestamp.js",
    "./research-candle-dataset.js",
  ]);
});

function acquisitionInput(
  overrides: Partial<Parameters<typeof acquireUpbitResearchCandleDataset>[1]> = {},
): Parameters<typeof acquireUpbitResearchCandleDataset>[1] {
  return {
    asset: "ETH",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    collectedAt: "2026-08-03T00:00:00.000Z",
    pageSize: 200,
    pageLimit: 3,
    ...overrides,
  };
}

function createCandle(
  market: "KRW-BTC" | "KRW-ETH",
  openTimeUtc: string,
  closePrice: number,
): UpbitCandleSnapshot {
  return {
    market,
    candle_date_time_utc: openTimeUtc,
    candle_date_time_kst: openTimeUtc,
    opening_price: closePrice * 0.99,
    high_price: closePrice * 1.02,
    low_price: closePrice * 0.98,
    trade_price: closePrice,
    timestamp: Date.parse(`${openTimeUtc}Z`),
    candle_acc_trade_price: closePrice * 100,
    candle_acc_trade_volume: 100,
  };
}
