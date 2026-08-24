import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { OperatorNotificationRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import {
  OperatorNotificationDeliveryService,
  TelegramBotApiClient,
  type TelegramMessageEditClient,
} from "../src/modules/telegram/delivery.js";
import { TelegramCommandMenuSetupService } from "../src/modules/telegram/setup.js";
import { DurableTelegramReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

test("telegram bot api client sends typed HTML messages and returns Telegram message ids", async () => {
  const requests: Array<{
    input: RequestInfo | URL;
    init: RequestInit | undefined;
  }> = [];
  const client = new TelegramBotApiClient({
    botToken: "token-1",
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const typedClient = client as unknown as {
    sendMessage(input: {
      chatId: string;
      text: string;
      parseMode?: "HTML";
      replyMarkup?: {
        inlineKeyboard: readonly (readonly {
          text: string;
          callbackData: string;
        }[])[];
      };
    }): Promise<{ messageId: number }>;
  };
  const result = await typedClient.sendMessage({
    chatId: "chat-1",
    text: "<b>hello operator</b>",
    parseMode: "HTML",
    replyMarkup: {
      inlineKeyboard: [[
        {
          text: "Status",
          callbackData: "status",
        },
      ]],
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input), "https://api.telegram.org/bottoken-1/sendMessage");
  assert.equal(requests[0]?.init?.method, "POST");
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  assert.equal(body.chat_id, "chat-1");
  assert.equal(body.text, "<b>hello operator</b>");
  assert.equal(body.parse_mode, "HTML");
  assert.deepEqual(body.reply_markup, {
    inline_keyboard: [[
      {
        text: "Status",
        callback_data: "status",
      },
    ]],
  });
  assert.deepEqual(result, { messageId: 1 });
});

test("telegram bot api client edits messages with typed markup and disabled previews", async () => {
  const requests: Array<{
    input: RequestInfo | URL;
    init: RequestInit | undefined;
  }> = [];
  const client = new TelegramBotApiClient({
    botToken: "token-1",
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const editClient: TelegramMessageEditClient = client;
  await editClient.editMessageText({
    chatId: "chat-1",
    messageId: 42,
    text: "<b>Status</b>",
    parseMode: "HTML",
    replyMarkup: {
      inlineKeyboard: [[
        {
          text: "Refresh",
          callbackData: "status:refresh",
        },
      ]],
    },
  });

  assert.equal(String(requests[0]?.input), "https://api.telegram.org/bottoken-1/editMessageText");
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  assert.deepEqual(body, {
    chat_id: "chat-1",
    message_id: 42,
    text: "<b>Status</b>",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        {
          text: "Refresh",
          callback_data: "status:refresh",
        },
      ]],
    },
    disable_web_page_preview: true,
  });
});

test("telegram bot api client acknowledges callbacks without navigation side effects", async () => {
  const requests: Array<{
    input: RequestInfo | URL;
    init: RequestInit | undefined;
  }> = [];
  const client = new TelegramBotApiClient({
    botToken: "token-1",
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const typedClient = client as unknown as {
    answerCallbackQuery(input: {
      callbackQueryId: string;
      text?: string;
    }): Promise<void>;
  };
  await typedClient.answerCallbackQuery({
    callbackQueryId: "callback-1",
    text: "요청을 처리할 수 없습니다.",
  });

  assert.equal(String(requests[0]?.input), "https://api.telegram.org/bottoken-1/answerCallbackQuery");
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  assert.deepEqual(body, {
    callback_query_id: "callback-1",
    text: "요청을 처리할 수 없습니다.",
  });
});

test("telegram command-menu setup registers Korean fallback and English operator-chat menus", async () => {
  const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
  const setupService = new TelegramCommandMenuSetupService({
    client: new TelegramBotApiClient({
      botToken: "token-1",
      fetchImpl: async (input, init) => {
        requests.push({ input, init });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      },
    }),
    operatorChatId: "operator-chat-1",
  });

  const result = await setupService.setup();

  assert.deepEqual(result, {
    configured: true,
    attempted: true,
    status: "COMPLETED",
    failureCode: null,
    korean: "COMPLETED",
    english: "COMPLETED",
  });
  assert.equal(requests.length, 2);
  assert.equal(String(requests[0]?.input), "https://api.telegram.org/bottoken-1/setMyCommands");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    commands: expectedKoreanCommandMenu(),
    scope: { type: "chat", chat_id: "operator-chat-1" },
  });
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    commands: expectedEnglishCommandMenu(),
    scope: { type: "chat", chat_id: "operator-chat-1" },
    language_code: "en",
  });
});

test("telegram command-menu setup repeats the same replacement requests without other side effects", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const setupService = new TelegramCommandMenuSetupService({
    client: {
      async setMyCommands(input) {
        requests.push(JSON.parse(JSON.stringify(input)) as Record<string, unknown>);
      },
    },
    operatorChatId: "operator-chat-1",
  });

  const first = await setupService.setup();
  const second = await setupService.setup();

  assert.deepEqual(first, second);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0], requests[2]);
  assert.deepEqual(requests[1], requests[3]);
});

test("telegram command-menu setup skips without configuration and never calls the transport", async () => {
  let calls = 0;
  const setupService = new TelegramCommandMenuSetupService({
    client: {
      async setMyCommands() {
        calls += 1;
      },
    },
    operatorChatId: null,
  });

  const result = await setupService.setup();

  assert.deepEqual(result, {
    configured: false,
    attempted: false,
    status: "SKIPPED",
    failureCode: "telegram_command_menu_not_configured",
    korean: "NOT_ATTEMPTED",
    english: "NOT_ATTEMPTED",
  });
  assert.equal(calls, 0);
});

test("telegram command-menu setup captures first and second registration failures without leaking secrets", async () => {
  const token = "token-that-must-not-leak";
  const tokenBearingUrl = `https://api.telegram.org/bot${token}/setMyCommands`;
  const firstFailure = new TelegramCommandMenuSetupService({
    client: new TelegramBotApiClient({
      botToken: token,
      fetchImpl: async () => {
        throw new Error(`transport secret ${token}`);
      },
    }),
    operatorChatId: "operator-chat-1",
  });
  let secondRequest = 0;
  const secondFailure = new TelegramCommandMenuSetupService({
    client: new TelegramBotApiClient({
      botToken: token,
      fetchImpl: async () => {
        secondRequest += 1;
        return new Response(
          secondRequest === 1
            ? JSON.stringify({ ok: true, result: true })
            : "malformed-response",
          { status: 200 },
        );
      },
    }),
    operatorChatId: "operator-chat-1",
  });

  const firstResult = await firstFailure.setup();
  const secondResult = await secondFailure.setup();

  assert.deepEqual(firstResult, {
    configured: true,
    attempted: true,
    status: "FAILED",
    failureCode: "telegram_command_menu_korean_failed",
    korean: "FAILED",
    english: "NOT_ATTEMPTED",
  });
  assert.deepEqual(secondResult, {
    configured: true,
    attempted: true,
    status: "FAILED",
    failureCode: "telegram_command_menu_english_failed",
    korean: "COMPLETED",
    english: "FAILED",
  });
  for (const result of [firstResult, secondResult]) {
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(tokenBearingUrl), false);
    assert.equal(serialized.includes("transport secret"), false);
  }
});

test("telegram bot api client rejects non-OK and preserves HTTP 200 Telegram rejection metadata", async () => {
  const nonOkClient = new TelegramBotApiClient({
    botToken: "token-1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: invalid message" }), {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      }),
  }) as unknown as {
    editMessageText(input: {
      chatId: string;
      messageId: number;
      text: string;
    }): Promise<void>;
  };
  const rejectedClient = new TelegramBotApiClient({
    botToken: "token-1",
    fetchImpl: async () =>
      new Response(JSON.stringify({
        ok: false,
        description: "Too Many Requests: retry later",
        parameters: {
          retry_after: 3,
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
  }) as unknown as {
    answerCallbackQuery(input: {
      callbackQueryId: string;
    }): Promise<void>;
  };

  await assert.rejects(
    nonOkClient.editMessageText({
      chatId: "chat-1",
      messageId: 1,
      text: "status",
    }),
    /Bad Request: invalid message/,
  );
  await assert.rejects(
    rejectedClient.answerCallbackQuery({
      callbackQueryId: "callback-1",
    }),
    isRetryableTelegramApiError,
  );
});

test("telegram bot api client rejects malformed JSON success responses across all transport methods", async () => {
  const client = createTelegramClientWithResponse("not-json");

  await assertTelegramMethodsRejectInvalidSuccessEnvelope(client);
});

test("telegram bot api client rejects success responses missing ok across all transport methods", async () => {
  const client = createTelegramClientWithResponse(JSON.stringify({
    result: {
      message_id: 1,
    },
  }));

  await assertTelegramMethodsRejectInvalidSuccessEnvelope(client);
});

for (const invalidMessageId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`telegram bot api client rejects invalid sendMessage message_id ${invalidMessageId}`, async () => {
    const client = createTelegramClientWithResponse(JSON.stringify({
      ok: true,
      result: {
        message_id: invalidMessageId,
      },
    }));

    await assert.rejects(
      client.sendMessage({
        chatId: "chat-1",
        text: "status",
      }),
      /telegram_send_message_invalid_response/,
    );
  });
}

test("delivery service marks pending notifications as sent after successful Telegram delivery in oldest-first order", async () => {
  const repositories = new InMemoryExecutionRepository();
  const sentMessages: Array<{ chatId: string; text: string }> = [];

  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-1",
    title: "Order rejected before submission",
    message: "Exchange order chance does not allow price orders for bid on KRW-BTC.",
    payloadJson: JSON.stringify({ market: "KRW-BTC" }),
    createdAt: "2026-04-20T00:21:00.000Z",
  }));
  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-2",
    notificationType: "SYNC_FAILED",
    severity: "ERROR",
    title: "Sync failed",
    message: "Failed to read balances from Upbit.",
    payloadJson: JSON.stringify({ stage: "getBalances" }),
    createdAt: "2026-04-20T00:22:00.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: {
      async sendMessage(input) {
        sentMessages.push(input);
      },
    },
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:21:05.000Z",
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const notifications = await repositories.listOperatorNotifications("primary");
  const attempts = await repositories.listOperatorNotificationDeliveryAttempts("primary");
  const runs = await repositories.listOperatorNotificationDeliveryRuns("primary");
  const pendingNotifications = await repositories.listPendingOperatorNotifications("primary");
  const firstAttempt = attempts.find((attempt) => attempt.notificationId === "operator-notification-1");

  assert.deepEqual(summary, {
    attempted: 2,
    sent: 2,
    retryScheduled: 0,
    failed: 0,
    staleLease: 0,
    pendingTotal: 0,
    pendingDue: 0,
    pendingScheduled: 0,
    activeLease: 0,
    expiredLease: 0,
    abandonedLeaseCandidate: 0,
    skippedReason: null,
  });
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0]?.chatId, "chat-1");
  assert.match(sentMessages[0]?.text ?? "", /\[WARN\] ORDER_REJECTED/);
  assert.match(sentMessages[1]?.text ?? "", /\[ERROR\] SYNC_FAILED/);
  assert.equal(notifications[0]?.deliveryStatus, "SENT");
  assert.equal(notifications[0]?.attemptCount, 1);
  assert.equal(notifications[0]?.lastAttemptAt, "2026-04-20T00:21:05.000Z");
  assert.equal(notifications[0]?.nextAttemptAt, null);
  assert.equal(notifications[0]?.failureClass, null);
  assert.equal(notifications[0]?.leaseToken, null);
  assert.equal(notifications[0]?.leaseExpiresAt, null);
  assert.equal(notifications[0]?.deliveredAt, "2026-04-20T00:21:05.000Z");
  assert.equal(notifications[0]?.lastError, null);
  assert.equal(attempts.length, 2);
  assert.equal(firstAttempt?.outcome, "SENT");
  assert.equal(firstAttempt?.attemptCount, 1);
  assert.equal(firstAttempt?.deliveredAt, "2026-04-20T00:21:05.000Z");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "COMPLETED");
  assert.equal(runs[0]?.attemptedCount, 2);
  assert.equal(runs[0]?.sentCount, 2);
  assert.equal(runs[0]?.skippedReason, null);
  assert.equal(pendingNotifications.length, 0);
});

test("delivery sends default Korean candidate-pilot push text instead of raw English notification text", async () => {
  const repositories = new InMemoryExecutionRepository();
  const sentMessages: string[] = [];
  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-pilot-korean",
    notificationType: "POSITION_GUARD_PILOT_ROLLBACK_STARTED",
    severity: "WARN",
    title: "Candidate pilot rollback started",
    message: "The candidate pilot entered DRAINING.",
    payloadJson: JSON.stringify({
      deploymentId: "deployment-pilot-1",
      phase: "DRAINING",
      stateVersion: 5,
    }),
    createdAt: "2026-08-21T03:30:00.000Z",
  }));
  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: {
      async sendMessage(input) {
        sentMessages.push(input.text);
      },
    },
    operatorChatId: "chat-1",
    now: () => "2026-08-21T03:31:00.000Z",
  });

  await deliveryService.deliverPending("primary", 1);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0] ?? "", /BTC 후보 파일럿 롤백 시작/u);
  assert.match(sentMessages[0] ?? "", /알림 코드: POSITION_GUARD_PILOT_ROLLBACK_STARTED/u);
  assert.match(sentMessages[0] ?? "", /배포 ID: deployment-pilot-1/u);
  assert.match(sentMessages[0] ?? "", /현재 단계: DRAINING/u);
  assert.doesNotMatch(sentMessages[0] ?? "", /Candidate pilot rollback started/u);
  assert.doesNotMatch(sentMessages[0] ?? "", /The candidate pilot entered DRAINING/u);
});

test("delivery honors en-US for candidate-pilot push text and preserves technical identifiers", async () => {
  const repositories = new InMemoryExecutionRepository();
  const sentMessages: string[] = [];
  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-pilot-english",
    notificationType: "POSITION_GUARD_PILOT_FAULT_PAUSED",
    severity: "ERROR",
    title: "Raw title must not be delivered",
    message: "Raw message must not be delivered",
    payloadJson: JSON.stringify({
      deploymentId: "deployment-pilot-2",
      phase: "PAUSED_FAULT",
      reasonCode: "UNCERTAIN_ORDER",
      faultId: "fault-pilot-2",
    }),
    createdAt: "2026-08-21T03:30:00.000Z",
  }));
  const dependencies = {
    repositories,
    client: {
      async sendMessage(input: { text: string }) {
        sentMessages.push(input.text);
      },
    },
    operatorChatId: "chat-1",
    locale: "en-US" as const,
    now: () => "2026-08-21T03:31:00.000Z",
  };
  const deliveryService = new OperatorNotificationDeliveryService(
    dependencies as unknown as ConstructorParameters<typeof OperatorNotificationDeliveryService>[0],
  );

  await deliveryService.deliverPending("primary", 1);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0] ?? "", /BTC candidate pilot fault paused/u);
  assert.match(sentMessages[0] ?? "", /Notification code: POSITION_GUARD_PILOT_FAULT_PAUSED/u);
  assert.match(sentMessages[0] ?? "", /Deployment ID: deployment-pilot-2/u);
  assert.match(sentMessages[0] ?? "", /Fault ID: fault-pilot-2/u);
  assert.doesNotMatch(sentMessages[0] ?? "", /Raw title must not be delivered/u);
  assert.doesNotMatch(sentMessages[0] ?? "", /Raw message must not be delivered/u);
});

test("delivery service runs a follow-up pass when kicked during an in-flight run", async () => {
  const repositories = new InMemoryExecutionRepository();
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  let deliveryService: OperatorNotificationDeliveryService;

  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-follow-up-1",
    title: "First notification",
    message: "First notification is already claimed by the active delivery run.",
    createdAt: "2026-04-20T00:21:00.000Z",
  }));

  deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: {
      async sendMessage(input) {
        sentMessages.push(input);
        if (sentMessages.length === 1) {
          await repositories.saveOperatorNotification(createNotification({
            id: "operator-notification-follow-up-2",
            title: "Second notification",
            message: "Second notification arrived while delivery was in flight.",
            createdAt: "2026-04-20T00:21:01.000Z",
          }));
          deliveryService.kick("primary", 10);
        }
      },
    },
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:21:05.000Z",
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const pendingNotifications = await repositories.listPendingOperatorNotifications("primary");
  const runs = await repositories.listOperatorNotificationDeliveryRuns("primary");

  assert.equal(summary.attempted, 2);
  assert.equal(summary.sent, 2);
  assert.equal(sentMessages.length, 2);
  assert.equal(pendingNotifications.length, 0);
  assert.equal(runs.length, 2);
});

test("delivery service reschedules retryable Telegram delivery errors with exponential backoff", async () => {
  const repositories = new InMemoryExecutionRepository();

  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-3",
    notificationType: "SYNC_FAILED",
    severity: "ERROR",
    title: "Sync failed",
    message: "Failed to read balances from Upbit.",
    payloadJson: JSON.stringify({ stage: "getBalances" }),
    createdAt: "2026-04-20T00:22:00.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: {
      async sendMessage() {
        throw new Error("telegram_http_500");
      },
    },
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:22:05.000Z",
    baseBackoffMs: 30_000,
    maxBackoffMs: 120_000,
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const notifications = await repositories.listOperatorNotifications("primary");
  const runs = await repositories.listOperatorNotificationDeliveryRuns("primary");
  const attempts = await repositories.listOperatorNotificationDeliveryAttempts("primary");

  assert.deepEqual(summary, {
    attempted: 1,
    sent: 0,
    retryScheduled: 1,
    failed: 0,
    staleLease: 0,
    pendingTotal: 1,
    pendingDue: 0,
    pendingScheduled: 1,
    activeLease: 0,
    expiredLease: 0,
    abandonedLeaseCandidate: 0,
    skippedReason: null,
  });
  assert.equal(notifications[0]?.deliveryStatus, "PENDING");
  assert.equal(notifications[0]?.attemptCount, 1);
  assert.equal(notifications[0]?.lastAttemptAt, "2026-04-20T00:22:05.000Z");
  assert.equal(notifications[0]?.nextAttemptAt, "2026-04-20T00:22:35.000Z");
  assert.equal(notifications[0]?.failureClass, "RETRYABLE");
  assert.equal(notifications[0]?.deliveredAt, null);
  assert.equal(notifications[0]?.lastError, "telegram_http_500");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.outcome, "RETRY_SCHEDULED");
  assert.equal(attempts[0]?.failureClass, "RETRYABLE");
  assert.equal(attempts[0]?.nextAttemptAt, "2026-04-20T00:22:35.000Z");
});

test("delivery service marks permanent Telegram delivery errors as failed", async () => {
  const repositories = new InMemoryExecutionRepository();

  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-3b",
    notificationType: "SYNC_FAILED",
    severity: "ERROR",
    title: "Sync failed",
    message: "Failed to read balances from Upbit.",
    payloadJson: JSON.stringify({ stage: "getBalances" }),
    createdAt: "2026-04-20T00:22:10.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: {
      async sendMessage() {
        throw new Error("telegram_http_403");
      },
    },
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:22:15.000Z",
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const notifications = await repositories.listOperatorNotifications("primary");
  const attempts = await repositories.listOperatorNotificationDeliveryAttempts("primary");

  assert.deepEqual(summary, {
    attempted: 1,
    sent: 0,
    retryScheduled: 0,
    failed: 1,
    staleLease: 0,
    pendingTotal: 0,
    pendingDue: 0,
    pendingScheduled: 0,
    activeLease: 0,
    expiredLease: 0,
    abandonedLeaseCandidate: 0,
    skippedReason: null,
  });
  assert.equal(notifications[0]?.deliveryStatus, "FAILED");
  assert.equal(notifications[0]?.attemptCount, 1);
  assert.equal(notifications[0]?.failureClass, "PERMANENT");
  assert.equal(notifications[0]?.nextAttemptAt, null);
  assert.equal(notifications[0]?.lastError, "telegram_http_403");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.outcome, "FAILED");
  assert.equal(attempts[0]?.failureClass, "PERMANENT");
});

test("delivery service honors Telegram retry_after when rate limited", async () => {
  const repositories = new InMemoryExecutionRepository();

  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-3c",
    notificationType: "SYNC_FAILED",
    severity: "ERROR",
    title: "Sync failed",
    message: "Failed to read balances from Upbit.",
    payloadJson: JSON.stringify({ stage: "getBalances" }),
    createdAt: "2026-04-20T00:22:20.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: new TelegramBotApiClient({
      botToken: "token-1",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests: retry later",
            parameters: {
              retry_after: 120,
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    }),
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:22:25.000Z",
    baseBackoffMs: 15_000,
    maxBackoffMs: 300_000,
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const notifications = await repositories.listOperatorNotifications("primary");
  const dueNow = await repositories.listPendingOperatorNotifications("primary", {
    dueBefore: "2026-04-20T00:23:00.000Z",
    limit: 10,
  });
  const dueLater = await repositories.listPendingOperatorNotifications("primary", {
    dueBefore: "2026-04-20T00:24:30.000Z",
    limit: 10,
  });

  assert.deepEqual(summary, {
    attempted: 1,
    sent: 0,
    retryScheduled: 1,
    failed: 0,
    staleLease: 0,
    pendingTotal: 1,
    pendingDue: 0,
    pendingScheduled: 1,
    activeLease: 0,
    expiredLease: 0,
    abandonedLeaseCandidate: 0,
    skippedReason: null,
  });
  assert.equal(notifications[0]?.nextAttemptAt, "2026-04-20T00:24:25.000Z");
  assert.equal(dueNow.length, 0);
  assert.equal(dueLater.length, 1);
});

test("delivery service leaves notifications pending when Telegram delivery is not configured", async () => {
  const repositories = new InMemoryExecutionRepository();

  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-4",
    notificationType: "RECONCILIATION_DRIFT_DETECTED",
    title: "Reconciliation drift detected",
    message: "Detected 2 reconciliation issue(s).",
    payloadJson: JSON.stringify({ issueCount: 2 }),
    createdAt: "2026-04-20T00:23:00.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: null,
    operatorChatId: null,
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const notifications = await repositories.listOperatorNotifications("primary");
  const runs = await repositories.listOperatorNotificationDeliveryRuns("primary");

  assert.deepEqual(summary, {
    attempted: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    staleLease: 0,
    pendingTotal: 0,
    pendingDue: 0,
    pendingScheduled: 0,
    activeLease: 0,
    expiredLease: 0,
    abandonedLeaseCandidate: 0,
    skippedReason: "telegram_delivery_not_configured",
  });
  assert.equal(notifications[0]?.deliveryStatus, "PENDING");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "SKIPPED");
  assert.equal(runs[0]?.skippedReason, "telegram_delivery_not_configured");
});

test("delivery service avoids double-claiming notifications while an active lease exists", async () => {
  const repositories = new InMemoryExecutionRepository();
  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-lease-1",
    createdAt: "2026-04-20T00:25:00.000Z",
  }));

  const firstClaim = await repositories.claimPendingOperatorNotifications("primary", {
    limit: 10,
    dueBefore: "2026-04-20T00:25:05.000Z",
    claimedAt: "2026-04-20T00:25:05.000Z",
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-04-20T00:25:35.000Z",
  });
  const secondClaim = await repositories.claimPendingOperatorNotifications("primary", {
    limit: 10,
    dueBefore: "2026-04-20T00:25:06.000Z",
    claimedAt: "2026-04-20T00:25:06.000Z",
    leaseToken: "lease-2",
    leaseExpiresAt: "2026-04-20T00:25:36.000Z",
  });

  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0]?.leaseToken, "lease-1");
  assert.equal(secondClaim.length, 0);
});

test("delivery service ignores stale finalize after a lease mismatch", async () => {
  const repositories = new InMemoryExecutionRepository();
  const claimedNotifications = await (async () => {
    await repositories.saveOperatorNotification(createNotification({
      id: "operator-notification-lease-2",
      createdAt: "2026-04-20T00:25:10.000Z",
    }));
    return repositories.claimPendingOperatorNotifications("primary", {
      limit: 1,
      dueBefore: "2026-04-20T00:25:11.000Z",
      claimedAt: "2026-04-20T00:25:11.000Z",
      leaseToken: "lease-correct",
      leaseExpiresAt: "2026-04-20T00:25:41.000Z",
    });
  })();

  assert.equal(
    await repositories.compareAndSetOperatorNotificationDeliveryStatus({
      id: "operator-notification-lease-2",
      leaseToken: "lease-stale",
      deliveryStatus: "FAILED",
      attemptCount: 1,
      lastAttemptAt: "2026-04-20T00:25:12.000Z",
      nextAttemptAt: null,
      failureClass: "PERMANENT",
      deliveredAt: null,
      lastError: "telegram_http_403",
    }),
    false,
  );

  assert.equal(claimedNotifications[0]?.leaseToken, "lease-correct");
});

test("delivery service records stale lease outcomes in delivery attempt history", async () => {
  const baseRepository = new InMemoryExecutionRepository();
  await baseRepository.saveOperatorNotification(createNotification({
    id: "operator-notification-stale-1",
    createdAt: "2026-04-20T00:25:20.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories: {
      claimPendingOperatorNotifications:
        baseRepository.claimPendingOperatorNotifications.bind(baseRepository),
      listOperatorNotifications:
        baseRepository.listOperatorNotifications.bind(baseRepository),
      listPendingOperatorNotifications:
        baseRepository.listPendingOperatorNotifications.bind(baseRepository),
      saveOperatorNotificationDeliveryAttempt:
        baseRepository.saveOperatorNotificationDeliveryAttempt.bind(baseRepository),
      saveOperatorNotificationDeliveryRun:
        baseRepository.saveOperatorNotificationDeliveryRun.bind(baseRepository),
      async compareAndSetOperatorNotificationDeliveryStatus() {
        return false;
      },
    },
    client: {
      async sendMessage() {},
    },
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:25:25.000Z",
  });

  const summary = await deliveryService.deliverPending("primary", 10);
  const notifications = await baseRepository.listOperatorNotifications("primary");
  const attempts = await baseRepository.listOperatorNotificationDeliveryAttempts("primary");
  const runs = await baseRepository.listOperatorNotificationDeliveryRuns("primary");

  assert.deepEqual(summary, {
    attempted: 1,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    staleLease: 1,
    pendingTotal: 1,
    pendingDue: 0,
    pendingScheduled: 0,
    activeLease: 1,
    expiredLease: 0,
    abandonedLeaseCandidate: 0,
    skippedReason: null,
  });
  assert.equal(notifications[0]?.deliveryStatus, "PENDING");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.outcome, "STALE_LEASE");
  assert.equal(attempts[0]?.errorMessage, "stale_lease_finalize");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "COMPLETED");
  assert.equal(runs[0]?.staleLeaseCount, 1);
});

test("delivery service reports expired abandoned lease candidates in queue metrics", async () => {
  const repositories = new InMemoryExecutionRepository();
  await repositories.saveOperatorNotification(createNotification({
    id: "operator-notification-abandoned-lease-1",
    createdAt: "2026-04-20T00:25:00.000Z",
    attemptCount: 1,
    lastAttemptAt: "2026-04-20T00:25:05.000Z",
    nextAttemptAt: "2026-04-20T00:30:00.000Z",
    leaseToken: "lease-expired",
    leaseExpiresAt: "2026-04-20T00:25:35.000Z",
  }));

  const deliveryService = new OperatorNotificationDeliveryService({
    repositories,
    client: {
      async sendMessage() {
        throw new Error("should not claim scheduled notification");
      },
    },
    operatorChatId: "chat-1",
    now: () => "2026-04-20T00:26:00.000Z",
  });

  const summary = await deliveryService.deliverPending("primary", 10);

  assert.deepEqual(summary, {
    attempted: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    staleLease: 0,
    pendingTotal: 1,
    pendingDue: 0,
    pendingScheduled: 1,
    activeLease: 0,
    expiredLease: 1,
    abandonedLeaseCandidate: 1,
    skippedReason: null,
  });
});

test("durable reporter queues notifications and kicks the delivery service without awaiting transport", async () => {
  const repositories = new InMemoryExecutionRepository();
  const kickedExchangeAccounts: string[] = [];
  const reporter = new DurableTelegramReporter({
    repositories,
    deliveryService: {
      kick(exchangeAccountId) {
        kickedExchangeAccounts.push(exchangeAccountId);
      },
    },
    now: () => "2026-04-20T00:24:00.000Z",
  });

  await reporter.report({
    exchangeAccountId: "primary",
    notificationType: "ORDER_SUBMISSION_FAILED",
    severity: "ERROR",
    title: "Order submission failed",
    message: "Exchange adapter threw after order persistence.",
    payload: {
      orderId: "order-1",
    },
  });

  const notifications = await repositories.listOperatorNotifications("primary");

  assert.deepEqual(kickedExchangeAccounts, ["primary"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.deliveryStatus, "PENDING");
  assert.equal(notifications[0]?.attemptCount, 0);
  assert.equal(notifications[0]?.lastAttemptAt, null);
  assert.equal(notifications[0]?.nextAttemptAt, null);
  assert.equal(notifications[0]?.failureClass, null);
  assert.equal(notifications[0]?.deliveredAt, null);
});

test("durable reporter persists a deterministic pilot notification once and re-kicks its pending retry", async () => {
  const repositories = new InMemoryExecutionRepository();
  const kickedExchangeAccounts: string[] = [];
  const reporter = new DurableTelegramReporter({
    repositories,
    deliveryService: {
      kick(exchangeAccountId) {
        kickedExchangeAccounts.push(exchangeAccountId);
      },
    },
    now: () => "2026-08-21T00:01:00.000Z",
  });
  const notification = {
    notificationId: "operator_notification:position_guard_pilot_rollback_started:deployment-1:1",
    exchangeAccountId: "primary",
    notificationType: "POSITION_GUARD_PILOT_ROLLBACK_STARTED" as const,
    severity: "WARN" as const,
    title: "Candidate pilot rollback started",
    message: "The candidate pilot entered DRAINING.",
    payload: {
      deploymentId: "deployment-1",
      phase: "DRAINING",
    },
  };

  await reporter.report(notification);
  await reporter.report(notification);

  const notifications = await repositories.listOperatorNotifications("primary");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.id, notification.notificationId);
  assert.equal(notifications[0]?.notificationType, "POSITION_GUARD_PILOT_ROLLBACK_STARTED");
  assert.deepEqual(kickedExchangeAccounts, ["primary", "primary"]);
});

test("durable reporter retry kicks an exact pre-existing pending notification without saving a duplicate", async () => {
  const baseRepository = new InMemoryExecutionRepository();
  const kickedExchangeAccounts: string[] = [];
  let saveCalls = 0;
  const input = {
    notificationId: "operator_notification:position_guard_pilot_rollback_started:deployment-crash-gap:1",
    exchangeAccountId: "primary",
    notificationType: "POSITION_GUARD_PILOT_ROLLBACK_STARTED" as const,
    severity: "WARN" as const,
    title: "Candidate pilot rollback started",
    message: "The candidate pilot entered DRAINING.",
    payload: {
      deploymentId: "deployment-crash-gap",
      phase: "DRAINING",
    },
  };
  const persisted = createNotification({
    id: input.notificationId,
    notificationType: input.notificationType,
    severity: input.severity,
    title: input.title,
    message: input.message,
    payloadJson: JSON.stringify(input.payload),
    createdAt: "2026-08-21T00:01:00.000Z",
  });
  await baseRepository.saveOperatorNotification(persisted);
  const reporter = new DurableTelegramReporter({
    repositories: {
      listOperatorNotifications: baseRepository.listOperatorNotifications.bind(baseRepository),
      async saveOperatorNotification(record) {
        saveCalls += 1;
        await baseRepository.saveOperatorNotification(record);
      },
    },
    deliveryService: {
      kick(exchangeAccountId) {
        kickedExchangeAccounts.push(exchangeAccountId);
      },
    },
    now: () => persisted.createdAt,
  });

  await reporter.report(input);

  await assert.rejects(
    reporter.report({
      ...input,
      message: "Conflicting deterministic notification material.",
    }),
    /Conflicting deterministic operator notification/,
  );

  assert.equal(saveCalls, 0);
  assert.deepEqual(await baseRepository.listOperatorNotifications("primary"), [persisted]);
  assert.deepEqual(kickedExchangeAccounts, ["primary"]);
});

test("durable reporter retry does not re-kick exact sent or failed notifications", async () => {
  const baseRepository = new InMemoryExecutionRepository();
  const kickedExchangeAccounts: string[] = [];
  let saveCalls = 0;
  const createdAt = "2026-08-21T00:01:00.000Z";
  const inputs = [
    {
      notificationId: "operator_notification:position_guard_pilot_activated:deployment-terminal:sent",
      notificationType: "POSITION_GUARD_PILOT_ACTIVATED" as const,
      severity: "INFO" as const,
      title: "Candidate pilot activated",
      message: "Candidate authority is ACTIVE.",
      payload: { deploymentId: "deployment-terminal", phase: "ACTIVE" },
      deliveryStatus: "SENT" as const,
    },
    {
      notificationId: "operator_notification:position_guard_pilot_fault_paused:deployment-terminal:failed",
      notificationType: "POSITION_GUARD_PILOT_FAULT_PAUSED" as const,
      severity: "ERROR" as const,
      title: "Candidate pilot fault paused",
      message: "Candidate authority is PAUSED_FAULT.",
      payload: { deploymentId: "deployment-terminal", phase: "PAUSED_FAULT" },
      deliveryStatus: "FAILED" as const,
    },
  ];
  for (const input of inputs) {
    await baseRepository.saveOperatorNotification({
      ...createNotification({
        id: input.notificationId,
        notificationType: input.notificationType,
        severity: input.severity,
        title: input.title,
        message: input.message,
        payloadJson: JSON.stringify(input.payload),
        createdAt,
      }),
      deliveryStatus: input.deliveryStatus,
    });
  }
  const reporter = new DurableTelegramReporter({
    repositories: {
      listOperatorNotifications: baseRepository.listOperatorNotifications.bind(baseRepository),
      async saveOperatorNotification(record) {
        saveCalls += 1;
        await baseRepository.saveOperatorNotification(record);
      },
    },
    deliveryService: {
      kick(exchangeAccountId) {
        kickedExchangeAccounts.push(exchangeAccountId);
      },
    },
    now: () => createdAt,
  });

  for (const input of inputs) {
    await reporter.report({
      notificationId: input.notificationId,
      exchangeAccountId: "primary",
      notificationType: input.notificationType,
      severity: input.severity,
      title: input.title,
      message: input.message,
      payload: input.payload,
    });
  }

  assert.equal(saveCalls, 0);
  assert.equal((await baseRepository.listOperatorNotifications("primary")).length, 2);
  assert.deepEqual(kickedExchangeAccounts, []);
});

test("durable reporter resolves a concurrent deterministic insert race by exact immutable readback", async () => {
  const stored = new Map<string, OperatorNotificationRecord>();
  let saveCalls = 0;
  const kickedExchangeAccounts: string[] = [];
  const repositories = {
    async listOperatorNotifications(): Promise<OperatorNotificationRecord[]> {
      return [...stored.values()].map((record) => ({ ...record }));
    },
    async saveOperatorNotification(record: OperatorNotificationRecord): Promise<void> {
      saveCalls += 1;
      await Promise.resolve();
      if (stored.has(record.id)) throw new Error("UNIQUE constraint failed: operator_notifications.id");
      stored.set(record.id, { ...record });
    },
  };
  const reporter = new DurableTelegramReporter({
    repositories,
    deliveryService: {
      kick(exchangeAccountId) {
        kickedExchangeAccounts.push(exchangeAccountId);
      },
    },
    now: () => "2026-08-21T00:01:00.000Z",
  });
  const input = {
    notificationId: "operator_notification:position_guard_pilot_activated:deployment-1:1",
    exchangeAccountId: "primary",
    notificationType: "POSITION_GUARD_PILOT_ACTIVATED" as const,
    severity: "INFO" as const,
    title: "Candidate pilot activated",
    message: "Candidate authority is ACTIVE.",
    payload: { deploymentId: "deployment-1" },
  };

  await Promise.all([reporter.report(input), reporter.report(input)]);

  assert.equal(saveCalls, 2);
  assert.equal(stored.get(input.notificationId)?.id, input.notificationId);
  assert.deepEqual(kickedExchangeAccounts, ["primary", "primary"]);
});

test("durable reporters re-kick a pending SQLite winner after a synchronized deterministic insert race", async () => {
  const databasePath = await createTempDatabasePath("reporter-deterministic-race");
  const first = createNotificationTestPersistence(databasePath);
  const second = createNotificationTestPersistence(databasePath);
  const kickedExchangeAccounts: string[] = [];
  const waitForBothInitialReads = createTwoPartyBarrier();
  let listCalls = 0;
  const input = {
    notificationId: "operator_notification:position_guard_pilot_activated:sqlite-race:1",
    exchangeAccountId: "primary",
    notificationType: "POSITION_GUARD_PILOT_ACTIVATED" as const,
    severity: "INFO" as const,
    title: "Candidate pilot activated",
    message: "Candidate authority is ACTIVE.",
    payload: { deploymentId: "sqlite-race" },
  };
  const createReporter = (repositories: typeof first.repositories) => new DurableTelegramReporter({
    repositories: {
      async listOperatorNotifications(exchangeAccountId: string, limit?: number) {
        const notifications = await repositories.listOperatorNotifications(exchangeAccountId, limit);
        listCalls += 1;
        if (listCalls <= 2) await waitForBothInitialReads();
        return notifications;
      },
      saveOperatorNotification: repositories.saveOperatorNotification.bind(repositories),
    },
    deliveryService: {
      kick(exchangeAccountId) {
        kickedExchangeAccounts.push(exchangeAccountId);
      },
    },
    now: () => "2026-08-24T00:20:00.000Z",
  });

  try {
    await Promise.all([
      createReporter(first.repositories).report(input),
      createReporter(second.repositories).report(input),
    ]);

    assert.deepEqual(
      await first.repositories.listOperatorNotifications("primary", 10),
      [createNotification({
        id: input.notificationId,
        notificationType: input.notificationType,
        severity: input.severity,
        title: input.title,
        message: input.message,
        payloadJson: JSON.stringify(input.payload),
        createdAt: "2026-08-24T00:20:00.000Z",
      })],
    );
    assert.deepEqual(kickedExchangeAccounts, ["primary", "primary"]);
  } finally {
    second.close();
    first.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("nondeterministic reporter calls do not require notification listing support", async () => {
  const saved: OperatorNotificationRecord[] = [];
  const reporter = new DurableTelegramReporter({
    repositories: {
      async saveOperatorNotification(record) {
        saved.push(record);
      },
    },
    now: () => "2026-08-21T00:01:00.000Z",
  });

  await reporter.report({
    exchangeAccountId: "primary",
    notificationType: "ORDER_REJECTED",
    severity: "WARN",
    title: "Order rejected",
    message: "Risk policy rejected the order.",
  });

  assert.equal(saved.length, 1);
});

function createTelegramClientWithResponse(rawBody: string): TelegramBotApiClient {
  return new TelegramBotApiClient({
    botToken: "token-1",
    fetchImpl: async () => new Response(rawBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  });
}

async function assertTelegramMethodsRejectInvalidSuccessEnvelope(
  client: TelegramBotApiClient,
): Promise<void> {
  for (const request of [
    () => client.sendMessage({
      chatId: "chat-1",
      text: "status",
    }),
    () => client.editMessageText({
      chatId: "chat-1",
      messageId: 1,
      text: "status",
    }),
    () => client.answerCallbackQuery({
      callbackQueryId: "callback-1",
    }),
  ]) {
    await assert.rejects(request(), isPermanentEnvelopeError);
  }
}

function isPermanentEnvelopeError(error: unknown): boolean {
  return Boolean(
    error instanceof Error &&
      error.message === "telegram_api_invalid_success_envelope" &&
      "failureClass" in error &&
      error.failureClass === "PERMANENT",
  );
}

function isRetryableTelegramApiError(error: unknown): boolean {
  return Boolean(
    error instanceof Error &&
      error.message === "Too Many Requests: retry later" &&
      "failureClass" in error &&
      error.failureClass === "RETRYABLE" &&
      "retryAfterMs" in error &&
      error.retryAfterMs === 3_000,
  );
}

function expectedKoreanCommandMenu(): Array<{ command: string; description: string }> {
  return [
    { command: "help", description: "지원 명령과 안전 경계를 확인합니다" },
    { command: "config", description: "실행 설정과 안전 게이트를 확인합니다" },
    { command: "readiness", description: "운영 준비 상태를 확인합니다" },
    { command: "status", description: "실행 상태를 확인합니다" },
    { command: "statehistory", description: "실행 상태 변경 이력을 확인합니다" },
    { command: "synchistory", description: "동기화 이력을 확인합니다" },
    { command: "recovery", description: "주문 이력 복구 진행 상황을 확인합니다" },
    { command: "alerts", description: "운영 알림과 전송 상태를 확인합니다" },
    { command: "risks", description: "위험 이벤트 이력을 확인합니다" },
    { command: "balances", description: "저장된 거래소 잔고를 확인합니다" },
    { command: "positions", description: "저장된 BTC/ETH 보유 현황을 확인합니다" },
    { command: "orders", description: "저장된 주문 목록을 확인합니다" },
    { command: "order", description: "주문 상태와 체결을 확인합니다" },
    { command: "scheduler", description: "자동 실행 상태와 이력을 확인합니다" },
    { command: "inbound", description: "텔레그램 명령 수신 상태를 확인합니다" },
    { command: "pause", description: "자동 실행과 주문 실행을 일시 중지합니다" },
    { command: "resume", description: "킬 스위치가 해제되면 실행을 재개합니다" },
    { command: "killswitch", description: "전역 킬 스위치를 켜고 실행을 중단합니다" },
    { command: "sync", description: "거래소 상태와 로컬 기록 동기화를 요청합니다" },
    { command: "preview", description: "주문 없이 BTC/ETH 전략 판단을 미리 확인합니다" },
    { command: "run", description: "안전 실행 경로로 BTC/ETH 전략을 한 번 실행합니다" },
  ];
}

function expectedEnglishCommandMenu(): Array<{ command: string; description: string }> {
  return [
    { command: "help", description: "Show supported commands and safety boundaries." },
    { command: "config", description: "Show runtime configuration and safety gates." },
    { command: "readiness", description: "Show operator readiness." },
    { command: "status", description: "Show execution status." },
    { command: "statehistory", description: "Show execution state history." },
    { command: "synchistory", description: "Show reconciliation history." },
    { command: "recovery", description: "Show order-history recovery progress." },
    { command: "alerts", description: "Show operator alerts and delivery health." },
    { command: "risks", description: "Show risk event history." },
    { command: "balances", description: "Show stored exchange balances." },
    { command: "positions", description: "Show stored BTC and ETH positions." },
    { command: "orders", description: "Show stored orders." },
    { command: "order", description: "Show an order lifecycle and fills." },
    { command: "scheduler", description: "Show automatic-run status and history." },
    { command: "inbound", description: "Show Telegram command intake status." },
    { command: "pause", description: "Pause automated execution and orders." },
    { command: "resume", description: "Resume execution when kill switch is clear." },
    { command: "killswitch", description: "Activate the global kill switch." },
    { command: "sync", description: "Request exchange and local-state reconciliation." },
    { command: "preview", description: "Preview a BTC or ETH strategy decision." },
    { command: "run", description: "Run one BTC or ETH strategy cycle safely." },
  ];
}

function createNotification(
  overrides: Partial<OperatorNotificationRecord> & Pick<OperatorNotificationRecord, "id" | "createdAt">,
): OperatorNotificationRecord {
  const { id, createdAt, ...rest } = overrides;
  return {
    exchangeAccountId: "primary",
    channel: "TELEGRAM",
    notificationType: "ORDER_REJECTED",
    severity: "WARN",
    title: "Operator notification",
    message: "Operator-facing event.",
    payloadJson: "{}",
    deliveryStatus: "PENDING",
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    failureClass: null,
    leaseToken: null,
    leaseExpiresAt: null,
    ...rest,
    id,
    createdAt,
    deliveredAt: null,
    lastError: null,
  };
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `sqlite-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
}

function createNotificationTestPersistence(databasePath: string) {
  return createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "user-notification-test",
    userTelegramId: "telegram-notification-test",
    userDisplayName: "Notification Test Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });
}

function createTwoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await released;
  };
}
