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

const RECONCILIATION_ISSUE_CODES = new Set([
  "OPEN_ORDER_NEEDS_REVIEW",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_STATUS_RECONCILED",
  "ORDER_FILLS_BACKFILLED",
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "TERMINAL_ORDER_RECHECKED",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_IDENTIFIER_RECOVERY_UNCERTAIN",
  "ORDER_IDENTIFIER_RECOVERED",
  "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
  "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
  "CANDIDATE_EVIDENCE_PROJECTION_DEFERRED",
  "EXCHANGE_ORDER_RECOVERED",
  "ORDER_HISTORY_LOOKUP_FAILED",
  "DRY_RUN_ORDER_REPAIRED",
]);

type CandidateReconciliationSummary = Readonly<{
  source: "SCHEDULER_PREFLIGHT";
  status: "SUCCESS" | "DRIFT_DETECTED";
  canonicalJson: string;
}>;

interface JsonSnapshotRecord {
  readonly [key: string]: JsonSnapshot;
}

type JsonSnapshot = null | boolean | number | string | readonly JsonSnapshot[] | JsonSnapshotRecord;

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
  const reconciliationSummary = snapshotReconciliationSummary(
    result.reconciliationSummary,
    "candidate BTC portfolio sync reconciliationSummary",
  );
  const reconciliationRun = snapshotReconciliationRun(result.reconciliationRun, request, reconciliationSummary);
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

function snapshotReconciliationRun(
  value: unknown,
  request: Readonly<{ exchangeAccountId: string; requestedAt: string }>,
  reconciliationSummary: CandidateReconciliationSummary,
): ReconciliationRunRecord {
  const fields = exactDataRecord(value, "candidate BTC reconciliation run", [
    "id", "exchangeAccountId", "status", "startedAt", "completedAt", "summaryJson", "errorMessage",
  ]);
  if (fields.exchangeAccountId !== request.exchangeAccountId) {
    throw new Error("Candidate BTC reconciliation run exchangeAccountId must match the request.");
  }
  const startedAt = requiredTimestamp(fields.startedAt, "candidate BTC reconciliation run startedAt");
  const startedAtEpoch = parseCandidatePilotTimestamp(startedAt, "candidate BTC reconciliation run startedAt");
  const requestedAtEpoch = parseCandidatePilotTimestamp(request.requestedAt, "candidate BTC preparation requestedAt");
  if (startedAt !== request.requestedAt || startedAtEpoch !== requestedAtEpoch) {
    throw new Error("Candidate BTC reconciliation run startedAt must match the request.");
  }
  const completedAt = requiredTimestamp(fields.completedAt, "candidate BTC reconciliation run completedAt");
  if (parseCandidatePilotTimestamp(completedAt, "candidate BTC reconciliation run completedAt") < startedAtEpoch) {
    throw new Error("Candidate BTC reconciliation run completedAt must not precede its exact startedAt.");
  }
  if ((fields.status !== "SUCCESS" && fields.status !== "DRIFT_DETECTED") || fields.errorMessage !== null) {
    throw new Error("Candidate BTC reconciliation run must be a successful or non-blocking drift exact record.");
  }
  const persistedSummary = snapshotReconciliationSummaryJson(fields.summaryJson);
  if (
    reconciliationSummary.source !== "SCHEDULER_PREFLIGHT" ||
    reconciliationSummary.status !== fields.status ||
    persistedSummary.source !== reconciliationSummary.source ||
    persistedSummary.status !== reconciliationSummary.status
  ) {
    throw new Error("Candidate BTC reconciliation run summary source or status does not match the exact record.");
  }
  if (persistedSummary.canonicalJson !== reconciliationSummary.canonicalJson) {
    throw new Error("Candidate BTC reconciliation summary evidence must match the persisted reconciliation run.");
  }
  return Object.freeze({
    id: requiredString(fields.id, "candidate BTC reconciliation run id"),
    exchangeAccountId: request.exchangeAccountId,
    status: fields.status,
    startedAt,
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
  const executionMode = requiredEnum(fields.executionMode, "candidate BTC execution state executionMode", ["DRY_RUN", "LIVE"]);
  const liveExecutionGate = requiredEnum(fields.liveExecutionGate, "candidate BTC execution state liveExecutionGate", ["DISABLED", "ENABLED"]);
  const systemStatus = requiredEnum(fields.systemStatus, "candidate BTC execution state systemStatus", ["BOOTING", "RUNNING", "PAUSED", "KILL_SWITCHED", "DEGRADED"]);
  const killSwitchActive = requiredBoolean(fields.killSwitchActive, "candidate BTC execution state killSwitchActive");
  const pauseReason = requiredNullableString(fields.pauseReason, "candidate BTC execution state pauseReason");
  const degradedReason = requiredNullableString(fields.degradedReason, "candidate BTC execution state degradedReason");
  const degradedAt = requiredNullableTimestamp(fields.degradedAt, "candidate BTC execution state degradedAt");
  if (systemStatus === "RUNNING" && (pauseReason !== null || degradedReason !== null || degradedAt !== null)) {
    throw new Error("Candidate BTC execution state RUNNING state must not carry pause or degraded authority.");
  }
  return Object.freeze({
    id: requiredString(fields.id, "candidate BTC execution state id"),
    exchangeAccountId: stateExchangeAccountId,
    executionMode,
    liveExecutionGate,
    systemStatus,
    killSwitchActive,
    pauseReason,
    degradedReason,
    degradedAt,
    updatedAt: requiredTimestamp(fields.updatedAt, "candidate BTC execution state updatedAt"),
  });
}

function snapshotActiveOrders(value: readonly OrderRecord[]): readonly OrderRecord[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Candidate BTC active orders must be a plain dense data array.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    Reflect.ownKeys(value).length !== value.length + 1 ||
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== value.length
  ) {
    throw new Error("Candidate BTC active orders must be a plain dense data array.");
  }
  const snapshot: OrderRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error("Candidate BTC active orders must be a plain dense data array.");
    }
    snapshot[index] = descriptor.value as OrderRecord;
  }
  return Object.freeze(snapshot);
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

function snapshotReconciliationSummaryJson(value: unknown): CandidateReconciliationSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredString(value, "candidate BTC reconciliation run summaryJson"));
  } catch {
    throw new Error("Candidate BTC reconciliation run summaryJson must be valid JSON.");
  }
  return snapshotReconciliationSummary(parsed, "candidate BTC reconciliation run persisted summary");
}

function snapshotReconciliationSummary(value: unknown, label: string): CandidateReconciliationSummary {
  const fields = dataRecordWithOptionalKey(value, label, [
    "source", "status", "issues", "candidateCount", "processedCount", "deferredCount", "maxOrderLookupsPerRun",
  ], "historyRecovery");
  const source = requiredEnum(fields.source, `${label} source`, ["SCHEDULER_PREFLIGHT"]);
  const status = requiredEnum(fields.status, `${label} status`, ["SUCCESS", "DRIFT_DETECTED"]);
  const issues = snapshotReconciliationIssues(fields.issues, `${label} issues`);
  const snapshot: Record<string, JsonSnapshot> = {
    source,
    status,
    issues,
    candidateCount: requiredNonNegativeSafeInteger(fields.candidateCount, `${label} candidateCount`),
    processedCount: requiredNonNegativeSafeInteger(fields.processedCount, `${label} processedCount`),
    deferredCount: requiredNonNegativeSafeInteger(fields.deferredCount, `${label} deferredCount`),
    maxOrderLookupsPerRun: requiredNonNegativeSafeInteger(fields.maxOrderLookupsPerRun, `${label} maxOrderLookupsPerRun`),
  };
  if (Object.prototype.hasOwnProperty.call(fields, "historyRecovery")) {
    snapshot.historyRecovery = snapshotJsonValue(fields.historyRecovery, `${label} historyRecovery`);
  }
  return Object.freeze({
    source,
    status,
    canonicalJson: canonicalizeJsonSnapshot(Object.freeze(snapshot)),
  });
}

function snapshotReconciliationIssues(value: unknown, label: string): readonly JsonSnapshot[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    Reflect.ownKeys(value).length !== value.length + 1 ||
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== value.length
  ) {
    throw new Error(`${label} must be a dense data array.`);
  }
  const issues: JsonSnapshot[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} ${index} must be an enumerable data property.`);
    }
    const issue = exactDataRecord(descriptor.value, `${label} ${index}`, ["code", "message"]);
    const code = requiredEnum(issue.code, `${label} ${index} code`, [...RECONCILIATION_ISSUE_CODES]);
    const message = requiredString(issue.message, `${label} ${index} message`);
    issues.push(Object.freeze({ code, message }));
  }
  return Object.freeze(issues);
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

function dataRecordWithOptionalKey(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
  optionalKey: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  const allowedKeys = new Set([...requiredKeys, optionalKey]);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length < requiredKeys.length ||
    ownKeys.length > requiredKeys.length + 1 ||
    ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
  ) {
    throw new Error(`${label} has an invalid key set.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of requiredKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} ${key} must be an enumerable data property.`);
    }
    snapshot[key] = descriptor.value;
  }
  const optionalDescriptor = descriptors[optionalKey];
  if (optionalDescriptor !== undefined) {
    if (optionalDescriptor.enumerable !== true || !("value" in optionalDescriptor)) {
      throw new Error(`${label} ${optionalKey} must be an enumerable data property.`);
    }
    snapshot[optionalKey] = optionalDescriptor.value;
  }
  return snapshot;
}

function snapshotJsonValue(value: unknown, label: string): JsonSnapshot {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must be a plain array.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      Reflect.ownKeys(value).length !== value.length + 1 ||
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.value !== value.length
    ) {
      throw new Error(`${label} must be a dense data array.`);
    }
    const snapshot: JsonSnapshot[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new Error(`${label} ${index} must be an enumerable data property.`);
      }
      snapshot.push(snapshotJsonValue(descriptor.value, `${label} ${index}`));
    }
    return Object.freeze(snapshot);
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be JSON-compatible plain data.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, JsonSnapshot>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys.`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} ${key} must be an enumerable data property.`);
    }
    snapshot[key] = snapshotJsonValue(descriptor.value, `${label} ${key}`);
  }
  return Object.freeze(snapshot);
}

function canonicalizeJsonSnapshot(value: JsonSnapshot): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonSnapshot).join(",")}]`;
  }
  const record = value as JsonSnapshotRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJsonSnapshot(record[key] as JsonSnapshot)}`).join(",")}}`;
}

function requiredEnum<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} is unsupported.`);
  }
  return value as Values[number];
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requiredNullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function requiredNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : requiredTimestamp(value, label);
}

function requiredNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
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
