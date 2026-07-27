import type {
  StrategyDecisionAction,
  StrategySchedulerLastStatus,
  StrategySchedulerRunRecord,
  StrategySchedulerRunStatus,
  StrategySchedulerStartupPreflightCheck,
  StrategySchedulerStartupPreflightScope,
  StrategySchedulerStartupPreflightStatus,
  StrategySchedulerStatus,
} from "../../../domain/types.js";
import type { TelegramLocale } from "./locale.js";

type LocalizedLabel = {
  readonly ko: string;
  readonly en: string;
};

const DISPLAYED_RUN_LIMIT = 3;

const RUN_STATUS_LABELS: Readonly<Record<StrategySchedulerRunStatus, LocalizedLabel>> = {
  STARTED: label("시작", "Started"),
  COMPLETED: label("완료", "Completed"),
  FAILED: label("실패", "Failed"),
  SKIPPED: label("건너뜀", "Skipped"),
};

const LAST_STATUS_LABELS: Readonly<Record<StrategySchedulerLastStatus, LocalizedLabel>> = {
  NEVER_RUN: label("실행 이력 없음", "Never run"),
  COMPLETED: label("완료", "Completed"),
  FAILED: label("실패", "Failed"),
  SKIPPED: label("건너뜀", "Skipped"),
  NOT_CONNECTED: label("연결 안 됨", "Not connected"),
  ALREADY_RUNNING: label("이미 실행 중", "Already running"),
  STARTUP_BLOCKED: label("시작 차단", "Startup blocked"),
};

const PREFLIGHT_STATUS_LABELS: Readonly<
  Record<StrategySchedulerStartupPreflightStatus, LocalizedLabel>
> = {
  NOT_REQUIRED: label("불필요", "Not required"),
  PASS: label("통과", "Pass"),
  WARN: label("주의", "Warning"),
  BLOCK: label("차단", "Blocked"),
};

const PREFLIGHT_SCOPE_LABELS: Readonly<
  Record<StrategySchedulerStartupPreflightScope, LocalizedLabel>
> = {
  DISABLED: label("비활성", "Disabled"),
  DRY_RUN: label("모의 실행", "Dry run"),
  LIVE: label("실운영", "Live"),
};

const CHECK_STATUS_LABELS: Readonly<
  Record<StrategySchedulerStartupPreflightCheck["status"], LocalizedLabel>
> = {
  PASS: label("통과", "Pass"),
  WARN: label("주의", "Warning"),
  BLOCK: label("차단", "Blocked"),
};

const ACTION_LABELS: Readonly<Record<StrategyDecisionAction, LocalizedLabel>> = {
  ENTER: label("신규 진입", "Enter"),
  ADD: label("추가 매수", "Add"),
  REDUCE: label("일부 축소", "Reduce"),
  EXIT: label("전량 청산", "Exit"),
  HOLD: label("유지", "Hold"),
};

export function formatStrategySchedulerPresentation(
  runs: readonly StrategySchedulerRunRecord[],
  runtimeStatus: StrategySchedulerStatus | null,
  locale: TelegramLocale,
): string {
  const sortedRuns = sortByInstant(runs);
  const displayedRuns = sortedRuns.slice(0, DISPLAYED_RUN_LIMIT);
  const omittedCount = sortedRuns.length - displayedRuns.length;
  const counts = countRunStatuses(runs);

  return locale === "en-US"
    ? [
        "Strategy scheduler",
        "Current in-memory runtime status:",
        ...formatRuntime(runtimeStatus, locale),
        "Recent persisted history (latest sample, up to 20 runs; not current runtime state):",
        `Started ${counts.STARTED} | Completed ${counts.COMPLETED} | Failed ${counts.FAILED} | Skipped ${counts.SKIPPED}`,
        ...(displayedRuns.length === 0
          ? ["No recent persisted scheduler runs."]
          : displayedRuns.flatMap((run) => formatRun(run, locale))),
        `Displayed ${displayedRuns.length} | omitted ${omittedCount}`,
        "Full technical details: /scheduler detail",
      ].join("\n")
    : [
        "전략 스케줄러",
        "현재 메모리 상태:",
        ...formatRuntime(runtimeStatus, locale),
        "최근 저장 이력 (최대 20건의 저장 표본이며 현재 런타임 상태가 아닙니다):",
        `시작 ${counts.STARTED} | 완료 ${counts.COMPLETED} | 실패 ${counts.FAILED} | 건너뜀 ${counts.SKIPPED}`,
        ...(displayedRuns.length === 0
          ? ["최근 저장된 실행 이력이 없습니다."]
          : displayedRuns.flatMap((run) => formatRun(run, locale))),
        `표시 ${displayedRuns.length}건 | 생략 ${omittedCount}건`,
        "전체 기술 정보: /scheduler detail",
      ].join("\n");
}

function formatRuntime(
  status: StrategySchedulerStatus | null,
  locale: TelegramLocale,
): string[] {
  if (!status) {
    return locale === "en-US"
      ? ["- Runtime status is unavailable."]
      : ["- 현재 런타임 상태를 확인할 수 없습니다."];
  }

  const state = describeRuntimeState(status, locale);
  const lines = locale === "en-US"
    ? [
        `- State: ${state}`,
        `- Send-path wiring: ${status.liveSendPath} (wiring only; this does not prove orders are currently allowed)`,
      ]
    : [
        `- 상태: ${state}`,
        `- 주문 연결 경로: ${status.liveSendPath} (연결 정보일 뿐 현재 주문 허용을 뜻하지 않습니다)`,
      ];

  lines.push(...formatPreflight(status, locale));
  lines.push(
    ...(status.markets.length === 0
      ? [locale === "en-US" ? "- No configured markets." : "- 설정된 시장이 없습니다."]
      : status.markets.flatMap((market) => {
          const action = market.lastAction
            ? localize(ACTION_LABELS[market.lastAction], locale)
            : none(locale);
          const order = market.lastOrderId
            ? `/order ${market.lastOrderId}`
            : none(locale);
          const base = locale === "en-US"
            ? `- ${market.market}: every ${formatInterval(market.intervalMs, locale)} | running ${yesNo(market.running, locale)} | next ${formatTime(market.nextRunAt, locale)} | last ${localize(LAST_STATUS_LABELS[market.lastStatus], locale)} | runs ${market.runCount}, success ${market.successCount}, failed ${market.failureCount}, skipped ${market.skippedCount}`
            : `- ${market.market}: ${formatInterval(market.intervalMs, locale)}마다 | 실행 중 ${yesNo(market.running, locale)} | 다음 실행 ${formatTime(market.nextRunAt, locale)} | 최근 결과 ${localize(LAST_STATUS_LABELS[market.lastStatus], locale)} | 실행 ${market.runCount}, 성공 ${market.successCount}, 실패 ${market.failureCount}, 건너뜀 ${market.skippedCount}`;
          return [
            base,
            locale === "en-US"
              ? `  Last action ${action} | order ${order} | order status ${market.lastOrderStatus ?? none(locale)}`
              : `  최근 판단 ${action} | 주문 ${order} | 주문 상태 ${market.lastOrderStatus ?? none(locale)}`,
            ...(market.lastError
              ? [locale === "en-US" ? `  Last error: ${market.lastError}` : `  최근 오류: ${market.lastError}`]
              : []),
          ];
        })),
  );

  return lines;
}

function formatPreflight(
  status: StrategySchedulerStatus,
  locale: TelegramLocale,
): string[] {
  const preflight = status.startupPreflight;
  if (!preflight) {
    return [
      locale === "en-US"
        ? "- Startup preflight: no runtime result"
        : "- 시작 전 점검: 런타임 결과 없음",
    ];
  }

  const checkCounts = countCheckStatuses(preflight.checks);
  const lines = [
    locale === "en-US"
      ? `- Startup preflight: ${localize(PREFLIGHT_STATUS_LABELS[preflight.status], locale)} | scope ${localize(PREFLIGHT_SCOPE_LABELS[preflight.scope], locale)} | checked ${formatTime(preflight.checkedAt, locale)}`
      : `- 시작 전 점검: ${localize(PREFLIGHT_STATUS_LABELS[preflight.status], locale)} | 범위 ${localize(PREFLIGHT_SCOPE_LABELS[preflight.scope], locale)} | 확인 ${formatTime(preflight.checkedAt, locale)}`,
    locale === "en-US"
      ? `  Detail: ${preflight.detail}`
      : `  설명: ${preflight.detail}`,
    locale === "en-US"
      ? `  Checks: PASS ${checkCounts.PASS} | WARN ${checkCounts.WARN} | BLOCK ${checkCounts.BLOCK}`
      : `  점검: PASS ${checkCounts.PASS} | 주의 ${checkCounts.WARN} | 차단 ${checkCounts.BLOCK}`,
  ];

  for (const check of preflight.checks) {
    if (check.status === "PASS") {
      continue;
    }
    lines.push(
      `  - ${check.name}: ${localize(CHECK_STATUS_LABELS[check.status], locale)} | ${check.detail}`,
    );
  }
  return lines;
}

function formatRun(
  run: StrategySchedulerRunRecord,
  locale: TelegramLocale,
): string[] {
  const action = run.action ? localize(ACTION_LABELS[run.action], locale) : none(locale);
  const order = run.orderId ? `/order ${run.orderId}` : none(locale);
  const accepted = run.submissionAccepted === null
    ? none(locale)
    : yesNo(run.submissionAccepted, locale);
  const startedAt = formatTime(run.startedAt, locale);
  const completedAt = formatTime(run.completedAt, locale);

  return locale === "en-US"
    ? [
        `- ${startedAt} | ${run.market} | ${localize(RUN_STATUS_LABELS[run.status], locale)}`,
        `  Completed ${completedAt} | action ${action} | order ${order} | order status ${run.orderStatus ?? none(locale)} | accepted ${accepted}`,
        ...(run.detail ? [`  Detail: ${run.detail}`] : []),
        ...(run.errorMessage ? [`  Error: ${run.errorMessage}`] : []),
      ]
    : [
        `- ${startedAt} | ${run.market} | ${localize(RUN_STATUS_LABELS[run.status], locale)}`,
        `  완료 시각 ${completedAt} | 판단 ${action} | 주문 ${order} | 주문 상태 ${run.orderStatus ?? none(locale)} | 접수 ${accepted}`,
        ...(run.detail ? [`  설명: ${run.detail}`] : []),
        ...(run.errorMessage ? [`  오류: ${run.errorMessage}`] : []),
      ];
}

function countRunStatuses(
  runs: readonly StrategySchedulerRunRecord[],
): Record<StrategySchedulerRunStatus, number> {
  const counts: Record<StrategySchedulerRunStatus, number> = {
    STARTED: 0,
    COMPLETED: 0,
    FAILED: 0,
    SKIPPED: 0,
  };
  for (const run of runs) {
    counts[run.status] += 1;
  }
  return counts;
}

function countCheckStatuses(
  checks: readonly StrategySchedulerStartupPreflightCheck[],
): Record<StrategySchedulerStartupPreflightCheck["status"], number> {
  const counts: Record<StrategySchedulerStartupPreflightCheck["status"], number> = {
    PASS: 0,
    WARN: 0,
    BLOCK: 0,
  };
  for (const check of checks) {
    counts[check.status] += 1;
  }
  return counts;
}

function sortByInstant(
  runs: readonly StrategySchedulerRunRecord[],
): StrategySchedulerRunRecord[] {
  return [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt);
    const rightTime = Date.parse(right.startedAt);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid) {
      return rightTime - leftTime;
    }
    if (leftValid) {
      return -1;
    }
    if (rightValid) {
      return 1;
    }
    return 0;
  });
}

function describeRuntimeState(
  status: StrategySchedulerStatus,
  locale: TelegramLocale,
): string {
  if (!status.enabled) {
    return locale === "en-US" ? "disabled" : "비활성";
  }
  if (!status.started) {
    return locale === "en-US" ? "enabled but not started" : "활성화됐지만 시작되지 않음";
  }
  return locale === "en-US" ? "started" : "실행 중";
}

function formatInterval(value: number, locale: TelegramLocale): string {
  if (value % 3_600_000 === 0) {
    const hours = value / 3_600_000;
    return locale === "en-US"
      ? `${hours} hour${hours === 1 ? "" : "s"}`
      : `${hours}시간`;
  }
  if (value % 60_000 === 0) {
    const minutes = value / 60_000;
    return locale === "en-US"
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : `${minutes}분`;
  }
  return locale === "en-US" ? `${value} ms` : `${value}ms`;
}

function formatTime(value: string | null, locale: TelegramLocale): string {
  if (value === null) {
    return none(locale);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return locale === "en-US" ? `invalid timestamp (${value})` : `잘못된 시각 (${value})`;
  }
  const instant = new Date(timestamp + 9 * 60 * 60 * 1_000);
  const date = [
    instant.getUTCFullYear(),
    String(instant.getUTCMonth() + 1).padStart(2, "0"),
    String(instant.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const time = [
    String(instant.getUTCHours()).padStart(2, "0"),
    String(instant.getUTCMinutes()).padStart(2, "0"),
    String(instant.getUTCSeconds()).padStart(2, "0"),
  ].join(":");
  return `${date} ${time} KST`;
}

function yesNo(value: boolean, locale: TelegramLocale): string {
  if (locale === "en-US") {
    return value ? "yes" : "no";
  }
  return value ? "예" : "아니요";
}

function none(locale: TelegramLocale): string {
  return locale === "en-US" ? "none" : "없음";
}

function label(ko: string, en: string): LocalizedLabel {
  return { ko, en };
}

function localize(value: LocalizedLabel, locale: TelegramLocale): string {
  return locale === "en-US" ? value.en : value.ko;
}
