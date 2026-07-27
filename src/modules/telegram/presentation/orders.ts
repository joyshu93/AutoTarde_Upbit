import {
  getAssetForMarket,
  type OrderLifecycleStatus,
  type OrderOrigin,
  type OrderRecord,
  type OrderSide,
} from "../../../domain/types.js";
import {
  formatTelegramKrw,
  formatTelegramQuantity,
  formatTelegramTimestamp,
} from "./common.js";
import type { TelegramLocale } from "./locale.js";

const SUMMARY_LIMIT = 10;

const ACTIVE_OR_RECOVERY_STATUSES = new Set<OrderLifecycleStatus>([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);

const REJECTED_OR_FAILED_STATUSES = new Set<OrderLifecycleStatus>([
  "RISK_REJECTED",
  "REJECTED",
  "FAILED",
]);

export function formatOrdersPresentation(
  orders: readonly OrderRecord[],
  locale: TelegramLocale,
): string {
  const sortedOrders = [...orders]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleOrders = sortedOrders.slice(0, SUMMARY_LIMIT);
  const omittedCount = Math.max(0, sortedOrders.length - visibleOrders.length);
  const counts = countLifecycleGroups(sortedOrders);

  if (locale === "en-US") {
    return [
      "Recent orders",
      `Total: ${sortedOrders.length}`,
      `Active/recovery required: ${counts.activeOrRecovery}`,
      `Filled: ${counts.filled}`,
      `Canceled: ${counts.canceled}`,
      `Rejected/failed: ${counts.rejectedOrFailed}`,
      ...(visibleOrders.length === 0
        ? ["No stored orders."]
        : ["Latest 10:", ...visibleOrders.flatMap((order) => buildOrderLines(order, locale))]),
      ...(omittedCount > 0 ? [`${omittedCount} order(s) omitted.`] : []),
      "Full technical list: /orders detail",
    ].join("\n");
  }

  return [
    "최근 주문 (Orders)",
    `전체: ${sortedOrders.length}건`,
    `진행/확인 필요: ${counts.activeOrRecovery}건`,
    `체결 완료: ${counts.filled}건`,
    `취소: ${counts.canceled}건`,
    `거부/실패: ${counts.rejectedOrFailed}건`,
    ...(visibleOrders.length === 0
      ? ["저장된 주문이 없습니다."]
      : ["최근 10건:", ...visibleOrders.flatMap((order) => buildOrderLines(order, locale))]),
    ...(omittedCount > 0 ? [`${omittedCount}건은 생략되었습니다.`] : []),
    "전체 기술 목록: /orders detail",
  ].join("\n");
}

function countLifecycleGroups(orders: readonly OrderRecord[]): {
  activeOrRecovery: number;
  filled: number;
  canceled: number;
  rejectedOrFailed: number;
} {
  return orders.reduce(
    (counts, order) => {
      if (ACTIVE_OR_RECOVERY_STATUSES.has(order.status)) {
        counts.activeOrRecovery += 1;
      } else if (order.status === "FILLED") {
        counts.filled += 1;
      } else if (order.status === "CANCELED") {
        counts.canceled += 1;
      } else if (REJECTED_OR_FAILED_STATUSES.has(order.status)) {
        counts.rejectedOrFailed += 1;
      }
      return counts;
    },
    {
      activeOrRecovery: 0,
      filled: 0,
      canceled: 0,
      rejectedOrFailed: 0,
    },
  );
}

function buildOrderLines(order: OrderRecord, locale: TelegramLocale): string[] {
  const asset = getAssetForMarket(order.market);
  const price = order.price === null ? null : parseFiniteNumber(order.price);
  const valueLines = [
    ...(order.price === null
      ? []
      : [`  ${describePriceMeaning(order, locale)}: ${formatTelegramKrw(price, locale)}`]),
    ...(order.volume === null
      ? []
      : [
          locale === "ko-KR"
            ? `  수량: ${formatTelegramQuantity(order.volume, asset, locale)}`
            : `  Volume: ${formatTelegramQuantity(order.volume, asset, locale)}`,
        ]),
  ];

  return [
    `- ${formatTelegramTimestamp(order.updatedAt, locale)}`,
    `  ${order.market} · ${describeSide(order.side, locale)} · ${describeStatus(order.status, locale)} · ${order.executionMode} · ${describeOrigin(order.origin, locale)}`,
    ...valueLines,
    locale === "ko-KR"
      ? `  확인: /order ${order.id}`
      : `  Inspect: /order ${order.id}`,
  ];
}

function describePriceMeaning(
  order: Pick<OrderRecord, "ordType" | "side">,
  locale: TelegramLocale,
): string {
  const isPurchaseAmount =
    order.side === "bid"
    && (order.ordType === "price" || order.ordType === "best");

  if (isPurchaseAmount) {
    return locale === "ko-KR" ? "주문금액" : "Order amount";
  }

  if (order.ordType === "limit") {
    return locale === "ko-KR" ? "주문 단가" : "Unit price";
  }

  return locale === "ko-KR" ? "주문가" : "Order price";
}

function describeSide(side: OrderSide, locale: TelegramLocale): string {
  if (locale === "ko-KR") {
    return side === "bid" ? "매수" : "매도";
  }
  return side === "bid" ? "Buy" : "Sell";
}

function describeOrigin(origin: OrderOrigin, locale: TelegramLocale): string {
  if (locale === "ko-KR") {
    switch (origin) {
      case "STRATEGY":
        return "전략";
      case "OPERATOR":
        return "운영자";
      case "RECOVERY":
        return "복구";
    }
  }

  switch (origin) {
    case "STRATEGY":
      return "Strategy";
    case "OPERATOR":
      return "Operator";
    case "RECOVERY":
      return "Recovery";
  }
}

function describeStatus(
  status: OrderLifecycleStatus,
  locale: TelegramLocale,
): string {
  const labels: Record<OrderLifecycleStatus, readonly [string, string]> = {
    INTENT_CREATED: ["주문 의도 생성", "Intent created"],
    RISK_REJECTED: ["리스크 거부", "Risk rejected"],
    PERSISTED: ["로컬 저장", "Persisted"],
    SUBMITTING: ["전송 중", "Submitting"],
    OPEN: ["미체결", "Open"],
    PARTIALLY_FILLED: ["부분 체결", "Partially filled"],
    FILLED: ["체결 완료", "Filled"],
    CANCEL_REQUESTED: ["취소 요청", "Cancel requested"],
    CANCELED: ["취소 완료", "Canceled"],
    REJECTED: ["거래소 거부", "Rejected"],
    FAILED: ["실패", "Failed"],
    RECONCILIATION_REQUIRED: ["확인 필요", "Reconciliation required"],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function parseFiniteNumber(value: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
