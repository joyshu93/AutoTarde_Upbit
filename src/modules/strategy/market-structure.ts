import type { SupportedAsset, SupportedMarket } from "../../domain/types.js";
import type {
  PositionGuardStructureAnalysis,
  StrategyEntryPath,
  StrategyInvalidationState,
  StrategyMarketRegime,
  StrategyRiskLevel,
  StrategyWeakeningStage,
} from "./position-guard-core.js";

export type SupportedStrategyTimeframe = "1h" | "4h" | "1d";
export type StrategyTrendDirection = "UP" | "DOWN" | "FLAT";
export type StrategyRangeLocation = "LOWER" | "MIDDLE" | "UPPER";

export interface StrategyMarketCandle {
  market: SupportedMarket;
  timeframe: SupportedStrategyTimeframe;
  openTime: string;
  closeTime: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume: number;
}

export interface StrategyTimeframeMarketSnapshot {
  timeframe: SupportedStrategyTimeframe;
  candles: StrategyMarketCandle[];
}

export interface StrategyMarketTicker {
  tradePrice: number;
  tradeTimeUtc?: string | null;
  tradeTimeKst?: string | null;
  exchangeTimestampMs?: number | null;
  fetchedAt?: string | null;
}

export interface PositionGuardMarketSnapshot {
  asset: SupportedAsset;
  market: SupportedMarket;
  ticker: StrategyMarketTicker;
  timeframes: Record<SupportedStrategyTimeframe, StrategyTimeframeMarketSnapshot>;
  fetchedAt: string;
}

export interface TimeframeIndicatorState {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  rsi14: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  previousMacdHistogram: number | null;
  volumeRatio: number | null;
}

export interface TimeframeStructure {
  timeframe: SupportedStrategyTimeframe;
  trend: StrategyTrendDirection;
  rangeHigh: number;
  rangeLow: number;
  previousRangeLow: number;
  previousRangeHigh: number;
  location: StrategyRangeLocation;
  changePct: number;
  latestClose: number;
  previousClose: number;
  swingHigh: number;
  swingLow: number;
  support: number;
  resistance: number;
  indicators: TimeframeIndicatorState;
  aboveEma20: boolean;
  aboveEma50: boolean;
  aboveEma200: boolean;
  emaStackBullish: boolean;
  emaStackBearish: boolean;
  macdHistogramImproving: boolean;
  rsiOverbought: boolean;
  rsiOversold: boolean;
}

export interface PositionGuardMarketStructureAnalysis extends PositionGuardStructureAnalysis {
  asset: SupportedAsset;
  market: SupportedMarket;
  timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>;
  bearishTrendCount: number;
  bullishTrendCount: number;
  lowerLocationCount: number;
  upperLocationCount: number;
  reclaimLevel: number | null;
}

const LOOKBACK: Record<SupportedStrategyTimeframe, number> = { "1h": 24, "4h": 24, "1d": 30 };
const TREND_THRESHOLD: Record<SupportedStrategyTimeframe, number> = { "1h": 0.015, "4h": 0.025, "1d": 0.03 };
const SWING_LOOKBACK: Record<SupportedStrategyTimeframe, number> = { "1h": 18, "4h": 18, "1d": 20 };

export function analyzePositionGuardMarketStructure(
  snapshot: PositionGuardMarketSnapshot,
  averageEntryPrice = 0,
): PositionGuardMarketStructureAnalysis {
  const currentPrice = snapshot.ticker.tradePrice;
  const timeframes = {
    "1h": analyzeTimeframe("1h", getDecisionCandles(snapshot, "1h"), currentPrice),
    "4h": analyzeTimeframe("4h", getDecisionCandles(snapshot, "4h"), currentPrice),
    "1d": analyzeTimeframe("1d", getDecisionCandles(snapshot, "1d"), currentPrice),
  };
  const structures = Object.values(timeframes);
  const reclaimLevel = getReclaimLevel(timeframes["1h"], timeframes["4h"]);
  const reclaimStructure = isFreshReclaim(timeframes["1h"], timeframes["4h"]);
  const breakoutHoldStructure = isBreakoutHold(timeframes["1h"], timeframes["4h"]);
  const failedReclaim = isFailedReclaimBelowLevel(timeframes["1h"], timeframes["4h"].support)
    || isFailedReclaimBelowLevel(timeframes["4h"], timeframes["1d"].support);
  const breakdown4h = isConfirmedBreakdown(timeframes["4h"], timeframes["1h"], timeframes["4h"].support);
  const breakdown1d = isConfirmedBreakdown(timeframes["1d"], timeframes["4h"], timeframes["1d"].support);
  const pullbackZone = !breakdown4h
    && !breakdown1d
    && !failedReclaim
    && (
      timeframes["4h"].location === "LOWER"
      || (timeframes["4h"].location === "MIDDLE" && !breakoutHoldStructure)
      || (timeframes["1h"].location === "LOWER" && timeframes["4h"].trend !== "DOWN")
    );
  const upperRangeChase = isUpperRangeChase(timeframes, currentPrice, reclaimStructure || breakoutHoldStructure);
  const volumeRecovery = isConstructiveVolumeRecovery(timeframes["1h"], timeframes["4h"]);
  const macdImproving = timeframes["1h"].macdHistogramImproving || timeframes["4h"].macdHistogramImproving;
  const rsiRecovery = isRsiRecovery(timeframes["1h"]) || isRsiRecovery(timeframes["4h"]);
  const bearishMomentumExpansion = isBearishMomentumExpansion(timeframes);
  const atrShock = isAtrShock(timeframes["1h"]) || isAtrShock(timeframes["4h"]);
  const entryPath = getEntryPath({ pullbackZone, reclaimStructure, breakoutHoldStructure });
  const trendAlignmentScore = getTrendAlignmentScore(timeframes);
  const recoveryQualityScore = getRecoveryQualityScore({
    timeframes,
    pullbackZone,
    reclaimStructure,
    breakoutHoldStructure,
    volumeRecovery,
    macdImproving,
    rsiRecovery,
  });
  const breakdownPressureScore = getBreakdownPressureScore({
    timeframes,
    breakdown4h,
    breakdown1d,
    failedReclaim,
    bearishMomentumExpansion,
    atrShock,
  });
  const regime = classifyRegime(timeframes, {
    breakdown4h,
    breakdown1d,
    reclaimStructure,
    breakoutHoldStructure,
    macdImproving,
    rsiRecovery,
    failedReclaim,
  });
  const invalidationLevel = getInvalidationLevel(timeframes);
  const invalidationState: StrategyInvalidationState = invalidationLevel === null
    ? "UNCLEAR"
    : isInvalidationBroken(timeframes, invalidationLevel)
      ? "BROKEN"
      : "CLEAR";
  const weakeningStage = getWeakeningStage(
    breakdownPressureScore,
    breakdown1d || invalidationState === "BROKEN",
  );
  const riskLevel: StrategyRiskLevel = breakdown1d || regime === "BREAKDOWN_RISK"
    ? "HIGH"
    : breakdown4h || failedReclaim || atrShock || bearishMomentumExpansion
      ? "ELEVATED"
      : regime === "WEAK_DOWNTREND" || regime === "RECLAIM_ATTEMPT"
        ? "MODERATE"
        : "LOW";

  return {
    asset: snapshot.asset,
    market: snapshot.market,
    currentPrice,
    timeframes,
    bearishTrendCount: structures.filter((value) => value.trend === "DOWN").length,
    bullishTrendCount: structures.filter((value) => value.trend === "UP").length,
    lowerLocationCount: structures.filter((value) => value.location === "LOWER").length,
    upperLocationCount: structures.filter((value) => value.location === "UPPER").length,
    regime,
    riskLevel,
    invalidationState,
    invalidationLevel,
    pullbackZone,
    reclaimLevel,
    reclaimStructure,
    breakoutHoldStructure,
    upperRangeChase,
    entryPath,
    trendAlignmentScore,
    recoveryQualityScore,
    breakdownPressureScore,
    weakeningStage,
    breakdown1d,
    breakdown4h,
    failedReclaim,
    bearishMomentumExpansion,
    volumeRecovery,
    macdImproving,
    rsiRecovery,
    atrShock,
    averageEntryPrice,
    pnlPct: averageEntryPrice > 0 ? (currentPrice - averageEntryPrice) / averageEntryPrice : 0,
    oneHourLocation: timeframes["1h"].location,
    fourHourLocation: timeframes["4h"].location,
  };
}

function analyzeTimeframe(
  timeframe: SupportedStrategyTimeframe,
  candles: StrategyMarketCandle[],
  currentPrice: number,
): TimeframeStructure {
  const recent = candles.slice(-Math.min(candles.length, LOOKBACK[timeframe]));
  const prior = recent.length > 1 ? recent.slice(0, -1) : recent;
  const closes = candles.map((candle) => candle.closePrice);
  const latestClose = recent[recent.length - 1]?.closePrice ?? currentPrice;
  const previousClose = recent[recent.length - 2]?.closePrice ?? latestClose;
  const firstClose = recent[0]?.closePrice ?? currentPrice;
  const changePct = firstClose > 0 ? (latestClose - firstClose) / firstClose : 0;
  const ema20 = calculateEma(closes, 20);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const atr14 = calculateAtr(candles, 14);
  const rsi14 = calculateRsi(closes, 14);
  const macd = calculateMacd(closes);
  const volumeRatio = calculateVolumeRatio(candles, 20);
  const swings = findSwings(candles.slice(-SWING_LOOKBACK[timeframe]), currentPrice);

  return {
    timeframe,
    trend: classifyTrend(timeframe, changePct, latestClose, ema20, ema50),
    rangeHigh: getHigh(recent, currentPrice),
    rangeLow: getLow(recent, currentPrice),
    previousRangeHigh: getHigh(prior, currentPrice),
    previousRangeLow: getLow(prior, currentPrice),
    location: classifyLocation(latestClose, swings.swingLow, swings.swingHigh),
    changePct,
    latestClose,
    previousClose,
    swingHigh: swings.swingHigh,
    swingLow: swings.swingLow,
    support: swings.swingLow,
    resistance: swings.swingHigh,
    indicators: {
      ema20,
      ema50,
      ema200,
      atr14,
      rsi14,
      macdLine: macd.line,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
      previousMacdHistogram: macd.previousHistogram,
      volumeRatio,
    },
    aboveEma20: ema20 !== null ? latestClose >= ema20 : false,
    aboveEma50: ema50 !== null ? latestClose >= ema50 : false,
    aboveEma200: ema200 !== null ? latestClose >= ema200 : false,
    emaStackBullish: ema20 !== null && ema50 !== null && ema200 !== null ? ema20 >= ema50 && ema50 >= ema200 : false,
    emaStackBearish: ema20 !== null && ema50 !== null && ema200 !== null ? ema20 <= ema50 && ema50 <= ema200 : false,
    macdHistogramImproving: macd.histogram !== null && macd.previousHistogram !== null ? macd.histogram > macd.previousHistogram : false,
    rsiOverbought: rsi14 !== null ? rsi14 >= 70 : false,
    rsiOversold: rsi14 !== null ? rsi14 <= 35 : false,
  };
}

function getDecisionCandles(
  snapshot: PositionGuardMarketSnapshot,
  timeframe: SupportedStrategyTimeframe,
): StrategyMarketCandle[] {
  const candles = snapshot.timeframes[timeframe].candles;
  const cutoffMs = getSnapshotDecisionCutoffMs(snapshot);
  if (cutoffMs === null) {
    return candles;
  }

  const completed = candles.filter((candle) => {
    const closeMs = toUtcMs(candle.closeTime);
    return closeMs !== null && closeMs <= cutoffMs;
  });

  return completed.length >= Math.min(LOOKBACK[timeframe], 5) ? completed : candles;
}

function getSnapshotDecisionCutoffMs(snapshot: PositionGuardMarketSnapshot): number | null {
  if (typeof snapshot.ticker.exchangeTimestampMs === "number" && Number.isFinite(snapshot.ticker.exchangeTimestampMs)) {
    return snapshot.ticker.exchangeTimestampMs;
  }

  const tradeTimeMs = snapshot.ticker.tradeTimeUtc ? toUtcMs(snapshot.ticker.tradeTimeUtc) : null;
  if (tradeTimeMs !== null) {
    return tradeTimeMs;
  }

  return toUtcMs(snapshot.ticker.fetchedAt ?? snapshot.fetchedAt);
}

function classifyTrend(
  timeframe: SupportedStrategyTimeframe,
  changePct: number,
  latestClose: number,
  ema20: number | null,
  ema50: number | null,
): StrategyTrendDirection {
  const above20 = ema20 !== null ? latestClose >= ema20 : false;
  const above50 = ema50 !== null ? latestClose >= ema50 : false;
  if (changePct >= TREND_THRESHOLD[timeframe] && above20 && (ema50 === null || above50)) {
    return "UP";
  }
  if (changePct <= -TREND_THRESHOLD[timeframe] && !above20 && (ema50 === null || !above50)) {
    return "DOWN";
  }
  return "FLAT";
}

function classifyRegime(
  timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>,
  input: {
    breakdown4h: boolean;
    breakdown1d: boolean;
    reclaimStructure: boolean;
    breakoutHoldStructure: boolean;
    macdImproving: boolean;
    rsiRecovery: boolean;
    failedReclaim: boolean;
  },
): StrategyMarketRegime {
  const oneHour = timeframes["1h"];
  const fourHour = timeframes["4h"];
  const oneDay = timeframes["1d"];
  const recoverySignalCount = [
    input.reclaimStructure || input.breakoutHoldStructure,
    input.macdImproving,
    input.rsiRecovery,
    fourHour.aboveEma20,
    oneDay.location !== "LOWER",
  ].filter(Boolean).length;

  if (
    input.breakdown1d
    || input.failedReclaim
    || (input.breakdown4h && oneDay.trend === "DOWN")
    || (oneDay.emaStackBearish && isCloseBelowLevel(oneDay, oneDay.support, 0.15))
  ) {
    return "BREAKDOWN_RISK";
  }

  if (oneDay.emaStackBullish && fourHour.emaStackBullish && oneDay.trend !== "DOWN" && fourHour.trend !== "DOWN") {
    return fourHour.location !== "UPPER" && (fourHour.latestClose <= (fourHour.indicators.ema20 ?? fourHour.latestClose) * 1.02 || oneHour.location !== "UPPER")
      ? "PULLBACK_IN_UPTREND"
      : "BULL_TREND";
  }

  if (recoverySignalCount >= 4 && !oneDay.emaStackBearish && !input.breakdown4h && oneHour.latestClose >= fourHour.support) {
    return "EARLY_RECOVERY";
  }

  if (recoverySignalCount >= 3 && !input.breakdown4h && oneHour.latestClose >= fourHour.support) {
    return "RECLAIM_ATTEMPT";
  }

  if (oneDay.trend === "FLAT" && fourHour.trend !== "DOWN" && !oneDay.emaStackBearish && oneDay.location !== "LOWER") {
    return "RANGE";
  }

  return "WEAK_DOWNTREND";
}

function getEntryPath(input: {
  pullbackZone: boolean;
  reclaimStructure: boolean;
  breakoutHoldStructure: boolean;
}): StrategyEntryPath {
  if (input.reclaimStructure) return "RECLAIM";
  if (input.breakoutHoldStructure) return "BREAKOUT_HOLD";
  if (input.pullbackZone) return "PULLBACK";
  return "NONE";
}

function getTrendAlignmentScore(timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>): number {
  let score = 0;
  if (timeframes["1d"].emaStackBullish) score += 2;
  else if (timeframes["1d"].trend === "UP" || timeframes["1d"].aboveEma20) score += 1;
  if (timeframes["4h"].emaStackBullish) score += 2;
  else if (timeframes["4h"].trend === "UP" || timeframes["4h"].aboveEma20) score += 1;
  if (timeframes["1h"].trend === "UP") score += 1;
  return score;
}

function getRecoveryQualityScore(input: {
  timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>;
  pullbackZone: boolean;
  reclaimStructure: boolean;
  breakoutHoldStructure: boolean;
  volumeRecovery: boolean;
  macdImproving: boolean;
  rsiRecovery: boolean;
}): number {
  let score = 0;
  if (input.reclaimStructure) score += 2;
  if (input.breakoutHoldStructure) score += 2;
  if (input.pullbackZone && (input.timeframes["1h"].location === "LOWER" || input.timeframes["4h"].location === "LOWER")) score += 1;
  if (input.volumeRecovery) score += 1;
  if (input.macdImproving) score += 1;
  if (input.rsiRecovery) score += 1;
  return score;
}

function getBreakdownPressureScore(input: {
  timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>;
  breakdown4h: boolean;
  breakdown1d: boolean;
  failedReclaim: boolean;
  bearishMomentumExpansion: boolean;
  atrShock: boolean;
}): number {
  let score = 0;
  if (input.breakdown1d) score += 3;
  if (input.breakdown4h) score += 2;
  if (input.failedReclaim) score += 2;
  if (input.bearishMomentumExpansion) score += 1;
  if (input.atrShock) score += 1;
  if (input.timeframes["1d"].trend === "DOWN") score += 1;
  return score;
}

function getWeakeningStage(
  breakdownPressureScore: number,
  invalidationFailed: boolean,
): StrategyWeakeningStage {
  if (invalidationFailed) return "FAILURE";
  if (breakdownPressureScore >= 4) return "CLEAR";
  if (breakdownPressureScore >= 2) return "SOFT";
  return "NONE";
}

function getInvalidationLevel(timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>): number | null {
  const levels = [timeframes["4h"].support, timeframes["1d"].support].filter((value) => Number.isFinite(value) && value > 0);
  return levels.length === 0 ? null : Math.max(...levels);
}

function getReclaimLevel(oneHour: TimeframeStructure, fourHour: TimeframeStructure): number | null {
  const reclaimedBarrier = Math.min(oneHour.previousRangeHigh, fourHour.resistance);
  const higherTimeframeFloor = fourHour.support;
  const candidates = [reclaimedBarrier, higherTimeframeFloor].filter((value): value is number => Number.isFinite(value) && value > 0);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

function isInvalidationBroken(
  timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>,
  level: number,
): boolean {
  return isCloseBelowLevel(timeframes["4h"], level, 0.2)
    || isCloseBelowLevel(timeframes["1d"], level, 0.15)
    || isFailedReclaimBelowLevel(timeframes["1h"], level);
}

function isConfirmedBreakdown(
  structure: TimeframeStructure,
  lowerTimeframe: TimeframeStructure,
  level: number,
): boolean {
  return isCloseBelowLevel(structure, level, 0.2)
    || isSustainedCloseBelowLevel(structure, level)
    || isFailedReclaimBelowLevel(lowerTimeframe, level);
}

function isCloseBelowLevel(
  structure: TimeframeStructure,
  level: number,
  atrMultiplier: number,
): boolean {
  if (!Number.isFinite(level) || level <= 0) return false;
  return structure.latestClose <= level - getLevelBuffer(level, structure.indicators.atr14, atrMultiplier);
}

function isSustainedCloseBelowLevel(structure: TimeframeStructure, level: number): boolean {
  const buffer = getLevelBuffer(level, structure.indicators.atr14, 0.05);
  return structure.previousClose <= level - buffer && structure.latestClose <= level - buffer;
}

function isFailedReclaimBelowLevel(structure: TimeframeStructure, level: number): boolean {
  if (!Number.isFinite(level) || level <= 0) return false;
  const buffer = getLevelBuffer(level, structure.indicators.atr14, 0.08);
  return structure.previousClose >= level - buffer && structure.latestClose <= level - buffer;
}

function isUpperRangeChase(
  timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>,
  currentPrice: number,
  hasReclaimQuality: boolean,
): boolean {
  const oneHour = timeframes["1h"];
  const fourHour = timeframes["4h"];
  const oneDay = timeframes["1d"];
  const resistanceBuffer = getLevelBuffer(oneHour.resistance, oneHour.indicators.atr14, 0.25);
  const higherTimeframeExtension = fourHour.location === "UPPER" && oneDay.location === "UPPER";
  const localExtension = oneHour.location === "UPPER"
    && currentPrice >= oneHour.resistance + resistanceBuffer
    && (oneHour.indicators.rsi14 ?? 0) >= 66;

  if (hasReclaimQuality) {
    return higherTimeframeExtension && localExtension;
  }

  return higherTimeframeExtension
    || localExtension
    || (oneHour.location === "UPPER" && currentPrice > (oneHour.indicators.ema20 ?? currentPrice) * 1.02);
}

function classifyLocation(currentPrice: number, rangeLow: number, rangeHigh: number): StrategyRangeLocation {
  const width = rangeHigh - rangeLow;
  if (width <= 0) return "MIDDLE";
  const placement = (currentPrice - rangeLow) / width;
  return placement <= 0.33 ? "LOWER" : placement >= 0.67 ? "UPPER" : "MIDDLE";
}

function calculateEma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    ema = ((values[index] ?? ema) - ema) * multiplier + ema;
  }
  return ema;
}

function calculateAtr(candles: StrategyMarketCandle[], period: number): number | null {
  if (candles.length <= period) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (!candle || !previous) continue;
    trueRanges.push(Math.max(
      candle.highPrice - candle.lowPrice,
      Math.abs(candle.highPrice - previous.closePrice),
      Math.abs(candle.lowPrice - previous.closePrice),
    ));
  }
  if (trueRanges.length < period) return null;
  let atr = average(trueRanges.slice(0, period));
  for (let index = period; index < trueRanges.length; index += 1) {
    atr = ((atr * (period - 1)) + (trueRanges[index] ?? atr)) / period;
  }
  return atr;
}

function calculateRsi(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = (values[index] ?? 0) - (values[index - 1] ?? 0);
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = (values[index] ?? 0) - (values[index - 1] ?? 0);
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function calculateMacd(values: number[]): {
  line: number | null;
  signal: number | null;
  histogram: number | null;
  previousHistogram: number | null;
} {
  if (values.length < 35) {
    return { line: null, signal: null, histogram: null, previousHistogram: null };
  }
  const ema12 = calculateEmaSeries(values, 12);
  const ema26 = calculateEmaSeries(values, 26);
  const macdSeries = ema12
    .map((value, index) => {
      const slow = ema26[index] ?? null;
      return value !== null && slow !== null ? value - slow : null;
    })
    .filter((value): value is number => value !== null);
  const signalSeries = calculateEmaSeries(macdSeries, 9).filter((value): value is number => value !== null);
  if (macdSeries.length === 0 || signalSeries.length === 0) {
    return { line: null, signal: null, histogram: null, previousHistogram: null };
  }
  const line = macdSeries[macdSeries.length - 1] ?? null;
  const signal = signalSeries[signalSeries.length - 1] ?? null;
  const previousLine = macdSeries[macdSeries.length - 2] ?? null;
  const previousSignal = signalSeries[signalSeries.length - 2] ?? null;
  return {
    line,
    signal,
    histogram: line !== null && signal !== null ? line - signal : null,
    previousHistogram: previousLine !== null && previousSignal !== null ? previousLine - previousSignal : null,
  };
}

function calculateEmaSeries(values: number[], period: number): Array<number | null> {
  if (values.length < period) return values.map(() => null);
  const multiplier = 2 / (period + 1);
  const output: Array<number | null> = values.map(() => null);
  let ema = average(values.slice(0, period));
  output[period - 1] = ema;
  for (let index = period; index < values.length; index += 1) {
    ema = ((values[index] ?? ema) - ema) * multiplier + ema;
    output[index] = ema;
  }
  return output;
}

function calculateVolumeRatio(candles: StrategyMarketCandle[], period: number): number | null {
  if (candles.length < 2) return null;
  const latest = candles[candles.length - 1]?.volume ?? null;
  if (latest === null) return null;
  const baseline = candles
    .slice(Math.max(0, candles.length - 1 - period), candles.length - 1)
    .map((candle) => candle.volume);
  if (baseline.length === 0) return null;
  const averageVolume = average(baseline);
  return averageVolume <= 0 ? null : latest / averageVolume;
}

function findSwings(candles: StrategyMarketCandle[], fallback: number): { swingHigh: number; swingLow: number } {
  if (candles.length < 5) {
    return { swingHigh: getHigh(candles, fallback), swingLow: getLow(candles, fallback) };
  }
  let pivotHigh: number | null = null;
  let pivotLow: number | null = null;
  for (let index = 2; index < candles.length - 2; index += 1) {
    const current = candles[index];
    if (!current) continue;
    const highs = candles.slice(index - 2, index + 3).map((candle) => candle.highPrice);
    const lows = candles.slice(index - 2, index + 3).map((candle) => candle.lowPrice);
    if (current.highPrice === Math.max(...highs)) pivotHigh = current.highPrice;
    if (current.lowPrice === Math.min(...lows)) pivotLow = current.lowPrice;
  }
  return {
    swingHigh: pivotHigh ?? getHigh(candles, fallback),
    swingLow: pivotLow ?? getLow(candles, fallback),
  };
}

function isFreshReclaim(oneHour: TimeframeStructure, fourHour: TimeframeStructure): boolean {
  const reclaimLevel = getReclaimLevel(oneHour, fourHour);
  if (reclaimLevel === null) return false;
  const buffer = Math.max(reclaimLevel * 0.001, (oneHour.indicators.atr14 ?? 0) * 0.05);
  const extensionLimit = Math.max(getLevelBuffer(reclaimLevel, oneHour.indicators.atr14, 2.2), reclaimLevel * 0.025);
  return oneHour.previousClose <= reclaimLevel + buffer
    && oneHour.latestClose >= reclaimLevel + buffer
    && oneHour.latestClose <= reclaimLevel + extensionLimit
    && oneHour.aboveEma20;
}

function isBreakoutHold(oneHour: TimeframeStructure, fourHour: TimeframeStructure): boolean {
  const holdLevel = Math.min(oneHour.previousRangeHigh, oneHour.resistance);
  const buffer = Math.max(holdLevel * 0.001, (oneHour.indicators.atr14 ?? 0) * 0.05);
  const extensionLimit = Math.max(getLevelBuffer(holdLevel, oneHour.indicators.atr14, 2), holdLevel * 0.02);
  return holdLevel > 0
    && oneHour.previousClose >= holdLevel - buffer
    && oneHour.latestClose >= holdLevel - buffer
    && oneHour.latestClose <= holdLevel + extensionLimit
    && oneHour.aboveEma20
    && (fourHour.trend !== "DOWN" || fourHour.aboveEma20);
}

function isRsiRecovery(structure: TimeframeStructure): boolean {
  const rsi = structure.indicators.rsi14;
  return rsi !== null && rsi >= 40 && rsi <= 64 && structure.macdHistogramImproving;
}

function isConstructiveVolumeRecovery(oneHour: TimeframeStructure, fourHour: TimeframeStructure): boolean {
  const oneHourRatio = oneHour.indicators.volumeRatio ?? 0;
  const fourHourRatio = fourHour.indicators.volumeRatio ?? 0;

  return (
    oneHourRatio >= 1.005
    && oneHour.latestClose > oneHour.previousClose
  ) || (
    fourHourRatio >= 1
    && fourHour.latestClose >= fourHour.previousClose
    && fourHour.aboveEma20
  );
}

function isBearishMomentumExpansion(timeframes: Record<SupportedStrategyTimeframe, TimeframeStructure>): boolean {
  return (timeframes["1h"].indicators.macdHistogram ?? 0) < 0
    && !timeframes["1h"].macdHistogramImproving
    && (timeframes["4h"].indicators.macdHistogram ?? 0) < 0
    && !timeframes["4h"].macdHistogramImproving;
}

function isAtrShock(structure: TimeframeStructure): boolean {
  const atr = structure.indicators.atr14;
  return atr !== null
    && atr > 0
    && Math.abs(structure.latestClose - structure.previousClose) >= atr * 1.2
    && structure.latestClose <= structure.support - getLevelBuffer(structure.support, atr, 0.15);
}

function getLevelBuffer(level: number, atr: number | null, atrMultiplier: number): number {
  const atrBuffer = atr !== null && atr > 0 ? atr * atrMultiplier : 0;
  return Math.max(level * 0.0025, atrBuffer);
}

function toUtcMs(value: string): number | null {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getHigh(candles: StrategyMarketCandle[], fallback: number): number {
  return candles.length === 0
    ? fallback
    : candles.reduce((highest, candle) => Math.max(highest, candle.highPrice), candles[0]?.highPrice ?? fallback);
}

function getLow(candles: StrategyMarketCandle[], fallback: number): number {
  return candles.length === 0
    ? fallback
    : candles.reduce((lowest, candle) => Math.min(lowest, candle.lowPrice), candles[0]?.lowPrice ?? fallback);
}
