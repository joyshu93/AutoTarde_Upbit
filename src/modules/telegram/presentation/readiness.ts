import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  StrategySchedulerStatus,
} from "../../../domain/types.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";
import type { RuntimeOwnershipSnapshot } from "../../../app/runtime-ownership-guard.js";
import {
  describePilot,
  formatRuntimeOwnershipTechnicalVisibility,
  type BtcCandidatePilotVisibility,
} from "./status.js";

export type ReadinessStatus = "PASS" | "WARN" | "BLOCK";

export interface ReadinessPresentationCheck {
  name: string;
  status: ReadinessStatus;
  detail: string;
}

export interface ReadinessPresentationInput {
  overallStatus: ReadinessStatus;
  executionState: ExecutionStateRecord;
  schedulerStatus: StrategySchedulerStatus | null;
  latestBalanceSnapshot: BalanceSnapshotRecord | null;
  latestPositionSnapshot: PositionSnapshotRecord | null;
  latestReconciliationRun: ReconciliationRunRecord | null;
  activeOrderCount: number;
  recentRiskBlockCount: number;
  pendingNotificationCount: number;
  checks: readonly ReadinessPresentationCheck[];
  btcPilot?: BtcCandidatePilotVisibility | null;
  runtimeOwnership?: RuntimeOwnershipSnapshot | null;
  runtimeOwnershipNowEpochMs?: number | null;
}

export function formatReadinessPresentation(
  input: ReadinessPresentationInput,
  locale: TelegramLocale,
): string {
  return (locale === "ko-KR"
    ? buildKoreanReadinessLines(input)
    : buildEnglishReadinessLines(input)).join("\n");
}

function buildKoreanReadinessLines(input: ReadinessPresentationInput): string[] {
  const issueChecks = input.checks.filter((check) => check.status !== "PASS");

  return [
    "운영 준비 상태 (Operator Readiness)",
    `overall_status: ${input.overallStatus}`,
    `운영 준비 상태: ${describeOverallStatus(input.overallStatus, "ko-KR")}`,
    `다음 조치: ${describeNextAction(input.overallStatus, "ko-KR")}`,
    `execution_mode: ${input.executionState.executionMode}`,
    `실행 모드: ${input.executionState.executionMode === "LIVE" ? "실거래" : "모의 실행"} (${input.executionState.executionMode})`,
    `시스템 상태: ${describeSystemStatus(input.executionState.systemStatus, "ko-KR")} (${input.executionState.systemStatus})`,
    `킬 스위치: ${input.executionState.killSwitchActive ? "켜짐" : "꺼짐"}`,
    ...formatRuntimeOwnershipReadinessSummary(input.runtimeOwnership ?? null, input.runtimeOwnershipNowEpochMs, "ko-KR"),
    ...(input.executionState.degradedReason
      ? [`성능 저하 사유: ${input.executionState.degradedReason}`]
      : []),
    `스케줄러: ${describeScheduler(input.schedulerStatus, "ko-KR")}`,
    `잔고 스냅샷: ${formatTelegramTimestamp(input.latestBalanceSnapshot?.capturedAt ?? null, "ko-KR")}`,
    `포지션 스냅샷: ${formatTelegramTimestamp(input.latestPositionSnapshot?.capturedAt ?? null, "ko-KR")}`,
    `최근 동기화: ${describeReconciliation(input.latestReconciliationRun, "ko-KR")}`,
    `활성 주문: ${input.activeOrderCount}건`,
    `최근 위험 차단: ${input.recentRiskBlockCount}건`,
    `대기 알림: ${input.pendingNotificationCount}건`,
    ...(input.btcPilot === undefined ? [] : describePilot(input.btcPilot, "ko-KR")),
    ...(issueChecks.length === 0
      ? ["주의/차단 점검: 없음"]
      : [
          "주의/차단 점검:",
          ...issueChecks.map(
            (check) =>
              `- ${check.name} [${check.status}]: ${describeCheck(check, "ko-KR")}`,
          ),
        ]),
    "기술 상세: /readiness detail",
  ];
}

function buildEnglishReadinessLines(input: ReadinessPresentationInput): string[] {
  const issueChecks = input.checks.filter((check) => check.status !== "PASS");

  return [
    "Operator Readiness",
    `overall_status: ${input.overallStatus}`,
    `Operator readiness: ${describeOverallStatus(input.overallStatus, "en-US")}`,
    `Next action: ${describeNextAction(input.overallStatus, "en-US")}`,
    `execution_mode: ${input.executionState.executionMode}`,
    `Execution mode: ${input.executionState.executionMode === "LIVE" ? "live" : "dry run"} (${input.executionState.executionMode})`,
    `System status: ${describeSystemStatus(input.executionState.systemStatus, "en-US")} (${input.executionState.systemStatus})`,
    `Kill switch: ${input.executionState.killSwitchActive ? "on" : "off"}`,
    ...formatRuntimeOwnershipReadinessSummary(input.runtimeOwnership ?? null, input.runtimeOwnershipNowEpochMs, "en-US"),
    ...(input.executionState.degradedReason
      ? [`Degraded reason: ${input.executionState.degradedReason}`]
      : []),
    `Scheduler: ${describeScheduler(input.schedulerStatus, "en-US")}`,
    `Balance snapshot: ${formatTelegramTimestamp(input.latestBalanceSnapshot?.capturedAt ?? null, "en-US")}`,
    `Position snapshot: ${formatTelegramTimestamp(input.latestPositionSnapshot?.capturedAt ?? null, "en-US")}`,
    `Latest reconciliation: ${describeReconciliation(input.latestReconciliationRun, "en-US")}`,
    `Active orders: ${input.activeOrderCount}`,
    `Recent risk blocks: ${input.recentRiskBlockCount}`,
    `Pending notifications: ${input.pendingNotificationCount}`,
    ...(input.btcPilot === undefined ? [] : describePilot(input.btcPilot, "en-US")),
    ...(issueChecks.length === 0
      ? ["Warnings/blocks: none"]
      : [
          "Warnings/blocks:",
          ...issueChecks.map(
            (check) =>
              `- ${check.name} [${check.status}]: ${describeCheck(check, "en-US")}`,
          ),
        ]),
    "Technical details: /readiness detail",
  ];
}

function formatRuntimeOwnershipReadinessSummary(
  snapshot: RuntimeOwnershipSnapshot | null,
  nowEpochMs: number | null | undefined,
  locale: TelegramLocale,
): string[] {
  const technical = formatRuntimeOwnershipTechnicalVisibility(snapshot, nowEpochMs)
    .split("\n")
    .reduce<Record<string, string>>((values, line) => {
      const [key, value] = line.split(": ", 2);
      if (key !== undefined && value !== undefined) values[key] = value;
      return values;
    }, {});
  const status = technical.runtime_ownership_status ?? "UNAVAILABLE";
  const heartbeat = technical.runtime_ownership_heartbeat_at ?? "none";
  const age = technical.runtime_ownership_heartbeat_age_ms ?? "none";

  return locale === "ko-KR"
    ? [
        `런타임 소유권: ${status === "OWNED" ? "보유" : status === "LOST" ? "상실" : "확인 불가"} (${status})`,
        `소유권 세대: ${technical.runtime_ownership_generation === "none" ? "없음" : technical.runtime_ownership_generation}`,
        `소유권 모드: ${technical.runtime_ownership_execution_mode === "LIVE" ? "실거래" : technical.runtime_ownership_execution_mode === "DRY_RUN" ? "모의 실행" : "없음"} (${technical.runtime_ownership_execution_mode})`,
        `마지막 하트비트: ${heartbeat === "none" ? "없음" : formatTelegramTimestamp(heartbeat, locale)} (age: ${age === "none" ? "없음" : `${age}ms`})`,
        `시작 인계: ${technical.runtime_ownership_takeover === "true" ? "예" : "아니오"}`,
        `소유권 사유: ${technical.runtime_ownership_reason === "none" ? "없음" : technical.runtime_ownership_reason}`,
      ]
    : [
        `Runtime ownership: ${status === "OWNED" ? "owned" : status === "LOST" ? "lost" : "unavailable"} (${status})`,
        `Ownership generation: ${technical.runtime_ownership_generation}`,
        `Ownership mode: ${technical.runtime_ownership_execution_mode === "LIVE" ? "live" : technical.runtime_ownership_execution_mode === "DRY_RUN" ? "dry run" : "none"} (${technical.runtime_ownership_execution_mode})`,
        `Last heartbeat: ${heartbeat === "none" ? "none" : formatTelegramTimestamp(heartbeat, locale)} (age: ${age === "none" ? "none" : `${age}ms`})`,
        `Startup takeover: ${technical.runtime_ownership_takeover === "true" ? "yes" : "no"}`,
        `Ownership reason: ${technical.runtime_ownership_reason}`,
      ];
}

function describeOverallStatus(
  status: ReadinessStatus,
  locale: TelegramLocale,
): string {
  const labels: Record<ReadinessStatus, readonly [string, string]> = {
    PASS: ["통과", "ready"],
    WARN: ["주의", "warning"],
    BLOCK: ["차단", "blocked"],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function describeNextAction(
  status: ReadinessStatus,
  locale: TelegramLocale,
): string {
  const labels: Record<ReadinessStatus, readonly [string, string]> = {
    PASS: [
      "현재 상태를 유지하고 예정된 운영 절차를 따르세요.",
      "Keep the current state and follow the planned operating procedure.",
    ],
    WARN: [
      "아래 주의 항목을 확인한 뒤 운영 여부를 판단하세요.",
      "Review the warnings below before deciding whether to operate.",
    ],
    BLOCK: [
      "주문 실행 또는 스케줄러 운영 전에 차단 항목을 해결하세요.",
      "Resolve the blocking checks before running or scheduling orders.",
    ],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function describeSystemStatus(
  status: ExecutionStateRecord["systemStatus"],
  locale: TelegramLocale,
): string {
  const labels: Record<
    ExecutionStateRecord["systemStatus"],
    readonly [string, string]
  > = {
    BOOTING: ["시작 중", "starting"],
    RUNNING: ["실행 중", "running"],
    PAUSED: ["일시정지", "paused"],
    KILL_SWITCHED: ["긴급 중지", "kill switched"],
    DEGRADED: ["점검 필요", "degraded"],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function describeScheduler(
  status: StrategySchedulerStatus | null,
  locale: TelegramLocale,
): string {
  if (!status) {
    return locale === "ko-KR" ? "상태 정보 없음" : "status unavailable";
  }
  if (!status.enabled) {
    return locale === "ko-KR" ? "사용 안 함" : "disabled";
  }
  if (!status.started) {
    return locale === "ko-KR" ? "사용 중 (시작 안 됨)" : "enabled (not started)";
  }
  return locale === "ko-KR" ? "사용 중 (시작됨)" : "enabled (started)";
}

function describeReconciliation(
  run: ReconciliationRunRecord | null,
  locale: TelegramLocale,
): string {
  if (!run) {
    return locale === "ko-KR" ? "기록 없음" : "no record";
  }
  const labels: Record<
    ReconciliationRunRecord["status"],
    readonly [string, string]
  > = {
    SUCCESS: ["정상", "successful"],
    DRIFT_DETECTED: ["차이 감지", "drift detected"],
    ERROR: ["오류", "error"],
  };
  const label = labels[run.status][locale === "ko-KR" ? 0 : 1];
  return `${label} (${formatTelegramTimestamp(run.completedAt, locale)})`;
}

function describeCheck(
  check: ReadinessPresentationCheck,
  locale: TelegramLocale,
): string {
  const descriptions: Record<string, readonly [string, string]> = {
    runtime_config: [
      "런타임 설정을 확인할 수 없습니다.",
      "runtime configuration is unavailable",
    ],
    live_send_safety: [
      "실주문 경로가 활성화되어 있습니다.",
      "the live-order path is enabled",
    ],
    execution_state: [
      "현재 운영 상태가 주문 실행을 차단합니다.",
      "execution is blocked by the current operator state",
    ],
    upbit_read_credentials: [
      "Upbit 읽기 인증 설정을 확인하세요.",
      "Upbit read credentials need attention",
    ],
    telegram_delivery: [
      "Telegram 알림 전송 설정을 확인하세요.",
      "Telegram delivery configuration needs attention",
    ],
    telegram_inbound: [
      "Telegram 명령 수신 설정을 확인하세요.",
      "Telegram inbound polling needs attention",
    ],
    strategy_scheduler: [
      "전략 스케줄러 상태를 확인하세요.",
      "the strategy scheduler needs attention",
    ],
    balance_snapshot: [
      "최근 잔고 스냅샷을 확인하세요.",
      "the latest balance snapshot needs attention",
    ],
    position_snapshot: [
      "최근 포지션 스냅샷을 확인하세요.",
      "the latest position snapshot needs attention",
    ],
    latest_reconciliation: [
      "최근 동기화 결과를 확인하세요.",
      "the latest reconciliation needs attention",
    ],
    active_orders: [
      "진행 중이거나 복구가 필요한 주문을 확인하세요.",
      "active or recovery-required orders need review",
    ],
    recent_risk_blocks: [
      "최근 위험 차단 기록을 확인하세요.",
      "recent risk blocks need review",
    ],
    pending_notifications: [
      "전송 대기 중인 운영 알림을 확인하세요.",
      "pending operator notifications need review",
    ],
  };
  const description = descriptions[check.name];
  return description
    ? description[locale === "ko-KR" ? 0 : 1]
    : check.detail;
}
