# Task 10C Review Fix Report

## Status

Implemented and locally committed as `11394b1` (`fix: close candidate rollback safety races`). No push, operational database, Upbit, Telegram network, secret, LIVE process, scheduler start, sync, or order call was used. No subagents were dispatched.

The latest review instruction narrowly expanded ownership to `src/modules/db/repositories/in-memory-repositories.ts` for the shared synchronous rollback authority capability. All other edits are within the original Task 10C ownership list. Concurrent changes in `tests/position-guard-pilot-lifecycle.test.ts` were not edited or committed.

## Safety Fixes

- Rollback inputs now carry a descriptor-safe exact operator authority snapshot: execution-state id, deployment account, PAUSED/KILL_SWITCHED status, and updatedAt.
- In-memory start/complete rollback no longer await `getState()` before candidate mutation. `InMemoryOperatorStateStore.runWithCandidatePilotRollbackAuthority` validates authority and executes the phase CAS plus audit mutation in one synchronous callback. Its callback type is narrowly restricted to a deployment/null result.
- SQLite start/complete rollback reread `execution_state` and validate the same exact authority inside the existing `BEGIN IMMEDIATE` transaction before phase CAS and audit insertion.
- Recovery samples the established global pause authority, supplies it to rollback persistence, and fails closed if repository authority changes. It never auto-resumes.
- Recovery reporters use the injected existing notification delivery service while preserving deterministic notification createdAt and persistence idempotency.
- Production `createApp` passes bound `getState` and `pause`, injects the existing delivery service, exposes the exact recovery instance as `candidatePilotRecovery`, and returns `null` for baseline.
- Task 12 wiring passes `locale: telegramLocale` to `OperatorNotificationDeliveryService`.
- Task 13 construction coverage blocks/counts every private exchange method, all public market reads, Telegram fetch, timeout, and interval installation; it also verifies scheduler and inbound polling remain stopped.

## RED Evidence

- Repository authority contract: in-memory and SQLite tests initially rejected `expectedOperatorState` as an unknown property because the persistence contract did not support exact operator authority.
- Recovery interleaving: resume after recovery precheck produced `Missing expected rejection`; rollback still proceeded.
- In-memory shared-boundary review: controlled stale PAUSED `getState()` followed by `resume()` returned a DRAINING deployment instead of null, proving repository-local serialization did not share operator mutation authority.
- Delivery injection: recovery construction rejected `notificationDelivery` as an unknown dependency.
- createApp exposure: baseline and candidate recovery assertions observed `undefined` instead of required `null`/instance.
- Task 12 locale: `en-US` push test received Korean text beginning `[오류] BTC 후보 파일럿 장애 일시정지`.
- Task 13 mutation check: a fake-only construction callback invoked `getOrderChance`; the comprehensive counter test failed with actual `getOrderChance: 1` versus expected 0. The mutation was removed before GREEN.

## GREEN Evidence

- In-memory candidate contract passed in full, including exact changed/non-paused authority and the stale-read/resume gap test with zero async state reads and unchanged phase/audit.
- Recovery focused suite passed in full, including precheck/resume fail-closed behavior and idempotent persistence with one delivery kick.
- createApp focused suite passed in full, including baseline null, shared recovery exposure, en-US delivery, zero construction side effects, scheduler not started, and inbound polling not running.
- SQLite candidate persistence suite passed in full, including independent-connection resume rejection, two-connection rollback CAS, transaction rollback on audit failure, and backend contract parity.
- Owned TypeScript graph passed:
  `npx.cmd tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node tests/candidate-pilot-repository-contract.test.ts tests/db-candidate-pilot-persistence.test.ts tests/position-guard-pilot-recovery.test.ts tests/create-app.test.ts`
- Owned diff check passed: `git diff --cached --check` before implementation commit.
- Full `npm.cmd test` compiled successfully and all normal aggregate tests passed. Its final prospective-shadow subprocess reported 101/102 because sandbox directory traversal blocked esbuild; the sole failed read-only command then passed outside the sandbox: `node scripts/check-prospective-commitment-bundle.mjs` confirmed the checked-in bundle matches TypeScript byte-for-byte.

## Changed Files

- `src/app/create-app.ts`
- `src/app/position-guard-pilot-recovery.ts`
- `src/modules/db/pilot-interfaces.ts`
- `src/modules/db/repositories/in-memory-candidate-pilot-repository.ts`
- `src/modules/db/repositories/in-memory-repositories.ts`
- `src/modules/db/repositories/sqlite-candidate-pilot-repository.ts`
- `tests/candidate-pilot-repository-contract.test.ts`
- `tests/create-app.test.ts`
- `tests/db-candidate-pilot-persistence.test.ts`
- `tests/position-guard-pilot-recovery.test.ts`

## Concerns

Concurrent unowned changes remain in `tests/windows-task-scripts.test.ts` and were excluded from both Task 10C commits. The aggregate command's only nonzero result was the sandbox-blocked esbuild reproducibility subprocess, which passed when rerun with the required filesystem access. The only other observed warnings were Node's expected experimental SQLite warning and Git's existing LF-to-CRLF notice.
