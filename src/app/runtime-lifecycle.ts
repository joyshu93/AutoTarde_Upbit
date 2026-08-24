import type { StrategySchedulerStatus } from "../domain/types.js";
import type { TelegramInboundPollingStatus } from "../modules/telegram/inbound.js";

export interface RuntimeStopStep {
  readonly name: "telegram_inbound_polling" | "strategy_scheduler" | "sqlite_persistence";
  readonly status: "STOPPED" | "FAILED";
  readonly errorMessage: string | null;
}

export interface RuntimeStopSummary {
  readonly status: "STOPPED" | "PARTIAL_FAILURE";
  readonly steps: RuntimeStopStep[];
}

export interface RuntimeBackgroundStatus {
  readonly strategyScheduler: Pick<StrategySchedulerStatus, "started">;
  readonly telegramInboundPolling: Pick<TelegramInboundPollingStatus, "running">;
}

export interface RuntimeSignalHandler {
  readonly shutdown: (reason: string) => RuntimeStopSummary;
}

export type RuntimeShutdown = () => RuntimeStopSummary;

export interface RuntimeStoppableApp {
  readonly telegramInboundPolling: {
    stop(): TelegramInboundPollingStatus;
  };
  readonly strategyScheduler: {
    stop(): StrategySchedulerStatus;
  };
  readonly persistence: {
    close(): void;
  };
}

export interface RuntimeSignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): never | void;
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
      input.shutdown();
    } catch {
      // Preserve the startup error even if a future shutdown implementation throws.
    }
    throw error;
  }
}

export function hasBackgroundRuntime(status: RuntimeBackgroundStatus): boolean {
  return status.strategyScheduler.started || status.telegramInboundPolling.running;
}

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

  return {
    status: steps.some((step) => step.status === "FAILED") ? "PARTIAL_FAILURE" : "STOPPED",
    steps,
  };
}

export function createRuntimeShutdown(app: RuntimeStoppableApp): RuntimeShutdown {
  let stopped = false;
  let lastSummary: RuntimeStopSummary | null = null;

  return () => {
    if (!stopped) {
      stopped = true;
      lastSummary = stopAppRuntime(app);
    }

    return lastSummary ?? {
      status: "STOPPED",
      steps: [],
    };
  };
}

export function installRuntimeSignalHandlers(input: {
  app?: RuntimeStoppableApp;
  shutdown?: RuntimeShutdown;
  signalTarget?: RuntimeSignalTarget;
  writeLine?: (line: string) => void;
}): RuntimeSignalHandler {
  const signalTarget = input.signalTarget ?? process;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  const runtimeShutdown = input.shutdown ?? (input.app ? createRuntimeShutdown(input.app) : null);
  if (!runtimeShutdown) {
    throw new Error("Runtime signal handlers require an app or shutdown owner.");
  }
  let shutdownReported = false;

  const shutdown = (reason: string): RuntimeStopSummary => {
    const summary = runtimeShutdown();
    if (!shutdownReported) {
      shutdownReported = true;
      writeLine(JSON.stringify({
        service: "AutoTrade_Upbit",
        runtimeShutdownReason: reason,
        runtimeShutdown: summary,
      }, null, 2));
    }

    return summary;
  };

  signalTarget.on("SIGINT", () => {
    const summary = shutdown("SIGINT");
    signalTarget.exit(summary.status === "STOPPED" ? 0 : 1);
  });
  signalTarget.on("SIGTERM", () => {
    const summary = shutdown("SIGTERM");
    signalTarget.exit(summary.status === "STOPPED" ? 0 : 1);
  });

  return { shutdown };
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
    return {
      name,
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
