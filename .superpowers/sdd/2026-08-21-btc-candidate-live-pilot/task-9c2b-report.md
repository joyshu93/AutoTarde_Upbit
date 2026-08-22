# Task 9C2b Report

## RED

- `CandidatePilotRepository.findDeploymentsForRecoveryIdentity` was absent, so the repository contract failed with `TypeError`.
- `PositionGuardPilotRecovery` accepted only a configured deployment ID, so the new target-discriminant recovery tests failed before any recovery verification.

## GREEN

- Added an exact account/pilot/market/policy/version lookup with deterministic ordering and `LIMIT 2` parity for in-memory and SQLite repositories.
- Added explicit `EXACT_DEPLOYMENT` and `CONFIGURED_ACCOUNT_PILOT` recovery targets.
- Configured recovery proceeds only for one exact match, snapshots and freezes the deployment, and pins all later reads and mutations to the resolved deployment ID.
- Missing, ambiguous, foreign, and malformed identity paths pause only global execution state and do not synthesize or mutate pilot authority.
- Global-only fault construction no longer creates a placeholder deployment ID.
- Recovery now uses the canonical domain `PositionGuardPilotRefreshReceipt` whose source is fixed to `SCHEDULER_PREFLIGHT`.

## Verification

- Focused in-memory, SQLite, and recovery tests: PASS.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run build`: PASS.
- `git diff --check`: PASS.

## Safety

No migration, operational database, Upbit, Telegram, network, runtime process, execution script, activation default, push, or merge was accessed or changed.
