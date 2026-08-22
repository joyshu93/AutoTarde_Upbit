import type { AppConfig } from "./env.js";
import { evaluateLiveStrategyRunPreflight } from "./scheduler-preflight.js";
import type {
  CandidateBtcRunPreparation,
  CandidateBtcRunPreparationResult,
} from "./strategy-run-controller.js";
import type { PositionGuardPilotRefreshReceipt } from "../domain/pilot-types.js";
import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
} from "../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../modules/db/interfaces.js";
import { parseCandidatePilotTimestamp } from "../modules/db/pilot-interfaces.js";
import type { PortfolioSyncRunResult, PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";

type CandidateBtcRunPreparationDependencies = {
  config: Pick<AppConfig, "strategySchedulerBtcIntervalMs" | "strategySchedulerEthIntervalMs" | "liveExecutionGate">;
  portfolioSync: Pick<PortfolioSyncService, "run">;
  operatorState: Pick<OperatorStateStore, "getState">;
  repositories: Pick<ExecutionRepository, "listActiveOrders">;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  now?: () => string;
};

export class CandidateBtcRunPreparationService implements CandidateBtcRunPreparation {
  private readonly dependencies: Readonly<CandidateBtcRunPreparationDependencies>;

  constructor(dependencies: CandidateBtcRunPreparationDependencies) {
    this.dependencies = Object.freeze({
      config: Object.freeze({
        strategySchedulerBtcIntervalMs: dependencies.config.strategySchedulerBtcIntervalMs,
        strategySchedulerEthIntervalMs: dependencies.config.strategySchedulerEthIntervalMs,
        liveExecutionGate: dependencies.config.liveExecutionGate,
      }),
      portfolioSync: dependencies.portfolioSync,
      operatorState: dependencies.operatorState,
      repositories: dependencies.repositories,
      exchangeBackedReadEnabled: dependencies.exchangeBackedReadEnabled,
      liveSendPath: dependencies.liveSendPath,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
  }

  async prepare(input: Readonly<{
    exchangeAccountId: string;
    requestedAt: string;
    requestedBy: "TELEGRAM" | "SCHEDULER";
  }>): Promise<CandidateBtcRunPreparationResult> {
    const request = snapshotRequest(input);
    const dependencies = this.dependencies;
    const runPortfolioSync = dependencies.portfolioSync.run.bind(dependencies.portfolioSync);
    const getExecutionState = dependencies.operatorState.getState.bind(dependencies.operatorState);
    const listActiveOrders = dependencies.repositories.listActiveOrders.bind(dependencies.repositories);
    const syncResult = await runPortfolioSync(Object.freeze({
      exchangeAccountId: request.exchangeAccountId,
      source: "SCHEDULER_PREFLIGHT",
      requestedAt: request.requestedAt,
    }));
    const evidence = snapshotExactSyncEvidence(syncResult, request);
    const executionState = snapshotExecutionState(await getExecutionState(), request.exchangeAccountId);
    const activeOrders = snapshotActiveOrders(await listActiveOrders(request.exchangeAccountId, undefined, 20));
    const checkedAt = dependencies.now?.() ?? new Date().toISOString();
    parseCandidatePilotTimestamp(checkedAt, "candidate BTC preparation checkedAt");
    const evaluation = evaluateLiveStrategyRunPreflight({
      config: dependencies.config,
      executionState,
      exchangeBackedReadEnabled: dependencies.exchangeBackedReadEnabled,
      liveSendPath: dependencies.liveSendPath,
      checkedAt,
      balanceSnapshot: evidence.balanceSnapshot,
      positionSnapshot: evidence.positionSnapshot,
      reconciliationRun: evidence.reconciliationRun,
      activeOrders,
    });

    if (evaluation.status === "BLOCK") {
      const names = evaluation.checks.filter((check) => check.status === "BLOCK").map((check) => check.name);
      return Object.freeze({
        status: "BLOCKED" as const,
        detail: `Candidate BTC run blocked by ${names.join(",")}.`,
      });
    }

    return Object.freeze({ status: "READY" as const, refreshReceipt: evidence.refreshReceipt });
  }
}

function snapshotRequest(value: Readonly<{
  exchangeAccountId: string;
  requestedAt: string;
  requestedBy: "TELEGRAM" | "SCHEDULER";
}>): Readonly<{
  exchangeAccountId: string;
  requestedAt: string;
  requestedBy: "TELEGRAM" | "SCHEDULER";
}> {
  const fields = exactDataRecord(value, "candidate BTC preparation request", ["exchangeAccountId", "requestedAt", "requestedBy"]);
  const exchangeAccountId = requiredString(fields.exchangeAccountId, "candidate BTC preparation exchangeAccountId");
  const requestedAt = requiredTimestamp(fields.requestedAt, "candidate BTC preparation requestedAt");
  if (fields.requestedBy !== "TELEGRAM" && fields.requestedBy !== "SCHEDULER") {
    throw new Error("Candidate BTC preparation requestedBy is unsupported.");
  }
  return Object.freeze({ exchangeAccountId, requestedAt, requestedBy: fields.requestedBy });
}

function snapshotExactSyncEvidence(
  value: PortfolioSyncRunResult,
  request: Readonly<{ exchangeAccountId: string; requestedAt: string }>,
): Readonly<{
  refreshReceipt: PositionGuardPilotRefreshReceipt;
  balanceSnapshot: BalanceSnapshotRecord;
  positionSnapshot: PositionSnapshotRecord;
  reconciliationRun: ReconciliationRunRecord;
}> {
  const result = exactDataRecord(value, "candidate BTC portfolio sync result", [
    "requestedAt", "valuationSource", "balanceSnapshot", "positionSnapshot", "previousBalanceSnapshot",
    "previousPositionSnapshot", "reconciliationSummary", "reconciliationRun",
  ]);
  if (requiredTimestamp(result.requestedAt, "candidate BTC portfolio sync requestedAt") !== request.requestedAt) {
    throw new Error("Candidate BTC portfolio sync requestedAt must match the request.");
  }
  const balanceSnapshot = snapshotBalanceSnapshot(result.balanceSnapshot, request);
  const positionSnapshot = snapshotPositionSnapshot(result.positionSnapshot, request);
  const reconciliationRun = snapshotReconciliationRun(result.reconciliationRun, request);
  const refreshReceipt = Object.freeze({
    exchangeAccountId: request.exchangeAccountId,
    requestedAt: request.requestedAt,
    balanceSnapshotId: balanceSnapshot.id,
    balanceCapturedAt: balanceSnapshot.capturedAt,
    positionSnapshotId: positionSnapshot.id,
    positionCapturedAt: positionSnapshot.capturedAt,
    reconciliationRunId: reconciliationRun.id,
    reconciliationStartedAt: reconciliationRun.startedAt,
    reconciliationCompletedAt: reconciliationRun.completedAt as string,
    reconciliationSource: "SCHEDULER_PREFLIGHT" as const,
  });
  return Object.freeze({ refreshReceipt, balanceSnapshot, positionSnapshot, reconciliationRun });
}

function snapshotBalanceSnapshot(value: unknown, request: Readonly<{ exchangeAccountId: string; requestedAt: string }>): BalanceSnapshotRecord {
  const fields = exactDataRecord(value, "candidate BTC balance snapshot", [
    "id", "exchangeAccountId", "capturedAt", "source", "totalKrwValue", "balancesJson",
  ]);
  assertSnapshotCorrelation(fields, request, "balance snapshot");
  if (fields.source !== "RECONCILIATION" || (typeof fields.totalKrwValue !== "string" && fields.totalKrwValue !== null)) {
    throw new Error("Candidate BTC balance snapshot has invalid exact evidence.");
  }
  return Object.freeze({
    id: requiredString(fields.id, "candidate BTC balance snapshot id"),
    exchangeAccountId: request.exchangeAccountId,
    capturedAt: request.requestedAt,
    source: "RECONCILIATION",
    totalKrwValue: fields.totalKrwValue,
    balancesJson: requiredString(fields.balancesJson, "candidate BTC balance snapshot balancesJson"),
  });
}

function snapshotPositionSnapshot(value: unknown, request: Readonly<{ exchangeAccountId: string; requestedAt: string }>): PositionSnapshotRecord {
  const fields = exactDataRecord(value, "candidate BTC position snapshot", [
    "id", "exchangeAccountId", "capturedAt", "source", "positionsJson",
  ]);
  assertSnapshotCorrelation(fields, request, "position snapshot");
  if (fields.source !== "RECONCILIATION") throw new Error("Candidate BTC position snapshot has invalid exact evidence.");
  return Object.freeze({
    id: requiredString(fields.id, "candidate BTC position snapshot id"),
    exchangeAccountId: request.exchangeAccountId,
    capturedAt: request.requestedAt,
    source: "RECONCILIATION",
    positionsJson: requiredString(fields.positionsJson, "candidate BTC position snapshot positionsJson"),
  });
}

function snapshotReconciliationRun(value: unknown, request: Readonly<{ exchangeAccountId: string; requestedAt: string }>): ReconciliationRunRecord {
  const fields = exactDataRecord(value, "candidate BTC reconciliation run", [
    "id", "exchangeAccountId", "status", "startedAt", "completedAt", "summaryJson", "errorMessage",
  ]);
  if (fields.exchangeAccountId !== request.exchangeAccountId) {
    throw new Error("Candidate BTC reconciliation run exchangeAccountId must match the request.");
  }
  if (requiredTimestamp(fields.startedAt, "candidate BTC reconciliation run startedAt") !== request.requestedAt) {
    throw new Error("Candidate BTC reconciliation run startedAt must match the request.");
  }
  const completedAt = requiredTimestamp(fields.completedAt, "candidate BTC reconciliation run completedAt");
  if ((fields.status !== "SUCCESS" && fields.status !== "DRIFT_DETECTED") || fields.errorMessage !== null) {
    throw new Error("Candidate BTC reconciliation run must be a successful or non-blocking drift exact record.");
  }
  const summary = parseReconciliationSummary(fields.summaryJson);
  if (summary.source !== "SCHEDULER_PREFLIGHT" || summary.status !== fields.status) {
    throw new Error("Candidate BTC reconciliation run summary source or status does not match the exact record.");
  }
  return Object.freeze({
    id: requiredString(fields.id, "candidate BTC reconciliation run id"),
    exchangeAccountId: request.exchangeAccountId,
    status: fields.status,
    startedAt: request.requestedAt,
    completedAt,
    summaryJson: requiredString(fields.summaryJson, "candidate BTC reconciliation run summaryJson"),
    errorMessage: null,
  });
}

function snapshotExecutionState(value: ExecutionStateRecord, exchangeAccountId: string): ExecutionStateRecord {
  const fields = exactDataRecord(value, "candidate BTC execution state", [
    "id", "exchangeAccountId", "executionMode", "liveExecutionGate", "systemStatus", "killSwitchActive",
    "pauseReason", "degradedReason", "degradedAt", "updatedAt",
  ]);
  const stateExchangeAccountId = requiredString(fields.exchangeAccountId, "candidate BTC execution state exchangeAccountId");
  if (stateExchangeAccountId !== exchangeAccountId) {
    throw new Error("Candidate BTC execution state exchangeAccountId must match the request.");
  }
  return Object.freeze({
    id: requiredString(fields.id, "candidate BTC execution state id"),
    exchangeAccountId: stateExchangeAccountId,
    executionMode: fields.executionMode as ExecutionStateRecord["executionMode"],
    liveExecutionGate: fields.liveExecutionGate as ExecutionStateRecord["liveExecutionGate"],
    systemStatus: fields.systemStatus as ExecutionStateRecord["systemStatus"],
    killSwitchActive: fields.killSwitchActive as boolean,
    pauseReason: fields.pauseReason as string | null,
    degradedReason: fields.degradedReason as string | null,
    degradedAt: fields.degradedAt as string | null,
    updatedAt: requiredTimestamp(fields.updatedAt, "candidate BTC execution state updatedAt"),
  });
}

function snapshotActiveOrders(value: readonly OrderRecord[]): readonly OrderRecord[] {
  if (!Array.isArray(value)) throw new Error("Candidate BTC active orders must be an array.");
  return Object.freeze(value.slice());
}

function assertSnapshotCorrelation(
  fields: Record<string, unknown>,
  request: Readonly<{ exchangeAccountId: string; requestedAt: string }>,
  label: string,
): void {
  if (fields.exchangeAccountId !== request.exchangeAccountId) {
    throw new Error(`Candidate BTC ${label} exchangeAccountId must match the request.`);
  }
  if (requiredTimestamp(fields.capturedAt, `candidate BTC ${label} capturedAt`) !== request.requestedAt) {
    throw new Error(`Candidate BTC ${label} capturedAt must match the request.`);
  }
}

function parseReconciliationSummary(value: unknown): Readonly<{ source: string; status: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredString(value, "candidate BTC reconciliation run summaryJson"));
  } catch {
    throw new Error("Candidate BTC reconciliation run summaryJson must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("Candidate BTC reconciliation summary must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  const fields = Object.freeze({
    source: requiredSummaryDataProperty(descriptors, "source"),
    status: requiredSummaryDataProperty(descriptors, "status"),
  });
  return Object.freeze({
    source: fields.source,
    status: fields.status,
  });
}

function requiredSummaryDataProperty(descriptors: PropertyDescriptorMap, key: string): string {
  const descriptor = descriptors[key];
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new Error(`Candidate BTC reconciliation summary ${key} must be an enumerable data property.`);
  }
  return requiredString(descriptor.value, `candidate BTC reconciliation summary ${key}`);
}

function exactDataRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  const expectedKeys = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw new Error(`${label} has an invalid key set.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} ${key} must be an enumerable data property.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  parseCandidatePilotTimestamp(timestamp, label);
  return timestamp;
}
