import type { SupportedTelegramCommand } from "./interfaces.js";
import { listTelegramCommandContracts } from "./contracts.js";
import type { TelegramCommandMenuClient } from "./delivery.js";
import type { RuntimeOwnershipAuthority } from "../../app/runtime-ownership-guard.js";

export type TelegramCommandMenuRegistrationStatus = "COMPLETED" | "FAILED" | "NOT_ATTEMPTED";

export interface TelegramCommandMenuSetupResult {
  readonly configured: boolean;
  readonly attempted: boolean;
  readonly status: "COMPLETED" | "SKIPPED" | "FAILED";
  readonly failureCode: string | null;
  readonly korean: TelegramCommandMenuRegistrationStatus;
  readonly english: TelegramCommandMenuRegistrationStatus;
}

const KOREAN_DESCRIPTIONS: Record<SupportedTelegramCommand, string> = {
  "/help": "지원 명령과 안전 경계를 확인합니다",
  "/config": "실행 설정과 안전 게이트를 확인합니다",
  "/readiness": "운영 준비 상태를 확인합니다",
  "/status": "실행 상태를 확인합니다",
  "/statehistory": "실행 상태 변경 이력을 확인합니다",
  "/synchistory": "동기화 이력을 확인합니다",
  "/recovery": "주문 이력 복구 진행 상황을 확인합니다",
  "/alerts": "운영 알림과 전송 상태를 확인합니다",
  "/risks": "위험 이벤트 이력을 확인합니다",
  "/balances": "저장된 거래소 잔고를 확인합니다",
  "/positions": "저장된 BTC/ETH 보유 현황을 확인합니다",
  "/orders": "저장된 주문 목록을 확인합니다",
  "/order": "주문 상태와 체결을 확인합니다",
  "/scheduler": "자동 실행 상태와 이력을 확인합니다",
  "/inbound": "텔레그램 명령 수신 상태를 확인합니다",
  "/pause": "자동 실행과 주문 실행을 일시 중지합니다",
  "/resume": "킬 스위치가 해제되면 실행을 재개합니다",
  "/killswitch": "전역 킬 스위치를 켜고 실행을 중단합니다",
  "/sync": "거래소 상태와 로컬 기록 동기화를 요청합니다",
  "/preview": "주문 없이 BTC/ETH 전략 판단을 미리 확인합니다",
  "/run": "안전 실행 경로로 BTC/ETH 전략을 한 번 실행합니다",
};

const ENGLISH_DESCRIPTIONS: Record<SupportedTelegramCommand, string> = {
  "/help": "Show supported commands and safety boundaries.",
  "/config": "Show runtime configuration and safety gates.",
  "/readiness": "Show operator readiness.",
  "/status": "Show execution status.",
  "/statehistory": "Show execution state history.",
  "/synchistory": "Show reconciliation history.",
  "/recovery": "Show order-history recovery progress.",
  "/alerts": "Show operator alerts and delivery health.",
  "/risks": "Show risk event history.",
  "/balances": "Show stored exchange balances.",
  "/positions": "Show stored BTC and ETH positions.",
  "/orders": "Show stored orders.",
  "/order": "Show an order lifecycle and fills.",
  "/scheduler": "Show automatic-run status and history.",
  "/inbound": "Show Telegram command intake status.",
  "/pause": "Pause automated execution and orders.",
  "/resume": "Resume execution when kill switch is clear.",
  "/killswitch": "Activate the global kill switch.",
  "/sync": "Request exchange and local-state reconciliation.",
  "/preview": "Preview a BTC or ETH strategy decision.",
  "/run": "Run one BTC or ETH strategy cycle safely.",
};

export class TelegramCommandMenuSetupService {
  constructor(
    private readonly dependencies: {
      client: TelegramCommandMenuClient | null;
      operatorChatId: string | null;
      runtimeOwnership: RuntimeOwnershipAuthority;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.dependencies.client && this.dependencies.operatorChatId);
  }

  async setup(): Promise<TelegramCommandMenuSetupResult> {
    const client = this.dependencies.client;
    const operatorChatId = this.dependencies.operatorChatId;
    if (!client || !operatorChatId) {
      return {
        configured: false,
        attempted: false,
        status: "SKIPPED",
        failureCode: "telegram_command_menu_not_configured",
        korean: "NOT_ATTEMPTED",
        english: "NOT_ATTEMPTED",
      };
    }

    this.dependencies.runtimeOwnership.assertLocallyHeld();
    try {
      await client.setMyCommands({
        commands: buildCommandMenu(KOREAN_DESCRIPTIONS),
        scope: {
          type: "chat",
          chatId: operatorChatId,
        },
      });
    } catch {
      this.dependencies.runtimeOwnership.assertLocallyHeld();
      return {
        configured: true,
        attempted: true,
        status: "FAILED",
        failureCode: "telegram_command_menu_korean_failed",
        korean: "FAILED",
        english: "NOT_ATTEMPTED",
      };
    }
    this.dependencies.runtimeOwnership.assertLocallyHeld();

    this.dependencies.runtimeOwnership.assertLocallyHeld();
    try {
      await client.setMyCommands({
        commands: buildCommandMenu(ENGLISH_DESCRIPTIONS),
        scope: {
          type: "chat",
          chatId: operatorChatId,
        },
        languageCode: "en",
      });
    } catch {
      this.dependencies.runtimeOwnership.assertLocallyHeld();
      return {
        configured: true,
        attempted: true,
        status: "FAILED",
        failureCode: "telegram_command_menu_english_failed",
        korean: "COMPLETED",
        english: "FAILED",
      };
    }
    this.dependencies.runtimeOwnership.assertLocallyHeld();

    return {
      configured: true,
      attempted: true,
      status: "COMPLETED",
      failureCode: null,
      korean: "COMPLETED",
      english: "COMPLETED",
    };
  }
}

function buildCommandMenu(descriptions: Record<SupportedTelegramCommand, string>): Array<{
  command: string;
  description: string;
}> {
  return listTelegramCommandContracts().map(({ command }) => ({
    command: command.slice(1),
    description: descriptions[command],
  }));
}
