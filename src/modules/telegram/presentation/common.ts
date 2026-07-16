import type { TelegramLocale } from "./locale.js";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatTelegramTimestamp(value: string | null, locale: TelegramLocale): string {
  if (value === null) {
    return localizedNone(locale);
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return localizedNone(locale);
  }

  const kst = new Date(instant.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = padTwoDigits(kst.getUTCMonth() + 1);
  const day = padTwoDigits(kst.getUTCDate());
  const hours = padTwoDigits(kst.getUTCHours());
  const minutes = padTwoDigits(kst.getUTCMinutes());
  const seconds = padTwoDigits(kst.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;
}

export function formatTelegramKrw(value: number | null, locale: TelegramLocale): string {
  if (value === null || !Number.isFinite(value)) {
    return localizedNone(locale);
  }

  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);

  return locale === "ko-KR" ? `${formatted}원` : `KRW ${formatted}`;
}

export function formatTelegramQuantity(
  value: number | string | null,
  asset: "BTC" | "ETH",
  locale: TelegramLocale,
): string {
  if (value === null) {
    return localizedNone(locale);
  }

  const quantity = typeof value === "number"
    ? normalizeDecimalQuantity(value.toFixed(8))
    : normalizeDecimalQuantity(value);

  if (quantity === null) {
    return localizedNone(locale);
  }

  return `${quantity} ${asset}`;
}

function normalizeDecimalQuantity(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = match[3] ?? "";
  const scale = 100_000_000n;
  const fractionAtScale = BigInt(fraction.slice(0, 8).padEnd(8, "0") || "0");
  const roundUp = fraction.length > 8 && (fraction.charCodeAt(8) - 48) >= 5;
  let scaled = whole * scale + fractionAtScale + (roundUp ? 1n : 0n);
  scaled *= sign;

  if (scaled === 0n) {
    return "0";
  }

  const absolute = scaled < 0n ? -scaled : scaled;
  const wholePart = absolute / scale;
  const fractionPart = (absolute % scale).toString().padStart(8, "0").replace(/0+$/, "");
  const prefix = scaled < 0n ? "-" : "";

  return fractionPart.length > 0
    ? `${prefix}${wholePart}.${fractionPart}`
    : `${prefix}${wholePart}`;
}

function localizedNone(locale: TelegramLocale): string {
  return locale === "ko-KR" ? "없음" : "none";
}

function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
