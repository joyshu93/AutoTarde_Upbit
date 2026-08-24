import type { OperatorStateStore } from "../modules/db/interfaces.js";
import type {
  CandidatePilotDeploymentInitializationResult,
  CandidatePilotRepository,
} from "../modules/db/pilot-interfaces.js";
import {
  validateExistingPositionGuardPilotAuthority,
  type PositionGuardPilotInitializationResult,
  type PositionGuardPilotInitializer,
} from "./position-guard-pilot-initializer.js";

const APPROVED_CANDIDATE_IDENTITY = Object.freeze({
  exchangeAccountId: "primary",
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
  market: "KRW-BTC",
  policyId: "COMBINED_CONSERVATIVE",
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
} as const);

type StartupCandidateRepository = Pick<
  CandidatePilotRepository,
  | "getDeploymentForExchangeAccount"
  | "getExactState"
  | "listEvidenceRecords"
  | "listAuditEvents"
>;

export type PositionGuardPilotStartupAuthorityResult =
  | Readonly<{ status: "BASELINE_FRESH"; deployment: null }>
  | Readonly<{
      status: "BASELINE_DISABLED";
      deployment: PositionGuardPilotInitializationResult["deployment"];
    }>
  | Readonly<{
      status: "CANDIDATE_CONFIGURED";
      authority: PositionGuardPilotInitializationResult;
    }>;

export class PositionGuardPilotStartupAuthorityGuard {
  constructor(private readonly dependencies: Readonly<{
    configuredInitializer: PositionGuardPilotInitializer | null;
    candidatePilots: StartupCandidateRepository;
    operatorState: Pick<OperatorStateStore, "pause">;
    clock: Readonly<{ now(): string }>;
  }>) {}

  async initialize(): Promise<PositionGuardPilotStartupAuthorityResult> {
    try {
      if (this.dependencies.configuredInitializer !== null) {
        return Object.freeze({
          status: "CANDIDATE_CONFIGURED",
          authority: await this.dependencies.configuredInitializer.initialize(),
        });
      }

      const deployment = await this.dependencies.candidatePilots
        .getDeploymentForExchangeAccount(APPROVED_CANDIDATE_IDENTITY.exchangeAccountId);
      if (deployment === null) {
        return Object.freeze({ status: "BASELINE_FRESH", deployment: null });
      }
      if (deployment.phase !== "DISABLED") {
        throw new Error(
          `BASELINE selection cannot bypass persisted candidate phase ${deployment.phase}.`,
        );
      }

      const [exactState, evidenceRecords, auditEvents] = await Promise.all([
        this.dependencies.candidatePilots.getExactState(deployment.id),
        this.dependencies.candidatePilots.listEvidenceRecords(deployment.id),
        this.dependencies.candidatePilots.listAuditEvents(deployment.id),
      ]);
      if (exactState === null) {
        throw new Error("Persisted DISABLED candidate authority is missing exact state.");
      }
      const initialization: CandidatePilotDeploymentInitializationResult = {
        outcome: "EXISTING",
        deployment,
        exactState,
        evidenceRecords,
        auditEvents,
      };
      const authority = validateExistingPositionGuardPilotAuthority({
        initialization,
        identity: APPROVED_CANDIDATE_IDENTITY,
        now: this.dependencies.clock.now(),
      });
      if (authority.deployment.phase !== "DISABLED") {
        throw new Error("BASELINE candidate authority changed during startup inspection.");
      }
      return Object.freeze({
        status: "BASELINE_DISABLED",
        deployment: authority.deployment,
      });
    } catch (error) {
      try {
        await this.dependencies.operatorState.pause("position_guard_pilot_startup_authority_blocked");
      } catch (pauseError) {
        throw new AggregateError(
          [error, pauseError],
          "Candidate startup authority failed and global pause persistence also failed.",
        );
      }
      throw error;
    }
  }
}
