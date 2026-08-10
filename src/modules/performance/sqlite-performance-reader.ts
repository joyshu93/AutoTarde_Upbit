import { DatabaseSync } from "node:sqlite";

import type { ExecutionMode, OrderOrigin } from "../../domain/types.js";
import type {
  PerformanceCalculationInput,
  PerformanceFill,
  PerformanceMarkPrice,
  PerformanceMarket,
  PerformanceOpeningPosition,
} from "./performance-calculator.js";

export type PerformanceReadFilters = {
  databasePath: string;
  exchangeAccountId: string;
  executionMode: ExecutionMode;
  origin: OrderOrigin;
  from?: string;
  to?: string;
};

export type PerformanceSnapshotProvenance = {
  id: string;
  capturedAt: string;
  source: string;
};

export type PerformanceReadProvenance = {
  filters: PerformanceReadFilters & { periodSemantics: "[from,to)" };
  fillCount: number;
  firstFillAt: string | null;
  lastFillAt: string | null;
  openingSnapshot: PerformanceSnapshotProvenance | null;
  markSnapshot: PerformanceSnapshotProvenance | null;
};

export type PerformanceReadResult = {
  input: PerformanceCalculationInput;
  provenance: PerformanceReadProvenance;
};

type FillRow = {
  id: unknown;
  market: unknown;
  side: unknown;
  order_market: unknown;
  order_side: unknown;
  price: unknown;
  volume: unknown;
  fee_currency: unknown;
  fee_amount: unknown;
  filled_at: unknown;
};

type SnapshotRow = {
  id: unknown;
  captured_at: unknown;
  source: unknown;
  positions_json: unknown;
};

type TimestampValidatedFillRow = {
  row: FillRow;
  id: string;
  filledAt: string;
  filledEpoch: number;
};

type PersistedPosition = {
  market?: unknown;
  quantity?: unknown;
  averageEntryPrice?: unknown;
  markPrice?: unknown;
};

export function readPerformanceInput(filters: PerformanceReadFilters): PerformanceReadResult {
  const normalizedFilters = validateFilters(filters);
  const db = new DatabaseSync(normalizedFilters.databasePath, { readOnly: true });
  try {
    const fills = readFills(db, normalizedFilters);
    const firstFillAt = fills[0]?.filledAt ?? null;
    const lastFillAt = fills.at(-1)?.filledAt ?? null;
    const snapshots = readSnapshots(db, normalizedFilters.exchangeAccountId);
    const openingSnapshot = normalizedFilters.from === undefined
      ? firstFillAt === null
        ? null
        : selectSnapshot(snapshots, "<", firstFillAt)
      : selectSnapshot(snapshots, "<=", normalizedFilters.from);
    const markSnapshot = normalizedFilters.to === undefined
      ? snapshots.at(-1) ?? null
      : selectSnapshot(snapshots, "<=", normalizedFilters.to);

    return {
      input: {
        fills,
        openingPositions: openingSnapshot === null
          ? []
          : parseOpeningPositions(openingSnapshot.positionsJson, openingSnapshot.id),
        markPrices: markSnapshot === null
          ? []
          : parseMarkPrices(markSnapshot.positionsJson, markSnapshot.id),
      },
      provenance: {
        filters: {
          databasePath: normalizedFilters.databasePath,
          exchangeAccountId: normalizedFilters.exchangeAccountId,
          executionMode: normalizedFilters.executionMode,
          origin: normalizedFilters.origin,
          ...(normalizedFilters.from === undefined ? {} : { from: normalizedFilters.from }),
          ...(normalizedFilters.to === undefined ? {} : { to: normalizedFilters.to }),
          periodSemantics: "[from,to)",
        },
        fillCount: fills.length,
        firstFillAt,
        lastFillAt,
        openingSnapshot: toSnapshotProvenance(openingSnapshot),
        markSnapshot: toSnapshotProvenance(markSnapshot),
      },
    };
  } finally {
    db.close();
  }
}

function readFills(db: DatabaseSync, filters: PerformanceReadFilters): PerformanceFill[] {
  const rows = db.prepare(`
    SELECT
      f.id,
      f.market,
      f.side,
      o.market AS order_market,
      o.side AS order_side,
      f.price,
      f.volume,
      f.fee_currency,
      f.fee_amount,
      f.filled_at
    FROM fills f
    INNER JOIN orders o ON o.id = f.order_id
    WHERE o.exchange_account_id = ?
      AND o.execution_mode = ?
      AND o.origin = ?
  `).all(
    filters.exchangeAccountId,
    filters.executionMode,
    filters.origin,
  ) as unknown as FillRow[];

  const fromEpoch = filters.from === undefined ? null : Date.parse(filters.from);
  const toEpoch = filters.to === undefined ? null : Date.parse(filters.to);
  return rows
    .map((row) => validateFillTimestamp(row))
    .filter(({ filledEpoch }) => {
      return (fromEpoch === null || filledEpoch >= fromEpoch) &&
        (toEpoch === null || filledEpoch < toEpoch);
    })
    .sort(
      (left, right) =>
        left.filledEpoch - right.filledEpoch || left.id.localeCompare(right.id),
    )
    .map(({ row, id, filledAt }) => normalizeFill(row, id, filledAt));
}

function validateFillTimestamp(row: FillRow): TimestampValidatedFillRow {
  const id = requireString(row.id, "fill.id");
  const filledAt = normalizeExplicitIsoTimestamp(row.filled_at, `Fill ${id} filled_at`);
  return { row, id, filledAt, filledEpoch: Date.parse(filledAt) };
}

function normalizeFill(row: FillRow, id: string, filledAt: string): PerformanceFill {
  const market = parseMarket(row.market, `Fill ${id} market`);
  const orderMarket = parseMarket(row.order_market, `Order market for fill ${id}`);
  const side = row.side === "bid" || row.side === "ask"
    ? row.side
    : fail(`Fill ${id} side must be bid or ask.`);
  const orderSide = row.order_side === "bid" || row.order_side === "ask"
    ? row.order_side
    : fail(`Order side for fill ${id} must be bid or ask.`);
  if (market !== orderMarket) {
    throw new Error(`Fill ${id} market ${market} does not match order market ${orderMarket}.`);
  }
  if (side !== orderSide) {
    throw new Error(`Fill ${id} side ${side} does not match order side ${orderSide}.`);
  }
  const feeAmount = row.fee_amount === null
    ? null
    : parseNonNegativeNumericString(row.fee_amount, `Fill ${id} fee_amount`);
  const feeCurrency = row.fee_currency === null
    ? null
    : requireString(row.fee_currency, `Fill ${id} fee_currency`);

  return {
    id,
    market,
    side,
    priceKrw: parsePositiveNumericString(row.price, `Fill ${id} price`),
    volume: parsePositiveNumericString(row.volume, `Fill ${id} volume`),
    feeKrw: feeAmount === null || feeCurrency !== "KRW" ? null : feeAmount,
    filledAt,
  };
}

function readSnapshots(
  db: DatabaseSync,
  exchangeAccountId: string,
): NormalizedSnapshot[] {
  const rows = db.prepare(`
    SELECT id, captured_at, source, positions_json
    FROM position_snapshots
    WHERE exchange_account_id = ?
  `).all(exchangeAccountId) as unknown as SnapshotRow[];
  return rows
    .map((row) => {
      const id = requireString(row.id, "position_snapshot.id");
      return {
        id,
        capturedAt: normalizeExplicitIsoTimestamp(
          row.captured_at,
          `Position snapshot ${id} captured_at`,
        ),
        source: requireString(row.source, `Position snapshot ${id} source`),
        positionsJson: requireString(row.positions_json, `Position snapshot ${id} positions_json`),
      };
    })
    .sort(
      (left, right) =>
        Date.parse(left.capturedAt) - Date.parse(right.capturedAt) ||
        left.id.localeCompare(right.id),
    );
}

function selectSnapshot(
  snapshots: readonly NormalizedSnapshot[],
  comparator: "<" | "<=",
  boundary: string,
): NormalizedSnapshot | null {
  const boundaryEpoch = Date.parse(boundary);
  return snapshots.filter((snapshot) => {
    const capturedEpoch = Date.parse(snapshot.capturedAt);
    return comparator === "<" ? capturedEpoch < boundaryEpoch : capturedEpoch <= boundaryEpoch;
  }).at(-1) ?? null;
}

type NormalizedSnapshot = PerformanceSnapshotProvenance & { positionsJson: string };

function toSnapshotProvenance(
  snapshot: NormalizedSnapshot | null,
): PerformanceSnapshotProvenance | null {
  return snapshot === null
    ? null
    : { id: snapshot.id, capturedAt: snapshot.capturedAt, source: snapshot.source };
}

function parseOpeningPositions(
  positionsJson: string,
  snapshotId: string,
): PerformanceOpeningPosition[] {
  return parsePositionsJson(positionsJson, snapshotId)
    .map((position, index) => {
      const market = parseMarket(position.market, `Position ${index} market in ${snapshotId}`);
      const quantity = parseNonNegativeNumericString(
        position.quantity,
        `Position ${market} quantity in ${snapshotId}`,
      );
      if (quantity === 0) {
        return null;
      }
      return {
        market,
        quantity,
        averagePriceKrw: position.averageEntryPrice === null
          ? null
          : parsePositiveNumericString(
              position.averageEntryPrice,
              `Position ${market} averageEntryPrice in ${snapshotId}`,
            ),
      };
    })
    .filter((position): position is PerformanceOpeningPosition => position !== null);
}

function parseMarkPrices(positionsJson: string, snapshotId: string): PerformanceMarkPrice[] {
  return parsePositionsJson(positionsJson, snapshotId).map((position, index) => {
    const market = parseMarket(position.market, `Position ${index} market in ${snapshotId}`);
    return {
      market,
      priceKrw: position.markPrice === null
        ? null
        : parsePositiveNumericString(
            position.markPrice,
            `Position ${market} markPrice in ${snapshotId}`,
          ),
    };
  });
}

function parsePositionsJson(positionsJson: string, snapshotId: string): PersistedPosition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(positionsJson);
  } catch {
    throw new Error(`Position snapshot ${snapshotId} positions_json must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Position snapshot ${snapshotId} positions_json must be an array.`);
  }
  return parsed.map((position, index) => {
    if (typeof position !== "object" || position === null || Array.isArray(position)) {
      throw new Error(`Position ${index} in snapshot ${snapshotId} must be an object.`);
    }
    return position as PersistedPosition;
  });
}

function validateFilters(filters: PerformanceReadFilters): PerformanceReadFilters {
  if (filters.databasePath.trim() === "") throw new Error("databasePath must not be empty.");
  if (filters.exchangeAccountId.trim() === "") throw new Error("exchangeAccountId must not be empty.");
  if (filters.executionMode !== "LIVE" && filters.executionMode !== "DRY_RUN") {
    throw new Error("executionMode must be LIVE or DRY_RUN.");
  }
  if (!(["STRATEGY", "OPERATOR", "RECOVERY"] as const).includes(filters.origin)) {
    throw new Error("origin must be STRATEGY, OPERATOR, or RECOVERY.");
  }
  const from = filters.from === undefined
    ? undefined
    : normalizeExplicitIsoTimestamp(filters.from, "from");
  const to = filters.to === undefined
    ? undefined
    : normalizeExplicitIsoTimestamp(filters.to, "to");
  if (
    from !== undefined &&
    to !== undefined &&
    Date.parse(from) >= Date.parse(to)
  ) {
    throw new Error("from must be earlier than to.");
  }
  return {
    databasePath: filters.databasePath,
    exchangeAccountId: filters.exchangeAccountId,
    executionMode: filters.executionMode,
    origin: filters.origin,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function parseMarket(value: unknown, label: string): PerformanceMarket {
  if (value === "KRW-BTC" || value === "KRW-ETH") return value;
  throw new Error(`${label} must be KRW-BTC or KRW-ETH.`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function normalizeExplicitIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp,
  );
  if (match === null || !hasValidIsoComponents(match) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  return new Date(timestamp).toISOString();
}

function hasValidIsoComponents(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timezone = match[7];
  if (
    !Number.isInteger(year) || month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 ||
    minute > 59 || second > 59 || timezone === undefined
  ) {
    return false;
  }
  if (timezone === "Z") return true;
  const offsetHour = Number(timezone.slice(1, 3));
  const offsetMinute = Number(timezone.slice(4, 6));
  return offsetHour <= 23 && offsetMinute <= 59;
}

function parsePositiveNumericString(value: unknown, label: string): number {
  const parsed = parseNumericString(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function parseNonNegativeNumericString(value: unknown, label: string): number {
  const parsed = parseNumericString(value, label);
  if (parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function parseNumericString(value: unknown, label: string): number {
  const text = requireString(value, label);
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite numeric string.`);
  return parsed;
}

function fail(message: string): never {
  throw new Error(message);
}
