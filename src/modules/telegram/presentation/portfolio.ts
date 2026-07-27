import type {
  BalanceSnapshotRecord,
  ExchangeBalance,
  PositionSnapshot,
  PositionSnapshotRecord,
} from "../../../domain/types.js";
import {
  formatTelegramKrw,
  formatTelegramQuantity,
  formatTelegramTimestamp,
} from "./common.js";
import type { TelegramLocale } from "./locale.js";

const KOREAN_OPERATOR_BOUNDARY =
  "Telegram에서는 현금이나 보유 수량을 직접 입력할 수 없습니다.";
const ENGLISH_OPERATOR_BOUNDARY =
  "Telegram does not accept manual cash or position input.";

export function formatBalancePresentation(
  snapshot: BalanceSnapshotRecord | null,
  locale: TelegramLocale,
): string {
  if (!snapshot) {
    return buildBalanceUnavailableLines(locale, "missing").join("\n");
  }

  const balances = parseBalanceSnapshot(snapshot.balancesJson);
  const totalKrwValue = parseFiniteNumber(snapshot.totalKrwValue);
  if (
    !balances
    || (snapshot.totalKrwValue !== null && !isDecimalString(snapshot.totalKrwValue))
  ) {
    return buildBalanceUnavailableLines(locale, "malformed").join("\n");
  }

  return (locale === "ko-KR"
    ? [
        "잔고 요약 (Balances Snapshot)",
        `기준 시각: ${formatTelegramTimestamp(snapshot.capturedAt, locale)}`,
        `출처: ${describeSource(snapshot.source, locale)}`,
        `총 평가금액: ${formatTelegramKrw(totalKrwValue, locale)}`,
        ...(balances.length === 0
          ? ["저장된 잔고가 없습니다."]
          : ["통화별 잔고:", ...balances.flatMap((balance) => buildKoreanBalanceLines(balance))]),
        "기술 상세: /balances detail",
        `운영 경계: ${KOREAN_OPERATOR_BOUNDARY}`,
      ]
    : [
        "Balance summary (Balances Snapshot)",
        `As of: ${formatTelegramTimestamp(snapshot.capturedAt, locale)}`,
        `Source: ${describeSource(snapshot.source, locale)}`,
        `Total value: ${formatTelegramKrw(totalKrwValue, locale)}`,
        ...(balances.length === 0
          ? ["No stored balances."]
          : ["Balances:", ...balances.flatMap((balance) => buildEnglishBalanceLines(balance))]),
        "Technical details: /balances detail",
        `Operator boundary: ${ENGLISH_OPERATOR_BOUNDARY}`,
      ]).join("\n");
}

export function formatPositionPresentation(
  snapshot: PositionSnapshotRecord | null,
  locale: TelegramLocale,
): string {
  if (!snapshot) {
    return buildPositionUnavailableLines(locale, "missing").join("\n");
  }

  const positions = parsePositionSnapshot(snapshot.positionsJson);
  if (!positions) {
    return buildPositionUnavailableLines(locale, "malformed").join("\n");
  }

  const lines = locale === "ko-KR"
    ? [
        "보유 현황 요약 (Positions Snapshot)",
        `기준 시각: ${formatTelegramTimestamp(snapshot.capturedAt, locale)}`,
        `출처: ${describeSource(snapshot.source, locale)}`,
        ...(positions.length === 0
          ? ["저장된 보유 포지션이 없습니다."]
          : ["보유 포지션:", ...positions.flatMap((position) => buildKoreanPositionLines(position))]),
        "기술 상세: /positions detail",
        `운영 경계: ${KOREAN_OPERATOR_BOUNDARY}`,
      ]
    : [
        "Position summary (Positions Snapshot)",
        `As of: ${formatTelegramTimestamp(snapshot.capturedAt, locale)}`,
        `Source: ${describeSource(snapshot.source, locale)}`,
        ...(positions.length === 0
          ? ["No stored positions."]
          : ["Positions:", ...positions.flatMap((position) => buildEnglishPositionLines(position))]),
        "Technical details: /positions detail",
        `Operator boundary: ${ENGLISH_OPERATOR_BOUNDARY}`,
      ];

  return lines.join("\n");
}

function buildKoreanBalanceLines(balance: ExchangeBalance): string[] {
  return [
    `- ${balance.currency}`,
    `  사용 가능: ${formatBalanceAmount(balance.balance, balance.currency, "ko-KR")}`,
    `  주문 중: ${formatBalanceAmount(balance.locked, balance.currency, "ko-KR")}`,
    ...(balance.currency === "KRW" || isZeroDecimal(balance.avgBuyPrice)
      ? []
      : [`  평균 매수가: ${formatTelegramKrw(parseFiniteNumber(balance.avgBuyPrice), "ko-KR")}`]),
  ];
}

function buildEnglishBalanceLines(balance: ExchangeBalance): string[] {
  return [
    `- ${balance.currency}`,
    `  Available: ${formatBalanceAmount(balance.balance, balance.currency, "en-US")}`,
    `  Locked: ${formatBalanceAmount(balance.locked, balance.currency, "en-US")}`,
    ...(balance.currency === "KRW" || isZeroDecimal(balance.avgBuyPrice)
      ? []
      : [`  Average buy price: ${formatTelegramKrw(parseFiniteNumber(balance.avgBuyPrice), "en-US")}`]),
  ];
}

function buildKoreanPositionLines(position: PositionSnapshot): string[] {
  return [
    `- ${position.market}`,
    `  보유 수량: ${formatTelegramQuantity(position.quantity, position.asset, "ko-KR")}`,
    ...(position.averageEntryPrice === null
      ? []
      : [`  평균 매수가: ${formatTelegramKrw(parseFiniteNumber(position.averageEntryPrice), "ko-KR")}`]),
    ...(position.markPrice === null
      ? []
      : [`  현재가: ${formatTelegramKrw(parseFiniteNumber(position.markPrice), "ko-KR")}`]),
    ...(position.marketValue === null
      ? []
      : [`  평가금액: ${formatTelegramKrw(parseFiniteNumber(position.marketValue), "ko-KR")}`]),
    ...(position.exposureRatio === null
      ? []
      : [`  노출 비율: ${formatExposureRatio(position.exposureRatio, "ko-KR")}`]),
  ];
}

function buildEnglishPositionLines(position: PositionSnapshot): string[] {
  return [
    `- ${position.market}`,
    `  Quantity: ${formatTelegramQuantity(position.quantity, position.asset, "en-US")}`,
    ...(position.averageEntryPrice === null
      ? []
      : [`  Average entry: ${formatTelegramKrw(parseFiniteNumber(position.averageEntryPrice), "en-US")}`]),
    ...(position.markPrice === null
      ? []
      : [`  Mark price: ${formatTelegramKrw(parseFiniteNumber(position.markPrice), "en-US")}`]),
    ...(position.marketValue === null
      ? []
      : [`  Market value: ${formatTelegramKrw(parseFiniteNumber(position.marketValue), "en-US")}`]),
    ...(position.exposureRatio === null
      ? []
      : [`  Exposure: ${formatExposureRatio(position.exposureRatio, "en-US")}`]),
  ];
}

function buildBalanceUnavailableLines(
  locale: TelegramLocale,
  reason: "missing" | "malformed",
): string[] {
  return locale === "ko-KR"
    ? [
        "잔고 정보를 사용할 수 없습니다.",
        reason === "missing"
          ? "저장된 잔고 스냅샷이 없습니다. /sync 후 다시 확인하세요."
          : "저장된 잔고 데이터 형식이 올바르지 않습니다. /sync 결과를 확인하세요.",
        "기술 상세: /balances detail",
        `운영 경계: ${KOREAN_OPERATOR_BOUNDARY}`,
      ]
    : [
        "Balance information is unavailable.",
        reason === "missing"
          ? "No stored balance snapshot. Run /sync and try again."
          : "The stored balance data is malformed. Review the /sync result.",
        "Technical details: /balances detail",
        `Operator boundary: ${ENGLISH_OPERATOR_BOUNDARY}`,
      ];
}

function buildPositionUnavailableLines(
  locale: TelegramLocale,
  reason: "missing" | "malformed",
): string[] {
  return locale === "ko-KR"
    ? [
        "보유 현황 정보를 사용할 수 없습니다.",
        reason === "missing"
          ? "저장된 보유 포지션이 없습니다. /sync 후 다시 확인하세요."
          : "저장된 포지션 데이터 형식이 올바르지 않습니다. /sync 결과를 확인하세요.",
        "기술 상세: /positions detail",
        `운영 경계: ${KOREAN_OPERATOR_BOUNDARY}`,
      ]
    : [
        "Position information is unavailable.",
        reason === "missing"
          ? "No stored positions. Run /sync and try again."
          : "The stored position data is malformed. Review the /sync result.",
        "Technical details: /positions detail",
        `Operator boundary: ${ENGLISH_OPERATOR_BOUNDARY}`,
      ];
}

function describeSource(
  source: BalanceSnapshotRecord["source"] | PositionSnapshotRecord["source"],
  locale: TelegramLocale,
): string {
  if (locale === "ko-KR") {
    return source === "RECONCILIATION"
      ? `거래소 동기화 (source: ${source})`
      : `거래소 조회 (source: ${source})`;
  }
  return source === "RECONCILIATION"
    ? `reconciliation (source: ${source})`
    : `exchange poll (source: ${source})`;
}

function formatBalanceAmount(
  value: string,
  unit: string,
  locale: TelegramLocale,
): string {
  if (unit === "BTC" || unit === "ETH") {
    return formatTelegramQuantity(value, unit, locale);
  }
  const normalized = normalizeDecimal(value);
  return normalized === null ? (locale === "ko-KR" ? "없음" : "none") : `${normalized} ${unit}`;
}

function formatExposureRatio(value: string, locale: TelegramLocale): string {
  const ratio = parseFiniteNumber(value);
  if (ratio === null) {
    return locale === "ko-KR" ? "없음" : "none";
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(ratio * 100)}%`;
}

function parseBalanceSnapshot(value: string): ExchangeBalance[] | null {
  const parsed = parseJsonArray(value);
  return parsed && parsed.every(isExchangeBalance) ? parsed : null;
}

function parsePositionSnapshot(value: string): PositionSnapshot[] | null {
  const parsed = parseJsonArray(value);
  return parsed && parsed.every(isPositionSnapshot) ? parsed : null;
}

function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isExchangeBalance(value: unknown): value is ExchangeBalance {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.currency === "string"
    && value.currency.trim().length > 0
    && typeof value.unitCurrency === "string"
    && value.unitCurrency.trim().length > 0
    && isDecimalString(value.balance)
    && isDecimalString(value.locked)
    && isDecimalString(value.avgBuyPrice);
}

function isPositionSnapshot(value: unknown): value is PositionSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const nullableNumbers = ["averageEntryPrice", "markPrice", "marketValue", "exposureRatio"];
  const assetMarketMatches = (value.asset === "BTC" && value.market === "KRW-BTC")
    || (value.asset === "ETH" && value.market === "KRW-ETH");
  return assetMarketMatches
    && isDecimalString(value.quantity)
    && typeof value.capturedAt === "string"
    && nullableNumbers.every((key) => value[key] === null || isDecimalString(value[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFiniteNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDecimal(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  const sign = match[1] === "-" ? "-" : "";
  const whole = (match[2] ?? "0").replace(/^0+(?=\d)/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string"
    && normalizeDecimal(value) !== null
    && parseFiniteNumber(value) !== null;
}

function isZeroDecimal(value: string): boolean {
  return parseFiniteNumber(value) === 0;
}
