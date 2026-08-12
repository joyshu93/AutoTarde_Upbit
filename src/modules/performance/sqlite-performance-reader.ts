import { DatabaseSync } from "node:sqlite";

import type { ExecutionMode, OrderOrigin } from "../../domain/types.js";
import type {
  PerformanceCalculationInput,
  PerformanceMarkPrice,
  PerformanceMarket,
  PerformanceOpeningPosition,
} from "./performance-calculator.js";
import type { PerformanceMarkObservation } from "./performance-diagnostics.js";
import type {
  PerformanceDecisionAction,
  PerformanceTradeFill,
} from "./performance-trade-matcher.js";
import {
  compareEpochNanoseconds,
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

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
  attributionOpeningSnapshot: PerformanceSnapshotProvenance | null;
  markSnapshot: PerformanceSnapshotProvenance | null;
  markObservationCount: number;
  firstMarkObservationAt: string | null;
  lastMarkObservationAt: string | null;
  markObservationSnapshots: readonly PerformanceSnapshotProvenance[];
  feeEvidence: PerformanceFeeEvidenceProvenance;
  dataQualityWarnings: readonly PerformanceDataQualityWarning[];
};

export type PerformanceFeeEvidenceProvenance = {
  persistedFillFeeCount: number;
  recoveredOrderPaidFeeCount: number;
  unknownFeeCount: number;
};

export type PerformanceDataQualityWarning = {
  code:
    | "AMBIGUOUS_ORDER_FEE_EVIDENCE"
    | "MALFORMED_ORDER_FEE_EVIDENCE"
    | "MISMATCHED_ORDER_FEE_EVIDENCE"
    | "MISSING_ORDER_FEE_EVIDENCE";
  fillId: string;
  orderId: string;
  message: string;
};

export type PerformanceReadResult = {
  input: PerformanceCalculationInput;
  attributionInput: PerformanceCalculationInput;
  tradeFills: readonly PerformanceTradeFill[];
  markObservations: readonly PerformanceMarkObservation[];
  provenance: PerformanceReadProvenance;
};

type FillRow = {
  id: unknown;
  order_id: unknown;
  order_strategy_decision_id: unknown;
  order_exchange_account_id: unknown;
  order_exchange_response_json: unknown;
  exchange_fill_id: unknown;
  market: unknown;
  side: unknown;
  order_market: unknown;
  order_side: unknown;
  decision_id: unknown;
  decision_exchange_account_id: unknown;
  decision_market: unknown;
  decision_action: unknown;
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
  filledEpochNanoseconds: bigint;
};

type PerformanceFillReadResult = {
  fills: PerformanceTradeFill[];
  feeEvidence: PerformanceFeeEvidenceProvenance;
  dataQualityWarnings: PerformanceDataQualityWarning[];
};

type ResolvedFee = {
  feeKrw: number | null;
  source: "PERSISTED_FILL" | "ORDER_PAID_FEE" | "UNKNOWN";
  warning: PerformanceDataQualityWarning | null;
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
    const fillRead = readFills(db, normalizedFilters);
    const fills = fillRead.fills;
    const firstFillAt = fills[0]?.filledAt ?? null;
    const lastFillAt = fills.at(-1)?.filledAt ?? null;
    const snapshots = readSnapshots(db, normalizedFilters.exchangeAccountId);
    const openingSnapshotCandidate = normalizedFilters.from === undefined
      ? firstFillAt === null
        ? null
        : selectSnapshot(snapshots, "<", firstFillAt)
      : selectSnapshot(snapshots, "<=", normalizedFilters.from);
    const attributionOpeningSnapshotCandidate = firstFillAt === null
      ? null
      : selectSnapshot(snapshots, "<", firstFillAt);
    const markSnapshotCandidate = normalizedFilters.to === undefined
      ? snapshots.at(-1) ?? null
      : selectSnapshot(snapshots, "<", normalizedFilters.to);
    const markObservationCandidates = selectMarkObservationSnapshots(snapshots, normalizedFilters);
    const openingSnapshot = openingSnapshotCandidate === null
      ? null
      : normalizeSnapshot(openingSnapshotCandidate);
    const attributionOpeningSnapshot = attributionOpeningSnapshotCandidate === null
      ? null
      : normalizeSnapshot(attributionOpeningSnapshotCandidate);
    const markSnapshot = markSnapshotCandidate === null
      ? null
      : normalizeSnapshot(markSnapshotCandidate);
    const markObservationSnapshots = markObservationCandidates.map(normalizeSnapshot);
    const markObservations = markObservationSnapshots.map(toMarkObservation);
    const openingPositions = openingSnapshot === null
      ? []
      : parseOpeningPositions(openingSnapshot.positionsJson, openingSnapshot.id);
    const attributionOpeningPositions = attributionOpeningSnapshot === null
      ? []
      : parseOpeningPositions(
          attributionOpeningSnapshot.positionsJson,
          attributionOpeningSnapshot.id,
        );
    const markPrices = markSnapshot === null
      ? []
      : parseMarkPrices(markSnapshot.positionsJson, markSnapshot.id);

    return {
      input: {
        fills,
        openingPositions,
        markPrices,
      },
      attributionInput: {
        fills,
        openingPositions: attributionOpeningPositions,
        markPrices,
      },
      tradeFills: fills,
      markObservations,
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
        attributionOpeningSnapshot: toSnapshotProvenance(attributionOpeningSnapshot),
        markSnapshot: toSnapshotProvenance(markSnapshot),
        markObservationCount: markObservations.length,
        firstMarkObservationAt: markObservations[0]?.capturedAt ?? null,
        lastMarkObservationAt: markObservations.at(-1)?.capturedAt ?? null,
        markObservationSnapshots: markObservationSnapshots.map((snapshot) =>
          toSnapshotProvenance(snapshot) as PerformanceSnapshotProvenance
        ),
        feeEvidence: fillRead.feeEvidence,
        dataQualityWarnings: fillRead.dataQualityWarnings,
      },
    };
  } finally {
    db.close();
  }
}

function readFills(db: DatabaseSync, filters: PerformanceReadFilters): PerformanceFillReadResult {
  const orderExchangeResponseSelect = tableHasColumn(db, "orders", "exchange_response_json")
    ? "o.exchange_response_json AS order_exchange_response_json"
    : "NULL AS order_exchange_response_json";
  const exchangeFillIdSelect = tableHasColumn(db, "fills", "exchange_fill_id")
    ? "f.exchange_fill_id AS exchange_fill_id"
    : "NULL AS exchange_fill_id";
  const rows = db.prepare(`
    SELECT
      f.id,
      o.id AS order_id,
      o.strategy_decision_id AS order_strategy_decision_id,
      o.exchange_account_id AS order_exchange_account_id,
      ${orderExchangeResponseSelect},
      ${exchangeFillIdSelect},
      f.market,
      f.side,
      o.market AS order_market,
      o.side AS order_side,
      d.id AS decision_id,
      d.exchange_account_id AS decision_exchange_account_id,
      d.market AS decision_market,
      d.action AS decision_action,
      f.price,
      f.volume,
      f.fee_currency,
      f.fee_amount,
      f.filled_at
    FROM fills f
    INNER JOIN orders o ON o.id = f.order_id
    LEFT JOIN strategy_decisions d ON d.id = o.strategy_decision_id
    WHERE o.exchange_account_id = ?
      AND o.execution_mode = ?
      AND o.origin = ?
  `).all(
    filters.exchangeAccountId,
    filters.executionMode,
    filters.origin,
  ) as unknown as FillRow[];

  const fromEpoch = filters.from === undefined
    ? null
    : performanceTimestampEpochNanoseconds(filters.from);
  const toEpoch = filters.to === undefined
    ? null
    : performanceTimestampEpochNanoseconds(filters.to);
  const rowsByOrderId = groupRowsByOrderId(rows);
  const selectedRows = rows
    .map((row) => validateFillTimestamp(row))
    .filter(({ filledEpochNanoseconds }) => {
      return (fromEpoch === null || filledEpochNanoseconds >= fromEpoch) &&
        (toEpoch === null || filledEpochNanoseconds < toEpoch);
    })
    .sort(
      (left, right) =>
        compareEpochNanoseconds(left.filledEpochNanoseconds, right.filledEpochNanoseconds) ||
        left.id.localeCompare(right.id),
    );
  const dataQualityWarnings: PerformanceDataQualityWarning[] = [];
  let persistedFillFeeCount = 0;
  let recoveredOrderPaidFeeCount = 0;
  let unknownFeeCount = 0;
  const fills = selectedRows.map(({ row, id, filledAt }) => {
    const orderId = requireString(row.order_id, `Order id for fill ${id}`);
    const resolvedFee = resolveFeeEvidence(row, id, orderId, rowsByOrderId.get(orderId) ?? []);
    if (resolvedFee.source === "PERSISTED_FILL") persistedFillFeeCount += 1;
    else if (resolvedFee.source === "ORDER_PAID_FEE") recoveredOrderPaidFeeCount += 1;
    else unknownFeeCount += 1;
    if (resolvedFee.warning !== null) dataQualityWarnings.push(resolvedFee.warning);
    return normalizeFill(row, id, filledAt, resolvedFee.feeKrw);
  });
  return {
    fills,
    feeEvidence: { persistedFillFeeCount, recoveredOrderPaidFeeCount, unknownFeeCount },
    dataQualityWarnings,
  };
}

function tableHasColumn(
  db: DatabaseSync,
  table: "fills" | "orders",
  column: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name?: unknown;
  }>;
  return rows.some((row) => row.name === column);
}

function validateFillTimestamp(row: FillRow): TimestampValidatedFillRow {
  const id = requireString(row.id, "fill.id");
  const filledAt = normalizeExplicitIsoTimestamp(row.filled_at, `Fill ${id} filled_at`);
  const filledEpochNanoseconds = performanceTimestampEpochNanoseconds(filledAt);
  return { row, id, filledAt, filledEpochNanoseconds };
}

function normalizeFill(
  row: FillRow,
  id: string,
  filledAt: string,
  feeKrw: number | null,
): PerformanceTradeFill {
  const orderId = requireString(row.order_id, `Order id for fill ${id}`);
  const orderAccountId = requireString(
    row.order_exchange_account_id,
    `Order account for fill ${id}`,
  );
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
  const strategyDecisionId = row.order_strategy_decision_id === null
    ? null
    : requireString(row.order_strategy_decision_id, `Order ${orderId} strategy_decision_id`);
  const decisionAction = validateDecisionLink({
    row,
    orderId,
    orderAccountId,
    orderMarket,
    orderSide,
    strategyDecisionId,
  });
  return {
    id,
    orderId,
    strategyDecisionId,
    decisionAction,
    market,
    side,
    priceKrw: parsePositiveNumericString(row.price, `Fill ${id} price`),
    volume: parsePositiveNumericString(row.volume, `Fill ${id} volume`),
    feeKrw,
    filledAt,
  };
}

function groupRowsByOrderId(rows: readonly FillRow[]): Map<string, FillRow[]> {
  const grouped = new Map<string, FillRow[]>();
  for (const row of rows) {
    const orderId = typeof row.order_id === "string" ? row.order_id : "";
    if (orderId === "") continue;
    const orderRows = grouped.get(orderId) ?? [];
    orderRows.push(row);
    grouped.set(orderId, orderRows);
  }
  return grouped;
}

function resolveFeeEvidence(
  row: FillRow,
  fillId: string,
  orderId: string,
  orderRows: readonly FillRow[],
): ResolvedFee {
  if (row.fee_amount !== null) {
    const feeAmount = parseNonNegativeNumericString(row.fee_amount, `Fill ${fillId} fee_amount`);
    const feeCurrency = row.fee_currency === null
      ? null
      : requireString(row.fee_currency, `Fill ${fillId} fee_currency`);
    return {
      feeKrw: feeCurrency === "KRW" ? feeAmount : null,
      source: feeCurrency === "KRW" ? "PERSISTED_FILL" : "UNKNOWN",
      warning: feeCurrency === "KRW"
        ? null
        : feeWarning(
            "MISMATCHED_ORDER_FEE_EVIDENCE",
            fillId,
            orderId,
            `Fill ${fillId} persisted fee currency is not KRW.`,
          ),
    };
  }
  if (orderRows.length !== 1) {
    return unknownFee(
      "AMBIGUOUS_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} has ${orderRows.length} local fills; order-level paid_fee is not assigned.`,
    );
  }
  if (typeof row.order_exchange_response_json !== "string" || row.order_exchange_response_json === "") {
    return unknownFee(
      "MISSING_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} has no persisted exchange response for fee recovery.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.order_exchange_response_json);
  } catch {
    return unknownFee(
      "MALFORMED_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} exchange response is not valid JSON.`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.trades)) {
    return unknownFee(
      "MALFORMED_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} exchange response must contain a trades array.`,
    );
  }
  if (parsed.trades.length !== 1) {
    return unknownFee(
      "AMBIGUOUS_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} has ${parsed.trades.length} persisted trades; exact single-fill fee recovery is unavailable.`,
    );
  }
  if (
    Object.hasOwn(parsed, "trades_count")
    && parsed.trades_count !== 1
  ) {
    return unknownFee(
      "AMBIGUOUS_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} trades_count does not prove one complete persisted trade.`,
    );
  }
  const trade = parsed.trades[0];
  const exchangeFillId = row.exchange_fill_id;
  if (
    !isRecord(trade) ||
    typeof exchangeFillId !== "string" || exchangeFillId === "" ||
    trade.uuid !== exchangeFillId ||
    trade.market !== row.market || parsed.market !== row.market ||
    trade.side !== row.side || parsed.side !== row.side ||
    !decimalStringsEqual(trade.price, row.price) ||
    !decimalStringsEqual(trade.volume, row.volume)
  ) {
    return unknownFee(
      "MISMATCHED_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} trade evidence does not exactly match fill ${fillId}.`,
    );
  }
  const paidFee = parseOptionalNonNegativeNumericString(parsed.paid_fee);
  if (paidFee === null) {
    return unknownFee(
      "MALFORMED_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} paid_fee must be a finite non-negative numeric string.`,
    );
  }
  if (isRecord(trade) && Object.hasOwn(trade, "fee") && !decimalStringsEqual(trade.fee, parsed.paid_fee)) {
    return unknownFee(
      "MISMATCHED_ORDER_FEE_EVIDENCE",
      fillId,
      orderId,
      `Order ${orderId} per-trade fee contradicts paid_fee.`,
    );
  }
  return { feeKrw: paidFee, source: "ORDER_PAID_FEE", warning: null };
}

function unknownFee(
  code: PerformanceDataQualityWarning["code"],
  fillId: string,
  orderId: string,
  message: string,
): ResolvedFee {
  return { feeKrw: null, source: "UNKNOWN", warning: feeWarning(code, fillId, orderId, message) };
}

function feeWarning(
  code: PerformanceDataQualityWarning["code"],
  fillId: string,
  orderId: string,
  message: string,
): PerformanceDataQualityWarning {
  return { code, fillId, orderId, message };
}

function parseOptionalNonNegativeNumericString(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function decimalStringsEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftCanonical = canonicalDecimalString(left);
  const rightCanonical = canonicalDecimalString(right);
  return leftCanonical !== null && leftCanonical === rightCanonical;
}

function canonicalDecimalString(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/u.exec(value.trim());
  if (!match) return null;
  const sign = match[1] === "-" ? "-" : "";
  const integer = (match[2] ?? "").replace(/^0+(?=\d)/u, "") || "0";
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  const magnitude = fraction === "" ? integer : `${integer}.${fraction}`;
  return magnitude === "0" ? "0" : `${sign}${magnitude}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDecisionLink(input: {
  row: FillRow;
  orderId: string;
  orderAccountId: string;
  orderMarket: PerformanceMarket;
  orderSide: "bid" | "ask";
  strategyDecisionId: string | null;
}): PerformanceDecisionAction | null {
  if (input.strategyDecisionId === null) return null;
  if (input.row.decision_id === null) {
    throw new Error(
      `Order ${input.orderId} references missing strategy decision ${input.strategyDecisionId}.`,
    );
  }
  const decisionId = requireString(input.row.decision_id, `Decision id for order ${input.orderId}`);
  if (decisionId !== input.strategyDecisionId) {
    throw new Error(`Decision ${decisionId} does not match order ${input.orderId} link.`);
  }
  const decisionAccountId = requireString(
    input.row.decision_exchange_account_id,
    `Decision account for order ${input.orderId}`,
  );
  if (decisionAccountId !== input.orderAccountId) {
    throw new Error(
      `Order ${input.orderId} decision account ${decisionAccountId} does not match order account ${input.orderAccountId}.`,
    );
  }
  const decisionMarket = parseMarket(
    input.row.decision_market,
    `Decision market for order ${input.orderId}`,
  );
  if (decisionMarket !== input.orderMarket) {
    throw new Error(
      `Order ${input.orderId} decision market ${decisionMarket} does not match order market ${input.orderMarket}.`,
    );
  }
  const action = input.row.decision_action;
  if (action === "HOLD") {
    throw new Error(`Order ${input.orderId} decision action HOLD cannot be linked to a fill.`);
  }
  if (action !== "ENTER" && action !== "ADD" && action !== "REDUCE" && action !== "EXIT") {
    throw new Error(`Order ${input.orderId} decision action must be ENTER, ADD, REDUCE, or EXIT.`);
  }
  const expectedSide = action === "ENTER" || action === "ADD" ? "bid" : "ask";
  if (expectedSide !== input.orderSide) {
    throw new Error(
      `Order ${input.orderId} decision action ${action} contradicts ${input.orderSide} order side.`,
    );
  }
  return action;
}

function readSnapshots(
  db: DatabaseSync,
  exchangeAccountId: string,
): TimestampValidatedSnapshot[] {
  const rows = db.prepare(`
    SELECT id, captured_at, source, positions_json
    FROM position_snapshots
    WHERE exchange_account_id = ?
  `).all(exchangeAccountId) as unknown as SnapshotRow[];
  return rows
    .map((row) => {
      const id = requireString(row.id, "position_snapshot.id");
      return {
        row,
        id,
        capturedAt: normalizeExplicitIsoTimestamp(
          row.captured_at,
          `Position snapshot ${id} captured_at`,
        ),
      };
    })
    .sort(
      (left, right) =>
        comparePerformanceTimestamps(left.capturedAt, right.capturedAt) ||
        left.id.localeCompare(right.id),
    );
}

function selectSnapshot(
  snapshots: readonly TimestampValidatedSnapshot[],
  comparator: "<" | "<=",
  boundary: string,
): TimestampValidatedSnapshot | null {
  return snapshots.filter((snapshot) => {
    const comparison = comparePerformanceTimestamps(snapshot.capturedAt, boundary);
    return comparator === "<" ? comparison < 0 : comparison <= 0;
  }).at(-1) ?? null;
}

function selectMarkObservationSnapshots(
  snapshots: readonly TimestampValidatedSnapshot[],
  filters: PerformanceReadFilters,
): TimestampValidatedSnapshot[] {
  return snapshots.filter((snapshot) => {
    return (filters.from === undefined ||
      comparePerformanceTimestamps(snapshot.capturedAt, filters.from) >= 0) &&
      (filters.to === undefined ||
        comparePerformanceTimestamps(snapshot.capturedAt, filters.to) < 0);
  });
}

function normalizeSnapshot(snapshot: TimestampValidatedSnapshot): NormalizedSnapshot {
  return {
    id: snapshot.id,
    capturedAt: snapshot.capturedAt,
    source: requireString(snapshot.row.source, `Position snapshot ${snapshot.id} source`),
    positionsJson: requireString(
      snapshot.row.positions_json,
      `Position snapshot ${snapshot.id} positions_json`,
    ),
  };
}

function toMarkObservation(snapshot: NormalizedSnapshot): PerformanceMarkObservation {
  const prices: Partial<Record<PerformanceMarket, number>> = {};
  for (const mark of parseMarkPrices(snapshot.positionsJson, snapshot.id)) {
    if (mark.priceKrw !== null) prices[mark.market] = mark.priceKrw;
  }
  return {
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    prices,
  };
}

type NormalizedSnapshot = PerformanceSnapshotProvenance & { positionsJson: string };
type TimestampValidatedSnapshot = {
  row: SnapshotRow;
  id: string;
  capturedAt: string;
};

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
    comparePerformanceTimestamps(from, to) >= 0
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
  const parsed = parsePerformanceTimestamp(timestamp);
  if (parsed === null) {
    throw new Error(`${label} must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  return parsed.normalized;
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
