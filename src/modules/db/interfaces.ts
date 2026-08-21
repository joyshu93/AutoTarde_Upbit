import type {
  BalanceSnapshotRecord,
  ClaimedOperatorNotificationRecord,
  ExecutionMode,
  HistoryRecoveryCheckpointRecord,
  HistoryRecoveryCheckpointType,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
  OperatorNotificationDeliveryTransition,
  OperatorNotificationRecord,
  ExecutionStateSeed,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  FillRecord,
  LiveExecutionGate,
  OrderEventRecord,
  OrderRecord,
  PortfolioExposureSnapshot,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  RiskEventRecord,
  StrategyDecisionRecord,
  StrategySchedulerRunRecord,
  SupportedMarket,
  TelegramInboundOffsetRecord,
} from "../../domain/types.js";
import type { OrderSubmissionRecoveryObservationRecord } from "../../domain/pilot-types.js";

export interface PersistOrderIntentInput {
  order: OrderRecord;
  event: OrderEventRecord;
}

export interface PersistExchangeSubmissionInput {
  order: OrderRecord;
  event: OrderEventRecord;
  fills: FillRecord[];
  terminalEvent?: OrderEventRecord;
}

export interface PersistUncertainSubmissionInput {
  order: OrderRecord;
  event: OrderEventRecord;
  riskEvent: RiskEventRecord;
}

export interface FaultPauseInput {
  exchangeAccountId: string;
  faultId: string;
  reason: string;
  occurredAt: string;
}

export interface FinalizeBoundedSubmissionAbsenceInput {
  orderId: string;
  expectedStatus: Extract<OrderRecord["status"], "SUBMITTING" | "RECONCILIATION_REQUIRED" | "FAILED" | "REJECTED">;
  expectedUpdatedAt: string;
  failedAt: string;
  failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED";
  failureMessage: string;
  event: OrderEventRecord;
  faultPause: FaultPauseInput;
}

export interface ExecutionRepository {
  saveStrategyDecision(record: StrategyDecisionRecord): Promise<void>;
  getLatestStrategyDecision(
    exchangeAccountId: string,
    market: SupportedMarket,
    strategyKey?: string,
  ): Promise<StrategyDecisionRecord | null>;
  getStrategyDecisionById?(id: string): Promise<StrategyDecisionRecord | null>;
  saveOrder(record: OrderRecord): Promise<void>;
  updateOrder(record: OrderRecord): Promise<void>;
  persistOrderIntent(input: PersistOrderIntentInput): Promise<void>;
  persistExchangeSubmission(input: PersistExchangeSubmissionInput): Promise<void>;
  persistUncertainSubmission(input: PersistUncertainSubmissionInput): Promise<void>;
  findOrderByIdempotencyKey(exchangeAccountId: string, idempotencyKey: string): Promise<OrderRecord | null>;
  findOrderByReference(exchangeAccountId: string, reference: string): Promise<OrderRecord | null>;
  listActiveOrders(exchangeAccountId: string, market?: SupportedMarket, limit?: number): Promise<OrderRecord[]>;
  listOrders(exchangeAccountId: string): Promise<OrderRecord[]>;
  appendOrderEvent(record: OrderEventRecord): Promise<void>;
  listOrderEvents(orderId: string): Promise<OrderEventRecord[]>;
  saveFill(record: FillRecord): Promise<void>;
  listFills(orderId?: string): Promise<FillRecord[]>;
  saveOrderSubmissionRecoveryObservation?(
    record: OrderSubmissionRecoveryObservationRecord,
  ): Promise<void>;
  listOrderSubmissionRecoveryObservations?(
    orderId: string,
  ): Promise<OrderSubmissionRecoveryObservationRecord[]>;
  finalizeBoundedSubmissionAbsence?(
    input: FinalizeBoundedSubmissionAbsenceInput,
  ): Promise<boolean>;
  saveBalanceSnapshot(record: BalanceSnapshotRecord): Promise<void>;
  getLatestBalanceSnapshot(exchangeAccountId: string): Promise<BalanceSnapshotRecord | null>;
  savePositionSnapshot(record: PositionSnapshotRecord): Promise<void>;
  getLatestPositionSnapshot(exchangeAccountId: string): Promise<PositionSnapshotRecord | null>;
  getPortfolioExposure(exchangeAccountId: string): Promise<PortfolioExposureSnapshot>;
  saveRiskEvent(record: RiskEventRecord): Promise<void>;
  listRiskEvents(exchangeAccountId: string, limit?: number): Promise<RiskEventRecord[]>;
  saveReconciliationRun(record: ReconciliationRunRecord): Promise<void>;
  updateReconciliationRun(record: ReconciliationRunRecord): Promise<void>;
  listReconciliationRuns(exchangeAccountId: string, limit?: number): Promise<ReconciliationRunRecord[]>;
  saveStrategySchedulerRun(record: StrategySchedulerRunRecord): Promise<void>;
  updateStrategySchedulerRun(record: StrategySchedulerRunRecord): Promise<void>;
  listStrategySchedulerRuns(exchangeAccountId: string, limit?: number): Promise<StrategySchedulerRunRecord[]>;
  saveHistoryRecoveryCheckpoint(record: HistoryRecoveryCheckpointRecord): Promise<void>;
  listHistoryRecoveryCheckpoints(exchangeAccountId: string): Promise<HistoryRecoveryCheckpointRecord[]>;
  getHistoryRecoveryCheckpoint(
    exchangeAccountId: string,
    market: SupportedMarket,
    checkpointType: HistoryRecoveryCheckpointType,
  ): Promise<HistoryRecoveryCheckpointRecord | null>;
  saveOperatorNotification(record: OperatorNotificationRecord): Promise<void>;
  saveOperatorNotificationDeliveryAttempt(record: OperatorNotificationDeliveryAttemptRecord): Promise<void>;
  saveOperatorNotificationDeliveryRun(record: OperatorNotificationDeliveryRunRecord): Promise<void>;
  claimPendingOperatorNotifications(
    exchangeAccountId: string,
    input: {
      limit?: number;
      dueBefore?: string;
      claimedAt: string;
      leaseToken: string;
      leaseExpiresAt: string;
    },
  ): Promise<ClaimedOperatorNotificationRecord[]>;
  compareAndSetOperatorNotificationDeliveryStatus(
    transition: OperatorNotificationDeliveryTransition,
  ): Promise<boolean>;
  listOperatorNotifications(exchangeAccountId: string, limit?: number): Promise<OperatorNotificationRecord[]>;
  listOperatorNotificationDeliveryAttempts(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryAttemptRecord[]>;
  listOperatorNotificationDeliveryRuns(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryRunRecord[]>;
  listPendingOperatorNotifications(
    exchangeAccountId: string,
    options?: {
      limit?: number;
      dueBefore?: string;
    },
  ): Promise<OperatorNotificationRecord[]>;
}

export interface OperatorStateStore {
  getState(): Promise<ExecutionStateRecord>;
  listTransitions(limit?: number): Promise<ExecutionStateTransitionRecord[]>;
  pauseForFault(input: FaultPauseInput): Promise<ExecutionStateRecord>;
  pause(reason?: string): Promise<ExecutionStateRecord>;
  resume(): Promise<ExecutionStateRecord>;
  activateKillSwitch(reason?: string): Promise<ExecutionStateRecord>;
  setExecutionMode(mode: ExecutionMode): Promise<ExecutionStateRecord>;
  setLiveExecutionGate(gate: LiveExecutionGate): Promise<ExecutionStateRecord>;
  markDegraded(reason?: string): Promise<ExecutionStateRecord>;
  clearDegraded(reason?: string): Promise<ExecutionStateRecord>;
}

export interface TelegramInboundOffsetStore {
  getTelegramInboundOffset(input: {
    exchangeAccountId: string;
    updateSource: TelegramInboundOffsetRecord["updateSource"];
    botTokenRef: string;
  }): Promise<TelegramInboundOffsetRecord | null>;
  saveTelegramInboundOffset(record: TelegramInboundOffsetRecord): Promise<void>;
}

export function detectExecutionStateSeedMismatches(
  state: ExecutionStateRecord,
  seed: ExecutionStateSeed,
): string[] {
  const mismatches: string[] = [];

  if (state.executionMode !== seed.executionMode) {
    mismatches.push("execution_mode");
  }

  if (state.liveExecutionGate !== seed.liveExecutionGate) {
    mismatches.push("live_execution_gate");
  }

  if (state.killSwitchActive !== seed.killSwitchActive) {
    mismatches.push("kill_switch");
  }

  return mismatches;
}
