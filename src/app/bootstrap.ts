import { App } from "./app.js";
import { loadConfig } from "../shared/config.js";
import { createLogger, serializeError } from "../shared/logger.js";

export async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({
    level: config.logLevel,
    scope: "autotrade-upbit"
  });
  const app = new App(config, logger);

  let shuttingDown = false;

  const shutdown = async (reason: string, error?: unknown): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    if (error) {
      logger.error("Shutdown triggered by fatal runtime condition", {
        reason,
        error: serializeError(error)
      });
      process.exitCode = 1;
    }

    const timeout = setTimeout(() => {
      logger.error("Graceful shutdown timeout exceeded", {
        reason,
        timeoutMs: config.runtime.gracefulShutdownTimeoutMs
      });
      process.exitCode = 1;
      process.exit();
    }, config.runtime.gracefulShutdownTimeoutMs);

    timeout.unref();

    try {
      await app.stop(reason);
    } finally {
      clearTimeout(timeout);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("unhandledRejection", (error) => {
    void shutdown("unhandledRejection", error);
  });

  process.on("uncaughtException", (error) => {
    void shutdown("uncaughtException", error);
  });

  try {
    await app.start();
  } catch (error) {
    logger.error("Application failed during bootstrap", {
      error: serializeError(error)
    });
    process.exitCode = 1;
    throw error;
  }
}
