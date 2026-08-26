# Final Fix Report: Runtime Single Ownership

## Status

DONE_WITH_CONCERNS

Every binding Critical/Important and related Minor finding in `final-fix-brief.md` was implemented in one strict-TDD fix wave on `codex/runtime-single-ownership` from base `0a8b1741b018e217f12f7c7745925d9f90d61b48`.

- Required commit subject: `fix: close runtime ownership safety gaps`
- The report is included in that same consolidated commit; the resulting hash is reported in the task response.
- No subagents were used because the task explicitly prohibited them.

## Findings Closed

### 1. Canonical Local Database Scope

- Added one fail-closed local database path canonicalizer for runtime verification and SQLite opens.
- UNC/network paths, Windows device namespaces, Windows short-name forms, symlink/junction/reparse aliases, non-regular targets, and hardlink ambiguity are rejected rather than normalized into a potentially competing scope.
- Existing paths are resolved through `realpathSync.native()` and checked component-by-component. Missing DRY_RUN targets are accepted only beneath a verified canonical existing ancestor and are rechecked after SQLite creates the file.
- Mutable and read-only SQLite opens reassert the accepted canonical path after open. The strict readiness inspection retains its narrow direct read-only open while applying the same canonicalizer before and after open.
- LIVE identity verification and DRY_RUN resolution now pass the same accepted canonical database path into lock derivation, ownership persistence, and application persistence. Runtime lock identity is mode invariant for the same canonical database/account scope.
- Added regressions for UNC and device forms, directory and filename short-name forms, junction/reparse aliases, both names of a hardlinked file, missing DRY_RUN targets, lock-scope mismatch cleanup, and real Windows DRY_RUN/LIVE child-process contention.

### 2. Post-Adapter Ownership Authority

- `createOrder` remains a synchronous invocation inside the final persisted execution-authority callback.
- After the adapter promise fulfills, ownership is reasserted before any submission persistence or state finalization.
- After the adapter promise rejects, ownership is reasserted before rejection persistence, pause, notification, or lease release.
- A typed ownership loss or an ordinary ownership-store read failure is rethrown unchanged, leaves the order `SUBMITTING`, preserves the account lease, and performs no stale finalization, pause, or notification.
- Added deferred fulfillment and rejection generation-replacement regressions plus generic post-adapter ownership-read failure coverage.

### 3. Durable Exact-Generation LOST Evidence

- Production ownership context now queues best-effort `recordLost()` for process-lock loss, persisted-owner mismatch, ownership expiry, heartbeat expiry, heartbeat renewal mismatch, and non-transient heartbeat renewal failure.
- Loss recording is awaited before ownership-database closure during runtime shutdown, scoped cleanup, and startup-failure cleanup.
- `recordLost()` remains exact-owner/exact-generation scoped and cannot alter or annotate a superseding owner.
- `RUNTIME_SHUTDOWN`, `SCOPED_WORK_COMPLETE`, and `STARTUP_FAILED` are not recorded as LOST. Normal shutdown retains `RELEASED` evidence.
- Added persisted event-history regressions for expiry, process-lock loss, supersession, and normal shutdown.

### 4. Notification Delivery Quiescence

- Notification delivery now has an idempotent stop fence and bounded `stopAndWait()` status.
- Stop clears queued reruns, rejects direct post-stop delivery, and waits for all already in-flight delivery promises to settle without inventing cancellation.
- Owned runtime shutdown fences first, stops delivery/inbound/scheduler entry, and uses one bounded `Promise.allSettled()` barrier for delivery, inbound, scheduler, and heartbeat settlement.
- SQLite closure and process-lock release occur only after settlement or recorded timeout failure. Failed or timed-out quiescence skips clean persisted ownership release, while the process lock remains the last released resource.
- Scoped writable compositions use the same delivery/inbound/scheduler fence and bounded settlement ordering before their application database closes.
- Added settlement, worker-rejection, timeout, no-rerun, and scoped-cleanup ordering regressions.

### 5. Persisted Scope Binding

- Edited undeployed migration `0024_add_runtime_ownership.sql` directly; no migration was executed.
- Added validated lowercase SHA-256 `scope_key` columns to current ownership and append-only audit events.
- Current ownership primary key, event indexes, and acquisition-generation uniqueness are scope bound.
- SQLite ownership reads, authority reads, acquisition, renewal, release, LOST recording, maximum-generation allocation, and recent-event listing all require the store's canonical database/account scope digest.
- In-memory and SQLite store constructors require the same validated scope key.
- Added two-scope isolation and physical-row/event binding regressions.

### 6. Telegram Setup Transmissions

- Both Korean and English `setMyCommands` transmissions assert local ownership immediately before and after the external call.
- Ordinary Telegram setup failures retain the existing setup result contract only after post-rejection ownership reassertion.
- Exact ownership exceptions after fulfillment or rejection escape unchanged instead of being converted to ordinary setup failure.
- Added exact assertion-order and fulfillment/rejection ownership-loss regressions.

### 7. Deterministic Windows Child Cleanup

- Process children are not considered terminated until their `exit` event has settled.
- Ownership worker helpers retain success/failure and resolve or reject only after worker exit, after the worker's `finally` closes SQLite.
- Temporary fixture directories are removed only after child/worker exit and database closure.
- Added failed-worker cleanup coverage while preserving fixture-owned signal targeting.

## Strict TDD Evidence

### RED

- Canonical path tests first demonstrated acceptance or divergent handling of unsafe aliases and mode-specific database scope.
- Scope-store tests first failed against schema and repository operations that had no persisted `scope_key`.
- Deferred adapter tests first demonstrated stale fulfillment/rejection finalization after generation replacement.
- Event-history tests first demonstrated that production loss paths appended no LOST evidence.
- Delivery/lifecycle tests first demonstrated database and lock cleanup could pass an unsettled delivery worker; a later regression also exposed early `Promise.all()` rejection racing deferred delivery settlement.
- Telegram setup tests first demonstrated missing pre/post authority checks and converted ownership failures.
- Worker cleanup tests first demonstrated parent cleanup could precede worker exit/database closure.
- The first expanded full-harness run exposed stale test fixtures for the stricter dependency boundary, schema, authority check count, and delivery stoppable contract. Production remained fail closed; only the affected fixtures and the strict read-only inspection boundary were corrected.

### GREEN

- Canonical path, scope store, startup gate, process lock, execution authority, Telegram delivery/setup, runtime lifecycle, and scoped ownership focused suites all pass.
- Task 8 integration passes 9/9, including Windows crash takeover, cross-mode contention, generation replacement, heartbeat expiry, synchronous final authority, no production cancellation caller, and deterministic temporary cleanup.
- The complete shared custom harness passes after fixture reconciliation.

## Verification

- `npm.cmd run build`: exit 0.
- Consolidated focused custom-harness run covering `live-database-identity`, `runtime-ownership-store-contract`, `runtime-startup-gate`, `runtime-process-lock`, `execution-send-authority`, `telegram-delivery`, `runtime-lifecycle`, and `scoped-runtime-ownership`: all registered tests passed.
- Exact Task 8 import/harness command for `runtime-single-ownership-integration.test.js`: exit 0, 9/9 passed.
- `npm.cmd run typecheck`: exit 0 after the final production and fixture changes.
- `npm.cmd test`: build and the complete shared custom harness passed; the command exited 1 only in the separately spawned prospective-shadow suite.
- Isolated `node --test dist/tests/prospective-shadow-commitment-cli.test.js` outside the filesystem sandbox: 10 passed, 1 failed. Exact failing test: `checked-in workflow validator bundle is byte-for-byte reproducible from TypeScript source`.
- Exact isolated cause: `.github/scripts/prospective-shadow-commitment.mjs` does not match `src/research/prospective-shadow-commitment.ts`.
- `git diff --check`: exit 0 with only Windows LF-to-CRLF notices.
- `git diff -- .github/scripts/prospective-shadow-commitment.mjs src/research/prospective-shadow-commitment.ts`: empty.

## Documentation

The mandatory root documents were updated for the changed contracts:

- `PRODUCT_BOUNDARY.md`: canonical local database and single accepted lock/open scope boundary.
- `ARCHITECTURE.md`: scope-bound ownership persistence, post-adapter assertion, durable loss evidence, and shutdown barrier ordering.
- `RISK_POLICY.md`: fail-closed alias handling, stale adapter-result handling, and timeout behavior.
- `ORDER_LIFECYCLE.md`: synchronous pre-send callback plus post-settlement ownership reassertion and stale `SUBMITTING` recovery boundary.
- `README.md`: operator/deployment guidance for canonical local storage, offline migration 0024, LOST versus RELEASED evidence, and quiescent shutdown.

## Safety Confirmation

- The original checkout, LIVE process, operational database, APIs, secrets, local launchers, and network were not accessed.
- No push, merge, deployment, restart, or runtime migration was performed.
- No cancellation behavior or production cancellation caller was invented.
- All database and process integration work used temporary test-owned fixtures and fixture-owned child processes.
- LIVE order transmission remains explicitly gated and DRY_RUN remains the default.
- The unrelated prospective-shadow source/bundle mismatch was preserved exactly as instructed.

## Concerns

1. Full `npm.cmd test` remains non-zero only because of the preserved pre-existing prospective-shadow checked-in bundle mismatch. The unrelated source and bundle were not modified or rebuilt.
