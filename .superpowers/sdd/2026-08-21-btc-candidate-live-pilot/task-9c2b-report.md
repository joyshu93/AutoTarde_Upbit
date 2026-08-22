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

## Independent Review Fix

- The independent review found that `PositionGuardPilotRecovery` retained the caller-owned dependency object, allowing account, target, policy, and numeric verification settings to change across an `await` boundary.
- RED reproduced an `account-A` deployment lookup followed by a mutated `account-B` global pause attempt, and showed that accessor and non-canonical constructor shapes were accepted.
- The constructor now descriptor-safely projects an exact top-level dependency shape and an exact target discriminant before any asynchronous work.
- Scalar identity, target, and numeric verification policies are copied into a shallow frozen authority snapshot. Collaborator references are read once into that snapshot, but the collaborator objects themselves are not frozen or mutated.
- Fault provenance schema version 3 records the snapshotted verification policy as well as the configured identity, so deterministic fault identity cannot silently depend on later caller mutation.
- Adversarial tests mutate every scalar policy and collaborator reference during the first awaited lookup and confirm that reads, provenance, pilot pause, and global pause remain pinned to the initial authority.
- Accessor, extra, symbol, non-enumerable, non-plain, and malformed top-level or target inputs are rejected without invoking accessors.

## Verification

- Focused in-memory, SQLite, and recovery tests: PASS.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run build`: PASS.
- `git diff --check`: PASS.

## Safety

No migration, operational database, Upbit, Telegram, network, runtime process, execution script, activation default, push, or merge was accessed or changed.
