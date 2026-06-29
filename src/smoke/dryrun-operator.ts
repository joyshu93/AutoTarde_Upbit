import { pathToFileURL } from "node:url";

import { createApp, type AppServices } from "../app/create-app.js";
import type { AppConfig } from "../app/env.js";
import type {
  UpbitCandleSnapshot,
  UpbitGetDayCandlesRequest,
  UpbitGetMinuteCandlesRequest,
  UpbitSpotMarket,
  UpbitTickerSnapshot,
} from "../modules/exchange/upbit/contracts.js";
import type { PositionGuardPublicMarketDataReader } from "../modules/strategy/position-guard-snapshot.js";

type DryRunOperatorSmokeStatus = "PASS" | "WARN" | "BLOCK";
type DryRunOperatorSmokeEnvKey = keyof typeof FORCED_DRY_RUN_OPERATOR_SMOKE_ENV;
type ClearedSecretEnvKey = (typeof CLEARED_SECRET_ENV_KEYS)[number];

const FORCED_DRY_RUN_OPERATOR_SMOKE_ENV = {
  APP_EXECUTION_MODE: "DRY_RUN",
  ENABLE_LIVE_ORDERS: "false",
  ENABLE_TELEGRAM_DELIVERY: "false",
  ENABLE_TELEGRAM_INBOUND_POLLING: "false",
  STRATEGY_SCHEDULER_ENABLED: "false",
  STRATEGY_SCHEDULER_RUN_ON_START: "false",
} as const;

const CLEARED_SECRET_ENV_KEYS = ["UPBIT_ACCESS_KEY", "UPBIT_SECRET_KEY"] as const;
const DEFAULT_DRY_RUN_OPERATOR_SMOKE_DATABASE_PATH = "./var/dryrun-operator-smoke.sqlite";

const COMMAND_EXPECTATIONS = [
  {
    command: "/config",
    requiredPatterns: [/Runtime Config/u, /execution_mode: DRY_RUN/u, /live_send_path: DRY_RUN_ADAPTER/u],
  },
  {
    command: "/status",
    requiredPatterns: [/Execution Status/u, /mode: DRY_RUN/u, /live_send_path: DRY_RUN_ADAPTER/u],
  },
  {
    command: "/readiness",
    requiredPatterns: [/Operator Readiness/u, /execution_mode: DRY_RUN/u],
  },
  {
    command: "/sync",
    requiredPatterns: [/Reconciliation Sync/u, /status: COMPLETED/u, /reconciliation_source=OPERATOR_SYNC/u],
  },
  {
    command: "/balances",
    requiredPatterns: [/Balances Snapshot/u, /source: RECONCILIATION/u],
  },
  {
    command: "/positions",
    requiredPatterns: [/Positions Snapshot/u, /source: RECONCILIATION/u],
  },
  {
    command: "/run BTC",
    requiredPatterns: [/Strategy Run/u, /status: COMPLETED/u, /market: KRW-BTC/u, /action: HOLD/u],
  },
  {
    command: "/run ETH",
    requiredPatterns: [/Strategy Run/u, /status: COMPLETED/u, /market: KRW-ETH/u, /action: HOLD/u],
  },
  {
    command: "/orders",
    requiredPatterns: [/Orders/u],
  },
  {
    command: "/scheduler",
    requiredPatterns: [/Strategy Scheduler History/u],
  },
  {
    command: "/alerts",
    requiredPatterns: [/Operator Alerts/u],
  },
] as const;

export interface DryRunOperatorSmokeEnvReport {
  readonly forced: Record<DryRunOperatorSmokeEnvKey, string>;
  readonly previous: Record<DryRunOperatorSmokeEnvKey, string | undefined>;
  readonly clearedSecrets: Record<ClearedSecretEnvKey, { readonly wasConfigured: boolean }>;
  readonly databasePathDefaulted: boolean;
  readonly databasePath: string;
}

export interface DryRunOperatorSmokeCommandResult {
  readonly command: string;
  readonly status: DryRunOperatorSmokeStatus;
  readonly firstLine: string;
  readonly missingPatterns: string[];
  readonly error: string | null;
}

export interface DryRunOperatorSmokeResult {
  readonly service: string;
  readonly status: DryRunOperatorSmokeStatus;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly schedulerEnabled: boolean;
  readonly schedulerRunOnStart: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly safetyEnv: DryRunOperatorSmokeEnvReport;
  readonly fixtureMarketData: true;
  readonly upbitPrivateReadAttempted: false;
  readonly telegramPollingStarted: false;
  readonly telegramDeliveryAttempted: false;
  readonly schedulerStarted: false;
  readonly liveOrderTransmissionAttempted: false;
  readonly orderCountBefore: number;
  readonly orderCountAfter: number;
  readonly dryRunOrderCountDelta: number;
  readonly latestBtcDecisionId: string | null;
  readonly latestEthDecisionId: string | null;
  readonly blockingCommandNames: string[];
  readonly warningCommandNames: string[];
  readonly safetyBlockers: string[];
  readonly commands: DryRunOperatorSmokeCommandResult[];
}

export function applyDryRunOperatorSmokeSafetyEnv(
  env: NodeJS.ProcessEnv = process.env,
): DryRunOperatorSmokeEnvReport {
  const previous = {} as Record<DryRunOperatorSmokeEnvKey, string | undefined>;
  for (const key of Object.keys(FORCED_DRY_RUN_OPERATOR_SMOKE_ENV) as DryRunOperatorSmokeEnvKey[]) {
    previous[key] = env[key];
    env[key] = FORCED_DRY_RUN_OPERATOR_SMOKE_ENV[key];
  }

  const clearedSecrets = {} as Record<ClearedSecretEnvKey, { readonly wasConfigured: boolean }>;
  for (const key of CLEARED_SECRET_ENV_KEYS) {
    clearedSecrets[key] = { wasConfigured: Boolean(env[key]?.trim()) };
    delete env[key];
  }

  const databasePathDefaulted = !env.DATABASE_PATH?.trim();
  if (databasePathDefaulted) {
    env.DATABASE_PATH = DEFAULT_DRY_RUN_OPERATOR_SMOKE_DATABASE_PATH;
  }
  const databasePath = env.DATABASE_PATH ?? DEFAULT_DRY_RUN_OPERATOR_SMOKE_DATABASE_PATH;

  return {
    forced: { ...FORCED_DRY_RUN_OPERATOR_SMOKE_ENV },
    previous,
    clearedSecrets,
    databasePathDefaulted,
    databasePath,
  };
}

export function validateDryRunOperatorSmokeSafety(input: {
  config: AppConfig;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
}): string[] {
  const blockers: string[] = [];

  if (input.config.executionMode !== "DRY_RUN") {
    blockers.push("APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run operator smoke.");
  }

  if (input.config.liveExecutionGate !== "DISABLED") {
    blockers.push("ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run operator smoke.");
  }

  if (input.liveSendPath !== "DRY_RUN_ADAPTER") {
    blockers.push("liveSendPath must remain DRY_RUN_ADAPTER for dry-run operator smoke.");
  }

  if (input.exchangeBackedReadEnabled) {
    blockers.push("Upbit private read credentials must be cleared for offline dry-run operator smoke.");
  }

  if (input.config.telegramDeliveryEnabled) {
    blockers.push("ENABLE_TELEGRAM_DELIVERY must be false for dry-run operator smoke.");
  }

  if (input.config.telegramInboundPollingEnabled) {
    blockers.push("ENABLE_TELEGRAM_INBOUND_POLLING must be false for dry-run operator smoke.");
  }

  if (input.config.strategySchedulerEnabled) {
    blockers.push("STRATEGY_SCHEDULER_ENABLED must be false for dry-run operator smoke.");
  }

  if (input.config.strategySchedulerRunOnStart) {
    blockers.push("STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run operator smoke.");
  }

  return blockers;
}

export async function runDryRunOperatorSmoke(): Promise<DryRunOperatorSmokeResult> {
  const safetyEnv = applyDryRunOperatorSmokeSafetyEnv();
  const app = createApp(undefined, {
    publicMarketDataReader: createDryRunOperatorMarketDataReader(),
  });

  try {
    return await buildDryRunOperatorSmokeResult(app, safetyEnv);
  } finally {
    app.telegramInboundPolling.stop();
    app.strategyScheduler.stop();
    app.persistence.close();
  }
}

export async function buildDryRunOperatorSmokeResult(
  app: Pick<
    AppServices,
    | "config"
    | "repositories"
    | "telegramRouter"
    | "telegramInboundPolling"
    | "strategyScheduler"
    | "exchangeBackedReadEnabled"
    | "liveSendPath"
  >,
  safetyEnv: DryRunOperatorSmokeEnvReport,
): Promise<DryRunOperatorSmokeResult> {
  const safetyBlockers = validateDryRunOperatorSmokeSafety({
    config: app.config,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    liveSendPath: app.liveSendPath,
  });
  const orderCountBefore = (await app.repositories.listOrders("primary")).length;
  const commands = safetyBlockers.length === 0
    ? await runOperatorCommands(app.telegramRouter)
    : [];
  const orderCountAfter = (await app.repositories.listOrders("primary")).length;
  const [latestBtcDecision, latestEthDecision] = await Promise.all([
    app.repositories.getLatestStrategyDecision("primary", "KRW-BTC"),
    app.repositories.getLatestStrategyDecision("primary", "KRW-ETH"),
  ]);
  const blockingCommandNames = getCommandNamesByStatus(commands, "BLOCK");
  const warningCommandNames = getCommandNamesByStatus(commands, "WARN");

  return {
    service: app.config.serviceName,
    status: summarizeDryRunOperatorSmokeStatus({
      safetyBlockers,
      commands,
      dryRunOrderCountDelta: orderCountAfter - orderCountBefore,
    }),
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    liveSendPath: app.liveSendPath,
    databasePath: app.config.databasePath,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    schedulerEnabled: app.config.strategySchedulerEnabled,
    schedulerRunOnStart: app.config.strategySchedulerRunOnStart,
    telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
    telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
    safetyEnv,
    fixtureMarketData: true,
    upbitPrivateReadAttempted: false,
    telegramPollingStarted: false,
    telegramDeliveryAttempted: false,
    schedulerStarted: false,
    liveOrderTransmissionAttempted: false,
    orderCountBefore,
    orderCountAfter,
    dryRunOrderCountDelta: orderCountAfter - orderCountBefore,
    latestBtcDecisionId: latestBtcDecision?.id ?? null,
    latestEthDecisionId: latestEthDecision?.id ?? null,
    blockingCommandNames,
    warningCommandNames,
    safetyBlockers,
    commands,
  };
}

export function createDryRunOperatorMarketDataReader(): PositionGuardPublicMarketDataReader {
  return {
    async getTickers(markets: readonly UpbitSpotMarket[]): Promise<readonly UpbitTickerSnapshot[]> {
      return markets.map((market) => ({
        market,
        trade_price: getFixtureTradePrice(market),
        trade_timestamp: Date.parse("2026-04-20T01:05:00.000Z"),
      }));
    },
    async getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      const durationMs = request.unit === 60 ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
      return createFixtureCandles(request.market, request.count, durationMs);
    },
    async getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      return createFixtureCandles(request.market, request.count, 24 * 60 * 60 * 1000);
    },
  };
}

async function runOperatorCommands(
  router: Pick<AppServices["telegramRouter"], "route">,
): Promise<DryRunOperatorSmokeCommandResult[]> {
  const results: DryRunOperatorSmokeCommandResult[] = [];
  for (const expectation of COMMAND_EXPECTATIONS) {
    try {
      const response = await router.route(expectation.command);
      const missingPatterns = expectation.requiredPatterns
        .filter((pattern) => !pattern.test(response.text))
        .map((pattern) => pattern.source);
      results.push({
        command: expectation.command,
        status: missingPatterns.length === 0 ? "PASS" : "BLOCK",
        firstLine: response.text.split("\n")[0] ?? "",
        missingPatterns,
        error: null,
      });
    } catch (error) {
      results.push({
        command: expectation.command,
        status: "BLOCK",
        firstLine: "",
        missingPatterns: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function summarizeDryRunOperatorSmokeStatus(input: {
  safetyBlockers: readonly string[];
  commands: readonly DryRunOperatorSmokeCommandResult[];
  dryRunOrderCountDelta: number;
}): DryRunOperatorSmokeStatus {
  if (
    input.safetyBlockers.length > 0 ||
    input.commands.some((command) => command.status === "BLOCK") ||
    input.dryRunOrderCountDelta !== 0
  ) {
    return "BLOCK";
  }

  if (input.commands.some((command) => command.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

function getCommandNamesByStatus(
  commands: readonly DryRunOperatorSmokeCommandResult[],
  status: DryRunOperatorSmokeStatus,
): string[] {
  return commands.filter((command) => command.status === status).map((command) => command.command);
}

function getFixtureTradePrice(market: UpbitSpotMarket): number {
  return market === "KRW-BTC" ? 100_000_000 : 5_000_000;
}

function createFixtureCandles(
  market: UpbitSpotMarket,
  count: number,
  durationMs: number,
): UpbitCandleSnapshot[] {
  const price = getFixtureTradePrice(market);
  const lastOpenMs = Date.parse("2026-04-20T00:00:00.000Z");

  return Array.from({ length: count }, (_, index) => {
    const openMs = lastOpenMs - ((count - 1 - index) * durationMs);
    return {
      market,
      candle_date_time_utc: new Date(openMs).toISOString().replace(/\.000Z$/u, ""),
      candle_date_time_kst: new Date(openMs + 9 * 60 * 60 * 1000).toISOString().replace(/\.000Z$/u, ""),
      opening_price: price,
      high_price: price * 1.01,
      low_price: price * 0.99,
      trade_price: price,
      timestamp: openMs,
      candle_acc_trade_price: price * 10,
      candle_acc_trade_volume: 10,
    };
  });
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runDryRunOperatorSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
