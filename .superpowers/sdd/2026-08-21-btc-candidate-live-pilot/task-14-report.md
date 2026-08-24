# Task 14 Report: Safety Documentation and Read-Only Example

## Status

Completed without activating the BTC candidate pilot. No candidate runtime/readiness implementation file was edited, no operational service or database was accessed, and no network, Upbit, Telegram, secret, `.local.ps1`, scheduler, sync, strategy, order, or LIVE process path was used.

No subagents were dispatched, as required.

## Implementation Commit

- Commit: `abe9df7f50b490ae370d52cf092d1504856c9f0c`
- Subject: `docs: document BTC candidate pilot readiness`
- Push: not performed

The report is committed separately after the implementation commit so this report can contain the implementation commit hash.

## TDD Evidence

### RED

The failing assertions were added first to `tests/windows-task-scripts.test.ts`.

Build command used to emit the focused test:

```powershell
npm.cmd run build
```

The first build attempt was temporarily blocked by unrelated literal-type errors in `tests/position-guard-pilot-lifecycle.test.ts`, outside Task 14 ownership. TypeScript still emitted the focused test artifact. No out-of-scope file was edited.

Focused RED command:

```powershell
node --input-type=module -e "await import('./dist/tests/windows-task-scripts.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected RED outcome: exit code `1`; both new tests failed with `ENOENT` because `scripts/inspect-btc-pilot-readiness.example.ps1` did not exist. Existing Windows-script tests passed.

### GREEN

After creating the minimal example script and documentation, the focused command was rerun. One initial GREEN attempt correctly identified that the validated database parameter was being handed to the CLI through an indirect variable name. The implementation was simplified so the validated mandatory `$DatabasePath` is normalized and passed directly.

Final focused GREEN command:

```powershell
node --input-type=module -e "await import('./dist/tests/windows-task-scripts.test.js'); const { runRegisteredTests } = await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Final outcome: exit code `0`; all `14` Windows-script tests passed, including both new BTC pilot readiness tests.

## Changed Files

- `README.md`: documents candidate availability without activation, exact identity, ETH baseline, phase meanings, persisted authority, uncertainty/fault posture, rollback, and example usage.
- `PRODUCT_BOUNDARY.md`: records the non-activation product boundary and read-only inspection boundary.
- `ARCHITECTURE.md`: records persisted runtime authority, exact replay, account lease, phase behavior, and inspector isolation.
- `RISK_POLICY.md`: records fail-closed phase, pause, recovery, rollback, lease, and no-auto-resume requirements.
- `ORDER_LIFECYCLE.md`: separates pilot phases from order lifecycle and documents uncertainty/recovery/rollback behavior.
- `scripts/inspect-btc-pilot-readiness.example.ps1`: adds a direct, parameterized, read-only readiness example requiring an existing DB path, account ID, deployment ID, and freshness threshold.
- `tests/windows-task-scripts.test.ts`: adds TDD assertions for required inputs, exact pilot identity, read-only command routing, and forbidden activation/mutation paths.

## Safety Checks

- Exact identity is present: `BTC_COMBINED_CONSERVATIVE_PILOT_V1`, `KRW-BTC`, `COMBINED_CONSERVATIVE`, `PCS-2026-001.DEPLOYMENT_READINESS_V1`.
- ETH is documented as baseline-only for this pilot.
- All phases are documented: `DISABLED`, `PENDING_FLAT`, `ACTIVE`, `DRAINING`, `PAUSED_FAULT`.
- The example requires and validates an explicit existing database leaf path.
- The example explicitly keeps `ENABLE_LIVE_ORDERS=false`, scheduler disabled, and Telegram transport disabled.
- The example contains no Upbit or Telegram secret assignment.
- The example invokes only `inspect:btc-pilot:readiness`; it does not invoke app start, sync, strategy run, or order paths.
- The example does not create, copy, edit, or remove a `.local.ps1` file.
- PowerShell parser check: `PowerShell parse PASS`.
- `git diff --check` over all Task 14-owned deliverables: exit code `0`.
- `npm.cmd run typecheck`: final exit code `0` after the unrelated concurrent errors were resolved by their owning workstream.
- `npm.cmd run build`: final exit code `0`.
- Focused Windows-script tests: `14/14` passed.

## Concerns

- The example was intentionally not executed against any SQLite database. Verification was limited to source-contract tests and PowerShell parsing to honor the prohibition on operational database access.
- Other workstreams left unrelated Telegram source/test modifications in the shared worktree. They were not staged, edited, or included in the Task 14 implementation commit.
