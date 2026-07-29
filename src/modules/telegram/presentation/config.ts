import type { TelegramRuntimeConfigSnapshot } from "../interfaces.js";
import type { TelegramLocale } from "./locale.js";

export function formatRuntimeConfigPresentation(
  config: TelegramRuntimeConfigSnapshot | null,
  technicalBody: string,
  locale: TelegramLocale,
): string {
  const lines = locale === "ko-KR"
    ? buildKoreanLines(config)
    : buildEnglishLines(config);

  return [...lines, locale === "ko-KR" ? "기술 원문:" : "Canonical details:", technicalBody].join("\n");
}

function buildKoreanLines(config: TelegramRuntimeConfigSnapshot | null): string[] {
  if (!config) {
    return [
      "실행 설정 (Runtime Config)",
      "실행 설정을 확인할 수 없습니다.",
      "필요 조치: 애플리케이션의 Telegram 라우터 설정 연결을 확인하세요.",
      "비밀값은 표시하지 않습니다.",
    ];
  }

  const missing = describeMissingConfiguration(config, "ko-KR");
  return [
    "실행 설정 (Runtime Config)",
    `실행 모드: ${config.executionMode === "LIVE" ? "실거래" : "모의 실행"} (${config.executionMode})`,
    `실주문: ${isLiveOrderPathEnabled(config) ? "설정상 허용" : "차단됨"}`,
    `주문 경로: ${config.liveSendPath} | 실주문 게이트: ${config.liveExecutionGate}`,
    `Upbit 계좌 조회: ${config.exchangeBackedReadEnabled ? "사용" : "사용 안 함"}`,
    `Telegram 알림: ${config.telegramDeliveryEnabled ? "사용" : "사용 안 함"} | 명령 수신: ${config.telegramInboundPollingEnabled ? "사용" : "사용 안 함"}`,
    `전략 스케줄러: ${config.strategySchedulerEnabled ? "사용" : "사용 안 함"} | 시작 즉시 실행: ${config.strategySchedulerRunOnStart ? "예" : "아니요"}`,
    `필수 설정 누락: ${missing.length === 0 ? "없음" : missing.join(", ")}`,
    `무시되는 이전 환경 변수: ${config.deprecatedIgnoredEnvVars.length === 0 ? "없음" : config.deprecatedIgnoredEnvVars.join(",")}`,
    "비밀값: 실제 값은 표시하지 않고 설정 여부만 기술 원문에 표시합니다.",
  ];
}

function buildEnglishLines(config: TelegramRuntimeConfigSnapshot | null): string[] {
  if (!config) {
    return [
      "Runtime configuration (Runtime Config)",
      "Runtime configuration is unavailable.",
      "Required action: Check the Telegram router configuration wiring.",
      "Secret values are not displayed.",
    ];
  }

  const missing = describeMissingConfiguration(config, "en-US");
  return [
    "Runtime configuration (Runtime Config)",
    `Execution mode: ${config.executionMode === "LIVE" ? "live" : "dry run"} (${config.executionMode})`,
    `Real orders: ${isLiveOrderPathEnabled(config) ? "allowed by configuration" : "blocked"}`,
    `Order path: ${config.liveSendPath} | live gate: ${config.liveExecutionGate}`,
    `Upbit account reads: ${config.exchangeBackedReadEnabled ? "enabled" : "disabled"}`,
    `Telegram delivery: ${config.telegramDeliveryEnabled ? "enabled" : "disabled"} | inbound commands: ${config.telegramInboundPollingEnabled ? "enabled" : "disabled"}`,
    `Strategy scheduler: ${config.strategySchedulerEnabled ? "enabled" : "disabled"} | run on start: ${config.strategySchedulerRunOnStart ? "yes" : "no"}`,
    `Missing required configuration: ${missing.length === 0 ? "none" : missing.join(", ")}`,
    `Ignored deprecated environment variables: ${config.deprecatedIgnoredEnvVars.length === 0 ? "none" : config.deprecatedIgnoredEnvVars.join(",")}`,
    "Secrets: Actual values are hidden; canonical details show configured status only.",
  ];
}

function isLiveOrderPathEnabled(config: TelegramRuntimeConfigSnapshot): boolean {
  return config.executionMode === "LIVE"
    && config.liveExecutionGate === "ENABLED"
    && config.liveSendPath === "LIVE_ADAPTER";
}

function describeMissingConfiguration(
  config: TelegramRuntimeConfigSnapshot,
  locale: TelegramLocale,
): string[] {
  const missing: string[] = [];
  if (config.executionMode === "LIVE" && !config.exchangeBackedReadEnabled) {
    missing.push(locale === "ko-KR" ? "Upbit 조회 자격 증명" : "Upbit read credentials");
  }
  if (config.telegramDeliveryEnabled || config.telegramInboundPollingEnabled) {
    if (!config.telegramBotTokenConfigured) {
      missing.push(locale === "ko-KR" ? "Telegram 봇 토큰" : "Telegram bot token");
    }
    if (!config.telegramOperatorChatIdConfigured) {
      missing.push(locale === "ko-KR" ? "Telegram 운영자 채팅 ID" : "Telegram operator chat ID");
    }
  }
  return missing;
}
