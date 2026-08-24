import type {
  BalanceSnapshotRecord,
  ClaimedOperatorNotificationRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
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
  StrategySchedulerRunRecord,
  SupportedAsset,
  SupportedMarket,
  TelegramInboundOffsetRecord,
} from "../../../domain/types.js";
import type {
  CandidateExecutionBindingRecord,
  OrderSubmissionRecoveryObservationRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../../domain/pilot-types.js";
import type {
  ExecutionRepository,
  FinalizeBoundedSubmissionAbsenceInput,
  FaultPauseInput,
  PersistCandidateProjectionFaultInput,
  OperatorStateStore,
  PersistExchangeSubmissionInput,
  InMemoryCandidateBoundOrderStore,
  PersistCandidateBoundOrderIntentInput,
  PersistCandidateBoundOrderIntentRequest,
  PersistOrderIntentInput,
  PersistReconciledExchangeSnapshotInput,
  PersistReconciledExchangeSnapshotResult,
  PersistUncertainSubmissionInput,
  TelegramInboundOffsetStore,
} from "../interfaces.js";
import {
  matchesCandidatePilotRollbackOperatorState,
  validateCandidatePilotRollbackOperatorState,
  type CandidatePilotRollbackOperatorState,
  type InMemoryCandidatePilotRollbackAuthorityResult,
} from "../pilot-interfaces.js";
import {
  validateCandidateBoundOrderIntent,
  validateCandidateBoundOrderIntentRequestShape,
} from "./candidate-bound-order-validation.js";
import {
  recordsEqual,
  faultPauseTransitionMatchesOccurrence,
  normalizeFillFeeProvenance,
  resolveImmutableFillReplay,
  validateExchangeSubmissionInput,
  validateFaultPauseInput,
  validateFaultPauseTimestamp,
  validateExchangeSubmissionCompletion,
  validateNewOrderUniqueness,
  validateOrderIntentInput,
  validateFillForOrder,
  validateReconciledExchangeSnapshotInput,
  validateUncertainSubmissionCompletion,
  validateUncertainSubmissionInput,
} from "./atomic-lifecycle-validation.js";

const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderLifecycleStatus> = new Set([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);
const CANDIDATE_SUBMISSION_BLOCKING_STATUSES: ReadonlySet<OrderLifecycleStatus> = new Set([
  ...ACTIVE_ORDER_STATUSES,
  "FAILED",
  "REJECTED",
]);

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly strategyDecisions: StrategyDecisionRecord[] = [];
  private orders: OrderRecord[] = [];
  private orderEvents: OrderEventRecord[] = [];
  private fills: FillRecord[] = [];
  private readonly orderSubmissionRecoveryObservations: OrderSubmissionRecoveryObservationRecord[] = [];
  private readonly balanceSnapshots: BalanceSnapshotRecord[] = [];
  private readonly positionSnapshots: PositionSnapshotRecord[] = [];
  private riskEvents: RiskEventRecord[] = [];
  private readonly reconciliationRuns: ReconciliationRunRecord[] = [];
  private readonly strategySchedulerRuns: StrategySchedulerRunRecord[] = [];
  private readonly historyRecoveryCheckpoints: HistoryRecoveryCheckpointRecord[] = [];
  private readonly operatorNotifications: OperatorNotificationRecord[] = [];
  private readonly operatorNotificationDeliveryAttempts: OperatorNotificationDeliveryAttemptRecord[] = [];
  private readonly operatorNotificationDeliveryRuns: OperatorNotificationDeliveryRunRecord[] = [];

  constructor(
    private readonly atomicFaultPauseStore?: Pick<InMemoryOperatorStateStore, "applyFaultPauseAtomically">,
    private readonly candidateBoundOrderStore?: InMemoryCandidateBoundOrderStore,
  ) {}

  async saveStrategyDecision(record: StrategyDecisionRecord): Promise<void> {
    this.strategyDecisions.push(record);
  }

  async getLatestStrategyDecision(
    exchangeAccountId: string,
    market: SupportedMarket,
    strategyKey?: string,
  ): Promise<StrategyDecisionRecord | null> {
    return (
      [...this.strategyDecisions]
        .filter((candidate) =>
          candidate.exchangeAccountId === exchangeAccountId &&
          candidate.market === market &&
          (strategyKey === undefined || candidate.strategyKey === strategyKey),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
    );
  }

  async saveOrder(record: OrderRecord): Promise<void> {
    this.orders.push(cloneRecord(record));
  }

  async updateOrder(record: OrderRecord): Promise<void> {
    const index = this.orders.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.orders.push(cloneRecord(record));
      return;
    }

    this.orders[index] = cloneRecord(record);
  }

  async getStrategyDecisionById(id: string): Promise<StrategyDecisionRecord | null> {
    const decision = this.strategyDecisions.find((candidate) => candidate.id === id);
    return decision ? cloneRecord(decision) : null;
  }

  async persistOrderIntent(input: PersistOrderIntentInput): Promise<void> {
    validateOrderIntentInput(input);
    const existingOrder = this.orders.find((candidate) => candidate.id === input.order.id);
    const existingEvent = this.orderEvents.find((candidate) => candidate.id === input.event.id);

    if (existingOrder) {
      if (!recordsEqual(existingOrder, input.order) || !existingEvent || !recordsEqual(existingEvent, input.event)) {
        throw new Error(`Conflicting duplicate order intent ${input.order.id}.`);
      }
      return;
    }
    if (existingEvent) {
      throw new Error(`Conflicting duplicate order event ${input.event.id}.`);
    }
    validateNewOrderUniqueness(this.orders, input.order);

    const nextOrders = [...this.orders, cloneRecord(input.order)];
    const nextOrderEvents = [...this.orderEvents, cloneRecord(input.event)];
    this.orders = nextOrders;
    this.orderEvents = nextOrderEvents;
  }

  async persistCandidateBoundOrderIntent(input: PersistCandidateBoundOrderIntentRequest): Promise<void> {
    validateCandidateBoundOrderIntentRequestShape(input);
    if (!this.candidateBoundOrderStore) {
      throw new Error("In-memory candidate-bound order store is required.");
    }
    const decision = this.strategyDecisions.find((candidate) => candidate.id === input.order.strategyDecisionId);
    const prepared = this.candidateBoundOrderStore.prepareCandidateBoundOrderIntent(input.binding);
    if (!decision) {
      throw new Error(`Persisted candidate strategy decision ${input.order.strategyDecisionId ?? "none"} is missing.`);
    }
    if (!prepared.deployment || prepared.exactStateVersion === null) {
      throw new Error(`Persisted candidate authority ${input.binding.deploymentId} is missing.`);
    }
    const aggregate: PersistCandidateBoundOrderIntentInput = {
      order: input.order,
      event: input.event,
      binding: input.binding,
      decision: cloneRecord(decision),
      deployment: prepared.deployment,
      exactStateVersion: prepared.exactStateVersion,
      expectedPhase: input.expectedPhase,
      expectedDeploymentUpdatedAt: input.expectedDeploymentUpdatedAt,
      expectedStateVersion: input.expectedStateVersion,
    };
    validateCandidateBoundOrderIntent(aggregate);

    const existingOrdersById = this.orders.filter((candidate) => candidate.id === input.order.id);
    const existingEventsById = this.orderEvents.filter((candidate) => candidate.id === input.event.id);
    const existingOrder = existingOrdersById[0] ?? null;
    const existingEventById = existingEventsById[0] ?? null;
    const existingOrderEvents = this.orderEvents.filter((candidate) => candidate.orderId === input.order.id);
    const existingBindingByOrder = prepared.existingBindingByOrderId;
    const existingBindingById = prepared.existingBindingById;

    if (existingOrdersById.length > 1) {
      throw new Error(`Conflicting duplicate candidate-bound order id ${input.order.id}.`);
    }
    if (existingEventsById.length > 1) {
      throw new Error(`Conflicting duplicate candidate-bound order event id ${input.event.id}.`);
    }
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
      prepared.commitBinding();
      return;
    }

    validateNewOrderUniqueness(this.orders, input.order);
    const nextOrders = [...this.orders, cloneRecord(input.order)];
    const nextOrderEvents = [...this.orderEvents, cloneRecord(input.event)];
    const bindingClone = cloneCandidateBinding(input.binding);
    if (!recordsEqual(bindingClone, input.binding)) {
      throw new Error("Candidate-bound binding clone changed material.");
    }

    prepared.commitBinding();
    this.orders = nextOrders;
    this.orderEvents = nextOrderEvents;
  }

  async persistExchangeSubmission(input: PersistExchangeSubmissionInput): Promise<void> {
    const normalizedInput = {
      ...input,
      fills: input.fills.map(normalizeFillFeeProvenance),
    };
    validateExchangeSubmissionInput(normalizedInput);
    const existingOrder = this.orders.find((candidate) => candidate.id === normalizedInput.order.id);
    if (!existingOrder) {
      throw new Error(`Cannot persist exchange submission for missing order ${normalizedInput.order.id}.`);
    }
    assertSameAccount(existingOrder, normalizedInput.order);
    const existingEvent = this.orderEvents.find((candidate) => candidate.id === normalizedInput.event.id);
    assertNoConflictingRecord(existingEvent, normalizedInput.event, "order event");
    if (normalizedInput.terminalEvent) {
      const existingTerminalEvent = this.orderEvents.find((candidate) => candidate.id === normalizedInput.terminalEvent!.id);
      assertNoConflictingRecord(existingTerminalEvent, normalizedInput.terminalEvent, "terminal order event");
    }
    const existingFills = normalizedInput.fills.map((fill) => findStoredFill(this.fills, fill));
    normalizedInput.fills.forEach((fill, index) => assertNoConflictingRecord(existingFills[index], fill, "fill"));

    const completion = validateExchangeSubmissionCompletion(
      existingOrder,
      normalizedInput.order,
      normalizedInput,
      this.orderEvents.filter((candidate) => candidate.orderId === normalizedInput.order.id),
      this.fills.filter((candidate) => candidate.orderId === normalizedInput.order.id),
    );
    if (completion === "RETRY") {
      return;
    }

    const nextOrders = this.orders.map((candidate) =>
      candidate.id === normalizedInput.order.id ? cloneRecord(normalizedInput.order) : candidate,
    );
    const nextOrderEvents = [
      ...this.orderEvents,
      cloneRecord(normalizedInput.event),
      ...(normalizedInput.terminalEvent ? [cloneRecord(normalizedInput.terminalEvent)] : []),
    ];
    const nextFills = [...this.fills, ...normalizedInput.fills.map(cloneRecord)];
    this.orders = nextOrders;
    this.orderEvents = nextOrderEvents;
    this.fills = nextFills;
  }

  async persistReconciledExchangeSnapshot(
    input: PersistReconciledExchangeSnapshotInput,
  ): Promise<PersistReconciledExchangeSnapshotResult> {
    const normalizedInput = {
      ...input,
      fills: input.fills.map(normalizeFillFeeProvenance),
    };
    validateReconciledExchangeSnapshotInput(normalizedInput);
    const currentOrder = this.orders.find((candidate) => candidate.id === normalizedInput.order.id);
    if (!currentOrder) {
      throw new Error(`Cannot persist reconciliation for missing order ${normalizedInput.order.id}.`);
    }
    if (!recordsEqual(currentOrder, normalizedInput.expectedOrder)) {
      throw new Error(`Reconciliation expected order ${normalizedInput.order.id} changed concurrently.`);
    }

    const existingEvent = normalizedInput.event
      ? this.orderEvents.find((candidate) => candidate.id === normalizedInput.event!.id)
      : undefined;
    if (normalizedInput.event) {
      assertNoConflictingRecord(existingEvent, normalizedInput.event, "reconciliation order event");
    }
    const fillResolutions = normalizedInput.fills.map((fill) => {
      const existing = findStoredFill(this.fills, fill);
      return { fill, resolution: resolveImmutableFillReplay(existing, fill) };
    });
    const insertedFills = fillResolutions
      .filter(({ resolution }) => resolution === "INSERT")
      .map(({ fill }) => cloneRecord(fill));
    const orderChanged = !recordsEqual(currentOrder, normalizedInput.order);
    const eventInserted = normalizedInput.event !== null && existingEvent === undefined;

    this.orders = this.orders.map((candidate) =>
      candidate.id === normalizedInput.order.id ? cloneRecord(normalizedInput.order) : candidate,
    );
    if (eventInserted) this.orderEvents = [...this.orderEvents, cloneRecord(normalizedInput.event!)];
    if (insertedFills.length > 0) this.fills = [...this.fills, ...insertedFills];

    return {
      outcome: orderChanged || eventInserted || insertedFills.length > 0 ? "APPLIED" : "DUPLICATE",
      insertedFillCount: insertedFills.length,
    };
  }

  async persistUncertainSubmission(input: PersistUncertainSubmissionInput): Promise<void> {
    validateUncertainSubmissionInput(input);
    const existingOrder = this.orders.find((candidate) => candidate.id === input.order.id);
    if (!existingOrder) {
      throw new Error(`Cannot persist uncertain submission for missing order ${input.order.id}.`);
    }
    assertSameAccount(existingOrder, input.order);
    const existingEvent = this.orderEvents.find((candidate) => candidate.id === input.event.id);
    const existingRiskEvent = this.riskEvents.find((candidate) => candidate.id === input.riskEvent.id);
    assertNoConflictingRecord(existingEvent, input.event, "order event");
    assertNoConflictingRecord(existingRiskEvent, input.riskEvent, "risk event");

    const completion = validateUncertainSubmissionCompletion(
      existingOrder,
      input.order,
      input,
      this.orderEvents.filter((candidate) => candidate.orderId === input.order.id),
      this.riskEvents.filter((candidate) => candidate.orderId === input.order.id),
    );
    if (completion === "RETRY") {
      return;
    }

    const nextOrders = this.orders.map((candidate) =>
      candidate.id === input.order.id ? cloneRecord(input.order) : candidate,
    );
    const nextOrderEvents = [...this.orderEvents, cloneRecord(input.event)];
    const nextRiskEvents = [...this.riskEvents, cloneRecord(input.riskEvent)];
    this.orders = nextOrders;
    this.orderEvents = nextOrderEvents;
    this.riskEvents = nextRiskEvents;
  }

  async findOrderByIdempotencyKey(exchangeAccountId: string, idempotencyKey: string): Promise<OrderRecord | null> {
    const order = this.orders.find(
      (candidate) =>
        candidate.exchangeAccountId === exchangeAccountId && candidate.idempotencyKey === idempotencyKey,
    );
    return order ? cloneRecord(order) : null;
  }

  async findOrderById(exchangeAccountId: string, orderId: string): Promise<OrderRecord | null> {
    const order = this.orders.find(
      (candidate) => candidate.exchangeAccountId === exchangeAccountId && candidate.id === orderId,
    );
    return order ? cloneRecord(order) : null;
  }

  async findOrderByReference(exchangeAccountId: string, reference: string): Promise<OrderRecord | null> {
    const order = this.orders.find(
      (candidate) =>
        candidate.exchangeAccountId === exchangeAccountId &&
        (candidate.id === reference || candidate.identifier === reference || candidate.upbitUuid === reference),
    );
    return order ? cloneRecord(order) : null;
  }

  async listActiveOrders(
    exchangeAccountId: string,
    market?: SupportedMarket,
    limit?: number,
  ): Promise<OrderRecord[]> {
    const orders = this.orders
      .filter((candidate) => {
        if (candidate.exchangeAccountId !== exchangeAccountId) {
          return false;
        }
        if (market && candidate.market !== market) {
          return false;
        }
        return ACTIVE_ORDER_STATUSES.has(candidate.status);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return (typeof limit === "number" ? orders.slice(0, limit) : orders).map(cloneRecord);
  }

  async listCandidateSubmissionBlockingOrders(
    exchangeAccountId: string,
    limit: number,
  ): Promise<OrderRecord[]> {
    validateCandidateOrderReadLimit(limit);
    return this.orders
      .filter((candidate) =>
        candidate.exchangeAccountId === exchangeAccountId &&
        CANDIDATE_SUBMISSION_BLOCKING_STATUSES.has(candidate.status) &&
        !(candidate.status === "FAILED" && candidate.failureCode === "ORDER_SUBMISSION_ABSENCE_CONFIRMED"),
      )
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(cloneRecord);
  }

  async listOrders(exchangeAccountId: string): Promise<OrderRecord[]> {
    return this.orders.filter((candidate) => candidate.exchangeAccountId === exchangeAccountId).map(cloneRecord);
  }

  async appendOrderEvent(record: OrderEventRecord): Promise<void> {
    this.orderEvents.push(cloneRecord(record));
  }

  async listOrderEvents(orderId: string): Promise<OrderEventRecord[]> {
    return this.orderEvents
      .filter((candidate) => candidate.orderId === orderId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneRecord);
  }

  async saveFill(record: FillRecord): Promise<void> {
    const normalizedRecord = normalizeFillFeeProvenance(record);
    const order = this.orders.find((candidate) => candidate.id === normalizedRecord.orderId);
    if (!order) throw new Error(`Cannot persist fill for missing order ${normalizedRecord.orderId}.`);
    validateFillForOrder(order, normalizedRecord);
    const existing = findStoredFill(this.fills, normalizedRecord);
    if (resolveImmutableFillReplay(existing, normalizedRecord) === "INSERT") {
      this.fills.push(cloneRecord(normalizedRecord));
    }
  }

  async listFills(orderId?: string): Promise<FillRecord[]> {
    if (!orderId) {
      return this.fills.map(cloneRecord);
    }

    return this.fills.filter((candidate) => candidate.orderId === orderId).map(cloneRecord);
  }

  async saveOrderSubmissionRecoveryObservation(
    record: OrderSubmissionRecoveryObservationRecord,
  ): Promise<void> {
    const existing = this.orderSubmissionRecoveryObservations.find((candidate) => candidate.id === record.id);
    if (existing && !recordsEqual(existing, record)) {
      throw new Error(`Conflicting duplicate order submission recovery observation ${record.id}.`);
    }
    if (!existing) this.orderSubmissionRecoveryObservations.push(cloneRecord(record));
  }

  async listOrderSubmissionRecoveryObservations(
    orderId: string,
  ): Promise<OrderSubmissionRecoveryObservationRecord[]> {
    return this.orderSubmissionRecoveryObservations
      .filter((candidate) => candidate.orderId === orderId)
      .sort((left, right) => left.observedAtEpochMs - right.observedAtEpochMs || left.id.localeCompare(right.id))
      .map(cloneRecord);
  }

  async finalizeBoundedSubmissionAbsence(
    input: FinalizeBoundedSubmissionAbsenceInput,
  ): Promise<boolean> {
    const current = this.orders.find((order) => order.id === input.orderId);
    if (!current || current.status !== input.expectedStatus || current.updatedAt !== input.expectedUpdatedAt) {
      return false;
    }
    if (!this.atomicFaultPauseStore) {
      throw new Error("In-memory bounded absence finalization requires an atomic fault-pause store.");
    }
    if (input.event.orderId !== input.orderId || this.orderEvents.some((event) => event.id === input.event.id)) {
      throw new Error("Bounded absence finalization event is invalid or conflicts with persisted evidence.");
    }
    const nextOrder: OrderRecord = {
      ...current,
      status: "FAILED",
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      updatedAt: input.failedAt,
    };
    // Both local collections change only after the pause plan has validated synchronously.
    this.atomicFaultPauseStore.applyFaultPauseAtomically(input.faultPause);
    this.orders = this.orders.map((order) => order.id === input.orderId ? cloneRecord(nextOrder) : order);
    this.orderEvents = [...this.orderEvents, cloneRecord(input.event)];
    return true;
  }

  async persistCandidateProjectionFault(
    input: PersistCandidateProjectionFaultInput,
  ): Promise<"APPLIED" | "DUPLICATE"> {
    if (!this.atomicFaultPauseStore) {
      throw new Error("In-memory candidate projection faults require an atomic fault-pause store.");
    }
    const order = this.orders.find((candidate) => candidate.id === input.orderId);
    if (!order || input.event.orderId !== order.id || input.faultPause.exchangeAccountId !== order.exchangeAccountId) {
      throw new Error("Candidate projection fault provenance does not match a persisted order.");
    }
    if (input.event.createdAt !== input.faultPause.occurredAt) {
      throw new Error("Candidate projection fault occurrence does not match its immutable event timestamp.");
    }
    validateFaultPauseInput(input.faultPause);
    const existing = this.orderEvents.find((event) => event.id === input.event.id);
    if (existing && !recordsEqual(existing, input.event)) {
      throw new Error(`Conflicting candidate projection fault event ${input.event.id}.`);
    }
    // Validate and durably pause before exposing a new disposal event to callers.
    this.atomicFaultPauseStore.applyFaultPauseAtomically(input.faultPause);
    if (!existing) {
      this.orderEvents = [...this.orderEvents, cloneRecord(input.event)];
      return "APPLIED";
    }
    return "DUPLICATE";
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
    this.riskEvents.push(cloneRecord(record));
  }

  async listRiskEvents(exchangeAccountId: string, limit?: number): Promise<RiskEventRecord[]> {
    const events = this.riskEvents
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return (typeof limit === "number" ? events.slice(0, limit) : events).map(cloneRecord);
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

  async saveStrategySchedulerRun(record: StrategySchedulerRunRecord): Promise<void> {
    const index = this.strategySchedulerRuns.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.strategySchedulerRuns.push(record);
      return;
    }

    this.strategySchedulerRuns[index] = record;
  }

  async updateStrategySchedulerRun(record: StrategySchedulerRunRecord): Promise<void> {
    await this.saveStrategySchedulerRun(record);
  }

  async listStrategySchedulerRuns(exchangeAccountId: string, limit?: number): Promise<StrategySchedulerRunRecord[]> {
    const runs = this.strategySchedulerRuns
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

  async saveOperatorNotificationDeliveryRun(
    record: OperatorNotificationDeliveryRunRecord,
  ): Promise<void> {
    const index = this.operatorNotificationDeliveryRuns.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) {
      this.operatorNotificationDeliveryRuns.push(record);
      return;
    }

    this.operatorNotificationDeliveryRuns[index] = record;
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

  async listOperatorNotificationDeliveryRuns(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryRunRecord[]> {
    const runs = this.operatorNotificationDeliveryRuns
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return typeof limit === "number" ? runs.slice(0, limit) : runs;
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

export class InMemoryTelegramInboundOffsetStore implements TelegramInboundOffsetStore {
  private readonly offsets: TelegramInboundOffsetRecord[] = [];

  async getTelegramInboundOffset(input: {
    exchangeAccountId: string;
    updateSource: TelegramInboundOffsetRecord["updateSource"];
    botTokenRef: string;
  }): Promise<TelegramInboundOffsetRecord | null> {
    return this.offsets.find((candidate) =>
      candidate.exchangeAccountId === input.exchangeAccountId &&
      candidate.updateSource === input.updateSource &&
      candidate.botTokenRef === input.botTokenRef,
    ) ?? null;
  }

  async saveTelegramInboundOffset(record: TelegramInboundOffsetRecord): Promise<void> {
    const index = this.offsets.findIndex((candidate) =>
      candidate.exchangeAccountId === record.exchangeAccountId &&
      candidate.updateSource === record.updateSource &&
      candidate.botTokenRef === record.botTokenRef,
    );

    if (index === -1) {
      this.offsets.push(record);
      return;
    }

    this.offsets[index] = record;
  }
}

export class InMemoryOperatorStateStore implements OperatorStateStore {
  private readonly transitions: ExecutionStateTransitionRecord[] = [];

  constructor(state: ExecutionStateRecord) {
    this.state = cloneRecord(state);
    this.transitions.push({
      id: "execution_state_transition_bootstrap",
      exchangeAccountId: this.state.exchangeAccountId,
      command: "BOOTSTRAP",
      fromExecutionMode: null,
      toExecutionMode: this.state.executionMode,
      fromLiveExecutionGate: null,
      toLiveExecutionGate: this.state.liveExecutionGate,
      fromSystemStatus: null,
      toSystemStatus: this.state.systemStatus,
      fromKillSwitchActive: null,
      toKillSwitchActive: this.state.killSwitchActive,
      reason: "bootstrap_seed",
      createdAt: this.state.updatedAt,
    });
  }

  private state: ExecutionStateRecord;

  async getState(): Promise<ExecutionStateRecord> {
    return { ...this.state };
  }

  async listTransitions(limit = 20): Promise<ExecutionStateTransitionRecord[]> {
    return this.transitions.slice(0, limit).map((record) => ({ ...record }));
  }

  async getTransitionById(id: string): Promise<ExecutionStateTransitionRecord | null> {
    const transition = this.transitions.find((candidate) => candidate.id === id);
    return transition ? { ...transition } : null;
  }

  async pauseForFault(input: FaultPauseInput): Promise<ExecutionStateRecord> {
    return this.applyFaultPauseAtomically(input);
  }

  applyFaultPauseAtomically(input: FaultPauseInput): ExecutionStateRecord {
    validateFaultPauseInput(input);
    if (input.exchangeAccountId !== this.state.exchangeAccountId) {
      throw new Error(`Fault ${input.faultId} is for a different exchange account.`);
    }
    const reason = formatFaultPauseReason(input);
    const existing = this.transitions.find((transition) => transition.id === input.faultId);
    if (existing) {
      if (
        existing.command === "AUTOMATIC_PAUSE" &&
        existing.exchangeAccountId === input.exchangeAccountId &&
        existing.reason === reason &&
        faultPauseTransitionMatchesOccurrence(input, existing.createdAt) &&
        (this.state.systemStatus === "PAUSED" || this.state.systemStatus === "KILL_SWITCHED")
      ) {
        return { ...this.state };
      }
      throw new Error(`Conflicting duplicate automatic pause ${input.faultId}.`);
    }
    const transitionAt = validateFaultPauseTimestamp(input, this.state);

    const previousState = { ...this.state };
    const preservesKillSwitch = this.state.killSwitchActive || this.state.systemStatus === "KILL_SWITCHED";
    this.state = {
      ...this.state,
      systemStatus: preservesKillSwitch ? "KILL_SWITCHED" : "PAUSED",
      pauseReason: preservesKillSwitch ? this.state.pauseReason : reason,
      updatedAt: transitionAt,
    };
    this.recordTransition(
      previousState,
      this.state,
      "AUTOMATIC_PAUSE",
      reason,
      input.faultId,
    );
    return { ...this.state };
  }

  runWithCandidatePilotRollbackAuthority(
    expected: CandidatePilotRollbackOperatorState,
    operation: () => PositionGuardPilotDeploymentRecord | null,
  ): InMemoryCandidatePilotRollbackAuthorityResult {
    const authority = validateCandidatePilotRollbackOperatorState(expected);
    if (!matchesCandidatePilotRollbackOperatorState(
      this.state,
      authority,
      authority.exchangeAccountId,
    )) {
      return Object.freeze({ authorityMatched: false });
    }
    if (typeof operation !== "function") {
      throw new Error("Candidate pilot rollback authority operation must be callable.");
    }
    return Object.freeze({
      authorityMatched: true,
      value: operation(),
    });
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
    id = `execution_state_transition_${this.transitions.length + 1}`,
  ): void {
    this.transitions.unshift({
      id,
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

function assertSameAccount(existing: OrderRecord, next: OrderRecord): void {
  if (existing.exchangeAccountId !== next.exchangeAccountId) {
    throw new Error(`Order ${next.id} cannot change exchange account.`);
  }
}

function assertNoConflictingRecord<T extends { id: string }>(
  existing: T | undefined,
  next: T,
  label: string,
): void {
  if (existing && !recordsEqual(existing, next)) {
    throw new Error(`Conflicting duplicate ${label} ${next.id}.`);
  }
}

function findStoredFill(fills: FillRecord[], fill: FillRecord): FillRecord | undefined {
  const matches = fills.filter(
    (candidate) => candidate.id === fill.id ||
      (candidate.orderId === fill.orderId && candidate.exchangeFillId === fill.exchangeFillId),
  );
  if (matches.length > 1) throw new Error(`Conflicting fill identity ${fill.id}.`);
  return matches[0];
}

function cloneRecord<T extends object>(record: T): T {
  return { ...record };
}

function cloneCandidateBinding(record: CandidateExecutionBindingRecord): CandidateExecutionBindingRecord {
  return { ...record };
}

function validateCandidateOrderReadLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Candidate submission-blocking order read limit must be a positive safe integer.");
  }
}

function formatFaultPauseReason(input: FaultPauseInput): string {
  return `faultId=${input.faultId}; reason=${input.reason}`;
}
