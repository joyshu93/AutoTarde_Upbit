import { createApp } from "./app/create-app.js";
import { applyStartupRecoveryPolicy, runStartupRecovery } from "./app/startup-recovery.js";
import { detectExecutionStateSeedMismatches } from "./modules/db/interfaces.js";

async function main(): Promise<void> {
  const app = createApp();
  const startupRecovery = await runStartupRecovery({
    exchangeAccountId: "primary",
    enabled: app.exchangeBackedReadEnabled,
    portfolioSyncService: app.portfolioSyncService,
  });
  const startupRecoveryPolicy = await applyStartupRecoveryPolicy({
    operatorState: app.operatorState,
    recovery: startupRecovery,
  });
  let notificationDeliverySummary:
    | {
        attempted: number;
        sent: number;
        retryScheduled: number;
        failed: number;
        staleLease: number;
        pendingDue: number;
        pendingScheduled: number;
        activeLease: number;
        skippedReason: string | null;
      }
    | {
        attempted: 0;
        sent: 0;
        retryScheduled: 0;
        failed: 0;
        staleLease: 0;
        pendingDue: 0;
        pendingScheduled: 0;
        activeLease: 0;
        skippedReason: string;
      };

  try {
    notificationDeliverySummary = await app.notificationDelivery.deliverPending("primary");
  } catch (error) {
    notificationDeliverySummary = {
      attempted: 0,
      sent: 0,
      retryScheduled: 0,
      failed: 0,
      staleLease: 0,
      pendingDue: 0,
      pendingScheduled: 0,
      activeLease: 0,
      skippedReason: error instanceof Error ? error.message : String(error),
    };
  }

  const state = await app.operatorState.getState();
  const seedMismatches = detectExecutionStateSeedMismatches(state, {
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    killSwitchActive: app.config.globalKillSwitch,
  });

  const banner = {
    service: app.config.serviceName,
    stateSource: "persisted execution_state",
    executionMode: state.executionMode,
    liveExecutionGate: state.liveExecutionGate,
    systemStatus: state.systemStatus,
    killSwitchActive: state.killSwitchActive,
    liveSendPath: "DRY_RUN_ADAPTER",
    seedMismatches,
    upbitBaseUrl: app.config.upbitBaseUrl,
    databasePath: app.config.databasePath,
    recoveryReader: app.exchangeBackedReadEnabled ? "UPBIT_PRIVATE_READER" : "DISABLED",
    reconciliationMaxOrderLookupsPerRun: app.config.reconciliationMaxOrderLookupsPerRun,
    reconciliationHistoryMaxPagesPerMarket: app.config.reconciliationHistoryMaxPagesPerMarket,
    reconciliationClosedOrderLookbackDays: app.config.reconciliationClosedOrderLookbackDays,
    startupRecovery,
    startupRecoveryPolicy,
    telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
    telegramDeliveryConfigured: app.notificationDelivery.isConfigured(),
    telegramDeliveryMaxAttempts: app.config.telegramDeliveryMaxAttempts,
    telegramDeliveryBaseBackoffMs: app.config.telegramDeliveryBaseBackoffMs,
    telegramDeliveryMaxBackoffMs: app.config.telegramDeliveryMaxBackoffMs,
    telegramDeliveryLeaseMs: app.config.telegramDeliveryLeaseMs,
    notificationDeliverySummary,
    supportedCommands: app.telegramRouter.getSupportedCommands(),
  };

  console.log(JSON.stringify(banner, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
