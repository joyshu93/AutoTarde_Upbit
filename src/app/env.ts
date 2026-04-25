import type {
  ExecutionMode,
  ExecutionRiskLimits,
  LiveExecutionGate,
  SupportedAsset,
} from "../domain/types.js";

export interface AppConfig {
  serviceName: string;
  executionMode: ExecutionMode;
  liveExecutionGate: LiveExecutionGate;
  globalKillSwitch: boolean;
  upbitBaseUrl: string;
  databasePath: string;
  telegramDeliveryEnabled: boolean;
  telegramBotToken: string | null;
  telegramOperatorChatId: string | null;
  telegramDeliveryMaxAttempts: number;
  telegramDeliveryBaseBackoffMs: number;
  telegramDeliveryMaxBackoffMs: number;
  telegramDeliveryLeaseMs: number;
  reconciliationMaxOrderLookupsPerRun: number;
  reconciliationHistoryMaxPagesPerMarket: number;
  reconciliationClosedOrderLookbackDays: number;
  stalePriceThresholdMs: number;
  minimumOrderValueKrw: number;
  maxAllocationByAsset: Record<SupportedAsset, number>;
  totalExposureCap: number;
}

const DEFAULT_SERVICE_NAME = "AutoTrade_Upbit";
const DEFAULT_UPBIT_BASE_URL = "https://api.upbit.com";
const DEFAULT_DATABASE_PATH = "./var/autotrade-upbit.sqlite";
const DEFAULT_TELEGRAM_DELIVERY_MAX_ATTEMPTS = 5;
const DEFAULT_TELEGRAM_DELIVERY_BASE_BACKOFF_MS = 15_000;
const DEFAULT_TELEGRAM_DELIVERY_MAX_BACKOFF_MS = 300_000;
const DEFAULT_TELEGRAM_DELIVERY_LEASE_MS = 30_000;
const DEFAULT_RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN = 10;
const DEFAULT_RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET = 3;
const DEFAULT_RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS = 7;
const DEFAULT_STALE_PRICE_THRESHOLD_MS = 30_000;
const DEFAULT_MINIMUM_ORDER_VALUE_KRW = 5_000;
const DEFAULT_TOTAL_EXPOSURE_CAP = 0.75;
const DEFAULT_MAX_ALLOCATION: Record<SupportedAsset, number> = {
  BTC: 0.6,
  ETH: 0.6,
};

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const executionMode = normalizeExecutionMode(env.APP_EXECUTION_MODE);
  const liveExecutionGate = parseBoolean(env.ENABLE_LIVE_ORDERS) ? "ENABLED" : "DISABLED";

  return {
    serviceName: env.APP_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
    executionMode,
    liveExecutionGate,
    globalKillSwitch: parseBoolean(env.GLOBAL_KILL_SWITCH),
    upbitBaseUrl: env.UPBIT_BASE_URL?.trim() || DEFAULT_UPBIT_BASE_URL,
    databasePath: env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH,
    telegramDeliveryEnabled: parseBoolean(env.ENABLE_TELEGRAM_DELIVERY),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramOperatorChatId: env.TELEGRAM_OPERATOR_CHAT_ID?.trim() || null,
    telegramDeliveryMaxAttempts: parseNumber(
      env.TELEGRAM_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_TELEGRAM_DELIVERY_MAX_ATTEMPTS,
    ),
    telegramDeliveryBaseBackoffMs: parseNumber(
      env.TELEGRAM_DELIVERY_BASE_BACKOFF_MS,
      DEFAULT_TELEGRAM_DELIVERY_BASE_BACKOFF_MS,
    ),
    telegramDeliveryMaxBackoffMs: parseNumber(
      env.TELEGRAM_DELIVERY_MAX_BACKOFF_MS,
      DEFAULT_TELEGRAM_DELIVERY_MAX_BACKOFF_MS,
    ),
    telegramDeliveryLeaseMs: parseNumber(
      env.TELEGRAM_DELIVERY_LEASE_MS,
      DEFAULT_TELEGRAM_DELIVERY_LEASE_MS,
    ),
    reconciliationMaxOrderLookupsPerRun: parseNumber(
      env.RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN,
      DEFAULT_RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN,
    ),
    reconciliationHistoryMaxPagesPerMarket: parseNumber(
      env.RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET,
      DEFAULT_RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET,
    ),
    reconciliationClosedOrderLookbackDays: parseNumber(
      env.RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS,
      DEFAULT_RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS,
    ),
    stalePriceThresholdMs: parseNumber(env.STALE_PRICE_THRESHOLD_MS, DEFAULT_STALE_PRICE_THRESHOLD_MS),
    minimumOrderValueKrw: parseNumber(env.MINIMUM_ORDER_VALUE_KRW, DEFAULT_MINIMUM_ORDER_VALUE_KRW),
    totalExposureCap: parseNumber(env.TOTAL_EXPOSURE_CAP, DEFAULT_TOTAL_EXPOSURE_CAP),
    maxAllocationByAsset: {
      BTC: parseNumber(env.MAX_ALLOCATION_BTC, DEFAULT_MAX_ALLOCATION.BTC),
      ETH: parseNumber(env.MAX_ALLOCATION_ETH, DEFAULT_MAX_ALLOCATION.ETH),
    },
  };
}

export function buildExecutionRiskLimits(config: AppConfig): ExecutionRiskLimits {
  return {
    maxAllocationByAsset: config.maxAllocationByAsset,
    totalExposureCap: config.totalExposureCap,
    stalePriceThresholdMs: config.stalePriceThresholdMs,
    minimumOrderValueKrw: config.minimumOrderValueKrw,
  };
}

function normalizeExecutionMode(input: string | undefined): ExecutionMode {
  return input?.trim().toUpperCase() === "LIVE" ? "LIVE" : "DRY_RUN";
}

function parseBoolean(input: string | undefined): boolean {
  if (!input) {
    return false;
  }

  return input.trim().toLowerCase() === "true" || input.trim() === "1";
}

function parseNumber(input: string | undefined, fallback: number): number {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}
