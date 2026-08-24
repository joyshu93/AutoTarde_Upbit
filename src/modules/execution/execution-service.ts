import type {
  ExecutionRiskLimits,
  ExecutionStateRecord,
  ExecutionPolicy,
  FillRecord,
  OrderEventRecord,
  RiskRuleCode,
  OrderRecord,
  RiskEventRecord,
  StrategyDecision,
  StrategyDecisionRecord,
  TimeInForce,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { AccountExecutionLeaseStore, CandidatePilotRepository } from "../db/pilot-interfaces.js";
import { validateCandidateExecutionBinding } from "../db/pilot-interfaces.js";
import {
  projectCandidateFinalBoundOrderIntent,
  validateCandidateBoundOrderIntent,
} from "../db/repositories/candidate-bound-order-validation.js";
import { ExchangeOrderSubmissionError } from "../exchange/errors.js";
import type { ExchangeAdapter, ExecutionExchangeAdapter, UpbitOrderChance } from "../exchange/interfaces.js";
import { evaluateRiskGuards } from "../risk/guards.js";
import type { OperatorNotificationReporter } from "../telegram/reporter.js";
import { buildOrderIdentifier, buildOrderIdempotencyKey } from "./idempotency.js";
import {
  createCandidateExecutionAttemptTimestamps,
  deriveCandidateExecutionBinding,
  formatCanonicalUtcIsoNanoseconds,
  validateCandidateExecutionAuthority,
} from "./candidate-execution-authority.js";
import { createHash } from "node:crypto";

import type {
  CandidateExecutionBindingRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../domain/pilot-types.js";
import type {
  CandidateExecutionAuthority,
  SubmitOrderFromDecisionInput,
  SubmitOrderFromDecisionResult,
} from "./interfaces.js";
import { parseCandidateEvidenceTimestamp } from "./candidate-evidence-decimals.js";

const CANDIDATE_FINAL_ORDER_SCAN_LIMIT = 100;

const EXACT_ORDER_RECORD_FIELDS = Object.freeze([
  "id",
  "strategyDecisionId",
  "exchangeAccountId",
  "market",
  "side",
  "ordType",
  "volume",
  "price",
  "timeInForce",
  "smpType",
  "identifier",
  "idempotencyKey",
  "origin",
  "requestedAt",
  "upbitUuid",
  "status",
  "executionMode",
  "exchangeResponseJson",
  "failureCode",
  "failureMessage",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof OrderRecord)[]);

function sameOrderRecord(left: OrderRecord, right: OrderRecord): boolean {
  return EXACT_ORDER_RECORD_FIELDS.every((field) => left[field] === right[field]);
}

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
      candidatePilots?: Pick<
        CandidatePilotRepository,
        "getDeployment" | "getExactState" | "getExecutionBindingForOrder" |
        "pauseForCandidateIntentFault"
      >;
      reporter?: OperatorNotificationReporter;
      now?: () => string;
    },
  ) {}

  async submitOrderFromDecision(input: SubmitOrderFromDecisionInput): Promise<SubmitOrderFromDecisionResult> {
    const attemptStartedAt = this.dependencies.now?.() ?? new Date().toISOString();
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
    const candidateContext = await this.prepareCandidateContext(input, market);
    if (duplicate) {
      if (candidateContext) {
        let bindingId = `candidate-duplicate-binding:${duplicate.id}`;
        try {
          bindingId = await this.assertExactCandidateDuplicate({
            authority: candidateContext.authority,
            decision: candidateContext.decision,
            duplicate,
            idempotencyKey,
          });
        } catch (error) {
          await this.pauseCandidateIntentFault({
            authority: candidateContext.authority,
            decision: candidateContext.decision,
            input,
            orderId: duplicate.id,
            bindingId,
            stage: "DUPLICATE",
            occurredAt: candidateFaultOccurredAt(candidateContext.authority, attemptStartedAt),
          });
          throw new CandidateExecutionSafetyError(
            "Candidate duplicate authority or binding is missing or mismatched; execution is paused.",
            error,
          );
        }
      }
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
      acquisitionWindow = this.leaseWindow(attemptStartedAt, "acquisition");
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
        occurredAt: attemptStartedAt,
        reason: "Account execution lease acquisition is ambiguous; order submission is blocked pending recovery.",
      });
      throw new AccountExecutionLeaseSafetyError("Account execution lease acquisition is ambiguous.");
    }

    if (!lease) {
      const message = "Account execution lease is unavailable; order submission is blocked pending recovery.";
      await this.recordLeaseBlockedAndPause({ input, idempotencyKey, market, occurredAt: attemptStartedAt, reason: message });
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
        occurredAt: attemptStartedAt,
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
        await this.recordLeaseBlockedAndPause({ input, idempotencyKey, market, occurredAt: attemptStartedAt, reason: message });
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
          occurredAt: attemptStartedAt,
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
      requestedAt: attemptStartedAt,
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
      now: attemptStartedAt,
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
      requestedAt: attemptStartedAt,
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

    const orderId = createId("order");
    const eventId = createId("order_event");
    const bindingId = candidateContext ? createId("candidate_execution_binding") : null;
    let candidateBinding: CandidateExecutionBindingRecord | null = null;
    let candidateTimestamps = null;
    if (candidateContext) {
      try {
        candidateTimestamps = createCandidateExecutionAttemptTimestamps({
          activationEpochNs: candidateContext.authority.activationEpochNs,
          bindingCreatedAt: this.currentTimestamp(),
        });
      } catch (error) {
        releaseLease = false;
        await this.pauseCandidateIntentFault({
          authority: candidateContext.authority,
          decision: candidateContext.decision,
          input,
          orderId,
          bindingId: bindingId!,
          stage: "DERIVATION",
          occurredAt: candidateFaultOccurredAt(candidateContext.authority, null),
        });
        throw new CandidateExecutionSafetyError(
          "Candidate execution timestamps could not be derived safely; execution is paused.",
          error,
        );
      }
    }
    const orderRequestedAt = candidateTimestamps?.orderRequestedAt ?? attemptStartedAt;
    const order: OrderRecord = {
      id: orderId,
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
      requestedAt: orderRequestedAt,
      upbitUuid: null,
      status: "PERSISTED",
      executionMode: executionModeForAdapter(this.dependencies.executionAdapter),
      exchangeResponseJson: null,
      failureCode: null,
      failureMessage: null,
      createdAt: orderRequestedAt,
      updatedAt: orderRequestedAt,
    };

    const persistedEvent = {
        id: eventId,
        orderId: order.id,
        eventType: "ORDER_PERSISTED",
        eventSource: "LOCAL",
        payloadJson: JSON.stringify({
          idempotencyKey,
          decisionAction: decision.action,
        }),
        createdAt: orderRequestedAt,
      } as const;

    if (candidateContext && candidateTimestamps) {
      let binding: ReturnType<typeof deriveCandidateExecutionBinding>;
      try {
        binding = deriveCandidateExecutionBinding({
          authority: candidateContext.authority,
          order,
          decision: candidateContext.decision,
          bindingId: bindingId!,
          createdAt: candidateTimestamps.bindingCreatedAt,
        });
        candidateBinding = binding;
      } catch (error) {
        releaseLease = false;
        await this.pauseCandidateIntentFault({
          authority: candidateContext.authority,
          decision: candidateContext.decision,
          input,
          orderId,
          bindingId: bindingId!,
          stage: "DERIVATION",
          occurredAt: candidateFaultOccurredAt(candidateContext.authority, candidateTimestamps.bindingCreatedAt),
        });
        throw new CandidateExecutionSafetyError(
          "Candidate order binding could not be derived safely; execution is paused.",
          error,
        );
      }
      try {
        await this.dependencies.repositories.persistCandidateBoundOrderIntent({
          order,
          event: persistedEvent,
          binding,
          expectedPhase: candidateContext.authority.expectedPhase,
          expectedDeploymentUpdatedAt: candidateContext.authority.expectedDeploymentUpdatedAt,
          expectedStateVersion: candidateContext.authority.expectedStateVersion,
        });
      } catch (error) {
        releaseLease = false;
        await this.pauseCandidateIntentFault({
          authority: candidateContext.authority,
          decision: candidateContext.decision,
          input,
          orderId,
          bindingId: bindingId!,
          stage: "PERSISTENCE",
          occurredAt: candidateFaultOccurredAt(candidateContext.authority, candidateTimestamps.bindingCreatedAt),
        });
        throw new CandidateExecutionSafetyError(
          "Candidate order intent could not be persisted atomically; execution is paused.",
          error,
        );
      }
    } else {
      await this.dependencies.repositories.persistOrderIntent({ order, event: persistedEvent });
    }

    const submittingOrder: OrderRecord = {
      ...order,
      status: "SUBMITTING",
      updatedAt: orderRequestedAt,
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

    let exchangeOrderPromise: ReturnType<ExecutionExchangeAdapter["createOrder"]> | undefined;
    let createOrderInvoked = false;
    let synchronousSubmissionError: unknown = null;
    try {
      const authorityBlockedByOrders = await this.assertFinalPreSendAuthority({
        exchangeAccountId: input.exchangeAccountId,
        orderId: order.id,
        expectedOrder: submittingOrder,
        candidate: candidateContext && candidateBinding
          ? {
              authority: candidateContext.authority,
              expectedOrder: submittingOrder,
              expectedEvent: persistedEvent,
              expectedDecision: candidateContext.decision,
              expectedBinding: candidateBinding,
            }
          : null,
      });
      // This is the final await on the successful path. Only synchronous checks and the sole send follow.
      const finalState = await this.dependencies.operatorState.getState();
      const finalAuthority = selectExecutionAuthority(finalState);
      const authorityUnchanged =
        finalAuthority.executionMode === initialAuthority.executionMode &&
        finalAuthority.liveExecutionGate === initialAuthority.liveExecutionGate;
      if (
        authorityBlockedByOrders ||
        finalState.systemStatus !== "RUNNING" ||
        finalState.killSwitchActive ||
        !authorityUnchanged ||
        !executionAdapterAcceptsAuthority(this.dependencies.executionAdapter, finalAuthority)
      ) {
        throw new Error("final pre-send authority is blocked");
      }
      createOrderInvoked = true;
      exchangeOrderPromise = this.dependencies.executionAdapter.createOrder({
        market,
        side: input.side,
        ordType: input.ordType,
        volume: input.volume,
        price: input.price,
        identifier: order.identifier,
        timeInForce: null,
        smpType: null,
      });
    } catch (error) {
      if (createOrderInvoked) {
        synchronousSubmissionError = error;
      } else {
        releaseLease = false;
        if (candidateContext && candidateBinding) {
          await this.pauseCandidateIntentFault({
            authority: candidateContext.authority,
            decision: candidateContext.decision,
            input,
            orderId: order.id,
            bindingId: candidateBinding.id,
            stage: "FINAL_REVALIDATION",
            occurredAt: order.requestedAt,
          });
          throw new CandidateExecutionSafetyError(
            "Candidate final pre-send authority or intent material changed; execution is paused.",
            error,
          );
        }
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
    }

    try {
      if (synchronousSubmissionError !== null) throw synchronousSubmissionError;
      if (!exchangeOrderPromise) throw new Error("Exchange order submission did not start.");
      const exchangeOrder = await exchangeOrderPromise;

      const submittedAt = this.currentTimestamp();
      let updatedOrder: OrderRecord = {
        ...submittingOrder,
        upbitUuid: exchangeOrder.uuid,
        status: mapExchangeOrderStatus(exchangeOrder.state, exchangeOrder.executedVolume, exchangeOrder.ordType, exchangeOrder.side),
        exchangeResponseJson: JSON.stringify(exchangeOrder.raw),
        updatedAt: submittedAt,
      };

      const fills: FillRecord[] = exchangeOrder.fills.map((fill): FillRecord => {
        const executionTimestamp = directExchangeFillTimestamp(fill.createdAt);
        return {
          id: createId("fill"),
          orderId: order.id,
          exchangeFillId: fill.tradeUuid ?? createId("exchange_fill"),
          market,
          side: fill.side,
          price: fill.price,
          volume: fill.volume,
          feeCurrency: "KRW",
          feeAmount: fill.fee,
          feeProvenance: fill.fee === null ? "MISSING" : "EXCHANGE_FILL_CONFIRMED",
          executionTimestampProvenance: executionTimestamp.provenance,
          executionEpochNs: executionTimestamp.epochNanoseconds,
          filledAt: executionTimestamp.filledAt,
          rawPayloadJson: JSON.stringify(fill.raw),
        };
      });

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

  private async prepareCandidateContext(
    input: SubmitOrderFromDecisionInput,
    market: SubmitOrderFromDecisionInput["decision"]["market"],
  ): Promise<{
    authority: CandidateExecutionAuthority;
    decision: StrategyDecisionRecord;
  } | null> {
    if (!input.candidateAuthority) return null;

    let authority: CandidateExecutionAuthority;
    try {
      authority = validateCandidateExecutionAuthority(input.candidateAuthority);
    } catch (error) {
      throw new CandidateExecutionSafetyError("Candidate execution authority is malformed.", error);
    }
    if (!this.dependencies.candidatePilots || !this.dependencies.repositories.getStrategyDecisionById) {
      throw new CandidateExecutionSafetyError(
        "Candidate execution dependencies are not configured; order submission is blocked.",
      );
    }
    if (
      authority.exchangeAccountId !== input.exchangeAccountId ||
      authority.market !== market ||
      input.strategyDecisionId === null ||
      input.decision.strategyKey !== authority.strategyKey ||
      (input.origin ?? "STRATEGY") !== "STRATEGY"
    ) {
      throw new CandidateExecutionSafetyError("Candidate execution authority does not match the submitted route.");
    }

    const decision = await this.dependencies.repositories.getStrategyDecisionById(input.strategyDecisionId);
    if (
      !decision ||
      decision.id !== input.strategyDecisionId ||
      decision.exchangeAccountId !== input.exchangeAccountId ||
      decision.market !== authority.market ||
      decision.strategyKey !== authority.strategyKey ||
      decision.action !== input.decision.action ||
      decision.status !== "READY" ||
      decision.referencePrice !== String(input.decision.referencePrice) ||
      decision.intendedNotionalKrw !== nullableNumberString(input.decision.requestedNotionalKrw) ||
      decision.intendedQuantity !== nullableNumberString(input.decision.requestedQuantity)
    ) {
      throw new CandidateExecutionSafetyError(
        "Persisted candidate strategy decision does not match the submitted authority and decision.",
      );
    }
    return { authority, decision };
  }

  private async assertExactCandidateDuplicate(input: {
    authority: CandidateExecutionAuthority;
    decision: StrategyDecisionRecord;
    duplicate: OrderRecord;
    idempotencyKey: string;
  }): Promise<string> {
    const candidatePilots = this.dependencies.candidatePilots;
    if (!candidatePilots) {
      throw new Error("Candidate duplicate validation requires the candidate repository.");
    }
    const binding = await candidatePilots.getExecutionBindingForOrder(input.duplicate.id);
    if (!binding) {
      throw new Error("Candidate duplicate order has no persisted execution binding.");
    }
    validateCandidateExecutionBinding(binding);
    const [deployment, exactState, events] = await Promise.all([
      candidatePilots.getDeployment(input.authority.deploymentId),
      candidatePilots.getExactState(input.authority.deploymentId),
      this.dependencies.repositories.listOrderEvents(input.duplicate.id),
    ]);
    const persistedEvents = events.filter((event) => event.eventType === "ORDER_PERSISTED");
    const persistedEvent = persistedEvents[0] ?? null;
    if (
      !deployment || !exactState || persistedEvents.length !== 1 || !persistedEvent ||
      !matchesCandidateDuplicateOrder(input.duplicate, input.decision, input.idempotencyKey) ||
      !matchesCandidateDuplicateBinding(binding, input.duplicate, input.decision, input.authority) ||
      !matchesCandidateDuplicateDeployment(deployment, exactState.stateVersion, input.authority) ||
      !matchesCandidateDuplicatePersistedEvent(persistedEvent, input.duplicate, input.decision)
    ) {
      throw new Error("Candidate duplicate order, binding, decision, deployment, or event does not match authority.");
    }
    return binding.id;
  }

  private async pauseCandidateIntentFault(input: {
    authority: CandidateExecutionAuthority;
    decision: StrategyDecisionRecord;
    input: SubmitOrderFromDecisionInput;
    orderId: string;
    bindingId: string;
    stage: "DUPLICATE" | "DERIVATION" | "PERSISTENCE" | "FINAL_REVALIDATION";
    occurredAt: string;
  }): Promise<void> {
    const candidatePilots = this.dependencies.candidatePilots;
    if (!candidatePilots) {
      throw new CandidateExecutionSafetyError(
        "Candidate recovery dependency is unavailable; lease remains retained.",
      );
    }
    const provenance = {
      schemaVersion: "CANDIDATE_INTENT_FAULT_V1",
      stage: input.stage,
      deploymentId: input.authority.deploymentId,
      exchangeAccountId: input.authority.exchangeAccountId,
      strategyDecisionId: input.decision.id,
      orderId: input.orderId,
      bindingId: input.bindingId,
      market: input.authority.market,
      action: input.decision.action,
      side: input.input.side,
      ordType: input.input.ordType,
      price: input.input.price,
      volume: input.input.volume,
      expectedPhase: input.authority.expectedPhase,
      expectedDeploymentUpdatedAt: input.authority.expectedDeploymentUpdatedAt,
      expectedStateVersion: input.authority.expectedStateVersion,
    } as const;
    const provenanceJson = JSON.stringify(provenance);
    const faultId = `candidate-intent:${createHash("sha256").update(provenanceJson, "utf8").digest("hex")}`;
    try {
      await candidatePilots.pauseForCandidateIntentFault({
        deploymentId: input.authority.deploymentId,
        exchangeAccountId: input.authority.exchangeAccountId,
        stage: input.stage,
        strategyDecisionId: input.decision.id,
        orderId: input.orderId,
        bindingId: input.bindingId,
        faultId,
        reasonCode: input.stage === "PERSISTENCE" ? "ACTIVATION_CAS_CONFLICT" : "IDENTITY_MISMATCH",
        provenanceJson,
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      throw new CandidateExecutionSafetyError(
        "Candidate intent failure could not be atomically paused; lease remains retained.",
        error,
      );
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
    expectedOrder: OrderRecord;
    candidate: {
      authority: CandidateExecutionAuthority;
      expectedOrder: OrderRecord;
      expectedEvent: OrderEventRecord;
      expectedDecision: StrategyDecisionRecord;
      expectedBinding: CandidateExecutionBindingRecord;
    } | null;
  }): Promise<boolean> {
    const activeOrders = await this.dependencies.repositories.listSubmissionBlockingOrders(
      input.exchangeAccountId,
      CANDIDATE_FINAL_ORDER_SCAN_LIMIT + 1,
    );
    if (activeOrders.length > CANDIDATE_FINAL_ORDER_SCAN_LIMIT) {
      throw new Error("final submission-blocking order scan exceeded its safety bound");
    }
    let expectedOrderIsActive = false;
    let hasCompetingOrder = false;
    for (const activeOrder of activeOrders) {
      if (activeOrder.id === input.orderId) {
        if (expectedOrderIsActive || !sameOrderRecord(activeOrder, input.expectedOrder)) {
          throw new Error("final persisted order scan is ambiguous or mutated");
        }
        expectedOrderIsActive = true;
      } else {
        hasCompetingOrder = true;
      }
    }

    const persistedOrder = await this.dependencies.repositories.findOrderById(
      input.exchangeAccountId,
      input.orderId,
    );
    if (
      !expectedOrderIsActive ||
      !persistedOrder ||
      persistedOrder.status !== "SUBMITTING" ||
      !sameOrderRecord(persistedOrder, input.expectedOrder)
    ) {
      throw new Error("final persisted SUBMITTING order authority changed");
    }

    if (input.candidate) {
      const candidatePilots = this.dependencies.candidatePilots;
      if (!candidatePilots || !this.dependencies.repositories.getStrategyDecisionById) {
        throw new Error("candidate final pre-send dependencies are unavailable");
      }
      const events = await this.dependencies.repositories.listOrderEvents(input.orderId);
      const firstEvent = events[0] ?? null;
      const getDecision = this.dependencies.repositories.getStrategyDecisionById;
      const decision = await getDecision.call(
        this.dependencies.repositories,
        input.candidate.expectedDecision.id,
      );
      const deployment = await candidatePilots.getDeployment(input.candidate.authority.deploymentId);
      const exactState = await candidatePilots.getExactState(input.candidate.authority.deploymentId);
      const binding = await candidatePilots.getExecutionBindingForOrder(input.orderId);
      if (
        hasCompetingOrder ||
        events.length !== 1 || !firstEvent || !decision || !deployment || !exactState || !binding
      ) {
        throw new Error("candidate final persisted authority or intent material changed");
      }
      const projected = projectCandidateFinalBoundOrderIntent({
        persistedOrder,
        expectedOrder: input.candidate.expectedOrder,
        persistedEvent: firstEvent,
        expectedEvent: input.candidate.expectedEvent,
        persistedDecision: decision,
        expectedDecision: input.candidate.expectedDecision,
        persistedBinding: binding,
        expectedBinding: input.candidate.expectedBinding,
      });
      validateCandidateBoundOrderIntent({
        ...projected,
        deployment,
        exactStateVersion: exactState.stateVersion,
        expectedPhase: input.candidate.authority.expectedPhase,
        expectedDeploymentUpdatedAt: input.candidate.authority.expectedDeploymentUpdatedAt,
        expectedStateVersion: input.candidate.authority.expectedStateVersion,
      });
    }
    return hasCompetingOrder;
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

export class CandidateExecutionSafetyError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CandidateExecutionSafetyError";
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
}): FillRecord | null {
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
    feeProvenance: "SIMULATED",
    executionTimestampProvenance: "LOCAL_SYNTHETIC",
    executionEpochNs: parseCandidateEvidenceTimestamp(input.filledAt, "dry-run synthetic fill timestamp").toString(),
    filledAt: input.filledAt,
    rawPayloadJson: JSON.stringify({
      mode: "DRY_RUN",
      settlement: "SIMULATED_IMMEDIATE_FILL",
      exchangeOrderRaw: input.exchangeOrderRaw,
    }),
  };
}

function directExchangeFillTimestamp(createdAt: string | null): {
  provenance: NonNullable<FillRecord["executionTimestampProvenance"]>;
  epochNanoseconds: string | null;
  filledAt: string;
} {
  if (createdAt === null) {
    return {
      provenance: "LEGACY_UNVERIFIED",
      epochNanoseconds: null,
      filledAt: "",
    };
  }
  try {
    return {
      provenance: "EXCHANGE_FILL_CONFIRMED",
      epochNanoseconds: parseCandidateEvidenceTimestamp(createdAt, "exchange fill createdAt").toString(),
      filledAt: createdAt,
    };
  } catch {
    return {
      provenance: "LEGACY_UNVERIFIED",
      epochNanoseconds: null,
      filledAt: createdAt,
    };
  }
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

function nullableNumberString(value: number | null): string | null {
  return value === null ? null : String(value);
}

function matchesCandidateDuplicateOrder(
  order: OrderRecord,
  decision: StrategyDecisionRecord,
  idempotencyKey: string,
): boolean {
  return order.exchangeAccountId === decision.exchangeAccountId &&
    order.strategyDecisionId === decision.id &&
    order.market === decision.market &&
    order.origin === "STRATEGY" &&
    order.idempotencyKey === idempotencyKey &&
    order.identifier.trim() !== "" &&
    order.createdAt === order.requestedAt &&
    ((decision.action === "ENTER" || decision.action === "ADD")
      ? order.side === "bid" && order.ordType === "price" &&
        order.price === decision.intendedNotionalKrw && order.volume === null
      : order.side === "ask" && order.ordType === "market" &&
        order.price === null && order.volume === decision.intendedQuantity) &&
    order.timeInForce === null && order.smpType === null;
}

function matchesCandidateDuplicateBinding(
  binding: CandidateExecutionBindingRecord,
  order: OrderRecord,
  decision: StrategyDecisionRecord,
  authority: CandidateExecutionAuthority,
): boolean {
  let expectedRequestedAt: string;
  try {
    expectedRequestedAt = formatCanonicalUtcIsoNanoseconds(
      parseCandidateEvidenceTimestamp(binding.createdAt, "candidate duplicate binding createdAt") + 1n,
    );
  } catch {
    return false;
  }
  return binding.deploymentId === authority.deploymentId &&
    binding.strategyDecisionId === decision.id &&
    binding.orderId === order.id &&
    binding.exchangeAccountId === authority.exchangeAccountId &&
    binding.activationAt === authority.activationAt &&
    binding.activationEpochNs === authority.activationEpochNs &&
    binding.market === authority.market &&
    binding.strategyKey === authority.strategyKey &&
    binding.policyId === authority.policyId &&
    binding.policyVersion === authority.policyVersion &&
    binding.executionMode === order.executionMode &&
    binding.ordType === order.ordType &&
    binding.action === decision.action &&
    binding.side === order.side &&
    binding.intendedQuantity === decision.intendedQuantity &&
    binding.intendedNotionalKrw === decision.intendedNotionalKrw &&
    binding.boundPrice === order.price &&
    binding.boundVolume === order.volume &&
    binding.boundTimeInForce === order.timeInForce &&
    binding.boundSmpType === order.smpType &&
    order.requestedAt === expectedRequestedAt;
}

function matchesCandidateDuplicateDeployment(
  deployment: PositionGuardPilotDeploymentRecord,
  exactStateVersion: number,
  authority: CandidateExecutionAuthority,
): boolean {
  return deployment.id === authority.deploymentId &&
    deployment.exchangeAccountId === authority.exchangeAccountId &&
    deployment.pilotId === authority.pilotId &&
    deployment.market === authority.market &&
    deployment.policyId === authority.policyId &&
    deployment.policyVersion === authority.policyVersion &&
    deployment.phase === authority.expectedPhase &&
    deployment.updatedAt === authority.expectedDeploymentUpdatedAt &&
    deployment.activationAt === authority.activationAt &&
    deployment.activationEpochNs === authority.activationEpochNs &&
    exactStateVersion === authority.expectedStateVersion;
}

function matchesCandidateDuplicatePersistedEvent(
  event: OrderEventRecord,
  order: OrderRecord,
  decision: StrategyDecisionRecord,
): boolean {
  if (
    event.orderId !== order.id || event.eventSource !== "LOCAL" ||
    event.createdAt !== order.requestedAt
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(event.payloadJson) as unknown;
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
      (payload as { idempotencyKey?: unknown }).idempotencyKey === order.idempotencyKey &&
      (payload as { decisionAction?: unknown }).decisionAction === decision.action;
  } catch {
    return false;
  }
}

function candidateFaultOccurredAt(
  authority: CandidateExecutionAuthority,
  attemptedAt: string | null,
): string {
  const minimumEpochNs = [
    authority.activationEpochNs,
    parseCandidateEvidenceTimestamp(
      authority.expectedDeploymentUpdatedAt,
      "candidate authority expected deployment updatedAt",
    ),
  ].reduce((maximum, value) => value > maximum ? value : maximum);
  if (attemptedAt !== null) {
    try {
      const attemptedEpochNs = parseCandidateEvidenceTimestamp(attemptedAt, "candidate fault attemptedAt");
      if (attemptedEpochNs >= minimumEpochNs) {
        return formatCanonicalUtcIsoNanoseconds(attemptedEpochNs);
      }
    } catch {
      // Persist a canonical successor rather than carrying an invalid clock value into fault evidence.
    }
  }
  return formatCanonicalUtcIsoNanoseconds(minimumEpochNs + 1n);
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
