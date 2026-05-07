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

export function installRuntimeSignalHandlers(input: {
  app: RuntimeStoppableApp;
  signalTarget?: RuntimeSignalTarget;
  writeLine?: (line: string) => void;
}): RuntimeSignalHandler {
  const signalTarget = input.signalTarget ?? process;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  let alreadyStopped = false;
  let lastSummary: RuntimeStopSummary | null = null;

  const shutdown = (reason: string): RuntimeStopSummary => {
    if (!alreadyStopped) {
      alreadyStopped = true;
      lastSummary = stopAppRuntime(input.app);
      writeLine(JSON.stringify({
        service: "AutoTrade_Upbit",
        runtimeShutdownReason: reason,
        runtimeShutdown: lastSummary,
      }, null, 2));
    }

    return lastSummary ?? {
      status: "STOPPED",
      steps: [],
    };
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
