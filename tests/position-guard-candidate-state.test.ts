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

type CandidateStateCursor = Readonly<{
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
}>;

test("position guard candidate state starts empty and frozen", () => {
  const state = createEmptyPositionGuardCandidateState();

  assert.deepEqual(state, {
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
  });
  assert.equal(Object.isFrozen(state), true);
});

test("position guard candidate state captures ENTER path and accumulates rounded REDUCE PnL", () => {
  const initialState = createEmptyPositionGuardCandidateState();
  const enter = evidence({
    evidenceId: "fill-001",
    executedAt: "2026-08-20T00:00:00.000000001Z",
    action: "ENTER",
    entryPath: "PULLBACK",
    remainingQuantity: 0.001,
  });
  const entered = advancePositionGuardCandidateState(initialState, enter);

  assert.equal(entered.lastEntryPath, "PULLBACK");
  assert.deepEqual(initialState, createEmptyPositionGuardCandidateState());
  assert.deepEqual(enter, evidence({
    evidenceId: "fill-001",
    executedAt: "2026-08-20T00:00:00.000000001Z",
    action: "ENTER",
    entryPath: "PULLBACK",
    remainingQuantity: 0.001,
  }));

  const reduced = advancePositionGuardCandidateState(entered, evidence({
    evidenceId: "fill-002",
    executedAt: "2026-08-20T01:00:00+00:00",
    action: "REDUCE",
    entryPath: "PULLBACK",
    realizedPnlKrw: -125.5000004,
    remainingQuantity: 0.0005,
  }));

  assert.equal(reduced.currentEpisodeRealizedPnlKrw, -125.5);
  assert.equal(Object.isFrozen(entered), true);
  assert.equal(Object.isFrozen(reduced), true);
});

test("position guard candidate state counts ADD fills and resets a full EXIT at the quantity tolerance", () => {
  const added = advancePositionGuardCandidateState(
    {
      currentEpisodeAddCount: 0,
      currentEpisodeRealizedPnlKrw: 10.25,
      lastFullExitAt: null,
      lastFullExitRealizedPnlKrw: null,
      lastEntryPath: "RECLAIM",
      lastEvidenceAt: "2026-08-20T00:00:00Z",
      lastEvidenceId: "fill-enter",
    },
    evidence({
      evidenceId: "fill-add",
      executedAt: "2026-08-20T01:00:00Z",
      action: "ADD",
      entryPath: "RECLAIM",
      remainingQuantity: 0.002,
    }),
  );

  assert.equal(added.currentEpisodeAddCount, 1);
  assert.equal(POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE, 1e-12);

  const exited = advancePositionGuardCandidateState(added, evidence({
    evidenceId: "fill-exit",
    executedAt: "2026-08-20T02:00:00.000000009Z",
    action: "EXIT",
    entryPath: "RECLAIM",
    realizedPnlKrw: -2.125,
    remainingQuantity: 1e-12,
  }));

  assert.deepEqual(exited, {
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: "2026-08-20T02:00:00.000000009Z",
    lastFullExitRealizedPnlKrw: 8.125,
    lastEntryPath: "RECLAIM",
    lastEvidenceAt: "2026-08-20T02:00:00.000000009Z",
    lastEvidenceId: "fill-exit",
  });
});

test("position guard candidate state keeps an EXIT episode open above the quantity tolerance", () => {
  const state = advancePositionGuardCandidateState(
    {
      currentEpisodeAddCount: 1,
      currentEpisodeRealizedPnlKrw: 0,
      lastFullExitAt: null,
      lastFullExitRealizedPnlKrw: null,
      lastEntryPath: "BREAKOUT_HOLD",
      lastEvidenceAt: "2026-08-20T01:00:00Z",
      lastEvidenceId: "fill-before-partial-exit",
    },
    evidence({
      evidenceId: "fill-partial-exit",
      executedAt: "2026-08-20T02:00:00Z",
      action: "EXIT",
      entryPath: "BREAKOUT_HOLD",
      realizedPnlKrw: 4.5,
      remainingQuantity: 1.0000001e-12,
    }),
  );

  assert.equal(state.currentEpisodeAddCount, 1);
  assert.equal(state.currentEpisodeRealizedPnlKrw, 4.5);
  assert.equal(state.lastFullExitAt, null);
  assert.equal(state.lastFullExitRealizedPnlKrw, null);
});

test("position guard candidate timestamp parser preserves nanoseconds and exact timezone instants", () => {
  assert.equal(parsePositionGuardCandidateTimestamp(
    "1970-01-01T00:00:00.000000001Z",
    "executedAt",
  ), 1n);
  assert.equal(parsePositionGuardCandidateTimestamp(
    "1970-01-01T09:00:00.123456789+09:00",
    "executedAt",
  ), 123_456_789n);
  assert.equal(parsePositionGuardCandidateTimestamp(
    "1969-12-31T23:59:59.999999999Z",
    "executedAt",
  ), -1n);
});

test("position guard candidate timestamp parser rejects malformed or implicit-zone values", () => {
  for (const value of [
    "2026-08-20T00:00:00",
    "2026-02-30T00:00:00Z",
    "2026-08-20T24:00:00Z",
    "2026-08-20T00:00:00.1234567890Z",
    "2026-08-20T00:00:00+14:01",
    "2026-08-20T00:00:00+09:60",
  ]) {
    assert.throws(
      () => parsePositionGuardCandidateTimestamp(value, "candidate timestamp"),
      /candidate timestamp/,
    );
  }
});

test("position guard candidate timestamps reject non-primitive strings without coercion", () => {
  let customToStringCalls = 0;
  const values: unknown[] = [
    new String("2026-08-20T00:00:00Z"),
    {
      toString() {
        customToStringCalls += 1;
        return "2026-08-20T00:00:00Z";
      },
    },
  ];

  for (const value of values) {
    assert.throws(
      () => parsePositionGuardCandidateTimestamp(value as string, "candidate timestamp"),
      /candidate timestamp/,
    );
    assert.throws(
      () => advancePositionGuardCandidateState(emptyState(), {
        ...evidence({ evidenceId: "non-string-time", executedAt: "2026-08-20T00:00:00Z" }),
        executedAt: value,
      } as unknown as PositionGuardCandidateExecutionEvidence),
      /executedAt/,
    );
  }

  assert.equal(customToStringCalls, 0);
});

test("position guard candidate projection orders mixed timezones by epoch nanoseconds", () => {
  const result = projectPositionGuardCandidateState({
    initialState: emptyState(),
    evidence: [
      evidence({
        evidenceId: "fill-001",
        executedAt: "2026-08-20T09:30:00+09:00",
        action: "ENTER",
        entryPath: "PULLBACK",
        remainingQuantity: 0.001,
      }),
      evidence({
        evidenceId: "fill-002",
        executedAt: "2026-08-20T01:00:00Z",
        action: "ADD",
        entryPath: "PULLBACK",
        remainingQuantity: 0.002,
      }),
    ],
  });

  assert.equal(result.lastEntryPath, "PULLBACK");
  assert.equal(result.currentEpisodeAddCount, 1);
});

test("position guard candidate projection accepts equal timestamps only in evidenceId order", () => {
  const ordered = [
    evidence({
      evidenceId: "fill-a",
      executedAt: "2026-08-20T00:00:00Z",
      action: "ENTER",
      entryPath: "RECLAIM",
      remainingQuantity: 0.001,
    }),
    evidence({
      evidenceId: "fill-b",
      executedAt: "2026-08-20T09:00:00+09:00",
      action: "ADD",
      entryPath: "RECLAIM",
      remainingQuantity: 0.002,
    }),
  ] as const;

  assert.equal(projectPositionGuardCandidateState({
    initialState: emptyState(),
    evidence: ordered,
  }).currentEpisodeAddCount, 1);

  assert.throws(
    () => projectPositionGuardCandidateState({
      initialState: emptyState(),
      evidence: [ordered[1], ordered[0]],
    }),
    /order/i,
  );
});

test("position guard candidate state records a canonical cursor and rejects one-step chronology overlap", () => {
  const first = advancePositionGuardCandidateState(emptyState(), evidence({
    evidenceId: "fill-b",
    executedAt: "2026-08-20T09:00:00.000000005+09:00",
    action: "ENTER",
    remainingQuantity: 0.001,
  }));

  assert.deepEqual(candidateCursor(first), {
    lastEvidenceAt: "2026-08-20T09:00:00.000000005+09:00",
    lastEvidenceId: "fill-b",
  });
  for (const stale of [
    evidence({ evidenceId: "fill-z", executedAt: "2026-08-20T00:00:00.000000004Z" }),
    evidence({ evidenceId: "fill-a", executedAt: "2026-08-20T00:00:00.000000005Z" }),
    evidence({ evidenceId: "fill-b", executedAt: "2026-08-20T00:00:00.000000005Z" }),
  ]) {
    assert.throws(
      () => advancePositionGuardCandidateState(first, stale),
      /cursor|ordered|chronolog/i,
    );
  }

  const next = advancePositionGuardCandidateState(first, evidence({
    evidenceId: "fill-c",
    executedAt: "2026-08-20T00:00:00.000000005Z",
    action: "ADD",
    remainingQuantity: 0.002,
  }));
  assert.deepEqual(candidateCursor(next), {
    lastEvidenceAt: "2026-08-20T00:00:00.000000005Z",
    lastEvidenceId: "fill-c",
  });
});

test("position guard candidate projection rejects evidence at or before a non-empty initial cursor", () => {
  const initialState = withCursor(emptyState(), {
    lastEvidenceAt: "2026-08-20T00:00:00.000000005Z",
    lastEvidenceId: "fill-b",
  });

  for (const stale of [
    evidence({ evidenceId: "fill-z", executedAt: "2026-08-20T00:00:00.000000004Z" }),
    evidence({ evidenceId: "fill-a", executedAt: "2026-08-20T09:00:00.000000005+09:00" }),
    evidence({ evidenceId: "fill-b", executedAt: "2026-08-20T00:00:00.000000005Z" }),
  ]) {
    assert.throws(
      () => projectPositionGuardCandidateState({ initialState, evidence: [stale] }),
      /cursor|ordered|chronolog|duplicate/i,
    );
  }

  const projected = projectPositionGuardCandidateState({
    initialState,
    evidence: [evidence({
      evidenceId: "fill-c",
      executedAt: "2026-08-20T09:00:00.000000005+09:00",
      action: "ADD",
      remainingQuantity: 0.002,
    })],
  });
  assert.deepEqual(candidateCursor(projected), {
    lastEvidenceAt: "2026-08-20T09:00:00.000000005+09:00",
    lastEvidenceId: "fill-c",
  });
});

test("position guard candidate projection rejects duplicate evidence IDs and timestamp regressions", () => {
  assert.throws(
    () => projectPositionGuardCandidateState({
      initialState: emptyState(),
      evidence: [
        evidence({
          evidenceId: "duplicate",
          executedAt: "2026-08-20T00:00:00Z",
          action: "ENTER",
          remainingQuantity: 0.001,
        }),
        evidence({
          evidenceId: "duplicate",
          executedAt: "2026-08-20T01:00:00Z",
          action: "ADD",
          remainingQuantity: 0.002,
        }),
      ],
    }),
    /duplicate/i,
  );

  assert.throws(
    () => projectPositionGuardCandidateState({
      initialState: emptyState(),
      evidence: [
        evidence({
          evidenceId: "fill-later",
          executedAt: "2026-08-20T01:00:00Z",
          action: "ENTER",
          remainingQuantity: 0.001,
        }),
        evidence({
          evidenceId: "fill-earlier",
          executedAt: "2026-08-20T00:59:59.999999999Z",
          action: "ADD",
          remainingQuantity: 0.002,
        }),
      ],
    }),
    /order/i,
  );
});

test("position guard candidate state rejects missing realized PnL and invalid actions", () => {
  for (const action of ["REDUCE", "EXIT"] as const) {
    assert.throws(
      () => advancePositionGuardCandidateState(emptyState(), evidence({
        evidenceId: `missing-${action}`,
        executedAt: "2026-08-20T00:00:00Z",
        action,
        realizedPnlKrw: null,
        remainingQuantity: 0.001,
      })),
      /realizedPnlKrw/,
    );
  }

  assert.throws(
    () => advancePositionGuardCandidateState(emptyState(), {
      ...evidence({ evidenceId: "hold", executedAt: "2026-08-20T00:00:00Z" }),
      action: "HOLD",
    } as unknown as PositionGuardCandidateExecutionEvidence),
    /action/i,
  );
});

test("position guard candidate state validation rejects malformed state", () => {
  const valid = emptyState();
  const invalidStates: PositionGuardCandidateState[] = [
    { ...valid, currentEpisodeAddCount: -1 },
    { ...valid, currentEpisodeAddCount: 1.5 },
    { ...valid, currentEpisodeRealizedPnlKrw: Number.NaN },
    { ...valid, currentEpisodeRealizedPnlKrw: Number.POSITIVE_INFINITY },
    { ...valid, lastFullExitAt: "2026-08-20T00:00:00" },
    { ...valid, lastFullExitRealizedPnlKrw: Number.NEGATIVE_INFINITY },
    { ...valid, lastEntryPath: "INVALID" as PositionGuardCandidateState["lastEntryPath"] },
  ];

  for (const state of invalidStates) {
    assert.throws(() => validatePositionGuardCandidateState(state));
  }
});

test("position guard candidate state requires symmetric full-exit metadata", () => {
  assert.throws(
    () => validatePositionGuardCandidateState({
      ...emptyState(),
      lastFullExitAt: "2026-08-20T00:00:00Z",
      lastFullExitRealizedPnlKrw: null,
    }),
    /full-exit metadata/i,
  );
  assert.throws(
    () => validatePositionGuardCandidateState({
      ...emptyState(),
      lastFullExitAt: null,
      lastFullExitRealizedPnlKrw: 0,
    }),
    /full-exit metadata/i,
  );
});

test("position guard candidate state requires symmetric canonical cursor metadata", () => {
  for (const invalid of [
    { lastEvidenceAt: "2026-08-20T00:00:00Z", lastEvidenceId: null },
    { lastEvidenceAt: null, lastEvidenceId: "fill-001" },
    { lastEvidenceAt: "2026-08-20T00:00:00", lastEvidenceId: "fill-001" },
    { lastEvidenceAt: "2026-08-20T00:00:00Z", lastEvidenceId: "" },
    { lastEvidenceAt: 123, lastEvidenceId: "fill-001" },
  ] as const) {
    assert.throws(
      () => validatePositionGuardCandidateState({
        ...emptyState(),
        ...invalid,
      } as unknown as PositionGuardCandidateState),
      /cursor|lastEvidence/i,
    );
  }
});

test("position guard candidate state rejects cursorless carry-in state", () => {
  const cursorless = {
    currentEpisodeAddCount: 1,
    currentEpisodeRealizedPnlKrw: -25,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: "PULLBACK",
  } as unknown as PositionGuardCandidateState;

  assert.throws(
    () => validatePositionGuardCandidateState(cursorless),
    /cursor|lastEvidence/i,
  );
  assert.throws(
    () => advancePositionGuardCandidateState(cursorless, evidence({
      evidenceId: "older-fill",
      executedAt: "2026-08-19T23:59:59Z",
    })),
    /cursor|lastEvidence/i,
  );

  const explicitNullCursor = {
    ...cursorless,
    lastEvidenceAt: null,
    lastEvidenceId: null,
  };
  assert.throws(
    () => validatePositionGuardCandidateState(explicitNullCursor),
    /cursor|empty/i,
  );
});

test("position guard candidate state rejects malformed execution evidence", () => {
  const invalidEvidence: PositionGuardCandidateExecutionEvidence[] = [
    evidence({ evidenceId: "", executedAt: "2026-08-20T00:00:00Z" }),
    evidence({ evidenceId: "bad-time", executedAt: "not-a-time" }),
    evidence({ evidenceId: "nan-pnl", executedAt: "2026-08-20T00:00:00Z", realizedPnlKrw: Number.NaN }),
    evidence({ evidenceId: "infinite-quantity", executedAt: "2026-08-20T00:00:00Z", remainingQuantity: Number.POSITIVE_INFINITY }),
    evidence({ evidenceId: "negative-quantity", executedAt: "2026-08-20T00:00:00Z", remainingQuantity: -1e-12 }),
    evidence({
      evidenceId: "bad-entry-path",
      executedAt: "2026-08-20T00:00:00Z",
      entryPath: "INVALID" as PositionGuardCandidateExecutionEvidence["entryPath"],
    }),
  ];

  for (const item of invalidEvidence) {
    assert.throws(() => advancePositionGuardCandidateState(emptyState(), item));
  }
});

test("position guard candidate projection leaves frozen inputs untouched and returns frozen output", () => {
  const initialState = Object.freeze({
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 1.25,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: "2026-08-19T00:00:00Z",
    lastEvidenceId: "fill-before-immutable",
  }) satisfies PositionGuardCandidateState;
  const executionEvidence = Object.freeze(evidence({
    evidenceId: "fill-immutable",
    executedAt: "2026-08-20T00:00:00Z",
    action: "ENTER",
    entryPath: "BREAKOUT_HOLD",
    remainingQuantity: 0.001,
  }));
  const evidenceList = Object.freeze([executionEvidence]);

  const result = projectPositionGuardCandidateState({
    initialState,
    evidence: evidenceList,
  });

  assert.deepEqual(initialState, {
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 1.25,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: "2026-08-19T00:00:00Z",
    lastEvidenceId: "fill-before-immutable",
  });
  assert.equal(executionEvidence.entryPath, "BREAKOUT_HOLD");
  assert.equal(evidenceList.length, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(candidateCursor(result), {
    lastEvidenceAt: "2026-08-20T00:00:00Z",
    lastEvidenceId: "fill-immutable",
  });
  assert.throws(() => {
    (result as PositionGuardCandidateState).currentEpisodeAddCount = 99;
  }, TypeError);
});

function emptyState(): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
  };
}

function candidateCursor(state: Readonly<PositionGuardCandidateState>): CandidateStateCursor {
  const value = state as PositionGuardCandidateState & CandidateStateCursor;
  return {
    lastEvidenceAt: value.lastEvidenceAt,
    lastEvidenceId: value.lastEvidenceId,
  };
}

function withCursor(
  state: PositionGuardCandidateState,
  cursor: CandidateStateCursor,
): PositionGuardCandidateState {
  return { ...state, ...cursor } as PositionGuardCandidateState;
}

function evidence(
  overrides: Partial<PositionGuardCandidateExecutionEvidence> & Pick<PositionGuardCandidateExecutionEvidence, "evidenceId" | "executedAt">,
): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: overrides.evidenceId,
    executedAt: overrides.executedAt,
    action: overrides.action ?? "ENTER",
    entryPath: overrides.entryPath ?? "PULLBACK",
    realizedPnlKrw: overrides.realizedPnlKrw ?? null,
    remainingQuantity: overrides.remainingQuantity ?? 0,
  };
}
