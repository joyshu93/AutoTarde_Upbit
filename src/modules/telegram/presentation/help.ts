import type {
  SupportedTelegramCommand,
  TelegramCommandContract,
} from "../interfaces.js";
import {
  DEFAULT_TELEGRAM_LOCALE,
  type TelegramLocale,
} from "./locale.js";

const KOREAN_SUMMARIES: Record<SupportedTelegramCommand, string> = {
  "/help": "지원 명령과 안전 경계를 확인합니다.",
  "/config": "비밀값을 제외한 실행 설정과 리스크 한도를 확인합니다.",
  "/readiness": "현재 운영 준비 상태를 읽기 전용으로 확인합니다.",
  "/status": "실행 상태와 실주문 차단 사유를 확인합니다.",
  "/statehistory": "최근 실행 상태 변경 기록을 확인합니다.",
  "/synchistory": "최근 거래소 동기화 기록을 확인합니다.",
  "/recovery": "거래소 주문 이력 복구 진행 상황을 확인합니다.",
  "/alerts": "최근 운영 알림과 전송 상태를 확인합니다.",
  "/risks": "최근 리스크 이벤트를 확인합니다.",
  "/balances": "최근 저장된 거래소 잔고를 확인합니다.",
  "/positions": "최근 저장된 BTC/ETH 보유 현황을 확인합니다.",
  "/orders": "저장된 주문 목록을 확인합니다.",
  "/order": "주문 한 건의 상태, 이벤트와 체결을 확인합니다.",
  "/scheduler": "자동 실행 상태와 최근 실행 기록을 확인합니다.",
  "/inbound": "텔레그램 명령 수신 상태를 확인합니다.",
  "/pause": "자동 실행과 주문 실행을 일시 정지합니다.",
  "/resume": "킬스위치가 꺼진 경우 실행을 재개합니다.",
  "/killswitch": "전역 킬스위치를 켜고 실행을 중단합니다.",
  "/sync": "거래소 상태와 로컬 기록의 동기화를 요청합니다.",
  "/preview": "기록이나 주문 없이 BTC/ETH 전략 판단을 미리 확인합니다.",
  "/run": "안전 절차를 거쳐 BTC/ETH 전략을 한 번 실행합니다.",
};

export function formatHelpPresentation(
  contracts: readonly TelegramCommandContract[],
  locale: TelegramLocale = DEFAULT_TELEGRAM_LOCALE,
): string {
  const inspectionContracts = contracts.filter((contract) => contract.category === "inspection");
  const controlContracts = contracts.filter((contract) => contract.category === "control");

  return locale === "en-US"
    ? formatEnglishHelp(contracts.length, inspectionContracts, controlContracts)
    : formatKoreanHelp(contracts.length, inspectionContracts, controlContracts);
}

function formatKoreanHelp(
  commandCount: number,
  inspectionContracts: readonly TelegramCommandContract[],
  controlContracts: readonly TelegramCommandContract[],
): string {
  return [
    "AutoTrade Upbit 도움말",
    `명령 수: ${commandCount}`,
    "",
    "조회 명령",
    ...formatCommandGroup(inspectionContracts, "ko-KR"),
    "",
    "운영 명령",
    ...formatCommandGroup(controlContracts, "ko-KR"),
    "",
    "안전 안내",
    "도움말 조회는 동기화, 전략 실행, 스케줄러 실행, 거래소 조회, 주문 변경 또는 실주문 전송을 수행하지 않습니다.",
    "텔레그램에서는 원화 잔고나 코인 보유 수량을 직접 입력할 수 없습니다.",
    "실제 주문은 실행 상태, 리스크 정책, 실주문 전송 안전장치를 모두 통과해야 합니다.",
    "기본 실행 모드는 DRY_RUN이며, LIVE 모드는 명시적인 설정이 필요합니다.",
  ].join("\n");
}

function formatEnglishHelp(
  commandCount: number,
  inspectionContracts: readonly TelegramCommandContract[],
  controlContracts: readonly TelegramCommandContract[],
): string {
  return [
    "AutoTrade Upbit Help",
    `Command count: ${commandCount}`,
    "",
    "Inspection commands",
    ...formatCommandGroup(inspectionContracts, "en-US"),
    "",
    "Operator controls",
    ...formatCommandGroup(controlContracts, "en-US"),
    "",
    "Safety notes",
    "Help is static and never triggers sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission.",
    "Telegram does not accept manual cash or position input.",
    "Live orders remain subject to execution state, risk policy, and live-send safety gates.",
    "The default execution mode is DRY_RUN; LIVE mode requires explicit configuration.",
  ].join("\n");
}

function formatCommandGroup(
  contracts: readonly TelegramCommandContract[],
  locale: TelegramLocale,
): string[] {
  return contracts.flatMap((contract) => [
    `- ${contract.command}`,
    `  ${locale === "ko-KR" ? "사용법" : "Usage"}: ${contract.usage}`,
    `  ${locale === "ko-KR" ? "설명" : "Description"}: ${locale === "ko-KR" ? KOREAN_SUMMARIES[contract.command] : contract.summary}`,
  ]);
}
