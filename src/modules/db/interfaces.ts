import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  FillRecord,
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
  listRiskEvents(exchangeAccountId: string): Promise<RiskEventRecord[]>;
  saveReconciliationRun(record: ReconciliationRunRecord): Promise<void>;
  updateReconciliationRun(record: ReconciliationRunRecord): Promise<void>;
}

export interface OperatorStateStore {
  getState(): Promise<ExecutionStateRecord>;
  pause(reason?: string): Promise<ExecutionStateRecord>;
  resume(): Promise<ExecutionStateRecord>;
  activateKillSwitch(reason?: string): Promise<ExecutionStateRecord>;
}
