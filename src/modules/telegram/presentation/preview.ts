import type { TelegramStrategyPreviewResult } from "../interfaces.js";
import {
  formatTelegramKrw,
  formatTelegramQuantity,
  formatTelegramTimestamp,
} from "./common.js";
import type { TelegramLocale } from "./locale.js";
import {
  describePilot,
  formatPilotTechnicalVisibility,
  type BtcCandidatePilotVisibility,
} from "./status.js";

interface PreviewStatusCopy {
  readonly label: string;
  readonly explanation: string;
  readonly nextAction: string;
}

const KOREAN_STATUS_COPY: Record<TelegramStrategyPreviewResult["status"], PreviewStatusCopy> = {
  COMPLETED: {
    label: "미리보기 완료",
    explanation: "현재 상태를 기준으로 전략 판단 미리보기를 계산했습니다.",
    nextAction:
      "먼저 /readiness를 확인하고 실행 의도가 명확할 때만 /run BTC|ETH를 사용하세요. LIVE 모드의 /run은 실주문을 전송할 수 있으며, 최신 시장·계정 상태에 따라 다른 결과를 계산할 수 있습니다.",
  },
  ALREADY_RUNNING: {
    label: "전략 확인 진행 중",
    explanation: "다른 전략 확인이 이미 진행 중이어서 새 미리보기를 계산하지 않았습니다.",
    nextAction: "진행 중인 확인이 끝날 때까지 기다린 뒤 나중에 다시 시도하세요.",
  },
  NOT_CONNECTED: {
    label: "미리보기 기능 연결 안 됨",
    explanation: "이 프로세스에 전략 미리보기 기능이 연결되지 않았습니다.",
    nextAction: "/config와 실행 중인 프로세스의 전략 러너 연결 상태를 확인하세요.",
  },
  FAILED: {
    label: "미리보기 실패",
    explanation: "전략 미리보기를 완료하지 못했습니다.",
    nextAction: "아래의 정확한 detail과 /alerts를 확인하세요.",
  },
};

const ENGLISH_STATUS_COPY: Record<TelegramStrategyPreviewResult["status"], PreviewStatusCopy> = {
  COMPLETED: {
    label: "Preview completed",
    explanation: "The strategy preview was computed from the current state.",
    nextAction:
      "Inspect /readiness first and use /run BTC|ETH only when execution is explicitly intended. In LIVE mode, /run can send a real order and can compute a different result from newer market and account state.",
  },
  ALREADY_RUNNING: {
    label: "Strategy check in progress",
    explanation: "Another strategy check is already running, so no new preview was computed.",
    nextAction: "Wait for the current check to finish, then retry later.",
  },
  NOT_CONNECTED: {
    label: "Preview not connected",
    explanation: "Strategy preview is not connected in this process.",
    nextAction: "Inspect /config and the strategy-runner wiring in the running process.",
  },
  FAILED: {
    label: "Preview failed",
    explanation: "The strategy preview could not be completed.",
    nextAction: "Inspect the exact detail below and /alerts.",
  },
};

const KOREAN_ACTION_LABELS: Record<NonNullable<TelegramStrategyPreviewResult["action"]>, string> = {
  ENTER: "신규 매수 판단",
  ADD: "추가 매수 판단",
  HOLD: "관망 판단",
  REDUCE: "일부 매도 판단",
  EXIT: "매도 종료 판단",
};

const ENGLISH_ACTION_LABELS: Record<NonNullable<TelegramStrategyPreviewResult["action"]>, string> = {
  ENTER: "New buy decision",
  ADD: "Additional buy decision",
  HOLD: "Hold decision",
  REDUCE: "Partial sell decision",
  EXIT: "Exit sell decision",
};

const KOREAN_DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  IMMEDIATE: "즉시 처리",
  DEFERRED_CONFIRMATION: "추가 확인 대기",
  EXECUTED_AFTER_CONFIRMATION: "확인 후 처리",
  SKIPPED: "처리 생략",
};

const ENGLISH_DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  IMMEDIATE: "Immediate",
  DEFERRED_CONFIRMATION: "Deferred for confirmation",
  EXECUTED_AFTER_CONFIRMATION: "Processed after confirmation",
  SKIPPED: "Skipped",
};

const NO_MUTATION_BOUNDARY =
  "no_mutation_boundary: /preview never persists strategy decisions, creates orders, sends orders, or triggers reconciliation.";
const OPERATOR_BOUNDARY =
  "operator_boundary: Telegram does not accept manual cash or position input.";

export function formatStrategyPreviewPresentation(
  result: TelegramStrategyPreviewResult,
  locale: TelegramLocale,
  btcPilot?: BtcCandidatePilotVisibility | null,
): string {
  const copy = locale === "ko-KR"
    ? KOREAN_STATUS_COPY[result.status]
    : ENGLISH_STATUS_COPY[result.status];
  const asset = assetForMarket(result.market);
  const marketAsset = result.market && asset
    ? `${result.market} / ${asset}`
    : localizedNone(locale);
  const action = formatAction(result.action, locale);
  const disposition = formatDisposition(result.executionDisposition, locale);
  const referencePrice = formatTelegramKrw(result.referencePrice, locale);
  const requestedNotional = formatTelegramKrw(result.requestedNotionalKrw, locale);
  const requestedQuantity = asset
    ? formatTelegramQuantity(result.requestedQuantity, asset, locale)
    : localizedNone(locale);
  const orderIntent = formatOrderIntent(result, asset, locale);
  const requestedAt = formatTelegramTimestamp(result.requestedAt, locale);

  const readableLines = locale === "ko-KR"
    ? [
        "전략 미리보기 (Strategy Preview)",
        `상태: ${copy.label} - ${copy.explanation}`,
        `시장/자산: ${marketAsset}`,
        `판단: ${action}`,
        `실행 처리: ${disposition}`,
        `기준 가격: ${referencePrice}`,
        `요청 금액: ${requestedNotional}`,
        `요청 수량: ${requestedQuantity}`,
        `주문 의도: ${orderIntent}`,
        `요청 시각: ${requestedAt}`,
        "안전 경계: 전략 판단을 저장하지 않았습니다.",
        "안전 경계: 주문을 전송하지 않았습니다.",
        `다음 조치: ${copy.nextAction}`,
      ]
    : [
        "Strategy Preview",
        `State: ${copy.label} - ${copy.explanation}`,
        `Market/asset: ${marketAsset}`,
        `Action: ${action}`,
        `Execution disposition: ${disposition}`,
        `Reference price: ${referencePrice}`,
        `Requested notional: ${requestedNotional}`,
        `Requested quantity: ${requestedQuantity}`,
        `Order intent: ${orderIntent}`,
        `Requested at: ${requestedAt}`,
        "Safety boundary: No strategy decision was persisted.",
        "Safety boundary: No order was sent.",
        `Next action: ${copy.nextAction}`,
      ];

  return [
    ...readableLines,
    ...(btcPilot === undefined ? [] : describePilot(btcPilot, locale)),
    "",
    `status: ${result.status}`,
    `requested_at: ${result.requestedAt}`,
    `market: ${result.market ?? "none"}`,
    `action: ${result.action ?? "none"}`,
    `execution_disposition: ${result.executionDisposition ?? "none"}`,
    `reference_price: ${result.referencePrice ?? "none"}`,
    `requested_notional_krw: ${result.requestedNotionalKrw ?? "none"}`,
    `requested_quantity: ${result.requestedQuantity ?? "none"}`,
    `order_side: ${result.orderSide ?? "none"}`,
    `order_type: ${result.orderType ?? "none"}`,
    `order_price: ${result.orderPrice ?? "none"}`,
    `order_volume: ${result.orderVolume ?? "none"}`,
    `detail: ${result.detail}`,
    ...(btcPilot === undefined || btcPilot === null ? [] : [formatPilotTechnicalVisibility(btcPilot)]),
    NO_MUTATION_BOUNDARY,
    OPERATOR_BOUNDARY,
  ].join("\n");
}

function formatAction(
  action: TelegramStrategyPreviewResult["action"],
  locale: TelegramLocale,
): string {
  if (action === null) {
    return locale === "ko-KR" ? "판단 없음" : "No decision";
  }
  return locale === "ko-KR" ? KOREAN_ACTION_LABELS[action] : ENGLISH_ACTION_LABELS[action];
}

function formatDisposition(value: string | null, locale: TelegramLocale): string {
  if (value === null) {
    return locale === "ko-KR" ? "처리 상태 없음" : "No disposition";
  }

  const known = locale === "ko-KR"
    ? KOREAN_DISPOSITION_LABELS[value]
    : ENGLISH_DISPOSITION_LABELS[value];
  if (known) {
    return known;
  }

  return locale === "ko-KR"
    ? `알 수 없는 처리 상태 (${value})`
    : `Unknown disposition (${value})`;
}

function formatOrderIntent(
  result: TelegramStrategyPreviewResult,
  asset: "BTC" | "ETH" | null,
  locale: TelegramLocale,
): string {
  if (
    result.action === "HOLD"
    || result.orderSide === null
    || result.orderType === null
  ) {
    return locale === "ko-KR"
      ? "없음 (미리보기 결과에 주문 의도가 없습니다.)"
      : "None (the preview contains no order intent).";
  }

  const side = locale === "ko-KR"
    ? result.orderSide === "bid" ? "매수" : "매도"
    : result.orderSide === "bid" ? "buy" : "sell";

  if (result.orderSide === "bid" && result.orderType === "price") {
    const spend = formatOrderPriceKrw(result.orderPrice, locale);
    return locale === "ko-KR"
      ? `시장가 ${side} 의도 - KRW 지출 금액 ${spend}`
      : `Market ${side} intent - KRW spend amount ${spend}`;
  }

  if (result.orderSide === "ask" && result.orderType === "market") {
    const volume = asset
      ? formatTelegramQuantity(result.orderVolume, asset, locale)
      : localizedNone(locale);
    return locale === "ko-KR"
      ? `시장가 ${side} 의도 - 매도 수량 ${volume}`
      : `Market ${side} intent - sell quantity ${volume}`;
  }

  if (result.orderType === "limit") {
    const unitPrice = formatOrderPriceKrw(result.orderPrice, locale);
    const volume = asset
      ? formatTelegramQuantity(result.orderVolume, asset, locale)
      : localizedNone(locale);
    return locale === "ko-KR"
      ? `지정가 ${side} 의도 - 주문 단가 ${unitPrice}, 주문 수량 ${volume}`
      : `Limit ${side} intent - unit price ${unitPrice}, quantity ${volume}`;
  }

  return locale === "ko-KR"
    ? "알 수 없는 주문 의도 형태"
    : "Unknown order-intent shape";
}

function assetForMarket(
  market: TelegramStrategyPreviewResult["market"],
): "BTC" | "ETH" | null {
  if (market === "KRW-BTC") {
    return "BTC";
  }
  if (market === "KRW-ETH") {
    return "ETH";
  }
  return null;
}

function formatOrderPriceKrw(value: string | null, locale: TelegramLocale): string {
  if (value === null || value.trim() === "") {
    return localizedNone(locale);
  }

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) {
    return localizedNone(locale);
  }

  const wholeDigits = (match[2] ?? "0").replace(/^0+(?=\d)/u, "");
  if (wholeDigits.length > 16) {
    return localizedNone(locale);
  }

  const fraction = match[3] ?? "";
  const roundUp = fraction.length > 0 && fraction.charCodeAt(0) - 48 >= 5;
  const roundedAbsolute = BigInt(wholeDigits) + (roundUp ? 1n : 0n);
  if (roundedAbsolute > BigInt(Number.MAX_SAFE_INTEGER)) {
    return localizedNone(locale);
  }

  const rounded = match[1] === "-" ? -roundedAbsolute : roundedAbsolute;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(rounded);
  return locale === "ko-KR" ? `${formatted}원` : `KRW ${formatted}`;
}

function localizedNone(locale: TelegramLocale): string {
  return locale === "ko-KR" ? "없음" : "none";
}
