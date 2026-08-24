import type {
  BalanceSnapshotRecord,
  ClaimedOperatorNotificationRecord,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  ExchangeAccountRecord,
  FillRecord,
  HistoryRecoveryCheckpointRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
  OperatorNotificationDeliveryTransition,
  OperatorNotificationRecord,
  OrderEventRecord,
  OrderRecord,
  PortfolioExposureSnapshot,
  PositionSnapshot,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  RiskEventRecord,
  StrategyDecisionRecord,
  StrategySchedulerRunRecord,
  SupportedAsset,
  SupportedMarket,
  TelegramInboundOffsetRecord,
  UserRecord,
} from "../../../domain/types.js";
import type {
  CandidateExecutionBindingRecord,
  OrderSubmissionRecoveryObservationRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../../domain/pilot-types.js";
import type {
  SqliteBalanceSnapshotRow,
  SqliteExecutionStateRow,
  SqliteExecutionStateTransitionRow,
  SqliteExchangeAccountRow,
  SqliteFillRow,
  SqliteHistoryRecoveryCheckpointRow,
  SqliteOperatorNotificationDeliveryAttemptRow,
  SqliteOperatorNotificationDeliveryRunRow,
  SqliteOperatorNotificationRow,
  SqliteOrderEventRow,
  SqliteOrderSubmissionRecoveryObservationRow,
  SqliteOrderRow,
  SqlitePositionSnapshotRow,
  SqliteReconciliationRunRow,
  SqliteRiskEventRow,
  SqliteStrategyDecisionRow,
  SqliteStrategySchedulerRunRow,
  SqliteTelegramInboundOffsetRow,
  SqliteUserRow,
} from "../types.js";
import type {
  ExecutionRepository,
  FinalizeBoundedSubmissionAbsenceInput,
  FaultPauseInput,
  OperatorStateStore,
  PersistCandidateProjectionFaultInput,
  PersistCandidateBoundOrderIntentInput,
  PersistCandidateBoundOrderIntentRequest,
  PersistExchangeSubmissionInput,
  PersistOrderIntentInput,
  PersistReconciledExchangeSnapshotInput,
  PersistReconciledExchangeSnapshotResult,
  PersistUncertainSubmissionInput,
  TelegramInboundOffsetStore,
} from "../interfaces.js";
import type { SqliteBootstrapOptions, SqlitePersistenceBundle } from "./contracts.js";
import { fromSqliteBoolean, parseJson, stringifyJson, toSqliteBoolean } from "./sqlite-shapes.js";
import { openSqliteDatabase } from "./sqlite-database.js";
import { createId } from "../../../shared/ids.js";
import { SqliteAccountExecutionLeaseStore } from "./sqlite-account-execution-lease-store.js";
import { SqliteCandidatePilotRepository } from "./sqlite-candidate-pilot-repository.js";
import { withImmediateTransaction } from "./sqlite-transaction.js";
import {
  validateCandidateBoundOrderIntent,
  validateCandidateBoundOrderIntentRequestShape,
} from "./candidate-bound-order-validation.js";
import {
  validateCandidateExecutionBinding,
  validateCandidatePilotDeployment,
} from "../pilot-interfaces.js";
import {
  faultPauseTransitionMatchesOccurrence,
  recordsEqual,
  normalizeFillFeeProvenance,
  resolveImmutableFillReplay,
  validateExchangeSubmissionInput,
  validateExchangeSubmissionCompletion,
  validateFaultPauseInput,
  validateFaultPauseTimestamp,
  validateOrderIntentInput,
  validateFillForOrder,
  validateReconciledExchangeSnapshotInput,
  validateUncertainSubmissionCompletion,
  validateUncertainSubmissionInput,
} from "./atomic-lifecycle-validation.js";

const ACTIVE_ORDER_STATUSES = new Set<OrderRecord["status"]>([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);
const ACTIVE_ORDER_STATUS_VALUES = Array.from(ACTIVE_ORDER_STATUSES);
const ACTIVE_ORDER_STATUS_PLACEHOLDERS = ACTIVE_ORDER_STATUS_VALUES.map(() => "?").join(", ");
const CANDIDATE_SUBMISSION_BLOCKING_STATUSES = new Set<OrderRecord["status"]>([
  ...ACTIVE_ORDER_STATUSES,
  "FAILED",
  "REJECTED",
]);
const CANDIDATE_SUBMISSION_BLOCKING_STATUS_VALUES = Array.from(CANDIDATE_SUBMISSION_BLOCKING_STATUSES);
const CANDIDATE_SUBMISSION_BLOCKING_STATUS_PLACEHOLDERS =
  CANDIDATE_SUBMISSION_BLOCKING_STATUS_VALUES.map(() => "?").join(", ");

interface SqliteCandidateDeploymentAuthorityRow {
  id: string;
  exchange_account_id: string;
  pilot_id: PositionGuardPilotDeploymentRecord["pilotId"];
  market: PositionGuardPilotDeploymentRecord["market"];
  policy_id: PositionGuardPilotDeploymentRecord["policyId"];
  policy_version: PositionGuardPilotDeploymentRecord["policyVersion"];
  phase: PositionGuardPilotDeploymentRecord["phase"];
  activation_at: string | null;
  activation_epoch_ns: string | number | bigint | null;
  created_at: string;
  updated_at: string;
}

interface SqliteCandidateStateAuthorityRow {
  state_version: number;
}

interface SqliteCandidateBindingAuthorityRow {
  id: string;
  deployment_id: string;
  strategy_decision_id: string;
  order_id: string;
  exchange_account_id: string;
  activation_at: string;
  activation_epoch_ns: string | number | bigint;
  market: CandidateExecutionBindingRecord["market"];
  strategy_key: CandidateExecutionBindingRecord["strategyKey"];
  policy_id: CandidateExecutionBindingRecord["policyId"];
  policy_version: CandidateExecutionBindingRecord["policyVersion"];
  execution_mode: CandidateExecutionBindingRecord["executionMode"];
  ord_type: CandidateExecutionBindingRecord["ordType"];
  action: CandidateExecutionBindingRecord["action"];
  side: CandidateExecutionBindingRecord["side"];
  intended_quantity_exact: string | null;
  intended_notional_krw_exact: string | null;
  bound_price_exact: string | null;
  bound_volume_exact: string | null;
  bound_time_in_force: CandidateExecutionBindingRecord["boundTimeInForce"];
  bound_smp_type: CandidateExecutionBindingRecord["boundSmpType"];
  material_version: CandidateExecutionBindingRecord["materialVersion"] | "LEGACY_UNVERIFIED";
  order_material_hash: string | null;
  created_at: string;
}

export function createSqlitePersistence(options: SqliteBootstrapOptions): SqlitePersistenceBundle {
  const handle = openSqliteDatabase(options.databasePath);
  const repositories = new SqliteExecutionRepository(handle.db);
  const candidatePilots = new SqliteCandidatePilotRepository(handle.db);
  const accountExecutionLeases = new SqliteAccountExecutionLeaseStore(handle.db);
  const telegramInboundOffsets = new SqliteTelegramInboundOffsetStore(handle.db);

  const now = new Date().toISOString();
  const bootstrapStateInserted = ensureBootstrapRecords(handle.db, {
    user: {
      id: options.userId,
      telegramUserId: options.userTelegramId,
      telegramChatId: null,
      displayName: options.userDisplayName,
      createdAt: now,
      updatedAt: now,
    },
    exchangeAccount: {
      id: options.exchangeAccountId,
      userId: options.userId,
      exchange: "UPBIT",
      venueType: "SPOT",
      accountLabel: "primary",
      accessKeyRef: options.accessKeyRef,
      secretKeyRef: options.secretKeyRef,
      quoteCurrency: "KRW",
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    },
    executionState: {
      id: `execution_state_${options.exchangeAccountId}`,
      exchangeAccountId: options.exchangeAccountId,
      executionMode: options.executionMode,
      liveExecutionGate: options.liveExecutionGate,
      systemStatus: options.killSwitchActive ? "KILL_SWITCHED" : "RUNNING",
      killSwitchActive: options.killSwitchActive,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: now,
    },
  });

  if (bootstrapStateInserted) {
    recordExecutionStateTransition(handle.db, {
      id: createId("execution_state_transition"),
      exchangeAccountId: options.exchangeAccountId,
      command: "BOOTSTRAP",
      fromExecutionMode: null,
      toExecutionMode: options.executionMode,
      fromLiveExecutionGate: null,
      toLiveExecutionGate: options.liveExecutionGate,
      fromSystemStatus: null,
      toSystemStatus: options.killSwitchActive ? "KILL_SWITCHED" : "RUNNING",
      fromKillSwitchActive: null,
      toKillSwitchActive: options.killSwitchActive,
      reason: "bootstrap_seed",
      createdAt: now,
    });
  }

  return {
    repositories,
    candidatePilots,
    accountExecutionLeases,
    operatorState: new SqliteOperatorStateStore(handle.db, options.exchangeAccountId),
    telegramInboundOffsets,
    close() {
      handle.close();
    },
  };
}

export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: import("node:sqlite").DatabaseSync) {}

  async saveStrategyDecision(record: StrategyDecisionRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO strategy_decisions (
        id, exchange_account_id, strategy_key, market, action, status,
        decision_basis_json, intended_notional_krw, intended_quantity,
        reference_price, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        strategy_key = excluded.strategy_key,
        market = excluded.market,
        action = excluded.action,
        status = excluded.status,
        decision_basis_json = excluded.decision_basis_json,
        intended_notional_krw = excluded.intended_notional_krw,
        intended_quantity = excluded.intended_quantity,
        reference_price = excluded.reference_price,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.strategyKey,
      record.market,
      record.action,
      record.status,
      record.decisionBasisJson,
      record.intendedNotionalKrw,
      record.intendedQuantity,
      record.referencePrice,
      record.createdAt,
    );
  }

  async getLatestStrategyDecision(
    exchangeAccountId: string,
    market: SupportedMarket,
    strategyKey?: string,
  ): Promise<StrategyDecisionRecord | null> {
    const row = strategyKey === undefined
      ? (this.db.prepare(`
          SELECT * FROM strategy_decisions
          WHERE exchange_account_id = ? AND market = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(exchangeAccountId, market) as SqliteStrategyDecisionRow | undefined)
      : (this.db.prepare(`
          SELECT * FROM strategy_decisions
          WHERE exchange_account_id = ? AND market = ? AND strategy_key = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(exchangeAccountId, market, strategyKey) as SqliteStrategyDecisionRow | undefined);

    return row ? mapStrategyDecisionRow(row) : null;
  }

  async getStrategyDecisionById(id: string): Promise<StrategyDecisionRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM strategy_decisions
      WHERE id = ?
      LIMIT 1
    `).get(id) as SqliteStrategyDecisionRow | undefined;
    return row ? mapStrategyDecisionRow(row) : null;
  }

  async saveOrder(record: OrderRecord): Promise<void> {
    this.upsertOrder(record);
  }

  async updateOrder(record: OrderRecord): Promise<void> {
    this.upsertOrder(record);
  }

  async persistOrderIntent(input: PersistOrderIntentInput): Promise<void> {
    withImmediateTransaction(this.db, () => {
      const existingOrder = this.getOrderById(input.order.id);
      const existingEvent = this.getOrderEventById(input.event.id);
      if (existingOrder) {
        validateOrderIntentInput(input);
        if (!recordsEqual(existingOrder, input.order) || !existingEvent || !recordsEqual(existingEvent, input.event)) {
          throw new Error(`Conflicting duplicate order intent ${input.order.id}.`);
        }
        return;
      }
      if (existingEvent) {
        throw new Error(`Conflicting duplicate order event ${input.event.id}.`);
      }

      this.upsertOrder(input.order);
      // Keep validation in the transaction so malformed child input proves the order write rolls back.
      validateOrderIntentInput(input);
      this.insertOrderEvent(input.event);
    });
  }

  async persistCandidateBoundOrderIntent(input: PersistCandidateBoundOrderIntentRequest): Promise<void> {
    withImmediateTransaction(this.db, () => {
      validateCandidateBoundOrderIntentRequestShape(input);

      const decision = this.getStrategyDecisionByIdSync(input.binding.strategyDecisionId);
      if (!decision) {
        throw new Error(`Persisted candidate strategy decision ${input.binding.strategyDecisionId} is missing.`);
      }
      const deployment = this.getCandidateDeploymentById(input.binding.deploymentId);
      const exactStateVersion = this.getCandidateStateVersion(input.binding.deploymentId);
      if (!deployment || exactStateVersion === null) {
        throw new Error(`Persisted candidate authority ${input.binding.deploymentId} is missing.`);
      }

      const aggregate: PersistCandidateBoundOrderIntentInput = {
        order: input.order,
        event: input.event,
        binding: input.binding,
        decision,
        deployment,
        exactStateVersion,
        expectedPhase: input.expectedPhase,
        expectedDeploymentUpdatedAt: input.expectedDeploymentUpdatedAt,
        expectedStateVersion: input.expectedStateVersion,
      };
      validateCandidateBoundOrderIntent(aggregate);

      const existingOrder = this.getOrderById(input.order.id);
      const existingEventById = this.getOrderEventById(input.event.id);
      const existingOrderEvents = this.getOrderEventsForOrder(input.order.id);
      const existingBindingByOrder = this.getCandidateBindingByOrderId(input.order.id);
      const existingBindingById = this.getCandidateBindingById(input.binding.id);

      if (existingEventById && !recordsEqual(existingEventById, input.event)) {
        throw new Error(`Conflicting candidate-bound order event ${input.event.id}.`);
      }
      if (existingBindingByOrder && !recordsEqual(existingBindingByOrder, input.binding)) {
        throw new Error(`Conflicting candidate-bound binding for order ${input.order.id}.`);
      }
      if (existingBindingById && !recordsEqual(existingBindingById, input.binding)) {
        throw new Error(`Conflicting candidate-bound binding id ${input.binding.id}.`);
      }

      const componentCount = Number(existingOrder !== null) +
        Number(existingOrderEvents.length > 0 || existingEventById !== null) +
        Number(existingBindingByOrder !== null || existingBindingById !== null);
      if (componentCount > 0) {
        if (
          !existingOrder || !recordsEqual(existingOrder, input.order) ||
          existingOrderEvents.length !== 1 || !recordsEqual(existingOrderEvents[0]!, input.event) ||
          !existingEventById ||
          !existingBindingByOrder || !existingBindingById ||
          !recordsEqual(existingBindingByOrder, input.binding) ||
          !recordsEqual(existingBindingById, input.binding)
        ) {
          throw new Error(`Dangling partial candidate-bound order intent ${input.order.id}.`);
        }
        return;
      }

      this.assertCandidateOrderUniqueness(input.order);
      this.insertOrder(input.order);
      this.insertOrderEvent(input.event);
      this.insertCandidateBinding(input.binding);
    });
  }

  async persistExchangeSubmission(input: PersistExchangeSubmissionInput): Promise<void> {
    withImmediateTransaction(this.db, () => {
      const normalizedInput = {
        ...input,
        fills: input.fills.map(normalizeFillFeeProvenance),
      };
      validateExchangeSubmissionInput(normalizedInput);
      const existingOrder = this.getOrderById(normalizedInput.order.id);
      if (!existingOrder) {
        throw new Error(`Cannot persist exchange submission for missing order ${normalizedInput.order.id}.`);
      }
      assertSameAccount(existingOrder, normalizedInput.order);
      const existingEvent = this.getOrderEventById(normalizedInput.event.id);
      assertNoConflictingRecord(existingEvent, normalizedInput.event, "order event");
      if (normalizedInput.terminalEvent) {
        const existingTerminalEvent = this.getOrderEventById(normalizedInput.terminalEvent.id);
        assertNoConflictingRecord(existingTerminalEvent, normalizedInput.terminalEvent, "terminal order event");
      }
      const existingFills = normalizedInput.fills.map((fill) => this.getFillByIdentity(fill));
      normalizedInput.fills.forEach((fill, index) => assertNoConflictingRecord(existingFills[index] ?? null, fill, "fill"));

      const completion = validateExchangeSubmissionCompletion(
        existingOrder,
        normalizedInput.order,
        normalizedInput,
        this.getOrderEventsForOrder(normalizedInput.order.id),
        this.getFillsForOrder(normalizedInput.order.id),
      );
      if (completion === "RETRY") {
        return;
      }

      this.upsertOrder(normalizedInput.order);
      this.insertOrderEvent(normalizedInput.event);
      if (normalizedInput.terminalEvent) this.insertOrderEvent(normalizedInput.terminalEvent);
      normalizedInput.fills.forEach((fill) => this.insertFill(fill));
    });
  }

  async persistReconciledExchangeSnapshot(
    input: PersistReconciledExchangeSnapshotInput,
  ): Promise<PersistReconciledExchangeSnapshotResult> {
    return withImmediateTransaction(this.db, () => {
      const normalizedInput = {
        ...input,
        fills: input.fills.map(normalizeFillFeeProvenance),
      };
      validateReconciledExchangeSnapshotInput(normalizedInput);
      const currentOrder = this.getOrderById(normalizedInput.order.id);
      if (!currentOrder) {
        throw new Error(`Cannot persist reconciliation for missing order ${normalizedInput.order.id}.`);
      }
      if (!recordsEqual(currentOrder, normalizedInput.expectedOrder)) {
        throw new Error(`Reconciliation expected order ${normalizedInput.order.id} changed concurrently.`);
      }

      const existingEvent = normalizedInput.event
        ? this.getOrderEventById(normalizedInput.event.id)
        : null;
      if (normalizedInput.event) {
        assertNoConflictingRecord(existingEvent, normalizedInput.event, "reconciliation order event");
      }
      const fillResolutions = normalizedInput.fills.map((fill) => ({
        fill,
        resolution: resolveImmutableFillReplay(this.getFillByIdentity(fill), fill),
      }));
      const insertedFills = fillResolutions
        .filter(({ resolution }) => resolution === "INSERT")
        .map(({ fill }) => fill);
      const orderChanged = !recordsEqual(currentOrder, normalizedInput.order);
      const eventInserted = normalizedInput.event !== null && existingEvent === null;

      this.upsertOrder(normalizedInput.order);
      if (eventInserted) this.insertOrderEvent(normalizedInput.event!);
      insertedFills.forEach((fill) => this.insertFill(fill));

      return {
        outcome: orderChanged || eventInserted || insertedFills.length > 0 ? "APPLIED" : "DUPLICATE",
        insertedFillCount: insertedFills.length,
      };
    });
  }

  async persistUncertainSubmission(input: PersistUncertainSubmissionInput): Promise<void> {
    withImmediateTransaction(this.db, () => {
      validateUncertainSubmissionInput(input);
      const existingOrder = this.getOrderById(input.order.id);
      if (!existingOrder) {
        throw new Error(`Cannot persist uncertain submission for missing order ${input.order.id}.`);
      }
      assertSameAccount(existingOrder, input.order);
      const existingEvent = this.getOrderEventById(input.event.id);
      const existingRiskEvent = this.getRiskEventById(input.riskEvent.id);
      assertNoConflictingRecord(existingEvent, input.event, "order event");
      assertNoConflictingRecord(existingRiskEvent, input.riskEvent, "risk event");

      const completion = validateUncertainSubmissionCompletion(
        existingOrder,
        input.order,
        input,
        this.getOrderEventsForOrder(input.order.id),
        this.getRiskEventsForOrder(input.order.id),
      );
      if (completion === "RETRY") {
        return;
      }

      this.upsertOrder(input.order);
      this.insertOrderEvent(input.event);
      this.upsertRiskEvent(input.riskEvent);
    });
  }

  async findOrderByIdempotencyKey(exchangeAccountId: string, idempotencyKey: string): Promise<OrderRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(exchangeAccountId, idempotencyKey) as SqliteOrderRow | undefined;

    return row ? mapOrderRow(row) : null;
  }

  async findOrderById(exchangeAccountId: string, orderId: string): Promise<OrderRecord | null> {
    const order = this.getOrderById(orderId);
    return order?.exchangeAccountId === exchangeAccountId ? order : null;
  }

  async findOrderByReference(exchangeAccountId: string, reference: string): Promise<OrderRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ?
        AND (id = ? OR identifier = ? OR upbit_uuid = ?)
      ORDER BY CASE WHEN id = ? THEN 0 WHEN identifier = ? THEN 1 ELSE 2 END, updated_at DESC
      LIMIT 1
    `).get(
      exchangeAccountId,
      reference,
      reference,
      reference,
      reference,
      reference,
    ) as SqliteOrderRow | undefined;

    return row ? mapOrderRow(row) : null;
  }

  async listActiveOrders(
    exchangeAccountId: string,
    market?: SupportedMarket,
    limit?: number,
  ): Promise<OrderRecord[]> {
    const marketClause = market ? "AND market = ?" : "";
    const limitClause = typeof limit === "number" ? "LIMIT ?" : "";
    const params: Array<string | number> = [
      exchangeAccountId,
      ...ACTIVE_ORDER_STATUS_VALUES,
      ...(market ? [market] : []),
      ...(typeof limit === "number" ? [limit] : []),
    ];

    const rows = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ?
        AND status IN (${ACTIVE_ORDER_STATUS_PLACEHOLDERS})
        ${marketClause}
      ORDER BY updated_at DESC
      ${limitClause}
    `).all(...params) as unknown as SqliteOrderRow[];

    return rows.map(mapOrderRow);
  }

  async listCandidateSubmissionBlockingOrders(
    exchangeAccountId: string,
    limit: number,
  ): Promise<OrderRecord[]> {
    validateCandidateOrderReadLimit(limit);
    const rows = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ?
        AND status IN (${CANDIDATE_SUBMISSION_BLOCKING_STATUS_PLACEHOLDERS})
        AND (
          status <> 'FAILED' OR
          failure_code IS NULL OR
          failure_code <> 'ORDER_SUBMISSION_ABSENCE_CONFIRMED'
        )
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(
      exchangeAccountId,
      ...CANDIDATE_SUBMISSION_BLOCKING_STATUS_VALUES,
      limit,
    ) as unknown as SqliteOrderRow[];

    return rows.map(mapOrderRow);
  }

  async listOrders(exchangeAccountId: string): Promise<OrderRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ?
      ORDER BY updated_at DESC
    `).all(exchangeAccountId) as unknown as SqliteOrderRow[];

    return rows.map(mapOrderRow);
  }

  async appendOrderEvent(record: OrderEventRecord): Promise<void> {
    this.insertOrderEvent(record);
  }

  private insertOrderEvent(record: OrderEventRecord): void {
    this.db.prepare(`
      INSERT INTO order_events (id, order_id, event_type, event_source, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.orderId,
      record.eventType,
      record.eventSource,
      record.payloadJson,
      record.createdAt,
    );
  }

  async saveFill(record: FillRecord): Promise<void> {
    withImmediateTransaction(this.db, () => {
      const normalizedRecord = normalizeFillFeeProvenance(record);
      const order = this.getOrderById(normalizedRecord.orderId);
      if (!order) throw new Error(`Cannot persist fill for missing order ${normalizedRecord.orderId}.`);
      validateFillForOrder(order, normalizedRecord);
      const existing = this.getFillByIdentity(normalizedRecord);
      if (resolveImmutableFillReplay(existing, normalizedRecord) === "INSERT") {
        this.insertFill(normalizedRecord);
      }
    });
  }

  private insertFill(record: FillRecord): void {
    this.db.prepare(`
      INSERT INTO fills (
        id, order_id, exchange_fill_id, market, side, price, volume,
        fee_currency, fee_amount, fee_provenance, execution_timestamp_provenance,
        execution_epoch_ns, filled_at, raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.orderId,
      record.exchangeFillId,
      record.market,
      record.side,
      record.price,
      record.volume,
      record.feeCurrency,
      record.feeAmount,
      record.feeProvenance ?? "LEGACY_UNVERIFIED",
      record.executionTimestampProvenance ?? "LEGACY_UNVERIFIED",
      record.executionEpochNs ?? null,
      record.filledAt,
      record.rawPayloadJson,
    );
  }

  async listFills(orderId?: string): Promise<FillRecord[]> {
    const rows = orderId
      ? (this.db.prepare(`
          SELECT * FROM fills WHERE order_id = ? ORDER BY filled_at DESC
        `).all(orderId) as unknown as SqliteFillRow[])
      : (this.db.prepare(`
          SELECT * FROM fills ORDER BY filled_at DESC
        `).all() as unknown as SqliteFillRow[]);

    return rows.map(mapFillRow);
  }

  async saveBalanceSnapshot(record: BalanceSnapshotRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO balance_snapshots (
        id, exchange_account_id, captured_at, source, total_krw_value, balances_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        captured_at = excluded.captured_at,
        source = excluded.source,
        total_krw_value = excluded.total_krw_value,
        balances_json = excluded.balances_json
    `).run(
      record.id,
      record.exchangeAccountId,
      record.capturedAt,
      record.source,
      record.totalKrwValue,
      record.balancesJson,
    );
  }

  async getLatestBalanceSnapshot(exchangeAccountId: string): Promise<BalanceSnapshotRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM balance_snapshots
      WHERE exchange_account_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(exchangeAccountId) as SqliteBalanceSnapshotRow | undefined;

    return row ? mapBalanceSnapshotRow(row) : null;
  }

  async savePositionSnapshot(record: PositionSnapshotRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO position_snapshots (
        id, exchange_account_id, captured_at, source, positions_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        captured_at = excluded.captured_at,
        source = excluded.source,
        positions_json = excluded.positions_json
    `).run(
      record.id,
      record.exchangeAccountId,
      record.capturedAt,
      record.source,
      record.positionsJson,
    );
  }

  async getLatestPositionSnapshot(exchangeAccountId: string): Promise<PositionSnapshotRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM position_snapshots
      WHERE exchange_account_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(exchangeAccountId) as SqlitePositionSnapshotRow | undefined;

    return row ? mapPositionSnapshotRow(row) : null;
  }

  async getPortfolioExposure(exchangeAccountId: string): Promise<PortfolioExposureSnapshot> {
    const balanceSnapshot = await this.getLatestBalanceSnapshot(exchangeAccountId);
    const positionSnapshot = await this.getLatestPositionSnapshot(exchangeAccountId);
    const positions = positionSnapshot ? parseJson<PositionSnapshot[]>(positionSnapshot.positionsJson) : [];
    const assetExposureKrw = positions.reduce<Record<SupportedAsset, number>>(
      (accumulator, position) => {
        accumulator[position.asset] += Number(position.marketValue ?? "0");
        return accumulator;
      },
      { BTC: 0, ETH: 0 },
    );

    return {
      totalEquityKrw: Number(balanceSnapshot?.totalKrwValue ?? "0"),
      totalExposureKrw: Object.values(assetExposureKrw).reduce((sum, value) => sum + value, 0),
      assetExposureKrw,
    };
  }

  async saveRiskEvent(record: RiskEventRecord): Promise<void> {
    this.upsertRiskEvent(record);
  }

  private upsertRiskEvent(record: RiskEventRecord): void {
    this.db.prepare(`
      INSERT INTO risk_events (
        id, exchange_account_id, strategy_decision_id, order_id,
        level, rule_code, message, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        strategy_decision_id = excluded.strategy_decision_id,
        order_id = excluded.order_id,
        level = excluded.level,
        rule_code = excluded.rule_code,
        message = excluded.message,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.strategyDecisionId,
      record.orderId,
      record.level,
      record.ruleCode,
      record.message,
      record.payloadJson,
      record.createdAt,
    );
  }

  async listRiskEvents(exchangeAccountId: string, limit?: number): Promise<RiskEventRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM risk_events
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteRiskEventRow[])
      : (this.db.prepare(`
          SELECT * FROM risk_events
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteRiskEventRow[]);

    return rows.map(mapRiskEventRow);
  }

  async saveReconciliationRun(record: ReconciliationRunRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO reconciliation_runs (
        id, exchange_account_id, status, started_at, completed_at, summary_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        summary_json = excluded.summary_json,
        error_message = excluded.error_message
    `).run(
      record.id,
      record.exchangeAccountId,
      record.status,
      record.startedAt,
      record.completedAt,
      record.summaryJson,
      record.errorMessage,
    );
  }

  async updateReconciliationRun(record: ReconciliationRunRecord): Promise<void> {
    await this.saveReconciliationRun(record);
  }

  async listReconciliationRuns(exchangeAccountId: string, limit?: number): Promise<ReconciliationRunRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM reconciliation_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteReconciliationRunRow[])
      : (this.db.prepare(`
          SELECT * FROM reconciliation_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteReconciliationRunRow[]);

    return rows.map(mapReconciliationRunRow);
  }

  async saveStrategySchedulerRun(record: StrategySchedulerRunRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO strategy_scheduler_runs (
        id, exchange_account_id, market, trigger_source, status, started_at, completed_at,
        interval_ms, run_on_start, strategy_decision_id, action, order_id, order_status,
        submission_accepted, detail, error_message, summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        market = excluded.market,
        trigger_source = excluded.trigger_source,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        interval_ms = excluded.interval_ms,
        run_on_start = excluded.run_on_start,
        strategy_decision_id = excluded.strategy_decision_id,
        action = excluded.action,
        order_id = excluded.order_id,
        order_status = excluded.order_status,
        submission_accepted = excluded.submission_accepted,
        detail = excluded.detail,
        error_message = excluded.error_message,
        summary_json = excluded.summary_json
    `).run(
      record.id,
      record.exchangeAccountId,
      record.market,
      record.triggerSource,
      record.status,
      record.startedAt,
      record.completedAt,
      record.intervalMs,
      toSqliteBoolean(record.runOnStart),
      record.strategyDecisionId,
      record.action,
      record.orderId,
      record.orderStatus,
      record.submissionAccepted === null ? null : toSqliteBoolean(record.submissionAccepted),
      record.detail,
      record.errorMessage,
      record.summaryJson,
    );
  }

  async listOrderEvents(orderId: string): Promise<OrderEventRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM order_events
      WHERE order_id = ?
      ORDER BY created_at ASC
    `).all(orderId) as unknown as SqliteOrderEventRow[];

    return rows.map(mapOrderEventRow);
  }

  async updateStrategySchedulerRun(record: StrategySchedulerRunRecord): Promise<void> {
    await this.saveStrategySchedulerRun(record);
  }

  async listStrategySchedulerRuns(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<StrategySchedulerRunRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM strategy_scheduler_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteStrategySchedulerRunRow[])
      : (this.db.prepare(`
          SELECT * FROM strategy_scheduler_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteStrategySchedulerRunRow[]);

    return rows.map(mapStrategySchedulerRunRow);
  }

  async saveHistoryRecoveryCheckpoint(record: HistoryRecoveryCheckpointRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO history_recovery_checkpoints (
        id, exchange_account_id, market, checkpoint_type, next_window_end_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_account_id, market, checkpoint_type) DO UPDATE SET
        id = excluded.id,
        next_window_end_at = excluded.next_window_end_at,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.market,
      record.checkpointType,
      record.nextWindowEndAt,
      record.updatedAt,
    );
  }

  async listHistoryRecoveryCheckpoints(exchangeAccountId: string): Promise<HistoryRecoveryCheckpointRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM history_recovery_checkpoints
      WHERE exchange_account_id = ?
      ORDER BY market ASC, checkpoint_type ASC
    `).all(exchangeAccountId) as unknown as SqliteHistoryRecoveryCheckpointRow[];

    return rows.map(mapHistoryRecoveryCheckpointRow);
  }

  async getHistoryRecoveryCheckpoint(
    exchangeAccountId: string,
    market: SupportedMarket,
    checkpointType: HistoryRecoveryCheckpointRecord["checkpointType"],
  ): Promise<HistoryRecoveryCheckpointRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM history_recovery_checkpoints
      WHERE exchange_account_id = ? AND market = ? AND checkpoint_type = ?
      LIMIT 1
    `).get(exchangeAccountId, market, checkpointType) as SqliteHistoryRecoveryCheckpointRow | undefined;

    return row ? mapHistoryRecoveryCheckpointRow(row) : null;
  }

  async saveOperatorNotification(record: OperatorNotificationRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO operator_notifications (
        id, exchange_account_id, channel, notification_type, severity,
        title, message, payload_json, delivery_status, attempt_count,
        last_attempt_at, next_attempt_at, failure_class, lease_token,
        lease_expires_at, created_at, delivered_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.exchangeAccountId,
      record.channel,
      record.notificationType,
      record.severity,
      record.title,
      record.message,
      record.payloadJson,
      record.deliveryStatus,
      record.attemptCount,
      record.lastAttemptAt,
      record.nextAttemptAt,
      record.failureClass,
      record.leaseToken,
      record.leaseExpiresAt,
      record.createdAt,
      record.deliveredAt,
      record.lastError,
    );
  }

  async saveOperatorNotificationDeliveryAttempt(
    record: OperatorNotificationDeliveryAttemptRecord,
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO operator_notification_delivery_attempts (
        id, notification_id, exchange_account_id, attempt_count, lease_token,
        outcome, failure_class, attempted_at, next_attempt_at, delivered_at,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        notification_id = excluded.notification_id,
        exchange_account_id = excluded.exchange_account_id,
        attempt_count = excluded.attempt_count,
        lease_token = excluded.lease_token,
        outcome = excluded.outcome,
        failure_class = excluded.failure_class,
        attempted_at = excluded.attempted_at,
        next_attempt_at = excluded.next_attempt_at,
        delivered_at = excluded.delivered_at,
        error_message = excluded.error_message,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.notificationId,
      record.exchangeAccountId,
      record.attemptCount,
      record.leaseToken,
      record.outcome,
      record.failureClass,
      record.attemptedAt,
      record.nextAttemptAt,
      record.deliveredAt,
      record.errorMessage,
      record.createdAt,
    );
  }

  async saveOperatorNotificationDeliveryRun(
    record: OperatorNotificationDeliveryRunRecord,
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO operator_notification_delivery_runs (
        id, exchange_account_id, worker_name, status, started_at, completed_at,
        attempted_count, sent_count, retry_scheduled_count, failed_count,
        stale_lease_count, pending_total_count, pending_due_count,
        pending_scheduled_count, active_lease_count, expired_lease_count,
        abandoned_lease_candidate_count, skipped_reason, error_message, summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        worker_name = excluded.worker_name,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        attempted_count = excluded.attempted_count,
        sent_count = excluded.sent_count,
        retry_scheduled_count = excluded.retry_scheduled_count,
        failed_count = excluded.failed_count,
        stale_lease_count = excluded.stale_lease_count,
        pending_total_count = excluded.pending_total_count,
        pending_due_count = excluded.pending_due_count,
        pending_scheduled_count = excluded.pending_scheduled_count,
        active_lease_count = excluded.active_lease_count,
        expired_lease_count = excluded.expired_lease_count,
        abandoned_lease_candidate_count = excluded.abandoned_lease_candidate_count,
        skipped_reason = excluded.skipped_reason,
        error_message = excluded.error_message,
        summary_json = excluded.summary_json
    `).run(
      record.id,
      record.exchangeAccountId,
      record.workerName,
      record.status,
      record.startedAt,
      record.completedAt,
      record.attemptedCount,
      record.sentCount,
      record.retryScheduledCount,
      record.failedCount,
      record.staleLeaseCount,
      record.pendingTotalCount,
      record.pendingDueCount,
      record.pendingScheduledCount,
      record.activeLeaseCount,
      record.expiredLeaseCount,
      record.abandonedLeaseCandidateCount,
      record.skippedReason,
      record.errorMessage,
      record.summaryJson,
    );
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
    const candidateRows = typeof input.limit === "number"
      ? (this.db.prepare(`
          SELECT id
          FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lease_expires_at IS NULL OR ? IS NULL OR lease_expires_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
          LIMIT ?
        `).all(
          exchangeAccountId,
          dueBefore,
          dueBefore,
          dueBefore,
          dueBefore,
          input.limit,
        ) as Array<{ id: string }>)
      : (this.db.prepare(`
          SELECT id
          FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lease_expires_at IS NULL OR ? IS NULL OR lease_expires_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
        `).all(
          exchangeAccountId,
          dueBefore,
          dueBefore,
          dueBefore,
          dueBefore,
        ) as Array<{ id: string }>);

    const claimedIds: string[] = [];
    const claimStatement = this.db.prepare(`
      UPDATE operator_notifications
      SET attempt_count = attempt_count + 1,
          last_attempt_at = ?,
          lease_token = ?,
          lease_expires_at = ?
      WHERE id = ?
        AND exchange_account_id = ?
        AND delivery_status = 'PENDING'
        AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_expires_at IS NULL OR ? IS NULL OR lease_expires_at <= ?)
    `);

    for (const row of candidateRows) {
      const result = claimStatement.run(
        input.claimedAt,
        input.leaseToken,
        input.leaseExpiresAt,
        row.id,
        exchangeAccountId,
        dueBefore,
        dueBefore,
        dueBefore,
        dueBefore,
      );
      if (result.changes > 0) {
        claimedIds.push(row.id);
      }
    }

    if (claimedIds.length === 0) {
      return [];
    }

    const fetchClaimedStatement = this.db.prepare(`
      SELECT * FROM operator_notifications
      WHERE id = ? AND lease_token = ?
      LIMIT 1
    `);

    return claimedIds
      .map((id) => fetchClaimedStatement.get(id, input.leaseToken) as SqliteOperatorNotificationRow | undefined)
      .filter((row): row is SqliteOperatorNotificationRow => Boolean(row))
      .map(mapOperatorNotificationRow)
      .filter(
        (row): row is ClaimedOperatorNotificationRecord =>
          row.leaseToken !== null && row.leaseExpiresAt !== null && row.lastAttemptAt !== null,
      );
  }

  async compareAndSetOperatorNotificationDeliveryStatus(
    transition: OperatorNotificationDeliveryTransition,
  ): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE operator_notifications
      SET delivery_status = ?, attempt_count = ?, last_attempt_at = ?, next_attempt_at = ?,
          failure_class = ?, lease_token = NULL, lease_expires_at = NULL,
          delivered_at = ?, last_error = ?
      WHERE id = ?
        AND lease_token = ?
    `).run(
      transition.deliveryStatus,
      transition.attemptCount,
      transition.lastAttemptAt,
      transition.nextAttemptAt,
      transition.failureClass,
      transition.deliveredAt,
      transition.lastError,
      transition.id,
      transition.leaseToken,
    );

    return result.changes > 0;
  }

  async listOperatorNotifications(exchangeAccountId: string, limit?: number): Promise<OperatorNotificationRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteOperatorNotificationRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteOperatorNotificationRow[]);

    return rows.map(mapOperatorNotificationRow);
  }

  async listOperatorNotificationDeliveryAttempts(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryAttemptRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notification_delivery_attempts
          WHERE exchange_account_id = ?
          ORDER BY attempted_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteOperatorNotificationDeliveryAttemptRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notification_delivery_attempts
          WHERE exchange_account_id = ?
          ORDER BY attempted_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteOperatorNotificationDeliveryAttemptRow[]);

    return rows.map(mapOperatorNotificationDeliveryAttemptRow);
  }

  async listOperatorNotificationDeliveryRuns(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryRunRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notification_delivery_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteOperatorNotificationDeliveryRunRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notification_delivery_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteOperatorNotificationDeliveryRunRow[]);

    return rows.map(mapOperatorNotificationDeliveryRunRow);
  }

  async listPendingOperatorNotifications(
    exchangeAccountId: string,
    options?: {
      limit?: number;
      dueBefore?: string;
    },
  ): Promise<OperatorNotificationRecord[]> {
    const dueBefore = options?.dueBefore ?? null;
    const rows = typeof options?.limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
          LIMIT ?
        `).all(exchangeAccountId, dueBefore, dueBefore, options.limit) as unknown as SqliteOperatorNotificationRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
        `).all(exchangeAccountId, dueBefore, dueBefore) as unknown as SqliteOperatorNotificationRow[]);

    return rows.map(mapOperatorNotificationRow);
  }

  private getStrategyDecisionByIdSync(id: string): StrategyDecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM strategy_decisions WHERE id = ? LIMIT 1")
      .get(id) as SqliteStrategyDecisionRow | undefined;
    return row ? mapStrategyDecisionRow(row) : null;
  }

  private getCandidateDeploymentById(id: string): PositionGuardPilotDeploymentRecord | null {
    const statement = this.db.prepare(`
      SELECT id, exchange_account_id, pilot_id, market, policy_id, policy_version,
        phase, activation_at, activation_epoch_ns, created_at, updated_at
      FROM strategy_pilot_deployments
      WHERE id = ?
      LIMIT 1
    `);
    statement.setReadBigInts(true);
    const row = statement.get(id) as SqliteCandidateDeploymentAuthorityRow | undefined;
    return row ? mapCandidateDeploymentAuthorityRow(row) : null;
  }

  private getCandidateStateVersion(deploymentId: string): number | null {
    const row = this.db.prepare(`
      SELECT state_version
      FROM strategy_candidate_states
      WHERE deployment_id = ?
      LIMIT 1
    `).get(deploymentId) as SqliteCandidateStateAuthorityRow | undefined;
    return row?.state_version ?? null;
  }

  private getCandidateBindingByOrderId(orderId: string): CandidateExecutionBindingRecord | null {
    return this.getCandidateBinding("order_id", orderId);
  }

  private getCandidateBindingById(id: string): CandidateExecutionBindingRecord | null {
    return this.getCandidateBinding("id", id);
  }

  private getCandidateBinding(
    column: "id" | "order_id",
    value: string,
  ): CandidateExecutionBindingRecord | null {
    const statement = this.db.prepare(`
      SELECT id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
        activation_at, activation_epoch_ns, market, strategy_key, policy_id, policy_version,
        execution_mode, ord_type, action, side, intended_quantity_exact,
        intended_notional_krw_exact, bound_price_exact, bound_volume_exact,
        bound_time_in_force, bound_smp_type, material_version, order_material_hash, created_at
      FROM strategy_candidate_execution_bindings
      WHERE ${column} = ?
      LIMIT 1
    `);
    statement.setReadBigInts(true);
    const row = statement.get(value) as SqliteCandidateBindingAuthorityRow | undefined;
    return row ? mapCandidateBindingAuthorityRow(row) : null;
  }

  private assertCandidateOrderUniqueness(order: OrderRecord): void {
    const identifier = this.db.prepare("SELECT id FROM orders WHERE identifier = ? LIMIT 1")
      .get(order.identifier) as { id: string } | undefined;
    if (identifier) {
      throw new Error(`Conflicting duplicate order identifier ${order.identifier}.`);
    }
    const idempotency = this.db.prepare(`
      SELECT id FROM orders
      WHERE exchange_account_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(order.exchangeAccountId, order.idempotencyKey) as { id: string } | undefined;
    if (idempotency) {
      throw new Error(`Conflicting duplicate order idempotency key ${order.idempotencyKey}.`);
    }
  }

  private insertOrder(record: OrderRecord): void {
    this.db.prepare(`
      INSERT INTO orders (
        id, strategy_decision_id, exchange_account_id, market, side, ord_type,
        volume, price, time_in_force, smp_type, identifier, idempotency_key,
        origin, requested_at, upbit_uuid, status, execution_mode,
        exchange_response_json, failure_code, failure_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.strategyDecisionId,
      record.exchangeAccountId,
      record.market,
      record.side,
      record.ordType,
      record.volume,
      record.price,
      record.timeInForce,
      record.smpType,
      record.identifier,
      record.idempotencyKey,
      record.origin,
      record.requestedAt,
      record.upbitUuid,
      record.status,
      record.executionMode,
      record.exchangeResponseJson,
      record.failureCode,
      record.failureMessage,
      record.createdAt,
      record.updatedAt,
    );
  }

  private insertCandidateBinding(binding: CandidateExecutionBindingRecord): void {
    this.db.prepare(`
      INSERT INTO strategy_candidate_execution_bindings (
        id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
        activation_at, activation_epoch_ns, market, strategy_key, policy_id, policy_version,
        execution_mode, ord_type, action, side, intended_quantity_exact,
        intended_notional_krw_exact, bound_price_exact, bound_volume_exact,
        bound_time_in_force, bound_smp_type, material_version, order_material_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.id,
      binding.deploymentId,
      binding.strategyDecisionId,
      binding.orderId,
      binding.exchangeAccountId,
      binding.activationAt,
      binding.activationEpochNs,
      binding.market,
      binding.strategyKey,
      binding.policyId,
      binding.policyVersion,
      binding.executionMode,
      binding.ordType,
      binding.action,
      binding.side,
      binding.intendedQuantity,
      binding.intendedNotionalKrw,
      binding.boundPrice,
      binding.boundVolume,
      binding.boundTimeInForce,
      binding.boundSmpType,
      binding.materialVersion,
      binding.orderMaterialHash,
      binding.createdAt,
    );
  }

  private getOrderById(id: string): OrderRecord | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ? LIMIT 1").get(id) as SqliteOrderRow | undefined;
    return row ? mapOrderRow(row) : null;
  }

  private getOrderEventById(id: string): OrderEventRecord | null {
    const row = this.db.prepare("SELECT * FROM order_events WHERE id = ? LIMIT 1").get(id) as SqliteOrderEventRow | undefined;
    return row ? mapOrderEventRow(row) : null;
  }

  private getOrderEventsForOrder(orderId: string): OrderEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(orderId) as unknown as SqliteOrderEventRow[];
    return rows.map(mapOrderEventRow);
  }

  private getFillByIdentity(fill: FillRecord): FillRecord | null {
    const rows = this.db.prepare(`
      SELECT * FROM fills
      WHERE id = ? OR (order_id = ? AND exchange_fill_id = ?)
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
      LIMIT 2
    `).all(fill.id, fill.orderId, fill.exchangeFillId, fill.id) as unknown as SqliteFillRow[];
    if (rows.length > 1 && !recordsEqual(mapFillRow(rows[0]!), mapFillRow(rows[1]!))) {
      throw new Error(`Conflicting fill identity ${fill.id}.`);
    }
    return rows[0] ? mapFillRow(rows[0]) : null;
  }

  private getFillsForOrder(orderId: string): FillRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM fills WHERE order_id = ? ORDER BY filled_at ASC, rowid ASC
    `).all(orderId) as unknown as SqliteFillRow[];
    return rows.map(mapFillRow);
  }

  async saveOrderSubmissionRecoveryObservation(
    record: OrderSubmissionRecoveryObservationRecord,
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO order_submission_recovery_observations (
        id, order_id, outcome, observed_at, observed_at_epoch_ms, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      record.id,
      record.orderId,
      record.outcome,
      record.observedAt,
      record.observedAtEpochMs,
      record.detailJson,
      record.createdAt,
    );
  }

  async listOrderSubmissionRecoveryObservations(
    orderId: string,
  ): Promise<OrderSubmissionRecoveryObservationRecord[]> {
    const rows = this.db.prepare(`
      SELECT id, order_id, outcome, observed_at, observed_at_epoch_ms, detail_json, created_at
      FROM order_submission_recovery_observations
      WHERE order_id = ?
      ORDER BY observed_at_epoch_ms ASC, id ASC
    `).all(orderId) as unknown as SqliteOrderSubmissionRecoveryObservationRow[];
    return rows.map(mapOrderSubmissionRecoveryObservationRow);
  }

  async finalizeBoundedSubmissionAbsence(
    input: FinalizeBoundedSubmissionAbsenceInput,
  ): Promise<boolean> {
    return withImmediateTransaction(this.db, () => {
      const currentOrder = this.getOrderById(input.orderId);
      if (
        !currentOrder ||
        currentOrder.status !== input.expectedStatus ||
        currentOrder.updatedAt !== input.expectedUpdatedAt
      ) {
        return false;
      }
      if (input.event.orderId !== currentOrder.id || input.faultPause.exchangeAccountId !== currentOrder.exchangeAccountId) {
        throw new Error("Bounded absence finalization provenance does not match the expected order.");
      }
      if (input.event.createdAt !== input.faultPause.occurredAt) {
        throw new Error("Bounded absence fault occurrence does not match its immutable event timestamp.");
      }
      if (this.getOrderEventById(input.event.id)) {
        throw new Error(`Conflicting bounded absence event ${input.event.id}.`);
      }
      validateFaultPauseInput(input.faultPause);
      const stateRow = this.db.prepare(`
        SELECT * FROM execution_state WHERE exchange_account_id = ? LIMIT 1
      `).get(currentOrder.exchangeAccountId) as SqliteExecutionStateRow | undefined;
      if (!stateRow) {
        throw new Error(`Execution state is missing for exchange account ${currentOrder.exchangeAccountId}.`);
      }
      const currentState = mapExecutionStateRow(stateRow);
      const transitionAt = validateFaultPauseTimestamp(input.faultPause, currentState);
      const orderUpdate = this.db.prepare(`
        UPDATE orders
        SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ?
        WHERE id = ? AND status = ? AND updated_at = ?
      `).run(
        input.failureCode,
        input.failureMessage,
        input.failedAt,
        input.orderId,
        input.expectedStatus,
        input.expectedUpdatedAt,
      );
      if (orderUpdate.changes !== 1) {
        return false;
      }
      this.insertOrderEvent(input.event);
      const reason = formatFaultPauseReason(input.faultPause);
      const preservesKillSwitch = currentState.killSwitchActive || currentState.systemStatus === "KILL_SWITCHED";
      const nextState: ExecutionStateRecord = {
        ...currentState,
        systemStatus: preservesKillSwitch ? "KILL_SWITCHED" : "PAUSED",
        pauseReason: preservesKillSwitch ? currentState.pauseReason : reason,
        updatedAt: transitionAt,
      };
      this.db.prepare(`
        UPDATE execution_state
        SET execution_mode = ?, live_execution_gate = ?, system_status = ?, kill_switch_active = ?,
            pause_reason = ?, degraded_reason = ?, degraded_at = ?, updated_at = ?
        WHERE exchange_account_id = ?
      `).run(
        nextState.executionMode,
        nextState.liveExecutionGate,
        nextState.systemStatus,
        toSqliteBoolean(nextState.killSwitchActive),
        nextState.pauseReason,
        nextState.degradedReason,
        nextState.degradedAt,
        nextState.updatedAt,
        nextState.exchangeAccountId,
      );
      recordExecutionStateTransition(this.db, {
        id: input.faultPause.faultId,
        exchangeAccountId: currentOrder.exchangeAccountId,
        command: "AUTOMATIC_PAUSE",
        fromExecutionMode: currentState.executionMode,
        toExecutionMode: nextState.executionMode,
        fromLiveExecutionGate: currentState.liveExecutionGate,
        toLiveExecutionGate: nextState.liveExecutionGate,
        fromSystemStatus: currentState.systemStatus,
        toSystemStatus: nextState.systemStatus,
        fromKillSwitchActive: currentState.killSwitchActive,
        toKillSwitchActive: nextState.killSwitchActive,
        reason,
        createdAt: transitionAt,
      });
      return true;
    });
  }

  async persistCandidateProjectionFault(
    input: PersistCandidateProjectionFaultInput,
  ): Promise<"APPLIED" | "DUPLICATE"> {
    return withImmediateTransaction(this.db, () => {
      const order = this.getOrderById(input.orderId);
      if (!order || input.event.orderId !== order.id || input.faultPause.exchangeAccountId !== order.exchangeAccountId) {
        throw new Error("Candidate projection fault provenance does not match a persisted order.");
      }
      if (input.event.createdAt !== input.faultPause.occurredAt) {
        throw new Error("Candidate projection fault occurrence does not match its immutable event timestamp.");
      }
      validateFaultPauseInput(input.faultPause);
      const existingEvent = this.getOrderEventById(input.event.id);
      if (existingEvent && !recordsEqual(existingEvent, input.event)) {
        throw new Error(`Conflicting candidate projection fault event ${input.event.id}.`);
      }
      const stateRow = this.db.prepare(`
        SELECT * FROM execution_state WHERE exchange_account_id = ? LIMIT 1
      `).get(order.exchangeAccountId) as SqliteExecutionStateRow | undefined;
      if (!stateRow) {
        throw new Error(`Execution state is missing for exchange account ${order.exchangeAccountId}.`);
      }
      const currentState = mapExecutionStateRow(stateRow);
      const reason = formatFaultPauseReason(input.faultPause);
      const existingTransitionRow = this.db.prepare(`
        SELECT * FROM execution_state_transitions WHERE id = ? LIMIT 1
      `).get(input.faultPause.faultId) as SqliteExecutionStateTransitionRow | undefined;
      let transitionAt = input.faultPause.transitionAt ?? input.faultPause.occurredAt;
      if (existingTransitionRow) {
        const existingTransition = mapExecutionStateTransitionRow(existingTransitionRow);
        if (
          existingTransition.command !== "AUTOMATIC_PAUSE" ||
          existingTransition.exchangeAccountId !== order.exchangeAccountId ||
          existingTransition.reason !== reason ||
          !faultPauseTransitionMatchesOccurrence(input.faultPause, existingTransition.createdAt)
        ) {
          throw new Error(`Conflicting duplicate automatic pause ${input.faultPause.faultId}.`);
        }
      } else {
        transitionAt = validateFaultPauseTimestamp(input.faultPause, currentState);
      }
      const preservesKillSwitch = currentState.killSwitchActive || currentState.systemStatus === "KILL_SWITCHED";
      const nextState: ExecutionStateRecord = {
        ...currentState,
        systemStatus: preservesKillSwitch ? "KILL_SWITCHED" : "PAUSED",
        pauseReason: preservesKillSwitch ? currentState.pauseReason : reason,
        updatedAt: existingTransitionRow ? currentState.updatedAt : transitionAt,
      };
      if (!existingEvent) {
        this.insertOrderEvent(input.event);
      }
      this.db.prepare(`
        UPDATE execution_state
        SET execution_mode = ?, live_execution_gate = ?, system_status = ?, kill_switch_active = ?,
            pause_reason = ?, degraded_reason = ?, degraded_at = ?, updated_at = ?
        WHERE exchange_account_id = ?
      `).run(
        nextState.executionMode,
        nextState.liveExecutionGate,
        nextState.systemStatus,
        toSqliteBoolean(nextState.killSwitchActive),
        nextState.pauseReason,
        nextState.degradedReason,
        nextState.degradedAt,
        nextState.updatedAt,
        nextState.exchangeAccountId,
      );
      if (!existingTransitionRow) {
        recordExecutionStateTransition(this.db, {
          id: input.faultPause.faultId,
          exchangeAccountId: order.exchangeAccountId,
          command: "AUTOMATIC_PAUSE",
          fromExecutionMode: currentState.executionMode,
          toExecutionMode: nextState.executionMode,
          fromLiveExecutionGate: currentState.liveExecutionGate,
          toLiveExecutionGate: nextState.liveExecutionGate,
          fromSystemStatus: currentState.systemStatus,
          toSystemStatus: nextState.systemStatus,
          fromKillSwitchActive: currentState.killSwitchActive,
          toKillSwitchActive: nextState.killSwitchActive,
          reason,
          createdAt: transitionAt,
        });
      }
      return existingEvent ? "DUPLICATE" : "APPLIED";
    });
  }

  private getRiskEventById(id: string): RiskEventRecord | null {
    const row = this.db.prepare("SELECT * FROM risk_events WHERE id = ? LIMIT 1").get(id) as SqliteRiskEventRow | undefined;
    return row ? mapRiskEventRow(row) : null;
  }

  private getRiskEventsForOrder(orderId: string): RiskEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM risk_events WHERE order_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(orderId) as unknown as SqliteRiskEventRow[];
    return rows.map(mapRiskEventRow);
  }

  private upsertOrder(record: OrderRecord): void {
    this.db.prepare(`
      INSERT INTO orders (
        id, strategy_decision_id, exchange_account_id, market, side, ord_type,
        volume, price, time_in_force, smp_type, identifier, idempotency_key,
        origin, requested_at, upbit_uuid, status, execution_mode,
        exchange_response_json, failure_code, failure_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        strategy_decision_id = excluded.strategy_decision_id,
        exchange_account_id = excluded.exchange_account_id,
        market = excluded.market,
        side = excluded.side,
        ord_type = excluded.ord_type,
        volume = excluded.volume,
        price = excluded.price,
        time_in_force = excluded.time_in_force,
        smp_type = excluded.smp_type,
        identifier = excluded.identifier,
        idempotency_key = excluded.idempotency_key,
        origin = excluded.origin,
        requested_at = excluded.requested_at,
        upbit_uuid = excluded.upbit_uuid,
        status = excluded.status,
        execution_mode = excluded.execution_mode,
        exchange_response_json = excluded.exchange_response_json,
        failure_code = excluded.failure_code,
        failure_message = excluded.failure_message,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.strategyDecisionId,
      record.exchangeAccountId,
      record.market,
      record.side,
      record.ordType,
      record.volume,
      record.price,
      record.timeInForce,
      record.smpType,
      record.identifier,
      record.idempotencyKey,
      record.origin,
      record.requestedAt,
      record.upbitUuid,
      record.status,
      record.executionMode,
      record.exchangeResponseJson,
      record.failureCode,
      record.failureMessage,
      record.createdAt,
      record.updatedAt,
    );
  }
}

export class SqliteOperatorStateStore implements OperatorStateStore {
  constructor(
    private readonly db: import("node:sqlite").DatabaseSync,
    private readonly exchangeAccountId: string,
  ) {}

  async getState(): Promise<ExecutionStateRecord> {
    const row = this.db.prepare(`
      SELECT * FROM execution_state
      WHERE exchange_account_id = ?
      LIMIT 1
    `).get(this.exchangeAccountId) as SqliteExecutionStateRow | undefined;

    if (!row) {
      throw new Error(`Execution state is missing for exchange account ${this.exchangeAccountId}.`);
    }

    return mapExecutionStateRow(row);
  }

  async listTransitions(limit = 20): Promise<ExecutionStateTransitionRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM execution_state_transitions
      WHERE exchange_account_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(this.exchangeAccountId, limit) as unknown as SqliteExecutionStateTransitionRow[];

    return rows.map(mapExecutionStateTransitionRow);
  }

  async getTransitionById(id: string): Promise<ExecutionStateTransitionRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM execution_state_transitions
      WHERE exchange_account_id = ? AND id = ?
      LIMIT 1
    `).get(this.exchangeAccountId, id) as SqliteExecutionStateTransitionRow | undefined;
    return row ? mapExecutionStateTransitionRow(row) : null;
  }

  async pauseForFault(input: FaultPauseInput): Promise<ExecutionStateRecord> {
    validateFaultPauseInput(input);
    if (input.exchangeAccountId !== this.exchangeAccountId) {
      throw new Error(`Fault ${input.faultId} is for a different exchange account.`);
    }

    return withImmediateTransaction(this.db, () => {
      const current = this.getStateSync();
      const reason = formatFaultPauseReason(input);
      const existingRow = this.db.prepare(`
        SELECT * FROM execution_state_transitions WHERE id = ? LIMIT 1
      `).get(input.faultId) as SqliteExecutionStateTransitionRow | undefined;
      if (existingRow) {
        const existing = mapExecutionStateTransitionRow(existingRow);
        if (
          existing.command === "AUTOMATIC_PAUSE" &&
          existing.exchangeAccountId === input.exchangeAccountId &&
          existing.reason === reason &&
          faultPauseTransitionMatchesOccurrence(input, existing.createdAt) &&
          (current.systemStatus === "PAUSED" || current.systemStatus === "KILL_SWITCHED")
        ) {
          return current;
        }
        throw new Error(`Conflicting duplicate automatic pause ${input.faultId}.`);
      }
      const transitionAt = validateFaultPauseTimestamp(input, current);

      const preservesKillSwitch = current.killSwitchActive || current.systemStatus === "KILL_SWITCHED";
      const nextState: ExecutionStateRecord = {
        ...current,
        systemStatus: preservesKillSwitch ? "KILL_SWITCHED" : "PAUSED",
        pauseReason: preservesKillSwitch ? current.pauseReason : reason,
        updatedAt: transitionAt,
      };
      this.writeState(nextState);
      recordExecutionStateTransition(this.db, {
        id: input.faultId,
        exchangeAccountId: input.exchangeAccountId,
        command: "AUTOMATIC_PAUSE",
        fromExecutionMode: current.executionMode,
        toExecutionMode: nextState.executionMode,
        fromLiveExecutionGate: current.liveExecutionGate,
        toLiveExecutionGate: nextState.liveExecutionGate,
        fromSystemStatus: current.systemStatus,
        toSystemStatus: nextState.systemStatus,
        fromKillSwitchActive: current.killSwitchActive,
        toKillSwitchActive: nextState.killSwitchActive,
        reason,
        createdAt: transitionAt,
      });
      return nextState;
    });
  }

  async pause(reason?: string): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    return this.updateState(
      current,
      {
        systemStatus: current.killSwitchActive ? "KILL_SWITCHED" : "PAUSED",
        pauseReason: reason ?? current.pauseReason,
      },
      "/pause",
      reason ?? current.pauseReason,
    );
  }

  async resume(): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    return this.updateState(
      current,
      {
        systemStatus: resolveResumedSystemStatus(current),
        pauseReason: null,
      },
      "/resume",
      null,
    );
  }

  async activateKillSwitch(reason?: string): Promise<ExecutionStateRecord> {
    return this.updateState(
      await this.getState(),
      {
        killSwitchActive: true,
        systemStatus: "KILL_SWITCHED",
        pauseReason: reason ?? "killswitch_activated",
      },
      "/killswitch",
      reason ?? "killswitch_activated",
    );
  }

  async setExecutionMode(mode: ExecutionStateRecord["executionMode"]): Promise<ExecutionStateRecord> {
    return this.updateState(
      await this.getState(),
      { executionMode: mode },
      "SET_EXECUTION_MODE",
      mode,
    );
  }

  async setLiveExecutionGate(gate: ExecutionStateRecord["liveExecutionGate"]): Promise<ExecutionStateRecord> {
    return this.updateState(
      await this.getState(),
      { liveExecutionGate: gate },
      "SET_LIVE_EXECUTION_GATE",
      gate,
    );
  }

  async markDegraded(reason?: string): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    const degradedReason = reason ?? current.degradedReason ?? "startup_portfolio_drift_detected";
    const degradedAt = current.degradedAt ?? new Date().toISOString();

    return this.updateState(
      current,
      {
        systemStatus: resolveSystemStatusForDegradation(current),
        degradedReason,
        degradedAt,
      },
      "MARK_DEGRADED",
      degradedReason,
    );
  }

  async clearDegraded(reason?: string): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    return this.updateState(
      current,
      {
        systemStatus: current.systemStatus === "DEGRADED" ? "RUNNING" : current.systemStatus,
        degradedReason: null,
        degradedAt: null,
      },
      "CLEAR_DEGRADED",
      reason ?? "startup_recovery_clean",
    );
  }

  private async updateState(
    current: ExecutionStateRecord,
    changes: Partial<
      Pick<
        ExecutionStateRecord,
        | "executionMode"
        | "liveExecutionGate"
        | "systemStatus"
        | "killSwitchActive"
        | "pauseReason"
        | "degradedReason"
        | "degradedAt"
      >
    >,
    command: ExecutionStateTransitionRecord["command"],
    reason: string | null,
  ): Promise<ExecutionStateRecord> {
    const nextState: ExecutionStateRecord = {
      ...current,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    this.writeState(nextState);

    recordExecutionStateTransition(this.db, {
      id: createId("execution_state_transition"),
      exchangeAccountId: this.exchangeAccountId,
      command,
      fromExecutionMode: current.executionMode,
      toExecutionMode: nextState.executionMode,
      fromLiveExecutionGate: current.liveExecutionGate,
      toLiveExecutionGate: nextState.liveExecutionGate,
      fromSystemStatus: current.systemStatus,
      toSystemStatus: nextState.systemStatus,
      fromKillSwitchActive: current.killSwitchActive,
      toKillSwitchActive: nextState.killSwitchActive,
      reason,
      createdAt: nextState.updatedAt,
    });

    return nextState;
  }

  private getStateSync(): ExecutionStateRecord {
    const row = this.db.prepare(`
      SELECT * FROM execution_state
      WHERE exchange_account_id = ?
      LIMIT 1
    `).get(this.exchangeAccountId) as SqliteExecutionStateRow | undefined;
    if (!row) {
      throw new Error(`Execution state is missing for exchange account ${this.exchangeAccountId}.`);
    }
    return mapExecutionStateRow(row);
  }

  private writeState(nextState: ExecutionStateRecord): void {
    this.db.prepare(`
      UPDATE execution_state
      SET execution_mode = ?, live_execution_gate = ?, system_status = ?,
          kill_switch_active = ?, pause_reason = ?, degraded_reason = ?, degraded_at = ?, updated_at = ?
      WHERE exchange_account_id = ?
    `).run(
      nextState.executionMode,
      nextState.liveExecutionGate,
      nextState.systemStatus,
      toSqliteBoolean(nextState.killSwitchActive),
      nextState.pauseReason,
      nextState.degradedReason,
      nextState.degradedAt,
      nextState.updatedAt,
      this.exchangeAccountId,
    );
  }
}

export class SqliteTelegramInboundOffsetStore implements TelegramInboundOffsetStore {
  constructor(private readonly db: import("node:sqlite").DatabaseSync) {}

  async getTelegramInboundOffset(input: {
    exchangeAccountId: string;
    updateSource: TelegramInboundOffsetRecord["updateSource"];
    botTokenRef: string;
  }): Promise<TelegramInboundOffsetRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM telegram_inbound_offsets
      WHERE exchange_account_id = ? AND update_source = ? AND bot_token_ref = ?
      LIMIT 1
    `).get(
      input.exchangeAccountId,
      input.updateSource,
      input.botTokenRef,
    ) as SqliteTelegramInboundOffsetRow | undefined;

    return row ? mapTelegramInboundOffsetRow(row) : null;
  }

  async saveTelegramInboundOffset(record: TelegramInboundOffsetRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO telegram_inbound_offsets (
        id, exchange_account_id, update_source, bot_token_ref, next_offset, last_update_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_account_id, update_source, bot_token_ref) DO UPDATE SET
        id = excluded.id,
        next_offset = excluded.next_offset,
        last_update_id = excluded.last_update_id,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.updateSource,
      record.botTokenRef,
      record.nextOffset,
      record.lastUpdateId,
      record.updatedAt,
    );
  }
}

function assertSameAccount(existing: OrderRecord, next: OrderRecord): void {
  if (existing.exchangeAccountId !== next.exchangeAccountId) {
    throw new Error(`Order ${next.id} cannot change exchange account.`);
  }
}

function assertNoConflictingRecord<T extends { id: string }>(
  existing: T | null,
  next: T,
  label: string,
): void {
  if (existing && !recordsEqual(existing, next)) {
    throw new Error(`Conflicting duplicate ${label} ${next.id}.`);
  }
}

function formatFaultPauseReason(input: FaultPauseInput): string {
  return `faultId=${input.faultId}; reason=${input.reason}`;
}

function resolveResumedSystemStatus(current: ExecutionStateRecord): ExecutionStateRecord["systemStatus"] {
  if (current.killSwitchActive) {
    return "KILL_SWITCHED";
  }

  if (current.degradedReason || current.degradedAt) {
    return "DEGRADED";
  }

  return "RUNNING";
}

function resolveSystemStatusForDegradation(
  current: ExecutionStateRecord,
): ExecutionStateRecord["systemStatus"] {
  if (current.killSwitchActive || current.systemStatus === "KILL_SWITCHED") {
    return "KILL_SWITCHED";
  }

  if (current.systemStatus === "PAUSED") {
    return "PAUSED";
  }

  return "DEGRADED";
}

function ensureBootstrapRecords(
  db: import("node:sqlite").DatabaseSync,
  input: {
    user: UserRecord;
    exchangeAccount: ExchangeAccountRecord;
    executionState: ExecutionStateRecord;
  },
): boolean {
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, telegram_user_id, telegram_chat_id, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.user.id,
    input.user.telegramUserId,
    input.user.telegramChatId,
    input.user.displayName,
    input.user.createdAt,
    input.user.updatedAt,
  );

  db.prepare(`
    INSERT OR IGNORE INTO exchange_accounts (
      id, user_id, exchange, venue_type, account_label,
      access_key_ref, secret_key_ref, quote_currency, is_primary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.exchangeAccount.id,
    input.exchangeAccount.userId,
    input.exchangeAccount.exchange,
    input.exchangeAccount.venueType,
    input.exchangeAccount.accountLabel,
    input.exchangeAccount.accessKeyRef,
    input.exchangeAccount.secretKeyRef,
    input.exchangeAccount.quoteCurrency,
    toSqliteBoolean(input.exchangeAccount.isPrimary),
    input.exchangeAccount.createdAt,
    input.exchangeAccount.updatedAt,
  );

  const result = db.prepare(`
    INSERT OR IGNORE INTO execution_state (
      id, exchange_account_id, execution_mode, live_execution_gate,
      system_status, kill_switch_active, pause_reason, degraded_reason, degraded_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.executionState.id,
    input.executionState.exchangeAccountId,
    input.executionState.executionMode,
    input.executionState.liveExecutionGate,
    input.executionState.systemStatus,
    toSqliteBoolean(input.executionState.killSwitchActive),
    input.executionState.pauseReason,
    input.executionState.degradedReason,
    input.executionState.degradedAt,
    input.executionState.updatedAt,
  );

  return result.changes > 0;
}

function mapExecutionStateRow(row: SqliteExecutionStateRow): ExecutionStateRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    executionMode: row.execution_mode,
    liveExecutionGate: row.live_execution_gate,
    systemStatus: row.system_status,
    killSwitchActive: fromSqliteBoolean(row.kill_switch_active),
    pauseReason: row.pause_reason,
    degradedReason: row.degraded_reason,
    degradedAt: row.degraded_at,
    updatedAt: row.updated_at,
  };
}

function mapExecutionStateTransitionRow(
  row: SqliteExecutionStateTransitionRow,
): ExecutionStateTransitionRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    command: row.command,
    fromExecutionMode: row.from_execution_mode,
    toExecutionMode: row.to_execution_mode,
    fromLiveExecutionGate: row.from_live_execution_gate,
    toLiveExecutionGate: row.to_live_execution_gate,
    fromSystemStatus: row.from_system_status,
    toSystemStatus: row.to_system_status,
    fromKillSwitchActive:
      row.from_kill_switch_active === null ? null : fromSqliteBoolean(row.from_kill_switch_active),
    toKillSwitchActive: fromSqliteBoolean(row.to_kill_switch_active),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapBalanceSnapshotRow(row: SqliteBalanceSnapshotRow): BalanceSnapshotRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    capturedAt: row.captured_at,
    source: row.source,
    totalKrwValue: row.total_krw_value,
    balancesJson: row.balances_json,
  };
}

function mapPositionSnapshotRow(row: SqlitePositionSnapshotRow): PositionSnapshotRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    capturedAt: row.captured_at,
    source: row.source,
    positionsJson: row.positions_json,
  };
}

function mapStrategyDecisionRow(row: SqliteStrategyDecisionRow): StrategyDecisionRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    strategyKey: row.strategy_key,
    market: row.market,
    action: row.action,
    status: row.status,
    decisionBasisJson: row.decision_basis_json,
    intendedNotionalKrw: row.intended_notional_krw,
    intendedQuantity: row.intended_quantity,
    referencePrice: row.reference_price,
    createdAt: row.created_at,
  };
}

function mapOrderRow(row: SqliteOrderRow): OrderRecord {
  return {
    id: row.id,
    strategyDecisionId: row.strategy_decision_id,
    exchangeAccountId: row.exchange_account_id,
    market: row.market,
    side: row.side,
    ordType: row.ord_type,
    volume: row.volume,
    price: row.price,
    timeInForce: row.time_in_force,
    smpType: row.smp_type,
    identifier: row.identifier,
    idempotencyKey: row.idempotency_key,
    origin: row.origin,
    requestedAt: row.requested_at,
    upbitUuid: row.upbit_uuid,
    status: row.status,
    executionMode: row.execution_mode,
    exchangeResponseJson: row.exchange_response_json,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFillRow(row: SqliteFillRow): FillRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    exchangeFillId: row.exchange_fill_id,
    market: row.market,
    side: row.side,
    price: row.price,
    volume: row.volume,
    feeCurrency: row.fee_currency,
    feeAmount: row.fee_amount,
    feeProvenance: row.fee_provenance,
    executionTimestampProvenance: row.execution_timestamp_provenance,
    executionEpochNs: row.execution_epoch_ns,
    filledAt: row.filled_at,
    rawPayloadJson: row.raw_payload_json,
  };
}

function mapOrderSubmissionRecoveryObservationRow(
  row: SqliteOrderSubmissionRecoveryObservationRow,
): OrderSubmissionRecoveryObservationRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    outcome: row.outcome,
    observedAt: row.observed_at,
    observedAtEpochMs: row.observed_at_epoch_ms,
    detailJson: row.detail_json,
    createdAt: row.created_at,
  };
}

function mapOrderEventRow(row: SqliteOrderEventRow): OrderEventRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    eventType: row.event_type,
    eventSource: row.event_source,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapCandidateDeploymentAuthorityRow(
  row: SqliteCandidateDeploymentAuthorityRow,
): PositionGuardPilotDeploymentRecord {
  return validateCandidatePilotDeployment({
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    pilotId: row.pilot_id,
    market: row.market,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    phase: row.phase,
    activationAt: row.activation_at,
    activationEpochNs: row.activation_epoch_ns === null ? null : BigInt(row.activation_epoch_ns),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapCandidateBindingAuthorityRow(
  row: SqliteCandidateBindingAuthorityRow,
): CandidateExecutionBindingRecord {
  if (row.material_version !== "BINDING_V2" || row.order_material_hash === null) {
    throw new Error("Legacy candidate execution binding cannot authorize an order intent retry.");
  }
  return validateCandidateExecutionBinding({
    id: row.id,
    deploymentId: row.deployment_id,
    strategyDecisionId: row.strategy_decision_id,
    orderId: row.order_id,
    exchangeAccountId: row.exchange_account_id,
    activationAt: row.activation_at,
    activationEpochNs: BigInt(row.activation_epoch_ns),
    market: row.market,
    strategyKey: row.strategy_key,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    executionMode: row.execution_mode,
    ordType: row.ord_type,
    action: row.action,
    side: row.side,
    intendedQuantity: row.intended_quantity_exact,
    intendedNotionalKrw: row.intended_notional_krw_exact,
    boundPrice: row.bound_price_exact,
    boundVolume: row.bound_volume_exact,
    boundTimeInForce: row.bound_time_in_force,
    boundSmpType: row.bound_smp_type,
    materialVersion: row.material_version,
    orderMaterialHash: row.order_material_hash,
    createdAt: row.created_at,
  });
}

function mapRiskEventRow(row: SqliteRiskEventRow): RiskEventRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    strategyDecisionId: row.strategy_decision_id,
    orderId: row.order_id,
    level: row.level,
    ruleCode: row.rule_code,
    message: row.message,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapReconciliationRunRow(row: SqliteReconciliationRunRow): ReconciliationRunRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summaryJson: row.summary_json,
    errorMessage: row.error_message,
  };
}

function mapHistoryRecoveryCheckpointRow(
  row: SqliteHistoryRecoveryCheckpointRow,
): HistoryRecoveryCheckpointRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    market: row.market,
    checkpointType: row.checkpoint_type,
    nextWindowEndAt: row.next_window_end_at,
    updatedAt: row.updated_at,
  };
}

function mapOperatorNotificationRow(row: SqliteOperatorNotificationRow): OperatorNotificationRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    channel: row.channel,
    notificationType: row.notification_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    payloadJson: row.payload_json,
    deliveryStatus: row.delivery_status,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    failureClass: row.failure_class,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  };
}

function mapOperatorNotificationDeliveryAttemptRow(
  row: SqliteOperatorNotificationDeliveryAttemptRow,
): OperatorNotificationDeliveryAttemptRecord {
  return {
    id: row.id,
    notificationId: row.notification_id,
    exchangeAccountId: row.exchange_account_id,
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    outcome: row.outcome,
    failureClass: row.failure_class,
    attemptedAt: row.attempted_at,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function mapOperatorNotificationDeliveryRunRow(
  row: SqliteOperatorNotificationDeliveryRunRow,
): OperatorNotificationDeliveryRunRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    workerName: row.worker_name,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    attemptedCount: row.attempted_count,
    sentCount: row.sent_count,
    retryScheduledCount: row.retry_scheduled_count,
    failedCount: row.failed_count,
    staleLeaseCount: row.stale_lease_count,
    pendingTotalCount: row.pending_total_count,
    pendingDueCount: row.pending_due_count,
    pendingScheduledCount: row.pending_scheduled_count,
    activeLeaseCount: row.active_lease_count,
    expiredLeaseCount: row.expired_lease_count,
    abandonedLeaseCandidateCount: row.abandoned_lease_candidate_count,
    skippedReason: row.skipped_reason,
    errorMessage: row.error_message,
    summaryJson: row.summary_json,
  };
}

function mapStrategySchedulerRunRow(
  row: SqliteStrategySchedulerRunRow,
): StrategySchedulerRunRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    market: row.market,
    triggerSource: row.trigger_source,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    intervalMs: row.interval_ms,
    runOnStart: fromSqliteBoolean(row.run_on_start),
    strategyDecisionId: row.strategy_decision_id,
    action: row.action,
    orderId: row.order_id,
    orderStatus: row.order_status,
    submissionAccepted: row.submission_accepted === null ? null : fromSqliteBoolean(row.submission_accepted),
    detail: row.detail,
    errorMessage: row.error_message,
    summaryJson: row.summary_json,
  };
}

function mapTelegramInboundOffsetRow(
  row: SqliteTelegramInboundOffsetRow,
): TelegramInboundOffsetRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    updateSource: row.update_source,
    botTokenRef: row.bot_token_ref,
    nextOffset: row.next_offset,
    lastUpdateId: row.last_update_id,
    updatedAt: row.updated_at,
  };
}

function validateCandidateOrderReadLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Candidate submission-blocking order read limit must be a positive safe integer.");
  }
}

function recordExecutionStateTransition(
  db: import("node:sqlite").DatabaseSync,
  record: ExecutionStateTransitionRecord,
): void {
  db.prepare(`
    INSERT INTO execution_state_transitions (
      id, exchange_account_id, command,
      from_execution_mode, to_execution_mode,
      from_live_execution_gate, to_live_execution_gate,
      from_system_status, to_system_status,
      from_kill_switch_active, to_kill_switch_active,
      reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.exchangeAccountId,
    record.command,
    record.fromExecutionMode,
    record.toExecutionMode,
    record.fromLiveExecutionGate,
    record.toLiveExecutionGate,
    record.fromSystemStatus,
    record.toSystemStatus,
    record.fromKillSwitchActive === null ? null : toSqliteBoolean(record.fromKillSwitchActive),
    toSqliteBoolean(record.toKillSwitchActive),
    record.reason,
    record.createdAt,
  );
}
