import type {
  OrderRecord,
  RiskEvaluationContext,
  RiskEvaluationResult,
  RiskRuleCode,
  SupportedAsset,
  SupportedMarket,
} from "../../domain/types.js";

const ACTIVE_DUPLICATE_STATUSES = new Set<OrderRecord["status"]>([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);

export function evaluateRiskGuards(context: RiskEvaluationContext): RiskEvaluationResult {
  const triggeredRules: RiskEvaluationResult["triggeredRules"] = [];

  if (context.policy.globalKillSwitch || context.systemStatus === "KILL_SWITCHED") {
    triggeredRules.push(block("GLOBAL_KILL_SWITCH", "Global kill switch is active."));
  }

  if (context.systemStatus === "PAUSED") {
    triggeredRules.push(block("EXECUTION_PAUSED", "Execution is paused by operator state."));
  }

  if (context.systemStatus === "DEGRADED") {
    triggeredRules.push(block("SYSTEM_DEGRADED", "Execution is blocked while the system is DEGRADED pending operator review."));
  }

  if (context.policy.executionMode === "LIVE" && context.policy.liveExecutionGate === "DISABLED") {
    triggeredRules.push(block("LIVE_EXECUTION_DISABLED", "LIVE mode is requested but live execution gate is disabled."));
  }

  if (!context.priceSnapshot) {
    triggeredRules.push(block("STALE_PRICE_GUARD", "No price snapshot is available for risk evaluation."));
  } else {
    const ageMs = Date.parse(context.now) - Date.parse(context.priceSnapshot.capturedAt);
    if (!Number.isFinite(ageMs) || ageMs > context.policy.stalePriceThresholdMs) {
      triggeredRules.push(block("STALE_PRICE_GUARD", "Price snapshot is stale."));
    }
  }

  if (
    typeof context.requestedNotionalKrw === "number" &&
    context.requestedNotionalKrw < context.policy.minimumOrderValueKrw
  ) {
    triggeredRules.push(block("MINIMUM_ORDER_VALUE_GUARD", "Requested order value is below the configured minimum."));
  }

  if (hasDuplicateOpenOrder(context)) {
    triggeredRules.push(block("DUPLICATE_ORDER_GUARD", "A matching active order already exists."));
  }

  if (typeof context.requestedNotionalKrw === "number") {
    const asset = getAssetForMarket(context.market);
    const assetExposureCap = context.portfolio.totalEquityKrw * context.policy.maxAllocationByAsset[asset];
    const projectedAssetExposure = context.portfolio.assetExposureKrw[asset] + context.requestedNotionalKrw;

    if (projectedAssetExposure > assetExposureCap) {
      triggeredRules.push(
        block(
          "PER_ASSET_MAX_ALLOCATION",
          `Projected ${asset} exposure exceeds configured max allocation.`,
        ),
      );
    }

    const projectedTotalExposure = context.portfolio.totalExposureKrw + context.requestedNotionalKrw;
    const totalExposureCap = context.portfolio.totalEquityKrw * context.policy.totalExposureCap;
    if (projectedTotalExposure > totalExposureCap) {
      triggeredRules.push(block("TOTAL_EXPOSURE_CAP", "Projected total exposure exceeds configured cap."));
    }
  }

  return {
    accepted: triggeredRules.length === 0,
    triggeredRules,
  };
}

function hasDuplicateOpenOrder(context: RiskEvaluationContext): boolean {
  return context.openOrders.some((order) => {
    if (!ACTIVE_DUPLICATE_STATUSES.has(order.status)) {
      return false;
    }

    return (
      order.idempotencyKey === context.requestedIdempotencyKey ||
      matchesRequestShape(order, context)
    );
  });
}

function matchesRequestShape(order: Pick<OrderRecord, "market" | "side" | "price" | "volume">, context: RiskEvaluationContext): boolean {
  return (
    order.market === context.market &&
    order.side === context.requestedSide &&
    normalizeOptionalNumberString(order.price) === normalizeOptionalNumberString(context.requestedPrice) &&
    normalizeOptionalNumberString(order.volume) === normalizeOptionalNumberString(context.requestedVolume)
  );
}

function normalizeOptionalNumberString(value: string | null): string | null {
  return value ? String(Number(value)) : null;
}

function block(code: RiskRuleCode, message: string) {
  return {
    code,
    level: "BLOCK" as const,
    message,
  };
}

function getAssetForMarket(market: SupportedMarket): SupportedAsset {
  return market === "KRW-BTC" ? "BTC" : "ETH";
}
