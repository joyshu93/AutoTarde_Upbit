import type {
  TelegramInlineKeyboardMarkup,
  TelegramResponse,
} from "../interfaces.js";
import { escapeTelegramHtml } from "./common.js";
import type { TelegramLocale } from "./locale.js";

const MAX_TELEGRAM_READ_ONLY_RESPONSE_LENGTH = 3_500;
const HTML_PREFIX = "<pre>";
const HTML_SUFFIX = "</pre>";

export function buildTelegramDashboardResponse(locale: TelegramLocale): TelegramResponse {
  return {
    text: locale === "ko-KR"
      ? "<b>AutoTrade Upbit</b>\n읽기 전용 운영 대시보드입니다.\n주문 실행과 운영 제어는 텍스트 명령으로만 사용할 수 있습니다."
      : "<b>AutoTrade Upbit</b>\nRead-only operator dashboard.\nOrder execution and operator controls remain text commands only.",
    parseMode: "HTML",
    replyMarkup: dashboardKeyboard(locale),
  };
}

export function buildTelegramReadOnlyResponse(
  text: string,
  replyMarkup: TelegramInlineKeyboardMarkup,
  locale: TelegramLocale = "ko-KR",
): TelegramResponse {
  const safeText = truncateTelegramReadOnlySource(text, locale);
  return {
    text: `${HTML_PREFIX}${escapeTelegramHtml(safeText)}${HTML_SUFFIX}`,
    parseMode: "HTML",
    replyMarkup,
  };
}

export function dashboardKeyboard(locale: TelegramLocale): TelegramInlineKeyboardMarkup {
  return {
    inlineKeyboard: [
      [button(locale === "ko-KR" ? "상태" : "Status", "status"), button(locale === "ko-KR" ? "준비 상태" : "Readiness", "readiness")],
      [button(locale === "ko-KR" ? "잔고" : "Balances", "balances"), button(locale === "ko-KR" ? "포지션" : "Positions", "positions")],
      [button(locale === "ko-KR" ? "주문" : "Orders", "orders:page:0"), button(locale === "ko-KR" ? "알림" : "Alerts", "alerts:page:0")],
      [button(locale === "ko-KR" ? "리스크" : "Risks", "risks"), button(locale === "ko-KR" ? "스케줄러" : "Scheduler", "scheduler")],
    ],
  };
}

export function homeKeyboard(locale: TelegramLocale): TelegramInlineKeyboardMarkup {
  return { inlineKeyboard: [[button(locale === "ko-KR" ? "홈" : "Home", "home")]] };
}

export function backHomeKeyboard(
  locale: TelegramLocale,
  callbackData: string,
): TelegramInlineKeyboardMarkup {
  return {
    inlineKeyboard: [[
      button(locale === "ko-KR" ? "뒤로" : "Back", callbackData),
      button(locale === "ko-KR" ? "홈" : "Home", "home"),
    ]],
  };
}

export function detailKeyboard(
  locale: TelegramLocale,
  summaryCallbackData: string,
  refreshCallbackData?: string,
): TelegramInlineKeyboardMarkup {
  return {
    inlineKeyboard: [
      [
        ...(refreshCallbackData ? [button(locale === "ko-KR" ? "새로고침" : "Refresh", refreshCallbackData)] : []),
        button(locale === "ko-KR" ? "상세" : "Detail", summaryCallbackData),
      ],
      [button(locale === "ko-KR" ? "홈" : "Home", "home")],
    ],
  };
}

export function expiredCallbackResponse(locale: TelegramLocale): TelegramResponse {
  return buildTelegramReadOnlyResponse(
    locale === "ko-KR" ? "요청이 만료되었거나 항목을 찾을 수 없습니다." : "This callback has expired or the item was not found.",
    homeKeyboard(locale),
    locale,
  );
}

function truncateTelegramReadOnlySource(text: string, locale: TelegramLocale): string {
  const maxEscapedLength = MAX_TELEGRAM_READ_ONLY_RESPONSE_LENGTH - HTML_PREFIX.length - HTML_SUFFIX.length;
  if (escapeTelegramHtml(text).length <= maxEscapedLength) {
    return text;
  }

  const omission = locale === "ko-KR"
    ? "\n[일부 내용이 생략되었습니다.]"
    : "\n[Content truncated for Telegram.]";
  const escapedOmissionLength = escapeTelegramHtml(omission).length;
  let source = "";
  let escapedLength = 0;

  for (const character of text) {
    const escapedCharacterLength = escapeTelegramHtml(character).length;
    if (escapedLength + escapedCharacterLength + escapedOmissionLength > maxEscapedLength) {
      break;
    }
    source += character;
    escapedLength += escapedCharacterLength;
  }

  return `${source}${omission}`;
}

function button(text: string, callbackData: string) {
  return { text, callbackData };
}
