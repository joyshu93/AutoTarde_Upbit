import type { ExecutionRepository, OperatorStateStore, TelegramInboundOffsetStore } from "../interfaces.js";
import type { AccountExecutionLeaseStore, CandidatePilotRepository } from "../pilot-interfaces.js";
import type { RuntimeOwnershipStore } from "../runtime-ownership-interfaces.js";

export interface SqliteRuntimeOwnershipBundle {
  runtimeOwnership: RuntimeOwnershipStore;
  close(): void;
}

export interface SqlitePersistenceBundle {
  repositories: ExecutionRepository;
  candidatePilots: CandidatePilotRepository;
  accountExecutionLeases: AccountExecutionLeaseStore;
  operatorState: OperatorStateStore;
  telegramInboundOffsets: TelegramInboundOffsetStore;
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
