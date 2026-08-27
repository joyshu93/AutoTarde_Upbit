import { pathToFileURL } from "node:url";
import { writeSync } from "node:fs";

import {
  verifyLiveDatabaseIdentity,
  type LiveDatabaseIdentityVerification,
} from "../app/live-database-identity.js";
import { loadAppConfig } from "../app/env.js";
import {
  acquireRuntimeProcessLock,
  deriveRuntimeLockIdentity,
  RuntimeProcessLockError,
  type RuntimeLockIdentity,
  type RuntimeLockIdentityInput,
  type RuntimeProcessLock,
} from "../app/runtime-process-lock.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_ONLY_PROBES_RUNTIME_OWNERSHIP";
const EXCHANGE_ACCOUNT_ID = "primary";

type RuntimeDuplicateOwnerProbeStatus = "PASS" | "BLOCK";
type RuntimeDuplicateOwnerProbeOutcome = "DUPLICATE_BLOCKED" | "NO_ACTIVE_OWNER";

export interface RuntimeDuplicateOwnerProbeDependencies {
  verifyLiveDatabaseIdentity(input: Parameters<typeof verifyLiveDatabaseIdentity>[0]):
    LiveDatabaseIdentityVerification;
  deriveRuntimeLockIdentity(input: RuntimeLockIdentityInput): RuntimeLockIdentity;
  acquireRuntimeProcessLock(identity: RuntimeLockIdentity): Promise<RuntimeProcessLock>;
}

export interface RuntimeDuplicateOwnerProbeResult {
  readonly service: string;
  readonly status: RuntimeDuplicateOwnerProbeStatus;
  readonly outcome: RuntimeDuplicateOwnerProbeOutcome;
  readonly databaseIdentityVerified: true;
  readonly processLockContended: boolean;
  readonly processLockAcquired: boolean;
  readonly processLockReleased: boolean;
  readonly nonMutationBoundary: Readonly<{
    databaseWrites: false;
    migrations: false;
    bootstrap: false;
    applicationConstruction: false;
    apiCalls: false;
    workerStarts: false;
    orderTransmission: false;
  }>;
}

export class RuntimeDuplicateOwnerProbeError extends Error {
  constructor(
    readonly code: "CONFIRMATION_REQUIRED" | "LIVE_MODE_REQUIRED" | "LOCK_RELEASE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeDuplicateOwnerProbeError";
  }
}

export interface RuntimeDuplicateOwnerProbeCliFailureDependencies {
  writeStderr(output: string): void;
  terminateProcess(code: number): never;
}

export async function runRuntimeDuplicateOwnerProbe(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeDuplicateOwnerProbeDependencies = {
    verifyLiveDatabaseIdentity,
    deriveRuntimeLockIdentity,
    acquireRuntimeProcessLock,
  },
): Promise<RuntimeDuplicateOwnerProbeResult> {
  if (env.LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION !== CONFIRMATION) {
    throw new RuntimeDuplicateOwnerProbeError(
      "CONFIRMATION_REQUIRED",
      `Refusing to probe until LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION=${CONFIRMATION}.`,
    );
  }

  const config = loadAppConfig(env);
  if (config.executionMode !== "LIVE") {
    throw new RuntimeDuplicateOwnerProbeError(
      "LIVE_MODE_REQUIRED",
      "Duplicate-owner probe requires APP_EXECUTION_MODE=LIVE.",
    );
  }

  const verification = dependencies.verifyLiveDatabaseIdentity({
    executionMode: config.executionMode,
    databasePath: config.databasePath,
    expectedDatabaseInstanceId: config.liveDatabaseInstanceId ?? null,
    exchangeAccountId: EXCHANGE_ACCOUNT_ID,
    upbitAccessKey: env.UPBIT_ACCESS_KEY?.trim() || null,
  });
  if (verification.status !== "VERIFIED") {
    throw new RuntimeDuplicateOwnerProbeError(
      "LIVE_MODE_REQUIRED",
      "Duplicate-owner probe requires verified LIVE database identity.",
    );
  }

  const lockIdentity = dependencies.deriveRuntimeLockIdentity({
    canonicalDatabasePath: verification.canonicalDatabasePath,
    databaseInstanceId: null,
    exchangeAccountId: EXCHANGE_ACCOUNT_ID,
  });

  let processLock: RuntimeProcessLock;
  try {
    processLock = await dependencies.acquireRuntimeProcessLock(lockIdentity);
  } catch (error) {
    if (error instanceof RuntimeProcessLockError && error.code === "RUNTIME_ALREADY_OWNED") {
      return createResult({
        status: "PASS",
        outcome: "DUPLICATE_BLOCKED",
        processLockContended: true,
        processLockAcquired: false,
        processLockReleased: false,
      });
    }
    throw error;
  }

  try {
    await processLock.release();
  } catch {
    throw new RuntimeDuplicateOwnerProbeError(
      "LOCK_RELEASE_FAILED",
      "Duplicate-owner probe acquired the process lock unexpectedly and could not release it cleanly.",
    );
  }

  return createResult({
    status: "BLOCK",
    outcome: "NO_ACTIVE_OWNER",
    processLockContended: false,
    processLockAcquired: true,
    processLockReleased: true,
  });
}

function createResult(input: Readonly<{
  status: RuntimeDuplicateOwnerProbeStatus;
  outcome: RuntimeDuplicateOwnerProbeOutcome;
  processLockContended: boolean;
  processLockAcquired: boolean;
  processLockReleased: boolean;
}>): RuntimeDuplicateOwnerProbeResult {
  return {
    service: "AutoTrade_Upbit",
    ...input,
    databaseIdentityVerified: true,
    nonMutationBoundary: {
      databaseWrites: false,
      migrations: false,
      bootstrap: false,
      applicationConstruction: false,
      apiCalls: false,
      workerStarts: false,
      orderTransmission: false,
    },
  };
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

export function terminateRuntimeDuplicateOwnerProbeCliFailure(
  error: unknown,
  dependencies: RuntimeDuplicateOwnerProbeCliFailureDependencies = {
    writeStderr(output) {
      writeSync(process.stderr.fd, output);
    },
    terminateProcess(code): never {
      process.exit(code);
    },
  },
): never {
  try {
    dependencies.writeStderr(`${JSON.stringify({
      service: "AutoTrade_Upbit",
      status: "BLOCK",
      code: error instanceof RuntimeDuplicateOwnerProbeError ? error.code : "PROBE_FAILED",
      detail: "Duplicate-owner probe failed closed.",
    }, null, 2)}\n`);
  } finally {
    return dependencies.terminateProcess(1);
  }
}

if (isMainModule()) {
  try {
    const result = await runRuntimeDuplicateOwnerProbe();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "BLOCK") process.exitCode = 1;
  } catch (error) {
    terminateRuntimeDuplicateOwnerProbeCliFailure(error);
  }
}
