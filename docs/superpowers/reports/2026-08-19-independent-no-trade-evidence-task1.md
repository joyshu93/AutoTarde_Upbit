# Independent No-Trade Evidence Task 1 Report

## Scope

Implemented Task 1 of `2026-08-19-independent-no-trade-evidence.md`: the pure sidecar schema, canonical checksum, and parent-dataset validation boundary.

## Changed Files

- `src/modules/performance/research-no-trade-evidence.ts` (new): strict immutable sidecar parser, canonical SHA-256 calculator, and parent-dataset validator.
- `tests/research-no-trade-evidence.test.ts` (new): valid artifact, checksum, malformed timestamp, identity, pagination, coverage, overlap, and observed-candle collision tests.
- `tests/run-all.ts`: registers the focused sidecar test.
- `docs/superpowers/reports/2026-08-19-independent-no-trade-evidence-task1.md` (new): this report.

## TDD Evidence

RED command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `1` with `ERR_MODULE_NOT_FOUND` for `src/modules/performance/research-no-trade-evidence.js`, confirming the focused test failed because the production module was absent.

GREEN command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `0`; all 9 focused sidecar tests passed.

Additional verification:

```powershell
npm.cmd run typecheck
node dist/tests/run-all.js
git diff --check
```

Results: all commands exited `0`. The full runner includes the registered sidecar tests. `git diff --check` emitted only pre-existing line-ending warnings for unrelated modified files.

## Safety Boundary

- The module imports only Node `crypto`, the runtime candle-dataset parser/type helper, and exact performance timestamp helpers; it has no domain import.
- It does not call or import Upbit, Telegram, runtime startup, execution, reconciliation, SQLite, migrations, operational DB, or network acquisition paths.
- It neither modifies candle schema v1 nor strategy behavior. The sidecar is parsed and validated in memory only.
- No commit or push was made. Existing user changes outside the four allowed Task 1 files were left untouched.

## Collaboration

Task 1 was implemented by the Turing subagent in the files listed above and independently reviewed by the Pasteur subagent. The main agent integrated the review fixes and retained responsibility for the final safety and contract checks.

## Review Fix Evidence

### Findings Fixed

- Parent datasets are now re-parsed with `parseResearchCandleDataset()` before identity checks, so their canonical checksum is recomputed and validated before any declared hash is trusted.
- Observed-candle conflict detection now compares half-open intervals: observed candle `[openTime,closeTime)` against verified no-trade `[from,to)`. Exact boundary contact does not collide.
- The sidecar module no longer imports `../../domain/types.js` at runtime. BTC/ETH and KRW market pairing is explicit and local to the research-only contract.
- Regression coverage now includes real canonical parent signing, a fixed sidecar digest, parent checksum forgery and mutated bytes, asset/market/range mismatches, query overlap, mixed-offset exact ordering, and interval edge semantics.

### TDD Regression Cycle

RED command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `1` with five expected regression failures. They demonstrated that mutated parent candle data was accepted, invalid parent checksums reached only hash identity comparison, a fully overlapping candle was accepted, and exact before/after boundary candles were falsely rejected. The initial market mismatch fixture was corrected before implementation because it attempted to re-sign an intentionally invalid artifact and therefore failed during test setup rather than at the asserted parser boundary.

GREEN command:

```powershell
npx.cmd tsx -e "import('./tests/research-no-trade-evidence.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Result: exited `0`; all 18 focused sidecar tests passed.

Additional verification:

```powershell
npm.cmd run typecheck
rg -n "../../domain/types|parseResearchCandleDataset|overlaps" src/modules/performance/research-no-trade-evidence.ts
```

Results: both commands exited `0`. The import check reported only parent-dataset parsing and interval-overlap references; it reported no domain runtime import.
