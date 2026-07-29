import type { TelegramSyncResult } from "../interfaces.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

interface SyncCopy {
  readonly title: string;
  readonly explanation: string;
  readonly nextAction: string;
}

const KOREAN_COPY: Record<TelegramSyncResult["status"], SyncCopy> = {
  COMPLETED: {
    title: "동기화 요청 완료",
    explanation: "동기화 요청이 완료되었습니다.",
    nextAction: "/readiness를 확인하세요. 계정 상태가 필요하면 /balances와 /positions를 사용하세요.",
  },
  ALREADY_RUNNING: {
    title: "동기화 진행 중",
    explanation: "이미 동기화 요청이 진행 중입니다.",
    nextAction: "잠시 기다린 뒤 /synchistory를 확인하거나 나중에 다시 시도하세요.",
  },
  NOT_CONNECTED: {
    title: "동기화 기능 연결 안 됨",
    explanation: "이 프로세스에 동기화 기능이 연결되지 않았습니다.",
    nextAction: "/config와 실행 중인 프로세스 설정을 확인하세요.",
  },
  FAILED: {
    title: "동기화 실패",
    explanation: "동기화 요청을 완료하지 못했습니다.",
    nextAction: "아래 detail과 /alerts, /synchistory를 확인하세요.",
  },
};

const ENGLISH_COPY: Record<TelegramSyncResult["status"], SyncCopy> = {
  COMPLETED: {
    title: "Sync request completed",
    explanation: "The sync request completed.",
    nextAction: "Inspect /readiness. Use /balances and /positions when account state is needed.",
  },
  ALREADY_RUNNING: {
    title: "Sync already running",
    explanation: "A sync request is already in progress.",
    nextAction: "Wait, then inspect /synchistory or retry later.",
  },
  NOT_CONNECTED: {
    title: "Sync not connected",
    explanation: "Sync is not connected in this process.",
    nextAction: "Inspect /config and the running process configuration.",
  },
  FAILED: {
    title: "Sync failed",
    explanation: "The sync request could not be completed.",
    nextAction: "Inspect the exact detail below, /alerts, and /synchistory.",
  },
};

export function formatSyncPresentation(
  result: TelegramSyncResult,
  locale: TelegramLocale,
): string {
  const copy = locale === "ko-KR" ? KOREAN_COPY[result.status] : ENGLISH_COPY[result.status];
  const requestedAt = formatTelegramTimestamp(result.requestedAt, locale);

  if (locale === "ko-KR") {
    return [
      copy.title,
      `상태: ${copy.explanation}`,
      `다음 조치: ${copy.nextAction}`,
      `요청 시각: ${requestedAt}`,
      "",
      `status: ${result.status}`,
      `requested_at: ${result.requestedAt}`,
      `detail: ${result.detail}`,
      "operator_boundary: Telegram은 수동 현금 또는 포지션 입력을 받지 않습니다.",
    ].join("\n");
  }

  return [
    copy.title,
    `State: ${copy.explanation}`,
    `Next action: ${copy.nextAction}`,
    `Requested at: ${requestedAt}`,
    "",
    `status: ${result.status}`,
    `requested_at: ${result.requestedAt}`,
    `detail: ${result.detail}`,
    "operator_boundary: Telegram does not accept manual cash or position input.",
  ].join("\n");
}
