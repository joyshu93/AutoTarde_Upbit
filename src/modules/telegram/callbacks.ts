import type { TelegramCallbackQueryInput } from "./interfaces.js";

const MAX_TELEGRAM_CALLBACK_DATA_BYTES = 64;
const SAFE_NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/u;

export type TelegramReadOnlyCallbackAction =
  | { readonly type: "HOME" }
  | { readonly type: "STATUS" }
  | { readonly type: "STATUS_DETAIL" }
  | { readonly type: "STATUS_REFRESH" }
  | { readonly type: "READINESS" }
  | { readonly type: "READINESS_DETAIL" }
  | { readonly type: "READINESS_REFRESH" }
  | { readonly type: "BALANCES" }
  | { readonly type: "POSITIONS" }
  | { readonly type: "ORDERS_PAGE"; readonly page: number }
  | { readonly type: "ORDERS_DETAIL"; readonly orderId: number }
  | { readonly type: "ALERTS_PAGE"; readonly page: number }
  | { readonly type: "ALERTS_DETAIL"; readonly alertId: number }
  | { readonly type: "RISKS" }
  | { readonly type: "SCHEDULER" };

export function parseTelegramReadOnlyCallbackAction(
  data: string,
): TelegramReadOnlyCallbackAction | null {
  if (Buffer.byteLength(data, "utf8") > MAX_TELEGRAM_CALLBACK_DATA_BYTES) {
    return null;
  }

  switch (data) {
    case "home":
      return { type: "HOME" };
    case "status":
      return { type: "STATUS" };
    case "status:detail":
      return { type: "STATUS_DETAIL" };
    case "status:refresh":
      return { type: "STATUS_REFRESH" };
    case "readiness":
      return { type: "READINESS" };
    case "readiness:detail":
      return { type: "READINESS_DETAIL" };
    case "readiness:refresh":
      return { type: "READINESS_REFRESH" };
    case "balances":
      return { type: "BALANCES" };
    case "positions":
      return { type: "POSITIONS" };
    case "risks":
      return { type: "RISKS" };
    case "scheduler":
      return { type: "SCHEDULER" };
    default:
      return parsePagedTelegramCallbackAction(data);
  }
}

export function isAuthorizedTelegramCallbackQuery(
  callbackQuery: TelegramCallbackQueryInput,
  operatorChatId: string | null,
): boolean {
  return Boolean(
    operatorChatId &&
      callbackQuery.chatId === operatorChatId &&
      callbackQuery.senderId === operatorChatId,
  );
}

function parsePagedTelegramCallbackAction(data: string): TelegramReadOnlyCallbackAction | null {
  const matched = /^(orders|alerts):(page|detail):(.+)$/u.exec(data);
  if (!matched) {
    return null;
  }

  const resource = matched[1];
  const view = matched[2];
  const value = parseSafeNonNegativeInteger(matched[3] ?? "");
  if (value === null) {
    return null;
  }

  if (resource === "orders" && view === "page") {
    return { type: "ORDERS_PAGE", page: value };
  }
  if (resource === "orders" && view === "detail") {
    return { type: "ORDERS_DETAIL", orderId: value };
  }
  if (resource === "alerts" && view === "page") {
    return { type: "ALERTS_PAGE", page: value };
  }
  if (resource === "alerts" && view === "detail") {
    return { type: "ALERTS_DETAIL", alertId: value };
  }

  return null;
}

function parseSafeNonNegativeInteger(value: string): number | null {
  if (!SAFE_NON_NEGATIVE_INTEGER.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
