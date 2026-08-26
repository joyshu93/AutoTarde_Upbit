import type {
  RuntimeOwnershipAcquisition,
  RuntimeOwnershipEventRecord,
  RuntimeOwnershipExecutionMode,
  RuntimeOwnershipRecord,
} from "../../domain/runtime-ownership.js";
import type { ExecutionMode, LiveExecutionGate, SystemStatus } from "../../domain/types.js";

export interface PersistedRuntimeExecutionAuthority {
  readonly runtimeOwnership: RuntimeOwnershipRecord;
  readonly executionState: {
    readonly exchangeAccountId: string;
    readonly executionMode: ExecutionMode;
    readonly liveExecutionGate: LiveExecutionGate;
    readonly systemStatus: SystemStatus;
    readonly killSwitchActive: boolean;
  } | null;
}

export interface AcquireRuntimeOwnershipInput {
  readonly ownerToken: string;
  readonly executionMode: RuntimeOwnershipExecutionMode;
  readonly acquiredAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface RenewRuntimeOwnershipInput {
  readonly ownerToken: string;
  readonly generation: number;
  readonly heartbeatAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface ReleaseRuntimeOwnershipInput {
  readonly ownerToken: string;
  readonly generation: number;
  readonly releasedAtEpochMs: number;
}

export interface RecordRuntimeOwnershipLostInput {
  readonly ownerToken: string;
  readonly generation: number;
  readonly lostAtEpochMs: number;
  readonly reasonCode: string;
}

export interface RuntimeOwnershipStore {
  getCurrent(): Promise<RuntimeOwnershipRecord | null>;
  getCurrentExecutionAuthority?(
    exchangeAccountId: string,
  ): Promise<PersistedRuntimeExecutionAuthority | null>;
  acquireAfterProcessLock(
    input: AcquireRuntimeOwnershipInput,
  ): Promise<RuntimeOwnershipAcquisition>;
  renew(input: RenewRuntimeOwnershipInput): Promise<RuntimeOwnershipRecord | null>;
  release(input: ReleaseRuntimeOwnershipInput): Promise<boolean>;
  recordLost(input: RecordRuntimeOwnershipLostInput): Promise<boolean>;
  listRecentEvents(limit: number): Promise<readonly RuntimeOwnershipEventRecord[]>;
}

const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/u;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const EXECUTION_MODES = new Set<RuntimeOwnershipExecutionMode>(["DRY_RUN", "LIVE"]);
const EVENT_TYPES = new Set<RuntimeOwnershipEventRecord["eventType"]>([
  "ACQUIRED",
  "TAKEN_OVER",
  "RELEASED",
  "LOST",
]);

export function validateAcquireRuntimeOwnershipInput(input: AcquireRuntimeOwnershipInput): void {
  assertExactKeys(input, [
    "ownerToken",
    "executionMode",
    "acquiredAtEpochMs",
    "expiresAtEpochMs",
  ], "runtime ownership acquisition");
  validateOwnerToken(input.ownerToken);
  validateExecutionMode(input.executionMode);
  validateEpochMs(input.acquiredAtEpochMs, "acquiredAtEpochMs");
  validateEpochMs(input.expiresAtEpochMs, "expiresAtEpochMs");
  if (input.expiresAtEpochMs <= input.acquiredAtEpochMs) {
    throw new Error("Runtime ownership expiry must be after acquisition time.");
  }
}

export function validateRenewRuntimeOwnershipInput(input: RenewRuntimeOwnershipInput): void {
  assertExactKeys(input, [
    "ownerToken",
    "generation",
    "heartbeatAtEpochMs",
    "expiresAtEpochMs",
  ], "runtime ownership renewal");
  validateOwnerToken(input.ownerToken);
  validateGeneration(input.generation);
  validateEpochMs(input.heartbeatAtEpochMs, "heartbeatAtEpochMs");
  validateEpochMs(input.expiresAtEpochMs, "expiresAtEpochMs");
  if (input.expiresAtEpochMs <= input.heartbeatAtEpochMs) {
    throw new Error("Runtime ownership expiry must be after heartbeat time.");
  }
}

export function validateReleaseRuntimeOwnershipInput(input: ReleaseRuntimeOwnershipInput): void {
  assertExactKeys(input, ["ownerToken", "generation", "releasedAtEpochMs"], "runtime ownership release");
  validateOwnerToken(input.ownerToken);
  validateGeneration(input.generation);
  validateEpochMs(input.releasedAtEpochMs, "releasedAtEpochMs");
}

export function validateRecordRuntimeOwnershipLostInput(
  input: RecordRuntimeOwnershipLostInput,
): void {
  assertExactKeys(input, [
    "ownerToken",
    "generation",
    "lostAtEpochMs",
    "reasonCode",
  ], "runtime ownership loss");
  validateOwnerToken(input.ownerToken);
  validateGeneration(input.generation);
  validateEpochMs(input.lostAtEpochMs, "lostAtEpochMs");
  validateReasonCode(input.reasonCode);
}

export function validateRuntimeOwnershipRecord(record: RuntimeOwnershipRecord): void {
  assertExactKeys(record, [
    "ownerToken",
    "generation",
    "executionMode",
    "acquiredAtEpochMs",
    "heartbeatAtEpochMs",
    "expiresAtEpochMs",
  ], "runtime ownership record");
  validateOwnerToken(record.ownerToken);
  validateGeneration(record.generation);
  validateExecutionMode(record.executionMode);
  validateEpochMs(record.acquiredAtEpochMs, "acquiredAtEpochMs");
  validateEpochMs(record.heartbeatAtEpochMs, "heartbeatAtEpochMs");
  validateEpochMs(record.expiresAtEpochMs, "expiresAtEpochMs");
  if (record.heartbeatAtEpochMs < record.acquiredAtEpochMs) {
    throw new Error("Runtime ownership heartbeat timestamp cannot precede acquisition.");
  }
  if (record.expiresAtEpochMs <= record.heartbeatAtEpochMs) {
    throw new Error("Runtime ownership expiry must be after heartbeat time.");
  }
}

export function validateRuntimeOwnershipEventRecord(event: RuntimeOwnershipEventRecord): void {
  assertExactKeys(event, [
    "id",
    "generation",
    "eventType",
    "executionMode",
    "reasonCode",
    "eventAtEpochMs",
  ], "runtime ownership event");
  validatePositiveSafeInteger(event.id, "Runtime ownership event id");
  validateGeneration(event.generation);
  if (!EVENT_TYPES.has(event.eventType)) {
    throw new Error("Runtime ownership event type is invalid.");
  }
  validateExecutionMode(event.executionMode);
  validateReasonCode(event.reasonCode);
  validateEpochMs(event.eventAtEpochMs, "eventAtEpochMs");
}

export function validateRuntimeOwnershipEventLimit(limit: number): void {
  validatePositiveSafeInteger(limit, "Runtime ownership event limit");
}

export function assertNoTimestampRollback(candidateEpochMs: number, floorEpochMs: number): void {
  if (candidateEpochMs < floorEpochMs) {
    throw new Error("Runtime ownership timestamp rollback is not permitted.");
  }
}

export function validateGeneration(generation: number): void {
  validatePositiveSafeInteger(generation, "Runtime ownership generation");
}

function validateOwnerToken(ownerToken: string): void {
  if (typeof ownerToken !== "string" || !OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new Error("Runtime ownership owner token must be exactly 64 token-safe characters.");
  }
}

function validateExecutionMode(executionMode: RuntimeOwnershipExecutionMode): void {
  if (!EXECUTION_MODES.has(executionMode)) {
    throw new Error("Runtime ownership execution mode must be DRY_RUN or LIVE.");
  }
}

function validateReasonCode(reasonCode: string): void {
  if (typeof reasonCode !== "string" || !REASON_CODE_PATTERN.test(reasonCode)) {
    throw new Error("Runtime ownership reason code must be 1-64 uppercase code characters.");
  }
}

function validateEpochMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Runtime ownership ${label} must be a non-negative safe integer.`);
  }
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertExactKeys(
  value: object,
  expectedKeys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} must contain exactly the documented keys.`);
  }
}
