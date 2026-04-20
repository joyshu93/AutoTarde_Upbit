import type { AppConfig } from "../shared/config.js";
import type { Logger } from "../shared/logger.js";
import { type ModuleName } from "../shared/runtime-constants.js";

export interface ModuleContext {
  readonly config: AppConfig;
  readonly logger: Logger;
}

export interface RuntimeModule {
  readonly name: ModuleName;
  readonly description: string;
  readonly sourcePath: string;
  readonly wired: boolean;
  start(context: ModuleContext): Promise<void>;
  stop(context: ModuleContext): Promise<void>;
}

const MODULE_DESCRIPTORS: ReadonlyArray<{
  readonly name: ModuleName;
  readonly description: string;
  readonly sourcePath: string;
}> = [
  {
    name: "db",
    description: "Persistence and repository coordination.",
    sourcePath: "src/modules/db"
  },
  {
    name: "exchange",
    description: "Exchange adapters and transport boundaries.",
    sourcePath: "src/modules/exchange"
  },
  {
    name: "execution",
    description: "Order orchestration and execution workflows.",
    sourcePath: "src/modules/execution"
  },
  {
    name: "reconciliation",
    description: "Trade and balance reconciliation workflows.",
    sourcePath: "src/modules/reconciliation"
  },
  {
    name: "risk",
    description: "Risk policy evaluation and position guards.",
    sourcePath: "src/modules/risk"
  },
  {
    name: "strategy",
    description: "Trading strategy composition and signals.",
    sourcePath: "src/modules/strategy"
  },
  {
    name: "telegram",
    description: "Operator-facing notifications and commands.",
    sourcePath: "src/modules/telegram"
  }
];

const MODULE_REGISTRY = new Map<ModuleName, RuntimeModule>(
  MODULE_DESCRIPTORS.map((descriptor): [ModuleName, RuntimeModule] => [
    descriptor.name,
    {
      ...descriptor,
      wired: false,
      async start(context: ModuleContext): Promise<void> {
        context.logger.info("Module placeholder registered", {
          description: descriptor.description,
          sourcePath: descriptor.sourcePath,
          wired: false,
          tradingMode: context.config.trading.mode
        });
      },
      async stop(context: ModuleContext): Promise<void> {
        context.logger.info("Module placeholder stopped", {
          sourcePath: descriptor.sourcePath
        });
      }
    }
  ])
);

export function createRuntimeModules(enabledModules: readonly ModuleName[]): RuntimeModule[] {
  return enabledModules.map((moduleName) => {
    const module = MODULE_REGISTRY.get(moduleName);

    if (!module) {
      throw new Error(`Runtime module "${moduleName}" is not registered.`);
    }

    return module;
  });
}
