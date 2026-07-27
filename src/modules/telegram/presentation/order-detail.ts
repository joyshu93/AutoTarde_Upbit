import {
  getAssetForMarket,
  type FillRecord,
  type OrderEventRecord,
  type OrderLifecycleStatus,
  type OrderOrigin,
  type OrderRecord,
  type OrderSide,
} from "../../../domain/types.js";
import {
  formatTelegramQuantity,
  formatTelegramTimestamp,
} from "./common.js";
import type { TelegramLocale } from "./locale.js";

const RECENT_ITEM_LIMIT = 3;

export function formatOrderDetailPresentation(
  order: OrderRecord | null,
  events: readonly OrderEventRecord[],
  fills: readonly FillRecord[],
  reference: string,
  locale: TelegramLocale,
): string {
  if (!order) {
    return locale === "ko-KR"
      ? [
          "주문을 찾을 수 없습니다.",
          `조회값: ${reference}`,
          "저장된 주문 ID, 식별자 또는 Upbit UUID를 확인해 주세요.",
          "텔레그램에서는 현금이나 포지션을 수동 입력할 수 없습니다.",
        ].join("\n")
      : [
          "Order not found.",
          `Reference: ${reference}`,
          "Check the stored order ID, identifier, or Upbit UUID.",
          "Telegram does not accept manual cash or position input.",
        ].join("\n");
  }

  const recentEvents = [...events]
    .sort((left, right) =>
      compareTimestampsNewestFirst(
        left.createdAt,
        left.id,
        right.createdAt,
        right.id,
      ))
    .slice(0, RECENT_ITEM_LIMIT);
  const recentFills = [...fills]
    .sort((left, right) =>
      compareTimestampsNewestFirst(
        left.filledAt,
        left.id,
        right.filledAt,
        right.id,
      ))
    .slice(0, RECENT_ITEM_LIMIT);

  return locale === "ko-KR"
    ? [
        "주문 상세 (Order)",
        `상태: ${describeStatus(order.status, locale)}`,
        `의미: ${describeStatusMeaning(order.status, locale)}`,
        `${order.market} · ${describeSide(order.side, locale)} · ${order.ordType} · ${order.executionMode} · ${describeOrigin(order.origin, locale)}`,
        `요청: ${formatTelegramTimestamp(order.requestedAt, locale)}`,
        `갱신: ${formatTelegramTimestamp(order.updatedAt, locale)}`,
        `내부 주문 ID: ${order.id}`,
        `식별자: ${order.identifier}`,
        ...buildOrderValueLines(order, locale),
        ...buildFailureLines(order, locale),
        formatRecentHeading("event", events.length, recentEvents.length, locale),
        ...(recentEvents.length === 0
          ? ["- 저장된 이벤트가 없습니다."]
          : recentEvents.map(
              (event) =>
                `- ${event.eventType} · ${event.eventSource} · ${formatTimestampOrError(event.createdAt, locale)}`,
            )),
        formatRecentHeading("fill", fills.length, recentFills.length, locale),
        ...(recentFills.length === 0
          ? ["- 저장된 체결이 없습니다."]
          : recentFills.map((fill) => formatFillLine(fill, locale))),
        `전체 기술 상세: /order ${order.id} detail`,
        "텔레그램에서는 현금이나 포지션을 수동 입력할 수 없습니다.",
      ].join("\n")
    : [
        "Order detail",
        `Status: ${describeStatus(order.status, locale)}`,
        `Meaning: ${describeStatusMeaning(order.status, locale)}`,
        `${order.market} · ${describeSide(order.side, locale)} · ${order.ordType} · ${order.executionMode} · ${describeOrigin(order.origin, locale)}`,
        `Requested: ${formatTelegramTimestamp(order.requestedAt, locale)}`,
        `Updated: ${formatTelegramTimestamp(order.updatedAt, locale)}`,
        `Internal order ID: ${order.id}`,
        `Identifier: ${order.identifier}`,
        ...buildOrderValueLines(order, locale),
        ...buildFailureLines(order, locale),
        formatRecentHeading("event", events.length, recentEvents.length, locale),
        ...(recentEvents.length === 0
          ? ["- No stored events."]
          : recentEvents.map(
              (event) =>
                `- ${event.eventType} · ${event.eventSource} · ${formatTimestampOrError(event.createdAt, locale)}`,
            )),
        formatRecentHeading("fill", fills.length, recentFills.length, locale),
        ...(recentFills.length === 0
          ? ["- No stored fills."]
          : recentFills.map((fill) => formatFillLine(fill, locale))),
        `Full technical detail: /order ${order.id} detail`,
        "Telegram does not accept manual cash or position input.",
      ].join("\n");
}

function buildOrderValueLines(order: OrderRecord, locale: TelegramLocale): string[] {
  const asset = getAssetForMarket(order.market);
  const lines: string[] = [];
  const isPurchaseAmount =
    order.side === "bid"
    && (order.ordType === "price" || order.ordType === "best");

  if (order.price !== null) {
    const price = parseFiniteNumber(order.price);
    const label = isPurchaseAmount
      ? (locale === "ko-KR" ? "주문금액" : "Order amount")
      : order.ordType === "limit"
        ? (locale === "ko-KR" ? "주문 단가" : "Unit price")
        : (locale === "ko-KR" ? "주문가" : "Order price");
    lines.push(
      price === null
        ? `${label}: ${formatDecimalError(order.price, locale)}`
        : `${label}: ${formatExactKrwDecimal(order.price, locale)}`,
    );
  }

  if (order.volume !== null) {
    const validVolume = parseFiniteNumber(order.volume) !== null;
    lines.push(
      locale === "ko-KR"
        ? `수량: ${validVolume
          ? formatTelegramQuantity(order.volume, asset, locale)
          : formatDecimalError(order.volume, locale)}`
        : `Volume: ${validVolume
          ? formatTelegramQuantity(order.volume, asset, locale)
          : formatDecimalError(order.volume, locale)}`,
    );
  }

  return lines;
}

function buildFailureLines(order: OrderRecord, locale: TelegramLocale): string[] {
  if (order.failureCode === null && order.failureMessage === null) {
    return [];
  }
  const code = order.failureCode ?? (locale === "ko-KR" ? "없음" : "none");
  const message = order.failureMessage ?? (locale === "ko-KR" ? "없음" : "none");
  return [locale === "ko-KR" ? `실패: ${code} · ${message}` : `Failure: ${code} · ${message}`];
}

function formatRecentHeading(
  kind: "event" | "fill",
  total: number,
  visible: number,
  locale: TelegramLocale,
): string {
  const label = kind === "event"
    ? (locale === "ko-KR" ? "최근 이벤트" : "Recent events")
    : (locale === "ko-KR" ? "최근 체결" : "Recent fills");
  if (total > visible) {
    return locale === "ko-KR"
      ? `${label} (전체 ${total}건 중 ${visible}건)`
      : `${label} (${visible} of ${total})`;
  }
  return locale === "ko-KR" ? `${label} (${total}건)` : `${label} (${total})`;
}

function formatFillLine(fill: FillRecord, locale: TelegramLocale): string {
  const asset = getAssetForMarket(fill.market);
  const price = parseFiniteNumber(fill.price) === null
    ? (locale === "ko-KR"
        ? `가격 ${formatDecimalError(fill.price, locale)}`
        : `Price ${formatDecimalError(fill.price, locale)}`)
    : formatExactKrwDecimal(fill.price, locale);
  const volume = parseFiniteNumber(fill.volume) === null
    ? (locale === "ko-KR"
        ? `수량 ${formatDecimalError(fill.volume, locale)}`
        : `Volume ${formatDecimalError(fill.volume, locale)}`)
    : formatTelegramQuantity(fill.volume, asset, locale);

  return `- ${formatTimestampOrError(fill.filledAt, locale)} · ${price} · ${volume} · ${formatFee(fill, locale)}`;
}

function formatFee(fill: FillRecord, locale: TelegramLocale): string {
  if (fill.feeAmount === null) {
    return locale === "ko-KR" ? "수수료 정보 없음" : "Fee unavailable";
  }

  if (parseFiniteNumber(fill.feeAmount) === null) {
    return locale === "ko-KR"
      ? `수수료 ${formatDecimalError(fill.feeAmount, locale)}`
      : `Fee ${formatDecimalError(fill.feeAmount, locale)}`;
  }

  const amount = formatExactDecimal(fill.feeAmount);
  if (fill.feeCurrency === null) {
    return locale === "ko-KR"
      ? `수수료 ${amount} (통화 미상)`
      : `Fee ${amount} (currency unknown)`;
  }

  if (fill.feeCurrency === "KRW") {
    return locale === "ko-KR"
      ? `수수료 ${amount}원`
      : `Fee KRW ${amount}`;
  }

  return locale === "ko-KR"
    ? `수수료 ${amount} ${fill.feeCurrency}`
    : `Fee ${amount} ${fill.feeCurrency}`;
}

function compareTimestampsNewestFirst(
  leftTimestamp: string,
  leftId: string,
  rightTimestamp: string,
  rightId: string,
): number {
  const leftInstant = parseTimestampInstant(leftTimestamp);
  const rightInstant = parseTimestampInstant(rightTimestamp);

  if (leftInstant !== null && rightInstant !== null) {
    return rightInstant - leftInstant || leftId.localeCompare(rightId);
  }
  if (leftInstant !== null) {
    return -1;
  }
  if (rightInstant !== null) {
    return 1;
  }
  return leftId.localeCompare(rightId);
}

function parseTimestampInstant(value: string): number | null {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function formatTimestampOrError(value: string, locale: TelegramLocale): string {
  return parseTimestampInstant(value) === null
    ? (locale === "ko-KR"
        ? `시간 데이터 오류 (${value})`
        : `Time data error (${value})`)
    : formatTelegramTimestamp(value, locale);
}

function formatDecimalError(value: string, locale: TelegramLocale): string {
  return locale === "ko-KR"
    ? `데이터 오류 (${value})`
    : `data error (${value})`;
}

function formatExactKrwDecimal(value: string, locale: TelegramLocale): string {
  const formatted = formatExactDecimal(value);
  return locale === "ko-KR" ? `${formatted}원` : `KRW ${formatted}`;
}

function formatExactDecimal(value: string): string {
  const trimmed = value.trim();
  const sign = trimmed.startsWith("-") || trimmed.startsWith("+")
    ? trimmed[0] ?? ""
    : "";
  const unsigned = sign ? trimmed.slice(1) : trimmed;
  const [rawWhole = "", fraction] = unsigned.split(".", 2);
  const whole = rawWhole || "0";
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined
    ? `${sign}${groupedWhole}`
    : `${sign}${groupedWhole}.${fraction}`;
}

function describeSide(side: OrderSide, locale: TelegramLocale): string {
  if (locale === "ko-KR") {
    return side === "bid" ? "매수" : "매도";
  }
  return side === "bid" ? "Buy" : "Sell";
}

function describeOrigin(origin: OrderOrigin, locale: TelegramLocale): string {
  const labels: Record<OrderOrigin, readonly [string, string]> = {
    STRATEGY: ["전략", "Strategy"],
    OPERATOR: ["운영자", "Operator"],
    RECOVERY: ["복구", "Recovery"],
  };
  return labels[origin][locale === "ko-KR" ? 0 : 1];
}

function describeStatus(status: OrderLifecycleStatus, locale: TelegramLocale): string {
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

function describeStatusMeaning(
  status: OrderLifecycleStatus,
  locale: TelegramLocale,
): string {
  const meanings: Record<OrderLifecycleStatus, readonly [string, string]> = {
    INTENT_CREATED: [
      "주문 의도만 생성되었으며 아직 거래소 전송이 완료되지 않았습니다.",
      "Only the order intent exists; exchange submission is not complete.",
    ],
    RISK_REJECTED: [
      "로컬 리스크 정책이 주문을 차단했으며 거래소에 전송되지 않았습니다.",
      "Local risk policy blocked the order before exchange submission.",
    ],
    PERSISTED: [
      "주문이 로컬에 저장되었으며 아직 거래소 전송이 완료되지 않았습니다.",
      "The order is persisted locally; exchange submission is not complete.",
    ],
    SUBMITTING: [
      "거래소 전송 중이며 아직 최종 결과가 확인되지 않았습니다.",
      "Exchange submission is in progress; the final result is not confirmed.",
    ],
    OPEN: [
      "아직 완료되지 않았으며 거래소 체결 또는 취소를 기다립니다.",
      "This order is not complete; it is waiting for an exchange fill or cancellation.",
    ],
    PARTIALLY_FILLED: [
      "아직 완료되지 않았으며 남은 수량의 체결 또는 취소를 기다립니다.",
      "This order is not complete; the remaining quantity is awaiting fill or cancellation.",
    ],
    FILLED: [
      "저장된 상태 기준으로 주문 체결이 완료되었습니다.",
      "The persisted state records this order as filled.",
    ],
    CANCEL_REQUESTED: [
      "아직 완료되지 않았으며 거래소의 취소 결과를 기다립니다.",
      "This order is not complete; it is waiting for the exchange cancellation result.",
    ],
    CANCELED: [
      "저장된 상태 기준으로 주문이 취소되었습니다.",
      "The persisted state records this order as canceled.",
    ],
    REJECTED: [
      "거래소가 주문을 거부했으며 체결되지 않았습니다.",
      "The exchange rejected the order; it was not filled.",
    ],
    FAILED: [
      "주문 처리에 실패했습니다. 실패 정보와 운영 알림을 확인해 주세요.",
      "Order processing failed; inspect the failure detail and operator alerts.",
    ],
    RECONCILIATION_REQUIRED: [
      "아직 완료되지 않았으며 저장된 거래소 reconciliation 근거로 확인해야 합니다.",
      "This order is not complete; verify it against persisted exchange reconciliation evidence.",
    ],
  };
  return meanings[status][locale === "ko-KR" ? 0 : 1];
}

function parseFiniteNumber(value: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
