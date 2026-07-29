import type {
  HistoryRecoveryCheckpointRecord,
  ReconciliationRunRecord,
} from "../../../domain/types.js";
import { formatTelegramTimestamp } from "./common.js";
import {
  describeConfidence,
  describeCoverage,
  type HistoryRecoveryPresentationSummary,
} from "./history.js";
import type { TelegramLocale } from "./locale.js";

export function formatRecoveryPresentation(
  latestRun: ReconciliationRunRecord | null,
  historyRecovery: HistoryRecoveryPresentationSummary | null,
  checkpoints: readonly HistoryRecoveryCheckpointRecord[],
  technicalBody: string,
  locale: TelegramLocale,
): string {
  const readable = locale === "ko-KR"
    ? buildKoreanLines(latestRun, historyRecovery, checkpoints)
    : buildEnglishLines(latestRun, historyRecovery, checkpoints);
  return [...readable, locale === "ko-KR" ? "기술 원문:" : "Canonical details:", technicalBody].join("\n");
}

function buildKoreanLines(
  latestRun: ReconciliationRunRecord | null,
  historyRecovery: HistoryRecoveryPresentationSummary | null,
  checkpoints: readonly HistoryRecoveryCheckpointRecord[],
): string[] {
  const lines = [
    "거래소 이력 복구 (Exchange History Recovery)",
    "주의: 저장된 복구 근거만 표시하며 거래소 전체 이력의 완전성을 보장하지 않습니다.",
  ];
  if (!latestRun) {
    return [
      ...lines,
      "저장된 복구 실행 근거가 없습니다.",
      `저장 체크포인트: ${checkpoints.length}개`,
      "필요 조치: /sync 실행 후 /recovery에서 저장 근거를 다시 확인하세요.",
    ];
  }

  return [
    ...lines,
    `최근 실행: ${formatTelegramTimestamp(latestRun.startedAt, "ko-KR")} | 상태 ${latestRun.status}`,
    `복구 범위: ${describeCoverage(historyRecovery?.coverageStatus ?? null, "ko-KR")}`,
    `신뢰도: ${describeConfidence(historyRecovery, "ko-KR")}`,
    `보존 범위 판단: ${describeRetention(historyRecovery?.retentionStatus ?? null, "ko-KR")}`,
    `복구 주문: ${historyRecovery?.recoveredOrderCount ?? "unknown"}건 | 검사 스냅샷: ${historyRecovery?.scannedSnapshotCount ?? "unknown"}개`,
    ...describeMarkets(historyRecovery, "ko-KR"),
    `저장 체크포인트: ${checkpoints.length}개`,
    ...checkpoints.map((checkpoint) =>
      `- ${checkpoint.market} | 다음 복구 경계 ${formatTelegramTimestamp(checkpoint.nextWindowEndAt, "ko-KR")} | 갱신 ${formatTelegramTimestamp(checkpoint.updatedAt, "ko-KR")}`),
    "필요 조치: 범위와 신뢰도가 완료 근거를 제공할 때까지 /sync와 /recovery로 진행 상황을 확인하세요.",
  ];
}

function buildEnglishLines(
  latestRun: ReconciliationRunRecord | null,
  historyRecovery: HistoryRecoveryPresentationSummary | null,
  checkpoints: readonly HistoryRecoveryCheckpointRecord[],
): string[] {
  const lines = [
    "Exchange-history recovery (Exchange History Recovery)",
    "Caution: This shows persisted recovery evidence and does not guarantee complete exchange history.",
  ];
  if (!latestRun) {
    return [
      ...lines,
      "No persisted recovery-run evidence is available.",
      `Stored checkpoints: ${checkpoints.length}`,
      "Required action: Run /sync, then inspect /recovery again.",
    ];
  }

  return [
    ...lines,
    `Latest run: ${formatTelegramTimestamp(latestRun.startedAt, "en-US")} | status ${latestRun.status}`,
    `Coverage: ${describeCoverage(historyRecovery?.coverageStatus ?? null, "en-US")}`,
    `Confidence: ${describeConfidence(historyRecovery, "en-US")}`,
    `Retention assessment: ${describeRetention(historyRecovery?.retentionStatus ?? null, "en-US")}`,
    `Recovered orders: ${historyRecovery?.recoveredOrderCount ?? "unknown"} | scanned snapshots: ${historyRecovery?.scannedSnapshotCount ?? "unknown"}`,
    ...describeMarkets(historyRecovery, "en-US"),
    `Stored checkpoints: ${checkpoints.length}`,
    ...checkpoints.map((checkpoint) =>
      `- ${checkpoint.market} | next recovery boundary ${formatTelegramTimestamp(checkpoint.nextWindowEndAt, "en-US")} | updated ${formatTelegramTimestamp(checkpoint.updatedAt, "en-US")}`),
    "Required action: Use /sync and /recovery until coverage and confidence provide completion evidence.",
  ];
}

function describeRetention(value: string | null, locale: TelegramLocale): string {
  if (value === null) {
    return locale === "ko-KR" ? "근거 없음 (none)" : "no evidence (none)";
  }
  const labels: Record<string, readonly [string, string]> = {
    WITHIN_ASSUMED_RETENTION: ["가정된 보존 기간 안쪽", "within assumed retention"],
    BEFORE_ASSUMED_RETENTION: ["가정된 보존 기간 이전", "before assumed retention"],
    UNKNOWN: ["알 수 없음", "unknown"],
  };
  const label = labels[value]?.[locale === "ko-KR" ? 0 : 1] ?? (locale === "ko-KR" ? "알 수 없음" : "unknown");
  return `${label} (${value})`;
}

function describeMarkets(
  historyRecovery: HistoryRecoveryPresentationSummary | null,
  locale: TelegramLocale,
): string[] {
  if (!historyRecovery || historyRecovery.markets.length === 0) {
    return [locale === "ko-KR" ? "시장 진행: 없음" : "Market progress: none"];
  }

  return historyRecovery.markets.map((market) => {
    const complete = market.archiveComplete === true
      ? locale === "ko-KR" ? "저장 근거상 완료" : "complete in persisted evidence"
      : market.archiveComplete === false
        ? locale === "ko-KR" ? "완료 아님" : "not complete"
        : locale === "ko-KR" ? "알 수 없음" : "unknown";
    const boundary = formatTelegramTimestamp(market.nextWindowEndAt, locale);
    return locale === "ko-KR"
      ? `시장 진행: ${market.market} | ${complete} | 다음 복구 경계 ${boundary}`
      : `Market progress: ${market.market} | ${complete} | next recovery boundary ${boundary}`;
  });
}
