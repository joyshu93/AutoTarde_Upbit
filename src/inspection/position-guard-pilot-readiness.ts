import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type {
  CandidateExecutionBindingRecord,
  PositionGuardPilotAbandonmentValidation,
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
  PositionGuardPilotPhase,
  PositionGuardPolicySelection,
} from "../domain/pilot-types.js";
import {
  classifySubmissionBlockingOrder,
  SUBMISSION_BLOCKING_CANDIDATE_STATUSES,
  type SubmissionBlockingReasonCode,
} from "../domain/submission-blocking-order.js";
import {
  parsePositionGuardPolicySelection,
} from "../app/position-guard-pilot-config.js";
import {
  loadCheckedInPositionGuardPilotAbandonment,
} from "../app/position-guard-pilot-registry-loader.js";
import {
  candidateEvidenceMaterial,
  parseCandidatePilotTimestamp,
  validateCandidateExecutionBinding,
  validateCandidatePilotDeployment,
  type CandidatePilotRecoveryIdentity,
} from "../modules/db/pilot-interfaces.js";
import type { PositionGuardCandidateExecutionEvidence } from "../modules/strategy/position-guard-candidate-state.js";
import type { OrderLifecycleStatus } from "../domain/types.js";
import {
  canonicalizeLocalDatabasePath,
  LocalDatabasePathError,
} from "../modules/db/local-database-path.js";

export type PositionGuardPilotReadinessFormat = "TEXT" | "JSON";
export type PositionGuardPilotReadinessStatus = "PASS" | "WARN" | "BLOCK";

export type PositionGuardPilotReadinessAuthority = Readonly<{
  source: "CHECKED_IN_REGISTRY";
  validation: Readonly<PositionGuardPilotAbandonmentValidation>;
}>;

export type PositionGuardPilotReadinessIdentity = CandidatePilotRecoveryIdentity & Readonly<{
  deploymentId: string;
}>;

export interface PositionGuardPilotReadinessOptions {
  databasePath: string;
  checkedAt: string;
  freshnessThresholdMs: number;
  identity: Readonly<PositionGuardPilotReadinessIdentity>;
  selection: Readonly<PositionGuardPolicySelection>;
  authority: PositionGuardPilotReadinessAuthority;
}

export interface PositionGuardPilotReadinessCliOptions {
  databasePath: string;
  format: PositionGuardPilotReadinessFormat;
  exchangeAccountId: string;
  deploymentId: string;
  checkedAt: string;
  freshnessThresholdMs: number;
}

export interface PositionGuardPilotReadinessCheck {
  name: string;
  status: PositionGuardPilotReadinessStatus;
  detail: string;
}

export interface PositionGuardPilotReadinessReport {
  service: "AutoTrade_Upbit";
  inspection: "BTC_POSITION_GUARD_PILOT_READINESS_V1";
  status: PositionGuardPilotReadinessStatus;
  databasePath: string;
  checkedAt: string;
  freshnessThresholdMs: number;
  filters: Readonly<PositionGuardPilotReadinessIdentity>;
  selection: Readonly<{
    kind: PositionGuardPolicySelection["kind"];
    pilotId: string | null;
    candidateSelected: boolean;
    liveOperatorConfirmed: boolean;
  }>;
  authority: Readonly<{
    source: "CHECKED_IN_REGISTRY";
    valid: boolean;
    experimentId: string | null;
    eventAt: string | null;
  }>;
  deployment: Readonly<{
    id: string;
    phase: string;
    activationAt: string | null;
    createdAt: string;
    updatedAt: string;
  }> | null;
  stateProvenance: Readonly<{
    materialVersion: string;
    stateVersion: number;
    lastEvidenceAt: string | null;
    lastEvidenceId: string | null;
    replayEqual: boolean;
  }> | null;
  evidenceProvenance: Readonly<{
    count: number;
    firstEvidenceAt: string | null;
    lastEvidenceAt: string | null;
    materialVersions: readonly string[];
    materialHashesValidated: boolean;
  }> | null;
  orderState: Readonly<{
    activeCount: number;
    uncertainCount: number;
    activeStatuses: readonly string[];
    uncertainStatuses: readonly string[];
    blockingOrders: readonly Readonly<{
      id: string;
      status: string;
      reasonCode: SubmissionBlockingReasonCode;
      reason: string;
    }>[];
  }>;
  health: Readonly<{
    balance: HealthEvidence | null;
    position: HealthEvidence | null;
    reconciliation: ReconciliationEvidence | null;
  }>;
  leaseState: Readonly<{
    classification: "ABSENT" | "ACTIVE" | "STALE" | "INVALID";
    purpose: string | null;
    acquiredAtEpochMs: number | null;
    expiresAtEpochMs: number | null;
  }>;
  ethPolicy: "BASELINE";
  checks: readonly PositionGuardPilotReadinessCheck[];
  nextActions: readonly string[];
  nonMutationBoundary: Readonly<{
    readOnly: true;
    databaseWrites: false;
    migrations: false;
    orderMutation: false;
    privateExchange: false;
    telegram: false;
    sync: false;
    scheduler: false;
    execution: false;
    runtime: false;
    sqliteSharedMemory: "UNCHANGED" | "READER_MARKS_MAY_CHANGE";
  }>;
}

type HealthEvidence = Readonly<{
  id: string;
  capturedAt: string;
  source: string;
  classification: "FRESH" | "STALE" | "INVALID";
}>;

type ReconciliationEvidence = Readonly<{
  id: string;
  status: string;
  completedAt: string | null;
  source: string | null;
  issueCodes: readonly string[];
  classification: "CLEAN" | "NON_BLOCKING_DRIFT" | "STALE" | "INVALID" | "BLOCKING";
}>;

type ExactCandidateState = Readonly<{
  currentEpisodeAddCount: number;
  currentEpisodeCostBasisKrw: string;
  currentEpisodeInventoryQuantity: string;
  currentEpisodeRealizedPnlKrw: string;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: string | null;
  lastEntryPath: PositionGuardCandidateExecutionEvidence["entryPath"] | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
  stateVersion: number;
}>;

type ExactDecimal = Readonly<{
  coefficient: bigint;
  scale: number;
}>;

type ValidatedEvidenceRecord = Readonly<{
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>;
  materialHash: string;
  materialVersion: string;
  hashValid: boolean;
}>;

type ReplayAuthority = Readonly<{
  state: Readonly<ExactCandidateState>;
  evidence: readonly ValidatedEvidenceRecord[];
}>;

type MutableInspection = {
  deployment: PositionGuardPilotReadinessReport["deployment"];
  stateProvenance: PositionGuardPilotReadinessReport["stateProvenance"];
  evidenceProvenance: PositionGuardPilotReadinessReport["evidenceProvenance"];
  orderState: PositionGuardPilotReadinessReport["orderState"];
  health: PositionGuardPilotReadinessReport["health"];
  leaseState: PositionGuardPilotReadinessReport["leaseState"];
  sqliteSharedMemory: PositionGuardPilotReadinessReport["nonMutationBoundary"]["sqliteSharedMemory"];
  checks: PositionGuardPilotReadinessCheck[];
};

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  strategy_pilot_deployments: [
    "id", "exchange_account_id", "pilot_id", "market", "policy_id", "policy_version",
    "phase", "created_at", "updated_at", "activation_at", "activation_epoch_ns",
  ],
  strategy_candidate_execution_evidence: [
    "deployment_id", "id", "executed_at", "executed_at_epoch_ns", "action", "entry_path",
    "terminal_status", "material_hash", "created_at", "material_version",
    "executed_quantity_exact", "gross_quote_value_krw_exact", "confirmed_fee_krw_exact",
    "remaining_quantity_exact",
  ],
  strategy_candidate_execution_bindings: [
    "id", "deployment_id", "strategy_decision_id", "order_id", "exchange_account_id",
    "activation_at", "activation_epoch_ns", "market", "strategy_key", "policy_id",
    "policy_version", "execution_mode", "ord_type", "action", "side",
    "intended_quantity_exact", "intended_notional_krw_exact", "bound_price_exact",
    "bound_volume_exact", "bound_time_in_force", "bound_smp_type", "material_version",
    "order_material_hash", "created_at",
  ],
  strategy_decisions: [
    "id", "exchange_account_id", "strategy_key", "market", "action", "status",
    "decision_basis_json", "intended_notional_krw", "intended_quantity",
    "reference_price", "created_at",
  ],
  strategy_candidate_states: [
    "deployment_id", "current_episode_add_count", "last_full_exit_at", "last_entry_path",
    "last_evidence_at", "last_evidence_id", "state_version", "updated_at", "material_version",
    "current_episode_cost_basis_krw_exact", "current_episode_inventory_quantity_exact",
    "current_episode_realized_pnl_krw_exact", "last_full_exit_realized_pnl_krw_exact",
  ],
  strategy_pilot_audit_events: [
    "id", "deployment_id", "event_type", "from_phase", "to_phase", "state_version",
    "payload_json", "created_at", "created_at_epoch_ns",
  ],
  account_execution_leases: [
    "exchange_account_id", "owner_token", "purpose", "acquired_at_epoch_ms", "expires_at_epoch_ms",
  ],
  orders: [
    "id", "exchange_account_id", "status", "requested_at", "created_at", "updated_at",
    "strategy_decision_id", "market", "side", "ord_type", "volume", "price",
    "time_in_force", "smp_type", "origin", "execution_mode", "upbit_uuid",
    "exchange_response_json", "failure_code",
  ],
  fills: [
    "id", "order_id", "exchange_fill_id", "market", "side", "price", "volume",
    "fee_currency", "fee_amount", "fee_provenance", "filled_at", "raw_payload_json",
    "execution_timestamp_provenance", "execution_epoch_ns",
  ],
  order_events: ["id", "order_id", "event_type", "event_source", "created_at"],
  order_submission_recovery_observations: [
    "id", "order_id", "outcome", "observed_at_epoch_ms",
  ],
  balance_snapshots: ["id", "exchange_account_id", "captured_at", "source", "total_krw_value", "balances_json"],
  position_snapshots: ["id", "exchange_account_id", "captured_at", "source", "positions_json"],
  reconciliation_runs: [
    "id", "exchange_account_id", "status", "started_at", "completed_at", "summary_json", "error_message",
  ],
  _schema_migrations: ["filename", "applied_at"],
});

const UNCERTAIN_ORDER_STATUSES = Object.freeze([
  "SUBMITTING", "RECONCILIATION_REQUIRED", "FAILED", "REJECTED",
] as const);
const REVIEWED_NON_BLOCKING_RECONCILIATION_CODES = new Set([
  "ORDER_STATUS_RECONCILED", "ORDER_FILLS_BACKFILLED", "TERMINAL_ORDER_RECHECKED",
  "ORDER_IDENTIFIER_RECOVERED", "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
  "EXCHANGE_ORDER_RECOVERED", "DRY_RUN_ORDER_REPAIRED",
]);
const KNOWN_RECONCILIATION_SOURCES = new Set([
  "DIRECT_RUN", "OPERATOR_SYNC", "STARTUP_RECOVERY", "SCHEDULER_PREFLIGHT",
]);
const NON_MUTATION_BOUNDARY = Object.freeze({
  readOnly: true as const,
  databaseWrites: false as const,
  migrations: false as const,
  orderMutation: false as const,
  privateExchange: false as const,
  telegram: false as const,
  sync: false as const,
  scheduler: false as const,
  execution: false as const,
  runtime: false as const,
});
const EXPECTED_AUTHORITY = Object.freeze({
  experimentId: "PCS-2026-001",
  eventAt: "2026-08-21T03:08:24.756Z",
});
const PILOT_PHASES = Object.freeze([
  "DISABLED", "PENDING_FLAT", "ACTIVE", "PAUSED_FAULT", "DRAINING",
] as const);
const AUDIT_EVENT_TYPES = Object.freeze([
  "DEPLOYMENT_CREATED", "STATE_ADVANCED", "PHASE_TRANSITION", "FAULT_PAUSED",
  "ROLLBACK_STARTED", "ROLLBACK_COMPLETED",
] as const);
const RECOVERY_FAULT_REASONS = new Set([
  "SNAPSHOT_PROVENANCE_INVALID", "STALE_SNAPSHOT", "IDENTITY_MISMATCH", "REPLAY_MISMATCH",
  "INVENTORY_MISMATCH", "BLOCKING_RECONCILIATION", "ACTIVE_ORDER", "UNCERTAIN_ORDER",
  "ACTIVATION_CAS_CONFLICT",
]);
const REQUIRED_AUDIT_IMMUTABILITY_TRIGGERS = Object.freeze({
  strategy_pilot_audit_events_no_update: /^\s*CREATE\s+TRIGGER\s+strategy_pilot_audit_events_no_update\s+BEFORE\s+UPDATE\s+ON\s+strategy_pilot_audit_events\s+BEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*'strategy pilot audit events are append-only'\s*\)\s*;\s*END\s*;?\s*$/iu,
  strategy_pilot_audit_events_no_delete: /^\s*CREATE\s+TRIGGER\s+strategy_pilot_audit_events_no_delete\s+BEFORE\s+DELETE\s+ON\s+strategy_pilot_audit_events\s+BEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*'strategy pilot audit events are append-only'\s*\)\s*;\s*END\s*;?\s*$/iu,
});
const REQUIRED_BINDING_IMMUTABILITY_TRIGGERS = Object.freeze({
  strategy_candidate_execution_bindings_no_update: /^\s*CREATE\s+TRIGGER\s+strategy_candidate_execution_bindings_no_update\s+BEFORE\s+UPDATE\s+ON\s+strategy_candidate_execution_bindings\s+BEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*'strategy candidate execution bindings are append-only'\s*\)\s*;\s*END\s*;?\s*$/iu,
  strategy_candidate_execution_bindings_no_delete: /^\s*CREATE\s+TRIGGER\s+strategy_candidate_execution_bindings_no_delete\s+BEFORE\s+DELETE\s+ON\s+strategy_candidate_execution_bindings\s+BEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*'strategy candidate execution bindings are append-only'\s*\)\s*;\s*END\s*;?\s*$/iu,
});

export function inspectPositionGuardPilotReadiness(
  rawOptions: PositionGuardPilotReadinessOptions,
): PositionGuardPilotReadinessReport {
  const options = validateOptions(rawOptions);
  const mutable = createMutableInspection();
  const selection = summarizeSelection(options.selection);
  const authority = summarizeAuthority(options.authority);
  mutable.checks.push(configurationCheck(options.selection, options.identity));
  mutable.checks.push(authorityCheck(authority));
  mutable.checks.push({
    name: "eth_baseline",
    status: "PASS",
    detail: "KRW-ETH remains on the baseline policy; this inspection cannot activate a candidate policy.",
  });

  let databasePath = resolve(options.databasePath);
  try {
    databasePath = canonicalizeLocalDatabasePath(options.databasePath, { mustExist: true });
  } catch (error) {
    const detail = error instanceof LocalDatabasePathError && error.code === "DATABASE_PATH_NOT_FOUND"
      ? "The explicitly selected SQLite database does not exist; no file was created."
      : `The explicitly selected SQLite database path is unsafe: ${formatError(error)}`;
    mutable.checks.unshift({
      name: "database_file",
      status: "BLOCK",
      detail,
    });
    addUnavailableChecks(mutable, "database file is unavailable or not canonical local storage");
    return buildReport(options, databasePath, selection, authority, mutable);
  }

  mutable.checks.unshift({
    name: "database_file",
    status: "PASS",
    detail: "Existing uniquely named canonical local SQLite file was selected explicitly.",
  });

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const recheckedDatabasePath = canonicalizeLocalDatabasePath(databasePath, { mustExist: true });
    if (!sameDatabasePath(databasePath, recheckedDatabasePath)) {
      throw new Error("SQLite inspection path changed after its canonical read-only open.");
    }
    const sqliteSnapshotCheck = inspectSqliteSnapshotReadSafety(db, mutable);
    mutable.checks.push(sqliteSnapshotCheck);
    if (sqliteSnapshotCheck.status === "BLOCK") {
      addUnavailableChecks(mutable, "the SQLite journal mode is not approved for read-only inspection");
      return buildReport(options, databasePath, selection, authority, mutable);
    }
    const schemaFailure = validateRequiredSchema(db);
    if (schemaFailure !== null) {
      mutable.checks.push({ name: "required_schema", status: "BLOCK", detail: schemaFailure });
      addUnavailableChecks(mutable, "required pilot schema is unavailable");
      return buildReport(options, databasePath, selection, authority, mutable);
    }
    mutable.checks.push({
      name: "required_schema",
      status: "PASS",
      detail: "Required migrated pilot, order, snapshot, reconciliation, lease schema, and immutable audit triggers are present.",
    });

    inspectDeploymentAndReplay(db, options, mutable);
    inspectOrders(db, options, mutable);
    inspectHealth(db, options, mutable);
    inspectLease(db, options, mutable);
  } catch (error) {
    mutable.checks.push({
      name: "persisted_data_integrity",
      status: "BLOCK",
      detail: `Persisted readiness evidence is invalid: ${formatError(error)}`,
    });
  } finally {
    db?.close();
  }

  mutable.checks.push({
    name: "non_mutation_boundary",
    status: "PASS",
    detail: mutable.sqliteSharedMemory === "READER_MARKS_MAY_CHANGE"
      ? "Read-only inspection performed no database or WAL write and no operational action; SQLite may update WAL-mode SHM reader marks."
      : "Read-only inspection performed no migration, write, runtime, exchange, Telegram, sync, scheduler, execution, or order action.",
  });
  return buildReport(options, databasePath, selection, authority, mutable);
}

function sameDatabasePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toUpperCase() === right.toUpperCase()
    : left === right;
}

export function formatPositionGuardPilotReadiness(
  report: PositionGuardPilotReadinessReport,
  format: PositionGuardPilotReadinessFormat,
): string {
  if (format === "JSON") return stringifyFiniteJson(report);
  if (format !== "TEXT") throw new Error("PositionGuard pilot readiness format must be TEXT or JSON.");
  return [
    "BTC Pilot Readiness",
    `overall_status: ${report.status}`,
    `database_path: ${report.databasePath}`,
    `checked_at: ${report.checkedAt}`,
    `exchange_account_id: ${report.filters.exchangeAccountId}`,
    `deployment_id: ${report.filters.deploymentId}`,
    `selection: ${report.selection.kind}`,
    `pilot_id: ${report.filters.pilotId}`,
    `market: ${report.filters.market}`,
    `policy: ${report.filters.policyId}@${report.filters.policyVersion}`,
    `phase: ${report.deployment?.phase ?? "none"}`,
    `state_version: ${report.stateProvenance?.stateVersion ?? "none"}`,
    `last_evidence_at: ${report.stateProvenance?.lastEvidenceAt ?? "none"}`,
    `active_orders: ${report.orderState.activeCount}`,
    `uncertain_orders: ${report.orderState.uncertainCount}`,
    `blocking_order_ids: ${report.orderState.blockingOrders.map((order) => order.id).join(",") || "none"}`,
    `lease: ${report.leaseState.classification}`,
    `eth_policy: ${report.ethPolicy}`,
    "checks:",
    ...report.checks.map((item) => `- ${item.name}: ${item.status} | ${item.detail}`),
    "next_actions:",
    ...(report.nextActions.length === 0 ? ["- none"] : report.nextActions.map((action) => `- ${action}`)),
    "boundary: read-only persisted evidence only; this command does not activate the pilot or prove exchange-backed runtime readiness.",
  ].join("\n");
}

export function parsePositionGuardPilotReadinessArgs(
  argv: readonly string[],
): PositionGuardPilotReadinessCliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "database-path", "format", "exchange-account-id", "deployment-id",
    "checked-at", "freshness-threshold-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    }
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown argument --${key}.`);
    if (values.has(key)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values.set(key, value);
    index += 1;
  }

  const databasePath = requiredCliValue(values, "database-path");
  const rawFormat = requiredCliValue(values, "format").toUpperCase();
  if (rawFormat !== "TEXT" && rawFormat !== "JSON") {
    throw new Error("--format must be TEXT|JSON.");
  }
  const exchangeAccountId = requiredCliValue(values, "exchange-account-id");
  const deploymentId = requiredCliValue(values, "deployment-id");
  const checkedAt = requiredCliValue(values, "checked-at");
  parseCandidatePilotTimestamp(checkedAt, "readiness --checked-at");
  const rawThreshold = requiredCliValue(values, "freshness-threshold-ms");
  if (!/^\d+$/u.test(rawThreshold)) {
    throw new Error("--freshness-threshold-ms must be a positive safe integer.");
  }
  const freshnessThresholdMs = Number(rawThreshold);
  if (!Number.isSafeInteger(freshnessThresholdMs) || freshnessThresholdMs <= 0) {
    throw new Error("--freshness-threshold-ms must be a positive safe integer.");
  }
  return {
    databasePath,
    format: rawFormat,
    exchangeAccountId,
    deploymentId,
    checkedAt,
    freshnessThresholdMs,
  };
}

export function runPositionGuardPilotReadinessCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): PositionGuardPilotReadinessReport {
  const cli = parsePositionGuardPilotReadinessArgs(argv);
  const selection = parsePositionGuardPolicySelection(env);
  const validation = loadCheckedInPositionGuardPilotAbandonment();
  const report = inspectPositionGuardPilotReadiness({
    databasePath: cli.databasePath,
    checkedAt: cli.checkedAt,
    freshnessThresholdMs: cli.freshnessThresholdMs,
    identity: {
      deploymentId: cli.deploymentId,
      exchangeAccountId: cli.exchangeAccountId,
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    },
    selection,
    authority: { source: "CHECKED_IN_REGISTRY", validation },
  });
  process.stdout.write(`${formatPositionGuardPilotReadiness(report, cli.format)}\n`);
  return report;
}

function validateOptions(raw: PositionGuardPilotReadinessOptions): PositionGuardPilotReadinessOptions {
  if (typeof raw !== "object" || raw === null) throw new Error("Readiness options are required.");
  if (typeof raw.databasePath !== "string" || raw.databasePath.trim() === "") {
    throw new Error("Readiness databasePath must be explicit and non-empty.");
  }
  const checkedAtEpochNs = parseCandidatePilotTimestamp(raw.checkedAt, "readiness checkedAt");
  if (checkedAtEpochNs < 0n) throw new Error("Readiness checkedAt cannot precede the Unix epoch.");
  if (!Number.isSafeInteger(raw.freshnessThresholdMs) || raw.freshnessThresholdMs <= 0) {
    throw new Error("Readiness freshnessThresholdMs must be a positive safe integer.");
  }
  validateIdentity(raw.identity);
  summarizeSelection(raw.selection);
  summarizeAuthority(raw.authority);
  return Object.freeze({
    databasePath: raw.databasePath,
    checkedAt: raw.checkedAt,
    freshnessThresholdMs: raw.freshnessThresholdMs,
    identity: Object.freeze({ ...raw.identity }),
    selection: Object.freeze({ ...raw.selection }),
    authority: Object.freeze({
      source: raw.authority.source,
      validation: Object.freeze({ ...raw.authority.validation }),
    }),
  });
}

function validateIdentity(identity: Readonly<PositionGuardPilotReadinessIdentity>): void {
  if (
    typeof identity.deploymentId !== "string" || identity.deploymentId.trim() === "" ||
    typeof identity.exchangeAccountId !== "string" || identity.exchangeAccountId.trim() === "" ||
    identity.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    identity.market !== "KRW-BTC" ||
    identity.policyId !== "COMBINED_CONSERVATIVE" ||
    identity.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1"
  ) {
    throw new Error("Readiness identity must be the explicit approved BTC pilot identity.");
  }
}

function summarizeSelection(selection: Readonly<PositionGuardPolicySelection>): PositionGuardPilotReadinessReport["selection"] {
  if (selection.kind === "BASELINE" && selection.pilotId === null) {
    return Object.freeze({
      kind: "BASELINE",
      pilotId: null,
      candidateSelected: false,
      liveOperatorConfirmed: false,
    });
  }
  if (
    selection.kind !== "BTC_CANDIDATE_PILOT" ||
    selection.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    selection.market !== "KRW-BTC" ||
    selection.policyId !== "COMBINED_CONSERVATIVE" ||
    selection.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1" ||
    selection.liveOperatorConfirmed !== true
  ) {
    throw new Error("Readiness selection is not an approved baseline or exact BTC candidate selection.");
  }
  return Object.freeze({
    kind: selection.kind,
    pilotId: selection.pilotId,
    candidateSelected: true,
    liveOperatorConfirmed: true,
  });
}

function summarizeAuthority(authority: PositionGuardPilotReadinessAuthority): PositionGuardPilotReadinessReport["authority"] {
  const validation = authority?.validation;
  const valid = authority?.source === "CHECKED_IN_REGISTRY" &&
    validation?.valid === true &&
    validation.experimentId === EXPECTED_AUTHORITY.experimentId &&
    validation.eventAt === EXPECTED_AUTHORITY.eventAt;
  return Object.freeze({
    source: "CHECKED_IN_REGISTRY",
    valid,
    experimentId: typeof validation?.experimentId === "string" ? validation.experimentId : null,
    eventAt: typeof validation?.eventAt === "string" ? validation.eventAt : null,
  });
}

function configurationCheck(
  selection: Readonly<PositionGuardPolicySelection>,
  identity: Readonly<PositionGuardPilotReadinessIdentity>,
): PositionGuardPilotReadinessCheck {
  if (selection.kind === "BASELINE") {
    return {
      name: "pilot_configuration",
      status: "WARN",
      detail: "Baseline is selected. This safe default does not activate or imply the BTC candidate pilot.",
    };
  }
  const matches = selection.pilotId === identity.pilotId && selection.market === identity.market &&
    selection.policyId === identity.policyId && selection.policyVersion === identity.policyVersion;
  return {
    name: "pilot_configuration",
    status: matches ? "PASS" : "BLOCK",
    detail: matches
      ? "Explicit candidate selection matches the inspected BTC pilot identity; inspection itself grants no activation authority."
      : "Explicit candidate selection does not match the inspected pilot identity.",
  };
}

function authorityCheck(authority: PositionGuardPilotReadinessReport["authority"]): PositionGuardPilotReadinessCheck {
  return {
    name: "authority_record",
    status: authority.valid ? "PASS" : "BLOCK",
    detail: authority.valid
      ? "Checked-in PCS-2026-001 abandonment authority matches the frozen local record; this is historical authority, not LIVE approval."
      : "Checked-in PCS-2026-001 abandonment authority is missing or does not match the frozen local record.",
  };
}

function validateRequiredSchema(db: DatabaseSync): string | null {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: unknown }>;
  const names = new Set(tables.map((row) => row.name).filter((name): name is string => typeof name === "string"));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!names.has(table)) return `Required table ${table} is missing (pre-0017 or incomplete schema).`;
    const columns = db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as Array<{ name: unknown }>;
    const columnNames = new Set(columns.map((row) => row.name).filter((name): name is string => typeof name === "string"));
    for (const column of requiredColumns) {
      if (!columnNames.has(column)) return `Required column ${table}.${column} is missing.`;
    }
  }
  const migration = db.prepare("SELECT filename FROM _schema_migrations WHERE filename = ?")
    .get("0017_add_btc_candidate_live_pilot.sql") as { filename?: unknown } | undefined;
  if (migration?.filename !== "0017_add_btc_candidate_live_pilot.sql") {
    return "Migration 0017_add_btc_candidate_live_pilot.sql is not recorded as applied.";
  }
  for (const [name, expectedSql] of Object.entries(REQUIRED_AUDIT_IMMUTABILITY_TRIGGERS)) {
    const trigger = db.prepare(`
      SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(name) as { tbl_name?: unknown; sql?: unknown } | undefined;
    if (trigger?.tbl_name !== "strategy_pilot_audit_events" ||
      typeof trigger.sql !== "string" || !expectedSql.test(trigger.sql)) {
      return `Required immutable append-only audit trigger ${name} is missing or malformed.`;
    }
  }
  for (const [name, expectedSql] of Object.entries(REQUIRED_BINDING_IMMUTABILITY_TRIGGERS)) {
    const trigger = db.prepare(`
      SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(name) as { tbl_name?: unknown; sql?: unknown } | undefined;
    if (trigger?.tbl_name !== "strategy_candidate_execution_bindings" ||
      typeof trigger.sql !== "string" || !expectedSql.test(trigger.sql)) {
      return `Required immutable append-only candidate binding trigger ${name} is missing or malformed.`;
    }
  }
  return null;
}

function inspectSqliteSnapshotReadSafety(
  db: DatabaseSync,
  mutable: MutableInspection,
): PositionGuardPilotReadinessCheck {
  try {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    const journalMode = requireString(row?.journal_mode, "SQLite journal mode").toUpperCase();
    if (journalMode === "WAL") {
      mutable.sqliteSharedMemory = "READER_MARKS_MAY_CHANGE";
      return {
        name: "sqlite_snapshot",
        status: "WARN",
        detail: "SQLite opened the current WAL read-only; SQLite may update SHM reader marks even though this tool issues no database or WAL writes.",
      };
    }
    if (journalMode === "DELETE" || journalMode === "TRUNCATE" || journalMode === "PERSIST") {
      return {
        name: "sqlite_snapshot",
        status: "PASS",
        detail: `SQLite opened directly read-only with ${journalMode} journal mode.`,
      };
    }
    return {
      name: "sqlite_snapshot",
      status: "BLOCK",
      detail: `SQLite journal mode ${journalMode} is not approved for this persisted readiness inspection.`,
    };
  } catch (error) {
    return {
      name: "sqlite_snapshot",
      status: "BLOCK",
      detail: `SQLite snapshot is not safely readable: ${formatError(error)}.`,
    };
  }
}

function inspectDeploymentAndReplay(
  db: DatabaseSync,
  options: PositionGuardPilotReadinessOptions,
  mutable: MutableInspection,
): void {
  const rows = db.prepare(`
    SELECT id, exchange_account_id, pilot_id, market, policy_id, policy_version, phase,
      activation_at, activation_epoch_ns, created_at, updated_at
    FROM strategy_pilot_deployments
    WHERE exchange_account_id = ? OR id = ?
    ORDER BY id ASC
  `).all(options.identity.exchangeAccountId, options.identity.deploymentId) as DeploymentRow[];
  if (rows.length === 0) {
    mutable.checks.push({
      name: "pilot_deployment",
      status: options.selection.kind === "BASELINE" ? "WARN" : "BLOCK",
      detail: options.selection.kind === "BASELINE"
        ? "No pilot deployment exists while baseline remains selected."
        : "The exact configured pilot deployment is missing.",
    });
    mutable.checks.push({ name: "pilot_phase", status: "WARN", detail: "No persisted pilot phase is available." });
    mutable.checks.push({ name: "state_replay", status: "WARN", detail: "No candidate state exists to replay." });
    mutable.checks.push({
      name: "evidence_source_provenance",
      status: options.selection.kind === "BASELINE" ? "WARN" : "BLOCK",
      detail: "No candidate deployment exists for terminal evidence provenance validation.",
    });
    return;
  }
  if (rows.length !== 1) {
    mutable.checks.push({
      name: "pilot_deployment",
      status: "BLOCK",
      detail: `Expected exactly one pilot deployment for the account and identity; found ${rows.length}.`,
    });
    mutable.checks.push({ name: "pilot_phase", status: "BLOCK", detail: "Pilot phase is ambiguous." });
    mutable.checks.push({ name: "state_replay", status: "BLOCK", detail: "Candidate state replay is ambiguous." });
    mutable.checks.push({
      name: "evidence_source_provenance",
      status: "BLOCK",
      detail: "Candidate terminal evidence provenance is ambiguous.",
    });
    return;
  }

  const row = rows[0] as DeploymentRow;
  const deployment = validateCandidatePilotDeployment({
    id: requireString(row.id, "deployment id"),
    exchangeAccountId: requireString(row.exchange_account_id, "deployment exchange account"),
    pilotId: row.pilot_id as "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: row.market as "KRW-BTC",
    policyId: row.policy_id as "COMBINED_CONSERVATIVE",
    policyVersion: row.policy_version as "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    phase: row.phase as "DISABLED" | "PENDING_FLAT" | "ACTIVE" | "PAUSED_FAULT" | "DRAINING",
    activationAt: nullableString(row.activation_at, "deployment activationAt"),
    activationEpochNs: row.activation_epoch_ns === null
      ? null
      : BigInt(requireString(row.activation_epoch_ns, "deployment activationEpochNs")),
    createdAt: requireString(row.created_at, "deployment createdAt"),
    updatedAt: requireString(row.updated_at, "deployment updatedAt"),
  });
  const identityMatches = deployment.id === options.identity.deploymentId &&
    deployment.exchangeAccountId === options.identity.exchangeAccountId &&
    deployment.pilotId === options.identity.pilotId && deployment.market === options.identity.market &&
    deployment.policyId === options.identity.policyId && deployment.policyVersion === options.identity.policyVersion;
  mutable.deployment = Object.freeze({
    id: deployment.id,
    phase: deployment.phase,
    activationAt: deployment.activationAt,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  });
  mutable.checks.push({
    name: "pilot_deployment",
    status: identityMatches ? "PASS" : "BLOCK",
    detail: identityMatches
      ? "Persisted deployment matches the exact explicit account, deployment, pilot, market, policy, and version identity."
      : "Persisted deployment identity differs from the explicit inspected identity.",
  });

  const phaseCheck = classifyPhase(deployment.phase, options.selection.kind);
  mutable.checks.push(phaseCheck);
  try {
    const replay = inspectReplay(db, deployment, options.checkedAt, mutable);
    if (replay === null) {
      mutable.checks.push({
        name: "audit_chain",
        status: "BLOCK",
        detail: "Pilot audit authority cannot be verified because exact state is unavailable.",
      });
    } else {
      inspectAuditChain(db, deployment, replay, options.checkedAt, mutable);
    }
  } catch (error) {
    if (!mutable.checks.some((item) => item.name === "state_replay")) {
      mutable.checks.push({
        name: "state_replay",
        status: "BLOCK",
        detail: `Candidate state/evidence replay is invalid: ${formatError(error)}`,
      });
    }
    if (!mutable.checks.some((item) => item.name === "audit_chain")) {
      mutable.checks.push({
        name: "audit_chain",
        status: "BLOCK",
        detail: `Pilot audit authority is invalid: ${formatError(error)}`,
      });
    }
    if (!mutable.checks.some((item) => item.name === "evidence_source_provenance")) {
      mutable.checks.push({
        name: "evidence_source_provenance",
        status: "BLOCK",
        detail: `Candidate terminal evidence provenance is invalid: ${formatError(error)}`,
      });
    }
  }
}

function inspectReplay(
  db: DatabaseSync,
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  checkedAt: string,
  mutable: MutableInspection,
): ReplayAuthority | null {
  const deploymentId = deployment.id;
  const stateRow = db.prepare(`
    SELECT deployment_id, current_episode_add_count, last_full_exit_at,
      last_full_exit_realized_pnl_krw_exact, last_entry_path, last_evidence_at,
      last_evidence_id, state_version, updated_at, material_version,
      current_episode_cost_basis_krw_exact, current_episode_inventory_quantity_exact,
      current_episode_realized_pnl_krw_exact
    FROM strategy_candidate_states WHERE deployment_id = ?
  `).get(deploymentId) as StateRow | undefined;
  if (stateRow === undefined) {
    mutable.checks.push({ name: "state_replay", status: "BLOCK", detail: "Persisted exact candidate state is missing." });
    mutable.checks.push({
      name: "evidence_source_provenance",
      status: "BLOCK",
      detail: "Terminal evidence provenance cannot be validated without persisted exact candidate state.",
    });
    return null;
  }
  const persisted = exactStateFromRow(stateRow);
  const evidenceStatement = db.prepare(`
    SELECT id, executed_at, executed_at_epoch_ns, action, entry_path, terminal_status,
      material_hash, created_at, material_version, executed_quantity_exact,
      gross_quote_value_krw_exact, confirmed_fee_krw_exact, remaining_quantity_exact
    FROM strategy_candidate_execution_evidence
    WHERE deployment_id = ?
    ORDER BY executed_at_epoch_ns ASC, id ASC
  `);
  evidenceStatement.setReadBigInts(true);
  const evidenceRows = evidenceStatement.all(deploymentId) as EvidenceRow[];
  const evidence = evidenceRows.map((row) => evidenceFromRow(row, deploymentId));
  try {
    validateTerminalEvidenceSources(db, deployment, evidence, checkedAt);
    mutable.checks.push({
      name: "evidence_source_provenance",
      status: "PASS",
      detail: `${evidence.length} terminal evidence record(s) match their exact decisions, source orders, bindings, and exchange-confirmed fills.`,
    });
  } catch (error) {
    mutable.checks.push({
      name: "evidence_source_provenance",
      status: "BLOCK",
      detail: `Candidate terminal evidence source provenance is invalid: ${formatError(error)}`,
    });
  }
  mutable.stateProvenance = Object.freeze({
    materialVersion: requireString(stateRow.material_version, "candidate state materialVersion"),
    stateVersion: persisted.stateVersion,
    lastEvidenceAt: persisted.lastEvidenceAt,
    lastEvidenceId: persisted.lastEvidenceId,
    replayEqual: false,
  });
  mutable.evidenceProvenance = Object.freeze({
    count: evidence.length,
    firstEvidenceAt: evidence.at(0)?.evidence.executedAt ?? null,
    lastEvidenceAt: evidence.at(-1)?.evidence.executedAt ?? null,
    materialVersions: Object.freeze([...new Set(evidence.map((item) => item.materialVersion))].sort()),
    materialHashesValidated: evidence.every((item) => item.hashValid),
  });
  const replayed = projectExactCandidateState(evidence.map((item) => item.evidence));
  const replayEqual = sameExactState(persisted, replayed);
  mutable.stateProvenance = Object.freeze({ ...mutable.stateProvenance, replayEqual });
  const allExact = stateRow.material_version === "EXACT_V2" &&
    evidence.every((item) => item.materialVersion === "EXACT_V2" && item.hashValid);
  mutable.checks.push({
    name: "state_replay",
    status: replayEqual && allExact ? "PASS" : "BLOCK",
    detail: replayEqual && allExact
      ? `Exact persisted state equals replay of ${evidence.length} validated evidence record(s).`
      : "Exact persisted candidate state, evidence material, or deterministic replay does not match.",
  });
  return Object.freeze({ state: persisted, evidence: Object.freeze(evidence) });
}

function validateTerminalEvidenceSources(
  db: DatabaseSync,
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  evidenceRecords: readonly ValidatedEvidenceRecord[],
  checkedAt: string,
): void {
  const checkedAtEpoch = parseCandidatePilotTimestamp(checkedAt, "readiness checkedAt");
  for (const record of evidenceRecords) {
    const prefix = "terminal-order:";
    if (!record.evidence.evidenceId.startsWith(prefix)) {
      throw new Error(`Evidence ${record.evidence.evidenceId} has no canonical source-order identity.`);
    }
    const orderId = record.evidence.evidenceId.slice(prefix.length);
    if (orderId.length === 0 || record.evidence.evidenceId !== `${prefix}${orderId}`) {
      throw new Error(`Evidence ${record.evidence.evidenceId} has an invalid source-order identity.`);
    }

    const order = db.prepare(`
      SELECT id, strategy_decision_id, exchange_account_id, market, side, ord_type,
        volume, price, time_in_force, smp_type, origin, requested_at, status,
        execution_mode, upbit_uuid, created_at, updated_at
      FROM orders WHERE id = ?
    `).get(orderId) as EvidenceSourceOrderRow | undefined;
    if (!order) throw new Error(`Evidence ${record.evidence.evidenceId} source order is missing.`);

    const bindingStatement = db.prepare(`
      SELECT id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
        activation_at, activation_epoch_ns, market, strategy_key, policy_id, policy_version,
        execution_mode, ord_type, action, side, intended_quantity_exact,
        intended_notional_krw_exact, bound_price_exact, bound_volume_exact,
        bound_time_in_force, bound_smp_type, material_version, order_material_hash, created_at
      FROM strategy_candidate_execution_bindings WHERE order_id = ?
    `);
    bindingStatement.setReadBigInts(true);
    const bindingRow = bindingStatement.get(orderId) as ReadinessBindingRow | undefined;
    if (!bindingRow) throw new Error(`Evidence ${record.evidence.evidenceId} source binding is missing.`);
    const binding = bindingFromReadinessRow(bindingRow);

    const decision = db.prepare(`
      SELECT id, exchange_account_id, strategy_key, market, action, status,
        decision_basis_json, intended_notional_krw, intended_quantity,
        reference_price, created_at
      FROM strategy_decisions WHERE id = ?
    `).get(binding.strategyDecisionId) as ReadinessStrategyDecisionRow | undefined;
    if (!decision) throw new Error(`Evidence ${record.evidence.evidenceId} source strategy decision is missing.`);

    const fillRows = db.prepare(`
      SELECT id, order_id, exchange_fill_id, market, side, price, volume,
        fee_currency, fee_amount, fee_provenance, filled_at, raw_payload_json,
        execution_timestamp_provenance, execution_epoch_ns
      FROM fills WHERE order_id = ?
      ORDER BY execution_epoch_ns ASC, exchange_fill_id ASC, id ASC
    `).all(orderId) as ReadinessFillRow[];

    const orderStatus = requireOrderLifecycleStatus(order.status);
    const strategyDecisionId = nullableString(order.strategy_decision_id, "evidence source strategyDecisionId");
    const requestedAt = requireString(order.requested_at, "evidence source order requestedAt");
    const createdAt = requireString(order.created_at, "evidence source order createdAt");
    const updatedAt = requireString(order.updated_at, "evidence source order updatedAt");
    const requestedEpoch = parseCandidatePilotTimestamp(requestedAt, "evidence source order requestedAt");
    const createdEpoch = parseCandidatePilotTimestamp(createdAt, "evidence source order createdAt");
    const updatedEpoch = parseCandidatePilotTimestamp(updatedAt, "evidence source order updatedAt");
    const evidenceEpoch = parseCandidatePilotTimestamp(
      record.evidence.executedAt,
      "candidate evidence executedAt",
    );
    const bindingEpoch = parseCandidatePilotTimestamp(binding.createdAt, "candidate binding createdAt");

    if (
      requireString(order.id, "evidence source order id") !== orderId ||
      strategyDecisionId === null ||
      strategyDecisionId !== binding.strategyDecisionId ||
      requireString(order.exchange_account_id, "evidence source account") !== deployment.exchangeAccountId ||
      binding.exchangeAccountId !== deployment.exchangeAccountId ||
      binding.deploymentId !== deployment.id ||
      binding.market !== deployment.market ||
      binding.policyId !== deployment.policyId ||
      binding.policyVersion !== deployment.policyVersion ||
      deployment.activationAt === null ||
      deployment.activationEpochNs === null ||
      binding.activationAt !== deployment.activationAt ||
      binding.activationEpochNs !== deployment.activationEpochNs ||
      binding.orderId !== orderId ||
      requireString(order.market, "evidence source market") !== binding.market ||
      requireString(order.execution_mode, "evidence source executionMode") !== binding.executionMode ||
      requireString(order.execution_mode, "evidence source executionMode") !== "LIVE" ||
      nullableString(order.upbit_uuid, "evidence source upbitUuid") === null ||
      requireString(order.ord_type, "evidence source ordType") !== binding.ordType ||
      requireString(order.side, "evidence source side") !== binding.side ||
      nullableString(order.price, "evidence source price") !== binding.boundPrice ||
      nullableString(order.volume, "evidence source volume") !== binding.boundVolume ||
      nullableString(order.time_in_force, "evidence source timeInForce") !== binding.boundTimeInForce ||
      nullableString(order.smp_type, "evidence source smpType") !== binding.boundSmpType ||
      requireString(order.origin, "evidence source origin") !== "STRATEGY" ||
      (orderStatus !== "FILLED" && orderStatus !== "CANCELED") ||
      orderStatus !== record.evidence.terminalStatus ||
      binding.action !== record.evidence.action ||
      createdAt !== requestedAt ||
      createdEpoch !== requestedEpoch ||
      bindingEpoch + 1n !== requestedEpoch ||
      evidenceEpoch < requestedEpoch ||
      updatedEpoch < evidenceEpoch ||
      updatedEpoch > checkedAtEpoch ||
      evidenceEpoch > checkedAtEpoch
    ) {
      throw new Error(`Evidence ${record.evidence.evidenceId} conflicts with its source order or binding authority.`);
    }

    validateEvidenceStrategyDecision({
      row: decision,
      deployment,
      binding,
      order,
      evidence: record.evidence,
      requestedEpoch,
      bindingEpoch,
      checkedAtEpoch,
    });
    const aggregate = deriveEvidenceFillAggregate({
      rows: fillRows,
      orderId,
      order,
      bindingEpoch,
      requestedEpoch,
      updatedEpoch,
      evidenceEpoch,
      checkedAtEpoch,
    });
    if (
      aggregate.executedAt !== record.evidence.executedAt ||
      aggregate.executedQuantity !== record.evidence.executedQuantity ||
      aggregate.grossQuoteValueKrw !== record.evidence.grossQuoteValueKrw ||
      aggregate.confirmedFeeKrw !== record.evidence.confirmedFeeKrw
    ) {
      throw new Error(`Evidence ${record.evidence.evidenceId} conflicts with exact persisted fill material.`);
    }
  }
}

function validateEvidenceStrategyDecision(input: Readonly<{
  row: ReadinessStrategyDecisionRow;
  deployment: Readonly<PositionGuardPilotDeploymentRecord>;
  binding: Readonly<CandidateExecutionBindingRecord>;
  order: EvidenceSourceOrderRow;
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>;
  requestedEpoch: bigint;
  bindingEpoch: bigint;
  checkedAtEpoch: bigint;
}>): void {
  const id = requireString(input.row.id, "evidence source decision id");
  const accountId = requireString(input.row.exchange_account_id, "evidence source decision account");
  const strategyKey = requireString(input.row.strategy_key, "evidence source decision strategyKey");
  const market = requireString(input.row.market, "evidence source decision market");
  const action = requireString(input.row.action, "evidence source decision action");
  const status = requireString(input.row.status, "evidence source decision status");
  const intendedNotionalKrw = input.row.intended_notional_krw === null
    ? null
    : canonicalNonNegativeDecimal(input.row.intended_notional_krw, "evidence source intended notional");
  const intendedQuantity = input.row.intended_quantity === null
    ? null
    : canonicalNonNegativeDecimal(input.row.intended_quantity, "evidence source intended quantity");
  if (input.row.reference_price !== null) {
    canonicalNonNegativeDecimal(input.row.reference_price, "evidence source reference price");
  }
  const decisionCreatedAt = requireString(input.row.created_at, "evidence source decision createdAt");
  const decisionEpoch = parseCandidatePilotTimestamp(decisionCreatedAt, "evidence source decision createdAt");
  const entryPath = decisionEntryPath(
    requireString(input.row.decision_basis_json, "evidence source decisionBasisJson"),
    market,
    action,
  );
  const orderSide = requireString(input.order.side, "evidence source order side");
  const orderType = requireString(input.order.ord_type, "evidence source order ordType");
  const orderPrice = nullableString(input.order.price, "evidence source order price");
  const orderVolume = nullableString(input.order.volume, "evidence source order volume");
  const isEntry = action === "ENTER" || action === "ADD";
  const isExit = action === "REDUCE" || action === "EXIT";

  if (
    id !== input.binding.strategyDecisionId ||
    id !== nullableString(input.order.strategy_decision_id, "evidence source strategyDecisionId") ||
    accountId !== input.deployment.exchangeAccountId ||
    accountId !== input.binding.exchangeAccountId ||
    accountId !== requireString(input.order.exchange_account_id, "evidence source order account") ||
    strategyKey !== "position_guard.paper_core.v1" ||
    strategyKey !== input.binding.strategyKey ||
    market !== input.deployment.market ||
    market !== input.binding.market ||
    market !== requireString(input.order.market, "evidence source order market") ||
    status !== "READY" ||
    (!isEntry && !isExit) ||
    action !== input.binding.action ||
    action !== input.evidence.action ||
    entryPath !== input.evidence.entryPath ||
    intendedNotionalKrw !== input.binding.intendedNotionalKrw ||
    intendedQuantity !== input.binding.intendedQuantity ||
    decisionEpoch > input.bindingEpoch ||
    decisionEpoch > input.checkedAtEpoch ||
    input.bindingEpoch >= input.requestedEpoch ||
    input.deployment.activationEpochNs === null ||
    input.requestedEpoch < input.deployment.activationEpochNs
  ) {
    throw new Error(`Evidence ${input.evidence.evidenceId} conflicts with its persisted strategy decision.`);
  }
  if (isEntry) {
    if (
      orderSide !== "bid" || orderType !== "price" || orderVolume !== null ||
      orderPrice === null || orderPrice !== intendedNotionalKrw || intendedQuantity !== null ||
      nullableString(input.order.time_in_force, "evidence source order timeInForce") !== null ||
      nullableString(input.order.smp_type, "evidence source order smpType") !== null
    ) {
      throw new Error(`Evidence ${input.evidence.evidenceId} conflicts with its entry decision shape.`);
    }
  } else if (
    orderSide !== "ask" || orderType !== "market" || orderPrice !== null ||
    orderVolume === null || orderVolume !== intendedQuantity || intendedNotionalKrw !== null ||
    nullableString(input.order.time_in_force, "evidence source order timeInForce") !== null ||
    nullableString(input.order.smp_type, "evidence source order smpType") !== null
  ) {
    throw new Error(`Evidence ${input.evidence.evidenceId} conflicts with its exit decision shape.`);
  }
}

function decisionEntryPath(
  value: string,
  market: string,
  action: string,
): PositionGuardCandidateExecutionEvidence["entryPath"] {
  const basis = parsePlainJsonObject(value, "evidence source decision basis");
  if (!isPlainRecord(basis.strategyDecision) || !isPlainRecord(basis.engineDecision)) {
    throw new Error("Evidence source decision basis is missing strategy or engine provenance.");
  }
  const diagnostics = isPlainRecord(basis.engineDecision.diagnostics)
    ? basis.engineDecision.diagnostics
    : null;
  const canonicalEntryPath = diagnostics?.entryPath;
  const legacyEntryPath = basis.engineDecision.entryPath;
  if (
    canonicalEntryPath !== undefined && legacyEntryPath !== undefined &&
    canonicalEntryPath !== legacyEntryPath
  ) {
    throw new Error("Evidence source decision basis contains conflicting entry-path provenance.");
  }
  const entryPath = canonicalEntryPath ?? legacyEntryPath;
  if (
    basis.strategyDecision.market !== market ||
    basis.strategyDecision.action !== action ||
    (entryPath !== "PULLBACK" && entryPath !== "RECLAIM" &&
      entryPath !== "BREAKOUT_HOLD" && entryPath !== "NONE")
  ) {
    throw new Error("Evidence source decision basis conflicts with persisted decision provenance.");
  }
  return entryPath;
}

function deriveEvidenceFillAggregate(input: Readonly<{
  rows: readonly ReadinessFillRow[];
  orderId: string;
  order: EvidenceSourceOrderRow;
  bindingEpoch: bigint;
  requestedEpoch: bigint;
  updatedEpoch: bigint;
  evidenceEpoch: bigint;
  checkedAtEpoch: bigint;
}>): Readonly<{
  executedAt: string;
  executedQuantity: string;
  grossQuoteValueKrw: string;
  confirmedFeeKrw: string;
}> {
  if (input.rows.length === 0) {
    throw new Error(`Evidence terminal-order:${input.orderId} has no persisted exchange fill.`);
  }
  const orderMarket = requireString(input.order.market, "evidence source order market");
  const orderSide = requireString(input.order.side, "evidence source order side");
  const seenFillIds = new Set<string>();
  const seenExchangeFillIds = new Set<string>();
  const verified = input.rows.map((row) => {
    const id = requireString(row.id, "evidence source fill id");
    const exchangeFillId = requireString(row.exchange_fill_id, "evidence source exchangeFillId");
    if (seenFillIds.has(id) || seenExchangeFillIds.has(exchangeFillId)) {
      throw new Error(`Evidence terminal-order:${input.orderId} has duplicate fill identity.`);
    }
    seenFillIds.add(id);
    seenExchangeFillIds.add(exchangeFillId);
    if (
      requireString(row.order_id, "evidence source fill orderId") !== input.orderId ||
      requireString(row.market, "evidence source fill market") !== orderMarket ||
      requireString(row.side, "evidence source fill side") !== orderSide
    ) {
      throw new Error(`Evidence terminal-order:${input.orderId} fill conflicts with its source order.`);
    }
    if (
      requireString(row.fee_currency, "evidence source fill feeCurrency") !== "KRW" ||
      requireString(row.fee_provenance, "evidence source fill feeProvenance") !== "EXCHANGE_FILL_CONFIRMED" ||
      requireString(
        row.execution_timestamp_provenance,
        "evidence source fill timestamp provenance",
      ) !== "EXCHANGE_FILL_CONFIRMED"
    ) {
      throw new Error(`Evidence terminal-order:${input.orderId} fill provenance is not exchange-confirmed.`);
    }
    parsePlainJsonObject(requireString(row.raw_payload_json, "evidence source fill raw payload"), "fill raw payload");
    const price = parseCanonicalNonNegativeDecimal(row.price, "evidence source fill price");
    const volume = parseCanonicalNonNegativeDecimal(row.volume, "evidence source fill volume");
    const fee = parseCanonicalNonNegativeDecimal(row.fee_amount, "evidence source fill fee");
    if (price.coefficient === 0n || volume.coefficient === 0n) {
      throw new Error(`Evidence terminal-order:${input.orderId} fill price and volume must be positive.`);
    }
    const executionEpochRaw = requireString(row.execution_epoch_ns, "evidence source fill executionEpochNs");
    if (!/^(0|[1-9][0-9]*)$/u.test(executionEpochRaw)) {
      throw new Error(`Evidence terminal-order:${input.orderId} fill execution epoch is invalid.`);
    }
    const filledAt = requireString(row.filled_at, "evidence source fill filledAt");
    const executionEpoch = parseCandidatePilotTimestamp(filledAt, "evidence source fill filledAt");
    if (
      executionEpoch.toString() !== executionEpochRaw ||
      executionEpoch < input.requestedEpoch ||
      executionEpoch <= input.bindingEpoch ||
      executionEpoch > input.evidenceEpoch ||
      executionEpoch > input.updatedEpoch ||
      executionEpoch > input.checkedAtEpoch
    ) {
      throw new Error(`Evidence terminal-order:${input.orderId} fill timestamp provenance is invalid or future-dated.`);
    }
    return { id, exchangeFillId, filledAt, executionEpoch, price, volume, fee };
  }).sort((left, right) => {
    if (left.executionEpoch < right.executionEpoch) return -1;
    if (left.executionEpoch > right.executionEpoch) return 1;
    if (left.exchangeFillId !== right.exchangeFillId) {
      return left.exchangeFillId < right.exchangeFillId ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  let executedQuantity = parseCanonicalNonNegativeDecimal("0", "evidence aggregate quantity");
  let grossQuoteValueKrw = parseCanonicalNonNegativeDecimal("0", "evidence aggregate gross");
  let confirmedFeeKrw = parseCanonicalNonNegativeDecimal("0", "evidence aggregate fee");
  for (const fill of verified) {
    executedQuantity = addExactDecimals(executedQuantity, fill.volume);
    grossQuoteValueKrw = addExactDecimals(
      grossQuoteValueKrw,
      multiplyExactDecimals(fill.price, fill.volume),
    );
    confirmedFeeKrw = addExactDecimals(confirmedFeeKrw, fill.fee);
  }
  if (executedQuantity.coefficient === 0n) {
    throw new Error(`Evidence terminal-order:${input.orderId} contains only zero fill quantity.`);
  }
  const orderVolume = nullableString(input.order.volume, "evidence source order volume");
  if (
    orderVolume !== null &&
    compareExactDecimals(executedQuantity, parseCanonicalNonNegativeDecimal(orderVolume, "order volume")) > 0
  ) {
    throw new Error(`Evidence terminal-order:${input.orderId} fill quantity exceeds its source order.`);
  }
  const orderType = requireString(input.order.ord_type, "evidence source order ordType");
  if (orderSide === "bid" && orderType === "price") {
    const orderPrice = parseCanonicalNonNegativeDecimal(input.order.price, "evidence source order price");
    if (compareExactDecimals(grossQuoteValueKrw, orderPrice) > 0) {
      throw new Error(`Evidence terminal-order:${input.orderId} fill gross exceeds its source order budget.`);
    }
  }
  const latest = verified.at(-1)!;
  if (latest.executionEpoch !== input.evidenceEpoch) {
    throw new Error(`Evidence terminal-order:${input.orderId} executedAt does not equal its latest fill.`);
  }
  return Object.freeze({
    executedAt: latest.filledAt,
    executedQuantity: formatExactDecimal(executedQuantity),
    grossQuoteValueKrw: formatExactDecimal(grossQuoteValueKrw),
    confirmedFeeKrw: formatExactDecimal(confirmedFeeKrw),
  });
}

function bindingFromReadinessRow(row: ReadinessBindingRow): CandidateExecutionBindingRecord {
  return validateCandidateExecutionBinding({
    id: requireString(row.id, "candidate binding id"),
    deploymentId: requireString(row.deployment_id, "candidate binding deploymentId"),
    strategyDecisionId: requireString(row.strategy_decision_id, "candidate binding strategyDecisionId"),
    orderId: requireString(row.order_id, "candidate binding orderId"),
    exchangeAccountId: requireString(row.exchange_account_id, "candidate binding exchangeAccountId"),
    activationAt: requireString(row.activation_at, "candidate binding activationAt"),
    activationEpochNs: requireNonNegativeBigInt(row.activation_epoch_ns, "candidate binding activationEpochNs"),
    market: requireString(row.market, "candidate binding market") as CandidateExecutionBindingRecord["market"],
    strategyKey: requireString(
      row.strategy_key,
      "candidate binding strategyKey",
    ) as CandidateExecutionBindingRecord["strategyKey"],
    policyId: requireString(row.policy_id, "candidate binding policyId") as CandidateExecutionBindingRecord["policyId"],
    policyVersion: requireString(
      row.policy_version,
      "candidate binding policyVersion",
    ) as CandidateExecutionBindingRecord["policyVersion"],
    executionMode: requireString(
      row.execution_mode,
      "candidate binding executionMode",
    ) as CandidateExecutionBindingRecord["executionMode"],
    ordType: requireString(row.ord_type, "candidate binding ordType") as CandidateExecutionBindingRecord["ordType"],
    action: requireString(row.action, "candidate binding action") as CandidateExecutionBindingRecord["action"],
    side: requireString(row.side, "candidate binding side") as CandidateExecutionBindingRecord["side"],
    intendedQuantity: nullableString(row.intended_quantity_exact, "candidate binding intendedQuantity"),
    intendedNotionalKrw: nullableString(
      row.intended_notional_krw_exact,
      "candidate binding intendedNotionalKrw",
    ),
    boundPrice: nullableString(row.bound_price_exact, "candidate binding boundPrice"),
    boundVolume: nullableString(row.bound_volume_exact, "candidate binding boundVolume"),
    boundTimeInForce: nullableString(
      row.bound_time_in_force,
      "candidate binding boundTimeInForce",
    ) as CandidateExecutionBindingRecord["boundTimeInForce"],
    boundSmpType: nullableString(
      row.bound_smp_type,
      "candidate binding boundSmpType",
    ) as CandidateExecutionBindingRecord["boundSmpType"],
    materialVersion: requireString(
      row.material_version,
      "candidate binding materialVersion",
    ) as CandidateExecutionBindingRecord["materialVersion"],
    orderMaterialHash: requireString(row.order_material_hash, "candidate binding orderMaterialHash"),
    createdAt: requireString(row.created_at, "candidate binding createdAt"),
  });
}

function inspectAuditChain(
  db: DatabaseSync,
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  replay: ReplayAuthority,
  checkedAt: string,
  mutable: MutableInspection,
): void {
  try {
    const statement = db.prepare(`
      SELECT id, deployment_id, event_type, from_phase, to_phase, state_version,
        payload_json, created_at, created_at_epoch_ns
      FROM strategy_pilot_audit_events
      WHERE deployment_id = ?
      ORDER BY created_at_epoch_ns ASC, id ASC
    `);
    statement.setReadBigInts(true);
    const rows = statement.all(deployment.id) as AuditRow[];
    const events = validateAuditRows(rows, deployment, replay.state, checkedAt);
    assertCanonicalAuditLifecycle(deployment, replay, events);
    mutable.checks.push({
      name: "audit_chain",
      status: "PASS",
      detail: `Immutable pilot audit authority proves the ${deployment.phase} lifecycle and ${replay.evidence.length} exact state advance(s).`,
    });
  } catch (error) {
    mutable.checks.push({
      name: "audit_chain",
      status: "BLOCK",
      detail: `Immutable pilot audit authority is invalid: ${formatError(error)}`,
    });
  }
}

function validateAuditRows(
  rows: readonly AuditRow[],
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  state: Readonly<ExactCandidateState>,
  checkedAt: string,
): readonly Readonly<PositionGuardPilotAuditEventRecord>[] {
  const deploymentCreatedAt = parseCandidatePilotTimestamp(deployment.createdAt, "deployment createdAt");
  const checkedAtEpoch = parseCandidatePilotTimestamp(checkedAt, "readiness checkedAt");
  const ids = new Set<string>();
  let previousEpoch: bigint | null = null;
  let previousId: string | null = null;
  const events = rows.map((row, index) => {
    const id = requireString(row.id, `audit event ${index} id`);
    if (ids.has(id)) throw new Error(`audit event id ${id} is duplicated`);
    ids.add(id);
    if (requireString(row.deployment_id, `audit event ${index} deployment`) !== deployment.id) {
      throw new Error(`audit event ${id} deployment identity is inconsistent`);
    }
    const eventType = requireString(row.event_type, `audit event ${id} type`);
    if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new Error(`audit event ${id} type is unsupported`);
    }
    const fromPhase = nullablePilotPhase(row.from_phase, `audit event ${id} fromPhase`);
    const toPhase = nullablePilotPhase(row.to_phase, `audit event ${id} toPhase`);
    const stateVersion = requireSafeNonNegativeInteger(row.state_version, `audit event ${id} stateVersion`);
    if (stateVersion > state.stateVersion) throw new Error(`audit event ${id} state version exceeds exact state`);
    const payloadJson = requireString(row.payload_json, `audit event ${id} payloadJson`);
    parsePlainJsonObject(payloadJson, `audit event ${id} payload`);
    const createdAt = requireString(row.created_at, `audit event ${id} createdAt`);
    const createdAtEpoch = parseCandidatePilotTimestamp(createdAt, `audit event ${id} createdAt`);
    const persistedEpoch = typeof row.created_at_epoch_ns === "bigint"
      ? row.created_at_epoch_ns
      : BigInt(requireString(row.created_at_epoch_ns, `audit event ${id} persisted epoch`));
    if (persistedEpoch !== createdAtEpoch) throw new Error(`audit event ${id} timestamp and epoch are inconsistent`);
    if (createdAtEpoch < deploymentCreatedAt || createdAtEpoch > checkedAtEpoch) {
      throw new Error(`audit event ${id} chronology is outside deployment and inspection bounds`);
    }
    if (
      previousEpoch !== null &&
      (createdAtEpoch < previousEpoch || (createdAtEpoch === previousEpoch && id <= previousId!))
    ) {
      throw new Error(`audit event ${id} chronology is not strictly ordered`);
    }
    previousEpoch = createdAtEpoch;
    previousId = id;
    return Object.freeze({
      id,
      deploymentId: deployment.id,
      eventType: eventType as PositionGuardPilotAuditEventRecord["eventType"],
      fromPhase,
      toPhase,
      stateVersion,
      payloadJson,
      createdAt,
    });
  });
  return Object.freeze(events);
}

function assertCanonicalAuditLifecycle(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  replay: ReplayAuthority,
  events: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
): void {
  assertCanonicalCreationEvent(deployment, events);
  const activationEvents = events.filter((event) => event.eventType === "PHASE_TRANSITION");
  const stateEvents = events.filter((event) => event.eventType === "STATE_ADVANCED");
  const rollbackEvents = events.filter((event) => event.eventType === "ROLLBACK_STARTED");
  const completionEvents = events.filter((event) => event.eventType === "ROLLBACK_COMPLETED");
  const faultEvents = events.filter((event) => event.eventType === "FAULT_PAUSED");

  const requiresActivation = deployment.activationAt !== null || deployment.activationEpochNs !== null;
  if ((deployment.activationAt === null) !== (deployment.activationEpochNs === null)) {
    throw new Error("deployment activation timestamp and epoch must be persisted together");
  }
  if (requiresActivation) {
    assertCanonicalActivationEvent(deployment, activationEvents);
  } else if (activationEvents.length !== 0 || replay.evidence.length !== 0) {
    throw new Error("audit authority contains activation or evidence without deployment activation");
  }

  const rollback = rollbackEvents.length === 1 ? rollbackEvents[0]! : null;
  if (rollbackEvents.length > 1) throw new Error("audit authority contains multiple rollback-start events");
  const rollbackBoundary = rollback === null
    ? null
    : assertCanonicalRollbackStart(deployment, replay, events, rollback);
  assertCanonicalStateEvents(deployment, replay, events, stateEvents, rollbackBoundary);

  switch (deployment.phase) {
    case "PENDING_FLAT":
      if (requiresActivation || replay.evidence.length !== 0 || replay.state.stateVersion !== 0 ||
        deployment.updatedAt !== deployment.createdAt || rollback !== null ||
        faultEvents.length !== 0 || completionEvents.length !== 0) {
        throw new Error("PENDING_FLAT audit authority is not pristine");
      }
      break;
    case "ACTIVE":
      if (!requiresActivation || deployment.updatedAt !== deployment.activationAt || rollback !== null ||
        faultEvents.length !== 0 || completionEvents.length !== 0) {
        throw new Error("ACTIVE audit authority is inconsistent with canonical activation");
      }
      break;
    case "DRAINING":
      if (!requiresActivation || rollback === null || deployment.updatedAt !== rollback.createdAt ||
        faultEvents.length !== 0 || completionEvents.length !== 0) {
        throw new Error("DRAINING audit authority requires one current rollback-start transition");
      }
      break;
    case "PAUSED_FAULT":
      if (completionEvents.length !== 0) throw new Error("PAUSED_FAULT audit authority cannot be rollback-completed");
      assertCanonicalFaultEvent(deployment, replay, events, faultEvents, rollback);
      break;
    case "DISABLED":
      if (faultEvents.length !== 0) throw new Error("DISABLED audit authority cannot retain fault-pause authority");
      assertCanonicalRollbackCompletion(deployment, replay.state, events, completionEvents, rollback);
      break;
    default:
      throw new Error("pilot phase is unsupported");
  }

  const expectedCount = 1 + activationEvents.length + stateEvents.length + rollbackEvents.length +
    completionEvents.length + faultEvents.length;
  if (events.length !== expectedCount) throw new Error("audit authority contains unsupported lifecycle events");
}

function assertCanonicalCreationEvent(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  events: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
): void {
  const creations = events.filter((event) => event.eventType === "DEPLOYMENT_CREATED");
  const expectedPayload = JSON.stringify({
    pilotId: deployment.pilotId,
    market: deployment.market,
    policyId: deployment.policyId,
    policyVersion: deployment.policyVersion,
  });
  const event = creations[0];
  if (creations.length !== 1 || event === undefined ||
    event.id !== `${deployment.id}:created` || event.deploymentId !== deployment.id ||
    event.fromPhase !== null || event.toPhase !== "PENDING_FLAT" || event.stateVersion !== 0 ||
    event.payloadJson !== expectedPayload || event.createdAt !== deployment.createdAt) {
    throw new Error("canonical DEPLOYMENT_CREATED audit authority is missing or malformed");
  }
  if (events[0]?.id !== event.id) {
    throw new Error("canonical DEPLOYMENT_CREATED must be the first pilot lifecycle event");
  }
}

function assertCanonicalActivationEvent(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  events: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
): void {
  if (deployment.activationAt === null || deployment.activationEpochNs === null) {
    throw new Error("activation audit has no deployment activation authority");
  }
  const event = events[0];
  const expectedPayload = JSON.stringify({
    activationAt: deployment.activationAt,
    activationEpochNs: deployment.activationEpochNs.toString(),
  });
  if (events.length !== 1 || event === undefined ||
    event.id !== `${deployment.id}:activation:${deployment.activationEpochNs.toString()}` ||
    event.fromPhase !== "PENDING_FLAT" || event.toPhase !== "ACTIVE" ||
    event.stateVersion !== 0 || event.payloadJson !== expectedPayload ||
    event.createdAt !== deployment.activationAt ||
    parseCandidatePilotTimestamp(deployment.activationAt, "deployment activationAt") !== deployment.activationEpochNs) {
    throw new Error("canonical activation PHASE_TRANSITION audit authority is missing or malformed");
  }
  if (deployment.activationEpochNs <= parseCandidatePilotTimestamp(deployment.createdAt, "deployment createdAt")) {
    throw new Error("canonical activation must occur after deployment creation");
  }
}

function assertCanonicalStateEvents(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  replay: ReplayAuthority,
  allEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  stateEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  rollbackBoundary: number | null,
): void {
  if (stateEvents.length !== replay.evidence.length || replay.state.stateVersion !== replay.evidence.length) {
    throw new Error("STATE_ADVANCED audit count does not match exact evidence and state version");
  }
  const activationAt = deployment.activationAt === null
    ? null
    : parseCandidatePilotTimestamp(deployment.activationAt, "deployment activationAt");
  for (let index = 0; index < replay.evidence.length; index += 1) {
    const record = replay.evidence[index]!;
    const event = stateEvents[index];
    const phase = rollbackBoundary !== null && index >= rollbackBoundary ? "DRAINING" : "ACTIVE";
    const expectedVersion = index + 1;
    if (phase === "DRAINING" && record.evidence.action !== "REDUCE" && record.evidence.action !== "EXIT") {
      throw new Error("DRAINING STATE_ADVANCED evidence must be REDUCE or EXIT");
    }
    const expectedPayload = JSON.stringify({
      evidenceId: record.evidence.evidenceId,
      materialHash: record.materialHash,
      materialVersion: record.materialVersion,
      fromStateVersion: index,
      toStateVersion: expectedVersion,
    });
    if (event === undefined || event.id !== `${deployment.id}:evidence:${record.evidence.evidenceId}` ||
      event.fromPhase !== phase || event.toPhase !== phase || event.stateVersion !== expectedVersion ||
      event.payloadJson !== expectedPayload || event.createdAt !== record.evidence.executedAt) {
      throw new Error("STATE_ADVANCED audit does not link exact evidence, material, state version, and phase");
    }
    const evidenceAt = parseCandidatePilotTimestamp(record.evidence.executedAt, "candidate evidence executedAt");
    if (activationAt === null || evidenceAt <= activationAt) {
      throw new Error("STATE_ADVANCED audit does not follow activation chronology");
    }
    if (index > 0 && allEvents.indexOf(stateEvents[index - 1]!) >= allEvents.indexOf(event)) {
      throw new Error("STATE_ADVANCED audit chronology is inconsistent");
    }
  }
}

function assertCanonicalRollbackStart(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  replay: ReplayAuthority,
  events: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  rollback: Readonly<PositionGuardPilotAuditEventRecord>,
): number {
  if (deployment.activationAt === null || deployment.activationEpochNs === null) {
    throw new Error("ROLLBACK_STARTED requires activation authority");
  }
  const rollbackAt = parseCandidatePilotTimestamp(rollback.createdAt, "rollback startedAt");
  const precedingStateCount = events.slice(0, events.indexOf(rollback))
    .filter((event) => event.eventType === "STATE_ADVANCED").length;
  if (rollback.id !== `${deployment.id}:rollback_started:${rollbackAt.toString()}` ||
    rollback.fromPhase !== "ACTIVE" || rollback.toPhase !== "DRAINING" ||
    rollback.stateVersion !== precedingStateCount ||
    rollback.payloadJson !== JSON.stringify({ transitionAt: rollback.createdAt })) {
    throw new Error("canonical ROLLBACK_STARTED audit authority is malformed");
  }
  const activationAt = parseCandidatePilotTimestamp(deployment.activationAt, "deployment activationAt");
  const activationEvent = events.find((event) => event.eventType === "PHASE_TRANSITION");
  if (rollbackAt < activationAt || activationEvent === undefined ||
    events.indexOf(activationEvent) >= events.indexOf(rollback)) {
    throw new Error("ROLLBACK_STARTED precedes canonical activation authority");
  }
  for (let index = 0; index < replay.evidence.length; index += 1) {
    const evidenceAt = parseCandidatePilotTimestamp(replay.evidence[index]!.evidence.executedAt, "candidate evidence executedAt");
    if ((index < precedingStateCount && evidenceAt > rollbackAt) ||
      (index >= precedingStateCount && evidenceAt < rollbackAt)) {
      throw new Error("ROLLBACK_STARTED boundary is inconsistent with exact evidence chronology");
    }
  }
  return precedingStateCount;
}

function assertCanonicalFaultEvent(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  replay: ReplayAuthority,
  allEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  faultEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  rollback: Readonly<PositionGuardPilotAuditEventRecord> | null,
): void {
  const fault = faultEvents[0];
  const expectedFrom: PositionGuardPilotPhase = rollback !== null
    ? "DRAINING"
    : deployment.activationAt === null ? "PENDING_FLAT" : "ACTIVE";
  if (faultEvents.length !== 1 || fault === undefined || fault.fromPhase !== expectedFrom ||
    fault.toPhase !== "PAUSED_FAULT" || fault.stateVersion !== replay.state.stateVersion ||
    fault.createdAt !== deployment.updatedAt) {
    throw new Error("canonical FAULT_PAUSED audit authority is missing or malformed");
  }
  const payload = parseExactJsonKeys(fault.payloadJson, ["reasonCode", "provenanceJson"], "fault audit payload");
  if (typeof payload.reasonCode !== "string" || !RECOVERY_FAULT_REASONS.has(payload.reasonCode) ||
    typeof payload.provenanceJson !== "string") {
    throw new Error("FAULT_PAUSED reason or provenance is invalid");
  }
  parsePlainJsonObject(payload.provenanceJson, "fault provenance");
  if (fault.payloadJson !== JSON.stringify({
    reasonCode: payload.reasonCode,
    provenanceJson: payload.provenanceJson,
  })) throw new Error("FAULT_PAUSED payload is not canonical JSON");
  const faultAt = parseCandidatePilotTimestamp(fault.createdAt, "fault audit createdAt");
  const latestEvidence = replay.evidence.at(-1);
  if (latestEvidence !== undefined) {
    const evidenceAt = parseCandidatePilotTimestamp(latestEvidence.evidence.executedAt, "candidate evidence executedAt");
    if (rollback === null ? faultAt < evidenceAt : faultAt <= evidenceAt) {
      throw new Error("FAULT_PAUSED chronology does not follow exact evidence");
    }
  }
  if (rollback !== null && allEvents.indexOf(rollback) >= allEvents.indexOf(fault)) {
    throw new Error("FAULT_PAUSED does not follow ROLLBACK_STARTED");
  }
  const lastStateEvent = allEvents.filter((event) => event.eventType === "STATE_ADVANCED").at(-1);
  if (lastStateEvent !== undefined && allEvents.indexOf(lastStateEvent) >= allEvents.indexOf(fault)) {
    throw new Error("FAULT_PAUSED precedes exact state authority chronology");
  }
  const activationEvent = allEvents.find((event) => event.eventType === "PHASE_TRANSITION");
  if (rollback === null && activationEvent !== undefined &&
    allEvents.indexOf(activationEvent) >= allEvents.indexOf(fault)) {
    throw new Error("FAULT_PAUSED does not follow activation authority");
  }
}

function assertCanonicalRollbackCompletion(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  state: Readonly<ExactCandidateState>,
  allEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  completionEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  rollback: Readonly<PositionGuardPilotAuditEventRecord> | null,
): void {
  const completion = completionEvents[0];
  if (completionEvents.length !== 1 || completion === undefined ||
    (completion.fromPhase !== "PENDING_FLAT" && completion.fromPhase !== "ACTIVE" && completion.fromPhase !== "DRAINING") ||
    completion.toPhase !== "DISABLED" || completion.stateVersion !== state.stateVersion ||
    completion.createdAt !== deployment.updatedAt) {
    throw new Error("canonical ROLLBACK_COMPLETED audit authority is missing or malformed");
  }
  const completedAt = parseCandidatePilotTimestamp(completion.createdAt, "rollback completedAt");
  if (completion.id !== `${deployment.id}:rollback_completed:${completedAt.toString()}` ||
    completion.payloadJson !== JSON.stringify({ transitionAt: completion.createdAt })) {
    throw new Error("canonical ROLLBACK_COMPLETED identity or payload is malformed");
  }
  if (!isExactRollbackFlat(state)) throw new Error("ROLLBACK_COMPLETED requires exact-flat state");
  if ((completion.fromPhase === "DRAINING") !== (rollback !== null)) {
    throw new Error("ROLLBACK_COMPLETED phase does not match rollback-start authority");
  }
  if (completion.fromPhase === "ACTIVE" && deployment.activationAt === null) {
    throw new Error("ACTIVE ROLLBACK_COMPLETED requires activation authority");
  }
  if (completion.fromPhase === "PENDING_FLAT" && (deployment.activationAt !== null || rollback !== null)) {
    throw new Error("PENDING_FLAT ROLLBACK_COMPLETED cannot contain activation or rollback-start authority");
  }
  if (rollback !== null && allEvents.indexOf(rollback) >= allEvents.indexOf(completion)) {
    throw new Error("ROLLBACK_COMPLETED does not follow ROLLBACK_STARTED");
  }
  const lastStateEvent = allEvents.filter((event) => event.eventType === "STATE_ADVANCED").at(-1);
  if (lastStateEvent !== undefined && allEvents.indexOf(lastStateEvent) >= allEvents.indexOf(completion)) {
    throw new Error("ROLLBACK_COMPLETED precedes exact state authority chronology");
  }
}

function isExactRollbackFlat(state: Readonly<ExactCandidateState>): boolean {
  return state.currentEpisodeAddCount === 0 && state.currentEpisodeCostBasisKrw === "0" &&
    state.currentEpisodeInventoryQuantity === "0" && state.currentEpisodeRealizedPnlKrw === "0";
}

function nullablePilotPhase(value: unknown, label: string): PositionGuardPilotPhase | null {
  if (value === null) return null;
  const phase = requireString(value, label);
  if (!(PILOT_PHASES as readonly string[]).includes(phase)) throw new Error(`${label} is unsupported`);
  return phase as PositionGuardPilotPhase;
}

function parsePlainJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (!isPlainRecord(parsed)) throw new Error(`${label} must contain an object`);
  return parsed;
}

function parseExactJsonKeys(
  value: string,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const parsed = parsePlainJsonObject(value, label);
  const actual = Object.keys(parsed);
  if (actual.length !== expectedKeys.length || actual.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} keys are not canonical`);
  }
  return parsed;
}

function inspectOrders(
  db: DatabaseSync,
  options: PositionGuardPilotReadinessOptions,
  mutable: MutableInspection,
): void {
  const placeholders = SUBMISSION_BLOCKING_CANDIDATE_STATUSES.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, status, requested_at, created_at, updated_at,
      upbit_uuid, exchange_response_json, failure_code
    FROM orders
    WHERE exchange_account_id = ? AND status IN (${placeholders})
    ORDER BY created_at ASC, id ASC
  `).all(options.identity.exchangeAccountId, ...SUBMISSION_BLOCKING_CANDIDATE_STATUSES) as OrderRow[];
  const activeStatuses: string[] = [];
  const uncertainStatuses: string[] = [];
  const blockingOrders: Array<{
    id: string;
    status: string;
    reasonCode: SubmissionBlockingReasonCode;
    reason: string;
  }> = [];
  for (const row of rows) {
    const id = requireString(row.id, "order id");
    const status = requireOrderLifecycleStatus(row.status);
    parseCandidatePilotTimestamp(requireString(row.requested_at, "order requestedAt"), "order requestedAt");
    parseCandidatePilotTimestamp(requireString(row.created_at, "order createdAt"), "order createdAt");
    parseCandidatePilotTimestamp(requireString(row.updated_at, "order updatedAt"), "order updatedAt");
    const classification = classifySubmissionBlockingOrder({
      order: {
        id,
        status,
        failureCode: nullableString(row.failure_code, "order failureCode"),
        upbitUuid: nullableString(row.upbit_uuid, "order upbitUuid"),
        exchangeResponseJson: nullableString(row.exchange_response_json, "order exchangeResponseJson"),
      },
      events: (db.prepare(`
        SELECT event_type, event_source, created_at
        FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC
      `).all(id) as ReadinessOrderEventRow[]).map((event) => ({
        eventType: requireString(event.event_type, "order event type"),
        eventSource: requireOrderEventSource(event.event_source),
        createdAt: requireString(event.created_at, "order event createdAt"),
      })),
      recoveryObservations: (db.prepare(`
        SELECT outcome, observed_at_epoch_ms
        FROM order_submission_recovery_observations
        WHERE order_id = ? ORDER BY observed_at_epoch_ms ASC, id ASC
      `).all(id) as ReadinessRecoveryObservationRow[]).map((observation) => ({
        outcome: requireRecoveryOutcome(observation.outcome),
        observedAtEpochMs: requireSafeNonNegativeInteger(
          observation.observed_at_epoch_ms,
          "order recovery observation epoch",
        ),
      })),
    });
    if (!classification.blocking) continue;
    activeStatuses.push(status);
    if ((UNCERTAIN_ORDER_STATUSES as readonly string[]).includes(status)) uncertainStatuses.push(status);
    blockingOrders.push({ id, status, reasonCode: classification.reasonCode, reason: classification.reason });
  }
  mutable.orderState = Object.freeze({
    activeCount: blockingOrders.length,
    uncertainCount: uncertainStatuses.length,
    activeStatuses: Object.freeze(activeStatuses),
    uncertainStatuses: Object.freeze(uncertainStatuses),
    blockingOrders: Object.freeze(blockingOrders.map((order) => Object.freeze(order))),
  });
  mutable.checks.push({
    name: "active_orders",
    status: blockingOrders.length === 0 ? "PASS" : "BLOCK",
    detail: blockingOrders.length === 0
      ? "No account-wide submission-blocking order is persisted."
      : blockingOrders.map((order) => `${order.id}:${order.reasonCode}`).join(", "),
  });
  mutable.checks.push({
    name: "uncertain_orders",
    status: uncertainStatuses.length === 0 ? "PASS" : "BLOCK",
    detail: uncertainStatuses.length === 0
      ? "No unresolved submission-uncertain account order is persisted."
      : `${uncertainStatuses.length} unresolved submission-uncertain account order(s) require reconciliation.`,
  });
}

function inspectHealth(
  db: DatabaseSync,
  options: PositionGuardPilotReadinessOptions,
  mutable: MutableInspection,
): void {
  const balanceRows = db.prepare(`
    SELECT id, captured_at, source, total_krw_value, balances_json
    FROM balance_snapshots WHERE exchange_account_id = ?
  `).all(options.identity.exchangeAccountId) as BalanceRow[];
  const balanceSelection = selectLatestTimestampedRow(
    balanceRows,
    (row) => row.id,
    (row) => row.captured_at,
    "balance snapshot",
  );
  const balance = classifySnapshot(
    balanceSelection.error === null && balanceSelection.row !== null
      ? {
          id: balanceSelection.row.id,
          capturedAt: balanceSelection.row.captured_at,
          source: balanceSelection.row.source,
          payloadJson: balanceSelection.row.balances_json,
          numericValue: balanceSelection.row.total_krw_value,
        }
      : null,
    options,
    "balance",
  );
  const balanceResult = balanceSelection.error === null
    ? balance
    : { status: "BLOCK" as const, detail: balanceSelection.error, evidence: null };
  mutable.health = { ...mutable.health, balance: balanceResult.evidence };
  mutable.checks.push({ name: "balance_snapshot", status: balanceResult.status, detail: balanceResult.detail });

  const positionRows = db.prepare(`
    SELECT id, captured_at, source, positions_json
    FROM position_snapshots WHERE exchange_account_id = ?
  `).all(options.identity.exchangeAccountId) as PositionRow[];
  const positionSelection = selectLatestTimestampedRow(
    positionRows,
    (row) => row.id,
    (row) => row.captured_at,
    "position snapshot",
  );
  const position = classifySnapshot(
    positionSelection.error === null && positionSelection.row !== null
      ? {
          id: positionSelection.row.id,
          capturedAt: positionSelection.row.captured_at,
          source: positionSelection.row.source,
          payloadJson: positionSelection.row.positions_json,
          numericValue: null,
        }
      : null,
    options,
    "position",
  );
  const positionResult = positionSelection.error === null
    ? position
    : { status: "BLOCK" as const, detail: positionSelection.error, evidence: null };
  mutable.health = { ...mutable.health, position: positionResult.evidence };
  mutable.checks.push({ name: "position_snapshot", status: positionResult.status, detail: positionResult.detail });

  const reconciliationRows = db.prepare(`
    SELECT id, status, started_at, completed_at, summary_json, error_message
    FROM reconciliation_runs WHERE exchange_account_id = ?
  `).all(options.identity.exchangeAccountId) as ReconciliationRow[];
  const reconciliationSelection = selectLatestReconciliationRow(reconciliationRows);
  const reconciliation = reconciliationSelection.error === null
    ? classifyReconciliation(reconciliationSelection.row, options)
    : { status: "BLOCK" as const, detail: reconciliationSelection.error, evidence: null };
  mutable.health = { ...mutable.health, reconciliation: reconciliation.evidence };
  mutable.checks.push({
    name: "latest_reconciliation",
    status: reconciliation.status,
    detail: reconciliation.detail,
  });
}

function selectLatestTimestampedRow<Row>(
  rows: readonly Row[],
  readId: (row: Row) => unknown,
  readTimestamp: (row: Row) => unknown,
  label: string,
): Readonly<{ row: Row | null; error: string | null }> {
  try {
    let latest: { row: Row; id: string; epoch: bigint } | null = null;
    for (const row of rows) {
      const id = requireString(readId(row), `${label} id`);
      const timestamp = requireString(readTimestamp(row), `${label} timestamp`);
      const epoch = parseCandidatePilotTimestamp(timestamp, `${label} timestamp`);
      if (latest === null || epoch > latest.epoch || (epoch === latest.epoch && id > latest.id)) {
        latest = { row, id, epoch };
      }
    }
    return { row: latest?.row ?? null, error: null };
  } catch (error) {
    return { row: null, error: `Persisted ${label} timestamp set is invalid: ${formatError(error)}` };
  }
}

function selectLatestReconciliationRow(
  rows: readonly ReconciliationRow[],
): Readonly<{ row: ReconciliationRow | null; error: string | null }> {
  try {
    let latest: { row: ReconciliationRow; id: string; epoch: bigint } | null = null;
    for (const row of rows) {
      const id = requireString(row.id, "reconciliation id");
      const startedAt = requireString(row.started_at, `reconciliation ${id} startedAt`);
      const startedEpoch = parseCandidatePilotTimestamp(startedAt, `reconciliation ${id} startedAt`);
      const completedAt = nullableString(row.completed_at, `reconciliation ${id} completedAt`);
      const completedEpoch = completedAt === null
        ? null
        : parseCandidatePilotTimestamp(completedAt, `reconciliation ${id} completedAt`);
      if (completedEpoch !== null && completedEpoch < startedEpoch) {
        throw new Error(`reconciliation ${id} completion precedes start`);
      }
      const epoch = completedEpoch ?? startedEpoch;
      if (latest === null || epoch > latest.epoch || (epoch === latest.epoch && id > latest.id)) {
        latest = { row, id, epoch };
      }
    }
    return { row: latest?.row ?? null, error: null };
  } catch (error) {
    return { row: null, error: `Persisted reconciliation timestamp set is invalid: ${formatError(error)}` };
  }
}

function inspectLease(
  db: DatabaseSync,
  options: PositionGuardPilotReadinessOptions,
  mutable: MutableInspection,
): void {
  const row = db.prepare(`
    SELECT owner_token, purpose, acquired_at_epoch_ms, expires_at_epoch_ms
    FROM account_execution_leases WHERE exchange_account_id = ?
  `).get(options.identity.exchangeAccountId) as LeaseRow | undefined;
  if (row === undefined) {
    mutable.leaseState = Object.freeze({
      classification: "ABSENT", purpose: null, acquiredAtEpochMs: null, expiresAtEpochMs: null,
    });
    mutable.checks.push({ name: "execution_lease", status: "PASS", detail: "No account execution lease is persisted." });
    return;
  }
  const acquiredAt = requireSafeNonNegativeInteger(row.acquired_at_epoch_ms, "lease acquiredAtEpochMs");
  const expiresAt = requireSafeNonNegativeInteger(row.expires_at_epoch_ms, "lease expiresAtEpochMs");
  const purpose = requireString(row.purpose, "lease purpose");
  const owner = requireString(row.owner_token, "lease owner token");
  if (owner.length === 0 || purpose !== "ORDER_SUBMISSION" || expiresAt <= acquiredAt) {
    mutable.leaseState = Object.freeze({
      classification: "INVALID", purpose, acquiredAtEpochMs: acquiredAt, expiresAtEpochMs: expiresAt,
    });
    mutable.checks.push({ name: "execution_lease", status: "BLOCK", detail: "Persisted account execution lease is invalid." });
    return;
  }
  const checkedAtMs = Number(parseCandidatePilotTimestamp(options.checkedAt, "readiness checkedAt") / 1_000_000n);
  const active = expiresAt > checkedAtMs;
  mutable.leaseState = Object.freeze({
    classification: active ? "ACTIVE" : "STALE",
    purpose,
    acquiredAtEpochMs: acquiredAt,
    expiresAtEpochMs: expiresAt,
  });
  mutable.checks.push({
    name: "execution_lease",
    status: active ? "BLOCK" : "WARN",
    detail: active
      ? "An unexpired account execution lease exists; owner authority is intentionally not rendered."
      : "An expired account execution lease remains persisted and should be reviewed before pilot operation.",
  });
}

function classifySnapshot(
  row: Readonly<{
    id: unknown;
    capturedAt: unknown;
    source: unknown;
    payloadJson: unknown;
    numericValue: unknown;
  }> | null,
  options: PositionGuardPilotReadinessOptions,
  label: "balance" | "position",
): Readonly<{
  status: PositionGuardPilotReadinessStatus;
  detail: string;
  evidence: HealthEvidence | null;
}> {
  if (row === null) {
    return { status: "WARN", detail: `Latest persisted ${label} snapshot is missing.`, evidence: null };
  }
  try {
    const id = requireString(row.id, `${label} snapshot id`);
    const capturedAt = requireString(row.capturedAt, `${label} snapshot capturedAt`);
    const source = requireString(row.source, `${label} snapshot source`);
    if (source !== "EXCHANGE_POLL" && source !== "RECONCILIATION") {
      throw new Error(`${label} snapshot source is invalid.`);
    }
    const payload = parseJson(row.payloadJson, `${label} snapshot payload`);
    if (!Array.isArray(payload)) throw new Error(`${label} snapshot payload must be an array.`);
    validatePersistedJsonNumbers(payload, `${label} snapshot payload`);
    if (row.numericValue !== null && row.numericValue !== undefined) {
      canonicalNonNegativeDecimal(requireString(row.numericValue, `${label} snapshot numeric value`), `${label} snapshot numeric value`);
    }
    const freshness = classifyFreshness(capturedAt, options);
    const evidence: HealthEvidence = Object.freeze({
      id, capturedAt, source, classification: freshness.classification,
    });
    return {
      status: freshness.status,
      detail: `${label} snapshot ${freshness.detail}`,
      evidence,
    };
  } catch (error) {
    return {
      status: "BLOCK",
      detail: `Latest persisted ${label} snapshot is invalid: ${formatError(error)}`,
      evidence: null,
    };
  }
}

function classifyReconciliation(
  row: ReconciliationRow | null,
  options: PositionGuardPilotReadinessOptions,
): Readonly<{
  status: PositionGuardPilotReadinessStatus;
  detail: string;
  evidence: ReconciliationEvidence | null;
}> {
  if (row === null) {
    return { status: "WARN", detail: "Latest persisted reconciliation run is missing.", evidence: null };
  }
  try {
    const id = requireString(row.id, "reconciliation id");
    const status = requireString(row.status, "reconciliation status");
    const startedAt = requireString(row.started_at, "reconciliation startedAt");
    const startedEpoch = parseCandidatePilotTimestamp(startedAt, "reconciliation startedAt");
    const completedAt = nullableString(row.completed_at, "reconciliation completedAt");
    if (completedAt === null) throw new Error("reconciliation completion is missing");
    const completedEpoch = parseCandidatePilotTimestamp(completedAt, "reconciliation completedAt");
    if (completedEpoch < startedEpoch) throw new Error("reconciliation completion precedes start");
    const summary = parseJson(row.summary_json, "reconciliation summary");
    if (!isPlainRecord(summary) || !Array.isArray(summary.issues)) {
      throw new Error("reconciliation summary shape is invalid");
    }
    const source = requireString(summary.source, "reconciliation summary source");
    if (!KNOWN_RECONCILIATION_SOURCES.has(source) || summary.status !== status) {
      throw new Error("reconciliation summary provenance does not match the run");
    }
    const issueCodes = summary.issues.map((issue, index) => {
      if (!isPlainRecord(issue)) throw new Error(`reconciliation issue ${index} is invalid`);
      const code = requireString(issue.code, `reconciliation issue ${index} code`);
      requireString(issue.message, `reconciliation issue ${index} message`);
      return code;
    });
    validateReconciliationCounts(summary, issueCodes);
    const errorMessage = nullableString(row.error_message, "reconciliation errorMessage");
    const freshness = classifyFreshness(completedAt, options);
    let classification: ReconciliationEvidence["classification"];
    let checkStatus: PositionGuardPilotReadinessStatus;
    if (freshness.status === "BLOCK") {
      classification = freshness.classification === "STALE" ? "STALE" : "INVALID";
      checkStatus = "BLOCK";
    } else if (status === "SUCCESS" && issueCodes.length === 0 && errorMessage === null) {
      classification = "CLEAN";
      checkStatus = "PASS";
    } else if (
      status === "DRIFT_DETECTED" && issueCodes.length > 0 && errorMessage === null &&
      issueCodes.every((code) => REVIEWED_NON_BLOCKING_RECONCILIATION_CODES.has(code))
    ) {
      classification = "NON_BLOCKING_DRIFT";
      checkStatus = "WARN";
    } else {
      classification = "BLOCKING";
      checkStatus = "BLOCK";
    }
    return {
      status: checkStatus,
      detail: `Latest reconciliation classification=${classification}; source=${source}; status=${status}; issues=${issueCodes.join(",") || "none"}.`,
      evidence: Object.freeze({ id, status, completedAt, source, issueCodes: Object.freeze(issueCodes), classification }),
    };
  } catch (error) {
    return {
      status: "BLOCK",
      detail: `Latest persisted reconciliation run is invalid: ${formatError(error)}`,
      evidence: null,
    };
  }
}

function validateReconciliationCounts(summary: Record<string, unknown>, issueCodes: readonly string[]): void {
  const candidateCount = requireSafeNonNegativeInteger(summary.candidateCount, "reconciliation candidateCount");
  const processedCount = requireSafeNonNegativeInteger(summary.processedCount, "reconciliation processedCount");
  const deferredCount = requireSafeNonNegativeInteger(summary.deferredCount, "reconciliation deferredCount");
  const maxLookups = requireSafeNonNegativeInteger(summary.maxOrderLookupsPerRun, "reconciliation maxOrderLookupsPerRun");
  if (processedCount + deferredCount !== candidateCount || processedCount > maxLookups) {
    throw new Error("reconciliation bounded sweep counts are contradictory");
  }
  const deferredIssues = issueCodes.filter((code) => code === "ORDER_LOOKUP_DEFERRED").length;
  if (deferredIssues !== (deferredCount > 0 ? 1 : 0)) {
    throw new Error("reconciliation deferred evidence is contradictory");
  }
}

function classifyFreshness(
  timestamp: string,
  options: PositionGuardPilotReadinessOptions,
): Readonly<{
  status: "PASS" | "BLOCK";
  classification: "FRESH" | "STALE" | "INVALID";
  detail: string;
}> {
  const observed = parseCandidatePilotTimestamp(timestamp, "persisted health timestamp");
  const checked = parseCandidatePilotTimestamp(options.checkedAt, "readiness checkedAt");
  if (observed > checked) return { status: "BLOCK", classification: "INVALID", detail: "is future-dated." };
  const maximumAge = BigInt(options.freshnessThresholdMs) * 1_000_000n;
  if (checked - observed > maximumAge) return { status: "BLOCK", classification: "STALE", detail: "is stale." };
  return { status: "PASS", classification: "FRESH", detail: "is fresh." };
}

const CANONICAL_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;
const CANONICAL_SIGNED_DECIMAL = /^(?:0|[1-9]\d*(?:\.\d*[1-9])?|-?[1-9]\d*(?:\.\d*[1-9])?)$/u;
const EXACT_QUANTITY_TOLERANCE = parseCanonicalNonNegativeDecimal(
  "0.000000000001",
  "candidate quantity tolerance",
);

function createExactEmptyCandidateState(): ExactCandidateState {
  return Object.freeze({
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: "0",
    currentEpisodeInventoryQuantity: "0",
    currentEpisodeRealizedPnlKrw: "0",
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
  });
}

function projectExactCandidateState(
  evidence: readonly Readonly<PositionGuardCandidateExecutionEvidence>[],
): ExactCandidateState {
  const ordered = evidence.map((item) => ({
    evidence: item,
    epochNanoseconds: parseCandidatePilotTimestamp(item.executedAt, "candidate evidence executedAt"),
  })).sort((left, right) => {
    if (left.epochNanoseconds < right.epochNanoseconds) return -1;
    if (left.epochNanoseconds > right.epochNanoseconds) return 1;
    return left.evidence.evidenceId < right.evidence.evidenceId
      ? -1
      : left.evidence.evidenceId > right.evidence.evidenceId ? 1 : 0;
  });
  let state = createExactEmptyCandidateState();
  for (const item of ordered) state = advanceExactCandidateState(state, item.evidence);
  return state;
}

function advanceExactCandidateState(
  state: ExactCandidateState,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): ExactCandidateState {
  const executedQuantity = canonicalNonNegativeDecimal(evidence.executedQuantity, "candidate evidence executedQuantity");
  const grossQuoteValueKrw = canonicalNonNegativeDecimal(evidence.grossQuoteValueKrw, "candidate evidence grossQuoteValueKrw");
  const confirmedFeeKrw = canonicalNonNegativeDecimal(evidence.confirmedFeeKrw, "candidate evidence confirmedFeeKrw");
  const remainingQuantity = canonicalNonNegativeDecimal(evidence.remainingQuantity, "candidate evidence remainingQuantity");
  assertExactChronology(state, evidence);
  if (executedQuantity === "0") {
    if (remainingQuantity !== state.currentEpisodeInventoryQuantity) {
      throw new Error("Terminal no-fill candidate evidence contradicts exact inventory.");
    }
    return state;
  }

  const expectedRemaining = deriveExactRemainingQuantity(
    state.currentEpisodeInventoryQuantity,
    evidence.action,
    executedQuantity,
  );
  if (expectedRemaining !== remainingQuantity) {
    throw new Error(`Candidate evidence ${evidence.evidenceId} remainingQuantity contradicts exact inventory.`);
  }

  const next = { ...state };
  const currentCost = parseCanonicalNonNegativeDecimal(state.currentEpisodeCostBasisKrw, "candidate exact cost basis");
  const currentQuantity = parseCanonicalNonNegativeDecimal(state.currentEpisodeInventoryQuantity, "candidate exact inventory");
  const currentPnl = parseCanonicalSignedDecimal(state.currentEpisodeRealizedPnlKrw, "candidate exact realized pnl");
  const executed = parseCanonicalNonNegativeDecimal(executedQuantity, "candidate executed quantity");
  const gross = parseCanonicalNonNegativeDecimal(grossQuoteValueKrw, "candidate gross quote value");
  const fee = parseCanonicalNonNegativeDecimal(confirmedFeeKrw, "candidate confirmed fee");

  if (evidence.action === "ENTER" || evidence.action === "ADD") {
    if (evidence.action === "ENTER" && state.currentEpisodeInventoryQuantity !== "0") {
      throw new Error("Candidate ENTER evidence requires an exact flat episode.");
    }
    if (evidence.action === "ADD" && state.currentEpisodeInventoryQuantity === "0") {
      throw new Error("Candidate ADD evidence requires an exact open episode.");
    }
    next.currentEpisodeInventoryQuantity = expectedRemaining;
    next.currentEpisodeCostBasisKrw = formatExactDecimal(addExactDecimals(currentCost, addExactDecimals(gross, fee)));
    if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
    if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
  } else {
    if (state.currentEpisodeInventoryQuantity === "0") {
      throw new Error("Candidate sell evidence requires an exact open episode.");
    }
    const removedCost = expectedRemaining === "0"
      ? currentCost
      : divideExactDecimals(
          multiplyExactDecimals(currentCost, executed),
          currentQuantity,
          "candidate proportional cost allocation",
        );
    const realized = subtractExactDecimals(
      addExactDecimals(currentPnl, subtractExactDecimals(gross, fee)),
      removedCost,
    );
    if (expectedRemaining === "0") {
      next.currentEpisodeAddCount = 0;
      next.currentEpisodeCostBasisKrw = "0";
      next.currentEpisodeInventoryQuantity = "0";
      next.currentEpisodeRealizedPnlKrw = "0";
      next.lastFullExitAt = evidence.executedAt;
      next.lastFullExitRealizedPnlKrw = formatExactDecimal(realized);
    } else {
      next.currentEpisodeCostBasisKrw = formatExactDecimal(subtractExactDecimals(currentCost, removedCost));
      next.currentEpisodeInventoryQuantity = expectedRemaining;
      next.currentEpisodeRealizedPnlKrw = formatExactDecimal(realized);
    }
  }
  next.lastEvidenceAt = evidence.executedAt;
  next.lastEvidenceId = evidence.evidenceId;
  next.stateVersion += 1;
  return Object.freeze(next);
}

function deriveExactRemainingQuantity(
  currentQuantity: string,
  action: PositionGuardCandidateExecutionEvidence["action"],
  executedQuantity: string,
): string {
  const current = parseCanonicalNonNegativeDecimal(currentQuantity, "candidate exact inventory quantity");
  const executed = parseCanonicalNonNegativeDecimal(executedQuantity, "candidate executed quantity");
  if (action === "ENTER" || action === "ADD") {
    return formatExactDecimal(addExactDecimals(current, executed));
  }
  if (compareExactDecimals(executed, addExactDecimals(current, EXACT_QUANTITY_TOLERANCE)) > 0) {
    throw new Error("Terminal sell evidence exceeds exact candidate inventory.");
  }
  const remaining = subtractExactDecimals(current, executed);
  return compareExactDecimals(absExactDecimal(remaining), EXACT_QUANTITY_TOLERANCE) <= 0
    ? "0"
    : formatExactDecimal(remaining);
}

function canonicalNonNegativeDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_NON_NEGATIVE_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical non-negative decimal string.`);
  }
  return formatExactDecimal(parseCanonicalDecimal(value));
}

function canonicalSignedDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_SIGNED_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical signed decimal string.`);
  }
  return formatExactDecimal(parseCanonicalDecimal(value));
}

function parseCanonicalNonNegativeDecimal(value: unknown, label: string): ExactDecimal {
  return parseCanonicalDecimal(canonicalNonNegativeDecimal(value, label));
}

function parseCanonicalSignedDecimal(value: unknown, label: string): ExactDecimal {
  return parseCanonicalDecimal(canonicalSignedDecimal(value, label));
}

function parseCanonicalDecimal(value: string): ExactDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fractional = ""] = unsigned.split(".");
  return normalizeExactDecimal({
    coefficient: (negative ? -1n : 1n) * BigInt(`${whole}${fractional}`),
    scale: fractional.length,
  });
}

function formatExactDecimal(value: ExactDecimal): string {
  const normalized = normalizeExactDecimal(value);
  const sign = normalized.coefficient < 0n ? "-" : "";
  const digits = absoluteBigInt(normalized.coefficient).toString();
  if (normalized.scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(normalized.scale + 1, "0");
  return `${sign}${padded.slice(0, -normalized.scale)}.${padded.slice(-normalized.scale)}`;
}

function normalizeExactDecimal(value: ExactDecimal): ExactDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function addExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeExactDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function subtractExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeExactDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) -
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function multiplyExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalizeExactDecimal({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

function divideExactDecimals(left: ExactDecimal, right: ExactDecimal, label: string): ExactDecimal {
  if (right.coefficient === 0n) throw new Error(`${label} cannot divide by zero.`);
  let numerator = left.coefficient;
  let denominator = right.coefficient;
  const scaleDelta = right.scale - left.scale;
  if (scaleDelta >= 0) numerator *= 10n ** BigInt(scaleDelta);
  else denominator *= 10n ** BigInt(-scaleDelta);
  const divisor = greatestCommonDivisor(absoluteBigInt(numerator), absoluteBigInt(denominator));
  numerator /= divisor;
  denominator /= divisor;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n && denominator !== -1n) {
    throw new Error(`${label} does not have a terminating exact decimal representation.`);
  }
  const scale = Math.max(twos, fives);
  if (twos < scale) numerator *= 2n ** BigInt(scale - twos);
  if (fives < scale) numerator *= 5n ** BigInt(scale - fives);
  return normalizeExactDecimal({ coefficient: numerator, scale });
}

function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function assertExactChronology(
  state: ExactCandidateState,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): void {
  if (state.lastEvidenceAt === null) return;
  const cursor = parseCandidatePilotTimestamp(state.lastEvidenceAt, "candidate state lastEvidenceAt");
  const next = parseCandidatePilotTimestamp(evidence.executedAt, "candidate evidence executedAt");
  if (next < cursor || (next === cursor && evidence.evidenceId <= state.lastEvidenceId!)) {
    throw new Error("Candidate evidence must be in exact persisted chronology order.");
  }
}

function absExactDecimal(value: ExactDecimal): ExactDecimal {
  return value.coefficient < 0n ? { ...value, coefficient: -value.coefficient } : value;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function exactStateFromRow(row: StateRow): Readonly<ExactCandidateState> {
  if (row.material_version !== "EXACT_V2") throw new Error("Candidate state is not EXACT_V2.");
  const addCount = requireSafeNonNegativeInteger(row.current_episode_add_count, "candidate state add count");
  const state: ExactCandidateState = {
    currentEpisodeAddCount: addCount,
    currentEpisodeCostBasisKrw: canonicalNonNegativeDecimal(row.current_episode_cost_basis_krw_exact, "candidate state cost basis"),
    currentEpisodeInventoryQuantity: canonicalNonNegativeDecimal(row.current_episode_inventory_quantity_exact, "candidate state inventory"),
    currentEpisodeRealizedPnlKrw: canonicalSignedDecimal(row.current_episode_realized_pnl_krw_exact, "candidate state realized pnl"),
    lastFullExitAt: nullableString(row.last_full_exit_at, "candidate state lastFullExitAt"),
    lastFullExitRealizedPnlKrw: row.last_full_exit_realized_pnl_krw_exact === null
      ? null
      : canonicalSignedDecimal(row.last_full_exit_realized_pnl_krw_exact, "candidate state last full exit pnl"),
    lastEntryPath: nullableEntryPath(row.last_entry_path),
    lastEvidenceAt: nullableString(row.last_evidence_at, "candidate state lastEvidenceAt"),
    lastEvidenceId: nullableString(row.last_evidence_id, "candidate state lastEvidenceId"),
    stateVersion: requireSafeNonNegativeInteger(row.state_version, "candidate state version"),
  };
  parseCandidatePilotTimestamp(requireString(row.updated_at, "candidate state updatedAt"), "candidate state updatedAt");
  if (state.lastFullExitAt !== null) parseCandidatePilotTimestamp(state.lastFullExitAt, "candidate state lastFullExitAt");
  if (state.lastEvidenceAt !== null) parseCandidatePilotTimestamp(state.lastEvidenceAt, "candidate state lastEvidenceAt");
  if ((state.lastFullExitAt === null) !== (state.lastFullExitRealizedPnlKrw === null)) {
    throw new Error("Candidate full-exit timestamp and pnl must be persisted together.");
  }
  if ((state.lastEvidenceAt === null) !== (state.lastEvidenceId === null)) {
    throw new Error("Candidate evidence cursor timestamp and id must be persisted together.");
  }
  return Object.freeze(state);
}

function evidenceFromRow(
  row: EvidenceRow,
  deploymentId: string,
): Readonly<{
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>;
  materialHash: string;
  materialVersion: string;
  hashValid: boolean;
}> {
  const evidence: PositionGuardCandidateExecutionEvidence = Object.freeze({
    evidenceId: requireString(row.id, "candidate evidence id"),
    executedAt: requireString(row.executed_at, "candidate evidence executedAt"),
    action: row.action as PositionGuardCandidateExecutionEvidence["action"],
    entryPath: row.entry_path as PositionGuardCandidateExecutionEvidence["entryPath"],
    terminalStatus: row.terminal_status as PositionGuardCandidateExecutionEvidence["terminalStatus"],
    executedQuantity: requireString(row.executed_quantity_exact, "candidate evidence executed quantity"),
    grossQuoteValueKrw: requireString(row.gross_quote_value_krw_exact, "candidate evidence gross quote value"),
    confirmedFeeKrw: requireString(row.confirmed_fee_krw_exact, "candidate evidence confirmed fee"),
    remainingQuantity: requireString(row.remaining_quantity_exact, "candidate evidence remaining quantity"),
  });
  const material = candidateEvidenceMaterial(deploymentId, evidence);
  const persistedEpoch = typeof row.executed_at_epoch_ns === "bigint"
    ? row.executed_at_epoch_ns
    : BigInt(requireString(row.executed_at_epoch_ns, "candidate evidence epoch"));
  if (persistedEpoch !== material.epochNanoseconds) throw new Error("Candidate evidence epoch does not match timestamp.");
  parseCandidatePilotTimestamp(requireString(row.created_at, "candidate evidence createdAt"), "candidate evidence createdAt");
  const materialVersion = requireString(row.material_version, "candidate evidence materialVersion");
  const materialHash = requireString(row.material_hash, "candidate evidence materialHash");
  return Object.freeze({
    evidence: material.evidence,
    materialHash,
    materialVersion,
    hashValid: materialVersion === "EXACT_V2" && materialHash === material.hash,
  });
}

function sameExactState(left: Readonly<ExactCandidateState>, right: Readonly<ExactCandidateState>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function classifyPhase(
  phase: string,
  selection: PositionGuardPolicySelection["kind"],
): PositionGuardPilotReadinessCheck {
  if (phase === "ACTIVE") {
    return {
      name: "pilot_phase",
      status: selection === "BTC_CANDIDATE_PILOT" ? "PASS" : "WARN",
      detail: selection === "BTC_CANDIDATE_PILOT"
        ? "Persisted candidate phase is ACTIVE."
        : "Persisted candidate phase is ACTIVE while baseline is configured; keep baseline and investigate before startup.",
    };
  }
  if (phase === "PENDING_FLAT") {
    return { name: "pilot_phase", status: "WARN", detail: "PENDING_FLAT suppresses candidate entry and ADD until flat-start proof exists." };
  }
  if (phase === "DISABLED") {
    return { name: "pilot_phase", status: "WARN", detail: "Pilot is DISABLED and cannot route candidate decisions." };
  }
  if (phase === "DRAINING") {
    return { name: "pilot_phase", status: "BLOCK", detail: "Pilot is DRAINING during rollback; new candidate exposure must remain blocked." };
  }
  return { name: "pilot_phase", status: "BLOCK", detail: "Pilot is PAUSED_FAULT and requires explicit fault investigation; no automatic resume is allowed." };
}

function createMutableInspection(): MutableInspection {
  return {
    deployment: null,
    stateProvenance: null,
    evidenceProvenance: null,
    orderState: Object.freeze({
      activeCount: 0,
      uncertainCount: 0,
      activeStatuses: [],
      uncertainStatuses: [],
      blockingOrders: [],
    }),
    health: Object.freeze({ balance: null, position: null, reconciliation: null }),
    leaseState: Object.freeze({ classification: "ABSENT", purpose: null, acquiredAtEpochMs: null, expiresAtEpochMs: null }),
    sqliteSharedMemory: "UNCHANGED",
    checks: [],
  };
}

function addUnavailableChecks(mutable: MutableInspection, reason: string): void {
  const existing = new Set(mutable.checks.map((item) => item.name));
  for (const name of [
    "sqlite_snapshot", "required_schema", "pilot_deployment", "pilot_phase", "state_replay",
    "evidence_source_provenance", "audit_chain", "active_orders",
    "uncertain_orders", "balance_snapshot", "position_snapshot", "latest_reconciliation", "execution_lease",
  ]) {
    if (!existing.has(name)) mutable.checks.push({ name, status: "BLOCK", detail: `Not evaluated because ${reason}.` });
  }
  if (!existing.has("non_mutation_boundary")) {
    mutable.checks.push({
      name: "non_mutation_boundary",
      status: "PASS",
      detail: "No database was created or mutated and no operational action was invoked.",
    });
  }
}

function buildReport(
  options: PositionGuardPilotReadinessOptions,
  databasePath: string,
  selection: PositionGuardPilotReadinessReport["selection"],
  authority: PositionGuardPilotReadinessReport["authority"],
  mutable: MutableInspection,
): PositionGuardPilotReadinessReport {
  if (!mutable.checks.some((item) => item.name === "non_mutation_boundary")) {
    mutable.checks.push({
      name: "non_mutation_boundary",
      status: "PASS",
      detail: "Inspection is declared and implemented as direct read-only SQLite access only.",
    });
  }
  const checks = Object.freeze(mutable.checks.map((item) => Object.freeze({ ...item })));
  const status = checks.some((item) => item.status === "BLOCK")
    ? "BLOCK"
    : checks.some((item) => item.status === "WARN")
      ? "WARN"
      : "PASS";
  return Object.freeze({
    service: "AutoTrade_Upbit",
    inspection: "BTC_POSITION_GUARD_PILOT_READINESS_V1",
    status,
    databasePath,
    checkedAt: options.checkedAt,
    freshnessThresholdMs: options.freshnessThresholdMs,
    filters: Object.freeze({ ...options.identity }),
    selection,
    authority,
    deployment: mutable.deployment,
    stateProvenance: mutable.stateProvenance,
    evidenceProvenance: mutable.evidenceProvenance,
    orderState: mutable.orderState,
    health: Object.freeze({ ...mutable.health }),
    leaseState: mutable.leaseState,
    ethPolicy: "BASELINE",
    checks,
    nextActions: Object.freeze(buildNextActions(checks)),
    nonMutationBoundary: Object.freeze({
      ...NON_MUTATION_BOUNDARY,
      sqliteSharedMemory: mutable.sqliteSharedMemory,
    }),
  });
}

function buildNextActions(checks: readonly PositionGuardPilotReadinessCheck[]): string[] {
  const actions: string[] = [];
  const byName = new Map(checks.map((item) => [item.name, item]));
  if (byName.get("database_file")?.status === "BLOCK") actions.push("Provide an existing copied or otherwise approved SQLite path; do not create it through this inspector.");
  if (byName.get("sqlite_snapshot")?.status === "BLOCK") actions.push("Use an approved existing SQLite database in WAL or rollback-journal mode; this inspector never changes journal mode.");
  if (byName.get("required_schema")?.status === "BLOCK") actions.push("Use a separately migrated fixture or approved database copy; this inspector never runs migrations.");
  if (byName.get("pilot_configuration")?.status === "WARN") actions.push("Baseline remains selected; no BTC candidate activation is implied.");
  if (byName.get("pilot_deployment")?.status !== "PASS") actions.push("Review the exact pilot deployment identity before any runtime startup.");
  const phase = byName.get("pilot_phase");
  if (phase?.detail.includes("PENDING_FLAT")) actions.push("Complete exchange-backed flat-start validation through the separately governed runtime path; this inspector cannot do it.");
  if (phase?.detail.includes("PAUSED_FAULT")) actions.push("Investigate PAUSED_FAULT evidence and retain the pause until a separately governed recovery decision.");
  if (phase?.detail.includes("DRAINING")) actions.push("Complete rollback draining and reconciliation before candidate operation.");
  if (byName.get("state_replay")?.status === "BLOCK") actions.push("Investigate persisted candidate state/evidence replay mismatch without repairing the operational database here.");
  if (byName.get("evidence_source_provenance")?.status === "BLOCK") actions.push("Investigate terminal candidate evidence source-order and immutable binding provenance before operation.");
  if (byName.get("active_orders")?.status === "BLOCK" || byName.get("uncertain_orders")?.status === "BLOCK") actions.push("Resolve active or uncertain orders through separately governed reconciliation before pilot operation.");
  if (["balance_snapshot", "position_snapshot", "latest_reconciliation"].some((name) => byName.get(name)?.status !== "PASS")) actions.push("Refresh and reconcile account health only through an explicitly approved runtime operation, then rerun read-only inspection.");
  if (byName.get("execution_lease")?.status !== "PASS") actions.push("Review persisted execution lease state before any order-capable process starts.");
  if (actions.length === 0) actions.push("Persisted read-only checks pass; actual exchange-backed runtime preflight and LIVE approval remain separate requirements.");
  return [...new Set(actions)];
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`${label} must be JSON text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is malformed JSON.`);
  }
}

function validatePersistedJsonNumbers(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePersistedJsonNumbers(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainRecord(value)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${label}.${key} is non-finite.`);
    if (typeof item === "string" && /^(?:NaN|[+-]?Infinity)$/u.test(item)) throw new Error(`${label}.${key} is non-finite.`);
    validatePersistedJsonNumbers(item, `${label}.${key}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireOrderLifecycleStatus(value: unknown): OrderLifecycleStatus {
  if (
    value !== "INTENT_CREATED" && value !== "RISK_REJECTED" && value !== "PERSISTED" &&
    value !== "SUBMITTING" && value !== "OPEN" && value !== "PARTIALLY_FILLED" &&
    value !== "FILLED" && value !== "CANCEL_REQUESTED" && value !== "CANCELED" &&
    value !== "REJECTED" && value !== "FAILED" && value !== "RECONCILIATION_REQUIRED"
  ) {
    throw new Error("Order lifecycle status is invalid.");
  }
  return value;
}

function requireOrderEventSource(value: unknown): "LOCAL" | "EXCHANGE" | "RECONCILIATION" | "TELEGRAM" {
  if (value !== "LOCAL" && value !== "EXCHANGE" && value !== "RECONCILIATION" && value !== "TELEGRAM") {
    throw new Error("Order event source is invalid.");
  }
  return value;
}

function requireRecoveryOutcome(value: unknown): "FOUND" | "NOT_FOUND" | "TRANSIENT_FAILURE" {
  if (value !== "FOUND" && value !== "NOT_FOUND" && value !== "TRANSIENT_FAILURE") {
    throw new Error("Order recovery observation outcome is invalid.");
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function nullableEntryPath(value: unknown): ExactCandidateState["lastEntryPath"] {
  if (value === null) return null;
  if (value !== "PULLBACK" && value !== "RECLAIM" && value !== "BREAKOUT_HOLD" && value !== "NONE") {
    throw new Error("Candidate state lastEntryPath is invalid.");
  }
  return value;
}

function requireSafeNonNegativeInteger(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function requireNonNegativeBigInt(value: unknown, label: string): bigint {
  let result: bigint;
  try {
    result = typeof value === "bigint" ? value : BigInt(requireString(value, label));
  } catch {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  if (result < 0n) throw new Error(`${label} must be a non-negative integer.`);
  return result;
}

function requiredCliValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "") throw new Error(`--${key} is required.`);
  return value;
}

function stringifyFiniteJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Readiness JSON contains a non-finite number.");
    if (typeof item === "bigint") return item.toString();
    return item;
  }, 2);
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DeploymentRow = Record<
  "id" | "exchange_account_id" | "pilot_id" | "market" | "policy_id" | "policy_version" |
  "phase" | "activation_at" | "activation_epoch_ns" | "created_at" | "updated_at",
  unknown
>;
type StateRow = Record<
  "deployment_id" | "current_episode_add_count" | "last_full_exit_at" |
  "last_full_exit_realized_pnl_krw_exact" | "last_entry_path" | "last_evidence_at" |
  "last_evidence_id" | "state_version" | "updated_at" | "material_version" |
  "current_episode_cost_basis_krw_exact" | "current_episode_inventory_quantity_exact" |
  "current_episode_realized_pnl_krw_exact",
  unknown
>;
type EvidenceRow = Record<
  "id" | "executed_at" | "executed_at_epoch_ns" | "action" | "entry_path" |
  "terminal_status" | "material_hash" | "created_at" | "material_version" |
  "executed_quantity_exact" | "gross_quote_value_krw_exact" | "confirmed_fee_krw_exact" |
  "remaining_quantity_exact",
  unknown
>;
type EvidenceSourceOrderRow = Record<
  "id" | "strategy_decision_id" | "exchange_account_id" | "market" | "side" |
  "ord_type" | "volume" | "price" | "time_in_force" | "smp_type" | "origin" |
  "requested_at" | "status" | "execution_mode" | "upbit_uuid" | "created_at" | "updated_at",
  unknown
>;
type ReadinessStrategyDecisionRow = Record<
  "id" | "exchange_account_id" | "strategy_key" | "market" | "action" | "status" |
  "decision_basis_json" | "intended_notional_krw" | "intended_quantity" |
  "reference_price" | "created_at",
  unknown
>;
type ReadinessFillRow = Record<
  "id" | "order_id" | "exchange_fill_id" | "market" | "side" | "price" | "volume" |
  "fee_currency" | "fee_amount" | "fee_provenance" | "filled_at" | "raw_payload_json" |
  "execution_timestamp_provenance" | "execution_epoch_ns",
  unknown
>;
type ReadinessBindingRow = Record<
  "id" | "deployment_id" | "strategy_decision_id" | "order_id" | "exchange_account_id" |
  "activation_at" | "activation_epoch_ns" | "market" | "strategy_key" | "policy_id" |
  "policy_version" | "execution_mode" | "ord_type" | "action" | "side" |
  "intended_quantity_exact" | "intended_notional_krw_exact" | "bound_price_exact" |
  "bound_volume_exact" | "bound_time_in_force" | "bound_smp_type" | "material_version" |
  "order_material_hash" | "created_at",
  unknown
>;
type AuditRow = Record<
  "id" | "deployment_id" | "event_type" | "from_phase" | "to_phase" | "state_version" |
  "payload_json" | "created_at" | "created_at_epoch_ns",
  unknown
>;
type OrderRow = Record<
  "id" | "status" | "requested_at" | "created_at" | "updated_at" |
  "upbit_uuid" | "exchange_response_json" | "failure_code",
  unknown
>;
type ReadinessOrderEventRow = Record<"event_type" | "event_source" | "created_at", unknown>;
type ReadinessRecoveryObservationRow = Record<"outcome" | "observed_at_epoch_ms", unknown>;
type BalanceRow = Record<"id" | "captured_at" | "source" | "total_krw_value" | "balances_json", unknown>;
type PositionRow = Record<"id" | "captured_at" | "source" | "positions_json", unknown>;
type ReconciliationRow = Record<"id" | "status" | "started_at" | "completed_at" | "summary_json" | "error_message", unknown>;
type LeaseRow = Record<"owner_token" | "purpose" | "acquired_at_epoch_ms" | "expires_at_epoch_ms", unknown>;

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const report = runPositionGuardPilotReadinessCli(process.argv.slice(2), process.env);
    if (report.status === "BLOCK") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`BTC pilot readiness failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  }
}
