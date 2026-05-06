import { getAssetForMarket, type ExchangeBalance, type OrderRecord, type PortfolioExposureSnapshot, type PositionSnapshot, type PositionSnapshotRecord, type StrategyDecisionRecord, type SupportedMarket } from "../../domain/types.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import type {
  PositionGuardStrategyContext,
  PositionGuardStrategySettings,
  PositionGuardStructureAnalysis,
  PreviousPositionGuardDecision,
  RecentExitContext,
  StrategyEntryPath,
  StrategyExecutionDisposition,
  StrategySignalQualityBucket,
} from "./position-guard-core.js";
import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  POSITION_GUARD_STRATEGY_KEY,
} from "./position-guard-core.js";

export interface LoadPositionGuardStrategyContextInput {
  exchangeAccountId: string;
  market: SupportedMarket;
  generatedAt: string;
  analysis: PositionGuardStructureAnalysis;
  settings?: PositionGuardStrategySettings;
}

export interface BuildPositionGuardStrategyContextInput extends LoadPositionGuardStrategyContextInput {
  balanceSnapshotJson: string | null;
  positionSnapshotJson: string | null;
  portfolio: PortfolioExposureSnapshot;
  latestDecisionRecord: StrategyDecisionRecord | null;
  orders: readonly OrderRecord[];
}

export async function loadPositionGuardStrategyContext(
  repositories: ExecutionRepository,
  input: LoadPositionGuardStrategyContextInput,
): Promise<PositionGuardStrategyContext> {
  const [
    balanceSnapshot,
    positionSnapshot,
    portfolio,
    latestDecisionRecord,
    orders,
  ] = await Promise.all([
    repositories.getLatestBalanceSnapshot(input.exchangeAccountId),
    repositories.getLatestPositionSnapshot(input.exchangeAccountId),
    repositories.getPortfolioExposure(input.exchangeAccountId),
    repositories.getLatestStrategyDecision(input.exchangeAccountId, input.market, POSITION_GUARD_STRATEGY_KEY),
    repositories.listOrders(input.exchangeAccountId),
  ]);

  return buildPositionGuardStrategyContext({
    ...input,
    balanceSnapshotJson: balanceSnapshot?.balancesJson ?? null,
    positionSnapshotJson: positionSnapshot?.positionsJson ?? null,
    portfolio,
    latestDecisionRecord,
    orders,
  });
}

export function buildPositionGuardStrategyContext(
  input: BuildPositionGuardStrategyContextInput,
): PositionGuardStrategyContext {
  const asset = getAssetForMarket(input.market);
  const balances = parseJsonArray<ExchangeBalance>(input.balanceSnapshotJson);
  const positions = parseJsonArray<PositionSnapshot>(input.positionSnapshotJson);
  const position = positions.find((candidate) => candidate.asset === asset && candidate.market === input.market) ?? null;
  const availableKrw = getAvailableKrw(balances);
  const positionQuantity = parseFiniteNumber(position?.quantity, 0);
  const averageEntryPrice = parseFiniteNumber(position?.averageEntryPrice, input.analysis.averageEntryPrice);
  const assetMarketValueKrw = parseFiniteNumber(
    position?.marketValue,
    positionQuantity * input.analysis.currentPrice,
  );

  return {
    asset,
    market: input.market,
    generatedAt: input.generatedAt,
    availableKrw,
    positionQuantity,
    averageEntryPrice,
    portfolio: {
      totalEquityKrw: input.portfolio.totalEquityKrw,
      assetMarketValueKrw,
      totalExposureKrw: input.portfolio.totalExposureKrw,
    },
    latestDecision: toPreviousPositionGuardDecision(input.latestDecisionRecord),
    recentExit: deriveRecentExitContext(input.orders, input.market, input.generatedAt),
    settings: input.settings ?? DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
    analysis: {
      ...input.analysis,
      averageEntryPrice,
      pnlPct: averageEntryPrice > 0 ? (input.analysis.currentPrice - averageEntryPrice) / averageEntryPrice : 0,
    },
  };
}

export function toPreviousPositionGuardDecision(
  record: StrategyDecisionRecord | null,
): PreviousPositionGuardDecision | null {
  if (!record) {
    return null;
  }

  const basis = parseJsonObject(record.decisionBasisJson);
  const metadata = readObject(basis.metadata);
  const diagnostics = parseMaybeJsonObject(metadata.diagnosticsJson) ?? readObject(basis.diagnostics);
  const signalQuality = readObject(basis.signalQuality);
  const executionDisposition = asExecutionDisposition(
    metadata.executionDisposition ?? basis.executionDisposition,
  );
  const entryPath = asEntryPath(
    diagnostics.entryPath ?? metadata.entryPath ?? basis.entryPath,
  );
  const qualityBucket = asQualityBucket(
    metadata.signalQualityBucket ?? signalQuality.bucket ?? basis.qualityBucket,
  );

  if (executionDisposition === null || entryPath === null || qualityBucket === null) {
    return null;
  }

  return {
    action: record.action,
    executionDisposition,
    entryPath,
    qualityBucket,
    createdAt: record.createdAt,
  };
}

export function deriveRecentExitContext(
  orders: readonly OrderRecord[],
  market: SupportedMarket,
  generatedAt: string,
): RecentExitContext {
  const generatedAtMs = Date.parse(generatedAt);
  const latestExit = [...orders]
    .filter((order) => order.market === market && order.side === "ask" && order.status === "FILLED")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;

  if (!latestExit) {
    return {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    };
  }

  const exitAtMs = Date.parse(latestExit.updatedAt);
  return {
    createdAt: latestExit.updatedAt,
    hoursSinceExit: Number.isNaN(generatedAtMs) || Number.isNaN(exitAtMs)
      ? null
      : Math.max(0, (generatedAtMs - exitAtMs) / (60 * 60 * 1000)),
    realizedPnl: null,
  };
}

function getAvailableKrw(balances: readonly ExchangeBalance[]): number {
  const krw = balances.find((candidate) => candidate.currency === "KRW");
  return parseFiniteNumber(krw?.balance, 0);
}

function parseJsonArray<TValue>(value: string | null): TValue[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as TValue[] : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    return readObject(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return readObject(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseFiniteNumber(value: string | number | null | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asExecutionDisposition(value: unknown): StrategyExecutionDisposition | null {
  return value === "IMMEDIATE" ||
    value === "DEFERRED_CONFIRMATION" ||
    value === "EXECUTED_AFTER_CONFIRMATION" ||
    value === "SKIPPED"
    ? value
    : null;
}

function asEntryPath(value: unknown): StrategyEntryPath | null {
  return value === "PULLBACK" || value === "RECLAIM" || value === "BREAKOUT_HOLD" || value === "NONE"
    ? value
    : null;
}

function asQualityBucket(value: unknown): StrategySignalQualityBucket | null {
  return value === "HIGH" || value === "MEDIUM" || value === "BORDERLINE" || value === "LOW"
    ? value
    : null;
}
