import type {
  ExecutionStateTransitionRecord,
  ReconciliationRunRecord,
} from "../../../domain/types.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

export interface HistoryRecoveryPresentationSummary {
  coverageStatus: string | null;
  confidenceLevel: string | null;
  confidenceReason: string | null;
  retentionStatus: string | null;
  failureMessage: string | null;
  recoveredOrderCount: number | null;
  scannedSnapshotCount: number | null;
  markets: ReadonlyArray<{
    market: string;
    archiveComplete: boolean | null;
    nextWindowEndAt: string | null;
  }>;
}

export interface ReconciliationRunPresentationSummary {
  run: ReconciliationRunRecord;
  source: string | null;
  issueCount: number | null;
  issueCodes: readonly string[];
  historyRecovery: HistoryRecoveryPresentationSummary | null;
}

export function formatStateHistoryPresentation(
  transitions: readonly ExecutionStateTransitionRecord[],
  technicalBody: string,
  locale: TelegramLocale,
): string {
  const readable = locale === "ko-KR"
    ? buildKoreanStateHistory(transitions)
    : buildEnglishStateHistory(transitions);
  return [...readable, locale === "ko-KR" ? "기술 원문:" : "Canonical details:", technicalBody].join("\n");
}

export function formatReconciliationHistoryPresentation(
  summaries: readonly ReconciliationRunPresentationSummary[],
  technicalBody: string,
  locale: TelegramLocale,
): string {
  const sorted = [...summaries].sort((left, right) =>
    right.run.startedAt.localeCompare(left.run.startedAt));
  const readable = locale === "ko-KR"
    ? buildKoreanReconciliationHistory(sorted)
    : buildEnglishReconciliationHistory(sorted);
  return [...readable, locale === "ko-KR" ? "기술 원문:" : "Canonical details:", technicalBody].join("\n");
}

function buildKoreanStateHistory(
  transitions: readonly ExecutionStateTransitionRecord[],
): string[] {
  const lines = [
    "실행 상태 변경 이력 (Execution State History)",
    "주의: 저장된 과거 기록이며 현재 실행 상태를 증명하지 않습니다.",
  ];
  if (transitions.length === 0) {
    return [...lines, "저장된 실행 상태 변경 기록이 없습니다.", "필요 조치: 현재 상태는 /status에서 확인하세요."];
  }

  return [
    ...lines,
    `최근 기록: ${transitions.length}건`,
    ...transitions.map((transition) =>
      `- ${formatTelegramTimestamp(transition.createdAt, "ko-KR")} | ${describeTransitionCommand(transition.command, "ko-KR")} | 시스템 ${describeSystemStatus(transition.fromSystemStatus, "ko-KR")} → ${describeSystemStatus(transition.toSystemStatus, "ko-KR")} | 모드 ${transition.fromExecutionMode ?? "none"} → ${transition.toExecutionMode} | 게이트 ${transition.fromLiveExecutionGate ?? "none"} → ${transition.toLiveExecutionGate} | 사유=${transition.reason ?? "none"}`),
    "필요 조치: 현재 상태는 /status에서 확인하세요.",
  ];
}

function buildEnglishStateHistory(
  transitions: readonly ExecutionStateTransitionRecord[],
): string[] {
  const lines = [
    "Execution-state history (Execution State History)",
    "Caution: This is persisted history and does not prove the current execution state.",
  ];
  if (transitions.length === 0) {
    return [...lines, "No execution-state transitions are stored.", "Required action: Inspect /status for the current state."];
  }

  return [
    ...lines,
    `Recent records: ${transitions.length}`,
    ...transitions.map((transition) =>
      `- ${formatTelegramTimestamp(transition.createdAt, "en-US")} | ${describeTransitionCommand(transition.command, "en-US")} | system ${describeSystemStatus(transition.fromSystemStatus, "en-US")} -> ${describeSystemStatus(transition.toSystemStatus, "en-US")} | mode ${transition.fromExecutionMode ?? "none"} -> ${transition.toExecutionMode} | gate ${transition.fromLiveExecutionGate ?? "none"} -> ${transition.toLiveExecutionGate} | reason=${transition.reason ?? "none"}`),
    "Required action: Inspect /status for the current state.",
  ];
}

function buildKoreanReconciliationHistory(
  summaries: readonly ReconciliationRunPresentationSummary[],
): string[] {
  const lines = [
    "동기화 이력 (Reconciliation History)",
    "주의: 저장된 동기화 실행 기록이며 현재 거래소 상태를 증명하지 않습니다.",
  ];
  if (summaries.length === 0) {
    return [...lines, "저장된 동기화 실행 기록이 없습니다.", "필요 조치: 필요하면 /sync 실행 후 다시 확인하세요."];
  }

  const latest = summaries[0]!;
  return [
    ...lines,
    `최근 결과: ${describeReconciliationStatus(latest.run.status, "ko-KR")} (${latest.run.status})`,
    `실행 시각: ${formatTelegramTimestamp(latest.run.startedAt, "ko-KR")}`,
    `실행 출처: ${latest.source ?? "unknown"}`,
    `감지 항목: ${latest.issueCount === null ? "알 수 없음" : `${latest.issueCount}건`}`,
    `항목 코드: ${latest.issueCodes.length === 0 ? "없음" : latest.issueCodes.join(",")}`,
    `이력 범위: ${describeCoverage(latest.historyRecovery?.coverageStatus ?? null, "ko-KR")}`,
    `신뢰도: ${describeConfidence(latest.historyRecovery, "ko-KR")}`,
    "필요 조치: 최신 상세 근거는 /readiness와 /recovery에서 함께 확인하세요.",
  ];
}

function buildEnglishReconciliationHistory(
  summaries: readonly ReconciliationRunPresentationSummary[],
): string[] {
  const lines = [
    "Reconciliation history (Reconciliation History)",
    "Caution: These are persisted reconciliation runs and do not prove current exchange state.",
  ];
  if (summaries.length === 0) {
    return [...lines, "No reconciliation runs are stored.", "Required action: Run /sync if needed, then inspect again."];
  }

  const latest = summaries[0]!;
  return [
    ...lines,
    `Latest outcome: ${describeReconciliationStatus(latest.run.status, "en-US")} (${latest.run.status})`,
    `Started: ${formatTelegramTimestamp(latest.run.startedAt, "en-US")}`,
    `Source: ${latest.source ?? "unknown"}`,
    `Issues: ${latest.issueCount === null ? "unknown" : latest.issueCount}`,
    `Issue codes: ${latest.issueCodes.length === 0 ? "none" : latest.issueCodes.join(",")}`,
    `History coverage: ${describeCoverage(latest.historyRecovery?.coverageStatus ?? null, "en-US")}`,
    `Confidence: ${describeConfidence(latest.historyRecovery, "en-US")}`,
    "Required action: Inspect /readiness and /recovery together for the latest evidence.",
  ];
}

function describeTransitionCommand(
  command: ExecutionStateTransitionRecord["command"],
  locale: TelegramLocale,
): string {
  const labels: Record<ExecutionStateTransitionRecord["command"], readonly [string, string]> = {
    BOOTSTRAP: ["초기 상태 저장", "bootstrap"],
    "/pause": ["운영자 일시정지", "operator pause"],
    "/resume": ["운영자 재개", "operator resume"],
    "/killswitch": ["긴급 중지", "kill switch"],
    SET_EXECUTION_MODE: ["실행 모드 변경", "execution-mode change"],
    SET_LIVE_EXECUTION_GATE: ["실주문 게이트 변경", "live-gate change"],
    MARK_DEGRADED: ["저하 상태 기록", "mark degraded"],
    CLEAR_DEGRADED: ["저하 상태 해제", "clear degraded"],
  };
  return labels[command][locale === "ko-KR" ? 0 : 1];
}

function describeSystemStatus(
  status: ExecutionStateTransitionRecord["fromSystemStatus"],
  locale: TelegramLocale,
): string {
  if (status === null) {
    return locale === "ko-KR" ? "없음" : "none";
  }
  const labels = {
    BOOTING: ["시작 중", "booting"],
    RUNNING: ["실행 중", "running"],
    PAUSED: ["일시정지", "paused"],
    KILL_SWITCHED: ["긴급 중지", "kill switched"],
    DEGRADED: ["저하 상태", "degraded"],
  } satisfies Record<NonNullable<ExecutionStateTransitionRecord["fromSystemStatus"]>, readonly [string, string]>;
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function describeReconciliationStatus(
  status: ReconciliationRunRecord["status"],
  locale: TelegramLocale,
): string {
  const labels: Record<ReconciliationRunRecord["status"], readonly [string, string]> = {
    SUCCESS: ["정상 완료", "successful"],
    DRIFT_DETECTED: ["차이 감지", "drift detected"],
    ERROR: ["오류", "error"],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

export function describeCoverage(value: string | null, locale: TelegramLocale): string {
  if (value === null) {
    return locale === "ko-KR" ? "근거 없음 (none)" : "no evidence (none)";
  }
  const labels: Record<string, readonly [string, string]> = {
    COMPLETE: ["저장 근거상 완료", "complete in persisted evidence"],
    IN_PROGRESS: ["진행 중", "in progress"],
    FAILED: ["실패", "failed"],
    UNAVAILABLE: ["확인 불가", "unavailable"],
  };
  const label = labels[value]?.[locale === "ko-KR" ? 0 : 1] ?? (locale === "ko-KR" ? "알 수 없음" : "unknown");
  return `${label} (${value})`;
}

export function describeConfidence(
  value: HistoryRecoveryPresentationSummary | null,
  locale: TelegramLocale,
): string {
  if (!value?.confidenceLevel) {
    return locale === "ko-KR" ? "근거 없음 (none)" : "no evidence (none)";
  }
  const labels: Record<string, readonly [string, string]> = {
    FULL: ["전체 확인", "full"],
    PARTIAL: ["부분 확인", "partial"],
    UNKNOWN: ["알 수 없음", "unknown"],
  };
  const label = labels[value.confidenceLevel]?.[locale === "ko-KR" ? 0 : 1]
    ?? (locale === "ko-KR" ? "알 수 없음" : "unknown");
  const reason = value.confidenceReason ?? "none";
  return `${label} (${value.confidenceLevel}) | ${locale === "ko-KR" ? "사유" : "reason"}=${reason}`;
}
