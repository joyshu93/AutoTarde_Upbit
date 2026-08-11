export type PerformanceTimestamp = {
  normalized: string;
  epochNanoseconds: bigint;
};

const EXPLICIT_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function parsePerformanceTimestamp(value: string): PerformanceTimestamp | null {
  const match = EXPLICIT_ISO_TIMESTAMP.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];
  if (
    timezone === undefined || month < 1 || month > 12 || day < 1 ||
    day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 ||
    !isValidTimezone(timezone)
  ) {
    return null;
  }

  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${timezone}`;
  const epochMilliseconds = Date.parse(wholeSecond);
  if (!Number.isFinite(epochMilliseconds)) return null;

  const fractionNanoseconds = BigInt(fraction.padEnd(9, "0") || "0");
  const normalizedFraction = fraction.length < 3 ? fraction.padEnd(3, "0") : fraction;
  const normalizedSecond = new Date(epochMilliseconds).toISOString().slice(0, 19);
  return {
    normalized: `${normalizedSecond}.${normalizedFraction || "000"}Z`,
    epochNanoseconds:
      BigInt(epochMilliseconds) * NANOSECONDS_PER_MILLISECOND + fractionNanoseconds,
  };
}

export function comparePerformanceTimestamps(left: string, right: string): number {
  return compareEpochNanoseconds(
    requirePerformanceTimestamp(left).epochNanoseconds,
    requirePerformanceTimestamp(right).epochNanoseconds,
  );
}

export function performanceTimestampDifferenceMs(later: string, earlier: string): number {
  const difference =
    requirePerformanceTimestamp(later).epochNanoseconds -
    requirePerformanceTimestamp(earlier).epochNanoseconds;
  return Number(difference) / Number(NANOSECONDS_PER_MILLISECOND);
}

export function performanceTimestampEpochNanoseconds(value: string): bigint {
  return requirePerformanceTimestamp(value).epochNanoseconds;
}

export function compareEpochNanoseconds(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requirePerformanceTimestamp(value: string): PerformanceTimestamp {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`Invalid performance timestamp ${value}.`);
  return parsed;
}

function isValidTimezone(timezone: string): boolean {
  if (timezone === "Z") return true;
  const offsetHour = Number(timezone.slice(1, 3));
  const offsetMinute = Number(timezone.slice(4, 6));
  return offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
