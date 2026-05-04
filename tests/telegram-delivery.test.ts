import assert from "node:assert/strict";

import type { OperatorNotificationRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import {
  OperatorNotificationDeliveryService,
  TelegramBotApiClient,
} from "../src/modules/telegram/delivery.js";
import { DurableTelegramReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

test("telegram bot api client posts sendMessage payloads", async () => {
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

  await client.sendMessage({
    chatId: "chat-1",
    text: "hello operator",
  });

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input), "https://api.telegram.org/bottoken-1/sendMessage");
  assert.equal(requests[0]?.init?.method, "POST");
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  assert.equal(body.chat_id, "chat-1");
  assert.equal(body.text, "hello operator");
});

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
  assert.equal(pendingNotifications.length, 0);
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
