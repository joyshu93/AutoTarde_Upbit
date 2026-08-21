import type {
  RiskEventLevel,
  RiskEventRecord,
  RiskRuleCode,
} from "../../../domain/types.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

type LocalizedRule = {
  readonly ko: {
    readonly title: string;
    readonly meaning: string;
  };
  readonly en: {
    readonly title: string;
    readonly meaning: string;
  };
};

const RISK_RULE_PRESENTATIONS: Readonly<Record<RiskRuleCode, LocalizedRule>> = {
  GLOBAL_KILL_SWITCH: rule(
    "글로벌 킬 스위치",
    "전체 주문 실행이 운영자 안전장치로 차단되었습니다.",
    "Global kill switch",
    "All order execution was blocked by the operator safety switch.",
  ),
  EXECUTION_PAUSED: rule(
    "실행 일시정지",
    "운영자가 주문 실행을 일시정지한 상태에서 요청이 차단되었습니다.",
    "Execution paused",
    "The request was blocked while order execution was paused by the operator.",
  ),
  SYSTEM_DEGRADED: rule(
    "시스템 복구 필요",
    "복구 또는 동기화 확인이 필요한 시스템 상태에서 요청이 차단되었습니다.",
    "System degraded",
    "The request was blocked while the system required recovery or reconciliation review.",
  ),
  PER_ASSET_MAX_ALLOCATION: rule(
    "자산별 최대 배분",
    "해당 자산의 예상 배분 비율이 설정된 한도를 넘었습니다.",
    "Per-asset allocation limit",
    "The projected allocation for the asset exceeded its configured limit.",
  ),
  TOTAL_EXPOSURE_CAP: rule(
    "총 노출 한도",
    "주문 후 전체 자산 노출이 설정된 상한을 넘을 것으로 판단되었습니다.",
    "Total exposure cap",
    "Projected total asset exposure would exceed the configured cap.",
  ),
  STALE_PRICE_GUARD: rule(
    "오래된 가격 차단",
    "가격 스냅샷이 없거나 주문 판단에 사용된 가격이 허용 시간을 초과했습니다.",
    "Stale price guard",
    "The price snapshot was missing or the price used for the order decision exceeded the allowed age.",
  ),
  DUPLICATE_ORDER_GUARD: rule(
    "중복 주문 차단",
    "동일한 활성 주문이 이미 있어 중복 실행을 막았습니다.",
    "Duplicate order guard",
    "A matching active order already existed, so duplicate execution was blocked.",
  ),
  MINIMUM_ORDER_VALUE_GUARD: rule(
    "최소 주문금액",
    "계산된 주문금액이 로컬 최소 주문 기준보다 작았습니다.",
    "Minimum order value",
    "The calculated order value was below the local minimum.",
  ),
  LIVE_EXECUTION_DISABLED: rule(
    "실주문 비활성화",
    "실주문 전송에 필요한 실행 모드 또는 안전 게이트가 비활성화되어 있습니다.",
    "Live execution disabled",
    "The execution mode or safety gate required for live transmission was disabled.",
  ),
  UNSUPPORTED_MARKET: rule(
    "지원하지 않는 마켓",
    "허용된 KRW-BTC 또는 KRW-ETH 현물 범위를 벗어난 요청입니다.",
    "Unsupported market",
    "The request was outside the allowed KRW-BTC or KRW-ETH spot scope.",
  ),
  UNSUPPORTED_ORDER_TYPE: rule(
    "지원하지 않는 주문 유형",
    "시스템이 허용하지 않는 주문 유형이 요청되었습니다.",
    "Unsupported order type",
    "The requested order type is not allowed by the system.",
  ),
  EXCHANGE_MIN_TOTAL_GUARD: rule(
    "거래소 최소 주문금액",
    "주문금액이 Upbit가 안내한 최소 주문 기준보다 작았습니다.",
    "Exchange minimum order value",
    "The order value was below the minimum reported by Upbit.",
  ),
  EXCHANGE_MAX_TOTAL_GUARD: rule(
    "거래소 최대 주문금액",
    "주문금액이 Upbit가 안내한 최대 주문 기준보다 컸습니다.",
    "Exchange maximum order value",
    "The order value exceeded the maximum reported by Upbit.",
  ),
  MARKET_OFFLINE: rule(
    "마켓 거래 중지",
    "Upbit가 해당 마켓을 현재 주문할 수 없는 상태로 안내했습니다.",
    "Market offline",
    "Upbit reported that the market was not currently available for orders.",
  ),
  EXCHANGE_ORDER_CHANCE_FAILED: rule(
    "주문 가능 정보 조회 실패",
    "Upbit 주문 가능 조건을 확인하지 못해 안전하게 주문을 중단했습니다.",
    "Order availability check failed",
    "The order was stopped because Upbit order availability could not be verified.",
  ),
  EXCHANGE_ORDER_TEST_FAILED: rule(
    "주문 테스트 실패",
    "Upbit 주문 테스트가 통과하지 않아 실제 전송을 중단했습니다.",
    "Exchange order test failed",
    "Live transmission was stopped because the Upbit order test did not pass.",
  ),
  ORDER_RECOVERY_REQUIRED: rule(
    "주문 복구 필요",
    "로컬 주문 상태와 거래소 결과를 다시 확인해야 합니다.",
    "Order recovery required",
    "The local order state and exchange result require reconciliation.",
  ),
  BALANCE_DRIFT_DETECTED: rule(
    "잔고 불일치",
    "거래소 잔고 변화가 로컬 체결 이력만으로 설명되지 않았습니다.",
    "Balance drift detected",
    "The exchange balance change was not fully explained by local fill history.",
  ),
  POSITION_DRIFT_DETECTED: rule(
    "포지션 불일치",
    "거래소 보유 수량 변화가 로컬 체결 이력만으로 설명되지 않았습니다.",
    "Position drift detected",
    "The exchange position change was not fully explained by local fill history.",
  ),
  POSITION_GUARD_PILOT_UNCERTAIN_ORDER: rule(
    "주문 확인 필요",
    "주문 전송 결과를 확정할 수 없어 조정 확인이 필요합니다.",
    "Uncertain order submission",
    "The order submission outcome is unknown and requires reconciliation.",
  ),
  ACCOUNT_EXECUTION_LEASE_BLOCKED: rule(
    "계정 실행 잠금 차단",
    "다른 실행 시도 또는 미해결 주문이 계정 실행 잠금을 점유하고 있습니다.",
    "Account execution lease blocked",
    "Another execution attempt or unresolved order owns the account execution lease.",
  ),
};

export function formatRiskEventsPresentation(
  events: readonly RiskEventRecord[],
  locale: TelegramLocale,
): string {
  const sortedEvents = sortRiskEvents(events);
  const counts = countLevels(events);

  if (locale === "en-US") {
    return [
      "Recent risk history",
      "Notice: This is persisted recent history, not the current active blocker state.",
      `Returned: ${events.length} record(s) (bounded to 10 by the repository read)`,
      `Levels: INFO ${counts.INFO} | WARN ${counts.WARN} | BLOCK ${counts.BLOCK}`,
      ...(sortedEvents.length === 0
        ? ["No persisted recent risk records."]
        : sortedEvents.flatMap((event) => formatEvent(event, locale))),
      "Full technical history: /risks detail",
    ].join("\n");
  }

  return [
    "최근 리스크 이력",
    "안내: 저장된 최근 이력이며 현재 활성 차단 상태가 아닙니다.",
    `조회 건수: ${events.length}건 (저장소 조회 최대 10건)`,
    `수준별: 정보 ${counts.INFO} | 주의 ${counts.WARN} | 차단 ${counts.BLOCK}`,
    ...(sortedEvents.length === 0
      ? ["저장된 최근 리스크 기록이 없습니다."]
      : sortedEvents.flatMap((event) => formatEvent(event, locale))),
    "전체 기술 이력: /risks detail",
  ].join("\n");
}

function sortRiskEvents(events: readonly RiskEventRecord[]): RiskEventRecord[] {
  return [...events].sort((left, right) => {
    const leftTime = parseInstant(left.createdAt);
    const rightTime = parseInstant(right.createdAt);
    if (leftTime === null && rightTime === null) {
      return 0;
    }
    if (leftTime === null) {
      return 1;
    }
    if (rightTime === null) {
      return -1;
    }
    return rightTime - leftTime;
  });
}

function formatEvent(event: RiskEventRecord, locale: TelegramLocale): string[] {
  const localizedRule = RISK_RULE_PRESENTATIONS[event.ruleCode];
  const selectedRule = locale === "ko-KR" ? localizedRule.ko : localizedRule.en;
  const validInstant = parseInstant(event.createdAt) !== null;
  const timestamp = validInstant
    ? formatTelegramTimestamp(event.createdAt, locale)
    : locale === "ko-KR"
      ? `데이터 오류(잘못된 시각: ${event.createdAt})`
      : `Data error (invalid timestamp: ${event.createdAt})`;
  const lines = locale === "ko-KR"
    ? [
        `- ${timestamp} | ${describeLevel(event.level, locale)} | ${selectedRule.title}`,
        `  의미: ${selectedRule.meaning}`,
        `  원문: ${event.message}`,
      ]
    : [
        `- ${timestamp} | ${describeLevel(event.level, locale)} | ${selectedRule.title}`,
        `  Meaning: ${selectedRule.meaning}`,
        `  Original: ${event.message}`,
      ];

  if (event.orderId) {
    lines.push(locale === "ko-KR"
      ? `  주문 확인: /order ${event.orderId}`
      : `  Inspect order: /order ${event.orderId}`);
  }
  if (event.strategyDecisionId) {
    lines.push(locale === "ko-KR"
      ? `  전략 결정 ID: ${event.strategyDecisionId}`
      : `  Strategy decision ID: ${event.strategyDecisionId}`);
  }

  return lines;
}

function countLevels(events: readonly RiskEventRecord[]): Record<RiskEventLevel, number> {
  const counts: Record<RiskEventLevel, number> = {
    INFO: 0,
    WARN: 0,
    BLOCK: 0,
  };
  for (const event of events) {
    counts[event.level] += 1;
  }
  return counts;
}

function describeLevel(level: RiskEventLevel, locale: TelegramLocale): string {
  if (locale === "en-US") {
    return level;
  }
  switch (level) {
    case "INFO":
      return "정보";
    case "WARN":
      return "주의";
    case "BLOCK":
      return "차단";
  }
}

function parseInstant(value: string): number | null {
  const instant = new Date(value).getTime();
  return Number.isNaN(instant) ? null : instant;
}

function rule(
  koTitle: string,
  koMeaning: string,
  enTitle: string,
  enMeaning: string,
): LocalizedRule {
  return {
    ko: {
      title: koTitle,
      meaning: koMeaning,
    },
    en: {
      title: enTitle,
      meaning: enMeaning,
    },
  };
}
