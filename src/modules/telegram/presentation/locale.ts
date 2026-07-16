export type TelegramLocale = "ko-KR" | "en-US";

export const DEFAULT_TELEGRAM_LOCALE: TelegramLocale = "ko-KR";

export function normalizeTelegramLocale(input: string | undefined): TelegramLocale {
  const normalized = input?.trim().toLowerCase();

  if (normalized === "en-us") {
    return "en-US";
  }

  return DEFAULT_TELEGRAM_LOCALE;
}
