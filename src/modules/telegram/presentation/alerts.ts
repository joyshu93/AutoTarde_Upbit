import type {
  OperatorNotificationAttemptOutcome,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
  OperatorNotificationDeliveryRunStatus,
  OperatorNotificationRecord,
  OperatorNotificationSeverity,
  OperatorNotificationStatus,
  OperatorNotificationType,
} from "../../../domain/types.js";
import { formatTelegramTimestamp } from "./common.js";
import type { TelegramLocale } from "./locale.js";

export interface OperatorNotificationDeliveryHealth {
  pendingTotalCount: number;
  pendingDueCount: number;
  pendingScheduledCount: number;
  failedNotificationCount: number;
  activeLeaseCount: number;
  expiredLeaseCount: number;
  abandonedLeaseCandidateCount: number;
  recentStaleLeaseCount: number;
  recentSentAttemptCount: number;
  recentRetryScheduledAttemptCount: number;
  recentFailedAttemptCount: number;
}

type LocalizedLabel = {
  readonly ko: string;
  readonly en: string;
};

const DISPLAYED_NOTIFICATION_LIMIT = 3;
const DISPLAYED_DELIVERY_RUN_LIMIT = 1;
const DISPLAYED_DELIVERY_ATTEMPT_LIMIT = 1;

const NOTIFICATION_TYPE_LABELS: Readonly<Record<OperatorNotificationType, LocalizedLabel>> = {
  ORDER_REJECTED: label("주문 거부", "Order rejected"),
  ORDER_SUBMISSION_FAILED: label("주문 제출 실패", "Order submission failed"),
  RECONCILIATION_DRIFT_DETECTED: label("정합성 불일치 감지", "Reconciliation drift detected"),
  SCHEDULER_STARTUP_BLOCKED: label("스케줄러 시작 차단", "Scheduler startup blocked"),
  SCHEDULER_ORDER_REJECTED: label("스케줄 주문 거부", "Scheduled order rejected"),
  SCHEDULER_ORDER_SUBMITTED: label("스케줄 주문 제출", "Scheduled order submitted"),
  SCHEDULER_RUN_FAILED: label("스케줄 실행 실패", "Scheduled run failed"),
  SCHEDULER_RUN_SKIPPED: label("스케줄 실행 건너뜀", "Scheduled run skipped"),
  SYNC_FAILED: label("동기화 실패", "Sync failed"),
};

const SEVERITY_LABELS: Readonly<Record<OperatorNotificationSeverity, LocalizedLabel>> = {
  INFO: label("정보", "Info"),
  WARN: label("주의", "Warning"),
  ERROR: label("오류", "Error"),
};

const DELIVERY_STATUS_LABELS: Readonly<Record<OperatorNotificationStatus, LocalizedLabel>> = {
  PENDING: label("전송 대기", "Pending"),
  SENT: label("전송 완료", "Sent"),
  FAILED: label("전송 실패", "Failed"),
};

const ATTEMPT_OUTCOME_LABELS: Readonly<Record<OperatorNotificationAttemptOutcome, LocalizedLabel>> = {
  SENT: label("전송", "Sent"),
  RETRY_SCHEDULED: label("재시도 예약", "Retry scheduled"),
  FAILED: label("실패", "Failed"),
  STALE_LEASE: label("만료 임대", "Stale lease"),
};

const DELIVERY_RUN_STATUS_LABELS: Readonly<Record<OperatorNotificationDeliveryRunStatus, LocalizedLabel>> = {
  COMPLETED: label("완료", "Completed"),
  SKIPPED: label("건너뜀", "Skipped"),
  FAILED: label("실패", "Failed"),
};

export function formatOperatorNotificationsPresentation(
  notifications: readonly OperatorNotificationRecord[],
  attempts: readonly OperatorNotificationDeliveryAttemptRecord[],
  runs: readonly OperatorNotificationDeliveryRunRecord[],
  health: OperatorNotificationDeliveryHealth,
  locale: TelegramLocale,
): string {
  const sortedNotifications = sortByInstant(notifications, (record) => record.createdAt);
  const sortedAttempts = sortByInstant(attempts, (record) => record.attemptedAt);
  const sortedRuns = sortByInstant(runs, (record) => record.startedAt);
  const displayedNotifications = sortedNotifications.slice(0, DISPLAYED_NOTIFICATION_LIMIT);
  const displayedAttempts = sortedAttempts.slice(0, DISPLAYED_DELIVERY_ATTEMPT_LIMIT);
  const displayedRuns = sortedRuns.slice(0, DISPLAYED_DELIVERY_RUN_LIMIT);
  const omittedNotificationCount = sortedNotifications.length - displayedNotifications.length;
  const omittedAttemptCount = sortedAttempts.length - displayedAttempts.length;
  const omittedRunCount = sortedRuns.length - displayedRuns.length;

  if (locale === "en-US") {
    return [
      "Alert delivery health",
      "Notice: This is persisted alert and delivery evidence. Only persisted status and retry timing describe current delivery work.",
      "Recent sample: up to 10 alerts and up to 5 delivery attempts (plus up to 5 delivery runs). These are not whole-queue totals.",
      `In-sample pending ${health.pendingTotalCount} | due now ${health.pendingDueCount} | scheduled retry ${health.pendingScheduledCount} | failed alerts ${health.failedNotificationCount}`,
      `In-sample leases: active ${health.activeLeaseCount} | expired ${health.expiredLeaseCount} | abandoned candidates ${health.abandonedLeaseCandidateCount}`,
      `In-sample recent attempts: sent ${health.recentSentAttemptCount} | retry scheduled ${health.recentRetryScheduledAttemptCount} | failed ${health.recentFailedAttemptCount} | stale lease ${health.recentStaleLeaseCount}`,
      ...(displayedNotifications.length === 0
        ? ["No recent persisted operator alerts."]
        : [
            "Recent alerts:",
            ...displayedNotifications.flatMap((notification) => formatNotification(notification, locale)),
          ]),
      ...formatOmittedLine(omittedNotificationCount, "recent alert", locale),
      ...formatRunLines(displayedRuns, locale),
      ...formatOmittedLine(omittedRunCount, "delivery run", locale),
      ...formatAttemptLines(displayedAttempts, locale),
      ...formatOmittedLine(omittedAttemptCount, "delivery attempt", locale),
      "Full technical details: /alerts detail",
    ].join("\n");
  }

  return [
    "알림 전송 상태 (Operator Alerts)",
    "안내: 저장된 알림과 전송 근거입니다. 현재 전송 작업은 저장된 상태와 재시도 시각으로만 판단합니다.",
    "최근 조회 표본: 알림 최대 10건 | 전송 시도 최대 5건 | 전송 실행 최대 5건. 전체 큐 총계가 아닙니다.",
    `표본 내 대기 ${health.pendingTotalCount} | 즉시 전송 ${health.pendingDueCount} | 재시도 예정 ${health.pendingScheduledCount} | 실패 알림 ${health.failedNotificationCount}`,
    `표본 내 임대: 활성 ${health.activeLeaseCount} | 만료 ${health.expiredLeaseCount} | 회수 필요 후보 ${health.abandonedLeaseCandidateCount}`,
    `표본 내 최근 전송 시도: 전송 ${health.recentSentAttemptCount} | 재시도 예약 ${health.recentRetryScheduledAttemptCount} | 실패 ${health.recentFailedAttemptCount} | 만료 임대 ${health.recentStaleLeaseCount}`,
    ...(displayedNotifications.length === 0
      ? ["저장된 최근 운영 알림이 없습니다."]
      : [
          "최근 운영 알림:",
          ...displayedNotifications.flatMap((notification) => formatNotification(notification, locale)),
        ]),
    ...formatOmittedLine(omittedNotificationCount, "recent alert", locale),
    ...formatRunLines(displayedRuns, locale),
    ...formatOmittedLine(omittedRunCount, "delivery run", locale),
    ...formatAttemptLines(displayedAttempts, locale),
    ...formatOmittedLine(omittedAttemptCount, "delivery attempt", locale),
    "전체 기술 정보: /alerts detail",
  ].join("\n");
}

export const TELEGRAM_ALERT_PAGE_SIZE = 3;

export function sortTelegramAlertsNewestFirst(
  notifications: readonly OperatorNotificationRecord[],
): OperatorNotificationRecord[] {
  return sortByInstant(notifications, (record) => record.createdAt);
}

export function formatAlertsPagePresentation(
  sortedNotifications: readonly OperatorNotificationRecord[],
  page: number,
  locale: TelegramLocale,
): string {
  const visibleNotifications = sortedNotifications.slice(
    page * TELEGRAM_ALERT_PAGE_SIZE,
    (page + 1) * TELEGRAM_ALERT_PAGE_SIZE,
  );
  return [
    locale === "ko-KR" ? "운영 알림" : "Operator alerts",
    `${locale === "ko-KR" ? "페이지" : "Page"}: ${page + 1}`,
    `${locale === "ko-KR" ? "전체" : "Total"}: ${sortedNotifications.length}`,
    ...(visibleNotifications.length === 0
      ? [locale === "ko-KR" ? "저장된 알림이 없습니다." : "No stored alerts."]
      : visibleNotifications.flatMap((notification) => formatNotification(notification, locale))),
  ].join("\n");
}

export function formatAlertDetailPresentation(
  notification: OperatorNotificationRecord,
  locale: TelegramLocale,
): string {
  return [
    locale === "ko-KR" ? "알림 상세" : "Alert detail",
    `id: ${notification.id}`,
    ...formatNotification(notification, locale),
  ].join("\n");
}

function formatNotification(
  notification: OperatorNotificationRecord,
  locale: TelegramLocale,
): string[] {
  const timestamp = formatTimestamp(notification.createdAt, locale);
  const lines = locale === "ko-KR"
    ? [
        `- ${timestamp} | ${localized(SEVERITY_LABELS[notification.severity], locale)} | ${localized(NOTIFICATION_TYPE_LABELS[notification.notificationType], locale)} | ${localized(DELIVERY_STATUS_LABELS[notification.deliveryStatus], locale)}`,
        `  제목: ${notification.title}`,
        `  내용: ${notification.message}`,
        `  시도 횟수: ${notification.attemptCount}`,
      ]
    : [
        `- ${timestamp} | ${localized(SEVERITY_LABELS[notification.severity], locale)} | ${localized(NOTIFICATION_TYPE_LABELS[notification.notificationType], locale)} | ${localized(DELIVERY_STATUS_LABELS[notification.deliveryStatus], locale)}`,
        `  Title: ${notification.title}`,
        `  Message: ${notification.message}`,
        `  Attempts: ${notification.attemptCount}`,
      ];

  appendOptionalNotificationFields(lines, notification, locale);
  return lines;
}

function appendOptionalNotificationFields(
  lines: string[],
  notification: OperatorNotificationRecord,
  locale: TelegramLocale,
): void {
  const fields = locale === "ko-KR"
    ? {
        lastAttempt: "마지막 시도",
        nextAttempt: "다음 재시도",
        delivered: "전송 완료",
        failureClass: "실패 분류",
        error: "오류",
      }
    : {
        lastAttempt: "Last attempt",
        nextAttempt: "Next retry",
        delivered: "Delivered",
        failureClass: "Failure class",
        error: "Error",
      };

  if (notification.lastAttemptAt) {
    lines.push(`  ${fields.lastAttempt}: ${formatTimestamp(notification.lastAttemptAt, locale)}`);
  }
  if (notification.nextAttemptAt) {
    lines.push(`  ${fields.nextAttempt}: ${formatTimestamp(notification.nextAttemptAt, locale)}`);
  }
  if (notification.deliveredAt) {
    lines.push(`  ${fields.delivered}: ${formatTimestamp(notification.deliveredAt, locale)}`);
  }
  if (notification.failureClass) {
    const failureClass = notification.failureClass === "RETRYABLE"
      ? locale === "ko-KR" ? "재시도 가능" : "Retryable"
      : locale === "ko-KR" ? "영구 실패" : "Permanent";
    lines.push(`  ${fields.failureClass}: ${failureClass}`);
  }
  if (notification.lastError) {
    lines.push(`  ${fields.error}: ${notification.lastError}`);
  }
}

function formatRunLines(
  runs: readonly OperatorNotificationDeliveryRunRecord[],
  locale: TelegramLocale,
): string[] {
  if (runs.length === 0) {
    return [];
  }

  return runs.map((run) => {
    const status = localized(DELIVERY_RUN_STATUS_LABELS[run.status], locale);
    const base = locale === "ko-KR"
      ? `최근 전송 실행: ${status} | ${formatTimestamp(run.startedAt, locale)} | 시도 ${run.attemptedCount} | 전송 ${run.sentCount} | 재시도 ${run.retryScheduledCount} | 실패 ${run.failedCount}`
      : `Recent delivery run: ${status} | ${formatTimestamp(run.startedAt, locale)} | attempted ${run.attemptedCount} | sent ${run.sentCount} | retry ${run.retryScheduledCount} | failed ${run.failedCount}`;
    const detail = run.errorMessage ?? run.skippedReason;
    return detail ? `${base} | ${locale === "ko-KR" ? "근거" : "detail"}: ${detail}` : base;
  });
}

function formatAttemptLines(
  attempts: readonly OperatorNotificationDeliveryAttemptRecord[],
  locale: TelegramLocale,
): string[] {
  if (attempts.length === 0) {
    return [];
  }

  return attempts.map((attempt) => {
    const outcome = localized(ATTEMPT_OUTCOME_LABELS[attempt.outcome], locale);
    const base = locale === "ko-KR"
      ? `최근 시도 결과: ${outcome} | ${formatTimestamp(attempt.attemptedAt, locale)} | 알림 ${attempt.notificationId} | ${attempt.attemptCount}회`
      : `Recent attempt outcome: ${outcome} | ${formatTimestamp(attempt.attemptedAt, locale)} | alert ${attempt.notificationId} | attempt ${attempt.attemptCount}`;
    return attempt.errorMessage
      ? `${base} | ${locale === "ko-KR" ? "오류" : "error"}: ${attempt.errorMessage}`
      : base;
  });
}

function formatOmittedLine(
  omittedCount: number,
  recordType: "recent alert" | "delivery run" | "delivery attempt",
  locale: TelegramLocale,
): string[] {
  if (omittedCount === 0) {
    return [];
  }

  if (locale === "en-US") {
    return [`${omittedCount} ${recordType}(s) omitted. Use /alerts detail for the complete bounded sample.`];
  }

  const label = recordType === "recent alert"
    ? "최근 알림"
    : recordType === "delivery run"
      ? "전송 실행"
      : "전송 시도";
  return [`${label} ${omittedCount}건 생략. 전체 제한 표본은 /alerts detail에서 확인하세요.`];
}

function sortByInstant<T>(records: readonly T[], timestamp: (record: T) => string): T[] {
  return [...records].sort((left, right) => {
    const leftTime = parseInstant(timestamp(left));
    const rightTime = parseInstant(timestamp(right));
    if (leftTime === null && rightTime === null) {
      return 0;
    }
    if (leftTime === null) {
      return 1;
    }
    if (rightTime === null) {
      return -1;
    }
    return rightTime - leftTime;
  });
}

function formatTimestamp(value: string, locale: TelegramLocale): string {
  return parseInstant(value) === null
    ? locale === "ko-KR"
      ? `데이터 오류(잘못된 시각: ${value})`
      : `Data error (invalid timestamp: ${value})`
    : formatTelegramTimestamp(value, locale);
}

function parseInstant(value: string): number | null {
  const instant = new Date(value).getTime();
  return Number.isNaN(instant) ? null : instant;
}

function localized(value: LocalizedLabel, locale: TelegramLocale): string {
  return locale === "ko-KR" ? value.ko : value.en;
}

function label(ko: string, en: string): LocalizedLabel {
  return { ko, en };
}
