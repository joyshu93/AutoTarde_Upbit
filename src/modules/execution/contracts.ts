import type {
  Iso8601String,
  UpbitCreateOrderRequest,
  UpbitCreatedOrderReceipt,
  UpbitOrderIdentifier,
  UpbitOrderReference,
  UpbitOrderSnapshot,
  UpbitSpotMarket,
  UpbitTestOrderReceipt,
  UuidString,
} from "../exchange/upbit/contracts.js";
import type {
  CancelOrderDecision,
  DeterministicStrategyDecision,
  PlaceOrderDecision,
} from "../strategy/contracts.js";
import type { RiskEvaluation } from "../risk/contracts.js";

export type ExecutionMode = "DRY_RUN" | "LIVE";
export type ExecutionEffect = "SIMULATE_ONLY" | "SUBMIT" | "BLOCK";
export type ExecutionPhase =
  | "planned"
  | "gated"
  | "submitted"
  | "acknowledged"
  | "reconciled"
  | "rejected";
export type ExecutionIdempotencyKey = string & {
  readonly __brand: "ExecutionIdempotencyKey";
};
export type ExecutionAttemptKey = string & {
  readonly __brand: "ExecutionAttemptKey";
};

export interface ExecutionEnvironmentPolicy {
  readonly mode: ExecutionMode;
  readonly managedMarkets: readonly UpbitSpotMarket[];
  readonly allowLiveOrderCreates: boolean;
  readonly allowLiveOrderCancels: boolean;
  readonly performDryRunOrderValidation: boolean;
  readonly dryRunMutatesExchangeState: false;
  readonly liveRequiresSuccessfulOrderTest: boolean;
}

export interface IdentifierReservation {
  readonly idempotencyKey: ExecutionIdempotencyKey;
  readonly attemptKey: ExecutionAttemptKey;
  readonly exchangeIdentifier: UpbitOrderIdentifier;
  readonly createdAt: Iso8601String;
}

export interface IdempotencyRecord {
  readonly key: ExecutionIdempotencyKey;
  readonly market: UpbitSpotMarket;
  readonly decisionKey: string;
  readonly phase: ExecutionPhase;
  readonly latestAttempt?: IdentifierReservation;
  readonly exchangeOrderUuid?: UuidString;
  readonly createdAt: Iso8601String;
  readonly updatedAt: Iso8601String;
}

export interface PlannedCreateOrder {
  readonly type: "CREATE_ORDER";
  readonly decision: PlaceOrderDecision;
  readonly idempotencyKey: ExecutionIdempotencyKey;
  readonly attempt: IdentifierReservation;
  readonly request: UpbitCreateOrderRequest;
}

export interface PlannedCancelOrder {
  readonly type: "CANCEL_ORDER";
  readonly decision: CancelOrderDecision;
  readonly idempotencyKey: ExecutionIdempotencyKey;
  readonly target: UpbitOrderReference;
}

export type PlannedExecution = PlannedCreateOrder | PlannedCancelOrder;

export type ExecutionGateDecision =
  | {
      readonly allowed: true;
      readonly effect: "SIMULATE_ONLY";
      readonly mode: "DRY_RUN";
      readonly execution: PlannedExecution;
    }
  | {
      readonly allowed: true;
      readonly effect: "SUBMIT";
      readonly mode: "LIVE";
      readonly execution: PlannedExecution;
      readonly successfulTestReceipt?: UpbitTestOrderReceipt;
    }
  | {
      readonly allowed: false;
      readonly effect: "BLOCK";
      readonly mode: ExecutionMode;
      readonly execution: PlannedExecution;
      readonly reasons: readonly string[];
    };

export interface DryRunExecutionReceipt {
  readonly mode: "DRY_RUN";
  readonly execution: PlannedExecution;
  readonly simulatedAt: Iso8601String;
  readonly previewOrder?: UpbitTestOrderReceipt;
}

export interface LiveCreateOrderReceipt {
  readonly mode: "LIVE";
  readonly execution: PlannedCreateOrder;
  readonly acknowledgedAt: Iso8601String;
  readonly exchangeOrder: UpbitCreatedOrderReceipt;
}

export interface LiveCancelOrderReceipt {
  readonly mode: "LIVE";
  readonly execution: PlannedCancelOrder;
  readonly acknowledgedAt: Iso8601String;
  readonly exchangeOrder: UpbitOrderSnapshot;
}

export type ExecutionReceipt =
  | DryRunExecutionReceipt
  | LiveCreateOrderReceipt
  | LiveCancelOrderReceipt;

export interface ExecutionCoordinator {
  reserveIdempotency(
    decision: DeterministicStrategyDecision,
  ): Promise<ExecutionIdempotencyKey>;
  reserveExchangeIdentifier(
    key: ExecutionIdempotencyKey,
    decision: PlaceOrderDecision,
  ): Promise<IdentifierReservation>;
  planCreateOrder(
    key: ExecutionIdempotencyKey,
    attempt: IdentifierReservation,
    decision: PlaceOrderDecision,
  ): Promise<PlannedCreateOrder>;
  planCancelOrder(
    key: ExecutionIdempotencyKey,
    decision: CancelOrderDecision,
  ): Promise<PlannedCancelOrder>;
  gateExecution(
    execution: PlannedExecution,
    risk: RiskEvaluation,
    policy: ExecutionEnvironmentPolicy,
    successfulTestReceipt?: UpbitTestOrderReceipt,
  ): Promise<ExecutionGateDecision>;
  execute(gate: ExecutionGateDecision): Promise<ExecutionReceipt>;
}
