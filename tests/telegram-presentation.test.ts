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
