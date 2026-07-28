import type { TelegramInboundOffsetRecord } from "../../../domain/types.js";
import type { TelegramInboundPollingStatus } from "../inbound.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

type OffsetComparison = "SYNCHRONIZED" | "DIFFERENT" | "UNAVAILABLE";

export function formatTelegramInboundPresentation(
  status: TelegramInboundPollingStatus | null,
  offset: TelegramInboundOffsetRecord | null,
  locale: TelegramLocale,
): string {
  const comparison = compareOffsets(status, offset);
  const nextAction = describeNextAction(status, comparison, locale);

  return locale === "en-US"
    ? [
        "Telegram command inbound",
        "Current in-memory polling state:",
        `- State: ${describeRuntimeState(status, locale)}`,
        `- Next action: ${nextAction}`,
        `- Enabled ${yesNoUnknown(status?.enabled, locale)} | configured ${yesNoUnknown(status?.configured, locale)} | running ${yesNoUnknown(status?.running, locale)}`,
        `- Offset storage: ${describeOffsetStorage(status, locale)}`,
        `- Runtime offset loaded: ${yesNoUnknown(status?.offsetLoaded, locale)}`,
        `- Next offset ${valueOrNone(status?.nextOffset, locale)} | last update ID ${valueOrNone(status?.lastUpdateId, locale)}`,
        `- Poll interval ${formatMilliseconds(status?.pollIntervalMs, locale)} | long-poll timeout ${formatSeconds(status?.longPollTimeoutSeconds, locale)} | batch limit ${formatCount(status?.limit, locale)}`,
        `- Last poll ${formatTelegramTimestamp(status?.lastPollAt ?? null, locale)}`,
        `- Process lifetime: processed ${valueOrUnknown(status?.processedCount, locale)} | ignored ${valueOrUnknown(status?.ignoredCount, locale)} | failed ${valueOrUnknown(status?.failedCount, locale)}`,
        ...(status?.lastError ? [`- Last error: ${status.lastError}`] : []),
        "Persisted telegram_inbound_offsets progress:",
        `- Persisted record: ${offset ? "present" : "absent"}`,
        `- Next offset ${valueOrNone(offset?.nextOffset, locale)} | last update ID ${valueOrNone(offset?.lastUpdateId, locale)}`,
        `- Persisted update ${formatTelegramTimestamp(offset?.updatedAt ?? null, locale)}`,
        `- Runtime and persisted offset comparison: ${describeComparison(comparison, locale)}`,
        "Full technical details: /inbound detail",
      ].join("\n")
    : [
        "텔레그램 명령 수신",
        "현재 메모리 폴링 상태:",
        `- 상태: ${describeRuntimeState(status, locale)}`,
        `- 다음 조치: ${nextAction}`,
        `- 활성화 ${yesNoUnknown(status?.enabled, locale)} | 설정 완료 ${yesNoUnknown(status?.configured, locale)} | 실행 중 ${yesNoUnknown(status?.running, locale)}`,
        `- 오프셋 저장: ${describeOffsetStorage(status, locale)}`,
        `- 런타임 오프셋 로드: ${yesNoUnknown(status?.offsetLoaded, locale)}`,
        `- 다음 오프셋 ${valueOrNone(status?.nextOffset, locale)} | 최근 업데이트 ID ${valueOrNone(status?.lastUpdateId, locale)}`,
        `- 폴링 간격 ${formatMilliseconds(status?.pollIntervalMs, locale)} | 롱폴링 제한 ${formatSeconds(status?.longPollTimeoutSeconds, locale)} | 배치 한도 ${formatCount(status?.limit, locale)}`,
        `- 최근 폴링 ${formatTelegramTimestamp(status?.lastPollAt ?? null, locale)}`,
        `- 프로세스 누적: 처리 ${valueOrUnknown(status?.processedCount, locale)}건 | 무시 ${valueOrUnknown(status?.ignoredCount, locale)}건 | 실패 ${valueOrUnknown(status?.failedCount, locale)}건`,
        ...(status?.lastError ? [`- 최근 오류: ${status.lastError}`] : []),
        "저장된 telegram_inbound_offsets 진행:",
        `- 저장 레코드: ${offset ? "있음" : "없음"}`,
        `- 다음 오프셋 ${valueOrNone(offset?.nextOffset, locale)} | 최근 업데이트 ID ${valueOrNone(offset?.lastUpdateId, locale)}`,
        `- 저장 갱신 ${formatTelegramTimestamp(offset?.updatedAt ?? null, locale)}`,
        `- 런타임과 저장 오프셋 비교: ${describeComparison(comparison, locale)}`,
        "전체 기술 정보: /inbound detail",
      ].join("\n");
}

function describeRuntimeState(
  status: TelegramInboundPollingStatus | null,
  locale: TelegramLocale,
): string {
  if (!status) {
    return locale === "en-US" ? "unavailable" : "확인 불가";
  }
  if (!status.enabled) {
    return locale === "en-US" ? "disabled" : "비활성";
  }
  if (!status.configured) {
    return locale === "en-US"
      ? "enabled but not configured"
      : "활성화됐지만 설정 미완료";
  }
  if (!status.running) {
    return locale === "en-US"
      ? "configured but not running"
      : "설정됐지만 실행 중이 아님";
  }
  return locale === "en-US" ? "running" : "실행 중";
}

function describeNextAction(
  status: TelegramInboundPollingStatus | null,
  comparison: OffsetComparison,
  locale: TelegramLocale,
): string {
  if (!status) {
    return locale === "en-US"
      ? "check runtime status wiring"
      : "런타임 상태 연결 확인";
  }
  if (!status.enabled) {
    return locale === "en-US"
      ? "enable inbound polling if needed"
      : "필요 시 인바운드 폴링 활성화";
  }
  if (!status.configured) {
    return locale === "en-US"
      ? "configure the bot token and operator chat ID"
      : "봇 토큰과 운영자 채팅 ID 설정";
  }
  if (!status.running) {
    return locale === "en-US"
      ? "check inbound polling startup"
      : "인바운드 폴링 시작 상태 확인";
  }
  if (status.lastError || status.failedCount > 0) {
    return locale === "en-US"
      ? "inspect the latest polling error"
      : "최근 폴링 오류 확인";
  }
  if (comparison === "DIFFERENT") {
    return locale === "en-US"
      ? "inspect the runtime and persisted offset difference"
      : "런타임과 저장 오프셋 차이 확인";
  }
  return locale === "en-US" ? "none" : "없음";
}

function compareOffsets(
  status: TelegramInboundPollingStatus | null,
  offset: TelegramInboundOffsetRecord | null,
): OffsetComparison {
  if (status?.nextOffset === null || status?.nextOffset === undefined || !offset) {
    return "UNAVAILABLE";
  }
  return status.nextOffset === offset.nextOffset ? "SYNCHRONIZED" : "DIFFERENT";
}

function describeComparison(comparison: OffsetComparison, locale: TelegramLocale): string {
  if (comparison === "SYNCHRONIZED") {
    return locale === "en-US" ? "synchronized" : "동기화됨";
  }
  if (comparison === "DIFFERENT") {
    return locale === "en-US" ? "different" : "다름";
  }
  return locale === "en-US" ? "unavailable" : "확인 불가";
}

function describeOffsetStorage(
  status: TelegramInboundPollingStatus | null,
  locale: TelegramLocale,
): string {
  if (!status) {
    return locale === "en-US" ? "unknown" : "알 수 없음";
  }
  if (status.offsetStorage === "DURABLE") {
    return locale === "en-US" ? "durable" : "영구 저장";
  }
  return locale === "en-US" ? "memory" : "메모리";
}

function yesNoUnknown(value: boolean | undefined, locale: TelegramLocale): string {
  if (value === undefined) {
    return locale === "en-US" ? "unknown" : "알 수 없음";
  }
  if (locale === "en-US") {
    return value ? "yes" : "no";
  }
  return value ? "예" : "아니요";
}

function valueOrNone(value: number | null | undefined, locale: TelegramLocale): string {
  return value === null || value === undefined
    ? locale === "en-US" ? "none" : "없음"
    : String(value);
}

function valueOrUnknown(value: number | undefined, locale: TelegramLocale): string {
  return value === undefined
    ? locale === "en-US" ? "unknown" : "알 수 없음"
    : String(value);
}

function formatMilliseconds(value: number | undefined, locale: TelegramLocale): string {
  if (value === undefined) {
    return locale === "en-US" ? "unknown" : "알 수 없음";
  }
  if (value % 1_000 === 0) {
    return formatSeconds(value / 1_000, locale);
  }
  return locale === "en-US" ? `${value} ms` : `${value}ms`;
}

function formatSeconds(value: number | undefined, locale: TelegramLocale): string {
  if (value === undefined) {
    return locale === "en-US" ? "unknown" : "알 수 없음";
  }
  if (locale === "en-US") {
    return `${value} second${value === 1 ? "" : "s"}`;
  }
  return `${value}초`;
}

function formatCount(value: number | undefined, locale: TelegramLocale): string {
  if (value === undefined) {
    return locale === "en-US" ? "unknown" : "알 수 없음";
  }
  return locale === "en-US"
    ? `${value} update${value === 1 ? "" : "s"}`
    : `${value}건`;
}
