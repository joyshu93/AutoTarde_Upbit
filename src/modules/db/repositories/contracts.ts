import type {
  BalanceSnapshotRecord,
  ExchangeAccountRecord,
  ExecutionStateKey,
  ExecutionStateRecord,
  FillRecord,
  IdempotencyKeyRecord,
  JsonValue,
  OperatorActionRecord,
  OrderEventRecord,
  OrderRecord,
  ReconciliationRunRecord,
  ResourcePointer,
  RiskEventRecord,
  StrategyDecisionRecord,
  TimestampMs,
  UserRecord,
  PositionSnapshotRecord,
} from '../types.js';

export interface UserRepository {
  upsert(user: UserRecord): Promise<void>;
  getById(userId: string): Promise<UserRecord | null>;
}

export interface ExchangeAccountRepository {
  upsert(account: ExchangeAccountRecord): Promise<void>;
  getById(exchangeAccountId: string): Promise<ExchangeAccountRecord | null>;
  listTradeEnabled(): Promise<ExchangeAccountRecord[]>;
}

export interface StrategyDecisionRepository {
  insert(decision: StrategyDecisionRecord): Promise<void>;
  save(decision: StrategyDecisionRecord): Promise<void>;
  getById(decisionId: string): Promise<StrategyDecisionRecord | null>;
  listPendingByAccount(exchangeAccountId: string, limit?: number): Promise<StrategyDecisionRecord[]>;
}

export interface SnapshotRepository {
  appendBalances(rows: readonly BalanceSnapshotRecord[]): Promise<void>;
  appendPositions(rows: readonly PositionSnapshotRecord[]): Promise<void>;
  listLatestBalances(exchangeAccountId: string): Promise<BalanceSnapshotRecord[]>;
  listLatestPositions(exchangeAccountId: string): Promise<PositionSnapshotRecord[]>;
}

export interface OrderRepository {
  insert(order: OrderRecord): Promise<void>;
  save(order: OrderRecord): Promise<void>;
  getById(orderId: string): Promise<OrderRecord | null>;
  getByClientOrderId(exchangeAccountId: string, clientOrderId: string): Promise<OrderRecord | null>;
  listActiveByAccount(exchangeAccountId: string): Promise<OrderRecord[]>;
  appendEvent(event: OrderEventRecord): Promise<void>;
  listEvents(orderId: string): Promise<OrderEventRecord[]>;
  appendFill(fill: FillRecord): Promise<void>;
  listFills(orderId: string): Promise<FillRecord[]>;
}

export interface ReconciliationRunRepository {
  upsert(run: ReconciliationRunRecord): Promise<void>;
  getById(runId: string): Promise<ReconciliationRunRecord | null>;
  listRecentByAccount(exchangeAccountId: string, limit?: number): Promise<ReconciliationRunRecord[]>;
}

export interface RiskEventRepository {
  upsert(event: RiskEventRecord): Promise<void>;
  getById(riskEventId: string): Promise<RiskEventRecord | null>;
  listActiveByAccount(exchangeAccountId: string): Promise<RiskEventRecord[]>;
}

export interface ExecutionStateMutation extends ExecutionStateKey {
  expectedVersion: number | null;
  state: JsonValue;
  leaseOwner?: string | null;
  leaseExpiresAtMs?: TimestampMs | null;
  lastHeartbeatAtMs?: TimestampMs | null;
  nowMs: TimestampMs;
}

export interface ExecutionLeaseRequest extends ExecutionStateKey {
  leaseOwner: string;
  leaseExpiresAtMs: TimestampMs;
  nowMs: TimestampMs;
}

export interface ExecutionStateRepository {
  get(key: ExecutionStateKey): Promise<ExecutionStateRecord | null>;
  compareAndSet(mutation: ExecutionStateMutation): Promise<ExecutionStateRecord | null>;
  acquireLease(request: ExecutionLeaseRequest): Promise<boolean>;
  releaseLease(key: ExecutionStateKey, leaseOwner: string, nowMs: TimestampMs): Promise<boolean>;
}

export interface IdempotencyClaim {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  firstSeenAtMs: TimestampMs;
  expiresAtMs?: TimestampMs | null;
}

export interface IdempotencyClaimResult {
  record: IdempotencyKeyRecord;
  inserted: boolean;
  requestHashMatched: boolean;
}

export interface IdempotencyRepository {
  claim(claim: IdempotencyClaim): Promise<IdempotencyClaimResult>;
  get(scope: string, idempotencyKey: string): Promise<IdempotencyKeyRecord | null>;
  markCompleted(
    scope: string,
    idempotencyKey: string,
    completedAtMs: TimestampMs,
    resource?: ResourcePointer | null,
    responsePayload?: JsonValue | null,
  ): Promise<void>;
  markFailed(
    scope: string,
    idempotencyKey: string,
    failedAtMs: TimestampMs,
    responsePayload?: JsonValue | null,
  ): Promise<void>;
}

export interface OperatorActionRepository {
  upsert(action: OperatorActionRecord): Promise<void>;
  getById(actionId: string): Promise<OperatorActionRecord | null>;
  listPendingByAccount(exchangeAccountId: string | null): Promise<OperatorActionRecord[]>;
}

export interface DbRepositoryBundle {
  users: UserRepository;
  exchangeAccounts: ExchangeAccountRepository;
  strategyDecisions: StrategyDecisionRepository;
  snapshots: SnapshotRepository;
  orders: OrderRepository;
  reconciliationRuns: ReconciliationRunRepository;
  riskEvents: RiskEventRepository;
  executionState: ExecutionStateRepository;
  idempotency: IdempotencyRepository;
  operatorActions: OperatorActionRepository;
}
