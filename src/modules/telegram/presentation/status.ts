import type {
  ExecutionStateRecord,
  ReconciliationRunRecord,
  StrategyDecisionAction,
  StrategySchedulerStatus,
} from "../../../domain/types.js";
import type { PositionGuardPilotPhase } from "../../../domain/pilot-types.js";
import type { RuntimeOwnershipSnapshot } from "../../../app/runtime-ownership-guard.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

export type LiveSendPath = "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";

export type PilotVisibilityCheck =
  | "VERIFIED_CURRENT"
  | "VERIFIED_BY_ROUTE"
  | "BLOCKED_UNAVAILABLE"
  | "BLOCKED_NON_FLAT"
  | "UNAVAILABLE";

export interface BtcCandidatePilotVisibility {
  readonly deploymentId?: string | null;
  readonly pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  readonly phase: PositionGuardPilotPhase | null;
  readonly policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
  readonly stateVersion: number | null;
  readonly activationAt?: string | null;
  readonly lastEvidenceAt: string | null;
  readonly lastEvidenceId: string | null;
  readonly currentAuthorityCheck: PilotVisibilityCheck;
  readonly exactFlatCheck: PilotVisibilityCheck;
  readonly replayCheck: PilotVisibilityCheck;
  readonly leaseCheck: PilotVisibilityCheck;
  readonly reconciliationCheck: PilotVisibilityCheck;
  readonly reconciliationRunId?: string | null;
  readonly latestOutcome: Readonly<{
    strategyDecisionId: string;
    action: StrategyDecisionAction;
    reasonCode: string;
    executionBlocked: boolean;
    createdAt: string;
  }> | null;
}

export interface StatusPresentationInput {
  state: ExecutionStateRecord;
  liveSendPath: LiveSendPath;
  schedulerStatus: StrategySchedulerStatus | null;
  latestReconciliationRun: ReconciliationRunRecord | null;
  btcPilot?: BtcCandidatePilotVisibility | null;
  runtimeOwnership?: RuntimeOwnershipSnapshot | null;
  runtimeOwnershipNowEpochMs?: number | null;
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
    ...formatRuntimeOwnershipSummary(input.runtimeOwnership ?? null, input.runtimeOwnershipNowEpochMs, "ko-KR"),
    ...(input.state.pauseReason ? [`일시정지 사유: ${input.state.pauseReason}`] : []),
    ...(input.state.degradedReason ? [`점검 사유: ${input.state.degradedReason}`] : []),
    ...describeScheduler(input.schedulerStatus, "ko-KR"),
    `최근 동기화: ${describeReconciliation(input.latestReconciliationRun, "ko-KR")}`,
    ...(input.btcPilot === undefined ? [] : describePilot(input.btcPilot, "ko-KR")),
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
    ...formatRuntimeOwnershipSummary(input.runtimeOwnership ?? null, input.runtimeOwnershipNowEpochMs, "en-US"),
    ...(input.state.pauseReason ? [`Pause reason: ${input.state.pauseReason}`] : []),
    ...(input.state.degradedReason ? [`Degraded reason: ${input.state.degradedReason}`] : []),
    ...describeScheduler(input.schedulerStatus, "en-US"),
    `Latest reconciliation: ${describeReconciliation(input.latestReconciliationRun, "en-US")}`,
    ...(input.btcPilot === undefined ? [] : describePilot(input.btcPilot, "en-US")),
    `Updated: ${formatTelegramTimestamp(input.state.updatedAt, "en-US")}`,
    "Technical details: /status detail",
  ];
}

export function formatRuntimeOwnershipTechnicalVisibility(
  snapshot: RuntimeOwnershipSnapshot | null | undefined,
  nowEpochMs: number | null | undefined,
): string {
  const heartbeatAtEpochMs = snapshot?.heartbeatAtEpochMs ?? null;
  const heartbeatAgeMs = heartbeatAtEpochMs === null || !isEpochMs(nowEpochMs)
    ? null
    : Math.max(0, nowEpochMs - heartbeatAtEpochMs);

  return [
    `runtime_ownership_status: ${runtimeOwnershipStatus(snapshot)}`,
    `runtime_ownership_generation: ${snapshot?.generation ?? "none"}`,
    `runtime_ownership_execution_mode: ${snapshot?.executionMode ?? "none"}`,
    `runtime_ownership_heartbeat_at: ${heartbeatAtEpochMs === null ? "none" : new Date(heartbeatAtEpochMs).toISOString()}`,
    `runtime_ownership_heartbeat_age_ms: ${heartbeatAgeMs ?? "none"}`,
    `runtime_ownership_takeover: ${snapshot?.takeover ?? false}`,
    `runtime_ownership_reason: ${snapshot?.lossReason ?? "none"}`,
  ].join("\n");
}

function formatRuntimeOwnershipSummary(
  snapshot: RuntimeOwnershipSnapshot | null,
  nowEpochMs: number | null | undefined,
  locale: TelegramLocale,
): string[] {
  const status = runtimeOwnershipStatus(snapshot);
  const heartbeatAtEpochMs = snapshot?.heartbeatAtEpochMs ?? null;
  const heartbeatAgeMs = heartbeatAtEpochMs === null || !isEpochMs(nowEpochMs)
    ? null
    : Math.max(0, nowEpochMs - heartbeatAtEpochMs);
  const heartbeat = heartbeatAtEpochMs === null
    ? localizedNone(locale)
    : formatTelegramTimestamp(new Date(heartbeatAtEpochMs).toISOString(), locale);
  const age = heartbeatAgeMs === null ? localizedNone(locale) : `${heartbeatAgeMs}ms`;

  if (locale === "ko-KR") {
    return [
      `런타임 소유권: ${describeRuntimeOwnershipStatus(status, locale)} (${status})`,
      `소유권 세대: ${snapshot?.generation ?? "없음"}`,
      `소유권 모드: ${snapshot?.executionMode === null || snapshot?.executionMode === undefined ? "없음" : describeExecutionMode(snapshot.executionMode, locale)} (${snapshot?.executionMode ?? "none"})`,
      `마지막 하트비트: ${heartbeat} (age: ${age})`,
      `시작 인계: ${snapshot?.takeover ? "예" : "아니오"}`,
      `소유권 사유: ${snapshot?.lossReason ?? "없음"}`,
    ];
  }

  return [
    `Runtime ownership: ${describeRuntimeOwnershipStatus(status, locale)} (${status})`,
    `Ownership generation: ${snapshot?.generation ?? "none"}`,
    `Ownership mode: ${snapshot?.executionMode === null || snapshot?.executionMode === undefined ? "none" : describeExecutionMode(snapshot.executionMode, locale)} (${snapshot?.executionMode ?? "none"})`,
    `Last heartbeat: ${heartbeat} (age: ${age})`,
    `Startup takeover: ${snapshot?.takeover ? "yes" : "no"}`,
    `Ownership reason: ${snapshot?.lossReason ?? "none"}`,
  ];
}

function runtimeOwnershipStatus(snapshot: RuntimeOwnershipSnapshot | null | undefined): "OWNED" | "LOST" | "UNAVAILABLE" {
  if (snapshot?.status === "OWNED") return "OWNED";
  if (snapshot?.status === "LOST") return "LOST";
  return "UNAVAILABLE";
}

function describeRuntimeOwnershipStatus(
  status: "OWNED" | "LOST" | "UNAVAILABLE",
  locale: TelegramLocale,
): string {
  const labels: Record<typeof status, readonly [string, string]> = {
    OWNED: ["보유", "owned"],
    LOST: ["상실", "lost"],
    UNAVAILABLE: ["확인 불가", "unavailable"],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function describeExecutionMode(
  executionMode: RuntimeOwnershipSnapshot["executionMode"],
  locale: TelegramLocale,
): string {
  return executionMode === "LIVE"
    ? locale === "ko-KR" ? "실거래" : "live"
    : locale === "ko-KR" ? "모의 실행" : "dry run";
}

function isEpochMs(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function formatPilotTechnicalVisibility(
  pilot: BtcCandidatePilotVisibility,
): string {
  return [
    `btc_pilot_id: ${pilot.pilotId}`,
    `btc_pilot_deployment_id: ${pilot.deploymentId ?? "none"}`,
    `btc_pilot_phase: ${pilot.phase ?? "unavailable"}`,
    `btc_pilot_policy_version: ${pilot.policyVersion}`,
    `btc_pilot_state_version: ${pilot.stateVersion ?? "none"}`,
    `btc_pilot_activation_at: ${pilot.activationAt ?? "none"}`,
    `btc_pilot_last_evidence_at: ${pilot.lastEvidenceAt ?? "unavailable"}`,
    `btc_pilot_last_evidence_id: ${pilot.lastEvidenceId ?? "unavailable"}`,
    `btc_pilot_current_authority_check: ${pilot.currentAuthorityCheck}`,
    `btc_pilot_exact_flat_check: ${pilot.exactFlatCheck}`,
    `btc_pilot_replay_check: ${pilot.replayCheck}`,
    `btc_pilot_lease_check: ${pilot.leaseCheck}`,
    `btc_pilot_reconciliation_check: ${pilot.reconciliationCheck}`,
    `btc_pilot_reconciliation_run_id: ${pilot.reconciliationRunId ?? "none"}`,
    `btc_pilot_latest_decision_id: ${pilot.latestOutcome?.strategyDecisionId ?? "none"}`,
    `btc_pilot_latest_action: ${pilot.latestOutcome?.action ?? "none"}`,
    `btc_pilot_latest_reason_code: ${pilot.latestOutcome?.reasonCode ?? "none"}`,
    `btc_pilot_latest_execution_blocked: ${pilot.latestOutcome?.executionBlocked ?? "none"}`,
    `btc_pilot_latest_decision_at: ${pilot.latestOutcome?.createdAt ?? "none"}`,
    "eth_policy: BASELINE",
  ].join("\n");
}

export function describePilot(
  pilot: BtcCandidatePilotVisibility | null,
  locale: TelegramLocale,
): string[] {
  if (pilot === null) {
    return locale === "ko-KR"
      ? ["BTC 후보 파일럿: 저장된 후보 판단 없음", "ETH 정책: 기존 기준 전략 (BASELINE)"]
      : ["BTC candidate pilot: no persisted candidate decision", "ETH policy: existing baseline strategy (BASELINE)"];
  }

  if (pilot.phase === null) {
    const outcome = pilot.latestOutcome === null
      ? localizedNone(locale)
      : `${describeAction(pilot.latestOutcome.action, locale)} · ${pilot.latestOutcome.reasonCode}`;
    return locale === "ko-KR"
      ? [
          "BTC 후보 파일럿 현재 상태: 확인 불가 (차단)",
          `현재 권위 검증: ${pilot.currentAuthorityCheck}`,
          `최근 BTC 후보 결과(과거 기록): ${outcome}`,
          "ETH 정책: 기존 기준 전략 (BASELINE)",
        ]
      : [
          "BTC candidate pilot current state: unavailable (blocked)",
          `Current authority check: ${pilot.currentAuthorityCheck}`,
          `Latest BTC candidate outcome (historical record): ${outcome}`,
          "ETH policy: existing baseline strategy (BASELINE)",
        ];
  }

  const outcome = pilot.latestOutcome === null
    ? localizedNone(locale)
    : locale === "ko-KR"
      ? `${describeAction(pilot.latestOutcome.action, locale)} · ${pilot.latestOutcome.reasonCode}`
      : `${describeAction(pilot.latestOutcome.action, locale)} · ${pilot.latestOutcome.reasonCode}`;
  const lastEvidence = pilot.lastEvidenceAt === null || pilot.lastEvidenceId === null
    ? locale === "ko-KR" ? "제공되지 않음 (현재 Telegram DTO에 없음)" : "unavailable (not provided by the current Telegram DTO)"
    : `${formatTelegramTimestamp(pilot.lastEvidenceAt, locale)} · ${pilot.lastEvidenceId}`;

  return locale === "ko-KR"
    ? [
        `BTC 후보 파일럿: ${describePhase(pilot.phase, locale)} (phase: ${pilot.phase})`,
        `파일럿 ID: ${pilot.pilotId}`,
        `정책 버전: ${pilot.policyVersion}`,
        `상태 버전: ${pilot.stateVersion ?? "없음"}`,
        `마지막 증거: ${lastEvidence}`,
        `검증 상태: authority=${pilot.currentAuthorityCheck}, exact_flat=${pilot.exactFlatCheck}, replay=${pilot.replayCheck}, lease=${pilot.leaseCheck}, reconciliation=${pilot.reconciliationCheck}`,
        `최근 BTC 후보 결과: ${outcome}`,
        "ETH 정책: 기존 기준 전략 (BASELINE)",
      ]
    : [
        `BTC candidate pilot: ${describePhase(pilot.phase, locale)} (phase: ${pilot.phase})`,
        `Pilot ID: ${pilot.pilotId}`,
        `Policy version: ${pilot.policyVersion}`,
        `State version: ${pilot.stateVersion ?? "none"}`,
        `Last evidence: ${lastEvidence}`,
        `Checks: authority=${pilot.currentAuthorityCheck}, exact_flat=${pilot.exactFlatCheck}, replay=${pilot.replayCheck}, lease=${pilot.leaseCheck}, reconciliation=${pilot.reconciliationCheck}`,
        `Latest BTC candidate outcome: ${outcome}`,
        "ETH policy: existing baseline strategy (BASELINE)",
      ];
}

function describePhase(phase: PositionGuardPilotPhase, locale: TelegramLocale): string {
  const labels: Record<PositionGuardPilotPhase, readonly [string, string]> = {
    DISABLED: ["비활성", "disabled"],
    PENDING_FLAT: ["평탄화 대기", "pending flat"],
    ACTIVE: ["활성", "active"],
    PAUSED_FAULT: ["오류로 일시정지", "paused on fault"],
    DRAINING: ["위험 축소 중", "draining"],
  };
  return labels[phase][locale === "ko-KR" ? 0 : 1];
}

function describeAction(action: StrategyDecisionAction, locale: TelegramLocale): string {
  const labels: Record<StrategyDecisionAction, readonly [string, string]> = {
    ENTER: ["신규 매수", "new buy"],
    ADD: ["추가 매수", "additional buy"],
    HOLD: ["관망", "hold"],
    REDUCE: ["일부 매도", "partial sell"],
    EXIT: ["매도 종료", "exit sell"],
  };
  return labels[action][locale === "ko-KR" ? 0 : 1];
}

function localizedNone(locale: TelegramLocale): string {
  return locale === "ko-KR" ? "없음" : "none";
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
