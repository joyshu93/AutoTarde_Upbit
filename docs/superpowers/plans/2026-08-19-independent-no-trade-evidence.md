# Independent No-Trade Evidence Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, immutable, independently validated no-trade evidence sidecar without collecting data or changing live behavior.

**Architecture:** Keep candle dataset schema v1 unchanged and introduce a separate sidecar parser, canonical checksum, parent-dataset validator, and coverage classifier. The module remains outside runtime, exchange, Telegram, SQLite, and network graphs.

**Tech Stack:** TypeScript strict mode, Node crypto, existing exact timestamp utilities, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-19-independent-no-trade-evidence-design.md`

## Global Constraints

- No Upbit or Telegram API calls, runtime startup, sync, scheduler tick, order mutation, migration, or operational DB access.
- Do not modify candle dataset schema version 1 or any strategy decision rule.
- All production behavior starts with a focused failing test.
- Do not commit or push unless the user separately requests it.

---

### Task 1: Sidecar Schema, Checksum, And Dataset Validation

**Files:**
- Create: `src/modules/performance/research-no-trade-evidence.ts`
- Create: `tests/research-no-trade-evidence.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces `ResearchNoTradeEvidence`, `parseResearchNoTradeEvidence()`,
  `computeResearchNoTradeEvidenceSha256()`, and
  `validateResearchNoTradeEvidenceForDataset()`.
- Consumes the existing `ResearchCandleDataset` and exact timestamp utilities.

- [ ] Add failing tests for a valid sidecar and stable canonical checksum.
- [ ] Confirm focused RED because the module is absent.
- [ ] Add failing tests for checksum mutation, malformed timestamps, identity mismatch,
  incomplete pagination, partial coverage, overlaps, and observed-candle collision.
- [ ] Implement the minimal strict parser, canonical hash, and parent validator.
- [ ] Run focused tests through GREEN.

### Task 2: Coverage Classification And Import Safety

**Files:**
- Modify: `src/modules/performance/research-no-trade-evidence.ts`
- Modify: `tests/research-no-trade-evidence.test.ts`
- Modify: the existing research import-boundary test selected during implementation
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`

**Interfaces:**
- Produces `classifyIndependentNoTradeCoverage()` with `DENSE`, `VERIFIED_SPARSE`,
  or `UNVERIFIED_SPARSE` and exact uncovered ranges.

- [ ] Add failing dense, fully verified sparse, and partially verified sparse tests.
- [ ] Confirm focused RED for the missing classifier.
- [ ] Implement deterministic exact-range coverage classification.
- [ ] Add an import-graph regression proving runtime/network modules are unreachable.
- [ ] Document the sidecar as research-only and non-deploying.
- [ ] Run focused tests through GREEN.

### Task 3: Independent Review And Verification

**Files:** No intended production changes unless review finds a defect.

- [ ] Run independent specification and code-quality review.
- [ ] Fix accepted findings with a failing regression test first.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run check`.
- [ ] Run `git diff --check`.
- [ ] Confirm operational DB metadata and AutoTrade process state were not changed.
