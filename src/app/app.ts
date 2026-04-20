import type { Logger } from "../shared/logger.js";
import { serializeError } from "../shared/logger.js";
import type { AppConfig } from "../shared/config.js";
import { summarizeConfig } from "../shared/config.js";
import { createRuntimeModules, type RuntimeModule } from "./module-registry.js";

export class App {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #modules: RuntimeModule[];

  #heartbeatTimer: NodeJS.Timeout | null = null;
  #tickInFlight: Promise<void> | null = null;
  #running = false;
  #loggedLoopReady = false;

  constructor(config: AppConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#modules = createRuntimeModules(config.modules.enabled);
  }

  async start(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      this.#logger.info("Starting runtime", summarizeConfig(this.#config));

      for (const module of this.#modules) {
        await module.start({
          config: this.#config,
          logger: this.#logger.child(`module.${module.name}`)
        });
      }

      this.#armHeartbeat();

      this.#logger.info("Runtime started", {
        enabledModules: this.#config.modules.enabled,
        tradingMode: this.#config.trading.mode,
        startPaused: this.#config.controls.startPaused,
        killSwitchEnabled: this.#config.controls.killSwitchEnabled
      });
    } catch (error) {
      this.#logger.error("Runtime startup failed", {
        error: serializeError(error)
      });
      await this.stop("startup_failed");
      throw error;
    }
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (!this.#running) {
      return;
    }

    this.#logger.info("Stopping runtime", { reason });

    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }

    for (const module of [...this.#modules].reverse()) {
      await module.stop({
        config: this.#config,
        logger: this.#logger.child(`module.${module.name}`)
      });
    }

    this.#running = false;
    this.#logger.info("Runtime stopped", { reason });
  }

  #armHeartbeat(): void {
    if (this.#heartbeatTimer) {
      return;
    }

    void this.#tick();

    this.#heartbeatTimer = setInterval(() => {
      void this.#tick();
    }, this.#config.runtime.cycleIntervalMs);
  }

  async #tick(): Promise<void> {
    if (this.#tickInFlight) {
      this.#logger.warn("Skipping heartbeat because the previous cycle is still running");
      return;
    }

    this.#tickInFlight = (async () => {
      if (!this.#loggedLoopReady) {
        this.#loggedLoopReady = true;
        this.#logger.info("Heartbeat loop armed", {
          cycleIntervalMs: this.#config.runtime.cycleIntervalMs,
          tradingMode: this.#config.trading.mode,
          startPaused: this.#config.controls.startPaused,
          killSwitchEnabled: this.#config.controls.killSwitchEnabled
        });
        return;
      }

      this.#logger.debug("Heartbeat tick", {
        tradingMode: this.#config.trading.mode,
        liveOrdersEnabled: this.#config.trading.liveOrdersEnabled
      });
    })().finally(() => {
      this.#tickInFlight = null;
    });

    await this.#tickInFlight;
  }
}
