import assert from "node:assert/strict";

import {
  advancePositionGuardCandidateState,
  createEmptyPositionGuardCandidateState,
  parsePositionGuardCandidateTimestamp,
  POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE,
  projectPositionGuardCandidateState,
  validatePositionGuardCandidateState,
  type PositionGuardCandidateExecutionEvidence,
  type PositionGuardCandidateState,
} from "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

test("candidate state starts with explicit inventory, cost basis, and version", () => {
  const state = createEmptyPositionGuardCandidateState();

  assert.deepEqual(state, {
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: 0,
    currentEpisodeInventoryQuantity: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
  });
  assert.equal(Object.isFrozen(state), true);
});

test("candidate state uses confirmed fees in cost basis and full-exit pnl", () => {
  const entered = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "e1",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 2,
    grossQuoteValueKrw: 20_000,
    confirmedFeeKrw: 10,
    remainingQuantity: 2,
  }));
  assert.equal(entered.currentEpisodeInventoryQuantity, 2);
  assert.equal(entered.currentEpisodeCostBasisKrw, 20_010);
  assert.equal(entered.stateVersion, 1);

  const exited = advancePositionGuardCandidateState(entered, sellEvidence({
    evidenceId: "e2",
    executedAt: "2026-08-20T01:00:00Z",
    executedQuantity: 2,
    grossQuoteValueKrw: 22_000,
    confirmedFeeKrw: 11,
    remainingQuantity: 0,
  }));
  assert.equal(exited.currentEpisodeInventoryQuantity, 0);
  assert.equal(exited.currentEpisodeCostBasisKrw, 0);
  assert.equal(exited.lastFullExitRealizedPnlKrw, 1_979);
  assert.equal(exited.stateVersion, 2);
});

test("candidate state removes proportional cost for a partial sell", () => {
  const entered = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "buy",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 4,
    grossQuoteValueKrw: 40_000,
    confirmedFeeKrw: 20,
    remainingQuantity: 4,
  }));

  const reduced = advancePositionGuardCandidateState(entered, sellEvidence({
    evidenceId: "reduce",
    executedAt: "2026-08-20T01:00:00Z",
    action: "REDUCE",
    executedQuantity: 1,
    grossQuoteValueKrw: 11_000,
    confirmedFeeKrw: 5,
    remainingQuantity: 3,
  }));

  assert.equal(reduced.currentEpisodeInventoryQuantity, 3);
  assert.equal(reduced.currentEpisodeCostBasisKrw, 30_015);
  assert.equal(reduced.currentEpisodeRealizedPnlKrw, 990);
  assert.equal(reduced.lastFullExitAt, null);
});

test("candidate state closes decimal residuals within the quantity tolerance", () => {
  const entered = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "buy",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  }));
  const exited = advancePositionGuardCandidateState(entered, sellEvidence({
    evidenceId: "exit",
    executedAt: "2026-08-20T01:00:00Z",
    action: "EXIT",
    executedQuantity: 0.9999999999995,
    grossQuoteValueKrw: 120,
    confirmedFeeKrw: 1,
    remainingQuantity: 0.0000000000005,
  }));

  assert.equal(POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE, 1e-12);
  assert.equal(exited.currentEpisodeInventoryQuantity, 0);
  assert.equal(exited.currentEpisodeCostBasisKrw, 0);
  assert.equal(exited.currentEpisodeRealizedPnlKrw, 0);
  assert.equal(exited.lastFullExitRealizedPnlKrw, 18);
});

test("candidate state counts one filled ADD order and preserves its entry path", () => {
  const entered = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "enter",
    executedAt: "2026-08-20T00:00:00Z",
    entryPath: "RECLAIM",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  }));
  const added = advancePositionGuardCandidateState(entered, buyEvidence({
    evidenceId: "add",
    executedAt: "2026-08-20T01:00:00Z",
    action: "ADD",
    entryPath: "RECLAIM",
    executedQuantity: 0.5,
    grossQuoteValueKrw: 60,
    confirmedFeeKrw: 1,
    remainingQuantity: 1.5,
  }));

  assert.equal(added.currentEpisodeAddCount, 1);
  assert.equal(added.currentEpisodeInventoryQuantity, 1.5);
  assert.equal(added.currentEpisodeCostBasisKrw, 162);
  assert.equal(added.lastEntryPath, "RECLAIM");
});

test("candidate state accepts canceled terminal evidence with a fill", () => {
  const state = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "canceled-with-fill",
    executedAt: "2026-08-20T00:00:00Z",
    terminalStatus: "CANCELED",
    executedQuantity: 0.25,
    grossQuoteValueKrw: 25_000,
    confirmedFeeKrw: 12.5,
    remainingQuantity: 0.25,
  }));

  assert.equal(state.currentEpisodeInventoryQuantity, 0.25);
  assert.equal(state.currentEpisodeCostBasisKrw, 25_012.5);
  assert.equal(state.stateVersion, 1);
});

test("candidate state leaves terminal no-fill evidence as a complete no-op", () => {
  const state = {
    ...emptyState(),
    currentEpisodeCostBasisKrw: 101,
    currentEpisodeInventoryQuantity: 1,
    lastEntryPath: "PULLBACK" as const,
    lastEvidenceAt: "2026-08-20T00:00:00Z",
    lastEvidenceId: "enter",
    stateVersion: 1,
  };
  const original = { ...state };
  const noFill = advancePositionGuardCandidateState(state, sellEvidence({
    evidenceId: "canceled-no-fill",
    executedAt: "2026-08-20T01:00:00Z",
    terminalStatus: "CANCELED",
    executedQuantity: 0,
    grossQuoteValueKrw: 0,
    confirmedFeeKrw: 0,
    remainingQuantity: 1,
  }));

  assert.deepEqual(state, original);
  assert.notStrictEqual(noFill, state);
  assert.deepEqual(noFill, state);
  assert.equal(Object.isFrozen(noFill), true);
  assert.equal(noFill.stateVersion, 1);
  assert.equal(noFill.lastEvidenceId, "enter");
});

test("candidate state keeps a mutable no-fill input detached after caller mutation", () => {
  const state = {
    ...emptyState(),
    currentEpisodeCostBasisKrw: 101,
    currentEpisodeInventoryQuantity: 1,
    lastEntryPath: "PULLBACK" as const,
    lastEvidenceAt: "2026-08-20T00:00:00Z",
    lastEvidenceId: "enter",
    stateVersion: 1,
  } as PositionGuardCandidateState;
  const noFill = advancePositionGuardCandidateState(state, sellEvidence({
    evidenceId: "canceled-no-fill",
    executedAt: "2026-08-20T01:00:00Z",
    terminalStatus: "CANCELED",
    executedQuantity: 0,
    grossQuoteValueKrw: 0,
    confirmedFeeKrw: 0,
    remainingQuantity: 1,
  }));

  state.currentEpisodeCostBasisKrw = 999;
  assert.equal(noFill.currentEpisodeCostBasisKrw, 101);
});

test("candidate state rejects a dirty flat episode before a later ENTER can inherit it", () => {
  const dirtyFlat = {
    ...emptyState(),
    currentEpisodeAddCount: 1,
    currentEpisodeRealizedPnlKrw: 5,
    lastEvidenceAt: "2026-08-20T00:00:00Z",
    lastEvidenceId: "prior",
    stateVersion: 1,
  };

  assert.throws(() => validatePositionGuardCandidateState(dirtyFlat), /flat|episode/i);
  assert.throws(() => advancePositionGuardCandidateState(dirtyFlat, buyEvidence({
    evidenceId: "enter",
    executedAt: "2026-08-20T01:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  })), /flat|episode/i);
});

test("candidate state rejects incoherent cursor and full-exit chronology", () => {
  assert.throws(() => validatePositionGuardCandidateState({
    ...emptyState(),
    lastEvidenceAt: "2026-08-20T00:00:00Z",
    lastEvidenceId: "cursor",
    stateVersion: 1,
  }), /full-exit|flat|cursor/i);
  assert.throws(() => validatePositionGuardCandidateState({
    ...emptyState(),
    lastFullExitAt: "2026-08-20T01:00:00Z",
    lastFullExitRealizedPnlKrw: 0,
    lastEntryPath: "PULLBACK",
    lastEvidenceAt: "2026-08-20T00:00:00Z",
    lastEvidenceId: "cursor",
    stateVersion: 1,
  }), /chronolog|full-exit|cursor/i);
});

test("candidate state rejects an open ADD episode with too-small stateVersion", () => {
  assert.throws(() => validatePositionGuardCandidateState({
    ...emptyState(),
    currentEpisodeAddCount: 1,
    currentEpisodeCostBasisKrw: 150,
    currentEpisodeInventoryQuantity: 1.5,
    lastEntryPath: "PULLBACK",
    lastEvidenceAt: "2026-08-20T01:00:00Z",
    lastEvidenceId: "add",
    stateVersion: 1,
  }), /stateVersion|version/i);
});

test("candidate state rejects a completed episode with too-small stateVersion", () => {
  assert.throws(() => validatePositionGuardCandidateState({
    ...emptyState(),
    lastFullExitAt: "2026-08-20T01:00:00Z",
    lastFullExitRealizedPnlKrw: 10,
    lastEntryPath: "PULLBACK",
    lastEvidenceAt: "2026-08-20T01:00:00Z",
    lastEvidenceId: "exit",
    stateVersion: 1,
  }), /stateVersion|version/i);
});

test("candidate state rejects a completed episode without its entry path", () => {
  assert.throws(() => validatePositionGuardCandidateState({
    ...emptyState(),
    lastFullExitAt: "2026-08-20T01:00:00Z",
    lastFullExitRealizedPnlKrw: 10,
    lastEvidenceAt: "2026-08-20T01:00:00Z",
    lastEvidenceId: "exit",
    stateVersion: 2,
  }), /entry path|lastEntryPath/i);
});

test("candidate state sums completed and open episode minimum stateVersion bounds", () => {
  assert.throws(() => validatePositionGuardCandidateState({
    ...emptyState(),
    currentEpisodeCostBasisKrw: 100,
    currentEpisodeInventoryQuantity: 1,
    lastFullExitAt: "2026-08-20T01:00:00Z",
    lastFullExitRealizedPnlKrw: 10,
    lastEntryPath: "RECLAIM",
    lastEvidenceAt: "2026-08-20T02:00:00Z",
    lastEvidenceId: "reenter",
    stateVersion: 2,
  }), /stateVersion|version/i);
});

test("candidate state and evidence require exact own data properties", () => {
  const inheritedState = Object.create(emptyState()) as PositionGuardCandidateState;
  const inheritedEvidence = Object.create(buyEvidence({
    evidenceId: "inherited",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  })) as PositionGuardCandidateExecutionEvidence;
  const hiddenExtraEvidence = buyEvidence({
    evidenceId: "hidden-extra",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  });
  Object.defineProperty(hiddenExtraEvidence, "hidden", { value: true });
  const symbolExtraState = { ...emptyState(), [Symbol("extra")]: true };

  assert.throws(() => validatePositionGuardCandidateState(inheritedState), /own|data property/i);
  assert.throws(() => advancePositionGuardCandidateState(emptyState(), inheritedEvidence), /own|data property/i);
  assert.throws(() => advancePositionGuardCandidateState(emptyState(), hiddenExtraEvidence), /extra|exact|own/i);
  assert.throws(
    () => validatePositionGuardCandidateState(symbolExtraState as PositionGuardCandidateState),
    /symbol|extra|exact/i,
  );
});

test("candidate evidence rejects accessors without reading mutable getter values", () => {
  let getterCalls = 0;
  const evidence = buyEvidence({
    evidenceId: "getter",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  });
  Object.defineProperty(evidence, "grossQuoteValueKrw", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCalls === 1 ? 100 : 10_000;
    },
  });

  assert.throws(() => advancePositionGuardCandidateState(emptyState(), evidence), /data property|accessor/i);
  assert.equal(getterCalls, 0);
});

test("candidate evidence cannot omit every fee-inclusive economic field", () => {
  const missingEconomicFields = {
    evidenceId: "missing-economic-fields",
    executedAt: "2026-08-20T00:00:00Z",
    action: "ENTER",
    entryPath: "PULLBACK",
    remainingQuantity: 1,
  } as unknown as PositionGuardCandidateExecutionEvidence;

  assert.throws(
    () => advancePositionGuardCandidateState(emptyState(), missingEconomicFields),
    /required own data properties|exactly/i,
  );
});

test("candidate projection sorts a detached copy by epoch nanoseconds and evidence ID", () => {
  const result = projectPositionGuardCandidateState({
    initialState: emptyState(),
    evidence: Object.freeze([
      buyEvidence({
        evidenceId: "fill-b",
        executedAt: "2026-08-20T09:00:00+09:00",
        action: "ADD",
        executedQuantity: 1,
        grossQuoteValueKrw: 120,
        confirmedFeeKrw: 1,
        remainingQuantity: 2,
      }),
      buyEvidence({
        evidenceId: "fill-a",
        executedAt: "2026-08-20T00:00:00Z",
        executedQuantity: 1,
        grossQuoteValueKrw: 100,
        confirmedFeeKrw: 1,
        remainingQuantity: 1,
      }),
    ]),
  });

  assert.equal(result.currentEpisodeInventoryQuantity, 2);
  assert.equal(result.currentEpisodeCostBasisKrw, 222);
  assert.equal(result.currentEpisodeAddCount, 1);
  assert.equal(result.lastEvidenceId, "fill-b");
});

test("candidate projection rejects missing fees, duplicates, invalid lifecycle evidence, and residual conflicts", () => {
  const missingFee = {
    ...buyEvidence({
      evidenceId: "missing-fee",
      executedAt: "2026-08-20T00:00:00Z",
      executedQuantity: 1,
      grossQuoteValueKrw: 100,
      confirmedFeeKrw: 1,
      remainingQuantity: 1,
    }),
    confirmedFeeKrw: null,
  } as unknown as PositionGuardCandidateExecutionEvidence;
  assert.throws(() => advancePositionGuardCandidateState(emptyState(), missingFee), /fee/i);

  const duplicate = buyEvidence({
    evidenceId: "duplicate",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  });
  assert.throws(
    () => projectPositionGuardCandidateState({ initialState: emptyState(), evidence: [duplicate, duplicate] }),
    /duplicate/i,
  );

  assert.throws(() => advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "bad-residual",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 0.5,
  })), /remaining|residual/i);

  assert.throws(() => advancePositionGuardCandidateState(emptyState(), {
    ...buyEvidence({
      evidenceId: "open-order",
      executedAt: "2026-08-20T00:00:00Z",
      executedQuantity: 1,
      grossQuoteValueKrw: 100,
      confirmedFeeKrw: 1,
      remainingQuantity: 1,
    }),
    terminalStatus: "OPEN",
  } as unknown as PositionGuardCandidateExecutionEvidence), /terminal|lifecycle/i);
});

test("candidate state rejects non-finite and negative economic evidence", () => {
  const base = buyEvidence({
    evidenceId: "base",
    executedAt: "2026-08-20T00:00:00Z",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  });
  for (const item of [
    { ...base, evidenceId: "nan-quantity", executedQuantity: Number.NaN },
    { ...base, evidenceId: "infinite-value", grossQuoteValueKrw: Number.POSITIVE_INFINITY },
    { ...base, evidenceId: "negative-quantity", executedQuantity: -1 },
    { ...base, evidenceId: "negative-value", grossQuoteValueKrw: -1 },
    { ...base, evidenceId: "negative-fee", confirmedFeeKrw: -1 },
    { ...base, evidenceId: "negative-remaining", remainingQuantity: -1 },
  ] as const) {
    assert.throws(
      () => advancePositionGuardCandidateState(emptyState(), item),
      /quantity|value|fee|remaining/i,
    );
  }
});

test("candidate state rejects out-of-order evidence against its chronology cursor", () => {
  const state = advancePositionGuardCandidateState(emptyState(), buyEvidence({
    evidenceId: "fill-b",
    executedAt: "2026-08-20T09:00:00.000000005+09:00",
    executedQuantity: 1,
    grossQuoteValueKrw: 100,
    confirmedFeeKrw: 1,
    remainingQuantity: 1,
  }));

  assert.throws(() => advancePositionGuardCandidateState(state, sellEvidence({
    evidenceId: "fill-a",
    executedAt: "2026-08-20T00:00:00.000000005Z",
    executedQuantity: 0.5,
    grossQuoteValueKrw: 60,
    confirmedFeeKrw: 1,
    remainingQuantity: 0.5,
  })), /cursor|ordered|chronolog/i);
});

test("candidate state validation rejects malformed inventory, cost basis, and version", () => {
  for (const invalid of [
    { currentEpisodeInventoryQuantity: Number.NaN },
    { currentEpisodeInventoryQuantity: -1 },
    { currentEpisodeCostBasisKrw: Number.POSITIVE_INFINITY },
    { currentEpisodeCostBasisKrw: -1 },
    { stateVersion: -1 },
    { stateVersion: 1.5 },
  ]) {
    assert.throws(() => validatePositionGuardCandidateState({ ...emptyState(), ...invalid }));
  }
});

test("candidate timestamp parser preserves explicit-offset nanosecond ordering", () => {
  assert.equal(parsePositionGuardCandidateTimestamp(
    "1970-01-01T09:00:00.123456789+09:00",
    "executedAt",
  ), 123_456_789n);
  assert.equal(parsePositionGuardCandidateTimestamp(
    "1969-12-31T23:59:59.999999999Z",
    "executedAt",
  ), -1n);
  assert.throws(
    () => parsePositionGuardCandidateTimestamp("2026-08-20T00:00:00", "executedAt"),
    /executedAt/,
  );
});

function emptyState(): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: 0,
    currentEpisodeInventoryQuantity: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
  };
}

type EvidenceOverrides = Pick<
  PositionGuardCandidateExecutionEvidence,
  "evidenceId" | "executedAt" | "executedQuantity" | "grossQuoteValueKrw" | "confirmedFeeKrw" | "remainingQuantity"
> & Partial<Omit<
  PositionGuardCandidateExecutionEvidence,
  "evidenceId" | "executedAt" | "executedQuantity" | "grossQuoteValueKrw" | "confirmedFeeKrw" | "remainingQuantity"
>>;

function buyEvidence(
  overrides: EvidenceOverrides,
): PositionGuardCandidateExecutionEvidence {
  return evidence({ ...overrides, action: overrides.action ?? "ENTER" });
}

function sellEvidence(
  overrides: EvidenceOverrides,
): PositionGuardCandidateExecutionEvidence {
  return evidence({ ...overrides, action: overrides.action ?? "EXIT" });
}

function evidence(
  overrides: EvidenceOverrides,
): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: overrides.evidenceId,
    executedAt: overrides.executedAt,
    action: overrides.action ?? "ENTER",
    entryPath: overrides.entryPath ?? "PULLBACK",
    terminalStatus: overrides.terminalStatus ?? "FILLED",
    executedQuantity: overrides.executedQuantity,
    grossQuoteValueKrw: overrides.grossQuoteValueKrw,
    confirmedFeeKrw: overrides.confirmedFeeKrw,
    remainingQuantity: overrides.remainingQuantity,
  };
}
