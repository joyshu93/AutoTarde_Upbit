import type {
  DecimalString,
  Iso8601String,
  ManagedSpotAsset,
  UpbitBalance,
  UpbitOrderIdentifier,
  UpbitOrderSnapshot,
  UpbitSpotMarket,
  UuidString,
} from "../exchange/upbit/contracts.js";
import type {
  ExecutionIdempotencyKey,
  ExecutionPhase,
  IdentifierReservation,
} from "../execution/contracts.js";
import type { DeterministicStrategyDecision } from "../strategy/contracts.js";

export type ReconciliationMismatchKind =
  | "balance_mismatch"
  | "missing_exchange_order"
  | "unexpected_exchange_order"
  | "identifier_collision"
  | "phase_divergence"
  | "dry_run_leak"
  | "market_scope_violation";
export type ReconciliationSeverity = "error" | "warning";

export interface ExecutionLedgerEntry {
  readonly idempotencyKey: ExecutionIdempotencyKey;
  readonly market: UpbitSpotMarket;
  readonly decision: DeterministicStrategyDecision;
  readonly phase: ExecutionPhase;
  readonly attempt?: IdentifierReservation;
  readonly exchangeOrderUuid?: UuidString;
  readonly createdAt: Iso8601String;
  readonly updatedAt: Iso8601String;
}

export interface ManagedBalanceExpectation {
  readonly currency: ManagedSpotAsset;
  readonly expectedFree: DecimalString;
  readonly expectedLocked: DecimalString;
}

export interface ManagedBalanceComparison {
  readonly currency: ManagedSpotAsset;
  readonly expected: ManagedBalanceExpectation;
  readonly actual?: UpbitBalance;
}

export interface ReconciliationMismatch {
  readonly kind: ReconciliationMismatchKind;
  readonly severity: ReconciliationSeverity;
  readonly message: string;
  readonly market?: UpbitSpotMarket;
  readonly idempotencyKey?: ExecutionIdempotencyKey;
  readonly exchangeIdentifier?: UpbitOrderIdentifier;
  readonly exchangeOrderUuid?: UuidString;
}

export interface ReconciliationInput {
  readonly startedAt: Iso8601String;
  readonly managedMarkets: readonly UpbitSpotMarket[];
  readonly expectedBalances: readonly ManagedBalanceExpectation[];
  readonly actualBalances: readonly UpbitBalance[];
  readonly ledger: readonly ExecutionLedgerEntry[];
  readonly exchangeOrders: readonly UpbitOrderSnapshot[];
}

export interface ReconciliationReport {
  readonly startedAt: Iso8601String;
  readonly completedAt: Iso8601String;
  readonly clean: boolean;
  readonly managedMarkets: readonly UpbitSpotMarket[];
  readonly balanceComparisons: readonly ManagedBalanceComparison[];
  readonly mismatches: readonly ReconciliationMismatch[];
}

export interface ReconciliationEngine {
  reconcile(input: ReconciliationInput): Promise<ReconciliationReport>;
}
