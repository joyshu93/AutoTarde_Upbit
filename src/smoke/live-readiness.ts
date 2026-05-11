import { pathToFileURL } from "node:url";

import { createApp, type AppServices } from "../app/create-app.js";
import type { AppConfig } from "../app/env.js";
import type { ExecutionStateRecord } from "../domain/types.js";
import { detectExecutionStateSeedMismatches } from "../modules/db/interfaces.js";

type LiveReadinessSmokeStatus = "PASS" | "WARN" | "BLOCK";

export interface LiveReadinessSmokeCheck {
  readonly name: string;
  readonly status: LiveReadinessSmokeStatus;
  readonly detail: string;
}

export interface LiveReadinessSmokeResult {
  readonly service: string;
  readonly status: LiveReadinessSmokeStatus;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly maxLiveOrderValueKrw: number | null;
  readonly schedulerEnabled: boolean;
  readonly schedulerRunOnStart: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly orderTransmissionAttempted: false;
  readonly strategyRunAttempted: false;
  readonly schedulerStarted: false;
  readonly telegramPollingStarted: false;
  readonly exchangeProbeAttempted: false;
  readonly activeOrderCount: number;
  readonly latestBalanceSnapshotAt: string | null;
  readonly latestPositionSnapshotAt: string | null;
  readonly latestReconciliationStatus: string | null;
  readonly seedMismatches: string[];
  readonly checks: LiveReadinessSmokeCheck[];
}

export async function runLiveReadinessSmoke(): Promise<LiveReadinessSmokeResult> {
  const app = createApp();

  try {
    const [executionState, activeOrders, latestBalanceSnapshot, latestPositionSnapshot, reconciliationRuns] =
      await Promise.all([
        app.operatorState.getState(),
        app.repositories.listActiveOrders("primary", undefined, 20),
        app.repositories.getLatestBalanceSnapshot("primary"),
        app.repositories.getLatestPositionSnapshot("primary"),
        app.repositories.listReconciliationRuns("primary", 1),
      ]);
    const latestReconciliationRun = reconciliationRuns[0] ?? null;
    const seedMismatches = detectExecutionStateSeedMismatches(executionState, {
      executionMode: app.config.executionMode,
      liveExecutionGate: app.config.liveExecutionGate,
      killSwitchActive: app.config.globalKillSwitch,
    });
    const checks = buildLiveReadinessSmokeChecks({
      app,
      executionState,
      seedMismatches,
      activeOrderCount: activeOrders.length,
      latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
      latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
      latestReconciliationStatus: latestReconciliationRun?.status ?? null,
    });

    return {
      service: app.config.serviceName,
      status: summarizeLiveReadinessSmokeStatus(checks),
      executionMode: app.config.executionMode,
      liveExecutionGate: app.config.liveExecutionGate,
      liveSendPath: app.liveSendPath,
      databasePath: app.config.databasePath,
      exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
      maxLiveOrderValueKrw: app.config.maxLiveOrderValueKrw,
      schedulerEnabled: app.config.strategySchedulerEnabled,
      schedulerRunOnStart: app.config.strategySchedulerRunOnStart,
      telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
      telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
      orderTransmissionAttempted: false,
      strategyRunAttempted: false,
      schedulerStarted: false,
      telegramPollingStarted: false,
      exchangeProbeAttempted: false,
      activeOrderCount: activeOrders.length,
      latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
      latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
      latestReconciliationStatus: latestReconciliationRun?.status ?? null,
      seedMismatches,
      checks,
    };
  } finally {
    app.telegramInboundPolling.stop();
    app.strategyScheduler.stop();
    app.persistence.close();
  }
}

export function buildLiveReadinessSmokeChecks(input: {
  app: Pick<AppServices, "config" | "exchangeBackedReadEnabled" | "liveSendPath">;
  executionState: ExecutionStateRecord;
  seedMismatches: string[];
  activeOrderCount: number;
  latestBalanceSnapshotAt: string | null;
  latestPositionSnapshotAt: string | null;
  latestReconciliationStatus: string | null;
}): LiveReadinessSmokeCheck[] {
  return [
    {
      name: "non_mutation_boundary",
      status: "PASS",
      detail:
        "This smoke creates no orders, runs no strategy cycle, starts no scheduler, starts no Telegram polling, and calls no exchange endpoint.",
    },
    {
      name: "live_mode",
      status: input.app.config.executionMode === "LIVE" ? "PASS" : "BLOCK",
      detail: input.app.config.executionMode === "LIVE"
        ? "APP_EXECUTION_MODE resolves to LIVE."
        : "APP_EXECUTION_MODE must resolve to LIVE for live readiness.",
    },
    {
      name: "live_gate",
      status: input.app.config.liveExecutionGate === "ENABLED" ? "PASS" : "BLOCK",
      detail: input.app.config.liveExecutionGate === "ENABLED"
        ? "ENABLE_LIVE_ORDERS=true is configured."
        : "ENABLE_LIVE_ORDERS must be true for live readiness.",
    },
    {
      name: "upbit_credentials",
      status: input.app.exchangeBackedReadEnabled ? "PASS" : "BLOCK",
      detail: input.app.exchangeBackedReadEnabled
        ? "Upbit credentials are configured. Secret values are not rendered."
        : "UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY must both be configured.",
    },
    {
      name: "live_send_path",
      status: input.app.liveSendPath === "LIVE_ADAPTER" ? "PASS" : "BLOCK",
      detail: input.app.liveSendPath === "LIVE_ADAPTER"
        ? "Execution service would use the live Upbit adapter if a later eligible strategy run submits an order."
        : "Execution service is still wired to the dry-run adapter.",
    },
    {
      name: "max_live_order_value",
      status: input.app.config.maxLiveOrderValueKrw === null ? "WARN" : "PASS",
      detail: input.app.config.maxLiveOrderValueKrw === null
        ? "MAX_LIVE_ORDER_VALUE_KRW is unset; ratio sizing can create larger live orders than intended."
        : `MAX_LIVE_ORDER_VALUE_KRW=${input.app.config.maxLiveOrderValueKrw}`,
    },
    {
      name: "scheduler_disabled_for_validation",
      status: input.app.config.strategySchedulerEnabled ? "BLOCK" : "PASS",
      detail: input.app.config.strategySchedulerEnabled
        ? "STRATEGY_SCHEDULER_ENABLED must be false for this live readiness smoke."
        : "Strategy scheduler is disabled for manual live validation.",
    },
    {
      name: "scheduler_run_on_start_disabled",
      status: input.app.config.strategySchedulerRunOnStart ? "BLOCK" : "PASS",
      detail: input.app.config.strategySchedulerRunOnStart
        ? "STRATEGY_SCHEDULER_RUN_ON_START must be false for this live readiness smoke."
        : "No immediate scheduler tick is configured.",
    },
    {
      name: "execution_state",
      status: isLiveRunnableExecutionState(input.executionState) ? "PASS" : "BLOCK",
      detail: describeExecutionState(input.executionState),
    },
    {
      name: "execution_state_seed",
      status: input.seedMismatches.length === 0 ? "PASS" : "BLOCK",
      detail: input.seedMismatches.length === 0
        ? "Persisted execution_state matches current startup seed."
        : `Persisted execution_state differs from startup seed: ${input.seedMismatches.join(",")}.`,
    },
    {
      name: "balance_snapshot",
      status: input.latestBalanceSnapshotAt ? "PASS" : "WARN",
      detail: input.latestBalanceSnapshotAt
        ? `latest balance snapshot captured_at=${input.latestBalanceSnapshotAt}`
        : "No balance snapshot is stored yet; run /sync before any live strategy run.",
    },
    {
      name: "position_snapshot",
      status: input.latestPositionSnapshotAt ? "PASS" : "WARN",
      detail: input.latestPositionSnapshotAt
        ? `latest position snapshot captured_at=${input.latestPositionSnapshotAt}`
        : "No position snapshot is stored yet; run /sync before any live strategy run.",
    },
    {
      name: "latest_reconciliation",
      status: input.latestReconciliationStatus === null ? "WARN" : "PASS",
      detail: input.latestReconciliationStatus === null
        ? "No reconciliation run is stored yet; run /sync before any live strategy run."
        : `latest reconciliation status=${input.latestReconciliationStatus}`,
    },
    {
      name: "active_orders",
      status: input.activeOrderCount === 0 ? "PASS" : "BLOCK",
      detail: input.activeOrderCount === 0
        ? "No active or reconciliation-required orders are stored."
        : `${input.activeOrderCount} active or reconciliation-required order(s) must be resolved first.`,
    },
  ];
}

export function summarizeLiveReadinessSmokeStatus(
  checks: readonly LiveReadinessSmokeCheck[],
): LiveReadinessSmokeStatus {
  if (checks.some((check) => check.status === "BLOCK")) {
    return "BLOCK";
  }

  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

function isLiveRunnableExecutionState(state: ExecutionStateRecord): boolean {
  return state.executionMode === "LIVE" &&
    state.liveExecutionGate === "ENABLED" &&
    state.systemStatus === "RUNNING" &&
    !state.killSwitchActive &&
    state.degradedReason === null;
}

function describeExecutionState(state: ExecutionStateRecord): string {
  const blockers: string[] = [];

  if (state.executionMode !== "LIVE") {
    blockers.push("execution_mode_not_live");
  }

  if (state.liveExecutionGate !== "ENABLED") {
    blockers.push("live_gate_disabled");
  }

  if (state.systemStatus !== "RUNNING") {
    blockers.push(`system_status_${state.systemStatus.toLowerCase()}`);
  }

  if (state.killSwitchActive) {
    blockers.push("kill_switch_active");
  }

  if (state.degradedReason !== null) {
    blockers.push(`degraded:${state.degradedReason}`);
  }

  return blockers.length === 0
    ? "Execution state is live, running, not degraded, and kill switch is off."
    : `Execution state blocks live readiness: ${blockers.join(",")}.`;
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runLiveReadinessSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
