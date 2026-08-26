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
import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "./runtime-ownership-guard.js";

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

export interface StrategySchedulerAccountRefreshResult {
  status: "COMPLETED" | "FAILED";
  requestedAt: string;
  detail: string;
}

export interface StrategySchedulerStopStatus extends StrategySchedulerStatus {
  readonly quiesced: boolean;
}

export type StrategySchedulerRunPreparationOwner = "SCHEDULER" | "CONTROLLER";

type StrategySchedulerRunPreparationOwnerResolver = (
  market: SupportedMarket,
) => StrategySchedulerRunPreparationOwner;

type StrategySchedulerDependencies = {
  config: StrategySchedulerConfig;
  controller: TelegramStrategyRunController;
  repositories?: Pick<ExecutionRepository, "saveStrategySchedulerRun" | "updateStrategySchedulerRun">;
  reporter?: OperatorNotificationReporter;
  beforeRunAccountRefresh?: () => Promise<StrategySchedulerAccountRefreshResult | null>;
  beforeRunPreflight?: () => Promise<StrategySchedulerStartupPreflight | null>;
  resolveRunPreparationOwner?: StrategySchedulerRunPreparationOwnerResolver;
  runtimeOwnership?: RuntimeOwnershipAuthority;
  now?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => SchedulerTimer;
  clearTimer?: (timer: SchedulerTimer) => void;
};

type StrategySchedulerResolverDescriptor =
  | { kind: "ABSENT" }
  | {
    kind: "DATA";
    value: unknown;
    writable: boolean;
    enumerable: boolean;
    configurable: boolean;
  }
  | {
    kind: "ACCESSOR";
    get: (() => unknown) | undefined;
    set: ((value: unknown) => void) | undefined;
    enumerable: boolean;
    configurable: boolean;
  };

interface StrategySchedulerRunPreparationOwnerAuthority {
  descriptor: StrategySchedulerResolverDescriptor;
  resolver: StrategySchedulerRunPreparationOwnerResolver | undefined;
  initialFailure: string | null;
}

type SchedulerTimer = ReturnType<typeof setTimeout>;
const SCHEDULER_BATCH_KEY_GRANULARITY_MS = 1_000;

export class StrategyScheduler {
  private started = false;
  private stopBegun = false;
  private startupBlockReported = false;
  private readonly timers = new Map<SupportedMarket, SchedulerTimer>();
  private readonly statusByMarket = new Map<SupportedMarket, StrategySchedulerMarketStatus>();
  private readonly inFlightRuns = new Set<Promise<TelegramStrategyRunResult>>();
  private startupPreflight: StrategySchedulerStartupPreflight | null;
  private accountRefreshInFlight: Promise<StrategySchedulerAccountRefreshResult | null> | null = null;
  private scheduledRunQueue: Promise<void> = Promise.resolve();
  private orderSubmittedBatchKey: string | null = null;
  private readonly runPreparationOwnerAuthority: StrategySchedulerRunPreparationOwnerAuthority;
  private readonly runtimeOwnership: RuntimeOwnershipAuthority;

  constructor(
    private readonly dependencies: StrategySchedulerDependencies,
  ) {
    this.runPreparationOwnerAuthority = snapshotRunPreparationOwnerAuthority(dependencies);
    this.runtimeOwnership = dependencies.runtimeOwnership ?? createUnavailableRuntimeOwnershipAuthority();
    this.startupPreflight = dependencies.config.startupPreflight ?? null;
    for (const market of dependencies.config.markets) {
      this.statusByMarket.set(market.market, createInitialMarketStatus(market));
    }
  }

  setStartupPreflight(preflight: StrategySchedulerStartupPreflight | null): void {
    this.startupPreflight = preflight;
    this.startupBlockReported = false;
  }

  start(): StrategySchedulerStatus {
    if (this.stopBegun) {
      throw new Error("Strategy scheduler cannot start after stop has begun.");
    }
    if (!this.dependencies.config.enabled || this.started) {
      return this.getStatus();
    }

    if (this.startupPreflight?.status === "BLOCK") {
      this.applyStartupBlock(this.startupPreflight);
      return this.getStatus();
    }

    this.started = true;
    if (this.dependencies.config.runOnStart) {
      void this.runMarketsOnStartSequentially();
      return this.getStatus();
    }

    for (const market of this.dependencies.config.markets) {
      this.scheduleMarket(market, market.intervalMs);
    }

    return this.getStatus();
  }

  async reportStartupBlockIfNeeded(): Promise<boolean> {
    if (this.startupPreflight?.status !== "BLOCK" || this.startupBlockReported) {
      return false;
    }

    this.startupBlockReported = true;
    await this.reportSchedulerStartupBlock(this.startupPreflight);
    return true;
  }

  stop(): StrategySchedulerStatus {
    this.stopBegun = true;
    for (const timer of this.timers.values()) {
      (this.dependencies.clearTimer ?? clearTimeout)(timer);
    }

    this.timers.clear();
    this.started = false;
    for (const market of this.dependencies.config.markets) {
      this.updateMarketStatus(market.market, {
        nextRunAt: null,
      });
    }

    return this.getStatus();
  }

  async stopAndWait(timeoutMs: number): Promise<StrategySchedulerStopStatus> {
    this.stop();
    const pending = [
      ...this.inFlightRuns,
      this.scheduledRunQueue,
    ];
    const quiesced = await waitForWorkOrTimeout(Promise.allSettled(pending), timeoutMs);
    return {
      ...this.getStatus(),
      quiesced,
    };
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

  runMarketNow(market: SupportedMarket): Promise<TelegramStrategyRunResult> {
    try {
      this.runtimeOwnership.assertLocallyHeld();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.stopBegun) {
      return Promise.reject(new Error("Strategy scheduler cannot run after stop has begun."));
    }

    const run = this.executeMarketNow(market);
    this.inFlightRuns.add(run);
    void run.then(
      () => this.inFlightRuns.delete(run),
      () => this.inFlightRuns.delete(run),
    );
    return run;
  }

  private async executeMarketNow(market: SupportedMarket): Promise<TelegramStrategyRunResult> {
    this.runtimeOwnership.assertLocallyHeld();
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
        submissionOutcome: null,
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

    let preparationOwner: StrategySchedulerRunPreparationOwner;
    try {
      preparationOwner = this.resolveRunPreparationOwner(market);
    } catch (error) {
      if (isRuntimeOwnershipFailure(error)) throw error;
      this.runtimeOwnership.assertLocallyHeld();
      return this.recordPreparationOwnershipFailure({
        market,
        config,
        startedAt,
        error,
      });
    }

    if (preparationOwner === "SCHEDULER" && this.dependencies.beforeRunAccountRefresh) {
      let refresh: StrategySchedulerAccountRefreshResult | null = null;
      try {
        refresh = await this.runBeforeRunAccountRefresh();
      } catch (error) {
        if (isRuntimeOwnershipFailure(error)) throw error;
        this.runtimeOwnership.assertLocallyHeld();
        const failedAt = this.now();
        const failed = createFailedRunResult({
          requestedAt: startedAt,
          market,
          detail: `Strategy scheduler account refresh failed before run: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        this.applyRunResult(market, failed, startedAt, failedAt);
        await this.persistSchedulerRun({
          run: createSchedulerRunRecord({
            exchangeAccountId: this.dependencies.config.exchangeAccountId,
            market,
            intervalMs: config.intervalMs,
            runOnStart: this.dependencies.config.runOnStart,
            status: "FAILED",
            startedAt,
            completedAt: failedAt,
            result: failed,
          }),
          update: false,
        });
        await this.reportSchedulerResult({
          market,
          result: failed,
          intervalMs: config.intervalMs,
          runOnStart: this.dependencies.config.runOnStart,
        });
        return failed;
      }
      this.runtimeOwnership.assertLocallyHeld();

      if (refresh?.status === "FAILED") {
        const failedAt = this.now();
        const failed = createFailedRunResult({
          requestedAt: startedAt,
          market,
          detail: `Strategy scheduler account refresh failed before run: ${refresh.detail}`,
        });
        this.applyRunResult(market, failed, startedAt, failedAt);
        await this.persistSchedulerRun({
          run: createSchedulerRunRecord({
            exchangeAccountId: this.dependencies.config.exchangeAccountId,
            market,
            intervalMs: config.intervalMs,
            runOnStart: this.dependencies.config.runOnStart,
            status: "FAILED",
            startedAt,
            completedAt: failedAt,
            result: failed,
          }),
          update: false,
        });
        await this.reportSchedulerResult({
          market,
          result: failed,
          intervalMs: config.intervalMs,
          runOnStart: this.dependencies.config.runOnStart,
        });
        return failed;
      }
    }

    const beforeRunPreflight = preparationOwner === "SCHEDULER"
      ? this.dependencies.beforeRunPreflight
      : undefined;
    if (beforeRunPreflight) {
      let preflight: StrategySchedulerStartupPreflight | null = null;
      try {
        preflight = await beforeRunPreflight();
      } catch (error) {
        if (isRuntimeOwnershipFailure(error)) throw error;
        this.runtimeOwnership.assertLocallyHeld();
        const failedAt = this.now();
        const failed = createFailedRunResult({
          requestedAt: startedAt,
          market,
          detail: `Strategy scheduler preflight failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.applyRunResult(market, failed, startedAt, failedAt);
        await this.persistSchedulerRun({
          run: createSchedulerRunRecord({
            exchangeAccountId: this.dependencies.config.exchangeAccountId,
            market,
            intervalMs: config.intervalMs,
            runOnStart: this.dependencies.config.runOnStart,
            status: "FAILED",
            startedAt,
            completedAt: failedAt,
            result: failed,
          }),
          update: false,
        });
        await this.reportSchedulerResult({
          market,
          result: failed,
          intervalMs: config.intervalMs,
          runOnStart: this.dependencies.config.runOnStart,
        });
        return failed;
      }
      this.runtimeOwnership.assertLocallyHeld();

      if (preflight?.status === "BLOCK") {
        const blockedAt = this.now();
        const blocked = createFailedRunResult({
          requestedAt: startedAt,
          market,
          detail: `Strategy scheduler blocked before run: ${preflight.detail}`,
        });
        this.applyRunResult(market, blocked, startedAt, blockedAt);
        await this.persistSchedulerRun({
          run: createSchedulerRunRecord({
            exchangeAccountId: this.dependencies.config.exchangeAccountId,
            market,
            intervalMs: config.intervalMs,
            runOnStart: this.dependencies.config.runOnStart,
            status: "FAILED",
            startedAt,
            completedAt: blockedAt,
            result: blocked,
          }),
          update: false,
        });
        await this.reportSchedulerResult({
          market,
          result: blocked,
          intervalMs: config.intervalMs,
          runOnStart: this.dependencies.config.runOnStart,
        });
        return blocked;
      }
    }

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
        submissionOutcome: null,
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
    this.runtimeOwnership.assertLocallyHeld();
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

  private async runBeforeRunAccountRefresh(): Promise<StrategySchedulerAccountRefreshResult | null> {
    if (!this.dependencies.beforeRunAccountRefresh) {
      return null;
    }

    if (!this.accountRefreshInFlight) {
      this.accountRefreshInFlight = this.dependencies.beforeRunAccountRefresh()
        .finally(() => {
          this.accountRefreshInFlight = null;
        });
    }

    return this.accountRefreshInFlight;
  }

  private resolveRunPreparationOwner(market: SupportedMarket): StrategySchedulerRunPreparationOwner {
    const authority = this.runPreparationOwnerAuthority;
    const currentDescriptor = snapshotResolverDescriptor(this.dependencies);
    if (!resolverDescriptorsMatch(authority.descriptor, currentDescriptor)) {
      throw new Error("Scheduler preparation ownership resolver authority changed after scheduler construction.");
    }

    if (hasInheritedResolverAuthority(this.dependencies)) {
      throw new Error("Scheduler preparation ownership resolver authority must not be inherited.");
    }

    if (authority.initialFailure) {
      throw new Error(authority.initialFailure);
    }

    const resolver = authority.resolver;
    const owner = resolver ? resolver(market) : "SCHEDULER";
    if (owner === "SCHEDULER" || owner === "CONTROLLER") {
      return owner;
    }

    throw new Error(`Unsupported scheduler preparation ownership: ${String(owner)}`);
  }

  private async recordPreparationOwnershipFailure(input: {
    market: SupportedMarket;
    config: StrategySchedulerMarketConfig;
    startedAt: string;
    error: unknown;
  }): Promise<TelegramStrategyRunResult> {
    const failedAt = this.now();
    const failed = createFailedRunResult({
      requestedAt: input.startedAt,
      market: input.market,
      detail: `Strategy scheduler preparation ownership failed before run: ${
        input.error instanceof Error ? input.error.message : String(input.error)
      }`,
    });
    this.applyRunResult(input.market, failed, input.startedAt, failedAt);
    await this.persistSchedulerRun({
      run: createSchedulerRunRecord({
        exchangeAccountId: this.dependencies.config.exchangeAccountId,
        market: input.market,
        intervalMs: input.config.intervalMs,
        runOnStart: this.dependencies.config.runOnStart,
        status: "FAILED",
        startedAt: input.startedAt,
        completedAt: failedAt,
        result: failed,
      }),
      update: false,
    });
    await this.reportSchedulerResult({
      market: input.market,
      result: failed,
      intervalMs: input.config.intervalMs,
      runOnStart: this.dependencies.config.runOnStart,
    });
    return failed;
  }

  private scheduleMarket(config: StrategySchedulerMarketConfig, delayMs: number): void {
    if (!this.started || !this.dependencies.config.enabled) {
      return;
    }

    const nextRunAt = new Date(Date.parse(this.now()) + delayMs).toISOString();
    const batchKey = buildSchedulerBatchKey(nextRunAt);
    this.updateMarketStatus(config.market, { nextRunAt });
    const timer = (this.dependencies.setTimer ?? setTimeout)(() => {
      this.timers.delete(config.market);
      void this.enqueueScheduledMarketRun(config, batchKey)
        .finally(() => this.scheduleMarket(config, config.intervalMs));
    }, delayMs);

    this.timers.set(config.market, timer);
  }

  private async runMarketsOnStartSequentially(): Promise<void> {
    for (const market of this.dependencies.config.markets) {
      if (!this.started || !this.dependencies.config.enabled) {
        return;
      }

      await this.runScheduledMarket(market);
      this.scheduleMarket(market, market.intervalMs);
    }
  }

  private async runScheduledMarket(config: StrategySchedulerMarketConfig): Promise<TelegramStrategyRunResult> {
    try {
      return await this.runMarketNow(config.market);
    } catch (error) {
      if (isRuntimeOwnershipFailure(error)) throw error;
      this.runtimeOwnership.assertLocallyHeld();
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = this.now();
      const result = {
        status: "FAILED" as const,
        requestedAt: completedAt,
        market: config.market,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        submissionOutcome: null,
        detail: `Strategy scheduler failed: ${message}`,
      };

      this.applyRunResult(config.market, result, completedAt, completedAt);
      await this.reportSchedulerResult({
        market: config.market,
        result,
        intervalMs: config.intervalMs,
        runOnStart: this.dependencies.config.runOnStart,
      });
      return result;
    }
  }

  private enqueueScheduledMarketRun(config: StrategySchedulerMarketConfig, batchKey: string): Promise<void> {
    const queuedRun = this.scheduledRunQueue.then(async () => {
      if (!this.started || !this.dependencies.config.enabled) {
        return;
      }

      if (this.orderSubmittedBatchKey === batchKey) {
        await this.recordSkippedScheduledRun(
          config,
          `A scheduled order was submitted earlier in the same scheduler batch; deferring ${config.market} until its next scheduled interval.`,
        );
        return;
      }

      const result = await this.runScheduledMarket(config);
      if (this.wasLiveOrderSubmitted(result)) {
        this.orderSubmittedBatchKey = batchKey;
      }
    });
    this.scheduledRunQueue = queuedRun.catch(() => undefined);
    return queuedRun;
  }

  private async recordSkippedScheduledRun(
    config: StrategySchedulerMarketConfig,
    detail: string,
  ): Promise<TelegramStrategyRunResult> {
    const skippedAt = this.now();
    const result: TelegramStrategyRunResult = {
      status: "SKIPPED",
      requestedAt: skippedAt,
      market: config.market,
      strategyDecisionId: null,
      action: null,
      orderId: null,
      orderStatus: null,
      submissionAccepted: null,
      submissionOutcome: null,
      detail,
    };

    this.applyRunResult(config.market, result, skippedAt, skippedAt);
    await this.persistSchedulerRun({
      run: createSchedulerRunRecord({
        exchangeAccountId: this.dependencies.config.exchangeAccountId,
        market: config.market,
        intervalMs: config.intervalMs,
        runOnStart: this.dependencies.config.runOnStart,
        status: "SKIPPED",
        startedAt: skippedAt,
        completedAt: skippedAt,
        result,
      }),
      update: false,
    });
    await this.reportSchedulerResult({
      market: config.market,
      result,
      intervalMs: config.intervalMs,
      runOnStart: this.dependencies.config.runOnStart,
    });

    return result;
  }

  private wasLiveOrderSubmitted(result: TelegramStrategyRunResult): boolean {
    return (
      this.dependencies.config.liveSendPath === "LIVE_ADAPTER" &&
      result.status === "COMPLETED" &&
      Boolean(result.orderId) &&
      result.submissionAccepted === true
    );
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
      this.runtimeOwnership.assertLocallyHeld();
      if (input.update) {
        await repositories.updateStrategySchedulerRun(input.run);
        this.runtimeOwnership.assertLocallyHeld();
        return true;
      }

      await repositories.saveStrategySchedulerRun(input.run);
      this.runtimeOwnership.assertLocallyHeld();
      return true;
    } catch (error) {
      if (isRuntimeOwnershipFailure(error)) throw error;
      this.runtimeOwnership.assertLocallyHeld();
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
    const skipped = result.status === "ALREADY_RUNNING" || result.status === "SKIPPED";
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
      this.runtimeOwnership.assertLocallyHeld();
      await this.dependencies.reporter.report(notification);
      this.runtimeOwnership.assertLocallyHeld();
    } catch (error) {
      if (isRuntimeOwnershipFailure(error)) throw error;
      this.runtimeOwnership.assertLocallyHeld();
      // Scheduler execution outcomes must not be changed by Telegram reporting failures.
    }
  }

  private async reportSchedulerStartupBlock(
    preflight: StrategySchedulerStartupPreflight,
  ): Promise<void> {
    if (!this.dependencies.reporter) {
      return;
    }

    try {
      await this.dependencies.reporter.report({
        exchangeAccountId: this.dependencies.config.exchangeAccountId,
        notificationType: "SCHEDULER_STARTUP_BLOCKED",
        severity: "ERROR",
        title: "Strategy scheduler startup blocked",
        message: preflight.detail,
        payload: {
          checkedAt: preflight.checkedAt,
          scope: preflight.scope,
          status: preflight.status,
          liveSendPath: this.dependencies.config.liveSendPath,
          checks: preflight.checks,
        },
      });
    } catch {
      // Startup safety decisions must not be changed by Telegram reporting failures.
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

function createUnavailableRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  return {
    snapshot: () => ({
      status: "UNOWNED", generation: null, executionMode: null, acquiredAtEpochMs: null,
      heartbeatAtEpochMs: null, expiresAtEpochMs: null, takeover: false, lossReason: null,
    }),
    assertLocallyHeld: throwRuntimeOwnershipNotHeld,
    async assertCurrent(): Promise<never> { return throwRuntimeOwnershipNotHeld(); },
  };
}

function throwRuntimeOwnershipNotHeld(): never {
  throw new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_NOT_HELD",
    "RUNTIME_OWNERSHIP_NOT_HELD: Runtime ownership is unavailable in this composition.",
  );
}

function isRuntimeOwnershipFailure(error: unknown): boolean {
  return error instanceof RuntimeOwnershipGuardError ||
    (error instanceof Error && /^RUNTIME_OWNERSHIP_(?:LOST|NOT_HELD):/u.test(error.message));
}

async function waitForWorkOrTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Strategy scheduler stop timeout must be a finite non-negative number.");
  }

  let quiesced = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.trunc(timeoutMs));
  });
  try {
    await Promise.race([
      promise.then(() => {
        quiesced = true;
      }),
      timeout,
    ]);
    return quiesced;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function snapshotRunPreparationOwnerAuthority(
  dependencies: StrategySchedulerDependencies,
): StrategySchedulerRunPreparationOwnerAuthority {
  const descriptor = snapshotResolverDescriptor(dependencies);
  const inheritedAuthority = hasInheritedResolverAuthority(dependencies);

  if (descriptor.kind === "ACCESSOR") {
    return {
      descriptor,
      resolver: undefined,
      initialFailure: "Scheduler preparation ownership resolver authority must be an own data property, not an accessor.",
    };
  }

  if (inheritedAuthority) {
    return {
      descriptor,
      resolver: undefined,
      initialFailure: "Scheduler preparation ownership resolver authority must not be inherited.",
    };
  }

  if (descriptor.kind === "DATA" && descriptor.value !== undefined && typeof descriptor.value !== "function") {
    return {
      descriptor,
      resolver: undefined,
      initialFailure: "Scheduler preparation ownership resolver authority must be a function or undefined.",
    };
  }

  return {
    descriptor,
    resolver: descriptor.kind === "DATA" && typeof descriptor.value === "function"
      ? descriptor.value as StrategySchedulerRunPreparationOwnerResolver
      : undefined,
    initialFailure: null,
  };
}

function snapshotResolverDescriptor(
  dependencies: StrategySchedulerDependencies,
): StrategySchedulerResolverDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, "resolveRunPreparationOwner");
  if (!descriptor) {
    return { kind: "ABSENT" };
  }

  if ("value" in descriptor || "writable" in descriptor) {
    return {
      kind: "DATA",
      value: descriptor.value,
      writable: descriptor.writable === true,
      enumerable: descriptor.enumerable === true,
      configurable: descriptor.configurable === true,
    };
  }

  return {
    kind: "ACCESSOR",
    get: descriptor.get,
    set: descriptor.set,
    enumerable: descriptor.enumerable === true,
    configurable: descriptor.configurable === true,
  };
}

function hasInheritedResolverAuthority(dependencies: StrategySchedulerDependencies): boolean {
  let prototype = Object.getPrototypeOf(dependencies) as object | null;
  while (prototype) {
    if (Object.getOwnPropertyDescriptor(prototype, "resolveRunPreparationOwner")) {
      return true;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  return false;
}

function resolverDescriptorsMatch(
  expected: StrategySchedulerResolverDescriptor,
  actual: StrategySchedulerResolverDescriptor,
): boolean {
  if (expected.kind !== actual.kind) {
    return false;
  }

  if (expected.kind === "ABSENT" || actual.kind === "ABSENT") {
    return true;
  }

  if (expected.kind === "DATA" && actual.kind === "DATA") {
    return expected.value === actual.value &&
      expected.writable === actual.writable &&
      expected.enumerable === actual.enumerable &&
      expected.configurable === actual.configurable;
  }

  if (expected.kind === "ACCESSOR" && actual.kind === "ACCESSOR") {
    return expected.get === actual.get &&
      expected.set === actual.set &&
      expected.enumerable === actual.enumerable &&
      expected.configurable === actual.configurable;
  }

  return false;
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
    submissionOutcome: input.result.submissionOutcome ?? null,
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

  if (input.result.status === "ALREADY_RUNNING" || input.result.status === "SKIPPED") {
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

  if (input.result.submissionOutcome === "REJECTED" || (
    input.result.submissionOutcome === undefined && input.result.submissionAccepted === false
  )) {
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

function createFailedRunResult(input: {
  requestedAt: string;
  market: SupportedMarket;
  detail: string;
}): TelegramStrategyRunResult {
  return {
    status: "FAILED",
    requestedAt: input.requestedAt,
    market: input.market,
    strategyDecisionId: null,
    action: null,
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    submissionOutcome: null,
    detail: input.detail,
  };
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
    errorMessage: isSchedulerRunError(input.result) ? input.result.detail : null,
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

  if (status === "ALREADY_RUNNING" || status === "SKIPPED") {
    return "SKIPPED";
  }

  return "FAILED";
}

function isSchedulerRunError(result: TelegramStrategyRunResult | null): result is TelegramStrategyRunResult {
  return Boolean(
    result &&
      result.status !== "COMPLETED" &&
      result.status !== "ALREADY_RUNNING" &&
      result.status !== "SKIPPED",
  );
}

function buildSchedulerBatchKey(nextRunAt: string): string {
  const timestamp = Date.parse(nextRunAt);
  if (!Number.isFinite(timestamp)) {
    return nextRunAt;
  }

  return new Date(
    Math.floor(timestamp / SCHEDULER_BATCH_KEY_GRANULARITY_MS) * SCHEDULER_BATCH_KEY_GRANULARITY_MS,
  ).toISOString();
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
