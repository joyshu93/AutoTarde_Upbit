# Telegram Korean Message Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Korean-first Telegram text presentation for `/run`, `/config`, `/statehistory`, `/synchistory`, and `/recovery`, then reduce `formatter.ts` to a compatibility facade without changing trading behavior.

**Architecture:** Add focused locale-aware presentation modules in front of the existing result and persisted-record contracts. Mutation and inspection controllers remain unchanged and are invoked with the same counts as before. After behavior is covered, move the formatter implementation into `presentation/technical.ts` and retain existing imports through a small `formatter.ts` re-export facade.

**Tech Stack:** TypeScript strict mode, Node.js test harness, existing Telegram router and presentation helpers.

## Global Constraints

- Default locale remains exactly `ko-KR`; the only alternative remains `en-US`.
- Preserve all existing canonical fields, identifiers, raw details, and safety boundaries.
- `/run` remains mutation-capable and may submit a real order in intentional LIVE operation.
- Formatting must not add repository reads, exchange calls, strategy runs, synchronization, scheduler actions, execution-state transitions, or notification delivery.
- Order submission acceptance must not be described as a fill.
- Inspection screens must not become portfolio or execution truth.
- Telegram remains plain text for these responses; preserve raw dynamic detail exactly.
- Root behavior, risk guards, DB schemas, order lifecycle, strategy calculations, DRY_RUN defaults, and live gates remain unchanged.
- Write tests first and observe expected RED failures before production edits.
- Do not stop or restart the running LIVE process.

---

### Task 1: Locale-Aware Strategy Run Result

**Files:**
- Create: `src/modules/telegram/presentation/run.ts`
- Modify: `src/modules/telegram/commands.ts`
- Modify: `src/modules/telegram/formatter.ts`
- Modify: `tests/telegram-commands.test.ts`
- Modify: `tests/telegram-operator-contracts.test.ts`

**Produces:** `formatStrategyRunPresentation(result, locale)` and locale wiring for `/run`.

- [x] Write failing tests for all run statuses (`COMPLETED`, `ALREADY_RUNNING`, `SKIPPED`, `NOT_CONNECTED`, `FAILED`), all actions, null values, KST and invalid timestamps, exact detail retention, and Korean/English equivalence.
- [x] Write failing tests for completed HOLD/no-order, submission accepted, submission rejected, and lifecycle states. Assert acceptance is never called a fill.
- [x] Write routing tests proving valid BTC/ETH calls the controller once, invalid requests call it zero times, and formatting adds no repository or operator-state reads.
- [x] Run focused tests and verify the failures are caused by missing localized run presentation.
- [x] Implement Korean-first readable status, action, submission outcome, order reference/status, next action, and explicit LIVE capability warning while preserving every canonical line.
- [x] Run focused and full tests.

---

### Task 2: Locale-Aware Config, State History, Sync History, And Recovery

**Files:**
- Create: `src/modules/telegram/presentation/config.ts`
- Create: `src/modules/telegram/presentation/history.ts`
- Create: `src/modules/telegram/presentation/recovery.ts`
- Modify: `src/modules/telegram/commands.ts`
- Modify: `src/modules/telegram/formatter.ts`
- Modify: `tests/telegram-commands.test.ts`
- Modify: `tests/telegram-operator-contracts.test.ts`

**Produces:** Korean-first inspection headers and explanations with unchanged canonical technical bodies.

- [x] Write failing tests for Korean and English `/config`, including missing config, execution mode, live path/blockers, Telegram/scheduler configuration, secret booleans, and deprecated ignored environment variables.
- [x] Write failing tests for empty and populated `/statehistory` with readable transitions, KST time, and exact canonical transition lines.
- [x] Write failing tests for empty and populated `/synchistory` with latest outcome, issue count/codes, history coverage/confidence, and exact canonical reconciliation lines.
- [x] Write failing tests for missing and populated `/recovery`, including coverage, confidence, retention, checkpoint progress, and exact canonical recovery fields.
- [x] Assert each command retains existing bounded repository-call counts and does not invoke sync, strategy, scheduler, operator-state mutations, exchange, or notification dependencies.
- [x] Run focused tests and verify expected RED failures.
- [x] Implement focused presentation modules that prepend concise localized guidance to the unchanged canonical formatter body.
- [x] Run focused and full tests.

---

### Task 3: Formatter Compatibility Facade

**Files:**
- Create by moving implementation: `src/modules/telegram/presentation/technical.ts`
- Replace: `src/modules/telegram/formatter.ts`
- Modify imports inside moved implementation only as required by its new location.
- Test: complete existing repository suite

**Produces:** A small stable `formatter.ts` facade that re-exports the implementation from `presentation/technical.ts`.

- [x] Add a failing structural test that requires `formatter.ts` to remain a small compatibility facade and verifies all existing formatter exports remain importable.
- [x] Run the structural test and verify it fails against the current monolithic file.
- [x] Move the current formatter implementation to `presentation/technical.ts`, adjust relative imports, and replace `formatter.ts` with a re-export-only facade.
- [x] Run focused import tests, TypeScript build, and the full suite.

---

### Task 4: Documentation And Final Safety Review

**Files:**
- Modify: `README.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `RISK_POLICY.md`

- [x] Document localized `/run`, config/history/recovery presentation, canonical evidence preservation, and the formatter facade.
- [x] Independently review the complete diff for live-order wording, accepted-versus-filled semantics, no added controller or repository calls, and secret boundaries.
- [x] Confirm no DB schema, strategy, risk, exchange, execution, reconciliation, scheduler, or delivery behavior changed.
- [x] Run `npm.cmd test` fresh.
- [x] Run `git diff --check`.
- [x] Confirm the existing LIVE process remains running and was not restarted.
- [x] Commit and push the complete bundle to `codex/telegram-korean-ux`.
