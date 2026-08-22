# Task 9C2d2 Report

## Scope

- Base: `3fcfb3a153dc0473281735681eebfcefea2881a8`
- Worktree: `C:\Users\D-\Documents\Codex_Project\AutoTrade_Upbit\.worktrees\btc-candidate-live-pilot`
- No operational database, Upbit, Telegram, runtime, scheduler tick, sync command, order execution, network, secrets, push, merge, or activation/default setting was used or changed. No scripts were added or modified.

## TDD Evidence

### RED

1. After adding the focused tests, the focused harness failed because `scheduler-preflight.ts` did not export `evaluateLiveStrategyRunPreflight`:

```text
SyntaxError: The requested module '../src/app/scheduler-preflight.js' does not provide an export named 'evaluateLiveStrategyRunPreflight'
```

2. After implementing the first preparation path and adding the WARN regression test, the focused candidate test failed as expected:

```text
Error: Candidate BTC reconciliation run must be a successful exact record.
```

This established that non-blocking `DRIFT_DETECTED` evidence needed to remain eligible for `READY`.

### GREEN

Focused command:

```powershell
npx.cmd tsx -e "(async () => { await import('./tests/portfolio-sync-service.test.ts'); await import('./tests/scheduler-preflight.test.ts'); await import('./tests/candidate-btc-run-preparation.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"
```

Result: all 18 focused tests passed, including explicit requested-time preservation, accessor rejection before dependency reads, exact-record preflight evaluation, candidate refresh ordering, PASS/WARN `READY`, deterministic `BLOCKED`, and exact-evidence mismatch failure.

### Fix Round 1 RED/GREEN

The review regressions were added before their implementation changes. The initial focused scheduler/candidate run failed with all four expected authority gaps:

```text
'WARN' !== 'BLOCK'
Missing expected rejection.
Missing expected rejection.
Missing expected rejection.
```

The first failure was malformed `DRIFT_DETECTED` issue evidence failing open to `WARN`; the three rejection failures covered cast execution-state authority, reversed reconciliation chronology, and unsafe/conflicting returned reconciliation summaries.

After the fixes, the focused command above passed all 23 tests. Added adversarial coverage proves that malformed state enums/nullables and `undefined`/string/number kill switches reject before preflight; malformed issue evidence blocks; reversed chronology rejects and future completion blocks; descriptor-unsafe, mismatched, or reordered issue-code/material summary authority rejects; and request/config/dependency/sync-result mutation across awaits cannot replace the exact returned records or trigger latest-row reads.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test
git diff --check
rg -n "\.createOrder\(" src
rg -n "POSITION_GUARD_PILOT_(ID|CONFIRMATION)|BTC_COMBINED_CONSERVATIVE_PILOT_V1" .env.example scripts src
```

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.

## Fix Round 3 TDD Evidence

### RED

`npx.cmd tsx -e "(async () => { await import('./tests/scheduler-preflight.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"` exited 1 because a `SUCCESS` run whose persisted summary claimed `DRIFT_DETECTED` still returned `PASS`.

### GREEN

The same focused scheduler suite passed 13 tests after requiring complete persisted summary identity, exact issue evidence, non-empty DRIFT, and parsed epoch chronology. `npm.cmd run typecheck` and `npm.cmd run build` passed.

## Fix Round 4 TDD Evidence

### RED

The focused scheduler suite failed when `completedAt` was one nanosecond after `checkedAt`: it blocked only through freshness and reported `timestamp is not comparable to preflight time`, rather than explicit chronology rejection.

### GREEN

The same 13-test scheduler suite passed after adding the `completedAtEpoch > checkedAtEpoch` chronology guard. `npm.cmd run typecheck` and `npm.cmd run build` passed.

## Fix Round 5 TDD Evidence

### RED/GREEN

Focused scheduler and candidate tests initially accepted matching malformed `historyRecovery: {}` evidence. They now pass after shared strict history-recovery validation. `npm.cmd run typecheck` and `npm.cmd run build` passed.
- `npm.cmd run test`: the Task 9C2d2 focused coverage passed, but the complete suite has one reproducible pre-existing, unowned failure. `prospective-shadow-commitment-cli.test` invokes `scripts/check-prospective-commitment-bundle.mjs`; esbuild cannot resolve the existing `src/research/prospective-shadow-commitment.ts` in this worktree because its parent-directory read is denied. Running that checked-in bundle verifier directly produces the same error. This task does not own the prospective-shadow source, bundle script, or test.
- `git diff --check`: passed.
- `.createOrder(` remains present only in `src/modules/execution/execution-service.ts`.
- Candidate activation/configuration matches are pre-existing approved declarations; this task added no activation values, default changes, scripts, controller changes, scheduler changes, or runtime wiring.

## Files

- Created `src/app/candidate-btc-run-preparation.ts` and its focused test.
- Added `PortfolioSyncService.run({ requestedAt? })` with descriptor-safe input validation and pre-await dependency snapshots.
- Added the exported pure exact-evidence LIVE preflight evaluator while preserving existing scheduler/manual builders.
- Registered the focused test in `tests/run-all.ts`.
- Fix round 1 strictly validates execution-state authority, uses timestamp epochs for reconciliation chronology and freshness, blocks malformed `DRIFT_DETECTED` issue evidence, and snapshots/canonically correlates returned reconciliation summaries with persisted `summaryJson` evidence.

## Fix Round 2 TDD Evidence

### RED

Focused command:

```powershell
npx.cmd tsx -e "(async () => { await import('./tests/portfolio-sync-service.test.ts'); await import('./tests/scheduler-preflight.test.ts'); await import('./tests/candidate-btc-run-preparation.test.ts'); const { runRegisteredTests } = await import('./tests/harness.ts'); await runRegisteredTests(); })()"
```

Result: exit code 1 with five expected failures. Invalid `source` reached `runWithRecord`; malformed `SUCCESS` evidence returned `PASS`; contradictory `RUNNING` state returned `PASS`; candidate preparation did not reject that contradiction before active-order reads; and hostile active-order arrays did not consistently reject without invocation.

### GREEN

The same focused command passed all 29 tests after implementation. `SUCCESS` now requires parseable empty exact issue evidence; `DRIFT_DETECTED` requires a dense exact known `{ code, message }` sequence; contradictory `RUNNING` pause/degraded metadata blocks or rejects before runner authority; active orders are copied only from dense own data arrays without `slice`; and portfolio source is exact-validated before dependency reads while a valid source remains detached across awaits.

Round 2 verification:

```powershell
npm.cmd run typecheck
npm.cmd run build
git diff --cached --check
```

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
