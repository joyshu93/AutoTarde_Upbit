import type { StrategySchedulerStatus } from "../domain/types.js";
import type { TelegramInboundPollingStatus } from "../modules/telegram/inbound.js";
import { RUNTIME_SHUTDOWN_TIMEOUT_MS } from "./runtime-heartbeat.js";
import type { RuntimeOwnershipContext } from "./runtime-ownership-context.js";

export interface RuntimeStopStep {
  readonly name:
    | "runtime_ownership_fence"
    | "telegram_inbound_polling"
    | "strategy_scheduler"
    | "workers_quiescence"
    | "runtime_ownership_release"
    | "sqlite_persistence"
    | "runtime_ownership_database"
    | "runtime_process_lock";
  readonly status: "STOPPED" | "SKIPPED" | "FAILED";
  readonly errorMessage: string | null;
}

export interface RuntimeStopSummary {
  readonly reason: string;
  readonly status: "STOPPED" | "PARTIAL_FAILURE";
  readonly steps: RuntimeStopStep[];
}

export interface RuntimeBackgroundStatus {
  readonly strategyScheduler: Pick<StrategySchedulerStatus, "started">;
  readonly telegramInboundPolling: Pick<TelegramInboundPollingStatus, "running">;
}

export interface RuntimeSignalHandler {
  readonly shutdown: RuntimeShutdown;
}

export type RuntimeShutdown = (reason: string) => Promise<RuntimeStopSummary>;
type LegacyRuntimeShutdown = () => RuntimeStopSummary;
type RuntimeSignalShutdown = (
  reason?: string,
) => RuntimeStopSummary | Promise<RuntimeStopSummary>;

export interface RuntimeStoppableApp {
  readonly telegramInboundPolling: {
    stop(): TelegramInboundPollingStatus;
    stopAndWait?(timeoutMs: number): Promise<TelegramInboundPollingStatus>;
  };
  readonly strategyScheduler: {
    stop(): StrategySchedulerStatus;
    stopAndWait?(timeoutMs: number): Promise<StrategySchedulerStatus>;
  };
  readonly persistence: {
    close(): void;
  };
}

export interface RuntimeSignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): never | void;
}

export interface RuntimeOwnershipLossSource {
  onLost(listener: (reason: string) => void): () => void;
}

export function installRuntimeOwnershipLossHandler(input: {
  shutdown: RuntimeShutdown;
  ownershipLossSource: RuntimeOwnershipLossSource;
  signalTarget?: RuntimeSignalTarget;
  writeLine?: (line: string) => void;
}): () => void {
  const signalTarget = input.signalTarget ?? process;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  let exitRequested = false;

  return input.ownershipLossSource.onLost((lossReason) => {
    if (lossReason === "RUNTIME_SHUTDOWN" || exitRequested) {
      return;
    }

    exitRequested = true;
    void input.shutdown("RUNTIME_OWNERSHIP_LOST")
      .then((runtimeShutdown) => {
        writeLine(JSON.stringify({
          service: "AutoTrade_Upbit",
          runtimeOwnershipLossReason: lossReason,
          runtimeShutdown,
        }, null, 2));
        signalTarget.exit(1);
      })
      .catch((error: unknown) => {
        writeLine(JSON.stringify({
          service: "AutoTrade_Upbit",
          runtimeOwnershipLossReason: lossReason,
          runtimeShutdownError: error instanceof Error ? error.message : String(error),
        }, null, 2));
        signalTarget.exit(1);
      });
  });
}

export interface RuntimeStartupInitializer {
  initialize(): Promise<unknown>;
}

export async function runRuntimeStartupGate<T>(input: {
  initializer: RuntimeStartupInitializer | null;
  continueStartup(): Promise<T>;
  shutdown(): unknown;
}): Promise<T> {
  try {
    await input.initializer?.initialize();
    return await input.continueStartup();
  } catch (error) {
    try {
      await input.shutdown();
    } catch {
      // Preserve the startup error even if cleanup unexpectedly rejects.
    }
    throw error;
  }
}

export function hasBackgroundRuntime(status: RuntimeBackgroundStatus): boolean {
  return status.strategyScheduler.started || status.telegramInboundPolling.running;
}

// Read-only smoke compositions still use this synchronous, app-only cleanup path.
export function stopAppRuntime(app: RuntimeStoppableApp): RuntimeStopSummary {
  const steps: RuntimeStopStep[] = [
    stopStep("telegram_inbound_polling", () => {
      app.telegramInboundPolling.stop();
    }),
    stopStep("strategy_scheduler", () => {
      app.strategyScheduler.stop();
    }),
    stopStep("sqlite_persistence", () => {
      app.persistence.close();
    }),
  ];

  return createStopSummary("LEGACY_APP_SHUTDOWN", steps);
}

export function createRuntimeShutdown(app: RuntimeStoppableApp): LegacyRuntimeShutdown;
export function createRuntimeShutdown(
  app: RuntimeStoppableApp,
  runtimeOwnership: RuntimeOwnershipContext,
  options?: {
    readonly timeoutMs?: number;
    readonly nowEpochMs?: () => number;
  },
): RuntimeShutdown;
export function createRuntimeShutdown(
  app: RuntimeStoppableApp,
  runtimeOwnership?: RuntimeOwnershipContext,
  options: {
    readonly timeoutMs?: number;
    readonly nowEpochMs?: () => number;
  } = {},
): RuntimeShutdown | LegacyRuntimeShutdown {
  if (!runtimeOwnership) {
    let summary: RuntimeStopSummary | null = null;
    return () => {
      summary ??= stopAppRuntime(app);
      return summary;
    };
  }

  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS);
  const nowEpochMs = options.nowEpochMs ?? Date.now;
  let shutdownPromise: Promise<RuntimeStopSummary> | null = null;

  return (reason: string) => {
    shutdownPromise ??= stopOwnedAppRuntime({
      app,
      runtimeOwnership,
      reason,
      timeoutMs,
      nowEpochMs,
    });
    return shutdownPromise;
  };
}

export function installRuntimeSignalHandlers(input: {
  app?: RuntimeStoppableApp;
  shutdown?: RuntimeSignalShutdown;
  ownershipLossSource?: RuntimeOwnershipLossSource;
  signalTarget?: RuntimeSignalTarget;
  writeLine?: (line: string) => void;
}): RuntimeSignalHandler {
  const signalTarget = input.signalTarget ?? process;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  const suppliedShutdown = input.shutdown ?? (input.app ? createRuntimeShutdown(input.app) : null);
  if (!suppliedShutdown) {
    throw new Error("Runtime signal handlers require an app or shutdown owner.");
  }

  let shutdownReported = false;
  const shutdown: RuntimeShutdown = (reason) => Promise.resolve(suppliedShutdown(reason));

  const reportShutdown = (reason: string, summary: RuntimeStopSummary, lossReason?: string): void => {
    if (shutdownReported) return;
    shutdownReported = true;
    writeLine(JSON.stringify({
      service: "AutoTrade_Upbit",
      runtimeShutdownReason: reason,
      ...(lossReason === undefined ? {} : { runtimeOwnershipLossReason: lossReason }),
      runtimeShutdown: summary,
    }, null, 2));
  };

  const shutdownAndExit = async (
    reason: string,
    forcedExitCode?: number,
    lossReason?: string,
  ): Promise<void> => {
    const summary = await shutdown(reason);
    reportShutdown(reason, summary, lossReason);
    signalTarget.exit(forcedExitCode ?? (summary.status === "STOPPED" ? 0 : 1));
  };

  signalTarget.on("SIGINT", () => {
    void shutdownAndExit("SIGINT");
  });
  signalTarget.on("SIGTERM", () => {
    void shutdownAndExit("SIGTERM");
  });
  input.ownershipLossSource?.onLost((lossReason) => {
    if (lossReason === "RUNTIME_SHUTDOWN") return;
    void shutdownAndExit("RUNTIME_OWNERSHIP_LOST", 1, lossReason);
  });

  return { shutdown };
}

async function stopOwnedAppRuntime(input: {
  app: RuntimeStoppableApp;
  runtimeOwnership: RuntimeOwnershipContext;
  reason: string;
  timeoutMs: number;
  nowEpochMs(): number;
}): Promise<RuntimeStopSummary> {
  const steps: RuntimeStopStep[] = [];
  const initialOwnership = input.runtimeOwnership.snapshot();

  const fenceStep = stopStep("runtime_ownership_fence", () => {
    input.runtimeOwnership.fence("RUNTIME_SHUTDOWN");
  });
  steps.push(fenceStep);

  const telegramStopStep = stopStep("telegram_inbound_polling", () => {
    input.app.telegramInboundPolling.stop();
  });
  steps.push(telegramStopStep);

  const schedulerStopStep = stopStep("strategy_scheduler", () => {
    input.app.strategyScheduler.stop();
  });
  steps.push(schedulerStopStep);

  const quiescenceStep = await stopAsyncStep("workers_quiescence", async () => {
    const telegramWait = input.app.telegramInboundPolling.stopAndWait?.(input.timeoutMs) ??
      Promise.resolve(input.app.telegramInboundPolling.stop());
    const schedulerWait = input.app.strategyScheduler.stopAndWait?.(input.timeoutMs) ??
      Promise.resolve(input.app.strategyScheduler.stop());
    const [telegramStatus, schedulerStatus] = await waitWithTimeout(
      Promise.all([
        telegramWait,
        schedulerWait,
        input.runtimeOwnership.heartbeat.stop(),
      ]).then(([telegram, scheduler]) => [telegram, scheduler] as const),
      input.timeoutMs,
    );

    if (
      telegramStatus.running ||
      schedulerStatus.markets.some((market) => market.running)
    ) {
      throw new Error("Runtime workers did not quiesce before the shutdown timeout.");
    }
  });
  steps.push(quiescenceStep);

  const canRelease = initialOwnership.status === "OWNED" &&
    fenceStep.status === "STOPPED" &&
    telegramStopStep.status === "STOPPED" &&
    schedulerStopStep.status === "STOPPED" &&
    quiescenceStep.status === "STOPPED";
  if (!canRelease) {
    steps.push(skippedStep(
      "runtime_ownership_release",
      initialOwnership.status === "OWNED"
        ? "runtime_not_quiesced"
        : "runtime_ownership_not_current",
    ));
  } else {
    steps.push(await stopAsyncStep("runtime_ownership_release", async () => {
      const released = await input.runtimeOwnership.releaseCurrentOwnership(input.nowEpochMs());
      if (!released) {
        throw new Error("Exact runtime ownership release was not accepted.");
      }
    }));
  }

  steps.push(stopStep("sqlite_persistence", () => {
    input.app.persistence.close();
  }));
  steps.push(stopStep("runtime_ownership_database", () => {
    input.runtimeOwnership.closeOwnershipDatabase();
  }));
  steps.push(await stopAsyncStep("runtime_process_lock", async () => {
    await input.runtimeOwnership.releaseProcessLock();
  }));

  return createStopSummary(input.reason, steps);
}

function createStopSummary(reason: string, steps: RuntimeStopStep[]): RuntimeStopSummary {
  return {
    reason,
    status: steps.some((step) => step.status === "FAILED") ? "PARTIAL_FAILURE" : "STOPPED",
    steps,
  };
}

function stopStep(
  name: RuntimeStopStep["name"],
  stop: () => void,
): RuntimeStopStep {
  try {
    stop();
    return {
      name,
      status: "STOPPED",
      errorMessage: null,
    };
  } catch (error) {
    return failedStep(name, error);
  }
}

async function stopAsyncStep(
  name: RuntimeStopStep["name"],
  stop: () => Promise<void>,
): Promise<RuntimeStopStep> {
  try {
    await stop();
    return {
      name,
      status: "STOPPED",
      errorMessage: null,
    };
  } catch (error) {
    return failedStep(name, error);
  }
}

function failedStep(name: RuntimeStopStep["name"], error: unknown): RuntimeStopStep {
  return {
    name,
    status: "FAILED",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function skippedStep(name: RuntimeStopStep["name"], reason: string): RuntimeStopStep {
  return {
    name,
    status: "SKIPPED",
    errorMessage: reason,
  };
}

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Runtime shutdown timeout must be a finite non-negative number.");
  }
  return Math.trunc(timeoutMs);
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Runtime worker quiescence timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
