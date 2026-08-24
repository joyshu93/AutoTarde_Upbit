import assert from "node:assert/strict";

import {
  escapeTelegramHtml,
  formatTelegramKrw,
  formatTelegramQuantity,
  formatTelegramTimestamp,
} from "../src/modules/telegram/presentation/common.js";
import {
  DEFAULT_TELEGRAM_LOCALE,
  normalizeTelegramLocale,
} from "../src/modules/telegram/presentation/locale.js";
import {
  formatReadinessPresentation,
} from "../src/modules/telegram/presentation/readiness.js";
import {
  formatStrategyPreviewPresentation,
} from "../src/modules/telegram/presentation/preview.js";
import {
  formatStrategyRunPresentation,
} from "../src/modules/telegram/presentation/run.js";
import {
  formatPilotTechnicalVisibility,
  formatStatusPresentation,
  type BtcCandidatePilotVisibility,
} from "../src/modules/telegram/presentation/status.js";
import { test } from "./harness.js";

test("normalizeTelegramLocale supports Korean and English case-insensitively", () => {
  assert.equal(DEFAULT_TELEGRAM_LOCALE, "ko-KR");
  assert.equal(normalizeTelegramLocale("ko-KR"), "ko-KR");
  assert.equal(normalizeTelegramLocale("KO-kr"), "ko-KR");
  assert.equal(normalizeTelegramLocale("en-US"), "en-US");
  assert.equal(normalizeTelegramLocale("EN-us"), "en-US");
});

test("normalizeTelegramLocale defaults missing and unsupported values to Korean", () => {
  assert.equal(normalizeTelegramLocale(undefined), "ko-KR");
  assert.equal(normalizeTelegramLocale("ja-JP"), "ko-KR");
});

test("escapeTelegramHtml escapes Telegram HTML special characters", () => {
  assert.equal(
    escapeTelegramHtml('A&B <tag attr="value">'),
    "A&amp;B &lt;tag attr=&quot;value&quot;&gt;",
  );
});

test("formatTelegramTimestamp renders deterministic KST timestamps", () => {
  const timestamp = "2026-07-16T00:30:45.000Z";

  assert.equal(formatTelegramTimestamp(timestamp, "ko-KR"), "2026-07-16 09:30:45 KST");
  assert.equal(formatTelegramTimestamp(timestamp, "en-US"), "2026-07-16 09:30:45 KST");
});

test("presentation formatters localize null values", () => {
  assert.equal(formatTelegramTimestamp(null, "ko-KR"), "없음");
  assert.equal(formatTelegramTimestamp(null, "en-US"), "none");
  assert.equal(formatTelegramKrw(null, "ko-KR"), "없음");
  assert.equal(formatTelegramKrw(null, "en-US"), "none");
  assert.equal(formatTelegramQuantity(null, "BTC", "ko-KR"), "없음");
  assert.equal(formatTelegramQuantity(null, "ETH", "en-US"), "none");
});

test("formatTelegramKrw uses locale-specific labels and comma grouping", () => {
  assert.equal(formatTelegramKrw(8_967, "ko-KR"), "8,967원");
  assert.equal(formatTelegramKrw(8_967, "en-US"), "KRW 8,967");
});

test("formatTelegramQuantity trims zeros and suppresses floating-point noise", () => {
  assert.equal(formatTelegramQuantity(0.1 + 0.2, "BTC", "ko-KR"), "0.3 BTC");
  assert.equal(formatTelegramQuantity("1.23000000", "ETH", "en-US"), "1.23 ETH");
  assert.equal(formatTelegramQuantity("0.123456789", "BTC", "en-US"), "0.12345679 BTC");
  assert.equal(
    formatTelegramQuantity("123456789012345.12345678", "BTC", "en-US"),
    "123456789012345.12345678 BTC",
  );
});

const ACTIVE_PILOT_VISIBILITY: BtcCandidatePilotVisibility = {
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
  phase: "ACTIVE",
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
  stateVersion: 4,
  lastEvidenceAt: null,
  lastEvidenceId: null,
  exactFlatCheck: "UNAVAILABLE",
  replayCheck: "VERIFIED_BY_ROUTE",
  leaseCheck: "VERIFIED_BY_ROUTE",
  reconciliationCheck: "VERIFIED_BY_ROUTE",
  latestOutcome: {
    strategyDecisionId: "strategy-decision-pilot-1",
    action: "ADD",
    reasonCode: "CANDIDATE_ALLOWED",
    executionBlocked: false,
    createdAt: "2026-08-21T03:30:00.000Z",
  },
};

test("status presents the active BTC candidate and explicit ETH baseline in Korean and English", () => {
  const state = {
    id: "state-pilot-status",
    exchangeAccountId: "primary",
    executionMode: "LIVE" as const,
    liveExecutionGate: "ENABLED" as const,
    systemStatus: "RUNNING" as const,
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T03:31:00.000Z",
  };
  const input = {
    state,
    liveSendPath: "LIVE_ADAPTER" as const,
    schedulerStatus: null,
    latestReconciliationRun: null,
    btcPilot: ACTIVE_PILOT_VISIBILITY,
  };

  const korean = formatStatusPresentation(input, "ko-KR");
  const english = formatStatusPresentation(input, "en-US");

  assert.match(korean, /BTC 후보 파일럿: 활성 \(phase: ACTIVE\)/u);
  assert.match(korean, /파일럿 ID: BTC_COMBINED_CONSERVATIVE_PILOT_V1/u);
  assert.match(korean, /정책 버전: PCS-2026-001\.DEPLOYMENT_READINESS_V1/u);
  assert.match(korean, /상태 버전: 4/u);
  assert.match(korean, /마지막 증거: 제공되지 않음/u);
  assert.match(korean, /최근 BTC 후보 결과: 추가 매수 · CANDIDATE_ALLOWED/u);
  assert.match(korean, /ETH 정책: 기존 기준 전략 \(BASELINE\)/u);
  assert.match(english, /BTC candidate pilot: active \(phase: ACTIVE\)/u);
  assert.match(english, /ETH policy: existing baseline strategy \(BASELINE\)/u);
});

test("pilot technical visibility retains stable identifiers and raw checks without secrets", () => {
  const message = formatPilotTechnicalVisibility(ACTIVE_PILOT_VISIBILITY);

  assert.match(message, /btc_pilot_id: BTC_COMBINED_CONSERVATIVE_PILOT_V1/u);
  assert.match(message, /btc_pilot_phase: ACTIVE/u);
  assert.match(message, /btc_pilot_policy_version: PCS-2026-001\.DEPLOYMENT_READINESS_V1/u);
  assert.match(message, /btc_pilot_state_version: 4/u);
  assert.match(message, /btc_pilot_exact_flat_check: UNAVAILABLE/u);
  assert.match(message, /btc_pilot_replay_check: VERIFIED_BY_ROUTE/u);
  assert.match(message, /btc_pilot_lease_check: VERIFIED_BY_ROUTE/u);
  assert.match(message, /btc_pilot_reconciliation_check: VERIFIED_BY_ROUTE/u);
  assert.match(message, /btc_pilot_latest_reason_code: CANDIDATE_ALLOWED/u);
  assert.match(message, /eth_policy: BASELINE/u);
  assert.doesNotMatch(message, /I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT/u);
  assert.doesNotMatch(message, /owner.?token|access.?key|bot.?token/iu);
});

test("readiness, run, and preview reuse the same Korean-first pilot visibility", () => {
  const executionState = {
    id: "state-pilot-readiness",
    exchangeAccountId: "primary",
    executionMode: "LIVE" as const,
    liveExecutionGate: "ENABLED" as const,
    systemStatus: "RUNNING" as const,
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T03:31:00.000Z",
  };
  const readiness = formatReadinessPresentation({
    overallStatus: "PASS",
    executionState,
    schedulerStatus: null,
    latestBalanceSnapshot: null,
    latestPositionSnapshot: null,
    latestReconciliationRun: null,
    activeOrderCount: 0,
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
    checks: [],
    btcPilot: ACTIVE_PILOT_VISIBILITY,
  }, "ko-KR");
  const run = formatStrategyRunPresentation({
    status: "COMPLETED",
    requestedAt: "2026-08-21T03:31:00.000Z",
    market: "KRW-BTC",
    strategyDecisionId: "strategy-decision-pilot-1",
    action: "ADD",
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: "Candidate decision persisted.",
  }, "ko-KR", ACTIVE_PILOT_VISIBILITY);
  const preview = formatStrategyPreviewPresentation({
    status: "COMPLETED",
    requestedAt: "2026-08-21T03:31:00.000Z",
    market: "KRW-BTC",
    action: "ADD",
    executionDisposition: "IMMEDIATE",
    referencePrice: 100_000_000,
    requestedNotionalKrw: 5_000,
    requestedQuantity: null,
    orderSide: "bid",
    orderType: "price",
    orderPrice: "5000",
    orderVolume: null,
    detail: "Candidate preview computed.",
  }, "ko-KR", ACTIVE_PILOT_VISIBILITY);

  for (const message of [readiness, run, preview]) {
    assert.match(message, /BTC 후보 파일럿: 활성/u);
    assert.match(message, /ETH 정책: 기존 기준 전략 \(BASELINE\)/u);
    assert.doesNotMatch(message, /I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT/u);
  }
});
