import type {
  ClaimedOperatorNotificationRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationFailureClass,
  OperatorNotificationRecord,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository } from "../db/interfaces.js";

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_TELEGRAM_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_PENDING_DELIVERY_LIMIT = 20;
const DEFAULT_TELEGRAM_DELIVERY_MAX_ATTEMPTS = 5;
const DEFAULT_TELEGRAM_DELIVERY_BASE_BACKOFF_MS = 15_000;
const DEFAULT_TELEGRAM_DELIVERY_MAX_BACKOFF_MS = 300_000;
const MAX_DELIVERY_TEXT_LENGTH = 3_500;
const MAX_DELIVERY_ERROR_LENGTH = 240;

export interface TelegramMessageClient {
  sendMessage(input: {
    chatId: string;
    text: string;
  }): Promise<void>;
}

export interface OperatorNotificationDeliverySummary {
  attempted: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  skippedReason: string | null;
}

class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly failureClass: OperatorNotificationFailureClass,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

export class TelegramBotApiClient implements TelegramMessageClient {
  constructor(
    private readonly dependencies: {
      botToken: string;
      apiBaseUrl?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async sendMessage(input: {
    chatId: string;
    text: string;
  }): Promise<void> {
    const fetchImpl = this.dependencies.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new TelegramDeliveryError("telegram_fetch_unavailable", "RETRYABLE");
    }

    let response: Response;
    try {
      response = await fetchImpl(buildTelegramSendMessageUrl(this.dependencies), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: input.text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(
          this.dependencies.timeoutMs ?? DEFAULT_TELEGRAM_DELIVERY_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      throw classifyTelegramDeliveryError(error);
    }

    const rawBody = await response.text();
    const parsed = tryParseTelegramApiResponse(rawBody);
    if (!response.ok) {
      throw buildTelegramHttpError(response.status, parsed);
    }

    if (parsed && parsed.ok === false) {
      throw buildTelegramApiRejectionError(parsed);
    }
  }
}

export class OperatorNotificationDeliveryService {
  private readonly inFlightByExchangeAccount = new Map<string, Promise<OperatorNotificationDeliverySummary>>();

  constructor(
    private readonly dependencies: {
      repositories: Pick<
        ExecutionRepository,
        | "claimPendingOperatorNotifications"
        | "compareAndSetOperatorNotificationDeliveryStatus"
        | "listPendingOperatorNotifications"
        | "saveOperatorNotificationDeliveryAttempt"
      >;
      client: TelegramMessageClient | null;
      operatorChatId: string | null;
      now?: () => string;
      maxAttempts?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
      leaseDurationMs?: number;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.dependencies.client && this.dependencies.operatorChatId);
  }

  kick(exchangeAccountId: string, limit = DEFAULT_PENDING_DELIVERY_LIMIT): void {
    void this.deliverPending(exchangeAccountId, limit).catch(() => {
      // Delivery is best-effort and must never raise unhandled rejections into execution paths.
    });
  }

  async deliverPending(
    exchangeAccountId: string,
    limit = DEFAULT_PENDING_DELIVERY_LIMIT,
  ): Promise<OperatorNotificationDeliverySummary> {
    const inFlight = this.inFlightByExchangeAccount.get(exchangeAccountId);
    if (inFlight) {
      return inFlight;
    }

    const deliveryRun = this.runDelivery(exchangeAccountId, limit).finally(() => {
      if (this.inFlightByExchangeAccount.get(exchangeAccountId) === deliveryRun) {
        this.inFlightByExchangeAccount.delete(exchangeAccountId);
      }
    });

    this.inFlightByExchangeAccount.set(exchangeAccountId, deliveryRun);
    return deliveryRun;
  }

  private async runDelivery(
    exchangeAccountId: string,
    limit: number,
  ): Promise<OperatorNotificationDeliverySummary> {
    if (!this.isConfigured()) {
      return {
        attempted: 0,
        sent: 0,
        retryScheduled: 0,
        failed: 0,
        skippedReason: "telegram_delivery_not_configured",
      };
    }

    const claimedAt = this.now();
    const claimedNotifications = await this.dependencies.repositories.claimPendingOperatorNotifications(
      exchangeAccountId,
      {
        limit,
        dueBefore: claimedAt,
        claimedAt,
        leaseToken: createId("telegram_delivery_lease"),
        leaseExpiresAt: addMillisecondsToIso(claimedAt, this.leaseDurationMs()),
      },
    );

    let sent = 0;
    let retryScheduled = 0;
    let failed = 0;

    for (const notification of claimedNotifications) {
      const delivered = await this.deliverRecord(notification);
      if (delivered.deliveryStatus === "SENT") {
        sent += 1;
        continue;
      }

      if (delivered.deliveryStatus === "FAILED") {
        failed += 1;
        continue;
      }

      if (delivered.deliveryStatus === "PENDING" && delivered.nextAttemptAt !== null) {
        retryScheduled += 1;
      }
    }

    return {
      attempted: claimedNotifications.length,
      sent,
      retryScheduled,
      failed,
      skippedReason: null,
    };
  }

  async deliverRecord(record: ClaimedOperatorNotificationRecord): Promise<OperatorNotificationRecord> {
    if (record.deliveryStatus !== "PENDING" || !this.isConfigured()) {
      return record;
    }

    const attemptAt = this.now();
    const attemptCount = record.attemptCount;

    try {
      await this.dependencies.client?.sendMessage({
        chatId: this.dependencies.operatorChatId ?? "",
        text: formatOperatorNotificationDeliveryText(record),
      });

      const deliveredRecord: OperatorNotificationRecord = {
        ...record,
        deliveryStatus: "SENT",
        attemptCount,
        lastAttemptAt: attemptAt,
        nextAttemptAt: null,
        failureClass: null,
        deliveredAt: attemptAt,
        lastError: null,
      };
      const finalized = await this.finalizeTransition({
        id: deliveredRecord.id,
        leaseToken: record.leaseToken,
        deliveryStatus: "SENT",
        attemptCount: deliveredRecord.attemptCount,
        lastAttemptAt: deliveredRecord.lastAttemptAt ?? attemptAt,
        nextAttemptAt: null,
        failureClass: null,
        deliveredAt: deliveredRecord.deliveredAt,
        lastError: null,
      });
      await this.saveAttemptRecord({
        notificationId: record.id,
        exchangeAccountId: record.exchangeAccountId,
        attemptCount,
        leaseToken: record.leaseToken,
        attemptedAt: attemptAt,
        outcome: finalized ? "SENT" : "STALE_LEASE",
        failureClass: null,
        nextAttemptAt: null,
        deliveredAt: finalized ? attemptAt : null,
        errorMessage: finalized ? null : "stale_lease_finalize",
      });
      return finalized ? deliveredRecord : record;
    } catch (error) {
      const classifiedError = classifyTelegramDeliveryError(error);
      const shouldRetry =
        classifiedError.failureClass === "RETRYABLE" && attemptCount < this.maxAttempts();

      if (shouldRetry) {
        const nextAttemptAt = addMillisecondsToIso(
          attemptAt,
          resolveRetryDelayMs({
            attemptCount,
            retryAfterMs: classifiedError.retryAfterMs,
            baseBackoffMs: this.baseBackoffMs(),
            maxBackoffMs: this.maxBackoffMs(),
          }),
        );
        const retryRecord: OperatorNotificationRecord = {
          ...record,
          deliveryStatus: "PENDING",
          attemptCount,
          lastAttemptAt: attemptAt,
          nextAttemptAt,
          failureClass: "RETRYABLE",
          deliveredAt: null,
          lastError: classifiedError.message,
        };
        const finalized = await this.finalizeTransition({
          id: retryRecord.id,
          leaseToken: record.leaseToken,
          deliveryStatus: "PENDING",
          attemptCount: retryRecord.attemptCount,
          lastAttemptAt: retryRecord.lastAttemptAt ?? attemptAt,
          nextAttemptAt: retryRecord.nextAttemptAt,
          failureClass: retryRecord.failureClass,
          deliveredAt: null,
          lastError: retryRecord.lastError,
        });
        await this.saveAttemptRecord({
          notificationId: record.id,
          exchangeAccountId: record.exchangeAccountId,
          attemptCount,
          leaseToken: record.leaseToken,
          attemptedAt: attemptAt,
          outcome: finalized ? "RETRY_SCHEDULED" : "STALE_LEASE",
          failureClass: classifiedError.failureClass,
          nextAttemptAt: finalized ? nextAttemptAt : null,
          deliveredAt: null,
          errorMessage: classifiedError.message,
        });
        return finalized ? retryRecord : record;
      }

      const failedRecord: OperatorNotificationRecord = {
        ...record,
        deliveryStatus: "FAILED",
        attemptCount,
        lastAttemptAt: attemptAt,
        nextAttemptAt: null,
        failureClass: classifiedError.failureClass,
        deliveredAt: null,
        lastError: classifiedError.message,
      };
      const finalized = await this.finalizeTransition({
        id: failedRecord.id,
        leaseToken: record.leaseToken,
        deliveryStatus: "FAILED",
        attemptCount: failedRecord.attemptCount,
        lastAttemptAt: failedRecord.lastAttemptAt ?? attemptAt,
        nextAttemptAt: null,
        failureClass: failedRecord.failureClass,
        deliveredAt: null,
        lastError: failedRecord.lastError,
      });
      await this.saveAttemptRecord({
        notificationId: record.id,
        exchangeAccountId: record.exchangeAccountId,
        attemptCount,
        leaseToken: record.leaseToken,
        attemptedAt: attemptAt,
        outcome: finalized ? "FAILED" : "STALE_LEASE",
        failureClass: classifiedError.failureClass,
        nextAttemptAt: null,
        deliveredAt: null,
        errorMessage: classifiedError.message,
      });
      return finalized ? failedRecord : record;
    }
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private maxAttempts(): number {
    return Math.max(1, Math.trunc(this.dependencies.maxAttempts ?? DEFAULT_TELEGRAM_DELIVERY_MAX_ATTEMPTS));
  }

  private baseBackoffMs(): number {
    return Math.max(1, Math.trunc(this.dependencies.baseBackoffMs ?? DEFAULT_TELEGRAM_DELIVERY_BASE_BACKOFF_MS));
  }

  private maxBackoffMs(): number {
    return Math.max(this.baseBackoffMs(), Math.trunc(this.dependencies.maxBackoffMs ?? DEFAULT_TELEGRAM_DELIVERY_MAX_BACKOFF_MS));
  }

  private leaseDurationMs(): number {
    return Math.max(
      DEFAULT_TELEGRAM_DELIVERY_TIMEOUT_MS,
      Math.trunc(this.dependencies.leaseDurationMs ?? DEFAULT_TELEGRAM_DELIVERY_TIMEOUT_MS * 6),
    );
  }

  private async finalizeTransition(transition: {
    id: string;
    leaseToken: string;
    deliveryStatus: OperatorNotificationRecord["deliveryStatus"];
    attemptCount: number;
    lastAttemptAt: string;
    nextAttemptAt: string | null;
    failureClass: OperatorNotificationFailureClass | null;
    deliveredAt: string | null;
    lastError: string | null;
  }): Promise<boolean> {
    return this.dependencies.repositories.compareAndSetOperatorNotificationDeliveryStatus(transition);
  }

  private async saveAttemptRecord(input: {
    notificationId: string;
    exchangeAccountId: string;
    attemptCount: number;
    leaseToken: string | null;
    attemptedAt: string;
    outcome: OperatorNotificationDeliveryAttemptRecord["outcome"];
    failureClass: OperatorNotificationFailureClass | null;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
    errorMessage: string | null;
  }): Promise<void> {
    const record: OperatorNotificationDeliveryAttemptRecord = {
      id: createId("operator_notification_delivery_attempt"),
      notificationId: input.notificationId,
      exchangeAccountId: input.exchangeAccountId,
      attemptCount: input.attemptCount,
      leaseToken: input.leaseToken,
      outcome: input.outcome,
      failureClass: input.failureClass,
      attemptedAt: input.attemptedAt,
      nextAttemptAt: input.nextAttemptAt,
      deliveredAt: input.deliveredAt,
      errorMessage: input.errorMessage,
      createdAt: input.attemptedAt,
    };

    await this.dependencies.repositories.saveOperatorNotificationDeliveryAttempt(record);
  }
}

export function formatOperatorNotificationDeliveryText(
  record: Pick<OperatorNotificationRecord, "severity" | "notificationType" | "title" | "message" | "createdAt">,
): string {
  return truncateText(
    [
      `[${record.severity}] ${record.notificationType}`,
      record.title,
      record.message,
      `created_at: ${record.createdAt}`,
    ].join("\n"),
    MAX_DELIVERY_TEXT_LENGTH,
  );
}

function buildTelegramSendMessageUrl(dependencies: {
  botToken: string;
  apiBaseUrl?: string;
}): string {
  const apiBaseUrl = dependencies.apiBaseUrl?.trim() || DEFAULT_TELEGRAM_API_BASE_URL;
  return `${apiBaseUrl}/bot${dependencies.botToken}/sendMessage`;
}

function tryParseTelegramApiResponse(
  rawBody: string,
): { ok?: boolean; description?: string; parameters?: { retry_after?: number } } | null {
  try {
    return JSON.parse(rawBody) as {
      ok?: boolean;
      description?: string;
      parameters?: { retry_after?: number };
    };
  } catch {
    return null;
  }
}

function buildTelegramHttpError(
  statusCode: number,
  parsed: { description?: string; parameters?: { retry_after?: number } } | null,
): TelegramDeliveryError {
  const description = sanitizeOperatorNotificationError(parsed?.description ?? `telegram_http_${statusCode}`);
  const retryAfterSeconds = parsed?.parameters?.retry_after;
  const retryAfterMs =
    typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1_000)
      : null;

  if (statusCode === 429 || statusCode === 408 || (statusCode >= 500 && statusCode <= 599)) {
    return new TelegramDeliveryError(description, "RETRYABLE", retryAfterMs);
  }

  return new TelegramDeliveryError(description, "PERMANENT");
}

function buildTelegramApiRejectionError(
  parsed: { description?: string; parameters?: { retry_after?: number } },
): TelegramDeliveryError {
  const description = sanitizeOperatorNotificationError(
    parsed.description?.trim() || "telegram_api_rejected_message",
  );
  const retryAfterSeconds = parsed.parameters?.retry_after;

  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
    return new TelegramDeliveryError(description, "RETRYABLE", Math.max(0, retryAfterSeconds * 1_000));
  }

  return new TelegramDeliveryError(description, "PERMANENT");
}

function classifyTelegramDeliveryError(error: unknown): TelegramDeliveryError {
  if (error instanceof TelegramDeliveryError) {
    return error;
  }

  if (error instanceof Error) {
    const normalizedMessage = sanitizeOperatorNotificationError(error);
    const lowerMessage = normalizedMessage.toLowerCase();
    if (
      error.name === "AbortError" ||
      lowerMessage.includes("timeout") ||
      lowerMessage.includes("timed out") ||
      lowerMessage.includes("network") ||
      lowerMessage.includes("fetch") ||
      lowerMessage.includes("socket") ||
      lowerMessage.includes("temporarily unavailable") ||
      lowerMessage.includes("too many requests") ||
      lowerMessage.includes("telegram_http_429") ||
      lowerMessage.includes("telegram_http_500") ||
      lowerMessage.includes("telegram_http_502") ||
      lowerMessage.includes("telegram_http_503") ||
      lowerMessage.includes("telegram_http_504")
    ) {
      return new TelegramDeliveryError(normalizedMessage, "RETRYABLE");
    }

    return new TelegramDeliveryError(normalizedMessage, "PERMANENT");
  }

  return new TelegramDeliveryError(sanitizeOperatorNotificationError(String(error)), "PERMANENT");
}

function resolveRetryDelayMs(input: {
  attemptCount: number;
  retryAfterMs: number | null;
  baseBackoffMs: number;
  maxBackoffMs: number;
}): number {
  if (input.retryAfterMs !== null) {
    return clampBackoff(input.retryAfterMs, input.baseBackoffMs, input.maxBackoffMs);
  }

  const exponentialDelay = input.baseBackoffMs * 2 ** Math.max(0, input.attemptCount - 1);
  return clampBackoff(exponentialDelay, input.baseBackoffMs, input.maxBackoffMs);
}

function clampBackoff(delayMs: number, minimumMs: number, maximumMs: number): number {
  return Math.min(Math.max(Math.trunc(delayMs), minimumMs), maximumMs);
}

function addMillisecondsToIso(isoTimestamp: string, delayMs: number): string {
  return new Date(Date.parse(isoTimestamp) + delayMs).toISOString();
}

function sanitizeOperatorNotificationError(error: unknown): string {
  if (error instanceof Error) {
    return truncateText(error.message.replace(/\s+/gu, " ").trim(), MAX_DELIVERY_ERROR_LENGTH);
  }

  return truncateText(String(error), MAX_DELIVERY_ERROR_LENGTH);
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
}
