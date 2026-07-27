import type {
  ExecutionStateRecord,
  ReconciliationRunRecord,
  StrategySchedulerStatus,
} from "../../../domain/types.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

export type LiveSendPath = "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";

export interface StatusPresentationInput {
  state: ExecutionStateRecord;
  liveSendPath: LiveSendPath;
  schedulerStatus: StrategySchedulerStatus | null;
  latestReconciliationRun: ReconciliationRunRecord | null;
}

export function formatStatusPresentation(
  input: StatusPresentationInput,
  locale: TelegramLocale,
): string {
  const blockers = describeLiveOrderBlockers(input.state, input.liveSendPath);
  return (locale === "ko-KR"
    ? buildKoreanStatusLines(input, blockers)
    : buildEnglishStatusLines(input, blockers)).join("\n");
}

export function describeLiveOrderBlockers(
  state: ExecutionStateRecord,
  liveSendPath: LiveSendPath,
): string[] {
  const blockers: string[] = [];

  if (state.executionMode !== "LIVE") {
    blockers.push("DRY_RUN");
  }
  if (state.liveExecutionGate !== "ENABLED") {
    blockers.push("LIVE_GATE_DISABLED");
  }
  if (state.killSwitchActive || state.systemStatus === "KILL_SWITCHED") {
    blockers.push("KILL_SWITCHED");
  } else if (state.systemStatus === "PAUSED") {
    blockers.push("PAUSED");
  } else if (state.systemStatus === "DEGRADED") {
    blockers.push("DEGRADED");
  }
  if (liveSendPath === "DRY_RUN_ADAPTER") {
    blockers.push("DRY_RUN_ADAPTER");
  }

  return blockers;
}

function buildKoreanStatusLines(
  input: StatusPresentationInput,
  blockers: readonly string[],
): string[] {
  return [
    "운영 상태 (Execution Status)",
    `시스템: ${describeSystemStatus(input.state.systemStatus, "ko-KR")}`,
    `실행 모드: ${input.state.executionMode === "LIVE" ? "실거래" : "모의 실행"} (mode: ${input.state.executionMode})`,
    `실주문: ${blockers.length === 0 ? "가능" : "차단됨"}`,
    `주문 경로: ${input.liveSendPath} (live_send_path: ${input.liveSendPath})`,
    ...(blockers.length === 0
      ? []
      : [`차단 사유: ${blockers.map((blocker) => describeBlocker(blocker, "ko-KR")).join(", ")}`]),
    `킬 스위치: ${input.state.killSwitchActive ? "켜짐" : "꺼짐"}`,
    ...(input.state.pauseReason ? [`일시정지 사유: ${input.state.pauseReason}`] : []),
    ...(input.state.degradedReason ? [`점검 사유: ${input.state.degradedReason}`] : []),
    ...describeScheduler(input.schedulerStatus, "ko-KR"),
    `최근 동기화: ${describeReconciliation(input.latestReconciliationRun, "ko-KR")}`,
    `업데이트: ${formatTelegramTimestamp(input.state.updatedAt, "ko-KR")}`,
    "기술 상세: /status detail",
  ];
}

function buildEnglishStatusLines(
  input: StatusPresentationInput,
  blockers: readonly string[],
): string[] {
  return [
    "Execution status (Execution Status)",
    `System: ${describeSystemStatus(input.state.systemStatus, "en-US")}`,
    `Execution mode: ${input.state.executionMode === "LIVE" ? "live" : "dry run"} (mode: ${input.state.executionMode})`,
    `Real orders: ${blockers.length === 0 ? "available" : "blocked"}`,
    `Order path: ${input.liveSendPath} (live_send_path: ${input.liveSendPath})`,
    ...(blockers.length === 0
      ? []
      : [`Blocking reasons: ${blockers.map((blocker) => describeBlocker(blocker, "en-US")).join(", ")}`]),
    `Kill switch: ${input.state.killSwitchActive ? "on" : "off"}`,
    ...(input.state.pauseReason ? [`Pause reason: ${input.state.pauseReason}`] : []),
    ...(input.state.degradedReason ? [`Degraded reason: ${input.state.degradedReason}`] : []),
    ...describeScheduler(input.schedulerStatus, "en-US"),
    `Latest reconciliation: ${describeReconciliation(input.latestReconciliationRun, "en-US")}`,
    `Updated: ${formatTelegramTimestamp(input.state.updatedAt, "en-US")}`,
    "Technical details: /status detail",
  ];
}

function describeSystemStatus(
  status: ExecutionStateRecord["systemStatus"],
  locale: TelegramLocale,
): string {
  const labels = locale === "ko-KR"
    ? {
        BOOTING: "시작 중",
        RUNNING: "실행 중",
        PAUSED: "일시정지",
        KILL_SWITCHED: "긴급 중지",
        DEGRADED: "점검 필요",
      }
    : {
        BOOTING: "starting",
        RUNNING: "running",
        PAUSED: "paused",
        KILL_SWITCHED: "kill switched",
        DEGRADED: "degraded",
      };
  return labels[status];
}

function describeBlocker(blocker: string, locale: TelegramLocale): string {
  const labels: Record<string, readonly [string, string]> = {
    DRY_RUN: ["모의 실행 모드", "dry-run mode"],
    LIVE_GATE_DISABLED: ["실주문 게이트 비활성화", "live-order gate disabled"],
    KILL_SWITCHED: ["킬 스위치 활성화", "kill switch active"],
    PAUSED: ["운영 일시정지", "system paused"],
    DEGRADED: ["시스템 성능 저하 상태", "system degraded"],
    DRY_RUN_ADAPTER: ["모의 주문 어댑터", "dry-run order adapter"],
  };
  const label = labels[blocker];
  return label ? label[locale === "ko-KR" ? 0 : 1] : blocker;
}

function describeScheduler(
  status: StrategySchedulerStatus | null,
  locale: TelegramLocale,
): string[] {
  if (!status) {
    return [locale === "ko-KR" ? "스케줄러: 상태 정보 없음" : "Scheduler: status unavailable"];
  }

  const state = locale === "ko-KR"
    ? status.enabled
      ? `사용 중 (${status.started ? "시작됨" : "시작 안 됨"})`
      : "사용 안 함"
    : status.enabled
      ? `enabled (${status.started ? "started" : "not started"})`
      : "disabled";
  const lines = [locale === "ko-KR" ? `스케줄러: ${state}` : `Scheduler: ${state}`];

  for (const market of status.markets) {
    const nextRun = formatTelegramTimestamp(market.nextRunAt, locale);
    lines.push(
      locale === "ko-KR"
        ? `${market.market} 다음 실행: ${nextRun}`
        : `${market.market} next run: ${nextRun}`,
    );
  }

  return lines;
}

function describeReconciliation(
  run: ReconciliationRunRecord | null,
  locale: TelegramLocale,
): string {
  if (!run) {
    return locale === "ko-KR" ? "기록 없음" : "no record";
  }

  const labels: Record<ReconciliationRunRecord["status"], readonly [string, string]> = {
    SUCCESS: ["정상", "successful"],
    DRIFT_DETECTED: ["차이 감지", "drift detected"],
    ERROR: ["오류", "error"],
  };
  const label = labels[run.status][locale === "ko-KR" ? 0 : 1];
  return `${label} (${formatTelegramTimestamp(run.completedAt, locale)})`;
}
