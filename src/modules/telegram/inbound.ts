import type { TelegramCommandRouter } from "./commands.js";
import type { TelegramMessageClient } from "./delivery.js";
import type { TelegramInboundOffsetStore } from "../db/interfaces.js";
import { createId } from "../../shared/ids.js";

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_TELEGRAM_INBOUND_TIMEOUT_MS = 30_000;
const DEFAULT_TELEGRAM_INBOUND_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TELEGRAM_INBOUND_LONG_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_TELEGRAM_INBOUND_LIMIT = 20;
const MAX_INBOUND_ERROR_LENGTH = 240;

export interface TelegramInboundUpdate {
  readonly updateId: number;
  readonly message: TelegramInboundMessage | null;
}

export interface TelegramInboundMessage {
  readonly messageId: number;
  readonly chatId: string;
  readonly text: string | null;
}

export interface TelegramUpdateClient {
  getUpdates(input: {
    offset: number | null;
    timeoutSeconds: number;
    limit: number;
  }): Promise<TelegramInboundUpdate[]>;
}

export interface TelegramInboundPollingStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly running: boolean;
  readonly nextOffset: number | null;
  readonly pollIntervalMs: number;
  readonly longPollTimeoutSeconds: number;
  readonly limit: number;
  readonly lastPollAt: string | null;
  readonly lastUpdateId: number | null;
  readonly offsetLoaded: boolean;
  readonly offsetStorage: "DURABLE" | "MEMORY";
  readonly processedCount: number;
  readonly ignoredCount: number;
  readonly failedCount: number;
  readonly lastError: string | null;
}

export interface TelegramInboundPollSummary {
  readonly status: "COMPLETED" | "SKIPPED" | "FAILED";
  readonly receivedCount: number;
  readonly processedCount: number;
  readonly ignoredCount: number;
  readonly failedCount: number;
  readonly nextOffset: number | null;
  readonly skippedReason: string | null;
  readonly errorMessage: string | null;
}

export class TelegramBotUpdateClient implements TelegramUpdateClient {
  constructor(
    private readonly dependencies: {
      botToken: string;
      apiBaseUrl?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async getUpdates(input: {
    offset: number | null;
    timeoutSeconds: number;
    limit: number;
  }): Promise<TelegramInboundUpdate[]> {
    const fetchImpl = this.dependencies.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("telegram_fetch_unavailable");
    }

    const response = await fetchImpl(buildTelegramGetUpdatesUrl(this.dependencies), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(input.offset === null ? {} : { offset: input.offset }),
        timeout: input.timeoutSeconds,
        limit: input.limit,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? DEFAULT_TELEGRAM_INBOUND_TIMEOUT_MS),
    });

    const rawBody = await response.text();
    const parsed = tryParseTelegramApiResponse(rawBody);
    if (!response.ok) {
      throw new Error(sanitizeTelegramInboundError(parsed?.description ?? `telegram_http_${response.status}`));
    }

    if (!parsed || parsed.ok === false || !Array.isArray(parsed.result)) {
      throw new Error(sanitizeTelegramInboundError(parsed?.description ?? "telegram_get_updates_invalid_response"));
    }

    return parsed.result
      .map(normalizeTelegramUpdate)
      .filter((update): update is TelegramInboundUpdate => update !== null);
  }
}

export class TelegramInboundPollingService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextOffset: number | null;
  private running = false;
  private lastPollAt: string | null = null;
  private lastUpdateId: number | null = null;
  private processedCount = 0;
  private ignoredCount = 0;
  private failedCount = 0;
  private lastError: string | null = null;
  private offsetLoaded = false;

  constructor(
    private readonly dependencies: {
      enabled: boolean;
      updateClient: TelegramUpdateClient | null;
      messageClient: TelegramMessageClient | null;
      router: Pick<TelegramCommandRouter, "route">;
      operatorChatId: string | null;
      exchangeAccountId?: string;
      initialOffset?: number | null;
      offsetStore?: TelegramInboundOffsetStore | null;
      botTokenRef?: string | null;
      pollIntervalMs?: number;
      longPollTimeoutSeconds?: number;
      limit?: number;
      now?: () => string;
    },
  ) {
    this.nextOffset = dependencies.initialOffset ?? null;
  }

  isConfigured(): boolean {
    return Boolean(
      this.dependencies.enabled &&
      this.dependencies.updateClient &&
      this.dependencies.messageClient &&
      this.dependencies.operatorChatId,
    );
  }

  getStatus(): TelegramInboundPollingStatus {
    return {
      enabled: this.dependencies.enabled,
      configured: this.isConfigured(),
      running: this.running,
      nextOffset: this.nextOffset,
      pollIntervalMs: this.pollIntervalMs(),
      longPollTimeoutSeconds: this.longPollTimeoutSeconds(),
      limit: this.limit(),
      lastPollAt: this.lastPollAt,
      lastUpdateId: this.lastUpdateId,
      offsetLoaded: this.offsetLoaded,
      offsetStorage: this.dependencies.offsetStore && this.dependencies.botTokenRef ? "DURABLE" : "MEMORY",
      processedCount: this.processedCount,
      ignoredCount: this.ignoredCount,
      failedCount: this.failedCount,
      lastError: this.lastError,
    };
  }

  start(): TelegramInboundPollingStatus {
    if (this.running || !this.isConfigured()) {
      return this.getStatus();
    }

    this.running = true;
    this.scheduleNextPoll(0);
    return this.getStatus();
  }

  stop(): TelegramInboundPollingStatus {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    return this.getStatus();
  }

  async pollOnce(): Promise<TelegramInboundPollSummary> {
    this.lastPollAt = this.now();

    if (!this.isConfigured()) {
      return {
        status: "SKIPPED",
        receivedCount: 0,
        processedCount: 0,
        ignoredCount: 0,
        failedCount: 0,
        nextOffset: this.nextOffset,
        skippedReason: "telegram_inbound_not_configured",
        errorMessage: null,
      };
    }

    try {
      await this.loadDurableOffsetIfNeeded();
      const updates = await this.dependencies.updateClient?.getUpdates({
        offset: this.nextOffset,
        timeoutSeconds: this.longPollTimeoutSeconds(),
        limit: this.limit(),
      }) ?? [];
      let processed = 0;
      let ignored = 0;
      let failed = 0;

      for (const update of updates) {
        await this.advanceOffset(update.updateId);

        if (!this.isOperatorMessage(update)) {
          ignored += 1;
          continue;
        }

        const text = update.message?.text?.trim();
        if (!text) {
          ignored += 1;
          continue;
        }

        try {
          const response = await this.dependencies.router.route(
            text,
            this.dependencies.exchangeAccountId ?? "primary",
          );
          await this.dependencies.messageClient?.sendMessage({
            chatId: this.dependencies.operatorChatId ?? "",
            text: response.text,
          });
          processed += 1;
        } catch (error) {
          failed += 1;
          this.lastError = sanitizeTelegramInboundError(error);
        }
      }

      this.processedCount += processed;
      this.ignoredCount += ignored;
      this.failedCount += failed;

      return {
        status: failed > 0 ? "FAILED" : "COMPLETED",
        receivedCount: updates.length,
        processedCount: processed,
        ignoredCount: ignored,
        failedCount: failed,
        nextOffset: this.nextOffset,
        skippedReason: null,
        errorMessage: failed > 0 ? this.lastError : null,
      };
    } catch (error) {
      const errorMessage = sanitizeTelegramInboundError(error);
      this.failedCount += 1;
      this.lastError = errorMessage;
      return {
        status: "FAILED",
        receivedCount: 0,
        processedCount: 0,
        ignoredCount: 0,
        failedCount: 1,
        nextOffset: this.nextOffset,
        skippedReason: null,
        errorMessage,
      };
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => {
        this.scheduleNextPoll(this.pollIntervalMs());
      });
    }, delayMs);
  }

  private isOperatorMessage(update: TelegramInboundUpdate): boolean {
    return update.message?.chatId === this.dependencies.operatorChatId;
  }

  private async loadDurableOffsetIfNeeded(): Promise<void> {
    if (this.offsetLoaded) {
      return;
    }

    this.offsetLoaded = true;
    if (!this.dependencies.offsetStore || !this.dependencies.botTokenRef) {
      return;
    }

    const record = await this.dependencies.offsetStore.getTelegramInboundOffset({
      exchangeAccountId: this.dependencies.exchangeAccountId ?? "primary",
      updateSource: "GET_UPDATES",
      botTokenRef: this.dependencies.botTokenRef,
    });
    if (!record) {
      return;
    }

    this.nextOffset = record.nextOffset;
    this.lastUpdateId = record.lastUpdateId;
  }

  private async advanceOffset(updateId: number): Promise<void> {
    this.lastUpdateId = updateId;
    const candidate = updateId + 1;
    this.nextOffset = this.nextOffset === null ? candidate : Math.max(this.nextOffset, candidate);

    if (!this.dependencies.offsetStore || !this.dependencies.botTokenRef || this.nextOffset === null) {
      return;
    }

    const updatedAt = this.now();
    await this.dependencies.offsetStore.saveTelegramInboundOffset({
      id: createId("telegram_inbound_offset"),
      exchangeAccountId: this.dependencies.exchangeAccountId ?? "primary",
      updateSource: "GET_UPDATES",
      botTokenRef: this.dependencies.botTokenRef,
      nextOffset: this.nextOffset,
      lastUpdateId: updateId,
      updatedAt,
    });
  }

  private pollIntervalMs(): number {
    return Math.max(
      1,
      Math.trunc(this.dependencies.pollIntervalMs ?? DEFAULT_TELEGRAM_INBOUND_POLL_INTERVAL_MS),
    );
  }

  private longPollTimeoutSeconds(): number {
    return Math.max(
      0,
      Math.trunc(this.dependencies.longPollTimeoutSeconds ?? DEFAULT_TELEGRAM_INBOUND_LONG_POLL_TIMEOUT_SECONDS),
    );
  }

  private limit(): number {
    return Math.max(1, Math.trunc(this.dependencies.limit ?? DEFAULT_TELEGRAM_INBOUND_LIMIT));
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }
}

function buildTelegramGetUpdatesUrl(dependencies: {
  botToken: string;
  apiBaseUrl?: string;
}): string {
  const apiBaseUrl = dependencies.apiBaseUrl?.trim() || DEFAULT_TELEGRAM_API_BASE_URL;
  return `${apiBaseUrl}/bot${dependencies.botToken}/getUpdates`;
}

function normalizeTelegramUpdate(raw: unknown): TelegramInboundUpdate | null {
  if (!raw || typeof raw !== "object" || !("update_id" in raw) || typeof raw.update_id !== "number") {
    return null;
  }

  const message = "message" in raw ? normalizeTelegramMessage(raw.message) : null;
  return {
    updateId: raw.update_id,
    message,
  };
}

function normalizeTelegramMessage(raw: unknown): TelegramInboundMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const messageId = "message_id" in raw && typeof raw.message_id === "number" ? raw.message_id : 0;
  const chatRaw = "chat" in raw && raw.chat && typeof raw.chat === "object" ? raw.chat : null;
  const chatId =
    chatRaw && "id" in chatRaw && (typeof chatRaw.id === "number" || typeof chatRaw.id === "string")
      ? String(chatRaw.id)
      : null;

  if (!chatId) {
    return null;
  }

  return {
    messageId,
    chatId,
    text: "text" in raw && typeof raw.text === "string" ? raw.text : null,
  };
}

function tryParseTelegramApiResponse(
  rawBody: string,
): { ok?: boolean; description?: string; result?: unknown[] } | null {
  try {
    return JSON.parse(rawBody) as {
      ok?: boolean;
      description?: string;
      result?: unknown[];
    };
  } catch {
    return null;
  }
}

function sanitizeTelegramInboundError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_INBOUND_ERROR_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_INBOUND_ERROR_LENGTH - 3)}...`;
}
