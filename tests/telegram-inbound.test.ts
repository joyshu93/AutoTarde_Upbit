import assert from "node:assert/strict";

import type { TelegramInboundOffsetRecord } from "../src/domain/types.js";
import {
  splitTelegramReplyText,
  TelegramBotUpdateClient,
  TelegramInboundPollingService,
  type TelegramInboundUpdate,
} from "../src/modules/telegram/inbound.js";
import { test } from "./harness.js";

test("telegram inbound polling stays skipped when disabled or not configured", async () => {
  const routed: string[] = [];
  const sent: string[] = [];
  const service = new TelegramInboundPollingService({
    enabled: false,
    updateClient: {
      async getUpdates() {
        throw new Error("should_not_poll");
      },
    },
    messageClient: {
      async sendMessage(input) {
        sent.push(`${input.chatId}:${input.text}`);
      },
    },
    router: {
      async route(input) {
        routed.push(input);
        return { text: "unused" };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();

  assert.equal(service.isConfigured(), false);
  assert.equal(summary.status, "SKIPPED");
  assert.equal(summary.skippedReason, "telegram_inbound_not_configured");
  assert.deepEqual(routed, []);
  assert.deepEqual(sent, []);
});

test("telegram inbound polling filters unauthorized chats and advances offset", async () => {
  const getUpdateRequests: Array<{ offset: number | null; timeoutSeconds: number; limit: number }> = [];
  const routed: string[] = [];
  const sent: string[] = [];
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const updateClient = createUpdateClient(getUpdateRequests, [
    [
      createUpdate(10, "999", "/pause malicious"),
      createUpdate(11, "123", "/status"),
      createUpdate(12, "123", null),
    ],
    [
      createUpdate(13, "123", "/scheduler"),
    ],
  ]);
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient,
    messageClient: {
      async sendMessage(input) {
        sent.push(`${input.chatId}:${input.text}`);
      },
    },
    router: {
      async route(input, exchangeAccountId) {
        routed.push(`${exchangeAccountId}:${input}`);
        return { text: `handled ${input}` };
      },
    },
    operatorChatId: "123",
    exchangeAccountId: "primary",
    offsetStore: createOffsetStore({
      savedOffsets,
    }),
    botTokenRef: "sha256:bot-a",
    pollIntervalMs: 500,
    longPollTimeoutSeconds: 5,
    limit: 3,
    now: () => "2026-04-20T00:00:00.000Z",
  });

  const first = await service.pollOnce();
  const second = await service.pollOnce();

  assert.deepEqual(getUpdateRequests, [
    { offset: null, timeoutSeconds: 5, limit: 3 },
    { offset: 13, timeoutSeconds: 5, limit: 3 },
  ]);
  assert.equal(first.status, "COMPLETED");
  assert.equal(first.receivedCount, 3);
  assert.equal(first.processedCount, 1);
  assert.equal(first.ignoredCount, 2);
  assert.equal(first.nextOffset, 13);
  assert.equal(savedOffsets[0]?.nextOffset, 11);
  assert.equal(savedOffsets[1]?.nextOffset, 12);
  assert.equal(savedOffsets[2]?.nextOffset, 13);
  assert.equal(second.processedCount, 1);
  assert.equal(second.nextOffset, 14);
  assert.equal(savedOffsets[3]?.nextOffset, 14);
  assert.deepEqual(routed, ["primary:/status", "primary:/scheduler"]);
  assert.deepEqual(sent, ["123:handled /status", "123:handled /scheduler"]);
  assert.equal(service.getStatus().processedCount, 2);
  assert.equal(service.getStatus().ignoredCount, 2);
  assert.equal(service.getStatus().lastUpdateId, 13);
  assert.equal(service.getStatus().offsetStorage, "DURABLE");
});

test("telegram inbound polling splits long routed replies before sending", async () => {
  const sent: string[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createUpdate(14, "123", "/alerts"),
      ],
    ]),
    messageClient: {
      async sendMessage(input) {
        sent.push(input.text);
      },
    },
    router: {
      async route() {
        return {
          text: [
            "Operator Alerts",
            "x".repeat(3_700),
            "tail",
          ].join("\n"),
        };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.processedCount, 1);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((message) => message.length <= 3_500));
  assert.match(sent[0] ?? "", /Operator Alerts/);
  assert.match(sent[1] ?? "", /tail/);
});

test("splitTelegramReplyText prefers newline boundaries and hard-splits long lines", () => {
  assert.deepEqual(splitTelegramReplyText("short", 10), ["short"]);
  assert.deepEqual(splitTelegramReplyText("aaa\nbbb\nccc", 7), ["aaa\nbbb", "ccc"]);
  assert.deepEqual(splitTelegramReplyText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("telegram inbound polling records route or reply failures without retrying the same update", async () => {
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createUpdate(20, "123", "/status"),
      ],
    ]),
    messageClient: {
      async sendMessage() {
        throw new Error("telegram_http_500");
      },
    },
    router: {
      async route(input) {
        return { text: `handled ${input}` };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({
      savedOffsets,
    }),
    botTokenRef: "sha256:bot-a",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.nextOffset, 21);
  assert.equal(summary.errorMessage, "telegram_http_500");
  assert.equal(savedOffsets[0]?.nextOffset, 21);
  assert.equal(savedOffsets[0]?.lastUpdateId, 20);
  assert.equal(service.getStatus().failedCount, 1);
  assert.equal(service.getStatus().lastError, "telegram_http_500");
});

test("telegram inbound polling starts from a durable offset scoped by bot token ref", async () => {
  const getUpdateRequests: Array<{ offset: number | null; timeoutSeconds: number; limit: number }> = [];
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient(getUpdateRequests, [
      [
        createUpdate(50, "123", "/status"),
      ],
    ]),
    messageClient: {
      async sendMessage() {},
    },
    router: {
      async route(input) {
        return { text: `handled ${input}` };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({
      savedOffsets,
      initial: {
        id: "telegram-inbound-offset-existing",
        exchangeAccountId: "primary",
        updateSource: "GET_UPDATES",
        botTokenRef: "sha256:bot-a",
        nextOffset: 50,
        lastUpdateId: 49,
        updatedAt: "2026-04-20T00:00:00.000Z",
      },
    }),
    botTokenRef: "sha256:bot-a",
  });

  const summary = await service.pollOnce();

  assert.deepEqual(getUpdateRequests, [
    { offset: 50, timeoutSeconds: 25, limit: 20 },
  ]);
  assert.equal(summary.nextOffset, 51);
  assert.equal(savedOffsets[0]?.nextOffset, 51);
  assert.equal(service.getStatus().offsetLoaded, true);
});

test("telegram bot update client posts getUpdates payload and normalizes messages", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const client = new TelegramBotUpdateClient({
    botToken: "token-1",
    apiBaseUrl: "https://telegram.test",
    fetchImpl: (async (url, init) => {
      requests.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 30,
            message: {
              message_id: 7,
              chat: {
                id: 123,
              },
              text: "/status",
            },
          },
          {
            update_id: 31,
            edited_message: {
              message_id: 8,
            },
          },
        ],
      }), {
        status: 200,
      });
    }) as typeof fetch,
  });

  const updates = await client.getUpdates({
    offset: 30,
    timeoutSeconds: 25,
    limit: 10,
  });

  assert.equal(requests[0]?.url, "https://telegram.test/bottoken-1/getUpdates");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    offset: 30,
    timeout: 25,
    limit: 10,
    allowed_updates: ["message"],
  });
  assert.deepEqual(updates, [
    {
      updateId: 30,
      message: {
        messageId: 7,
        chatId: "123",
        text: "/status",
      },
    },
    {
      updateId: 31,
      message: null,
    },
  ]);
});

function createUpdate(
  updateId: number,
  chatId: string,
  text: string | null,
): TelegramInboundUpdate {
  return {
    updateId,
    message: {
      messageId: updateId * 10,
      chatId,
      text,
    },
  };
}

function createUpdateClient(
  requests: Array<{ offset: number | null; timeoutSeconds: number; limit: number }>,
  batches: TelegramInboundUpdate[][],
) {
  let callCount = 0;

  return {
    async getUpdates(input: {
      offset: number | null;
      timeoutSeconds: number;
      limit: number;
    }): Promise<TelegramInboundUpdate[]> {
      requests.push(input);
      const batch = batches[callCount] ?? [];
      callCount += 1;
      return batch;
    },
  };
}

function createOffsetStore(input: {
  initial?: TelegramInboundOffsetRecord;
  savedOffsets: TelegramInboundOffsetRecord[];
}) {
  let current = input.initial ?? null;

  return {
    async getTelegramInboundOffset(request: {
      exchangeAccountId: string;
      updateSource: TelegramInboundOffsetRecord["updateSource"];
      botTokenRef: string;
    }): Promise<TelegramInboundOffsetRecord | null> {
      if (
        current &&
        current.exchangeAccountId === request.exchangeAccountId &&
        current.updateSource === request.updateSource &&
        current.botTokenRef === request.botTokenRef
      ) {
        return current;
      }

      return null;
    },
    async saveTelegramInboundOffset(record: TelegramInboundOffsetRecord): Promise<void> {
      current = record;
      input.savedOffsets.push(record);
    },
  };
}
