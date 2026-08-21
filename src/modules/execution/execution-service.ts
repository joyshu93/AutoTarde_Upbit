import type {
  ExecutionRiskLimits,
  ExecutionStateRecord,
  ExecutionPolicy,
  RiskRuleCode,
  OrderRecord,
  RiskEventRecord,
  StrategyDecision,
  TimeInForce,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { AccountExecutionLeaseStore } from "../db/pilot-interfaces.js";
import { ExchangeOrderSubmissionError } from "../exchange/errors.js";
import type { ExchangeAdapter, ExecutionExchangeAdapter, UpbitOrderChance } from "../exchange/interfaces.js";
import { evaluateRiskGuards } from "../risk/guards.js";
import type { OperatorNotificationReporter } from "../telegram/reporter.js";
import { buildOrderIdentifier, buildOrderIdempotencyKey } from "./idempotency.js";
import type { SubmitOrderFromDecisionInput, SubmitOrderFromDecisionResult } from "./interfaces.js";

export class ExecutionService {
  constructor(
    private readonly dependencies: {
      riskLimits: ExecutionRiskLimits;
      executionAdapter: ExecutionExchangeAdapter;
      validationAdapter?: Pick<ExchangeAdapter, "getOrderChance" | "testOrder">;
      repositories: ExecutionRepository;
      accountExecutionLeases: AccountExecutionLeaseStore;
      accountExecutionLeaseMs: number;
      operatorState: OperatorStateStore;
      reporter?: OperatorNotificationReporter;
      now?: () => string;
    },
  ) {}

  async submitOrderFromDecision(input: SubmitOrderFromDecisionInput): Promise<SubmitOrderFromDecisionResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();
    const decision = input.decision;
    const market = input.market ?? decision.market;
    const idempotencyKey = buildOrderIdempotencyKey({
      exchangeAccountId: input.exchangeAccountId,
      strategyDecisionId: input.strategyDecisionId,
      market,
      side: input.side,
      ordType: input.ordType,
      price: input.price,
      volume: input.volume,
    });

    const duplicate = await this.dependencies.repositories.findOrderByIdempotencyKey(
      input.exchangeAccountId,
      idempotencyKey,
    );
    if (duplicate) {
      return {
        accepted: false,
        outcome: "DUPLICATE",
        order: duplicate,
        reason: "Duplicate order intent already exists for the same idempotency key.",
      };
    }

    const leaseOwnerToken = createId("account_execution_lease");
    let acquisitionWindow: { atEpochMs: number; expiresAtEpochMs: number };
    let lease;
    try {
      acquisitionWindow = this.leaseWindow(requestedAt, "acquisition");
      lease = await this.dependencies.accountExecutionLeases.acquireLease({
        exchangeAccountId: input.exchangeAccountId,
        ownerToken: leaseOwnerToken,
        purpose: "ORDER_SUBMISSION",
        acquiredAtEpochMs: acquisitionWindow.atEpochMs,
        expiresAtEpochMs: acquisitionWindow.expiresAtEpochMs,
      });
    } catch {
      await this.recordLeaseBlockedAndPause({
        input,
        idempotencyKey,
        market,
        occurredAt: requestedAt,
        reason: "Account execution lease acquisition is ambiguous; order submission is blocked pending recovery.",
      });
      throw new AccountExecutionLeaseSafetyError("Account execution lease acquisition is ambiguous.");
    }

    if (!lease) {
      const message = "Account execution lease is unavailable; order submission is blocked pending recovery.";
      await this.recordLeaseBlockedAndPause({ input, idempotencyKey, market, occurredAt: requestedAt, reason: message });
      return {
        accepted: false,
        outcome: "LEASE_BLOCKED",
        order: null,
        reason: message,
      };
    }

    if (!this.isOwnedLease(lease, input.exchangeAccountId, leaseOwnerToken, acquisitionWindow.atEpochMs)) {
      await this.recordLeaseBlockedAndPause({
        input,
        idempotencyKey,
        market,
        occurredAt: requestedAt,
        reason: "Account execution lease acquisition returned ambiguous ownership; order submission is blocked pending recovery.",
      });
      throw new AccountExecutionLeaseSafetyError("Account execution lease acquisition is ambiguous.");
    }

    let releaseLease = true;
    try {

    let accountActiveOrders: OrderRecord[];
    let state: ExecutionStateRecord;
    try {
      accountActiveOrders = await this.dependencies.repositories.listActiveOrders(input.exchangeAccountId);
      state = await this.dependencies.operatorState.getState();
    } catch {
      releaseLease = false;
      await this.recordLeaseBlockedAndPause({
        input,
        idempotencyKey,
        market,
        occurredAt: this.currentTimestamp(),
        reason: "Initial post-acquisition authority check is ambiguous; order submission is blocked pending recovery.",
      });
      throw new AccountExecutionLeaseSafetyError("Initial post-acquisition authority check failed.");
    }
    if (accountActiveOrders.length > 0) {
      const message = "Account execution lease is blocked by active or uncertain local orders pending recovery.";
      try {
        await this.recordLeaseBlockedAndPause({ input, idempotencyKey, market, occurredAt: requestedAt, reason: message });
      } catch (error) {
        releaseLease = false;
        throw error;
      }
      return { accepted: false, outcome: "LEASE_BLOCKED", order: null, reason: message };
    }

    const initialAuthority = selectExecutionAuthority(state);
    if (!executionAdapterAcceptsAuthority(this.dependencies.executionAdapter, initialAuthority)) {
      const message = "The configured execution adapter is incompatible with initial persisted execution authority.";
      try {
        await this.recordLeaseBlockedAndPause({
          input,
          idempotencyKey,
          market,
          occurredAt: requestedAt,
          reason: message,
        });
      } catch (error) {
        releaseLease = false;
        throw error;
      }
      return { accepted: false, outcome: "LEASE_BLOCKED", order: null, reason: message };
    }

    const policy = composeExecutionPolicy(state, this.dependencies.riskLimits, this.dependencies.executionAdapter);
    const openOrders = accountActiveOrders;
    const portfolio = await this.dependencies.repositories.getPortfolioExposure(input.exchangeAccountId);

    const requestedNotionalKrw =
      typeof decision.requestedNotionalKrw === "number"
        ? decision.requestedNotionalKrw
        : deriveRequestedNotionalKrw(decision, input.price, input.volume);

    const requestedQuantity =
      typeof decision.requestedQuantity === "number"
        ? decision.requestedQuantity
        : input.volume
          ? Number(input.volume)
          : null;
    const identifier = buildOrderIdentifier({
      market,
      side: input.side,
      strategyDecisionId: input.strategyDecisionId,
      requestedAt,
    });

    const risk = evaluateRiskGuards({
      policy,
      systemStatus: state.systemStatus,
      market,
      priceSnapshot: {
        market,
        tradePrice: decision.referencePrice,
        capturedAt: input.referencePriceCapturedAt,
      },
      portfolio,
      openOrders,
      requestedSide: input.side,
      requestedIdempotencyKey: idempotencyKey,
      requestedPrice: input.price,
      requestedVolume: input.volume,
      requestedNotionalKrw,
      requestedQuantity,
      now: requestedAt,
    });

    if (!risk.accepted) {
      await Promise.all(
        risk.triggeredRules.map((rule) =>
          this.dependencies.repositories.saveRiskEvent(createRiskEvent(input.exchangeAccountId, input.strategyDecisionId, rule.code, rule.message)),
        ),
      );
      await this.safeReport({
        exchangeAccountId: input.exchangeAccountId,
        notificationType: "ORDER_REJECTED",
        severity: "WARN",
        title: "Order blocked by local risk policy",
        message: risk.triggeredRules.map((rule) => rule.message).join("; "),
        payload: {
          strategyDecisionId: input.strategyDecisionId,
          market,
          side: input.side,
          ordType: input.ordType,
          reasonCodes: risk.triggeredRules.map((rule) => rule.code),
        },
      });

      return {
        accepted: false,
        outcome: "REJECTED",
        order: null,
        reason: risk.triggeredRules.map((rule) => rule.message).join("; "),
      };
    }

    const preTradeValidation = await this.runExchangePreTradeValidation({
      exchangeAccountId: input.exchangeAccountId,
      strategyDecisionId: input.strategyDecisionId,
      market,
      side: input.side,
      ordType: input.ordType,
      price: input.price,
      volume: input.volume,
      requestedAt,
      requestedNotionalKrw,
      identifier,
      idempotencyKey,
    });

    if (!preTradeValidation.accepted) {
      await this.dependencies.repositories.saveRiskEvent(
        createRiskEvent(
          input.exchangeAccountId,
          input.strategyDecisionId,
          preTradeValidation.ruleCode,
          preTradeValidation.message,
          preTradeValidation.payload,
        ),
      );
      await this.safeReport({
        exchangeAccountId: input.exchangeAccountId,
        notificationType: "ORDER_REJECTED",
        severity: "WARN",
        title: "Order rejected before submission",
        message: preTradeValidation.message,
        payload: {
          strategyDecisionId: input.strategyDecisionId,
          market,
          side: input.side,
          ordType: input.ordType,
          identifier,
          idempotencyKey,
          ruleCode: preTradeValidation.ruleCode,
        },
      });

      return {
        accepted: false,
        outcome: "REJECTED",
        order: null,
        reason: preTradeValidation.message,
      };
    }

    const order: OrderRecord = {
      id: createId("order"),
      strategyDecisionId: input.strategyDecisionId,
      exchangeAccountId: input.exchangeAccountId,
      market,
      side: input.side,
      ordType: input.ordType,
      volume: input.volume,
      price: input.price,
      timeInForce: null,
      smpType: null,
      identifier,
      idempotencyKey,
      origin: input.origin ?? "STRATEGY",
      requestedAt,
      upbitUuid: null,
      status: "PERSISTED",
      executionMode: executionModeForAdapter(this.dependencies.executionAdapter),
      exchangeResponseJson: null,
      failureCode: null,
      failureMessage: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };

    await this.dependencies.repositories.persistOrderIntent({
      order,
      event: {
        id: createId("order_event"),
        orderId: order.id,
        eventType: "ORDER_PERSISTED",
        eventSource: "LOCAL",
        payloadJson: JSON.stringify({
          idempotencyKey,
          decisionAction: decision.action,
        }),
        createdAt: requestedAt,
      },
    });

    const submittingOrder: OrderRecord = {
      ...order,
      status: "SUBMITTING",
      updatedAt: requestedAt,
    };
    await this.dependencies.repositories.updateOrder(submittingOrder);

    const renewalAt = this.currentTimestamp();
    let renewedLease;
    try {
      const renewalWindow = this.leaseWindow(renewalAt, "renewal");
      const renewedExpiry = Math.max(renewalWindow.expiresAtEpochMs, acquisitionWindow.expiresAtEpochMs + 1);
      if (!Number.isSafeInteger(renewedExpiry) || renewedExpiry <= renewalWindow.atEpochMs) {
        throw new Error("lease renewal expiry is unsafe");
      }
      renewedLease = await this.dependencies.accountExecutionLeases.renewLease({
        exchangeAccountId: input.exchangeAccountId,
        ownerToken: leaseOwnerToken,
        renewedAtEpochMs: renewalWindow.atEpochMs,
        expiresAtEpochMs: renewedExpiry,
      });
      if (!this.isOwnedLease(renewedLease, input.exchangeAccountId, leaseOwnerToken, renewalWindow.atEpochMs)) {
        throw new Error("lease ownership was not renewed");
      }
    } catch {
      releaseLease = false;
      await this.recordLeaseBlockedAndPause({
        input,
        idempotencyKey,
        market,
        occurredAt: renewalAt,
        reason: "Account execution lease renewal is ambiguous after SUBMITTING; reconciliation is required before any resend.",
        orderId: order.id,
      });
      throw new AccountExecutionLeaseSafetyError("Account execution lease renewal is ambiguous.");
    }

    try {
      await this.assertFinalPreSendAuthority({
        exchangeAccountId: input.exchangeAccountId,
        orderId: order.id,
        initialAuthority,
      });
    } catch {
      releaseLease = false;
      await this.recordLeaseBlockedAndPause({
        input,
        idempotencyKey,
        market,
        occurredAt: this.currentTimestamp(),
        reason: "Final pre-send authority check is ambiguous or blocked; reconciliation is required before any send.",
        orderId: order.id,
      });
      throw new AccountExecutionLeaseSafetyError("Final pre-send authority check failed.");
    }

    try {
      const exchangeOrder = await this.dependencies.executionAdapter.createOrder({
        market,
        side: input.side,
        ordType: input.ordType,
        volume: input.volume,
        price: input.price,
        identifier: order.identifier,
        timeInForce: null,
        smpType: null,
      });

      const submittedAt = this.currentTimestamp();
      let updatedOrder: OrderRecord = {
        ...submittingOrder,
        upbitUuid: exchangeOrder.uuid,
        status: mapExchangeOrderStatus(exchangeOrder.state, exchangeOrder.executedVolume, exchangeOrder.ordType, exchangeOrder.side),
        exchangeResponseJson: JSON.stringify(exchangeOrder.raw),
        updatedAt: submittedAt,
      };

      const fills = exchangeOrder.fills.map((fill) => ({
          id: createId("fill"),
          orderId: order.id,
          exchangeFillId: fill.tradeUuid ?? createId("exchange_fill"),
          market,
          side: fill.side,
          price: fill.price,
          volume: fill.volume,
          feeCurrency: "KRW",
          feeAmount: fill.fee,
          filledAt: fill.createdAt ?? updatedOrder.updatedAt,
          rawPayloadJson: JSON.stringify(fill.raw),
        }));

      if (this.dependencies.executionAdapter.sendPath === "DRY_RUN_ADAPTER") {
        const settledAt = this.currentTimestamp();
        const syntheticFill = createDryRunSyntheticFill({
          orderId: order.id,
          market,
          side: input.side,
          ordType: input.ordType,
          price: input.price,
          volume: input.volume,
          referencePrice: decision.referencePrice,
          requestedNotionalKrw,
          filledAt: settledAt,
          exchangeOrderRaw: exchangeOrder.raw,
        });

        if (fills.length === 0 && syntheticFill) {
          fills.push(syntheticFill);
        }

        if (fills.length === 0) {
          releaseLease = false;
          await this.throwPostSendPersistenceFailure({
            order: submittingOrder,
            exchangeAccountId: input.exchangeAccountId,
            occurredAt: settledAt,
            reason: "Dry-run submission could not produce terminal fill evidence.",
          });
        }

        updatedOrder = {
          ...updatedOrder,
          status: "FILLED",
          updatedAt: settledAt,
        };
      }

      releaseLease = false;
      try {
        await this.dependencies.repositories.persistExchangeSubmission({
          order: updatedOrder,
          event: {
            id: createId("order_event"),
            orderId: order.id,
            eventType: "ORDER_SUBMITTED",
            eventSource: eventSourceForAdapter(this.dependencies.executionAdapter),
            payloadJson: JSON.stringify(exchangeOrder.raw),
            createdAt: updatedOrder.updatedAt,
          },
          fills,
          ...(updatedOrder.status === "FILLED"
            ? { terminalEvent: {
                id: createId("order_event"),
                orderId: order.id,
                eventType: "ORDER_FILLED",
                eventSource: eventSourceForAdapter(this.dependencies.executionAdapter),
                payloadJson: JSON.stringify(
                  this.dependencies.executionAdapter.sendPath === "DRY_RUN_ADAPTER"
                    ? { mode: "DRY_RUN", settlement: "SIMULATED_IMMEDIATE_FILL", fillCount: fills.length }
                    : exchangeOrder.raw,
                ),
                createdAt: updatedOrder.updatedAt,
              } }
            : {}),
        });
      } catch {
        await this.throwPostSendPersistenceFailure({
          order: submittingOrder,
          exchangeAccountId: input.exchangeAccountId,
          occurredAt: this.currentTimestamp(),
          reason: "Exchange submission response could not be persisted atomically.",
        });
      }

      releaseLease = isTerminalOrderStatus(updatedOrder.status);

      return {
        accepted: true,
        outcome: this.dependencies.executionAdapter.sendPath === "DRY_RUN_ADAPTER" ? "SIMULATED_FILLED" : "SUBMITTED",
        order: updatedOrder,
        reason: null,
      };
    } catch (error) {
      if (error instanceof PostSendPersistenceSafetyError) {
        throw error;
      }
      const submissionError = describeSubmissionError(error);
      const definitiveRejection =
        error instanceof ExchangeOrderSubmissionError &&
        error.kind === "DEFINITIVE_REJECTION" &&
        !isDuplicateIdentifierError(error);

      if (definitiveRejection) {
        const rejectedOrder: OrderRecord = {
          ...submittingOrder,
          status: "REJECTED",
          failureCode: "EXCHANGE_ORDER_REJECTED",
          failureMessage: submissionError.message,
          exchangeResponseJson: JSON.stringify(submissionError.metadata),
          updatedAt: this.currentTimestamp(),
        };
        releaseLease = false;
        try {
          await this.dependencies.repositories.persistExchangeSubmission({
            order: rejectedOrder,
            event: {
              id: createId("order_event"),
              orderId: order.id,
              eventType: "ORDER_REJECTED",
              eventSource: eventSourceForAdapter(this.dependencies.executionAdapter),
              payloadJson: JSON.stringify(submissionError.metadata),
              createdAt: rejectedOrder.updatedAt,
            },
            fills: [],
          });
        } catch {
          await this.throwPostSendPersistenceFailure({
            order: submittingOrder,
            exchangeAccountId: input.exchangeAccountId,
            occurredAt: this.currentTimestamp(),
            reason: "Definitive exchange rejection could not be persisted atomically.",
          });
        }
        releaseLease = true;
        await this.safeReport({
          exchangeAccountId: input.exchangeAccountId,
          notificationType: "ORDER_REJECTED",
          severity: "WARN",
          title: "Order rejected by exchange",
          message: submissionError.message,
          payload: {
            orderId: rejectedOrder.id,
            identifier: rejectedOrder.identifier,
            ...submissionError.metadata,
          },
        });
        return {
          accepted: false,
          outcome: "REJECTED",
          order: rejectedOrder,
          reason: submissionError.message,
        };
      }

      const uncertainOrder: OrderRecord = {
        ...submittingOrder,
        status: "RECONCILIATION_REQUIRED",
        failureCode: "RECONCILIATION_REQUIRED",
        failureMessage: submissionError.message,
        exchangeResponseJson: JSON.stringify(submissionError.metadata),
        updatedAt: this.currentTimestamp(),
      };
      releaseLease = false;
      try {
        await this.dependencies.repositories.persistUncertainSubmission({
          order: uncertainOrder,
          event: {
            id: createId("order_event"),
            orderId: order.id,
            eventType: "RECONCILIATION_RECOVERY_REQUIRED",
            eventSource: eventSourceForAdapter(this.dependencies.executionAdapter),
            payloadJson: JSON.stringify(submissionError.metadata),
            createdAt: uncertainOrder.updatedAt,
          },
          riskEvent: createRiskEvent(
            input.exchangeAccountId,
            input.strategyDecisionId,
            "POSITION_GUARD_PILOT_UNCERTAIN_ORDER",
            submissionError.message,
            submissionError.metadata,
            order.id,
          ),
        });
      } catch {
        await this.throwPostSendPersistenceFailure({
          order: submittingOrder,
          exchangeAccountId: input.exchangeAccountId,
          occurredAt: this.currentTimestamp(),
          reason: "Uncertain exchange submission could not be persisted atomically.",
        });
      }
      await this.pauseForFault({
        exchangeAccountId: input.exchangeAccountId,
        faultId: `uncertain-order:${order.id}`,
        reason: submissionError.message,
        occurredAt: uncertainOrder.updatedAt,
      });
      return {
        accepted: false,
        outcome: "RECONCILIATION_REQUIRED",
        order: uncertainOrder,
        reason: submissionError.message,
      };
    }
    } finally {
      if (releaseLease) {
        await this.releaseLeaseOrFail({ input, idempotencyKey, market, occurredAt: this.currentTimestamp(), leaseOwnerToken });
      }
    }
  }

  private currentTimestamp(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private leaseWindow(timestamp: string, operation: "acquisition" | "renewal"): { atEpochMs: number; expiresAtEpochMs: number } {
    const atEpochMs = Date.parse(timestamp);
    const duration = this.dependencies.accountExecutionLeaseMs;
    if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0 || !Number.isSafeInteger(duration) || duration <= 0) {
      throw new AccountExecutionLeaseSafetyError(`Account execution lease ${operation} requires positive safe integer timestamps and duration.`);
    }
    const expiresAtEpochMs = atEpochMs + duration;
    if (!Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= atEpochMs) {
      throw new AccountExecutionLeaseSafetyError(`Account execution lease ${operation} expiry is unsafe.`);
    }
    return { atEpochMs, expiresAtEpochMs };
  }

  private isOwnedLease(
    lease: Awaited<ReturnType<AccountExecutionLeaseStore["acquireLease"]>>,
    exchangeAccountId: string,
    ownerToken: string,
    atEpochMs: number,
  ): boolean {
    return Boolean(
      lease && lease.exchangeAccountId === exchangeAccountId && lease.ownerToken === ownerToken &&
      Number.isSafeInteger(lease.acquiredAtEpochMs) && Number.isSafeInteger(lease.expiresAtEpochMs) &&
      lease.expiresAtEpochMs > atEpochMs,
    );
  }

  private async assertFinalPreSendAuthority(input: {
    exchangeAccountId: string;
    orderId: string;
    initialAuthority: ExecutionAuthorityTuple;
  }): Promise<void> {
    const activeOrders = await this.dependencies.repositories.listActiveOrders(input.exchangeAccountId);
    // Keep this as the final await before createOrder so a persisted pause wins the send race.
    const state = await this.dependencies.operatorState.getState();
    const competingOrders = activeOrders.filter((order) => order.id !== input.orderId);
    const finalAuthority = selectExecutionAuthority(state);
    const authorityUnchanged =
      finalAuthority.executionMode === input.initialAuthority.executionMode &&
      finalAuthority.liveExecutionGate === input.initialAuthority.liveExecutionGate;
    if (
      competingOrders.length > 0 ||
      state.systemStatus !== "RUNNING" ||
      state.killSwitchActive ||
      !authorityUnchanged ||
      !executionAdapterAcceptsAuthority(this.dependencies.executionAdapter, finalAuthority)
    ) {
      throw new Error("final pre-send authority is blocked");
    }
  }

  private async recordLeaseBlockedAndPause(input: {
    input: SubmitOrderFromDecisionInput;
    idempotencyKey: string;
    market: SubmitOrderFromDecisionInput["decision"]["market"];
    occurredAt: string;
    reason: string;
    orderId?: string;
  }): Promise<void> {
    let riskEvidenceFailure: unknown = null;
    let pauseFailure: unknown = null;
    try {
      await this.dependencies.repositories.saveRiskEvent(
        createRiskEvent(
          input.input.exchangeAccountId,
          input.input.strategyDecisionId,
          "ACCOUNT_EXECUTION_LEASE_BLOCKED",
          input.reason,
          { idempotencyKey: input.idempotencyKey, market: input.market, occurredAt: input.occurredAt },
          input.orderId ?? null,
        ),
      );
    } catch (error) {
      riskEvidenceFailure = error;
    }
    try {
      await this.pauseForFault({
        exchangeAccountId: input.input.exchangeAccountId,
        faultId: `account-execution-lease:${input.idempotencyKey}`,
        reason: input.reason,
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      pauseFailure = error;
    }
    if (riskEvidenceFailure && pauseFailure) {
      throw new LeaseBlockPersistenceSafetyError(
        "Account execution lease risk evidence and automatic fault pause could not be persisted.",
        riskEvidenceFailure,
        pauseFailure,
      );
    }
    if (pauseFailure) throw pauseFailure;
    if (riskEvidenceFailure) {
      throw new LeaseBlockPersistenceSafetyError(
        "Account execution lease risk evidence could not be persisted after automatic pause.",
        riskEvidenceFailure,
        null,
      );
    }
  }

  private async releaseLeaseOrFail(input: {
    input: SubmitOrderFromDecisionInput;
    idempotencyKey: string;
    market: SubmitOrderFromDecisionInput["decision"]["market"];
    occurredAt: string;
    leaseOwnerToken: string;
  }): Promise<void> {
    try {
      if (await this.dependencies.accountExecutionLeases.releaseLease(input.input.exchangeAccountId, input.leaseOwnerToken)) return;
    } catch {
      // A false release and a thrown release are both ownership ambiguities.
    }
    await this.recordLeaseBlockedAndPause({
      input: input.input,
      idempotencyKey: input.idempotencyKey,
      market: input.market,
      occurredAt: input.occurredAt,
      reason: "Account execution lease release is ambiguous; execution remains paused pending recovery.",
    });
    throw new AccountExecutionLeaseSafetyError("Account execution lease release is ambiguous.");
  }

  private async pauseForFault(input: {
    exchangeAccountId: string;
    faultId: string;
    reason: string;
    occurredAt: string;
  }): Promise<void> {
    try {
      await this.dependencies.operatorState.pauseForFault(input);
    } catch {
      throw new AutomaticFaultPauseSafetyError("Automatic fault pause could not be persisted.");
    }
  }

  private async throwPostSendPersistenceFailure(input: {
    order: OrderRecord;
    exchangeAccountId: string;
    occurredAt: string;
    reason: string;
  }): Promise<never> {
    await this.pauseForFault({
      exchangeAccountId: input.exchangeAccountId,
      faultId: `post-send-persistence:${input.order.id}`,
      reason: input.reason,
      occurredAt: input.occurredAt,
    });
    throw new PostSendPersistenceSafetyError(input.reason);
  }

  private async runExchangePreTradeValidation(input: {
    exchangeAccountId: string;
    strategyDecisionId: string | null;
    market: SubmitOrderFromDecisionInput["decision"]["market"];
    side: SubmitOrderFromDecisionInput["side"];
    ordType: SubmitOrderFromDecisionInput["ordType"];
    price: SubmitOrderFromDecisionInput["price"];
    volume: SubmitOrderFromDecisionInput["volume"];
    requestedAt: string;
    requestedNotionalKrw: number | null;
    identifier: string;
    idempotencyKey: string;
  }): Promise<
    | {
        accepted: true;
      }
    | {
        accepted: false;
        ruleCode: RiskRuleCode;
        message: string;
        payload: Record<string, unknown>;
      }
  > {
    const validator = this.dependencies.validationAdapter ?? this.dependencies.executionAdapter;
    const basePayload = {
      exchangeAccountId: input.exchangeAccountId,
      strategyDecisionId: input.strategyDecisionId,
      market: input.market,
      side: input.side,
      ordType: input.ordType,
      identifier: input.identifier,
      idempotencyKey: input.idempotencyKey,
      requestedAt: input.requestedAt,
      requestedNotionalKrw: input.requestedNotionalKrw,
      price: input.price,
      volume: input.volume,
    };

    let chance: UpbitOrderChance;
    try {
      chance = await validator.getOrderChance(input.market);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown order chance failure.";
      return {
        accepted: false,
        ruleCode: "EXCHANGE_ORDER_CHANCE_FAILED",
        message: `Exchange order chance precheck failed: ${message}`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          reason: message,
        },
      };
    }

    if (chance.marketId !== input.market) {
      return {
        accepted: false,
        ruleCode: "UNSUPPORTED_MARKET",
        message: `Exchange order chance returned mismatched market ${chance.marketId} for ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          requestedMarket: input.market,
          responseMarket: chance.marketId,
        },
      };
    }

    const supportedTypes = input.side === "bid" ? chance.bidTypes : chance.askTypes;
    const requiredType = resolveChanceTypeToken(input.ordType, null);
    if (!supportedTypes.includes(requiredType)) {
      return {
        accepted: false,
        ruleCode: "UNSUPPORTED_ORDER_TYPE",
        message: `Exchange order chance does not allow ${requiredType} orders for ${input.side} on ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          supportedTypes,
          requiredType,
        },
      };
    }

    const exchangeMinTotal = input.side === "bid" ? chance.bidMinTotal : chance.askMinTotal;
    if (
      typeof input.requestedNotionalKrw === "number" &&
      typeof exchangeMinTotal === "number" &&
      Number.isFinite(exchangeMinTotal) &&
      input.requestedNotionalKrw < exchangeMinTotal
    ) {
      return {
        accepted: false,
        ruleCode: "EXCHANGE_MIN_TOTAL_GUARD",
        message: `Requested order value is below exchange min total ${exchangeMinTotal} KRW for ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          requestedNotionalKrw: input.requestedNotionalKrw,
          exchangeMinTotal,
        },
      };
    }

    const exchangeMaxTotal = chance.maxTotal === null ? null : Number(chance.maxTotal);
    if (
      typeof input.requestedNotionalKrw === "number" &&
      typeof exchangeMaxTotal === "number" &&
      Number.isFinite(exchangeMaxTotal) &&
      input.requestedNotionalKrw > exchangeMaxTotal
    ) {
      return {
        accepted: false,
        ruleCode: "EXCHANGE_MAX_TOTAL_GUARD",
        message: `Requested order value exceeds exchange max total ${exchangeMaxTotal} KRW for ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          requestedNotionalKrw: input.requestedNotionalKrw,
          exchangeMaxTotal,
        },
      };
    }

    try {
      const validation = await validator.testOrder({
        market: input.market,
        side: input.side,
        ordType: input.ordType,
        volume: input.volume,
        price: input.price,
        identifier: input.identifier,
        timeInForce: null,
        smpType: null,
      });

      if (!validation.accepted) {
        return {
          accepted: false,
          ruleCode: validation.marketOnline ? "EXCHANGE_ORDER_TEST_FAILED" : "MARKET_OFFLINE",
          message: validation.reason ?? "Exchange order test rejected the request.",
          payload: {
            ...basePayload,
            stage: "testOrder",
            marketOnline: validation.marketOnline,
            reason: validation.reason,
            preview: validation.preview,
          },
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown order test failure.";
      return {
        accepted: false,
        ruleCode: /market_offline/iu.test(message) ? "MARKET_OFFLINE" : "EXCHANGE_ORDER_TEST_FAILED",
        message: `Exchange order test failed: ${message}`,
        payload: {
          ...basePayload,
          stage: "testOrder",
          reason: message,
        },
      };
    }

    return {
      accepted: true,
    };
  }

  private async safeReport(input: {
    exchangeAccountId: string;
    notificationType: "ORDER_REJECTED" | "ORDER_SUBMISSION_FAILED";
    severity: "WARN" | "ERROR";
    title: string;
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.dependencies.reporter) {
      return;
    }

    try {
      await this.dependencies.reporter.report(input);
    } catch {
      // Reporting is best-effort and must not change execution outcomes.
    }
  }
}

function composeExecutionPolicy(
  state: ExecutionStateRecord,
  riskLimits: ExecutionRiskLimits,
  executionAdapter: ExecutionExchangeAdapter,
): ExecutionPolicy {
  return {
    executionMode: executionModeForAdapter(executionAdapter),
    liveExecutionGate: executionAdapter.sendPath === "LIVE_ADAPTER" ? "ENABLED" : "DISABLED",
    globalKillSwitch: state.killSwitchActive,
    maxAllocationByAsset: riskLimits.maxAllocationByAsset,
    totalExposureCap: riskLimits.totalExposureCap,
    stalePriceThresholdMs: riskLimits.stalePriceThresholdMs,
    minimumOrderValueKrw: riskLimits.minimumOrderValueKrw,
  };
}

function mapExchangeOrderStatus(
  exchangeState: string,
  executedVolume: string | null,
  ordType?: string,
  side?: string,
): OrderRecord["status"] {
  if (exchangeState === "done") {
    return "FILLED";
  }
  if (exchangeState === "cancel") {
    if (side === "bid" && ordType === "price" && hasExecutedVolume(executedVolume)) {
      return "FILLED";
    }
    return "CANCELED";
  }

  return hasExecutedVolume(executedVolume) ? "PARTIALLY_FILLED" : "OPEN";
}

function hasExecutedVolume(executedVolume: string | null): boolean {
  return Boolean(executedVolume && Number(executedVolume) > 0);
}

type ExecutionAuthorityTuple = Pick<ExecutionStateRecord, "executionMode" | "liveExecutionGate">;

function selectExecutionAuthority(state: ExecutionStateRecord): ExecutionAuthorityTuple {
  return {
    executionMode: state.executionMode,
    liveExecutionGate: state.liveExecutionGate,
  };
}

function executionAdapterAcceptsAuthority(
  executionAdapter: ExecutionExchangeAdapter,
  authority: ExecutionAuthorityTuple,
): boolean {
  const fullyLive = authority.executionMode === "LIVE" && authority.liveExecutionGate === "ENABLED";
  return executionAdapter.sendPath === "LIVE_ADAPTER" ? fullyLive : !fullyLive;
}

function executionModeForAdapter(executionAdapter: ExecutionExchangeAdapter): OrderRecord["executionMode"] {
  return executionAdapter.sendPath === "LIVE_ADAPTER" ? "LIVE" : "DRY_RUN";
}

function eventSourceForAdapter(executionAdapter: ExecutionExchangeAdapter): "LOCAL" | "EXCHANGE" {
  return executionAdapter.sendPath === "LIVE_ADAPTER" ? "EXCHANGE" : "LOCAL";
}

function isTerminalOrderStatus(status: OrderRecord["status"]): boolean {
  return status === "FILLED" || status === "CANCELED" || status === "REJECTED";
}

function isDuplicateIdentifierError(error: ExchangeOrderSubmissionError): boolean {
  return [error.exchangeCode, error.exchangeName].some(
    (value) => value?.trim().toLowerCase() === "duplicate_identifier",
  );
}

function describeSubmissionError(error: unknown): {
  message: string;
  metadata: {
    kind: "DEFINITIVE_REJECTION" | "UNCERTAIN";
    status: number | null;
    exchangeCode: string | null;
    exchangeName: string | null;
    responseReceived: boolean;
  };
} {
  if (error instanceof ExchangeOrderSubmissionError) {
    return {
      message: error.message,
      metadata: {
        kind: error.kind,
        status: error.status,
        exchangeCode: error.exchangeCode,
        exchangeName: error.exchangeName,
        responseReceived: error.responseReceived,
      },
    };
  }

  return {
    message: "Order submission outcome is uncertain and requires reconciliation.",
    metadata: {
      kind: "UNCERTAIN",
      status: null,
      exchangeCode: null,
      exchangeName: null,
      responseReceived: false,
    },
  };
}

export class PostSendPersistenceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostSendPersistenceSafetyError";
  }
}

export class AccountExecutionLeaseSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountExecutionLeaseSafetyError";
  }
}

export class AutomaticFaultPauseSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomaticFaultPauseSafetyError";
  }
}

export class LeaseBlockPersistenceSafetyError extends Error {
  constructor(
    message: string,
    readonly riskEvidenceFailure: unknown | null,
    readonly pauseFailure: unknown | null,
  ) {
    super(message);
    this.name = "LeaseBlockPersistenceSafetyError";
  }
}

function createDryRunSyntheticFill(input: {
  orderId: string;
  market: OrderRecord["market"];
  side: OrderRecord["side"];
  ordType: OrderRecord["ordType"];
  price: string | null;
  volume: string | null;
  referencePrice: number;
  requestedNotionalKrw: number | null;
  filledAt: string;
  exchangeOrderRaw: unknown;
}) {
  const price =
    input.ordType === "price" || input.price === null
      ? String(input.referencePrice)
      : input.price;
  const volume = input.volume ?? deriveDryRunVolume(input.requestedNotionalKrw, input.referencePrice);

  if (!volume || Number(volume) <= 0 || Number(price) <= 0) {
    return null;
  }

  return {
    id: createId("fill"),
    orderId: input.orderId,
    exchangeFillId: createId("dryrun_fill"),
    market: input.market,
    side: input.side,
    price,
    volume,
    feeCurrency: "KRW",
    feeAmount: "0",
    filledAt: input.filledAt,
    rawPayloadJson: JSON.stringify({
      mode: "DRY_RUN",
      settlement: "SIMULATED_IMMEDIATE_FILL",
      exchangeOrderRaw: input.exchangeOrderRaw,
    }),
  };
}

function deriveDryRunVolume(requestedNotionalKrw: number | null, referencePrice: number): string | null {
  if (
    typeof requestedNotionalKrw !== "number" ||
    !Number.isFinite(requestedNotionalKrw) ||
    requestedNotionalKrw <= 0 ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0
  ) {
    return null;
  }

  return (requestedNotionalKrw / referencePrice).toFixed(12).replace(/0+$/u, "").replace(/\.$/u, "");
}

function createRiskEvent(
  exchangeAccountId: string,
  strategyDecisionId: string | null,
  ruleCode: RiskEventRecord["ruleCode"],
  message: string,
  payload: Record<string, unknown> = {},
  orderId: string | null = null,
): RiskEventRecord {
  return {
    id: createId("risk_event"),
    exchangeAccountId,
    strategyDecisionId,
    orderId,
    level: "BLOCK",
    ruleCode,
    message,
    payloadJson: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
  };
}

function deriveRequestedNotionalKrw(
  decision: StrategyDecision,
  price: string | null,
  volume: string | null,
): number | null {
  if (price && volume) {
    const priceNumber = Number(price);
    const volumeNumber = Number(volume);
    if (Number.isFinite(priceNumber) && Number.isFinite(volumeNumber)) {
      return priceNumber * volumeNumber;
    }
  }

  if (volume) {
    const volumeNumber = Number(volume);
    if (Number.isFinite(volumeNumber) && Number.isFinite(decision.referencePrice)) {
      return decision.referencePrice * volumeNumber;
    }
  }

  if (price) {
    const priceNumber = Number(price);
    return Number.isFinite(priceNumber) ? priceNumber : null;
  }

  return null;
}

function resolveChanceTypeToken(
  ordType: SubmitOrderFromDecisionInput["ordType"],
  timeInForce: TimeInForce | null,
): string {
  if (!timeInForce) {
    return ordType;
  }

  return `${ordType}_${timeInForce}`;
}
