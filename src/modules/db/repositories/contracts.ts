import type { ExecutionRepository, OperatorStateStore } from "../interfaces.js";

export interface SqlitePersistenceBundle {
  repositories: ExecutionRepository;
  operatorState: OperatorStateStore;
  close(): void;
}

export interface SqliteBootstrapOptions {
  databasePath: string;
  exchangeAccountId: string;
  userId: string;
  userTelegramId: string;
  userDisplayName: string | null;
  accessKeyRef: string;
  secretKeyRef: string;
  executionMode: "DRY_RUN" | "LIVE";
  liveExecutionGate: "DISABLED" | "ENABLED";
  killSwitchActive: boolean;
}
