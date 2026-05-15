import type {
  StrategySchedulerMarketStatus,
  StrategySchedulerRunRecord,
  StrategySchedulerStartupPreflight,
  StrategySchedulerStatus,
  SupportedMarket,
} from "../domain/types.js";
import type { ExecutionRepository } from "../modules/db/interfaces.js";
import type {
  TelegramStrategyRunController,
  TelegramStrategyRunResult,
} from "../modules/telegram/interfaces.js";
import type { OperatorNotificationReporter } from "../modules/telegram/reporter.js";
import { createId } from "../shared/ids.js";

export interface StrategySchedulerMarketConfig {
  market: SupportedMarket;
  intervalMs: number;
}

export interface StrategySchedulerConfig {
  enabled: boolean;
  runOnStart: boolean;
  exchangeAccountId: string;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  startupPreflight?: StrategySchedulerStartupPreflight | null;
  markets: StrategySchedulerMarketConfig[];
}

type SchedulerTimer = ReturnType<typeof setTimeout>;

export class StrategyScheduler {
  private started = false;
  private readonly timers = new Map<SupportedMarket, SchedulerTimer>();
  private readonly statusByMarket = new Map<SupportedMarket, StrategySchedulerMarketStatus>();
  private startupPreflight: StrategySchedulerStartupPreflight | null;

  constructor(
    private readonly dependencies: {
      config: StrategySchedulerConfig;
      controller: TelegramStrategyRunController;
      repositories?: Pick<ExecutionRepository, "saveStrategySchedulerRun" | "updateStrategySchedulerRun">;
      reporter?: OperatorNotificationReporter;
      now?: () => string;
      setTimer?: (callback: () => void, delayMs: number) => SchedulerTimer;
      clearTimer?: (timer: SchedulerTimer) => void;
    },
  ) {
    this.startupPreflight = dependencies.config.startupPreflight ?? null;
    for (const market of dependencies.config.markets) {
      this.statusByMarket.set(market.market, createInitialMarketStatus(market));
    }
  }

  setStartupPreflight(preflight: StrategySchedulerStartupPreflight | null): void {
    this.startupPreflight = preflight;
  }

  start(): StrategySchedulerStatus {
    if (!this.dependencies.config.enabled || this.started) {
      return this.getStatus();
    }

    if (this.startupPreflight?.status === "BLOCK") {
      this.applyStartupBlock(this.startupPreflight);
      return this.getStatus();
    }

    this.started = true;
    for (const market of this.dependencies.config.markets) {
      if (this.dependencies.config.runOnStart) {
        this.scheduleMarket(market, 0);
        continue;
      }

      this.scheduleMarket(market, market.intervalMs);
    }

    return this.getStatus();
  }

  stop(): StrategySchedulerStatus {
    for (const timer of this.timers.values()) {
      (this.dependencies.clearTimer ?? clearTimeout)(timer);
    }

    this.timers.clear();
    this.started = false;
    for (const market of this.dependencies.config.markets) {
      this.updateMarketStatus(market.market, {
        running: false,
        nextRunAt: null,
      });
    }

    return this.getStatus();
  }

  getStatus(): StrategySchedulerStatus {
    return {
      enabled: this.dependencies.config.enabled,
      started: this.started,
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      liveSendPath: this.dependencies.config.liveSendPath,
      startupPreflight: this.startupPreflight,
      markets: this.dependencies.config.markets.map((market) => {
        const status = this.statusByMarket.get(market.market);
        return status ? { ...status } : createInitialMarketStatus(market);
      }),
    };
  }

  async runMarketNow(market: SupportedMarket): Promise<TelegramStrategyRunResult> {
    const config = this.dependencies.config.markets.find((candidate) => candidate.market === market);
    if (!config) {
      throw new Error(`Unsupported scheduled market: ${market}`);
    }

    const current = this.statusByMarket.get(market) ?? createInitialMarketStatus(config);
    if (current.running) {
      const requestedAt = this.now();
      const skipped: TelegramStrategyRunResult = {
        status: "ALREADY_RUNNING",
        requestedAt,
        market,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        detail: `A scheduled strategy run is already running for ${market}.`,
      };
      this.statusByMarket.set(market, {
        ...current,
        skippedCount: current.skippedCount + 1,
        lastCompletedAt: requestedAt,
        lastStatus: "ALREADY_RUNNING",
        lastError: null,
      });
      await this.persistSchedulerRun({
        run: createSchedulerRunRecord({
          exchangeAccountId: this.dependencies.config.exchangeAccountId,
          market,
          intervalMs: config.intervalMs,
          runOnStart: this.dependencies.config.runOnStart,
          status: "SKIPPED",
          startedAt: requestedAt,
          completedAt: requestedAt,
          result: skipped,
        }),
        update: false,
      });
      await this.reportSchedulerResult({
        market,
        result: skipped,
        intervalMs: config.intervalMs,
        runOnStart: this.dependencies.config.runOnStart,
      });
      return skipped;
    }

    const startedAt = this.now();
    this.updateMarketStatus(market, {
      running: true,
      lastStartedAt: startedAt,
      lastCompletedAt: null,
      lastError: null,
    });
    const runRecord = createSchedulerRunRecord({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      market,
      intervalMs: config.intervalMs,
      runOnStart: this.dependencies.config.runOnStart,
      status: "STARTED",
      startedAt,
      completedAt: null,
      result: null,
    });
    const startPersisted = await this.persistSchedulerRun({
      run: runRecord,
      update: false,
    });
    if (!startPersisted) {
      const failedAt = this.now();
      const failed: TelegramStrategyRunResult = {
        status: "FAILED",
        requestedAt: startedAt,
        market,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        detail: "Strategy scheduler did not run because scheduler history could not be persisted.",
      };
      this.applyRunResult(market, failed, startedAt, failedAt);
      await this.reportSchedulerResult({
        market,
        result: failed,
        intervalMs: config.intervalMs,
        runOnStart: this.dependencies.config.runOnStart,
      });
      return failed;
    }

    const result = await this.dependencies.controller.requestRun({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      market,
      requestedBy: "SCHEDULER",
      requestedCommand: "SCHEDULER_TICK",
    });
    const completedAt = this.now();
    this.applyRunResult(market, result, startedAt, completedAt);
    await this.persistSchedulerRun({
      run: completeSchedulerRunRecord(runRecord, result, completedAt),
      update: true,
    });
    await this.reportSchedulerResult({
      market,
      result,
      intervalMs: config.intervalMs,
      runOnStart: this.dependencies.config.runOnStart,
    });
    return result;
  }

  private scheduleMarket(config: StrategySchedulerMarketConfig, delayMs: number): void {
    if (!this.started || !this.dependencies.config.enabled) {
      return;
    }

    const nextRunAt = new Date(Date.parse(this.now()) + delayMs).toISOString();
    this.updateMarketStatus(config.market, { nextRunAt });
    const timer = (this.dependencies.setTimer ?? setTimeout)(() => {
      this.timers.delete(config.market);
      void this.runMarketNow(config.market)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const completedAt = this.now();
          this.applyRunResult(config.market, {
            status: "FAILED",
            requestedAt: completedAt,
            market: config.market,
            strategyDecisionId: null,
            action: null,
            orderId: null,
            orderStatus: null,
            submissionAccepted: null,
            detail: `Strategy scheduler failed: ${message}`,
          }, completedAt, completedAt);
          void this.reportSchedulerResult({
            market: config.market,
            result: {
              status: "FAILED",
              requestedAt: completedAt,
              market: config.market,
              strategyDecisionId: null,
              action: null,
              orderId: null,
              orderStatus: null,
              submissionAccepted: null,
              detail: `Strategy scheduler failed: ${message}`,
            },
            intervalMs: config.intervalMs,
            runOnStart: this.dependencies.config.runOnStart,
          });
        })
        .finally(() => this.scheduleMarket(config, config.intervalMs));
    }, delayMs);

    this.timers.set(config.market, timer);
  }

  private async persistSchedulerRun(input: {
    run: StrategySchedulerRunRecord;
    update: boolean;
  }): Promise<boolean> {
    const repositories = this.dependencies.repositories;
    if (!repositories) {
      return true;
    }

    try {
      if (input.update) {
        await repositories.updateStrategySchedulerRun(input.run);
        return true;
      }

      await repositories.saveStrategySchedulerRun(input.run);
      return true;
    } catch {
      return false;
    }
  }

  private applyRunResult(
    market: SupportedMarket,
    result: TelegramStrategyRunResult,
    startedAt: string,
    completedAt: string,
  ): void {
    const current = this.statusByMarket.get(market);
    if (!current) {
      return;
    }

    const success = result.status === "COMPLETED";
    const skipped = result.status === "ALREADY_RUNNING";
    this.statusByMarket.set(market, {
      ...current,
      running: false,
      runCount: current.runCount + (skipped ? 0 : 1),
      successCount: current.successCount + (success ? 1 : 0),
      failureCount: current.failureCount + (!success && !skipped ? 1 : 0),
      skippedCount: current.skippedCount + (skipped ? 1 : 0),
      lastStartedAt: startedAt,
      lastCompletedAt: completedAt,
      lastStatus: result.status,
      lastStrategyDecisionId: result.strategyDecisionId,
      lastAction: result.action,
      lastOrderId: result.orderId,
      lastOrderStatus: result.orderStatus,
      lastError: success || skipped ? null : result.detail,
    });
  }

  private updateMarketStatus(
    market: SupportedMarket,
    patch: Partial<StrategySchedulerMarketStatus>,
  ): void {
    const current = this.statusByMarket.get(market);
    if (!current) {
      return;
    }

    this.statusByMarket.set(market, {
      ...current,
      ...patch,
    });
  }

  private async reportSchedulerResult(input: {
    market: SupportedMarket;
    result: TelegramStrategyRunResult;
    intervalMs: number;
    runOnStart: boolean;
  }): Promise<void> {
    if (!this.dependencies.reporter) {
      return;
    }

    const notification = buildSchedulerNotification({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      liveSendPath: this.dependencies.config.liveSendPath,
      ...input,
    });
    if (!notification) {
      return;
    }

    try {
      await this.dependencies.reporter.report(notification);
    } catch {
      // Scheduler execution outcomes must not be changed by Telegram reporting failures.
    }
  }

  private applyStartupBlock(preflight: StrategySchedulerStartupPreflight): void {
    for (const market of this.dependencies.config.markets) {
      this.updateMarketStatus(market.market, {
        running: false,
        nextRunAt: null,
        lastCompletedAt: preflight.checkedAt,
        lastStatus: "STARTUP_BLOCKED",
        lastError: preflight.detail,
      });
    }
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }
}

function buildSchedulerNotification(input: {
  exchangeAccountId: string;
  liveSendPath: StrategySchedulerConfig["liveSendPath"];
  market: SupportedMarket;
  result: TelegramStrategyRunResult;
  intervalMs: number;
  runOnStart: boolean;
}): Parameters<OperatorNotificationReporter["report"]>[0] | null {
  const payload = {
    market: input.market,
    intervalMs: input.intervalMs,
    runOnStart: input.runOnStart,
    liveSendPath: input.liveSendPath,
    strategyDecisionId: input.result.strategyDecisionId,
    action: input.result.action,
    orderId: input.result.orderId,
    orderStatus: input.result.orderStatus,
    submissionAccepted: input.result.submissionAccepted,
    requestedAt: input.result.requestedAt,
  };

  if (input.result.status === "FAILED") {
    return {
      exchangeAccountId: input.exchangeAccountId,
      notificationType: "SCHEDULER_RUN_FAILED",
      severity: "ERROR",
      title: "Scheduled strategy run failed",
      message: input.result.detail,
      payload,
    };
  }

  if (input.result.status === "ALREADY_RUNNING") {
    return {
      exchangeAccountId: input.exchangeAccountId,
      notificationType: "SCHEDULER_RUN_SKIPPED",
      severity: "WARN",
      title: "Scheduled strategy run skipped",
      message: input.result.detail,
      payload,
    };
  }

  if (input.result.orderId && input.result.submissionAccepted === true) {
    return {
      exchangeAccountId: input.exchangeAccountId,
      notificationType: "SCHEDULER_ORDER_SUBMITTED",
      severity: "INFO",
      title: "Scheduled strategy submitted an order",
      message: `${input.market} scheduled ${input.result.action ?? "UNKNOWN"} created order ${input.result.orderId}.`,
      payload,
    };
  }

  if (input.result.submissionAccepted === false) {
    return {
      exchangeAccountId: input.exchangeAccountId,
      notificationType: "SCHEDULER_ORDER_REJECTED",
      severity: "WARN",
      title: "Scheduled strategy order was rejected",
      message: input.result.detail,
      payload,
    };
  }

  return null;
}

function createSchedulerRunRecord(input: {
  exchangeAccountId: string;
  market: SupportedMarket;
  intervalMs: number;
  runOnStart: boolean;
  status: StrategySchedulerRunRecord["status"];
  startedAt: string;
  completedAt: string | null;
  result: TelegramStrategyRunResult | null;
}): StrategySchedulerRunRecord {
  return {
    id: createId("strategy_scheduler_run"),
    exchangeAccountId: input.exchangeAccountId,
    market: input.market,
    triggerSource: "SCHEDULER",
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    intervalMs: input.intervalMs,
    runOnStart: input.runOnStart,
    strategyDecisionId: input.result?.strategyDecisionId ?? null,
    action: input.result?.action ?? null,
    orderId: input.result?.orderId ?? null,
    orderStatus: input.result?.orderStatus ?? null,
    submissionAccepted: input.result?.submissionAccepted ?? null,
    detail: input.result?.detail ?? null,
    errorMessage: input.result && input.result.status !== "COMPLETED" && input.result.status !== "ALREADY_RUNNING"
      ? input.result.detail
      : null,
    summaryJson: JSON.stringify({
      status: input.status,
      market: input.market,
      intervalMs: input.intervalMs,
      runOnStart: input.runOnStart,
      result: input.result,
    }),
  };
}

function completeSchedulerRunRecord(
  started: StrategySchedulerRunRecord,
  result: TelegramStrategyRunResult,
  completedAt: string,
): StrategySchedulerRunRecord {
  const status = mapSchedulerRunStatus(result.status);
  return {
    ...started,
    status,
    completedAt,
    strategyDecisionId: result.strategyDecisionId,
    action: result.action,
    orderId: result.orderId,
    orderStatus: result.orderStatus,
    submissionAccepted: result.submissionAccepted,
    detail: result.detail,
    errorMessage: status === "FAILED" ? result.detail : null,
    summaryJson: JSON.stringify({
      status,
      market: started.market,
      intervalMs: started.intervalMs,
      runOnStart: started.runOnStart,
      result,
    }),
  };
}

function mapSchedulerRunStatus(
  status: TelegramStrategyRunResult["status"],
): StrategySchedulerRunRecord["status"] {
  if (status === "COMPLETED") {
    return "COMPLETED";
  }

  if (status === "ALREADY_RUNNING") {
    return "SKIPPED";
  }

  return "FAILED";
}

export function createDefaultStrategySchedulerConfig(input: {
  enabled: boolean;
  runOnStart: boolean;
  exchangeAccountId: string;
  liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  btcIntervalMs: number;
  ethIntervalMs: number;
}): StrategySchedulerConfig {
  return {
    enabled: input.enabled,
    runOnStart: input.runOnStart,
    exchangeAccountId: input.exchangeAccountId,
    liveSendPath: input.liveSendPath ?? "DRY_RUN_ADAPTER",
    startupPreflight: null,
    markets: [
      {
        market: "KRW-BTC",
        intervalMs: input.btcIntervalMs,
      },
      {
        market: "KRW-ETH",
        intervalMs: input.ethIntervalMs,
      },
    ],
  };
}

function createInitialMarketStatus(
  config: StrategySchedulerMarketConfig,
): StrategySchedulerMarketStatus {
  return {
    market: config.market,
    intervalMs: config.intervalMs,
    running: false,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastStatus: "NEVER_RUN",
    lastStrategyDecisionId: null,
    lastAction: null,
    lastOrderId: null,
    lastOrderStatus: null,
    lastError: null,
    nextRunAt: null,
  };
}
