import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import {
  readPerformanceInput,
  type PerformanceReadFilters,
} from "../src/modules/performance/sqlite-performance-reader.js";
import {
  buildPerformanceReport,
  formatPerformanceReport,
  parsePerformanceReportArgs,
} from "../src/research/performance-report.js";
import { test } from "./harness.js";

test("performance report CLI requires explicit filters and parses valueless --json", () => {
  const parsed = parsePerformanceReportArgs([
    "--database",
    "./var/report.sqlite",
    "--exchange-account",
    "primary",
    "--mode",
    "LIVE",
    "--origin",
    "STRATEGY",
    "--from",
    "2026-08-01T00:00:00.000Z",
    "--to",
    "2026-08-02T00:00:00.000Z",
    "--json",
  ]);

  assert.deepEqual(parsed, {
    databasePath: "./var/report.sqlite",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    origin: "STRATEGY",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    output: "json",
  });

  assert.throws(
    () => parsePerformanceReportArgs(["--database", "db.sqlite"]),
    /Missing required argument --exchange-account/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--unknown", "value")),
    /Unknown argument --unknown/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--mode", "LIVE")),
    /Duplicate argument --mode/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(replaceArg(requiredArgs(), "--mode", "PAPER")),
    /Invalid --mode/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--json", "true")),
    /Unexpected argument true/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--from", "not-a-date")),
    /Invalid --from timestamp/,
  );
  assert.throws(
    () =>
      parsePerformanceReportArgs(
        requiredArgs(
          "--from",
          "2026-08-02T00:00:00.000Z",
          "--to",
          "2026-08-02T00:00:00.000Z",
        ),
      ),
    /--from must be earlier than --to/,
  );
});

test("performance report timestamps require explicit ISO timezone and normalize to UTC", async () => {
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--from", "08/01/2026")),
    /Invalid --from timestamp.*explicit ISO-8601 timezone/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--from", "2026-08-01T00:00:00")),
    /Invalid --from timestamp.*explicit ISO-8601 timezone/,
  );
  assert.throws(
    () => parsePerformanceReportArgs(requiredArgs("--from", "2026-08-01T00:00:00.1234567890Z")),
    /Invalid --from timestamp.*explicit ISO-8601 timezone/,
  );

  const parsed = parsePerformanceReportArgs(
    requiredArgs(
      "--from",
      "2026-08-01T09:00:00+09:00",
      "--to",
      "2026-08-02T09:00:00+09:00",
    ),
  );
  assert.equal(parsed.from, "2026-08-01T00:00:00.000Z");
  assert.equal(parsed.to, "2026-08-02T00:00:00.000Z");

  const precise = parsePerformanceReportArgs(
    requiredArgs(
      "--from",
      "2026-07-06T18:27:39.360311+09:00",
      "--to",
      "2026-07-06T18:27:39.360312+09:00",
    ),
  );
  assert.equal(precise.from, "2026-07-06T09:27:39.360311Z");
  assert.equal(precise.to, "2026-07-06T09:27:39.360312Z");

  const databasePath = await createPerformanceFixture("canonical-timezone");
  try {
    assert.throws(
      () =>
        readPerformanceInput({
          ...baseFilters(databasePath),
          from: "08/01/2026",
        }),
      /from must be an ISO-8601 timestamp with an explicit timezone/,
    );
    const result = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T09:00:00+09:00",
      to: "2026-08-02T09:00:00+09:00",
    });
    assert.equal(result.provenance.filters.from, "2026-08-01T00:00:00.000Z");
    assert.equal(result.provenance.filters.to, "2026-08-02T00:00:00.000Z");
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader orders and filters fills within one millisecond", async () => {
  const databasePath = await createPerformanceFixture("sub-millisecond-fills");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE fills SET filled_at = ? WHERE id = ?").run(
      "2026-08-01T12:00:00.000200Z",
      "fill-in-period",
    );
    db.prepare(`
      INSERT INTO orders (
        id, strategy_decision_id, exchange_account_id, market, side, origin, execution_mode
      ) VALUES (?, NULL, ?, ?, ?, ?, ?)
    `).run("order-z-earlier", "primary", "KRW-BTC", "ask", "STRATEGY", "LIVE");
    db.prepare(`
      INSERT INTO fills (
        id, order_id, market, side, price, volume, fee_currency, fee_amount, filled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "z-earlier",
      "order-z-earlier",
      "KRW-BTC",
      "ask",
      "109",
      "0.1",
      "KRW",
      "0.01",
      "2026-08-01T12:00:00.000100Z",
    );
  } finally {
    db.close();
  }

  try {
    const ordered = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T12:00:00.000050Z",
      to: "2026-08-01T12:00:00.000250Z",
    });
    assert.deepEqual(ordered.tradeFills.map((fill) => fill.id), ["z-earlier", "fill-in-period"]);

    const filtered = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T12:00:00.000150Z",
      to: "2026-08-01T12:00:00.000250Z",
    });
    assert.deepEqual(filtered.tradeFills.map((fill) => fill.id), ["fill-in-period"]);
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader applies persisted filters and [from,to) snapshot provenance", async () => {
  const databasePath = await createPerformanceFixture("bounded");
  try {
    const result = readPerformanceInput({
      databasePath,
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      origin: "STRATEGY",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });

    assert.deepEqual(
      result.input.fills.map((fill) => fill.id),
      ["fill-in-period"],
    );
    assert.deepEqual(result.input.openingPositions, [
      { market: "KRW-BTC", quantity: 0.5, averagePriceKrw: 90 },
      { market: "KRW-ETH", quantity: 1, averagePriceKrw: 190 },
    ]);
    assert.deepEqual(result.input.markPrices, [
      { market: "KRW-BTC", priceKrw: 105 },
      { market: "KRW-ETH", priceKrw: 190 },
    ]);
    assert.deepEqual(result.provenance.filters, {
      databasePath,
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      origin: "STRATEGY",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      periodSemantics: "[from,to)",
    });
    assert.equal(result.provenance.fillCount, 1);
    assert.equal(result.provenance.firstFillAt, "2026-08-01T12:00:00.000Z");
    assert.equal(result.provenance.lastFillAt, "2026-08-01T12:00:00.000Z");
    assert.deepEqual(result.provenance.openingSnapshot, {
      id: "position-opening-boundary",
      capturedAt: "2026-08-01T00:00:00.000Z",
      source: "RECONCILIATION",
    });
    assert.deepEqual(result.provenance.markSnapshot, {
      id: "position-opening-boundary",
      capturedAt: "2026-08-01T00:00:00.000Z",
      source: "RECONCILIATION",
    });
    assert.deepEqual(
      result.markObservations.map((observation) => ({
        snapshotId: observation.snapshotId,
        capturedAt: observation.capturedAt,
      })),
      [{
        snapshotId: "position-opening-boundary",
        capturedAt: "2026-08-01T00:00:00.000Z",
      }],
    );
    assert.deepEqual(result.markObservations[0]?.prices, {
      "KRW-BTC": 105,
      "KRW-ETH": 190,
    });
    assert.equal(result.provenance.markObservationCount, 1);
    assert.equal(result.provenance.firstMarkObservationAt, "2026-08-01T00:00:00.000Z");
    assert.equal(result.provenance.lastMarkObservationAt, "2026-08-01T00:00:00.000Z");
  } finally {
    await rm(databasePath, { force: true });
  }
});

test("SQLite performance reader recovers one exact persisted order fee without overriding fill evidence", async () => {
  const databasePath = await createPerformanceFixture("single-order-fee-recovery");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(`
      UPDATE fills
      SET exchange_fill_id = ?, fee_currency = NULL, fee_amount = NULL
      WHERE id = ?
    `).run("trade-in-period", "fill-in-period");
    db.prepare("UPDATE orders SET exchange_response_json = ? WHERE id = ?").run(
      JSON.stringify({
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades_count: 1,
        trades: [{
          uuid: "trade-in-period",
          market: "KRW-BTC",
          side: "ask",
          price: "110",
          volume: "0.1",
          fee: "0.055",
        }],
      }),
      "order-in-period",
    );
    db.prepare("UPDATE orders SET exchange_response_json = ? WHERE id = ?").run(
      JSON.stringify({
        market: "KRW-BTC",
        side: "bid",
        paid_fee: "999",
        trades: [{
          uuid: "ignored-because-fill-fee-exists",
          market: "KRW-BTC",
          side: "bid",
          price: "100",
          volume: "0.1",
        }],
      }),
      "order-before-period",
    );
  } finally {
    db.close();
  }

  try {
    const result = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-07-31T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(result.tradeFills.find((fill) => fill.id === "fill-in-period")?.feeKrw, 0.055);
    assert.equal(result.tradeFills.find((fill) => fill.id === "fill-before-period")?.feeKrw, 0.01);
    assert.deepEqual(Reflect.get(result.provenance, "feeEvidence"), {
      persistedFillFeeCount: 1,
      recoveredOrderPaidFeeCount: 1,
      unknownFeeCount: 0,
    });
    assert.deepEqual(Reflect.get(result.provenance, "dataQualityWarnings"), []);
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader keeps legacy schemas readable when fee recovery columns are absent", async () => {
  const databasePath = path.resolve(
    process.cwd(),
    `.tmp-performance-legacy-fee-schema-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE position_snapshots (
        id TEXT PRIMARY KEY,
        exchange_account_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source TEXT NOT NULL,
        positions_json TEXT NOT NULL
      );
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
      INSERT INTO orders VALUES
        ('legacy-order-known', NULL, 'primary', 'KRW-BTC', 'bid', 'STRATEGY', 'LIVE'),
        ('legacy-order-unknown', NULL, 'primary', 'KRW-BTC', 'ask', 'STRATEGY', 'LIVE');
      INSERT INTO fills VALUES
        ('legacy-fill-known', 'legacy-order-known', 'KRW-BTC', 'bid', '100', '0.1', 'KRW', '0.01', '2026-08-01T01:00:00.000Z'),
        ('legacy-fill-unknown', 'legacy-order-unknown', 'KRW-BTC', 'ask', '110', '0.1', NULL, NULL, '2026-08-01T02:00:00.000Z');
    `);
  } finally {
    db.close();
  }

  try {
    const result = readPerformanceInput(baseFilters(databasePath));
    assert.deepEqual(result.tradeFills.map((fill) => fill.feeKrw), [0.01, null]);
    assert.deepEqual(result.provenance.feeEvidence, {
      persistedFillFeeCount: 1,
      recoveredOrderPaidFeeCount: 0,
      unknownFeeCount: 1,
    });
    assert.equal(result.provenance.dataQualityWarnings[0]?.code, "MISSING_ORDER_FEE_EVIDENCE");
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader leaves ambiguous malformed and mismatched order fee evidence unknown", async () => {
  const cases = [
    {
      label: "multiple-local-fills",
      response: {
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades: [{ uuid: "trade-in-period", market: "KRW-BTC", side: "ask", price: "110", volume: "0.1" }],
      },
      code: "AMBIGUOUS_ORDER_FEE_EVIDENCE",
      extraLocalFill: true,
    },
    {
      label: "multiple-trades",
      response: {
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades: [
          { uuid: "trade-in-period", market: "KRW-BTC", side: "ask", price: "110", volume: "0.1" },
          { uuid: "another-trade", market: "KRW-BTC", side: "ask", price: "110", volume: "0.1" },
        ],
      },
      code: "AMBIGUOUS_ORDER_FEE_EVIDENCE",
      extraLocalFill: false,
    },
    {
      label: "malformed",
      response: "not-json",
      code: "MALFORMED_ORDER_FEE_EVIDENCE",
      extraLocalFill: false,
    },
    {
      label: "mismatch",
      response: {
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades: [{
          uuid: "trade-in-period",
          market: "KRW-BTC",
          side: "ask",
          price: "111",
          volume: "0.1",
        }],
      },
      code: "MISMATCHED_ORDER_FEE_EVIDENCE",
      extraLocalFill: false,
    },
    {
      label: "precision-mismatch",
      response: {
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades: [{
          uuid: "trade-in-period",
          market: "KRW-BTC",
          side: "ask",
          price: "110.0000000000000000001",
          volume: "0.1",
        }],
      },
      code: "MISMATCHED_ORDER_FEE_EVIDENCE",
      extraLocalFill: false,
    },
    {
      label: "partial-trades-count",
      response: {
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades_count: 2,
        trades: [{
          uuid: "trade-in-period",
          market: "KRW-BTC",
          side: "ask",
          price: "110",
          volume: "0.1",
        }],
      },
      code: "AMBIGUOUS_ORDER_FEE_EVIDENCE",
      extraLocalFill: false,
    },
    {
      label: "contradictory-trade-fee",
      response: {
        market: "KRW-BTC",
        side: "ask",
        paid_fee: "0.055",
        trades_count: 1,
        trades: [{
          uuid: "trade-in-period",
          market: "KRW-BTC",
          side: "ask",
          price: "110",
          volume: "0.1",
          fee: "0.054",
        }],
      },
      code: "MISMATCHED_ORDER_FEE_EVIDENCE",
      extraLocalFill: false,
    },
  ] as const;

  for (const fixture of cases) {
    const databasePath = await createPerformanceFixture(`fee-${fixture.label}`);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(`
        UPDATE fills
        SET exchange_fill_id = ?, fee_currency = NULL, fee_amount = NULL
        WHERE id = ?
      `).run("trade-in-period", "fill-in-period");
      db.prepare("UPDATE orders SET exchange_response_json = ? WHERE id = ?").run(
        fixture.response === "not-json" ? fixture.response : JSON.stringify(fixture.response),
        "order-in-period",
      );
      if (fixture.extraLocalFill) {
        db.prepare(`
          INSERT INTO fills (
            id, order_id, exchange_fill_id, market, side, price, volume,
            fee_currency, fee_amount, filled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        `).run(
          "fill-in-period-extra",
          "order-in-period",
          "trade-in-period-extra",
          "KRW-BTC",
          "ask",
          "110",
          "0.01",
          "2026-08-01T12:00:01.000Z",
        );
      }
    } finally {
      db.close();
    }

    try {
      const result = readPerformanceInput({
        ...baseFilters(databasePath),
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
      });
      assert.equal(result.tradeFills.find((fill) => fill.id === "fill-in-period")?.feeKrw, null);
      assert.equal(
        Reflect.get(result.provenance, "feeEvidence")?.unknownFeeCount,
        fixture.extraLocalFill ? 2 : 1,
      );
      assert.equal(
        Reflect.get(result.provenance, "dataQualityWarnings")?.[0]?.code,
        fixture.code,
      );
    } finally {
      await cleanupPerformanceDatabase(databasePath);
    }
  }
});

test("SQLite performance reader keeps period opening and exposes a strict pre-fill attribution baseline", async () => {
  const databasePath = await createPerformanceFixture("strict-attribution-opening");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(`
      INSERT INTO position_snapshots (
        id, exchange_account_id, captured_at, source, positions_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "position-same-time-as-first-fill",
      "primary",
      "2026-08-01T12:00:00.000Z",
      "RECONCILIATION",
      positionsJson("9", "999", "999", "0", "190", "190"),
    );
  } finally {
    db.close();
  }

  try {
    const result = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T12:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.deepEqual(result.input.openingPositions, [
      { market: "KRW-BTC", quantity: 9, averagePriceKrw: 999 },
    ]);
    assert.deepEqual(Reflect.get(result, "attributionInput")?.openingPositions, [
      { market: "KRW-BTC", quantity: 0.5, averagePriceKrw: 90 },
      { market: "KRW-ETH", quantity: 1, averagePriceKrw: 190 },
    ]);
    assert.deepEqual(Reflect.get(result.provenance, "attributionOpeningSnapshot"), {
      id: "position-opening-boundary",
      capturedAt: "2026-08-01T00:00:00.000Z",
      source: "RECONCILIATION",
    });
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader enriches fills with validated strategy decision evidence", async () => {
  const databasePath = await createPerformanceFixture("decision-evidence");
  const db = new DatabaseSync(databasePath);
  try {
    insertDecision(db, {
      id: "decision-exit",
      accountId: "primary",
      market: "KRW-BTC",
      action: "EXIT",
    });
    db.prepare("UPDATE orders SET strategy_decision_id = ? WHERE id = ?").run(
      "decision-exit",
      "order-in-period",
    );
  } finally {
    db.close();
  }

  try {
    const result = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.deepEqual(result.tradeFills, [{
      id: "fill-in-period",
      orderId: "order-in-period",
      strategyDecisionId: "decision-exit",
      decisionAction: "EXIT",
      market: "KRW-BTC",
      side: "ask",
      priceKrw: 110,
      volume: 0.1,
      feeKrw: 0.01,
      filledAt: "2026-08-01T12:00:00.000Z",
    }]);
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader rejects missing and contradictory strategy decision links", async () => {
  const cases = [
    {
      label: "missing-decision",
      prepare(db: DatabaseSync): void {
        db.prepare("UPDATE orders SET strategy_decision_id = ? WHERE id = ?").run(
          "missing-decision",
          "order-in-period",
        );
      },
      expected: /Order order-in-period references missing strategy decision missing-decision/,
    },
    {
      label: "decision-account",
      prepare(db: DatabaseSync): void {
        insertDecision(db, {
          id: "bad-account",
          accountId: "secondary",
          market: "KRW-BTC",
          action: "EXIT",
        });
        db.prepare("UPDATE orders SET strategy_decision_id = ? WHERE id = ?").run(
          "bad-account",
          "order-in-period",
        );
      },
      expected: /decision account secondary does not match order account primary/,
    },
    {
      label: "decision-market",
      prepare(db: DatabaseSync): void {
        insertDecision(db, {
          id: "bad-market",
          accountId: "primary",
          market: "KRW-ETH",
          action: "EXIT",
        });
        db.prepare("UPDATE orders SET strategy_decision_id = ? WHERE id = ?").run(
          "bad-market",
          "order-in-period",
        );
      },
      expected: /decision market KRW-ETH does not match order market KRW-BTC/,
    },
    {
      label: "decision-action",
      prepare(db: DatabaseSync): void {
        insertDecision(db, {
          id: "bad-action",
          accountId: "primary",
          market: "KRW-BTC",
          action: "ENTER",
        });
        db.prepare("UPDATE orders SET strategy_decision_id = ? WHERE id = ?").run(
          "bad-action",
          "order-in-period",
        );
      },
      expected: /decision action ENTER contradicts ask order side/,
    },
    {
      label: "decision-hold",
      prepare(db: DatabaseSync): void {
        insertDecision(db, {
          id: "bad-hold",
          accountId: "primary",
          market: "KRW-BTC",
          action: "HOLD",
        });
        db.prepare("UPDATE orders SET strategy_decision_id = ? WHERE id = ?").run(
          "bad-hold",
          "order-in-period",
        );
      },
      expected: /decision action HOLD cannot be linked to a fill/,
    },
  ] as const;

  for (const fixture of cases) {
    const databasePath = await createPerformanceFixture(fixture.label);
    const db = new DatabaseSync(databasePath);
    try {
      fixture.prepare(db);
    } finally {
      db.close();
    }
    try {
      assert.throws(
        () => readPerformanceInput({
          ...baseFilters(databasePath),
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        }),
        fixture.expected,
      );
    } finally {
      await cleanupPerformanceDatabase(databasePath);
    }
  }
});

test("SQLite performance reader selects pre-fill opening snapshot and latest mark without bounds", async () => {
  const databasePath = await createPerformanceFixture("unbounded");
  try {
    const result = readPerformanceInput(baseFilters(databasePath));

    assert.equal(result.provenance.openingSnapshot?.id, "position-before-first-fill");
    assert.equal(result.provenance.markSnapshot?.id, "position-latest");
    assert.deepEqual(
      result.input.fills.map((fill) => fill.id),
      ["fill-before-period", "fill-in-period", "fill-at-to"],
    );
  } finally {
    await rm(databasePath, { force: true });
  }
});

test("SQLite performance reader opens an existing database read-only without changing it", async () => {
  const databasePath = await createPerformanceFixture("readonly");
  const missingPath = `${databasePath}.missing`;
  try {
    const before = await checksum(databasePath);
    readPerformanceInput(baseFilters(databasePath));
    const after = await checksum(databasePath);
    assert.equal(after, before);

    assert.throws(() => readPerformanceInput(baseFilters(missingPath)));
    await assert.rejects(readFile(missingPath), /ENOENT/);
  } finally {
    await rm(databasePath, { force: true });
    await rm(missingPath, { force: true });
  }
});

test("SQLite performance reader rejects invalid persisted numeric data", async () => {
  const databasePath = await createPerformanceFixture("invalid-number");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE fills SET price = ? WHERE id = ?").run("not-a-number", "fill-in-period");
  } finally {
    db.close();
  }

  try {
    assert.throws(
      () =>
        readPerformanceInput({
          ...baseFilters(databasePath),
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        }),
      /Fill fill-in-period price must be a finite numeric string/,
    );
  } finally {
    await rm(databasePath, { force: true });
  }
});

test("SQLite performance reader rejects damaged selected fill and account snapshot timestamps", async () => {
  const fillDatabasePath = await createPerformanceFixture("invalid-fill-time");
  const fillDb = new DatabaseSync(fillDatabasePath);
  try {
    fillDb.prepare("UPDATE fills SET filled_at = ? WHERE id = ?").run(
      "damaged-time",
      "fill-in-period",
    );
  } finally {
    fillDb.close();
  }
  try {
    assert.throws(
      () =>
        readPerformanceInput({
          ...baseFilters(fillDatabasePath),
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        }),
      /Fill fill-in-period filled_at must be an ISO-8601 timestamp with an explicit timezone/,
    );
  } finally {
    await cleanupPerformanceDatabase(fillDatabasePath);
  }

  const snapshotDatabasePath = await createPerformanceFixture("invalid-snapshot-time");
  const snapshotDb = new DatabaseSync(snapshotDatabasePath);
  try {
    snapshotDb.prepare("UPDATE position_snapshots SET captured_at = ? WHERE id = ?").run(
      "damaged-time",
      "position-latest",
    );
  } finally {
    snapshotDb.close();
  }
  try {
    assert.throws(
      () =>
        readPerformanceInput({
          ...baseFilters(snapshotDatabasePath),
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        }),
      /Position snapshot position-latest captured_at must be an ISO-8601 timestamp with an explicit timezone/,
    );
  } finally {
    await cleanupPerformanceDatabase(snapshotDatabasePath);
  }
});

test("SQLite performance reader ignores out-of-period snapshot payload and source corruption", async () => {
  const databasePath = await createPerformanceFixture("out-of-period-snapshot-payload");
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(`
      UPDATE position_snapshots
      SET source = ?, positions_json = ?
      WHERE id = ?
    `).run("", "not-json", "position-latest");
  } finally {
    db.close();
  }

  try {
    const result = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(result.provenance.markSnapshot?.id, "position-opening-boundary");
    assert.deepEqual(result.markObservations.map((item) => item.snapshotId), [
      "position-opening-boundary",
    ]);
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("SQLite performance reader rejects selected snapshot payload and source corruption", async () => {
  const cases = [
    {
      label: "selected-snapshot-source",
      column: "source",
      value: "",
      expected: /Position snapshot position-opening-boundary source must be a non-empty string/,
    },
    {
      label: "selected-snapshot-json",
      column: "positions_json",
      value: "not-json",
      expected: /Position snapshot position-opening-boundary positions_json must be valid JSON/,
    },
  ] as const;

  for (const fixture of cases) {
    const databasePath = await createPerformanceFixture(fixture.label);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(`UPDATE position_snapshots SET ${fixture.column} = ? WHERE id = ?`).run(
        fixture.value,
        "position-opening-boundary",
      );
    } finally {
      db.close();
    }
    try {
      assert.throws(
        () => readPerformanceInput({
          ...baseFilters(databasePath),
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        }),
        fixture.expected,
      );
    } finally {
      await cleanupPerformanceDatabase(databasePath);
    }
  }
});

test("SQLite performance reader ignores out-of-period non-timestamp fill corruption", async () => {
  const numericDatabasePath = await createPerformanceFixture("out-of-period-number");
  const numericDb = new DatabaseSync(numericDatabasePath);
  try {
    numericDb.prepare("UPDATE fills SET price = ? WHERE id = ?").run(
      "not-a-number",
      "fill-before-period",
    );
  } finally {
    numericDb.close();
  }
  try {
    const result = readPerformanceInput({
      ...baseFilters(numericDatabasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.deepEqual(result.input.fills.map((fill) => fill.id), ["fill-in-period"]);
  } finally {
    await cleanupPerformanceDatabase(numericDatabasePath);
  }

  const mismatchDatabasePath = await createPerformanceFixture("out-of-period-mismatch");
  const mismatchDb = new DatabaseSync(mismatchDatabasePath);
  try {
    mismatchDb.prepare("UPDATE fills SET market = ? WHERE id = ?").run(
      "KRW-ETH",
      "fill-before-period",
    );
  } finally {
    mismatchDb.close();
  }
  try {
    const result = readPerformanceInput({
      ...baseFilters(mismatchDatabasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.deepEqual(result.input.fills.map((fill) => fill.id), ["fill-in-period"]);
  } finally {
    await cleanupPerformanceDatabase(mismatchDatabasePath);
  }
});

test("SQLite performance reader rejects order and fill market or side mismatches", async () => {
  const marketDatabasePath = await createPerformanceFixture("market-mismatch");
  const marketDb = new DatabaseSync(marketDatabasePath);
  try {
    marketDb.prepare("UPDATE fills SET market = ? WHERE id = ?").run(
      "KRW-ETH",
      "fill-in-period",
    );
  } finally {
    marketDb.close();
  }
  try {
    assert.throws(
      () => readPerformanceInput(baseFilters(marketDatabasePath)),
      /Fill fill-in-period market KRW-ETH does not match order market KRW-BTC/,
    );
  } finally {
    await cleanupPerformanceDatabase(marketDatabasePath);
  }

  const sideDatabasePath = await createPerformanceFixture("side-mismatch");
  const sideDb = new DatabaseSync(sideDatabasePath);
  try {
    sideDb.prepare("UPDATE fills SET side = ? WHERE id = ?").run("bid", "fill-in-period");
  } finally {
    sideDb.close();
  }
  try {
    assert.throws(
      () => readPerformanceInput(baseFilters(sideDatabasePath)),
      /Fill fill-in-period side bid does not match order side ask/,
    );
  } finally {
    await cleanupPerformanceDatabase(sideDatabasePath);
  }
});

test("SQLite performance reader is compatible with the fully migrated operational schema", async () => {
  const databasePath = await createMigratedPerformanceFixture("migrated-schema");
  try {
    const result = readPerformanceInput({
      ...baseFilters(databasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });

    assert.equal(result.provenance.fillCount, 1);
    assert.equal(result.input.fills[0]?.id, "migrated-fill");
    assert.equal(result.tradeFills[0]?.orderId, "migrated-order");
    assert.equal(result.tradeFills[0]?.decisionAction, null);
    assert.deepEqual(result.markObservations.map((item) => item.snapshotId), ["migrated-opening"]);
    assert.equal(result.provenance.openingSnapshot?.id, "migrated-opening");
    assert.equal(result.provenance.markSnapshot?.id, "migrated-opening");
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("performance report exposes stable provenance and selected-stream disclaimer", async () => {
  const databasePath = await createPerformanceFixture("format");
  try {
    const report = buildPerformanceReport({
      ...baseFilters(databasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      output: "text",
    });
    const text = formatPerformanceReport(report, "text");
    const json = formatPerformanceReport(report, "json");

    assert.match(text, /Performance Report/);
    assert.match(text, /period: \[2026-08-01T00:00:00.000Z, 2026-08-02T00:00:00.000Z\)/);
    assert.match(text, /opening_snapshot: position-opening-boundary @ 2026-08-01T00:00:00.000Z/);
    assert.match(text, /mark_snapshot: position-opening-boundary @ 2026-08-01T00:00:00.000Z/);
    assert.match(text, /KRW-BTC/);
    assert.match(text, /KRW-ETH/);
    assert.ok(text.indexOf("KRW-BTC") < text.indexOf("KRW-ETH"));
    assert.match(
      text,
      /selected order stream performance; it is not total account return/i,
    );

    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [
      "provenance",
      "performance",
      "diagnostics",
      "recentCompletedEpisodes",
      "disclaimer",
    ]);
    const diagnostics = parsed.diagnostics as {
      policy: { breakevenToleranceKrw: number };
      combined: { completedEpisodeCount: number; selectedSliceCount: number };
      realizedPnlCurve: { equityDefinition: string; observationFrequency: string };
      markPnlCurve: { observationFrequency: string; sampleCount: number };
    };
    assert.equal(diagnostics.policy.breakevenToleranceKrw, 1e-9);
    assert.equal(diagnostics.combined.completedEpisodeCount, 0);
    assert.equal(diagnostics.combined.selectedSliceCount, 0);
    assert.equal(
      diagnostics.realizedPnlCurve.equityDefinition,
      "CUMULATIVE_SELECTED_STREAM_REALIZED_PNL_KRW",
    );
    assert.equal(diagnostics.realizedPnlCurve.observationFrequency, "SELL_FILL_EPOCH");
    assert.equal(diagnostics.markPnlCurve.observationFrequency, "PERSISTED_MARK_SNAPSHOT");
    assert.equal(diagnostics.markPnlCurve.sampleCount, 1);
    assert.deepEqual(parsed.recentCompletedEpisodes, []);
    assert.equal(
      parsed.disclaimer,
      "This is selected order stream performance; it is not total account return.",
    );
    assert.equal(formatPerformanceReport(report, "json"), json);
    assert.doesNotMatch(json, /NaN|Infinity/);
    assert.match(text, /Episode win unit: completed position episodes/);
    assert.match(text, /FIFO realization slices/);
    assert.match(text, /gross_realized_pnl_krw:/);
    assert.match(text, /fee_completeness:/);
    assert.match(text, /Realized curve: CUMULATIVE_SELECTED_STREAM_REALIZED_PNL_KRW/);
    assert.match(text, /Snapshot mark curve: SELECTED_STREAM_ATTRIBUTED_PNL_KRW/);
    assert.match(text, /entry_action_contribution:/);
    assert.match(text, /exit_action_contribution:/);
    assert.match(text, /KRW-BTC realized drawdown:/);
    assert.match(text, /KRW-ETH snapshot mark drawdown:/);
    assert.match(text, /Recent completed episodes \(most recent, max 10\):/);
    assert.match(text, /mark_observations: 1/);

    const unknownFeesReport = {
      ...report,
      performance: {
        ...report.performance,
        markets: report.performance.markets.map((market) => ({
          ...market,
          paidFeesKrw: null,
        })),
        totals: {
          ...report.performance.totals,
          paidFeesKrw: null,
        },
      },
    } as unknown as typeof report;
    const unknownFeesText = formatPerformanceReport(unknownFeesReport, "text");
    assert.match(unknownFeesText, /paid_fees_krw: unknown/);
    assert.doesNotMatch(unknownFeesText, /paid_fees_krw: 0(?:\.0+)?\b/);
  } finally {
    await rm(databasePath, { force: true });
  }
});

test("performance report text distinguishes persisted marks from usable curve points", async () => {
  const databasePath = await createPerformanceFixture("mark-coverage-text");
  try {
    const report = buildPerformanceReport({
      ...baseFilters(databasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      output: "text",
    });
    const partialCurve = {
      ...report.diagnostics.markPnlCurve,
      persistedObservationCount: 3,
      usableObservationCount: 2,
      sampleCount: 2,
      excludedObservations: [{
        snapshotId: "snapshot-excluded-1",
        capturedAt: "2026-08-01T03:00:00.000Z",
        market: "KRW-BTC",
        metricScopes: ["GROSS", "NET"],
        reasonCodes: ["MISSING_ACTIVE_POSITION_MARK"],
      }] as const,
    };
    const unusableEthCurve = {
      ...report.diagnostics.marketMarkPnlCurves["KRW-ETH"],
      persistedObservationCount: 3,
      usableObservationCount: 0,
      sampleCount: 0,
    };
    const coverageReport = {
      ...report,
      diagnostics: {
        ...report.diagnostics,
        markPnlCurve: partialCurve,
        marketMarkPnlCurves: {
          ...report.diagnostics.marketMarkPnlCurves,
          "KRW-ETH": unusableEthCurve,
        },
      },
    };

    const text = formatPerformanceReport(coverageReport, "text");

    assert.match(
      text,
      /Snapshot mark curve: .*persisted_observation_count=3; usable_observation_count=2; curve_points=2; coverage=PARTIAL;/,
    );
    assert.match(
      text,
      /KRW-ETH snapshot mark drawdown: .*persisted_observation_count=3 usable_observation_count=0 curve_points=0 coverage=UNUSABLE/,
    );
    assert.match(
      text,
      /Usable snapshot mark points require persisted snapshots with complete mark and cost evidence;/,
    );
    assert.match(text, /Excluded mark observations: 1/);
    assert.match(
      text,
      /snapshot-excluded-1 .* KRW-BTC .* GROSS,NET .* MISSING_ACTIVE_POSITION_MARK/,
    );
    assert.match(text, /Full exclusion manifest is retained in JSON output/);
    assert.doesNotMatch(text, /use each persisted snapshot mark/);

    const coalescedText = formatPerformanceReport({
      ...report,
      diagnostics: {
        ...report.diagnostics,
        markPnlCurve: {
          ...report.diagnostics.markPnlCurve,
          persistedObservationCount: 2,
          usableObservationCount: 1,
          sampleCount: 1,
          excludedObservations: [],
        },
      },
    }, "text");
    assert.match(
      coalescedText,
      /Snapshot mark curve: .*persisted_observation_count=2; usable_observation_count=1; curve_points=1; coverage=COMPLETE;/,
    );
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

test("building the diagnostics report leaves the migrated SQLite checksum unchanged", async () => {
  const databasePath = await createMigratedPerformanceFixture("diagnostics-readonly");
  try {
    const before = await checksum(databasePath);
    const report = buildPerformanceReport({
      ...baseFilters(databasePath),
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      output: "json",
    });
    const output = formatPerformanceReport(report, "json");
    const after = await checksum(databasePath);
    assert.equal(after, before);
    assert.doesNotMatch(output, /NaN|Infinity/);
  } finally {
    await cleanupPerformanceDatabase(databasePath);
  }
});

function requiredArgs(...extra: string[]): string[] {
  return [
    "--database",
    "db.sqlite",
    "--exchange-account",
    "primary",
    "--mode",
    "LIVE",
    "--origin",
    "STRATEGY",
    ...extra,
  ];
}

function replaceArg(args: string[], key: string, value: string): string[] {
  const copy = [...args];
  const index = copy.indexOf(key);
  assert.notEqual(index, -1);
  copy[index + 1] = value;
  return copy;
}

function baseFilters(databasePath: string): PerformanceReadFilters {
  return {
    databasePath,
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    origin: "STRATEGY",
  };
}

async function createPerformanceFixture(label: string): Promise<string> {
  const databasePath = path.resolve(
    process.cwd(),
    `.tmp-performance-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE position_snapshots (
        id TEXT PRIMARY KEY,
        exchange_account_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source TEXT NOT NULL,
        positions_json TEXT NOT NULL
      );
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
        execution_mode TEXT NOT NULL,
        exchange_response_json TEXT
      );
      CREATE TABLE fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        exchange_fill_id TEXT,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        price TEXT NOT NULL,
        volume TEXT NOT NULL,
        fee_currency TEXT,
        fee_amount TEXT,
        filled_at TEXT NOT NULL
      );
    `);

    const insertSnapshot = db.prepare(`
      INSERT INTO position_snapshots (
        id, exchange_account_id, captured_at, source, positions_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    insertSnapshot.run(
      "position-before-first-fill",
      "primary",
      "2026-07-31T00:00:00.000Z",
      "RECONCILIATION",
      positionsJson("0.4", "80", "100", "1", "180", "180"),
    );
    insertSnapshot.run(
      "position-opening-boundary",
      "primary",
      "2026-08-01T00:00:00.000Z",
      "RECONCILIATION",
      positionsJson("0.5", "90", "105", "1", "190", "190"),
    );
    insertSnapshot.run(
      "position-mark-boundary",
      "primary",
      "2026-08-02T00:00:00.000Z",
      "RECONCILIATION",
      positionsJson("0.6", "95", "120", "1", "195", "210"),
    );
    insertSnapshot.run(
      "position-latest",
      "primary",
      "2026-08-03T00:00:00.000Z",
      "RECONCILIATION",
      positionsJson("0.7", "100", "130", "1", "200", "220"),
    );

    const insertOrder = db.prepare(`
      INSERT INTO orders (
        id, strategy_decision_id, exchange_account_id, market, side, origin, execution_mode
      ) VALUES (?, NULL, ?, ?, ?, ?, ?)
    `);
    const insertFill = db.prepare(`
      INSERT INTO fills (
        id, order_id, market, side, price, volume, fee_currency, fee_amount, filled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    addFill(insertOrder, insertFill, {
      id: "fill-before-period",
      orderId: "order-before-period",
      market: "KRW-BTC",
      side: "bid",
      price: "100",
      volume: "0.1",
      fee: "0.01",
      filledAt: "2026-07-31T12:00:00.000Z",
    });
    addFill(insertOrder, insertFill, {
      id: "fill-in-period",
      orderId: "order-in-period",
      market: "KRW-BTC",
      side: "ask",
      price: "110",
      volume: "0.1",
      fee: "0.01",
      filledAt: "2026-08-01T12:00:00.000Z",
    });
    addFill(insertOrder, insertFill, {
      id: "fill-at-to",
      orderId: "order-at-to",
      market: "KRW-ETH",
      side: "bid",
      price: "200",
      volume: "0.1",
      fee: "0.01",
      filledAt: "2026-08-02T00:00:00.000Z",
    });
    addFill(insertOrder, insertFill, {
      id: "fill-other-origin",
      orderId: "order-other-origin",
      market: "KRW-BTC",
      side: "bid",
      price: "100",
      volume: "0.1",
      fee: "0.01",
      filledAt: "2026-08-01T13:00:00.000Z",
      origin: "RECOVERY",
    });
    addFill(insertOrder, insertFill, {
      id: "fill-other-account",
      orderId: "order-other-account",
      market: "KRW-BTC",
      side: "bid",
      price: "100",
      volume: "0.1",
      fee: "0.01",
      filledAt: "2026-08-01T14:00:00.000Z",
      exchangeAccountId: "secondary",
    });
    addFill(insertOrder, insertFill, {
      id: "fill-other-mode",
      orderId: "order-other-mode",
      market: "KRW-BTC",
      side: "bid",
      price: "100",
      volume: "0.1",
      fee: "0.01",
      filledAt: "2026-08-01T15:00:00.000Z",
      executionMode: "DRY_RUN",
    });
  } finally {
    db.close();
  }
  return databasePath;
}

function insertDecision(
  db: DatabaseSync,
  decision: {
    id: string;
    accountId: string;
    market: "KRW-BTC" | "KRW-ETH";
    action: "ENTER" | "ADD" | "REDUCE" | "EXIT" | "HOLD";
  },
): void {
  db.prepare(`
    INSERT INTO strategy_decisions (id, exchange_account_id, market, action)
    VALUES (?, ?, ?, ?)
  `).run(decision.id, decision.accountId, decision.market, decision.action);
}

function positionsJson(
  btcQuantity: string,
  btcAverage: string,
  btcMark: string,
  ethQuantity: string,
  ethAverage: string,
  ethMark: string,
): string {
  return JSON.stringify([
    {
      asset: "BTC",
      market: "KRW-BTC",
      quantity: btcQuantity,
      averageEntryPrice: btcAverage,
      markPrice: btcMark,
      marketValue: null,
      exposureRatio: null,
      capturedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      asset: "ETH",
      market: "KRW-ETH",
      quantity: ethQuantity,
      averageEntryPrice: ethAverage,
      markPrice: ethMark,
      marketValue: null,
      exposureRatio: null,
      capturedAt: "2026-08-01T00:00:00.000Z",
    },
  ]);
}

function addFill(
  insertOrder: ReturnType<DatabaseSync["prepare"]>,
  insertFill: ReturnType<DatabaseSync["prepare"]>,
  fixture: {
    id: string;
    orderId: string;
    market: "KRW-BTC" | "KRW-ETH";
    side: "bid" | "ask";
    price: string;
    volume: string;
    fee: string | null;
    filledAt: string;
    origin?: "STRATEGY" | "OPERATOR" | "RECOVERY";
    executionMode?: "LIVE" | "DRY_RUN";
    exchangeAccountId?: string;
  },
): void {
  insertOrder.run(
    fixture.orderId,
    fixture.exchangeAccountId ?? "primary",
    fixture.market,
    fixture.side,
    fixture.origin ?? "STRATEGY",
    fixture.executionMode ?? "LIVE",
  );
  insertFill.run(
    fixture.id,
    fixture.orderId,
    fixture.market,
    fixture.side,
    fixture.price,
    fixture.volume,
    fixture.fee === null ? null : "KRW",
    fixture.fee,
    fixture.filledAt,
  );
}

async function checksum(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function createMigratedPerformanceFixture(label: string): Promise<string> {
  const databasePath = path.resolve(
    process.cwd(),
    `.tmp-performance-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  const handle = openSqliteDatabase(databasePath);
  try {
    handle.db.prepare(`
      INSERT INTO users (
        id, telegram_user_id, telegram_chat_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "performance-user",
      "performance-telegram-user",
      null,
      "Performance Test",
      "2026-07-31T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z",
    );
    handle.db.prepare(`
      INSERT INTO exchange_accounts (
        id, user_id, exchange, venue_type, account_label, access_key_ref, secret_key_ref,
        quote_currency, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "primary",
      "performance-user",
      "UPBIT",
      "SPOT",
      "Performance",
      "test-access-ref",
      "test-secret-ref",
      "KRW",
      1,
      "2026-07-31T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z",
    );
    const insertSnapshot = handle.db.prepare(`
      INSERT INTO position_snapshots (
        id, exchange_account_id, captured_at, source, positions_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    insertSnapshot.run(
      "migrated-opening",
      "primary",
      "2026-08-01T00:00:00.000Z",
      "RECONCILIATION",
      positionsJson("0.5", "90", "100", "1", "180", "190"),
    );
    insertSnapshot.run(
      "migrated-mark",
      "primary",
      "2026-08-02T00:00:00.000Z",
      "RECONCILIATION",
      positionsJson("0.4", "90", "110", "1", "180", "200"),
    );
    handle.db.prepare(`
      INSERT INTO orders (
        id, strategy_decision_id, exchange_account_id, market, side, ord_type, volume,
        price, time_in_force, smp_type, identifier, idempotency_key, origin, requested_at,
        upbit_uuid, status, execution_mode, exchange_response_json, failure_code,
        failure_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "migrated-order",
      null,
      "primary",
      "KRW-BTC",
      "ask",
      "market",
      "0.1",
      null,
      null,
      null,
      "performance-migrated-order",
      "performance-migrated-idempotency",
      "STRATEGY",
      "2026-08-01T12:00:00.000Z",
      "performance-upbit-uuid",
      "FILLED",
      "LIVE",
      "{}",
      null,
      null,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
    );
    handle.db.prepare(`
      INSERT INTO fills (
        id, order_id, exchange_fill_id, market, side, price, volume, fee_currency,
        fee_amount, filled_at, raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "migrated-fill",
      "migrated-order",
      "migrated-exchange-fill",
      "KRW-BTC",
      "ask",
      "110",
      "0.1",
      "KRW",
      "0.01",
      "2026-08-01T12:00:00.000Z",
      "{}",
    );
  } finally {
    handle.close();
  }
  return databasePath;
}

async function cleanupPerformanceDatabase(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}
