import type { ExecutionStateRecord } from "../../../domain/types.js";
import type { SupportedTelegramCommand } from "../interfaces.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";
import {
  describeLiveOrderBlockers,
  type LiveSendPath,
} from "./status.js";

type ControlTelegramCommand = Extract<
  SupportedTelegramCommand,
  "/pause" | "/resume" | "/killswitch"
>;

export interface ControlPresentationInput {
  command: ControlTelegramCommand;
  previousState: ExecutionStateRecord;
  nextState: ExecutionStateRecord;
  liveSendPath: LiveSendPath;
}

export function formatControlPresentation(
  input: ControlPresentationInput,
  locale: TelegramLocale,
): string {
  const blockers = describeLiveOrderBlockers(input.nextState, input.liveSendPath);

  return (locale === "ko-KR"
    ? buildKoreanControlLines(input, blockers)
    : buildEnglishControlLines(input, blockers)).join("\n");
}

function buildKoreanControlLines(
  input: ControlPresentationInput,
  blockers: readonly string[],
): string[] {
  const blockerCodes = formatBlockerCodes(blockers);
  const reason = input.nextState.pauseReason ?? "none";
  const previousKillSwitchReason = getPreviousKillSwitchReason(input);

  return [
    "실행 제어 결과 (Execution Control)",
    `명령: ${input.command} (command: ${input.command})`,
    "결과: 수락됨 (result: accepted)",
    `설명: ${describeKoreanResult(input, blockers)}`,
    `다음 조치: ${describeKoreanNextAction(input, blockers)}`,
    `상태 변경: ${describeSystemStatus(input.previousState.systemStatus, "ko-KR")} -> ${describeSystemStatus(input.nextState.systemStatus, "ko-KR")} (transition: ${input.previousState.systemStatus} -> ${input.nextState.systemStatus})`,
    `mode_transition: ${input.previousState.executionMode} -> ${input.nextState.executionMode}`,
    `live_gate_transition: ${input.previousState.liveExecutionGate} -> ${input.nextState.liveExecutionGate}`,
    `system_status: ${input.nextState.systemStatus}`,
    `실행 모드: ${input.nextState.executionMode} (execution_mode: ${input.nextState.executionMode})`,
    `라이브 게이트: ${input.nextState.liveExecutionGate} (live_gate: ${input.nextState.liveExecutionGate})`,
    `실주문 가능: ${blockers.length === 0 ? "가능" : "차단"} (live_orders_allowed: ${blockers.length === 0 ? "true" : "false"})`,
    `차단 코드: ${blockerCodes} (blocked_by: ${blockerCodes})`,
    `킬 스위치: ${input.nextState.killSwitchActive ? "켜짐" : "꺼짐"} (kill_switch: ${input.nextState.killSwitchActive ? "on" : "off"})`,
    `현재 사유: ${reason} (pause_reason: ${reason})`,
    ...(previousKillSwitchReason
      ? [`이전 킬 스위치 사유(현재 값 아님): ${previousKillSwitchReason} (previous_kill_switch_reason: ${previousKillSwitchReason})`]
      : []),
    `업데이트: ${formatTelegramTimestamp(input.nextState.updatedAt, "ko-KR")} (updated_at: ${input.nextState.updatedAt})`,
  ];
}

function buildEnglishControlLines(
  input: ControlPresentationInput,
  blockers: readonly string[],
): string[] {
  const blockerCodes = formatBlockerCodes(blockers);
  const reason = input.nextState.pauseReason ?? "none";
  const previousKillSwitchReason = getPreviousKillSwitchReason(input);

  return [
    "Execution control result (Execution Control)",
    `Command: ${input.command} (command: ${input.command})`,
    "Result: accepted (result: accepted)",
    `Explanation: ${describeEnglishResult(input, blockers)}`,
    `Next action: ${describeEnglishNextAction(input, blockers)}`,
    `System status: ${describeSystemStatus(input.previousState.systemStatus, "en-US")} -> ${describeSystemStatus(input.nextState.systemStatus, "en-US")} (transition: ${input.previousState.systemStatus} -> ${input.nextState.systemStatus})`,
    `mode_transition: ${input.previousState.executionMode} -> ${input.nextState.executionMode}`,
    `live_gate_transition: ${input.previousState.liveExecutionGate} -> ${input.nextState.liveExecutionGate}`,
    `system_status: ${input.nextState.systemStatus}`,
    `Execution mode: ${input.nextState.executionMode} (execution_mode: ${input.nextState.executionMode})`,
    `Live gate: ${input.nextState.liveExecutionGate} (live_gate: ${input.nextState.liveExecutionGate})`,
    `Real orders: ${blockers.length === 0 ? "available" : "blocked"} (live_orders_allowed: ${blockers.length === 0 ? "true" : "false"})`,
    `Blocker codes: ${blockerCodes} (blocked_by: ${blockerCodes})`,
    `Kill switch: ${input.nextState.killSwitchActive ? "on" : "off"} (kill_switch: ${input.nextState.killSwitchActive ? "on" : "off"})`,
    `Current reason: ${reason} (pause_reason: ${reason})`,
    ...(previousKillSwitchReason
      ? [`Previous kill-switch reason (not current): ${previousKillSwitchReason} (previous_kill_switch_reason: ${previousKillSwitchReason})`]
      : []),
    `Updated: ${formatTelegramTimestamp(input.nextState.updatedAt, "en-US")} (updated_at: ${input.nextState.updatedAt})`,
  ];
}

function describeKoreanResult(
  input: ControlPresentationInput,
  blockers: readonly string[],
): string {
  if (input.command === "/pause") {
    if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
      return "킬 스위치 활성 상태가 유지되며 실행은 계속 차단됩니다. /pause 명령은 킬 스위치 상태를 변경하지 않습니다.";
    }
    return input.previousState.systemStatus === input.nextState.systemStatus
      ? "일시정지 상태가 유지됩니다. 신규 실행은 계속 일시정지됩니다."
      : "신규 실행이 일시정지되었습니다.";
  }

  if (input.command === "/killswitch") {
    const repeated = input.previousState.killSwitchActive
      ? " 킬 스위치 활성 상태가 유지됩니다."
      : "";
    return `글로벌 킬 스위치는 활성 상태이며 실행은 계속 차단됩니다.${repeated}`;
  }

  if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
    return "킬 스위치는 계속 활성 상태입니다. /resume 명령은 킬 스위치를 해제하지 않습니다. 운영이 재개되지 않았습니다.";
  }

  if (
    input.previousState.systemStatus === "RUNNING"
    && input.nextState.systemStatus === "RUNNING"
  ) {
    return blockers.length === 0
      ? "이미 실행 중이며 RUNNING 상태가 유지됩니다. 실주문 가능 상태도 유지됩니다."
      : `이미 실행 중이며 RUNNING 상태가 유지되지만 실행은 ${formatBlockerCodes(blockers)} 코드로 계속 차단됩니다.`;
  }

  if (input.nextState.systemStatus === "RUNNING" && blockers.length === 0) {
    return "일시정지가 해제되었습니다. 실주문 가능 상태로 다시 진입할 수 있습니다.";
  }

  return `일시정지 요청은 처리되었지만 실행은 계속 차단되어 있습니다. 차단 코드는 ${formatBlockerCodes(blockers)}입니다.`;
}

function describeEnglishResult(
  input: ControlPresentationInput,
  blockers: readonly string[],
): string {
  if (input.command === "/pause") {
    if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
      return "The kill switch remains active and execution remains blocked. /pause does not change the kill-switch state.";
    }
    return input.previousState.systemStatus === input.nextState.systemStatus
      ? "The system remains paused and new execution remains paused."
      : "New execution is paused.";
  }

  if (input.command === "/killswitch") {
    const repeated = input.previousState.killSwitchActive
      ? " The kill switch remains active."
      : "";
    return `The global kill switch is active and execution remains blocked.${repeated}`;
  }

  if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
    return "The kill switch remains active. /resume does not clear it, and operation did not resume.";
  }

  if (
    input.previousState.systemStatus === "RUNNING"
    && input.nextState.systemStatus === "RUNNING"
  ) {
    return blockers.length === 0
      ? "The system was already running and remains RUNNING. Real-order capability remains available."
      : `The system was already running and remains RUNNING, but execution remains blocked by ${formatBlockerCodes(blockers)}.`;
  }

  if (input.nextState.systemStatus === "RUNNING" && blockers.length === 0) {
    return "The pause was released. Real-order-capable operation may resume.";
  }

  return `The resume request was accepted, but execution remains blocked by ${formatBlockerCodes(blockers)}.`;
}

function describeKoreanNextAction(
  input: ControlPresentationInput,
  blockers: readonly string[],
): string {
  if (input.command === "/pause") {
    if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
      return "/status와 /readiness를 확인하고 승인된 킬 스위치 복구 절차를 따르세요.";
    }
    return "/status를 확인하고 준비된 경우에만 /resume 명령을 사용하세요.";
  }
  if (input.command === "/killswitch") {
    return "/status로 차단 상태를 확인하고 승인된 킬 스위치 복구 절차를 따르세요.";
  }
  if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
    return "/status와 /readiness를 확인하고 승인된 킬 스위치 복구 절차를 따르세요.";
  }
  if (input.nextState.systemStatus === "RUNNING" && blockers.length === 0) {
    return "/readiness로 실주문 준비 상태를 다시 확인하세요.";
  }
  return `/status와 /readiness에서 차단 코드 ${formatBlockerCodes(blockers)}를 확인하세요.`;
}

function describeEnglishNextAction(
  input: ControlPresentationInput,
  blockers: readonly string[],
): string {
  if (input.command === "/pause") {
    if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
      return "Review /status and /readiness, then follow the approved kill-switch recovery procedure.";
    }
    return "Check /status and use /resume only when ready.";
  }
  if (input.command === "/killswitch") {
    return "Review /status and follow the approved kill-switch recovery procedure.";
  }
  if (input.nextState.killSwitchActive || input.nextState.systemStatus === "KILL_SWITCHED") {
    return "Review /status and /readiness, then follow the approved kill-switch recovery procedure.";
  }
  if (input.nextState.systemStatus === "RUNNING" && blockers.length === 0) {
    return "Review /readiness before allowing real-order-capable operation to continue.";
  }
  return `Review blocker codes ${formatBlockerCodes(blockers)} in /status and /readiness.`;
}

function describeSystemStatus(
  status: ExecutionStateRecord["systemStatus"],
  locale: TelegramLocale,
): string {
  const labels: Record<ExecutionStateRecord["systemStatus"], readonly [string, string]> = {
    BOOTING: ["시작 중", "starting"],
    RUNNING: ["실행 중", "running"],
    PAUSED: ["일시정지", "paused"],
    KILL_SWITCHED: ["킬 스위치 활성", "kill switched"],
    DEGRADED: ["복구 필요", "degraded"],
  };
  return labels[status][locale === "ko-KR" ? 0 : 1];
}

function formatBlockerCodes(blockers: readonly string[]): string {
  return blockers.length === 0 ? "none" : blockers.join(",");
}

function getPreviousKillSwitchReason(input: ControlPresentationInput): string | null {
  if (
    input.command !== "/resume"
    || !input.nextState.killSwitchActive
    || input.nextState.pauseReason !== null
  ) {
    return null;
  }
  return input.previousState.pauseReason;
}
