export type RuntimeOwnershipExecutionMode = "DRY_RUN" | "LIVE";

export type RuntimeOwnershipEventType = "ACQUIRED" | "TAKEN_OVER" | "RELEASED" | "LOST";

export interface RuntimeOwnershipRecord {
  readonly ownerToken: string;
  readonly generation: number;
  readonly executionMode: RuntimeOwnershipExecutionMode;
  readonly acquiredAtEpochMs: number;
  readonly heartbeatAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface RuntimeOwnershipAcquisition {
  readonly record: RuntimeOwnershipRecord;
  readonly takeover: boolean;
}

export interface RuntimeOwnershipEventRecord {
  readonly id: number;
  readonly generation: number;
  readonly eventType: RuntimeOwnershipEventType;
  readonly executionMode: RuntimeOwnershipExecutionMode;
  readonly reasonCode: string;
  readonly eventAtEpochMs: number;
}
