import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  FillRecord,
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
    this.fills.push(record);
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

  async listRiskEvents(exchangeAccountId: string): Promise<RiskEventRecord[]> {
    return this.riskEvents.filter((candidate) => candidate.exchangeAccountId === exchangeAccountId);
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
}

export class InMemoryOperatorStateStore implements OperatorStateStore {
  constructor(private state: ExecutionStateRecord) {}

  async getState(): Promise<ExecutionStateRecord> {
    return { ...this.state };
  }

  async pause(reason?: string): Promise<ExecutionStateRecord> {
    this.state = {
      ...this.state,
      systemStatus: this.state.killSwitchActive ? "KILL_SWITCHED" : "PAUSED",
      pauseReason: reason ?? this.state.pauseReason,
      updatedAt: new Date().toISOString(),
    };
    return this.getState();
  }

  async resume(): Promise<ExecutionStateRecord> {
    this.state = {
      ...this.state,
      systemStatus: this.state.killSwitchActive ? "KILL_SWITCHED" : "RUNNING",
      pauseReason: null,
      updatedAt: new Date().toISOString(),
    };
    return this.getState();
  }

  async activateKillSwitch(reason?: string): Promise<ExecutionStateRecord> {
    this.state = {
      ...this.state,
      killSwitchActive: true,
      systemStatus: "KILL_SWITCHED",
      pauseReason: reason ?? this.state.pauseReason,
      updatedAt: new Date().toISOString(),
    };
    return this.getState();
  }
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
