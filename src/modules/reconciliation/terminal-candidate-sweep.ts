import type { OrderRecord } from "../../domain/types.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import type {
  CandidateExecutionEvidenceService,
  TerminalCandidateSweepDisposition,
} from "../execution/candidate-evidence-service.js";
import {
  compareDeterministicIdentifiers,
  parseCandidateEvidenceTimestamp,
} from "../execution/candidate-evidence-decimals.js";

export const DEFAULT_MAX_TERMINAL_CANDIDATE_PROJECTIONS_PER_RUN = 25;

export interface TerminalCandidateProjectionSweepResult {
  processedCount: number;
  deferredCount: number;
  failedOrderIds: string[];
}

export class TerminalCandidateProjectionSweep {
  constructor(
    private readonly dependencies: {
      repositories: ExecutionRepository;
      projector: Pick<CandidateExecutionEvidenceService, "processTerminalOrder"> &
        Partial<Pick<CandidateExecutionEvidenceService, "classifyTerminalOrderForSweep">>;
      maximumPerRun?: number;
    },
  ) {}

  async run(exchangeAccountId: string): Promise<TerminalCandidateProjectionSweepResult> {
    const maximumPerRun = this.dependencies.maximumPerRun ?? DEFAULT_MAX_TERMINAL_CANDIDATE_PROJECTIONS_PER_RUN;
    if (!Number.isSafeInteger(maximumPerRun) || maximumPerRun < 0) {
      throw new Error("Terminal candidate projection sweep maximum must be a non-negative safe integer.");
    }
    const orders = await this.dependencies.repositories.listOrders(exchangeAccountId);
    const allCandidates = await Promise.all(
      orders
        .filter(isTerminalBtcStrategyOrder)
        .map(async (order) => ({
          order,
          disposition: await this.classify(order.id),
          sort: await terminalSortKey(this.dependencies.repositories, order),
        })),
    );
    const candidates = allCandidates.filter((candidate) => candidate.disposition === "ELIGIBLE");
    candidates.sort((left, right) => compareTerminalCandidates(left, right));
    const selected = candidates.slice(0, maximumPerRun);
    const failedOrderIds: string[] = [];
    for (const candidate of selected) {
      const result = await this.dependencies.projector.processTerminalOrder(candidate.order.id);
      if (result.outcome === "FAULT") failedOrderIds.push(candidate.order.id);
    }
    return {
      processedCount: selected.length,
      deferredCount: Math.max(0, candidates.length - selected.length),
      failedOrderIds,
    };
  }

  private async classify(orderId: string): Promise<TerminalCandidateSweepDisposition> {
    return this.dependencies.projector.classifyTerminalOrderForSweep
      ? this.dependencies.projector.classifyTerminalOrderForSweep(orderId)
      : "ELIGIBLE";
  }
}

async function terminalSortKey(
  repositories: ExecutionRepository,
  order: OrderRecord,
): Promise<{ latestFillEpochNanoseconds: bigint | null; evidenceId: string }> {
  const fills = await repositories.listFills(order.id);
  let latestFillEpochNanoseconds: bigint | null = null;
  for (const fill of fills) {
    try {
      if (fill.executionTimestampProvenance !== "EXCHANGE_FILL_CONFIRMED" || !fill.executionEpochNs ||
        !/^(0|[1-9][0-9]*)$/u.test(fill.executionEpochNs)) {
        latestFillEpochNanoseconds = null;
        break;
      }
      const epoch = BigInt(fill.executionEpochNs);
      if (parseCandidateEvidenceTimestamp(fill.filledAt, "terminal sweep fill filledAt") !== epoch) {
        latestFillEpochNanoseconds = null;
        break;
      }
      if (latestFillEpochNanoseconds === null || epoch > latestFillEpochNanoseconds) {
        latestFillEpochNanoseconds = epoch;
      }
    } catch {
      // The projector will record the invalid persisted timestamp as a fail-closed fault.
      latestFillEpochNanoseconds = null;
      break;
    }
  }
  return { latestFillEpochNanoseconds, evidenceId: `terminal-order:${order.id}` };
}

function isTerminalBtcStrategyOrder(order: OrderRecord): boolean {
  return order.origin === "STRATEGY" && order.market === "KRW-BTC" &&
    order.failureCode !== "ORDER_SUBMISSION_ABSENCE_CONFIRMED" &&
    (order.status === "FILLED" || order.status === "CANCELED");
}

function compareTerminalCandidates(
  left: { order: OrderRecord; sort: { latestFillEpochNanoseconds: bigint | null; evidenceId: string } },
  right: { order: OrderRecord; sort: { latestFillEpochNanoseconds: bigint | null; evidenceId: string } },
): number {
  if (left.sort.latestFillEpochNanoseconds !== null && right.sort.latestFillEpochNanoseconds !== null) {
    if (left.sort.latestFillEpochNanoseconds < right.sort.latestFillEpochNanoseconds) return -1;
    if (left.sort.latestFillEpochNanoseconds > right.sort.latestFillEpochNanoseconds) return 1;
  } else if (left.sort.latestFillEpochNanoseconds !== null) {
    return -1;
  } else if (right.sort.latestFillEpochNanoseconds !== null) {
    return 1;
  }
  return compareDeterministicIdentifiers(left.order.id, right.order.id) ||
    compareDeterministicIdentifiers(left.sort.evidenceId, right.sort.evidenceId);
}
