# Performance Diagnostics Implementation Plan

**Goal:** Add professional, read-only strategy diagnostics on top of the existing FIFO performance report without changing trading behavior.

**Architecture:** Build an auditable pure matcher, feed it into a separate pure diagnostics calculator, extend the read-only SQLite evidence adapter, and integrate stable text/JSON output through the existing CLI.

## Constraints

- No strategy, execution, reconciliation, scheduler, Telegram polling, Upbit, migration, secret, or LIVE-state changes.
- SQLite production reads use `readOnly: true` only.
- FIFO slices and flat-to-flat selected position episodes remain separate.
- Missing fees and costs propagate explicit unknown states.
- No account-return percentage or benchmark claim.

### Task 1: Pure trade matcher

**Files:**
- Create `src/modules/performance/performance-trade-matcher.ts`
- Create `tests/performance-trade-matcher.test.ts`

- [ ] Write failing tests for FIFO slices, flat-to-flat episodes, partial exits, multiple entries, opening inventory, open episodes, fee allocation, mixed timestamps, ambiguous ties, and decimal residue.
- [ ] Implement the minimal pure matcher and explicit evidence types.
- [ ] Run focused tests and typecheck.

### Task 2: Pure diagnostics

**Files:**
- Create `src/modules/performance/performance-diagnostics.ts`
- Create `tests/performance-diagnostics.test.ts`

- [ ] Write failing tests for episode and slice outcomes, win rate, averages, payoff ratio, profit factor, fee impact, streaks, holding duration, best/worst, realized curve/drawdown, snapshot curve/drawdown, and action contributions.
- [ ] Implement explicit metric-state and completeness contracts.
- [ ] Run focused tests and typecheck.

### Task 3: Read-only evidence and CLI integration

**Files:**
- Modify `src/modules/performance/performance-calculator.ts` only if shared types require a backward-compatible extension.
- Modify `src/modules/performance/sqlite-performance-reader.ts`
- Modify `src/research/performance-report.ts`
- Modify `tests/performance-report.test.ts`
- Modify `tests/run-all.ts`

- [ ] Add order and linked strategy-decision evidence without weakening current lifecycle validation.
- [ ] Load in-bound snapshot mark observations without future data or interpolation.
- [ ] Add stable diagnostics JSON and bounded text sections.
- [ ] Preserve required filters, read-only behavior, and existing report fields.
- [ ] Test corrupted relationships, migration compatibility, and database immutability.

### Task 4: Documentation and verification

**Files:**
- Modify `ARCHITECTURE.md`
- Modify `README.md`
- Update this design if integration uncovers a necessary contract clarification.

- [ ] Document metric definitions, unknown rules, and exact CLI usage.
- [ ] Run `npm.cmd run typecheck`, `npm.cmd test`, and `git diff --check`.
- [ ] Run the report against `company-live.sqlite` read-only and inspect plausibility.
- [ ] Confirm persisted execution state and active-order count are unchanged by the report.
- [ ] Obtain independent code review and address findings.
