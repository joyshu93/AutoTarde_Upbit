# Telegram Korean-First Operator UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Korean-first, progressively disclosed Telegram operator interface with read-only inline navigation while preserving all canonical trading records and execution guards.

**Architecture:** Add an explicit locale and presentation layer in front of the existing technical formatters. Extend the Telegram transport with typed inline-keyboard and callback primitives, then route only closed read-only callback actions to existing repository-backed inspections. Keep all mutation commands on the existing text command router.

**Tech Stack:** TypeScript strict mode, Node.js built-in test harness, Telegram Bot API HTTP endpoints, existing modular monolith and SQLite repositories.

## Global Constraints

- Default locale is exactly `ko-KR`; supported locales are exactly `ko-KR` and `en-US`.
- No locale DB migration and no `/language` command.
- No callback may invoke `/run`, `/resume`, `/pause`, `/killswitch`, or `/sync`.
- No changes to live execution selection, strategy decisions, risk guards, order lifecycle, or database truth.
- Canonical codes and identifiers remain available in detail output.
- Dynamic HTML content is escaped.
- Tests are written and observed failing before production implementation.

---

### Task 1: Locale Configuration And Presentation Primitives

**Files:**
- Modify: `src/app/env.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/modules/telegram/interfaces.ts`
- Create: `src/modules/telegram/presentation/locale.ts`
- Create: `src/modules/telegram/presentation/common.ts`
- Modify: `tests/env.test.ts`
- Create: `tests/telegram-presentation.test.ts`
- Modify: `tests/run-all.ts`

**Produces:** `TelegramLocale`, `normalizeTelegramLocale`, `formatTelegramTimestamp`, `formatTelegramKrw`, `formatTelegramQuantity`, and `escapeTelegramHtml`.

- [ ] Write tests asserting the missing env defaults to `ko-KR`, `en-US` is accepted, unsupported values fall back to `ko-KR`, UTC timestamps render in `Asia/Seoul`, KRW is grouped, quantities avoid floating noise, and HTML metacharacters are escaped.
- [ ] Run `npm.cmd test` and verify the new tests fail because locale and presentation primitives do not exist.
- [ ] Implement the minimal typed locale/config and common formatting functions and pass locale into `TelegramRuntimeConfigSnapshot` and `TelegramRouterDependencies`.
- [ ] Run `npm.cmd test` and verify the suite passes.

### Task 2: Localized Summary And Detail Formatters

**Files:**
- Move: `src/modules/telegram/formatter.ts` to `src/modules/telegram/presentation/technical.ts`
- Create: `src/modules/telegram/presentation/dashboard.ts`
- Create: `src/modules/telegram/presentation/inspection.ts`
- Create: `src/modules/telegram/presentation/portfolio.ts`
- Create: `src/modules/telegram/presentation/orders.ts`
- Create: `src/modules/telegram/presentation/operations.ts`
- Create: `src/modules/telegram/presentation/alerts.ts`
- Create: `src/modules/telegram/formatter.ts`
- Modify: `src/modules/telegram/contracts.ts`
- Modify: `src/modules/telegram/commands.ts`
- Modify: `tests/telegram-commands.test.ts`
- Modify: `tests/telegram-operator-contracts.test.ts`

**Consumes:** Task 1 locale and common formatting functions.
**Produces:** Korean-first summaries, English summaries, stable technical detail formatters, and `detail` argument handling.

- [ ] Write failing tests for Korean `/help`, `/status`, `/readiness`, `/balances`, `/positions`, `/orders`, `/order`, `/alerts`, `/risks`, `/scheduler`, control results, sync, preview, and run results.
- [ ] Write failing tests proving `/status detail`, `/readiness detail`, `/alerts detail`, and `/orders detail` retain canonical technical fields and identifiers.
- [ ] Run the focused Telegram tests and verify failures are caused by missing localized presentation behavior.
- [ ] Move the exhaustive implementation to `presentation/technical.ts`, retain compatibility exports, and implement focused localized summary modules.
- [ ] Extend command argument contracts only for the approved `detail` forms and keep mutation command validation unchanged.
- [ ] Run the focused Telegram tests and the full suite.

### Task 3: Typed Telegram Buttons, Editing, And Callback Input

**Files:**
- Modify: `src/modules/telegram/delivery.ts`
- Modify: `src/modules/telegram/inbound.ts`
- Modify: `src/modules/telegram/interfaces.ts`
- Create: `src/modules/telegram/callbacks.ts`
- Modify: `tests/telegram-delivery.test.ts`
- Modify: `tests/telegram-inbound.test.ts`

**Produces:** typed inline keyboards, `editMessageText`, `answerCallbackQuery`, callback update normalization, and a closed read-only callback action parser.

- [x] Write failing transport tests for `parse_mode`, `reply_markup`, returned `message_id`, `editMessageText`, and `answerCallbackQuery`.
- [x] Write failing inbound tests for `allowed_updates=[message,callback_query]`, callback normalization, private operator authorization, malformed callback acknowledgement, and message editing.
- [x] Run the focused tests and verify expected failures.
- [x] Implement typed transport primitives and callback polling without changing notification retry semantics.
- [x] Implement callback-data parsing that cannot represent mutation commands.
- [x] Run focused and full tests.

### Task 4: Read-Only Dashboard, Refresh, And Pagination

**Files:**
- Modify: `src/modules/telegram/commands.ts`
- Modify: `src/modules/telegram/inbound.ts`
- Modify: `src/modules/telegram/presentation/dashboard.ts`
- Modify: `src/modules/telegram/presentation/orders.ts`
- Modify: `src/modules/telegram/presentation/alerts.ts`
- Modify: `tests/telegram-commands.test.ts`
- Modify: `tests/telegram-inbound.test.ts`

**Produces:** `/start` dashboard, status/readiness refresh, order and alert pagination, and detail navigation using edited messages.

- [ ] Write failing tests for dashboard buttons and each approved callback action.
- [ ] Write failing tests proving callbacks cannot call operator-state mutations, sync, preview, or run controllers.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement a read-only callback route that reuses repository-backed inspection builders and bounded page sizes.
- [ ] Edit the originating bot message after callback acknowledgement instead of sending chat-cluttering navigation messages.
- [ ] Run focused and full tests.

### Task 5: Localized Telegram Command Menu And Integration Documentation

**Files:**
- Create: `src/modules/telegram/setup.ts`
- Modify: `src/modules/telegram/delivery.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/index.ts`
- Modify: `tests/telegram-delivery.test.ts`
- Modify: `tests/create-app.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `RISK_POLICY.md`

**Produces:** idempotent Korean/English `setMyCommands` registration and documented operator UX boundaries.

- [ ] Write failing tests for Korean default command descriptions, English language-specific descriptions, setup failure isolation, and secret-free status reporting.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement non-trading Telegram interface setup that never blocks runtime trading safety startup when Telegram rejects profile configuration.
- [ ] Update docs with `TELEGRAM_LOCALE`, summary/detail usage, dashboard buttons, callback authorization, and unchanged mutation-command safety boundaries.
- [ ] Run `npm.cmd run check` and inspect `git diff --check`.

### Task 6: Final Safety Review

**Files:**
- Review all changed files.

- [ ] Confirm no callback action can reach execution, sync, pause, resume, or kill-switch mutation dependencies.
- [ ] Confirm persisted order, fill, balance, position, risk, reconciliation, and notification schemas are unchanged.
- [ ] Confirm `DRY_RUN` defaults and live-order gates are unchanged.
- [ ] Run `npm.cmd run check` fresh and record the result.
- [ ] Run `git diff --check` and record the result.
