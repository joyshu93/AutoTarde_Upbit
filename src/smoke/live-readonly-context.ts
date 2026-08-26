import type { AppConfig } from "../app/env.js";
import { loadAppConfig } from "../app/env.js";
import { verifyLiveDatabaseIdentity } from "../app/live-database-identity.js";
import {
  SqliteExecutionRepository,
  SqliteOperatorStateStore,
} from "../modules/db/repositories/sqlite-repositories.js";
import { openReadOnlySqliteDatabase } from "../modules/db/repositories/sqlite-database.js";

export interface LiveReadOnlyContext {
  config: AppConfig;
  repositories: SqliteExecutionRepository;
  operatorState: SqliteOperatorStateStore;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  telegramInboundPollingConfigured: boolean;
  telegramDeliveryConfigured: boolean;
  close(): void;
}

export function openLiveReadOnlyContext(
  config: AppConfig = loadAppConfig(),
  env: NodeJS.ProcessEnv = process.env,
): LiveReadOnlyContext {
  if (config.executionMode !== "LIVE") {
    throw new Error("Read-only LIVE inspection requires APP_EXECUTION_MODE=LIVE.");
  }
  const accessKey = env.UPBIT_ACCESS_KEY?.trim() || null;
  const secretKey = env.UPBIT_SECRET_KEY?.trim() || null;
  verifyLiveDatabaseIdentity({
    executionMode: config.executionMode,
    databasePath: config.databasePath,
    expectedDatabaseInstanceId: config.liveDatabaseInstanceId ?? null,
    exchangeAccountId: "primary",
    upbitAccessKey: accessKey,
  });

  const db = openReadOnlySqliteDatabase(config.databasePath);
  const exchangeBackedReadEnabled = Boolean(accessKey && secretKey);
  return {
    config,
    repositories: new SqliteExecutionRepository(db),
    operatorState: new SqliteOperatorStateStore(db, "primary"),
    exchangeBackedReadEnabled,
    liveSendPath: config.liveExecutionGate === "ENABLED" && exchangeBackedReadEnabled
      ? "LIVE_ADAPTER"
      : "DRY_RUN_ADAPTER",
    telegramInboundPollingConfigured: config.telegramInboundPollingEnabled &&
      Boolean(config.telegramBotToken && config.telegramOperatorChatId),
    telegramDeliveryConfigured: config.telegramDeliveryEnabled &&
      Boolean(config.telegramBotToken && config.telegramOperatorChatId),
    close() {
      db.close();
    },
  };
}
