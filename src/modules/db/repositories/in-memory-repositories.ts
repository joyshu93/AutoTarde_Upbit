import type {
  BalanceSnapshotRecord,
  ClaimedOperatorNotificationRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryTransition,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  FillRecord,
  HistoryRecoveryCheckpointRecord,
  OperatorNotificationRecord,
  OrderEventRecord,
  OrderLifecycleStatus,
  OrderRecord,
  PortfolioExposureSnapshot,
  PositionSnapshot,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  RiskEventRecord,
  StrategyDecisionRecord,
  SupportedAsset,
  SupportedMarket,
} from "../../../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../interfaces.js";

const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderLifecycleStatus> = new Set([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly strategyDecisions: StrategyDecisionRecord[] = [];
  private readonly orders: OrderRecord[] = [];
  private readonly orderEvents: OrderEventRecord[] = [];
  private readonly fills: FillRecord[] = [];
  private readonly balanceSnapshots: BalanceSnapshotRecord[] = [];
  private readonly positionSnapshots: PositionSnapshotRecord[] = [];
  private readonly riskEvents: RiskEventRecord[] = [];
  private readonly reconciliationRuns: ReconciliationRunRecord[] = [];
  private readonly historyRecoveryCheckpoints: HistoryRecoveryCheckpointRecord[] = [];
  private readonly operatorNotifications: OperatorNotificationRecord[] = [];
  private readonly operatorNotificationDeliveryAttempts: OperatorNotificationDeliveryAttemptRecord[] = [];

  async saveStrategyDecision(record: StrategyDecisionRecord): Promise<void> {
    this.strategyDecisions.push(record);
  }

  async saveOrder(record: OrderRecord): Promise<void> {
    this.orders.push(record);
  }

  async updateOrder(record: OrderRecord): Promise<void> {
    const index = this.orders.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.orders.push(record);
      return;
    }

    this.orders[index] = record;
  }

  async findOrderByIdempotencyKey(exchangeAccountId: string, idempotencyKey: string): Promise<OrderRecord | null> {
    return this.orders.find(
      (candidate) =>
        candidate.exchangeAccountId === exchangeAccountId && candidate.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async listActiveOrders(exchangeAccountId: string, market?: SupportedMarket): Promise<OrderRecord[]> {
    return this.orders.filter((candidate) => {
      if (candidate.exchangeAccountId !== exchangeAccountId) {
        return false;
      }
      if (market && candidate.market !== market) {
        return false;
      }
      return ACTIVE_ORDER_STATUSES.has(candidate.status);
    });
  }

  async listOrders(exchangeAccountId: string): Promise<OrderRecord[]> {
    return this.orders.filter((candidate) => candidate.exchangeAccountId === exchangeAccountId);
  }

  async appendOrderEvent(record: OrderEventRecord): Promise<void> {
    this.orderEvents.push(record);
  }

  async saveFill(record: FillRecord): Promise<void> {
    const index = this.fills.findIndex(
      (candidate) => candidate.orderId === record.orderId && candidate.exchangeFillId === record.exchangeFillId,
    );
    if (index === -1) {
      this.fills.push(record);
      return;
    }

    this.fills[index] = record;
  }

  async listFills(orderId?: string): Promise<FillRecord[]> {
    if (!orderId) {
      return [...this.fills];
    }

    return this.fills.filter((candidate) => candidate.orderId === orderId);
  }

  async saveBalanceSnapshot(record: BalanceSnapshotRecord): Promise<void> {
    this.balanceSnapshots.push(record);
  }

  async getLatestBalanceSnapshot(exchangeAccountId: string): Promise<BalanceSnapshotRecord | null> {
    return (
      [...this.balanceSnapshots]
        .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? null
    );
  }

  async savePositionSnapshot(record: PositionSnapshotRecord): Promise<void> {
    this.positionSnapshots.push(record);
  }

  async getLatestPositionSnapshot(exchangeAccountId: string): Promise<PositionSnapshotRecord | null> {
    return (
      [...this.positionSnapshots]
        .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? null
    );
  }

  async getPortfolioExposure(exchangeAccountId: string): Promise<PortfolioExposureSnapshot> {
    const latestBalance = await this.getLatestBalanceSnapshot(exchangeAccountId);
    const latestPositions = await this.getLatestPositionSnapshot(exchangeAccountId);

    const totalEquityKrw = Number(latestBalance?.totalKrwValue ?? "0");
    const positions = parsePositionSnapshotJson(latestPositions?.positionsJson);
    const assetExposureKrw = aggregateAssetExposure(positions);
    const totalExposureKrw = Object.values(assetExposureKrw).reduce((sum, value) => sum + value, 0);

    return {
      totalEquityKrw,
      totalExposureKrw,
      assetExposureKrw,
    };
  }

  async saveRiskEvent(record: RiskEventRecord): Promise<void> {
    this.riskEvents.push(record);
  }

  async listRiskEvents(exchangeAccountId: string, limit?: number): Promise<RiskEventRecord[]> {
    const events = this.riskEvents
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return typeof limit === "number" ? events.slice(0, limit) : events;
  }

  async saveReconciliationRun(record: ReconciliationRunRecord): Promise<void> {
    this.reconciliationRuns.push(record);
  }

  async updateReconciliationRun(record: ReconciliationRunRecord): Promise<void> {
    const index = this.reconciliationRuns.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.reconciliationRuns.push(record);
      return;
    }

    this.reconciliationRuns[index] = record;
  }

  async listReconciliationRuns(exchangeAccountId: string, limit?: number): Promise<ReconciliationRunRecord[]> {
    const runs = this.reconciliationRuns
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return typeof limit === "number" ? runs.slice(0, limit) : runs;
  }

  async saveHistoryRecoveryCheckpoint(record: HistoryRecoveryCheckpointRecord): Promise<void> {
    const index = this.historyRecoveryCheckpoints.findIndex(
      (candidate) =>
        candidate.exchangeAccountId === record.exchangeAccountId &&
        candidate.market === record.market &&
        candidate.checkpointType === record.checkpointType,
    );
    if (index === -1) {
      this.historyRecoveryCheckpoints.push(record);
      return;
    }

    this.historyRecoveryCheckpoints[index] = record;
  }

  async listHistoryRecoveryCheckpoints(exchangeAccountId: string): Promise<HistoryRecoveryCheckpointRecord[]> {
    return this.historyRecoveryCheckpoints
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => left.market.localeCompare(right.market) || left.checkpointType.localeCompare(right.checkpointType));
  }

  async getHistoryRecoveryCheckpoint(
    exchangeAccountId: string,
    market: SupportedMarket,
    checkpointType: HistoryRecoveryCheckpointRecord["checkpointType"],
  ): Promise<HistoryRecoveryCheckpointRecord | null> {
    return this.historyRecoveryCheckpoints.find(
      (candidate) =>
        candidate.exchangeAccountId === exchangeAccountId &&
        candidate.market === market &&
        candidate.checkpointType === checkpointType,
    ) ?? null;
  }

  async saveOperatorNotification(record: OperatorNotificationRecord): Promise<void> {
    const index = this.operatorNotifications.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.operatorNotifications.push(record);
      return;
    }

    this.operatorNotifications[index] = record;
  }

  async saveOperatorNotificationDeliveryAttempt(
    record: OperatorNotificationDeliveryAttemptRecord,
  ): Promise<void> {
    const index = this.operatorNotificationDeliveryAttempts.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.operatorNotificationDeliveryAttempts.push(record);
      return;
    }

    this.operatorNotificationDeliveryAttempts[index] = record;
  }

  async claimPendingOperatorNotifications(
    exchangeAccountId: string,
    input: {
      limit?: number;
      dueBefore?: string;
      claimedAt: string;
      leaseToken: string;
      leaseExpiresAt: string;
    },
  ): Promise<ClaimedOperatorNotificationRecord[]> {
    const dueBefore = input.dueBefore ?? null;
    const candidates = this.operatorNotifications
      .filter(
        (candidate) =>
          candidate.exchangeAccountId === exchangeAccountId &&
          candidate.deliveryStatus === "PENDING" &&
          (dueBefore === null ||
            candidate.nextAttemptAt === null ||
            candidate.nextAttemptAt.localeCompare(dueBefore) <= 0) &&
          (candidate.leaseExpiresAt === null || dueBefore === null || candidate.leaseExpiresAt.localeCompare(dueBefore) <= 0),
      )
      .sort((left, right) => {
        const leftDueAt = left.nextAttemptAt ?? left.createdAt;
        const rightDueAt = right.nextAttemptAt ?? right.createdAt;
        return leftDueAt.localeCompare(rightDueAt) || left.createdAt.localeCompare(right.createdAt);
      });

    const selected = typeof input.limit === "number" ? candidates.slice(0, input.limit) : candidates;

    return selected.map((candidate) => {
      const index = this.operatorNotifications.findIndex((record) => record.id === candidate.id);
      if (index === -1) {
        throw new Error(`Operator notification ${candidate.id} is missing.`);
      }

      const claimedRecord: ClaimedOperatorNotificationRecord = {
        ...candidate,
        attemptCount: candidate.attemptCount + 1,
        lastAttemptAt: input.claimedAt,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      this.operatorNotifications[index] = claimedRecord;
      return claimedRecord;
    });
  }

  async compareAndSetOperatorNotificationDeliveryStatus(
    transition: OperatorNotificationDeliveryTransition,
  ): Promise<boolean> {
    const index = this.operatorNotifications.findIndex((candidate) => candidate.id === transition.id);
    if (index === -1) {
      return false;
    }

    const current = this.operatorNotifications[index];
    if (!current) {
      return false;
    }

    if (current.leaseToken !== transition.leaseToken) {
      return false;
    }

    const updatedRecord: OperatorNotificationRecord = {
      ...current,
      deliveryStatus: transition.deliveryStatus,
      attemptCount: transition.attemptCount,
      lastAttemptAt: transition.lastAttemptAt,
      nextAttemptAt: transition.nextAttemptAt,
      failureClass: transition.failureClass,
      leaseToken: null,
      leaseExpiresAt: null,
      deliveredAt: transition.deliveredAt,
      lastError: transition.lastError,
    };
    this.operatorNotifications[index] = updatedRecord;
    return true;
  }

  async listOperatorNotifications(exchangeAccountId: string, limit?: number): Promise<OperatorNotificationRecord[]> {
    const notifications = this.operatorNotifications
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return typeof limit === "number" ? notifications.slice(0, limit) : notifications;
  }

  async listOperatorNotificationDeliveryAttempts(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryAttemptRecord[]> {
    const attempts = this.operatorNotificationDeliveryAttempts
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => right.attemptedAt.localeCompare(left.attemptedAt));

    return typeof limit === "number" ? attempts.slice(0, limit) : attempts;
  }

  async listPendingOperatorNotifications(
    exchangeAccountId: string,
    options?: {
      limit?: number;
      dueBefore?: string;
    },
  ): Promise<OperatorNotificationRecord[]> {
    const dueBefore = options?.dueBefore ?? null;
    const notifications = this.operatorNotifications
      .filter(
        (candidate) =>
          candidate.exchangeAccountId === exchangeAccountId &&
          candidate.deliveryStatus === "PENDING" &&
          (dueBefore === null ||
            candidate.nextAttemptAt === null ||
            candidate.nextAttemptAt.localeCompare(dueBefore) <= 0),
      )
      .sort((left, right) => {
        const leftDueAt = left.nextAttemptAt ?? left.createdAt;
        const rightDueAt = right.nextAttemptAt ?? right.createdAt;
        return leftDueAt.localeCompare(rightDueAt) || left.createdAt.localeCompare(right.createdAt);
      });

    return typeof options?.limit === "number" ? notifications.slice(0, options.limit) : notifications;
  }
}

export class InMemoryOperatorStateStore implements OperatorStateStore {
  private readonly transitions: ExecutionStateTransitionRecord[] = [];

  constructor(private state: ExecutionStateRecord) {
    this.transitions.push({
      id: "execution_state_transition_bootstrap",
      exchangeAccountId: state.exchangeAccountId,
      command: "BOOTSTRAP",
      fromExecutionMode: null,
      toExecutionMode: state.executionMode,
      fromLiveExecutionGate: null,
      toLiveExecutionGate: state.liveExecutionGate,
      fromSystemStatus: null,
      toSystemStatus: state.systemStatus,
      fromKillSwitchActive: null,
      toKillSwitchActive: state.killSwitchActive,
      reason: "bootstrap_seed",
      createdAt: state.updatedAt,
    });
  }

  async getState(): Promise<ExecutionStateRecord> {
    return { ...this.state };
  }

  async listTransitions(limit = 20): Promise<ExecutionStateTransitionRecord[]> {
    return this.transitions.slice(0, limit).map((record) => ({ ...record }));
  }

  async pause(reason?: string): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    this.state = {
      ...this.state,
      systemStatus: this.state.killSwitchActive ? "KILL_SWITCHED" : "PAUSED",
      pauseReason: reason ?? this.state.pauseReason,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "/pause", reason ?? this.state.pauseReason);
    return this.getState();
  }

  async resume(): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    this.state = {
      ...this.state,
      systemStatus: resolveResumedSystemStatus(this.state),
      pauseReason: null,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "/resume", null);
    return this.getState();
  }

  async activateKillSwitch(reason?: string): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    this.state = {
      ...this.state,
      killSwitchActive: true,
      systemStatus: "KILL_SWITCHED",
      pauseReason: reason ?? this.state.pauseReason,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "/killswitch", reason ?? this.state.pauseReason);
    return this.getState();
  }

  async setExecutionMode(mode: ExecutionStateRecord["executionMode"]): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    this.state = {
      ...this.state,
      executionMode: mode,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "SET_EXECUTION_MODE", mode);
    return this.getState();
  }

  async setLiveExecutionGate(gate: ExecutionStateRecord["liveExecutionGate"]): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    this.state = {
      ...this.state,
      liveExecutionGate: gate,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "SET_LIVE_EXECUTION_GATE", gate);
    return this.getState();
  }

  async markDegraded(reason?: string): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    const degradedReason = reason ?? this.state.degradedReason ?? "startup_portfolio_drift_detected";
    const degradedAt = this.state.degradedAt ?? new Date().toISOString();
    this.state = {
      ...this.state,
      systemStatus: resolveSystemStatusForDegradation(this.state),
      degradedReason,
      degradedAt,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "MARK_DEGRADED", degradedReason);
    return this.getState();
  }

  async clearDegraded(reason?: string): Promise<ExecutionStateRecord> {
    const previousState = { ...this.state };
    this.state = {
      ...this.state,
      systemStatus: this.state.systemStatus === "DEGRADED" ? "RUNNING" : this.state.systemStatus,
      degradedReason: null,
      degradedAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.recordTransition(previousState, this.state, "CLEAR_DEGRADED", reason ?? "startup_recovery_clean");
    return this.getState();
  }

  private recordTransition(
    fromState: ExecutionStateRecord,
    toState: ExecutionStateRecord,
    command: ExecutionStateTransitionRecord["command"],
    reason: string | null,
  ): void {
    this.transitions.unshift({
      id: `execution_state_transition_${this.transitions.length + 1}`,
      exchangeAccountId: toState.exchangeAccountId,
      command,
      fromExecutionMode: fromState.executionMode,
      toExecutionMode: toState.executionMode,
      fromLiveExecutionGate: fromState.liveExecutionGate,
      toLiveExecutionGate: toState.liveExecutionGate,
      fromSystemStatus: fromState.systemStatus,
      toSystemStatus: toState.systemStatus,
      fromKillSwitchActive: fromState.killSwitchActive,
      toKillSwitchActive: toState.killSwitchActive,
      reason,
      createdAt: toState.updatedAt,
    });
  }
}

function resolveResumedSystemStatus(state: ExecutionStateRecord): ExecutionStateRecord["systemStatus"] {
  if (state.killSwitchActive) {
    return "KILL_SWITCHED";
  }

  if (state.degradedReason || state.degradedAt) {
    return "DEGRADED";
  }

  return "RUNNING";
}

function resolveSystemStatusForDegradation(
  state: ExecutionStateRecord,
): ExecutionStateRecord["systemStatus"] {
  if (state.killSwitchActive || state.systemStatus === "KILL_SWITCHED") {
    return "KILL_SWITCHED";
  }

  if (state.systemStatus === "PAUSED") {
    return "PAUSED";
  }

  return "DEGRADED";
}

function parsePositionSnapshotJson(input: string | undefined): PositionSnapshot[] {
  if (!input) {
    return [];
  }

  const parsed = JSON.parse(input) as unknown;
  return Array.isArray(parsed) ? (parsed as PositionSnapshot[]) : [];
}

function aggregateAssetExposure(positions: PositionSnapshot[]): Record<SupportedAsset, number> {
  return positions.reduce<Record<SupportedAsset, number>>(
    (accumulator, position) => {
      accumulator[position.asset] += Number(position.marketValue ?? "0");
      return accumulator;
    },
    { BTC: 0, ETH: 0 },
  );
}
