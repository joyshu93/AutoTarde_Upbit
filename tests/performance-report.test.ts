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
      { market: "KRW-BTC", priceKrw: 120 },
      { market: "KRW-ETH", priceKrw: 210 },
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
      id: "position-mark-boundary",
      capturedAt: "2026-08-02T00:00:00.000Z",
      source: "RECONCILIATION",
    });
  } finally {
    await rm(databasePath, { force: true });
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
    assert.equal(result.provenance.openingSnapshot?.id, "migrated-opening");
    assert.equal(result.provenance.markSnapshot?.id, "migrated-mark");
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
    assert.match(text, /mark_snapshot: position-mark-boundary @ 2026-08-02T00:00:00.000Z/);
    assert.match(text, /KRW-BTC/);
    assert.match(text, /KRW-ETH/);
    assert.ok(text.indexOf("KRW-BTC") < text.indexOf("KRW-ETH"));
    assert.match(
      text,
      /selected order stream performance; it is not total account return/i,
    );

    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["provenance", "performance", "disclaimer"]);
    assert.equal(
      parsed.disclaimer,
      "This is selected order stream performance; it is not total account return.",
    );
    assert.equal(formatPerformanceReport(report, "json"), json);

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
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
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
      INSERT INTO orders (id, exchange_account_id, market, side, origin, execution_mode)
      VALUES (?, ?, ?, ?, ?, ?)
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
