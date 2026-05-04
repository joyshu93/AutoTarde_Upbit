import type {
  BalanceSnapshotRecord,
  ClaimedOperatorNotificationRecord,
  ExecutionMode,
  HistoryRecoveryCheckpointRecord,
  HistoryRecoveryCheckpointType,
  OperatorNotificationDeliveryAttemptRecord,
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
  SupportedMarket,
} from "../../domain/types.js";

export interface ExecutionRepository {
  saveStrategyDecision(record: StrategyDecisionRecord): Promise<void>;
  saveOrder(record: OrderRecord): Promise<void>;
  updateOrder(record: OrderRecord): Promise<void>;
  findOrderByIdempotencyKey(exchangeAccountId: string, idempotencyKey: string): Promise<OrderRecord | null>;
  listActiveOrders(exchangeAccountId: string, market?: SupportedMarket): Promise<OrderRecord[]>;
  listOrders(exchangeAccountId: string): Promise<OrderRecord[]>;
  appendOrderEvent(record: OrderEventRecord): Promise<void>;
  saveFill(record: FillRecord): Promise<void>;
  listFills(orderId?: string): Promise<FillRecord[]>;
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
  saveHistoryRecoveryCheckpoint(record: HistoryRecoveryCheckpointRecord): Promise<void>;
  listHistoryRecoveryCheckpoints(exchangeAccountId: string): Promise<HistoryRecoveryCheckpointRecord[]>;
  getHistoryRecoveryCheckpoint(
    exchangeAccountId: string,
    market: SupportedMarket,
    checkpointType: HistoryRecoveryCheckpointType,
  ): Promise<HistoryRecoveryCheckpointRecord | null>;
  saveOperatorNotification(record: OperatorNotificationRecord): Promise<void>;
  saveOperatorNotificationDeliveryAttempt(record: OperatorNotificationDeliveryAttemptRecord): Promise<void>;
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
  pause(reason?: string): Promise<ExecutionStateRecord>;
  resume(): Promise<ExecutionStateRecord>;
  activateKillSwitch(reason?: string): Promise<ExecutionStateRecord>;
  setExecutionMode(mode: ExecutionMode): Promise<ExecutionStateRecord>;
  setLiveExecutionGate(gate: LiveExecutionGate): Promise<ExecutionStateRecord>;
  markDegraded(reason?: string): Promise<ExecutionStateRecord>;
  clearDegraded(reason?: string): Promise<ExecutionStateRecord>;
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
