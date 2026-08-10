# Performance Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic read-only PnL calculator and explicit SQLite CLI report without adding Telegram behavior.

**Architecture:** Keep FIFO accounting pure and independent of persistence. A read-only SQLite adapter normalizes persisted rows and snapshot provenance; a thin CLI validates explicit arguments and formats the result.

**Tech Stack:** TypeScript strict mode, Node.js `node:sqlite`, existing test harness.

## Global Constraints

- Upbit only; `KRW-BTC` and `KRW-ETH` spot only.
- The CLI must not call exchange, Telegram, reconciliation, strategy, scheduler, or execution paths.
- SQLite must be opened with `readOnly: true`.
- Database path, exchange account, execution mode, and order origin must be explicit CLI arguments.
- Missing costs or fees remain explicit warnings; they are never silently inferred.
- Report periods use `[from, to)` semantics.
- Unknown or duplicate CLI arguments are rejected; `--json` is a valueless flag.
- No Telegram command is added.

---

### Task 1: Pure FIFO performance calculator

**Files:**
- Create: `src/modules/performance/performance-calculator.ts`
- Create: `tests/performance-calculator.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `calculatePerformance(input: PerformanceCalculationInput): PerformanceCalculationResult`
- Consumes normalized fills, opening positions, and mark prices only.

- [ ] Write failing tests for round trips, fees, FIFO partial sells, opening inventory, open marks, and unmatched sells.
- [ ] Run the focused test through the compiled test harness and verify the missing module/function failure.
- [ ] Implement the minimal pure calculator with explicit finite-positive numeric validation.
- [ ] Run focused and full tests.

### Task 2: Read-only SQLite adapter and CLI report

**Files:**
- Create: `src/modules/performance/sqlite-performance-reader.ts`
- Create: `src/research/performance-report.ts`
- Create: `tests/performance-report.test.ts`
- Modify: `tests/run-all.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `calculatePerformance` and its exported input/result types.
- Produces: `readPerformanceInput`, `buildPerformanceReport`, `formatPerformanceReport`, and the `report:performance` npm script.

- [ ] Write failing tests for explicit CLI arguments, persisted filters, opening/latest snapshot provenance, stable text/JSON output, and read-only database access.
- [ ] Run focused tests and verify the expected missing implementation failure.
- [ ] Implement the SQLite reader, argument parser, report builder, and formatter without importing runtime side-effect modules.
- [ ] Document exact usage and the read-only boundary.
- [ ] Run focused tests, typecheck, full tests, and a read-only report against a copied fixture database.
