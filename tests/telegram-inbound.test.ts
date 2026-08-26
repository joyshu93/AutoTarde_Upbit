import assert from "node:assert/strict";

import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "../src/app/runtime-ownership-guard.js";
import type { TelegramInboundOffsetRecord } from "../src/domain/types.js";
import {
  splitTelegramReplyText,
  TelegramBotUpdateClient,
  TelegramInboundPollingService as ProductionTelegramInboundPollingService,
  type TelegramInboundUpdate,
} from "../src/modules/telegram/inbound.js";
import { test } from "./harness.js";

class TelegramInboundPollingService extends ProductionTelegramInboundPollingService {
  constructor(dependencies: ConstructorParameters<typeof ProductionTelegramInboundPollingService>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

test("telegram inbound fails closed when runtime authority is omitted", async () => {
  let pollCalls = 0;
  const service = new ProductionTelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        pollCalls += 1;
        return [];
      },
    },
    messageClient: { async sendMessage() {} },
    router: { async route() { return { text: "unused" }; } },
    operatorChatId: "123",
  });

  await assert.rejects(() => service.pollOnce(), /RUNTIME_OWNERSHIP_NOT_HELD/u);
  assert.equal(pollCalls, 0);
});

test("telegram inbound start fails closed before installing a timer", () => {
  let timerCalls = 0;
  const service = new ProductionTelegramInboundPollingService({
    enabled: true,
    updateClient: { async getUpdates() { return []; } },
    messageClient: { async sendMessage() {} },
    router: { async route() { return { text: "unused" }; } },
    operatorChatId: "123",
    setTimer: () => {
      timerCalls += 1;
      return setTimeout(() => undefined, 60_000);
    },
  });

  assert.throws(() => service.start(), /RUNTIME_OWNERSHIP_NOT_HELD/u);
  assert.equal(timerCalls, 0);
});

test("scheduled inbound ownership loss routes once without unhandled rejection or repeat timer", async () => {
  const ownership = createFreshLossRuntimeOwnershipAuthority();
  const callbacks: Array<() => void> = [];
  const routedErrors: unknown[] = [];
  const unhandled: unknown[] = [];
  let timerCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        ownership.lose();
        return [];
      },
    },
    messageClient: { async sendMessage() {} },
    router: { async route() { return { text: "unused" }; } },
    operatorChatId: "123",
    runtimeOwnership: ownership.authority,
    setTimer: (callback) => {
      timerCalls += 1;
      callbacks.push(callback);
      const timer = setTimeout(() => undefined, 60_000);
      clearTimeout(timer);
      return timer;
    },
  });
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    (service.start as unknown as (onOwnershipLost: (error: unknown) => void) => unknown)(
      (error) => routedErrors.push(error),
    );
    callbacks[0]?.();
    await waitForUnhandledTurn();

    assert.deepEqual(unhandled, []);
    assert.deepEqual(routedErrors, [ownership.errors[0]]);
    assert.equal(timerCalls, 1);
    assert.equal(service.getStatus().running, false);
    assert.equal(service.getStatus().failedCount, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    service.stop();
  }
});

test("telegram inbound rejects all routing and responses after runtime ownership is lost", async () => {
  let pollCalls = 0;
  let routeCalls = 0;
  let sendCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        pollCalls += 1;
        return [createUpdate(1, "123", "/status")];
      },
    },
    messageClient: {
      async sendMessage() {
        sendCalls += 1;
      },
    },
    router: {
      async route() {
        routeCalls += 1;
        return { text: "read-only status" };
      },
    },
    operatorChatId: "123",
    runtimeOwnership: createLostRuntimeOwnershipAuthority(),
  });
  service.stop();

  await assert.rejects(() => service.pollOnce(), /RUNTIME_OWNERSHIP_LOST/u);

  assert.equal(pollCalls, 0);
  assert.equal(routeCalls, 0);
  assert.equal(sendCalls, 0);
});

test("telegram inbound propagates ownership loss while a read-only route is awaiting", async () => {
  const runtimeOwnership = createControllableRuntimeOwnershipAuthority();
  let sendCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        return [createUpdate(1, "123", "/status")];
      },
    },
    messageClient: {
      async sendMessage() {
        sendCalls += 1;
      },
    },
    router: {
      async route() {
        runtimeOwnership.lose();
        return { text: "stale read-only status" };
      },
    },
    operatorChatId: "123",
    runtimeOwnership,
  });

  await assert.rejects(() => service.pollOnce(), /RUNTIME_OWNERSHIP_LOST/u);

  assert.equal(sendCalls, 0);
});

test("telegram inbound persists no offset when ownership is lost during polling", async () => {
  const runtimeOwnership = createControllableRuntimeOwnershipAuthority();
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  let routeCalls = 0;
  let sendCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        runtimeOwnership.lose();
        return [createUpdate(1, "123", "/pause")];
      },
    },
    messageClient: {
      async sendMessage() {
        sendCalls += 1;
      },
    },
    router: {
      async route() {
        routeCalls += 1;
        return { text: "stale mutation result" };
      },
    },
    operatorChatId: "123",
    exchangeAccountId: "primary",
    offsetStore: createOffsetStore({ savedOffsets }),
    botTokenRef: "sha256:runtime-loss",
    runtimeOwnership,
  });

  await assert.rejects(() => service.pollOnce(), /RUNTIME_OWNERSHIP_LOST/u);

  assert.deepEqual(savedOffsets, []);
  assert.equal(routeCalls, 0);
  assert.equal(sendCalls, 0);
});

test("telegram inbound rejects before getUpdates when ownership is lost during durable offset loading", async () => {
  const ownership = createFreshLossRuntimeOwnershipAuthority();
  let getUpdatesCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        getUpdatesCalls += 1;
        return [];
      },
    },
    messageClient: { async sendMessage() {} },
    router: { async route() { return { text: "unused" }; } },
    operatorChatId: "123",
    exchangeAccountId: "primary",
    offsetStore: {
      async getTelegramInboundOffset() {
        ownership.lose();
        return null;
      },
      async saveTelegramInboundOffset() {
        throw new Error("offset save must not run");
      },
    },
    botTokenRef: "sha256:offset-load-loss",
    runtimeOwnership: ownership.authority,
  });

  await assert.rejects(() => service.pollOnce(), (error) => error === ownership.errors[0]);
  assert.equal(getUpdatesCalls, 0);
});

test("telegram inbound rejects an empty getUpdates result when ownership is lost while polling", async () => {
  const ownership = createFreshLossRuntimeOwnershipAuthority();
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        ownership.lose();
        return [];
      },
    },
    messageClient: { async sendMessage() {} },
    router: { async route() { return { text: "unused" }; } },
    operatorChatId: "123",
    runtimeOwnership: ownership.authority,
  });

  await assert.rejects(() => service.pollOnce(), (error) => error === ownership.errors[0]);
  assert.equal(service.getStatus().failedCount, 0);
});

test("telegram inbound replaces a transport rejection with the exact ownership error after mid-poll loss", async () => {
  const ownership = createFreshLossRuntimeOwnershipAuthority();
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        ownership.lose();
        throw new Error("telegram_transport_failed");
      },
    },
    messageClient: { async sendMessage() {} },
    router: { async route() { return { text: "unused" }; } },
    operatorChatId: "123",
    runtimeOwnership: ownership.authority,
  });

  await assert.rejects(() => service.pollOnce(), (error) => error === ownership.errors[0]);
  assert.equal(service.getStatus().failedCount, 0);
});

test("telegram inbound rejects when ownership is lost while a reply send settles", async () => {
  const ownership = createFreshLossRuntimeOwnershipAuthority();
  let sendCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        return [createUpdate(1, "123", "/status")];
      },
    },
    messageClient: {
      async sendMessage() {
        sendCalls += 1;
        ownership.lose();
      },
    },
    router: {
      async route() {
        return { text: "single reply" };
      },
    },
    operatorChatId: "123",
    runtimeOwnership: ownership.authority,
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  await assert.rejects(() => service.pollOnce(), (error) => error === ownership.errors[0]);
  assert.equal(sendCalls, 1);
  assert.equal(service.getStatus().processedCount, 0);
  assert.equal(service.getStatus().failedCount, 0);
});

test("telegram inbound rejects the exact ownership error when loss occurs while callback edit settles", async () => {
  const ownership = createFreshLossRuntimeOwnershipAuthority();
  let editCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        return [createCallbackUpdate(1, {
          callbackId: "callback-runtime-loss",
          senderId: "123",
          chatId: "123",
          messageId: 10,
          data: "status:refresh",
        })];
      },
    },
    messageClient: {
      async sendMessage() {},
      async answerCallbackQuery() {},
      async editMessageText() {
        editCalls += 1;
        ownership.lose();
      },
    },
    router: {
      async route() { return { text: "unused" }; },
      async routeReadOnlyCallback() { return { text: "read-only callback" }; },
    },
    operatorChatId: "123",
    runtimeOwnership: ownership.authority,
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  await assert.rejects(() => service.pollOnce(), (error) => error === ownership.errors[0]);
  assert.equal(editCalls, 1);
  assert.equal(service.getStatus().processedCount, 0);
  assert.equal(service.getStatus().failedCount, 0);
});

function createFreshLossRuntimeOwnershipAuthority(): {
  authority: RuntimeOwnershipAuthority;
  errors: RuntimeOwnershipGuardError[];
  lose(): void;
} {
  let held = true;
  const errors: RuntimeOwnershipGuardError[] = [];
  return {
    errors,
    lose() {
      held = false;
    },
    authority: {
      snapshot: () => ({
        status: held ? "OWNED" : "LOST",
        generation: 1,
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 1,
        heartbeatAtEpochMs: 1,
        expiresAtEpochMs: 45_001,
        takeover: false,
        lossReason: held ? null : "TEST_GENERATION_REPLACED",
      }),
      assertLocallyHeld() {
        if (!held) {
          const error = new RuntimeOwnershipGuardError(
            "RUNTIME_OWNERSHIP_LOST",
            "RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED",
          );
          errors.push(error);
          throw error;
        }
      },
      async assertCurrent(): Promise<never> {
        throw new Error("assertCurrent is not used by inbound routing");
      },
    },
  };
}

function createLostRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  return {
    snapshot: () => ({
      status: "LOST",
      generation: 1,
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 1,
      heartbeatAtEpochMs: 1,
      expiresAtEpochMs: 45_001,
      takeover: false,
      lossReason: "TEST_GENERATION_REPLACED",
    }),
    assertLocallyHeld() {
      throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
    async assertCurrent(): Promise<never> {
      throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
  };
}

function createAlwaysOwnedRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  return {
    snapshot: () => ({
      status: "OWNED",
      generation: record.generation,
      executionMode: record.executionMode,
      acquiredAtEpochMs: record.acquiredAtEpochMs,
      heartbeatAtEpochMs: record.heartbeatAtEpochMs,
      expiresAtEpochMs: record.expiresAtEpochMs,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent() {
      return { ...record };
    },
  };
}

function createControllableRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority & { lose(): void } {
  let held = true;
  return {
    lose() {
      held = false;
    },
    snapshot: () => ({
      status: held ? "OWNED" : "LOST",
      generation: 1,
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 1,
      heartbeatAtEpochMs: 1,
      expiresAtEpochMs: 45_001,
      takeover: false,
      lossReason: held ? null : "TEST_GENERATION_REPLACED",
    }),
    assertLocallyHeld() {
      if (!held) throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
    async assertCurrent(): Promise<never> {
      throw new Error("assertCurrent is not used by inbound routing");
    },
  };
}

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

test("telegram inbound ignores group commands and persists their durable offset", async () => {
  const routed: string[] = [];
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[
      createUpdate(14, "123", "/killswitch", {
        senderId: "123",
        chatType: "group",
      }),
    ]]),
    messageClient: {
      async sendMessage() {
        throw new Error("unauthorized_group_must_not_receive_reply");
      },
    },
    router: {
      async route(input) {
        routed.push(input);
        return { text: "must_not_route" };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({ savedOffsets }),
    botTokenRef: "sha256:bot-a",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.processedCount, 0);
  assert.equal(summary.ignoredCount, 1);
  assert.equal(summary.nextOffset, 15);
  assert.equal(savedOffsets[0]?.nextOffset, 15);
  assert.deepEqual(routed, []);
});

test("telegram inbound ignores private commands from a mismatched sender", async () => {
  const routed: string[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[
      createUpdate(15, "123", "/pause", {
        senderId: "999",
        chatType: "private",
      }),
    ]]),
    messageClient: {
      async sendMessage() {
        throw new Error("unauthorized_sender_must_not_receive_reply");
      },
    },
    router: {
      async route(input) {
        routed.push(input);
        return { text: "must_not_route" };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.processedCount, 0);
  assert.equal(summary.ignoredCount, 1);
  assert.deepEqual(routed, []);
});

test("telegram inbound accepts private commands from the configured operator sender", async () => {
  const routed: string[] = [];
  const sent: string[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[
      createUpdate(16, "123", "/status", {
        senderId: "123",
        chatType: "private",
      }),
    ]]),
    messageClient: {
      async sendMessage(input) {
        sent.push(`${input.chatId}:${input.text}`);
      },
    },
    router: {
      async route(input) {
        routed.push(input);
        return { text: "authorized" };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.processedCount, 1);
  assert.equal(summary.ignoredCount, 0);
  assert.deepEqual(routed, ["/status"]);
  assert.deepEqual(sent, ["123:authorized"]);
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

test("telegram inbound preserves the dashboard HTML and inline keyboard on /start", async () => {
  const sent: Array<{
    chatId: string;
    text: string;
    parseMode?: string;
    replyMarkup?: { inlineKeyboard: readonly (readonly { callbackData: string }[])[] };
  }> = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[createUpdate(15, "123", "/start")]]),
    messageClient: {
      async sendMessage(input) {
        sent.push(input);
      },
    },
    router: {
      async route() {
        return {
          text: "<b>dashboard</b>",
          parseMode: "HTML" as const,
          replyMarkup: { inlineKeyboard: [[{ text: "Status", callbackData: "status" }]] },
        };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.deepEqual(sent, [{
    chatId: "123",
    text: "<b>dashboard</b>",
    parseMode: "HTML",
    replyMarkup: { inlineKeyboard: [[{ text: "Status", callbackData: "status" }]] },
  }]);
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

test("telegram inbound redacts bot-token URLs and secret-like values from lastError", async () => {
  const secretError = [
    "proxy failed https://api.telegram.org/bot123456:ABC-Secret/getUpdates",
    "?access_token=query-secret&foo=visible",
    "Authorization: Bearer bearer-secret",
  ].join("");
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[createUpdate(21, "123", "/status")]]),
    messageClient: {
      async sendMessage() {
        throw new Error(secretError);
      },
    },
    router: {
      async route() {
        return { text: "status" };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();
  const lastError = service.getStatus().lastError ?? "";

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.errorMessage, lastError);
  assert.doesNotMatch(lastError, /123456:ABC-Secret/u);
  assert.doesNotMatch(lastError, /query-secret/u);
  assert.doesNotMatch(lastError, /bearer-secret/u);
  assert.match(lastError, /\[REDACTED\]/u);
});

test("telegram inbound redacts compound secret-bearing query keys without hiding harmless evidence", async () => {
  const secretError = [
    "proxy https://x.test/?client_secret=s1&private_key=s2&credential=s3",
    "&client_token=s4&auth_token=s5&refreshToken=s6",
    "&signingCredential=s7&service-key=s8&foo=visible",
  ].join("");
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[createUpdate(22, "123", "/inbound")]]),
    messageClient: {
      async sendMessage() {
        throw new Error(secretError);
      },
    },
    router: {
      async route() {
        return { text: "inbound" };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();
  const lastError = service.getStatus().lastError ?? "";

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.errorMessage, lastError);
  for (const secret of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]) {
    assert.doesNotMatch(lastError, new RegExp(`=${secret}(?:&|$)`, "u"));
  }
  assert.match(lastError, /client_secret=\[REDACTED\]/u);
  assert.match(lastError, /private_key=\[REDACTED\]/u);
  assert.match(lastError, /credential=\[REDACTED\]/u);
  assert.match(lastError, /client_token=\[REDACTED\]/u);
  assert.match(lastError, /auth_token=\[REDACTED\]/u);
  assert.match(lastError, /refreshToken=\[REDACTED\]/u);
  assert.match(lastError, /signingCredential=\[REDACTED\]/u);
  assert.match(lastError, /service-key=\[REDACTED\]/u);
  assert.match(lastError, /foo=visible/u);
});

test("telegram inbound polling normalizes callback updates and requests both supported update types", async () => {
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
            update_id: 31,
            callback_query: {
              id: "callback-1",
              from: {
                id: 123,
              },
              message: {
                message_id: 8,
                chat: {
                  id: 123,
                },
              },
              data: "status:refresh",
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
    allowed_updates: ["message", "callback_query"],
  });
  assert.deepEqual(updates, [
    {
      updateId: 31,
      message: null,
      callbackQuery: {
        callbackId: "callback-1",
        senderId: "123",
        chatId: "123",
        messageId: 8,
        data: "status:refresh",
      },
    },
  ] as unknown as TelegramInboundUpdate[]);
});

test("telegram inbound callbacks require matching private source chat and sender ids before acknowledgement", async () => {
  const routed: string[] = [];
  const acknowledgements: Array<{ callbackQueryId: string; text?: string }> = [];
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createCallbackUpdate(60, {
          callbackId: "callback-wrong-chat",
          senderId: "123",
          chatId: "999",
          messageId: 1,
          data: "status",
        }),
        createCallbackUpdate(61, {
          callbackId: "callback-wrong-sender",
          senderId: "999",
          chatId: "123",
          messageId: 2,
          data: "status",
        }),
      ],
    ]),
    messageClient: {
      async sendMessage() {},
    },
    callbackClient: {
      async answerCallbackQuery(input: { callbackQueryId: string; text?: string }) {
        acknowledgements.push(input);
      },
    },
    router: {
      async route(input: string) {
        routed.push(input);
        return { text: "must_not_route_callbacks" };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({
      savedOffsets,
    }),
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.ignoredCount, 2);
  assert.deepEqual(routed, []);
  assert.deepEqual(savedOffsets.map((record) => record.nextOffset), [61, 62]);
  assert.deepEqual(acknowledgements.map((acknowledgement) => acknowledgement.callbackQueryId), [
    "callback-wrong-chat",
    "callback-wrong-sender",
  ]);
  assert.ok(acknowledgements.every((acknowledgement) => (acknowledgement.text?.length ?? 0) > 0));
  assert.ok(acknowledgements.every((acknowledgement) => (acknowledgement.text?.length ?? 0) <= 240));
});

test("telegram inbound acknowledges malformed and mutation callback data without routing or durable state mutation", async () => {
  const routed: string[] = [];
  const acknowledgements: Array<{ callbackQueryId: string; text?: string }> = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createCallbackUpdate(70, {
          callbackId: "callback-malformed",
          senderId: "123",
          chatId: "123",
          messageId: 1,
          data: "orders:page:01",
        }),
        createCallbackUpdate(71, {
          callbackId: "callback-mutation",
          senderId: "123",
          chatId: "123",
          messageId: 2,
          data: "pause",
        }),
      ],
    ]),
    messageClient: {
      async sendMessage() {},
    },
    callbackClient: {
      async answerCallbackQuery(input: { callbackQueryId: string; text?: string }) {
        acknowledgements.push(input);
      },
    },
    router: {
      async route(input: string) {
        routed.push(input);
        return { text: "must_not_route_callbacks" };
      },
    },
    operatorChatId: "123",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.ignoredCount, 2);
  assert.deepEqual(routed, []);
  assert.deepEqual(acknowledgements.map((acknowledgement) => acknowledgement.callbackQueryId), [
    "callback-malformed",
    "callback-mutation",
  ]);
  assert.ok(acknowledgements.every((acknowledgement) => (acknowledgement.text?.length ?? 0) > 0));
});

test("telegram inbound uses a callback acknowledgement capability exposed by its message client", async () => {
  const acknowledgements: Array<{ callbackQueryId: string; text?: string }> = [];
  const messageClient = {
    async sendMessage() {},
    async editMessageText() {},
    async answerCallbackQuery(input: { callbackQueryId: string; text?: string }) {
      acknowledgements.push(input);
    },
  };
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createCallbackUpdate(75, {
          callbackId: "callback-message-client",
          senderId: "123",
          chatId: "123",
          messageId: 1,
          data: "status",
        }),
      ],
    ]),
    messageClient,
    router: {
      async route() {
        throw new Error("callbacks_must_not_route");
      },
      async routeReadOnlyCallback() {
        return {
          text: "<pre>status</pre>",
          parseMode: "HTML" as const,
          replyMarkup: { inlineKeyboard: [] },
        };
      },
    },
    operatorChatId: "123",
  });

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.processedCount, 1);
  assert.deepEqual(acknowledgements, [
    {
      callbackQueryId: "callback-message-client",
    },
  ]);
});

test("telegram inbound acknowledges a valid callback before lookup and edits only its originating message", async () => {
  const timeline: string[] = [];
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const edited: Array<{ chatId: string; messageId: number; text: string; parseMode?: string }> = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createCallbackUpdate(76, {
          callbackId: "callback-status",
          senderId: "123",
          chatId: "123",
          messageId: 44,
          data: "status:refresh",
        }),
      ],
    ]),
    messageClient: {
      async sendMessage() {
        throw new Error("callback_navigation_must_not_send_message");
      },
      async editMessageText(input: { chatId: string; messageId: number; text: string; parseMode?: string }) {
        timeline.push("edit");
        edited.push(input);
      },
    },
    callbackClient: {
      async answerCallbackQuery() {
        timeline.push("ack");
      },
    },
    router: {
      async route() {
        throw new Error("callbacks_must_not_use_generic_route");
      },
      async routeReadOnlyCallback(action: { type: string }) {
        timeline.push(`lookup:${action.type}`);
        return {
          text: "<b>status</b>",
          parseMode: "HTML" as const,
          replyMarkup: { inlineKeyboard: [[{ text: "Home", callbackData: "home" }]] },
        };
      },
    },
    operatorChatId: "123",
    offsetStore: {
      ...createOffsetStore({ savedOffsets }),
      async saveTelegramInboundOffset(record: TelegramInboundOffsetRecord) {
        timeline.push("offset");
        savedOffsets.push(record);
      },
    },
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "COMPLETED");
  assert.equal(summary.processedCount, 1);
  assert.deepEqual(timeline, ["offset", "ack", "lookup:STATUS_REFRESH", "edit"]);
  assert.deepEqual(edited, [{
    chatId: "123",
    messageId: 44,
    text: "<b>status</b>",
    parseMode: "HTML",
    replyMarkup: { inlineKeyboard: [[{ text: "Home", callbackData: "home" }]] },
  }]);
});

test("telegram inbound records edit failures after the acknowledgement without retrying its persisted callback", async () => {
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createCallbackUpdate(77, {
          callbackId: "callback-edit-failure",
          senderId: "123",
          chatId: "123",
          messageId: 45,
          data: "home",
        }),
      ],
    ]),
    messageClient: {
      async sendMessage() {},
      async editMessageText() {
        throw new Error("telegram_callback_edit_failed");
      },
    },
    callbackClient: {
      async answerCallbackQuery() {},
    },
    router: {
      async route() {
        throw new Error("callbacks_must_not_use_generic_route");
      },
      async routeReadOnlyCallback() {
        return {
          text: "<b>home</b>",
          parseMode: "HTML" as const,
          replyMarkup: { inlineKeyboard: [[{ text: "Home", callbackData: "home" }]] },
        };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({ savedOffsets }),
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.errorMessage, "telegram_callback_edit_failed");
  assert.equal(savedOffsets[0]?.nextOffset, 78);
});

test("telegram inbound fails a valid callback without an acknowledgement client before lookup or edit", async () => {
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  let lookups = 0;
  let edits = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[createCallbackUpdate(78, {
      callbackId: "callback-no-ack",
      senderId: "123",
      chatId: "123",
      messageId: 46,
      data: "home",
    })]]),
    messageClient: {
      async sendMessage() {},
      async editMessageText() {
        edits += 1;
      },
    },
    router: {
      async route() {
        throw new Error("callbacks_must_not_use_generic_route");
      },
      async routeReadOnlyCallback() {
        lookups += 1;
        return { text: "<pre>home</pre>", parseMode: "HTML" as const, replyMarkup: { inlineKeyboard: [] } };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({ savedOffsets }),
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.errorMessage, "telegram_callback_ack_client_unavailable");
  assert.equal(summary.processedCount, 0);
  assert.equal(lookups, 0);
  assert.equal(edits, 0);
  assert.equal(savedOffsets[0]?.nextOffset, 79);
});

test("telegram inbound fails a valid callback after ACK when the read-only router is unavailable", async () => {
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  let acknowledgements = 0;
  let edits = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[createCallbackUpdate(79, {
      callbackId: "callback-no-router",
      senderId: "123",
      chatId: "123",
      messageId: 47,
      data: "home",
    })]]),
    messageClient: {
      async sendMessage() {},
      async editMessageText() {
        edits += 1;
      },
    },
    callbackClient: {
      async answerCallbackQuery() {
        acknowledgements += 1;
      },
    },
    router: {
      async route() {
        throw new Error("callbacks_must_not_use_generic_route");
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({ savedOffsets }),
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.errorMessage, "telegram_callback_router_unavailable");
  assert.equal(acknowledgements, 1);
  assert.equal(edits, 0);
  assert.equal(savedOffsets[0]?.nextOffset, 80);
});

test("telegram inbound fails a valid callback after ACK when message editing is unavailable", async () => {
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  let acknowledgements = 0;
  let lookups = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [[createCallbackUpdate(80, {
      callbackId: "callback-no-edit",
      senderId: "123",
      chatId: "123",
      messageId: 48,
      data: "home",
    })]]),
    messageClient: {
      async sendMessage() {},
    },
    callbackClient: {
      async answerCallbackQuery() {
        acknowledgements += 1;
      },
    },
    router: {
      async route() {
        throw new Error("callbacks_must_not_use_generic_route");
      },
      async routeReadOnlyCallback() {
        lookups += 1;
        return { text: "<pre>home</pre>", parseMode: "HTML" as const, replyMarkup: { inlineKeyboard: [] } };
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({ savedOffsets }),
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.errorMessage, "telegram_callback_edit_client_unavailable");
  assert.equal(acknowledgements, 1);
  assert.equal(lookups, 0);
  assert.equal(savedOffsets[0]?.nextOffset, 81);
});

test("telegram inbound records callback acknowledgement failures after persisting the update offset", async () => {
  const savedOffsets: TelegramInboundOffsetRecord[] = [];
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: createUpdateClient([], [
      [
        createCallbackUpdate(80, {
          callbackId: "callback-ack-failure",
          senderId: "123",
          chatId: "123",
          messageId: 1,
          data: "status",
        }),
      ],
    ]),
    messageClient: {
      async sendMessage() {},
    },
    callbackClient: {
      async answerCallbackQuery() {
        throw new Error("telegram_callback_ack_failed");
      },
    },
    router: {
      async route() {
        throw new Error("callbacks_must_not_route");
      },
    },
    operatorChatId: "123",
    offsetStore: createOffsetStore({
      savedOffsets,
    }),
    botTokenRef: "sha256:bot-a",
  } as unknown as ConstructorParameters<typeof TelegramInboundPollingService>[0]);

  const summary = await service.pollOnce();

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.nextOffset, 81);
  assert.equal(summary.errorMessage, "telegram_callback_ack_failed");
  assert.equal(savedOffsets[0]?.nextOffset, 81);
});

test("closed callback parser accepts only read-only navigation and safe decimal pages", async () => {
  const callbacksModulePath = new URL(
    "../src/modules/telegram/callbacks.js",
    import.meta.url,
  ).href;
  const { parseTelegramReadOnlyCallbackAction } = await import(callbacksModulePath) as {
    parseTelegramReadOnlyCallbackAction(data: string): unknown;
  };

  assert.deepEqual(parseTelegramReadOnlyCallbackAction("home"), { type: "HOME" });
  assert.deepEqual(parseTelegramReadOnlyCallbackAction("status:detail"), { type: "STATUS_DETAIL" });
  assert.deepEqual(parseTelegramReadOnlyCallbackAction("orders:page:0"), {
    type: "ORDERS_PAGE",
    page: 0,
  });
  assert.deepEqual(parseTelegramReadOnlyCallbackAction("alerts:detail:42"), {
    type: "ALERTS_DETAIL",
    alertId: 42,
  });

  for (const invalid of [
    "",
    "orders:page:-1",
    "orders:page:+1",
    "orders:page:1.0",
    "orders:page:1e2",
    "orders:page: 1",
    "orders:page:01",
    "orders:page:9007199254740992",
    "run",
    "sync",
    "pause",
    "resume",
    "killswitch",
    "unknown",
    "가".repeat(22),
  ]) {
    assert.equal(parseTelegramReadOnlyCallbackAction(invalid), null, invalid);
  }
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

test("telegram inbound stopAndWait clears timers, rejects new work, and waits for the active poll", async () => {
  const activePoll = createDeferred<TelegramInboundUpdate[]>();
  let getUpdatesCalls = 0;
  let clearTimerCalls = 0;
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        getUpdatesCalls += 1;
        return activePoll.promise;
      },
    },
    messageClient: {
      async sendMessage() {},
    },
    router: {
      async route() {
        return { text: "unused" };
      },
    },
    operatorChatId: "123",
    pollIntervalMs: 60_000,
    setTimer: () => setTimeout(() => undefined, 60_000),
    clearTimer: (timer) => {
      clearTimerCalls += 1;
      clearTimeout(timer);
    },
  });

  service.start();
  const currentPoll = service.pollOnce();
  await waitForMicrotasks();
  let stopResolved = false;
  const stopping = service.stopAndWait(1_000).then((status) => {
    stopResolved = true;
    return status;
  });

  assert.equal(clearTimerCalls, 1);
  assert.equal(service.getStatus().running, true);
  assert.throws(() => service.start(), /cannot start after stop/i);
  await assert.rejects(() => service.pollOnce(), /cannot poll after stop/i);
  assert.equal(getUpdatesCalls, 1);
  assert.equal(stopResolved, false);

  activePoll.resolve([]);
  await currentPoll;
  const status = await stopping;
  assert.equal(status.running, false);
});

test("telegram inbound stopAndWait returns at its bound while the active poll remains visible", async () => {
  const activePoll = createDeferred<TelegramInboundUpdate[]>();
  const service = new TelegramInboundPollingService({
    enabled: true,
    updateClient: {
      async getUpdates() {
        return activePoll.promise;
      },
    },
    messageClient: {
      async sendMessage() {},
    },
    router: {
      async route() {
        return { text: "unused" };
      },
    },
    operatorChatId: "123",
  });

  const currentPoll = service.pollOnce();
  await waitForMicrotasks();
  const status = await service.stopAndWait(0);

  assert.equal(status.running, true);

  activePoll.resolve([]);
  await currentPoll;
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
              from: {
                id: 123,
              },
              chat: {
                id: 123,
                type: "private",
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
    allowed_updates: ["message", "callback_query"],
  });
  assert.deepEqual(updates, [
    {
      updateId: 30,
      message: {
        messageId: 7,
        chatId: "123",
        senderId: "123",
        chatType: "private",
        text: "/status",
      },
      callbackQuery: null,
    },
    {
      updateId: 31,
      message: null,
      callbackQuery: null,
    },
  ]);
});

function createUpdate(
  updateId: number,
  chatId: string,
  text: string | null,
  options: {
    senderId?: string;
    chatType?: "private" | "group" | "supergroup" | "channel";
  } = {},
): TelegramInboundUpdate {
  return {
    updateId,
    message: {
      messageId: updateId * 10,
      chatId,
      senderId: options.senderId ?? chatId,
      chatType: options.chatType ?? "private",
      text,
    },
    callbackQuery: null,
  };
}

function createCallbackUpdate(
  updateId: number,
  callbackQuery: {
    callbackId: string;
    senderId: string;
    chatId: string;
    messageId: number;
    data: string | null;
  },
): TelegramInboundUpdate {
  return {
    updateId,
    message: null,
    callbackQuery,
  } as unknown as TelegramInboundUpdate;
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForUnhandledTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
