# Task 8 Report

## RED Evidence

- `npm.cmd run test` initially failed with `TS2307` because `src/modules/execution/candidate-evidence-service.ts` did not exist.
- Focused reconciliation tests failed when UUID recovery sent one combined `{ uuid, identifier }` query rather than the required UUID-first lookup.
- Focused candidate evidence tests failed because an aggregate fill notional exceeding a persisted price-bid quote budget advanced candidate state.
- Focused SQLite candidate tests exposed the new exact-decimal assertion's null-prototype row comparison; concrete value assertions then confirmed the expected stored text values.
- Focused candidate evidence tests failed because a retry of terminal no-fill cancellation returned `TERMINAL_NO_FILL` again instead of a durable-marker `DUPLICATE` result.
- The first `0019` compatibility fixture attempted to create a duplicate primary deployment; the corrected fixture reuses the persisted `0018` deployment and verifies its migrated state.

## GREEN Evidence

- `npm.cmd run build` and the focused candidate-evidence service suite passed after exact terminal-fill aggregation, fee/provenance validation, conflict handling, and restart idempotency were implemented.
- `npm.cmd run build` and the focused reconciliation suite passed after UUID-first/identifier-fallback recovery, persisted count-plus-elapsed absence bounds, transient isolation, and terminal projection wiring were implemented.
- `npm.cmd run build` and the focused SQLite candidate repository suite passed with migration `0019_store_candidate_evidence_decimals_as_text.sql`, including exact high-precision text-affinity assertions.
- The focused no-fill retry test passed with a fresh projector instance: first cancellation records exactly one `CANDIDATE_EVIDENCE_TERMINAL_NO_FILL` marker, while restart retry returns `DUPLICATE` without candidate evidence/state advancement.
- The focused SQLite candidate repository suite passed an explicit `0018` to `0019` upgrade test, retaining existing state and converting legacy numeric evidence to text.
- Final verification passed after the no-fill marker change: `npm.cmd run typecheck` and the full serial `npm.cmd run test` suite.

## Rulings And Concerns

- Ruling: terminal no-fill remains a candidate evidence/state no-op. Its deterministic order-event marker is the restart-idempotency record; marker replay returns `DUPLICATE` and never pauses, resumes, sends, or releases a lease.
- Ruling: candidate aggregate evidence is exact decimal text in persistence. The legacy candidate state projector still normalizes evidence for its existing numeric state calculations; Task 8 never reconstructs aggregate values from those floats.
- Concern: SQLite values written before `0019` were already subject to the old `REAL` representation. The migration preserves their available values as text, while all Task 8 writes are exact text from creation onward.

## Extra Files And Rationale

- `migrations/0019_store_candidate_evidence_decimals_as_text.sql`: required to persist Task 8 aggregate evidence as exact decimal strings rather than SQLite floating-point values.
- `src/modules/db/interfaces.ts`, `src/modules/db/types.ts`, `src/modules/db/repositories/in-memory-repositories.ts`, `src/modules/db/repositories/sqlite-repositories.ts`: required persisted strategy-decision lookup and recovery-observation interfaces/implementations.
- `src/modules/db/pilot-interfaces.ts`, `src/modules/db/repositories/in-memory-candidate-pilot-repository.ts`, `src/modules/db/repositories/sqlite-candidate-pilot-repository.ts`: required deployment lookup and exact-decimal candidate evidence persistence through the existing atomic CAS/audit contract.
- `src/modules/strategy/position-guard-candidate-state.ts`: required the candidate evidence boundary to accept persisted decimal strings while preserving pure numeric projection normalization.
- `src/modules/reconciliation/interfaces.ts`: required explicit reconciliation issue types for recovery and candidate-projection outcomes.
- `tests/db-candidate-pilot-persistence.test.ts`: required fresh-SQLite coverage for migration `0019` and exact decimal storage.
- `tests/position-guard-candidate-dependency-boundary.test.ts`: required whitelist update for the new reconciliation-only candidate projector.
- `tests/position-guard-candidate-parity.test.ts`: required numeric conversion at an existing pure-state assertion after evidence values became decimal-string capable.
- `PRODUCT_BOUNDARY.md`, `ARCHITECTURE.md`, `RISK_POLICY.md`, `ORDER_LIFECYCLE.md`, `README.md`: mandatory repository documentation updates for changed safety behavior and interfaces.
