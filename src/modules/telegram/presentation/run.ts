import type { OrderLifecycleStatus } from "../../../domain/types.js";
import type { TelegramStrategyRunResult } from "../interfaces.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

interface RunStatusCopy {
  readonly label: string;
  readonly explanation: string;
}

const KOREAN_STATUS_COPY: Record<TelegramStrategyRunResult["status"], RunStatusCopy> = {
  COMPLETED: {
    label: "실행 요청 처리 완료",
    explanation: "전략 실행 요청이 처리되었습니다.",
  },
  ALREADY_RUNNING: {
    label: "전략 실행 진행 중",
    explanation: "다른 전략 실행이 이미 진행 중이어서 새 실행을 시작하지 않았습니다.",
  },
  SKIPPED: {
    label: "전략 실행 생략",
    explanation: "현재 상태에서는 전략 실행을 진행하지 않았습니다.",
  },
  NOT_CONNECTED: {
    label: "전략 실행 기능 연결 안 됨",
    explanation: "이 프로세스에 전략 실행 기능이 연결되지 않았습니다.",
  },
  FAILED: {
    label: "전략 실행 실패",
    explanation: "전략 실행 요청을 완료하지 못했습니다.",
  },
};

const ENGLISH_STATUS_COPY: Record<TelegramStrategyRunResult["status"], RunStatusCopy> = {
  COMPLETED: {
    label: "Run request processed",
    explanation: "The strategy run request was processed.",
  },
  ALREADY_RUNNING: {
    label: "Strategy run in progress",
    explanation: "Another strategy run is already in progress, so no new run was started.",
  },
  SKIPPED: {
    label: "Strategy run skipped",
    explanation: "The strategy run did not proceed in the current state.",
  },
  NOT_CONNECTED: {
    label: "Strategy run not connected",
    explanation: "Strategy execution is not connected in this process.",
  },
  FAILED: {
    label: "Strategy run failed",
    explanation: "The strategy run request could not be completed.",
  },
};

const KOREAN_ACTION_LABELS: Record<
  NonNullable<TelegramStrategyRunResult["action"]>,
  string
> = {
  ENTER: "신규 매수",
  ADD: "추가 매수",
  HOLD: "관망",
  REDUCE: "일부 매도",
  EXIT: "매도 종료",
};

const ENGLISH_ACTION_LABELS: Record<
  NonNullable<TelegramStrategyRunResult["action"]>,
  string
> = {
  ENTER: "New buy",
  ADD: "Additional buy",
  HOLD: "Hold",
  REDUCE: "Partial sell",
  EXIT: "Exit sell",
};

const KOREAN_ORDER_STATUS_LABELS: Record<OrderLifecycleStatus, string> = {
  INTENT_CREATED: "주문 의도 생성",
  RISK_REJECTED: "위험 정책 거부",
  PERSISTED: "로컬 저장 완료",
  SUBMITTING: "주문 전송 중",
  OPEN: "주문 열림",
  PARTIALLY_FILLED: "부분 체결",
  FILLED: "체결 완료",
  CANCEL_REQUESTED: "취소 요청됨",
  CANCELED: "주문 취소",
  REJECTED: "거래소 거부",
  FAILED: "주문 실패",
  RECONCILIATION_REQUIRED: "동기화 확인 필요",
};

const ENGLISH_ORDER_STATUS_LABELS: Record<OrderLifecycleStatus, string> = {
  INTENT_CREATED: "Intent created",
  RISK_REJECTED: "Rejected by risk policy",
  PERSISTED: "Persisted locally",
  SUBMITTING: "Submitting",
  OPEN: "Open",
  PARTIALLY_FILLED: "Partially filled",
  FILLED: "Filled",
  CANCEL_REQUESTED: "Cancellation requested",
  CANCELED: "Canceled",
  REJECTED: "Rejected by exchange",
  FAILED: "Order failed",
  RECONCILIATION_REQUIRED: "Reconciliation required",
};

const OPERATOR_BOUNDARY =
  "operator_boundary: Telegram does not accept manual cash or position input.";

export function formatStrategyRunPresentation(
  result: TelegramStrategyRunResult,
  locale: TelegramLocale,
): string {
  const copy = locale === "ko-KR"
    ? KOREAN_STATUS_COPY[result.status]
    : ENGLISH_STATUS_COPY[result.status];
  const readableLines = locale === "ko-KR"
    ? buildKoreanLines(result, copy)
    : buildEnglishLines(result, copy);

  return [
    ...readableLines,
    "",
    `status: ${result.status}`,
    `requested_at: ${result.requestedAt}`,
    `market: ${result.market ?? "none"}`,
    `strategy_decision_id: ${result.strategyDecisionId ?? "none"}`,
    `action: ${result.action ?? "none"}`,
    `submission_accepted: ${result.submissionAccepted === null ? "none" : result.submissionAccepted}`,
    `order_id: ${result.orderId ?? "none"}`,
    `order_status: ${result.orderStatus ?? "none"}`,
    `detail: ${result.detail}`,
    OPERATOR_BOUNDARY,
  ].join("\n");
}

function buildKoreanLines(
  result: TelegramStrategyRunResult,
  copy: RunStatusCopy,
): string[] {
  return [
    "전략 실행 결과 (Strategy Run)",
    `상태: ${copy.label} - ${copy.explanation}`,
    `시장/자산: ${formatMarketAsset(result.market, "ko-KR")}`,
    `판단: ${formatAction(result.action, "ko-KR")}`,
    `전략 판단 ID: ${result.strategyDecisionId ?? "없음"}`,
    `주문 결과: ${formatSubmission(result.submissionAccepted, "ko-KR")}`,
    `주문 ID: ${result.orderId ?? "없음"}`,
    `주문 상태: ${formatOrderStatus(result.orderStatus, "ko-KR")}`,
    `요청 시각: ${formatTelegramTimestamp(result.requestedAt, "ko-KR")}`,
    "주의: LIVE 모드의 /run은 모든 안전 조건을 통과하면 실주문을 전송할 수 있습니다.",
    ...(result.submissionAccepted === true
      ? ["주의: 주문 접수는 체결 증명이 아닙니다."]
      : []),
    `다음 조치: ${formatNextAction(result, "ko-KR")}`,
  ];
}

function buildEnglishLines(
  result: TelegramStrategyRunResult,
  copy: RunStatusCopy,
): string[] {
  return [
    "Strategy Run Result (Strategy Run)",
    `State: ${copy.label} - ${copy.explanation}`,
    `Market/asset: ${formatMarketAsset(result.market, "en-US")}`,
    `Action: ${formatAction(result.action, "en-US")}`,
    `Strategy decision ID: ${result.strategyDecisionId ?? "none"}`,
    `Submission: ${formatSubmission(result.submissionAccepted, "en-US")}`,
    `Order ID: ${result.orderId ?? "none"}`,
    `Order state: ${formatOrderStatus(result.orderStatus, "en-US")}`,
    `Requested at: ${formatTelegramTimestamp(result.requestedAt, "en-US")}`,
    "Warning: In LIVE mode, /run can send a real order when every safety condition passes.",
    ...(result.submissionAccepted === true
      ? ["Warning: Acceptance is not proof of a fill."]
      : []),
    `Next action: ${formatNextAction(result, "en-US")}`,
  ];
}

function formatMarketAsset(
  market: TelegramStrategyRunResult["market"],
  locale: TelegramLocale,
): string {
  if (market === "KRW-BTC") {
    return "KRW-BTC / BTC";
  }
  if (market === "KRW-ETH") {
    return "KRW-ETH / ETH";
  }
  return localizedNone(locale);
}

function formatAction(
  action: TelegramStrategyRunResult["action"],
  locale: TelegramLocale,
): string {
  if (action === null) {
    return locale === "ko-KR" ? "판단 없음" : "No decision";
  }
  return locale === "ko-KR" ? KOREAN_ACTION_LABELS[action] : ENGLISH_ACTION_LABELS[action];
}

function formatSubmission(
  accepted: TelegramStrategyRunResult["submissionAccepted"],
  locale: TelegramLocale,
): string {
  if (accepted === null) {
    return locale === "ko-KR" ? "주문 요청 없음" : "No order requested";
  }
  if (accepted) {
    return locale === "ko-KR"
      ? "주문 접수됨 (체결을 의미하지 않습니다.)"
      : "Order accepted (acceptance is not a fill)";
  }
  return locale === "ko-KR" ? "주문 거부됨" : "Order rejected";
}

function formatOrderStatus(
  status: TelegramStrategyRunResult["orderStatus"],
  locale: TelegramLocale,
): string {
  if (status === null) {
    return localizedNone(locale);
  }
  return locale === "ko-KR"
    ? KOREAN_ORDER_STATUS_LABELS[status]
    : ENGLISH_ORDER_STATUS_LABELS[status];
}

function formatNextAction(
  result: TelegramStrategyRunResult,
  locale: TelegramLocale,
): string {
  if (result.status === "ALREADY_RUNNING") {
    return locale === "ko-KR"
      ? "진행 중인 실행이 끝날 때까지 기다린 뒤 나중에 다시 시도하세요."
      : "Wait for the current run to finish, then retry later.";
  }
  if (result.status === "SKIPPED") {
    return locale === "ko-KR"
      ? "아래의 정확한 detail과 /readiness를 확인하세요."
      : "Inspect the exact detail below and /readiness.";
  }
  if (result.status === "NOT_CONNECTED") {
    return locale === "ko-KR"
      ? "/config와 실행 중인 프로세스의 전략 러너 연결 상태를 확인하세요."
      : "Inspect /config and the strategy-runner wiring in the running process.";
  }
  if (result.status === "FAILED") {
    return locale === "ko-KR"
      ? "아래의 정확한 detail과 /alerts를 확인하세요."
      : "Inspect the exact detail below and /alerts.";
  }
  if (result.submissionAccepted === true && result.orderId) {
    return locale === "ko-KR"
      ? `/order ${result.orderId}로 주문 생명주기를 확인하고, 거래소 동기화가 필요하면 /sync를 사용하세요.`
      : `Inspect the order lifecycle with /order ${result.orderId}; use /sync when exchange reconciliation is needed.`;
  }
  if (result.submissionAccepted === true) {
    return locale === "ko-KR"
      ? "/orders에서 주문을 확인하고, 거래소 동기화가 필요하면 /sync를 사용하세요."
      : "Inspect /orders and use /sync when exchange reconciliation is needed.";
  }
  if (result.submissionAccepted === false) {
    return locale === "ko-KR"
      ? "아래의 정확한 detail을 확인하고 /risks와 /alerts를 점검하세요."
      : "Inspect the exact detail below, then review /risks and /alerts.";
  }
  return locale === "ko-KR"
    ? "주문을 요청하지 않았습니다. /preview로 현재 판단을 확인하거나 다음 주기를 기다리세요."
    : "No order was requested. Inspect /preview or wait for the next cycle.";
}

function localizedNone(locale: TelegramLocale): string {
  return locale === "ko-KR" ? "없음" : "none";
}
