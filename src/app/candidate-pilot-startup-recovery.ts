import type { CandidateBtcRunPreparationService } from "./candidate-btc-run-preparation.js";
import type {
  PositionGuardPilotRecovery,
  PositionGuardPilotRecoveryResult,
} from "./position-guard-pilot-recovery.js";
import type { OperatorStateStore } from "../modules/db/interfaces.js";

export class CandidatePilotStartupRecoveryService {
  constructor(private readonly dependencies: Readonly<{
    preparation: Pick<CandidateBtcRunPreparationService, "prepare">;
    recovery: Pick<PositionGuardPilotRecovery, "verifyAndPrepareBtcRun">;
    operatorState: Pick<OperatorStateStore, "pause">;
    exchangeAccountId: string;
    clock: Readonly<{ now(): string }>;
  }>) {}

  async prepareAndRecover(): Promise<Extract<PositionGuardPilotRecoveryResult, { status: "READY" }>> {
    try {
      const preparation = await this.dependencies.preparation.prepare({
        exchangeAccountId: this.dependencies.exchangeAccountId,
        requestedAt: this.dependencies.clock.now(),
        requestedBy: "SCHEDULER",
      });
      if (preparation.status !== "READY") {
        throw new Error(`Candidate startup preparation blocked: ${preparation.detail}`);
      }
      const recovery = await this.dependencies.recovery.verifyAndPrepareBtcRun(
        preparation.refreshReceipt,
      );
      if (recovery.status !== "READY") {
        throw new Error(
          `Candidate startup recovery blocked: ${recovery.reasonCode} (${recovery.faultId}).`,
        );
      }
      return recovery;
    } catch (error) {
      try {
        await this.dependencies.operatorState.pause("position_guard_pilot_startup_recovery_blocked");
      } catch (pauseError) {
        throw new AggregateError(
          [error, pauseError],
          "Candidate startup recovery failed and global pause persistence also failed.",
        );
      }
      throw error;
    }
  }
}
