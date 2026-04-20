import { readCsv, readInteger, readOptionalInteger, readOptionalString } from "./env.js";
import type { LogLevel } from "./logger.js";
import { KNOWN_LOG_LEVELS } from "./logger.js";
import {
  MODULE_NAMES,
  SUPPORTED_MARKETS,
  type ApprovedMarket,
  type ModuleName
} from "./runtime-constants.js";

const TRADING_MODES = ["DRY_RUN", "LIVE"] as const;
const APP_ENVS = ["development", "test", "production"] as const;
const BOOLEAN_TRUE_VALUES = ["1", "true", "yes", "on"] as const;
const BOOLEAN_FALSE_VALUES = ["0", "false", "no", "off"] as const;

export type TradingMode = (typeof TRADING_MODES)[number];
export type AppEnvironment = (typeof APP_ENVS)[number];

export interface AppConfig {
  readonly appEnv: AppEnvironment;
  readonly logLevel: LogLevel;
  readonly startupWarnings: readonly string[];
  readonly trading: {
    readonly mode: TradingMode;
    readonly liveOrdersEnabled: boolean;
    readonly approvedSymbols: readonly ApprovedMarket[];
  };
  readonly controls: {
    readonly startPaused: boolean;
    readonly killSwitchEnabled: boolean;
  };
  readonly runtime: {
    readonly cycleIntervalMs: number;
    readonly gracefulShutdownTimeoutMs: number;
  };
  readonly modules: {
    readonly enabled: readonly ModuleName[];
    readonly disabled: readonly ModuleName[];
  };
  readonly risk: {
    readonly maxOrderNotionalKrw: number | null;
    readonly maxSymbolExposureKrw: number | null;
    readonly maxTotalExposureKrw: number | null;
  };
  readonly integrations: {
    readonly databaseUrl: string | null;
    readonly telegramBotToken: string | null;
    readonly upbitAccessKey: string | null;
    readonly upbitSecretKey: string | null;
    readonly upbitRestBaseUrl: string;
    readonly upbitWebsocketUrl: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const startupWarnings: string[] = [];
  const appEnv = readEnumOrDefault(env, "APP_ENV", APP_ENVS, "development", startupWarnings);
  const logLevel = readEnumOrDefault(env, "LOG_LEVEL", KNOWN_LOG_LEVELS, "info", startupWarnings);
  const tradingMode = parseTradingMode(env, startupWarnings);
  const liveOrdersEnabled = parseSafeBooleanFlag(
    env,
    ["ENABLE_LIVE_ORDERS", "ENABLE_LIVE_EXECUTION"],
    false,
    startupWarnings,
    "ENABLE_LIVE_ORDERS"
  );
  const approvedSymbols = parseApprovedSymbols(
    readCsv(env, "APPROVED_SYMBOLS", [...SUPPORTED_MARKETS])
  );
  const enabledModules = parseEnabledModules(readCsv(env, "ENABLED_MODULES", [...MODULE_NAMES]));
  const disabledModuleSet = new Set(MODULE_NAMES.filter((name) => !enabledModules.includes(name)));

  const config: AppConfig = {
    appEnv,
    logLevel,
    startupWarnings,
    trading: {
      mode: tradingMode,
      liveOrdersEnabled,
      approvedSymbols
    },
    controls: {
      startPaused: parseSafeBooleanFlag(
        env,
        ["START_PAUSED"],
        false,
        startupWarnings,
        "START_PAUSED"
      ),
      killSwitchEnabled: parseSafeBooleanFlag(
        env,
        ["GLOBAL_KILL_SWITCH"],
        false,
        startupWarnings,
        "GLOBAL_KILL_SWITCH"
      )
    },
    runtime: {
      cycleIntervalMs: readInteger(env, "CYCLE_INTERVAL_MS", 60_000, { min: 1_000 }),
      gracefulShutdownTimeoutMs: readInteger(env, "GRACEFUL_SHUTDOWN_TIMEOUT_MS", 10_000, {
        min: 1_000
      })
    },
    modules: {
      enabled: enabledModules,
      disabled: MODULE_NAMES.filter((name) => disabledModuleSet.has(name))
    },
    risk: {
      maxOrderNotionalKrw: readOptionalInteger(env, "MAX_ORDER_NOTIONAL_KRW", { min: 1 }),
      maxSymbolExposureKrw: readOptionalInteger(env, "MAX_SYMBOL_EXPOSURE_KRW", { min: 1 }),
      maxTotalExposureKrw: readOptionalInteger(env, "MAX_TOTAL_EXPOSURE_KRW", { min: 1 })
    },
    integrations: {
      databaseUrl: readOptionalString(env, "DATABASE_URL"),
      telegramBotToken: readOptionalString(env, "TELEGRAM_BOT_TOKEN"),
      upbitAccessKey: readOptionalString(env, "UPBIT_ACCESS_KEY"),
      upbitSecretKey: readOptionalString(env, "UPBIT_SECRET_KEY"),
      upbitRestBaseUrl: readOptionalString(env, "UPBIT_REST_BASE_URL") ?? "https://api.upbit.com",
      upbitWebsocketUrl:
        readOptionalString(env, "UPBIT_WEBSOCKET_URL") ?? "wss://api.upbit.com/websocket/v1"
    }
  };

  if (config.controls.killSwitchEnabled) {
    startupWarnings.push(
      "GLOBAL_KILL_SWITCH is enabled. Execution modules should remain halted until an operator clears it."
    );
  }

  validateLiveStartup(config);

  return config;
}

export function summarizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    appEnv: config.appEnv,
    logLevel: config.logLevel,
    startupWarnings: config.startupWarnings,
    trading: config.trading,
    controls: config.controls,
    runtime: config.runtime,
    modules: config.modules,
    risk: {
      maxOrderNotionalKrwConfigured: config.risk.maxOrderNotionalKrw !== null,
      maxSymbolExposureKrwConfigured: config.risk.maxSymbolExposureKrw !== null,
      maxTotalExposureKrwConfigured: config.risk.maxTotalExposureKrw !== null
    },
    integrations: {
      databaseConfigured: Boolean(config.integrations.databaseUrl),
      telegramConfigured: Boolean(config.integrations.telegramBotToken),
      upbitConfigured:
        Boolean(config.integrations.upbitAccessKey) && Boolean(config.integrations.upbitSecretKey),
      upbitRestBaseUrl: config.integrations.upbitRestBaseUrl,
      upbitWebsocketUrl: config.integrations.upbitWebsocketUrl
    }
  };
}

function readEnumOrDefault<const TValues extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowedValues: TValues,
  defaultValue: TValues[number],
  warnings: string[]
): TValues[number] {
  const rawValue = readOptionalString(env, key);

  if (!rawValue) {
    return defaultValue;
  }

  if ((allowedValues as readonly string[]).includes(rawValue)) {
    return rawValue as TValues[number];
  }

  warnings.push(
    `Invalid ${key} value "${rawValue}" detected; falling back to ${defaultValue}.`
  );
  return defaultValue;
}

function parseTradingMode(env: NodeJS.ProcessEnv, warnings: string[]): TradingMode {
  const rawValue = readFirstConfigured(env, ["TRADING_MODE", "EXECUTION_MODE"]);

  if (!rawValue) {
    return "DRY_RUN";
  }

  if ((TRADING_MODES as readonly string[]).includes(rawValue)) {
    return rawValue as TradingMode;
  }

  warnings.push(`Invalid TRADING_MODE value "${rawValue}" detected; falling back to DRY_RUN.`);
  return "DRY_RUN";
}

function parseSafeBooleanFlag(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  defaultValue: boolean,
  warnings: string[],
  canonicalKey: string
): boolean {
  const rawValue = readFirstConfigured(env, keys);

  if (!rawValue) {
    return defaultValue;
  }

  const normalized = rawValue.toLowerCase();

  if ((BOOLEAN_TRUE_VALUES as readonly string[]).includes(normalized)) {
    return true;
  }

  if ((BOOLEAN_FALSE_VALUES as readonly string[]).includes(normalized)) {
    return false;
  }

  warnings.push(
    `Invalid ${canonicalKey} value "${rawValue}" detected; falling back to ${String(defaultValue)}.`
  );
  return defaultValue;
}

function readFirstConfigured(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const key of keys) {
    const rawValue = readOptionalString(env, key);

    if (rawValue) {
      return rawValue;
    }
  }

  return null;
}

function parseApprovedSymbols(requestedSymbols: readonly string[]): readonly ApprovedMarket[] {
  const validSymbols = new Set<string>(SUPPORTED_MARKETS);
  const seen = new Set<ApprovedMarket>();
  const approvedSymbols: ApprovedMarket[] = [];

  for (const symbol of requestedSymbols) {
    if (!validSymbols.has(symbol)) {
      throw new Error(
        `Unknown APPROVED_SYMBOLS entry "${symbol}". Allowed values: ${SUPPORTED_MARKETS.join(", ")}`
      );
    }

    const typedSymbol = symbol as ApprovedMarket;

    if (!seen.has(typedSymbol)) {
      seen.add(typedSymbol);
      approvedSymbols.push(typedSymbol);
    }
  }

  return approvedSymbols;
}

function parseEnabledModules(requestedModules: readonly string[]): readonly ModuleName[] {
  const validNames = new Set<string>(MODULE_NAMES);
  const seen = new Set<ModuleName>();
  const enabled: ModuleName[] = [];

  for (const name of requestedModules) {
    if (!validNames.has(name)) {
      throw new Error(
        `Unknown ENABLED_MODULES entry "${name}". Allowed values: ${MODULE_NAMES.join(", ")}`
      );
    }

    const typedName = name as ModuleName;

    if (!seen.has(typedName)) {
      seen.add(typedName);
      enabled.push(typedName);
    }
  }

  return enabled;
}

function validateLiveStartup(config: AppConfig): void {
  if (config.trading.mode !== "LIVE") {
    return;
  }

  const errors: string[] = [];

  if (!config.trading.liveOrdersEnabled) {
    errors.push("ENABLE_LIVE_ORDERS=true is required when TRADING_MODE=LIVE.");
  }

  if (!config.integrations.upbitAccessKey || !config.integrations.upbitSecretKey) {
    errors.push("UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY are required when TRADING_MODE=LIVE.");
  }

  if (!config.integrations.databaseUrl) {
    errors.push("DATABASE_URL is required when TRADING_MODE=LIVE.");
  }

  if (!config.integrations.telegramBotToken) {
    errors.push("TELEGRAM_BOT_TOKEN is required when TRADING_MODE=LIVE.");
  }

  if (config.trading.approvedSymbols.length === 0) {
    errors.push("APPROVED_SYMBOLS must include at least one approved market.");
  }

  if (
    config.risk.maxOrderNotionalKrw === null ||
    config.risk.maxSymbolExposureKrw === null ||
    config.risk.maxTotalExposureKrw === null
  ) {
    errors.push(
      "MAX_ORDER_NOTIONAL_KRW, MAX_SYMBOL_EXPOSURE_KRW, and MAX_TOTAL_EXPOSURE_KRW are required when TRADING_MODE=LIVE."
    );
  }

  if (errors.length > 0) {
    throw new Error(`LIVE startup validation failed:\n- ${errors.join("\n- ")}`);
  }
}
