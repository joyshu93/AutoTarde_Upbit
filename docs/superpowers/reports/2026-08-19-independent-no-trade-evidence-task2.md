# Independent No-Trade Evidence Task 2 Report

## Scope

Implemented Task 2 of `2026-08-19-independent-no-trade-evidence.md`: deterministic independent no-trade coverage classification and import-graph safety.

## Changed Files

- `src/modules/performance/research-no-trade-evidence.ts`: adds the pure `classifyIndependentNoTradeCoverage()` API and explicit coverage result types.
- `tests/research-no-trade-evidence.test.ts`: adds dense, fully verified sparse, partially verified sparse, no-sidecar, and invalid-sidecar classifier coverage.
- `tests/upbit-research-candle-acquisition.test.ts`: adds a sidecar import-graph regression.
- `README.md`, `ARCHITECTURE.md`, and `PRODUCT_BOUNDARY.md`: document the research-only, non-deployment boundary.
- `docs/superpowers/reports/2026-08-19-independent-no-trade-evidence-task2.md`: this report.

## TDD Evidence

RED command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `1` because `research-no-trade-evidence` did not export `classifyIndependentNoTradeCoverage`, confirming the focused tests failed before production implementation.

GREEN command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `0`; all 23 focused sidecar tests passed.

Import-graph regression:

```powershell
npx.cmd tsx -e "import('./tests/upbit-research-candle-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `0`; all 9 focused acquisition/import-boundary tests passed. The source-level regression verified that the sidecar's declared literal relative graph did not reach app, execution, exchange, reconciliation, Telegram, runtime, db, research, or `upbit-research-candle-acquisition`, and that no `src` module declared an import of the sidecar. It did not establish the absence of arbitrary runtime-generated module loading.

Final verification:

```powershell
npm.cmd run typecheck
npm.cmd run check
git diff --check
```

Results: `typecheck` and the full `check` both exited `0`. `git diff --check` found no whitespace errors; it emitted only pre-existing LF-to-CRLF warnings for tracked worktree files.

## Review Fix TDD Evidence

The review found that the first classifier anchored nominal hours to arbitrary parent boundaries, rounded partial verified evidence to full hours, and used a regex-only import graph reader.

Classifier RED command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `1` with three expected failures: mixed-offset nanosecond partial boundaries produced a shifted sparse grid, an off-grid extra candle was accepted, and adjacent/fragmented verified ranges left a whole-hour rather than exact sub-hour uncovered result.

Classifier GREEN command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `0`; all 26 focused sidecar tests passed after the classifier derived absolute UTC intervals fully contained in the parent range, rejected off-grid observed intervals, and subtracted verified evidence exactly.

Import-safety RED/GREEN commands:

```powershell
npx.cmd tsx -e "import('./tests/upbit-research-candle-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

RED result: exited `1` because the new AST module-specifier collector was absent. GREEN result: exited `0`; all 9 focused acquisition/import-boundary tests passed. The AST fixture covers static imports, side-effect imports, export-from declarations, dynamic `import()`, and `require()` calls, including non-literal dynamic/require arguments that fail the allowlist.

Review-fix final verification:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npx.cmd tsx -e "import('./tests/upbit-research-candle-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npm.cmd run typecheck
git diff --check
```

Results: the sidecar suite exited `0` with 26 passes, the acquisition/import suite exited `0` with 9 passes, and `typecheck` exited `0`. `git diff --check` found no whitespace errors and emitted only existing LF-to-CRLF warnings for tracked worktree files.

The final review requested one additional coverage-only regression for non-empty exact nanosecond gaps. The added mixed-offset parent-boundary test verifies that `uncoveredRanges` preserves both a one-nanosecond leading gap and a nanosecond-qualified trailing boundary. Production code did not require a change. The focused suite then exited `0` with 27 passes, and `npm.cmd run typecheck` exited `0`.

## Safety Boundary

- Classification uses exact epoch comparisons and complete nominal `[from,to)` 1h intervals.
- Dense data needs no sidecar; sparse data remains `UNVERIFIED_SPARSE` without one.
- A supplied sidecar is parsed and validated against the parent dataset before classification. Validation errors throw explicitly; they do not downgrade coverage.
- The classifier only reports ranges. It neither creates/interpolates candles nor accesses APIs, Telegram, runtime, SQLite, migrations, operational databases, orders, or deployment paths.

## Collaboration

Task 2 was implemented by the Noether subagent and reviewed by the Feynman subagent. The main agent integrated the final coverage-only regression and commissioned a fresh final independent review after the Codex update interrupted the earlier agent sessions.

## Completion Note

No commit or push was made. Task 3 verification and independent review remain separate work.
