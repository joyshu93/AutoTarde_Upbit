# Runtime Single-Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that one canonical SQLite database and exchange account have at most one mutating `LIVE` or `DRY_RUN` runtime, with operating-system exclusion, persisted generation fencing, heartbeat failure shutdown, and final order-send authority checks.

**Architecture:** A Windows named-pipe listener provides same-host process-lifetime exclusion. A separate SQLite ownership connection stores the current owner, generation, heartbeat, and append-only audit evidence. A runtime guard combines both layers and is checked at startup, worker boundaries, and immediately before exchange order or cancellation transmission; the existing per-order account lease remains unchanged.

**Tech Stack:** TypeScript 5.8 strict mode, Node.js 22 `node:net`, `node:crypto`, and experimental `node:sqlite`, SQLite migrations, custom TypeScript test harness.

**Spec:** `docs/superpowers/specs/2026-08-26-runtime-single-ownership-design.md`

## Global Constraints

- Execute implementation in an isolated Git worktree created through `superpowers:using-git-worktrees`; do not build into the checkout used by the currently running LIVE process.
- Do not start, stop, restart, signal, inspect, or otherwise alter the current LIVE process during implementation.
- Do not open or migrate the operational LIVE SQLite database; every database test uses a temporary fixture.
- Do not call Upbit or Telegram APIs, load local secret files, or modify ignored `*.local.ps1` launchers.
- Keep `DRY_RUN` as the default execution mode and keep live order transmission behind its existing explicit gates.
- Apply runtime ownership to mutating `LIVE` and `DRY_RUN` long-running runtimes; exclude read-only reports, inspections, and smoke commands.
- Use a 10,000 ms heartbeat interval, 45,000 ms ownership TTL, and 30,000 ms bounded shutdown wait exactly as specified.
- Do not reuse or broaden `account_execution_leases`; it remains an order-submission lease with purpose `ORDER_SUBMISSION`.
- Do not add a native dependency, shell helper, PID file, lock file, or distributed-lock assumption.
- Do not push or deploy during implementation. Deployment migration and runtime restart require a later explicit operator request.

---

### Task 1: Operating-System Process Lock And Scope Identity

**Files:**
- Create: `src/app/runtime-process-lock.ts`
- Create: `tests/runtime-process-lock.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `deriveRuntimeLockIdentity(input: RuntimeLockIdentityInput): RuntimeLockIdentity`
- Produces: `acquireRuntimeProcessLock(identity: RuntimeLockIdentity): Promise<RuntimeProcessLock>`
- Produces: `RuntimeProcessLock.isHeld(): boolean`, `RuntimeProcessLock.release(): Promise<void>`, and `RuntimeProcessLock.onLost(listener): () => void`
- Consumes: canonical absolute database path, optional verified database instance ID, and exchange account ID

- [ ] **Step 1: Write scope and process-lock failure tests**

Add tests that require deterministic domain-separated identity, no raw path/account disclosure, one successful owner, `RUNTIME_ALREADY_OWNED` for a contender, idempotent release, and permanent lost state after unexpected listener closure.

```ts
const identity = deriveRuntimeLockIdentity({
  canonicalDatabasePath: "C:\\runtime\\company-live.sqlite",
  databaseInstanceId: "11111111-1111-4111-8111-111111111111",
  exchangeAccountId: "primary",
});
assert.match(identity.scopeDigest, /^[a-f0-9]{64}$/u);
assert.equal(JSON.stringify(identity).includes("company-live.sqlite"), false);

const owner = await acquireRuntimeProcessLock(identity);
await assert.rejects(
  () => acquireRuntimeProcessLock(identity),
  (error: unknown) => error instanceof RuntimeProcessLockError &&
    error.code === "RUNTIME_ALREADY_OWNED",
);
await owner.release();
```

The real named-pipe contention test runs only on `win32`; deterministic fake-listener tests cover all platforms. A non-Windows production acquisition must fail closed with `UNSUPPORTED_RUNTIME_LOCK_PLATFORM`.

- [ ] **Step 2: Register and run the failing tests**

Add `await import("./runtime-process-lock.test.js");` before runtime lifecycle imports in `tests/run-all.ts`.

Run:

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/runtime-process-lock.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL because `runtime-process-lock.ts` does not exist.

- [ ] **Step 3: Implement identity derivation and named-pipe ownership**

Implement these public shapes:

```ts
export interface RuntimeLockIdentityInput {
  readonly canonicalDatabasePath: string;
  readonly databaseInstanceId: string | null;
  readonly exchangeAccountId: string;
}

export interface RuntimeLockIdentity {
  readonly scopeDigest: string;
}

export interface RuntimeProcessLock {
  readonly identity: RuntimeLockIdentity;
  isHeld(): boolean;
  onLost(listener: (reason: RuntimeProcessLockLossReason) => void): () => void;
  release(): Promise<void>;
}
```

Derive the digest from canonical JSON containing a fixed domain string, `canonicalDatabasePath.toUpperCase()`, `databaseInstanceId`, and `exchangeAccountId`. The canonical path is always part of the scope; the verified instance ID strengthens LIVE identity but never replaces path identity. Bind `\\\\.\\pipe\\autotrade-upbit-runtime-${scopeDigest}` with `node:net.createServer()`. Do not accept connections; destroy any unexpected socket. Map `EADDRINUSE` to `RUNTIME_ALREADY_OWNED` and every other bind failure to `RUNTIME_LOCK_ACQUIRE_FAILED`.

- [ ] **Step 4: Run focused tests and typecheck**

Run the focused command from Step 2, then:

```powershell
npm.cmd run typecheck
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the process-lock unit**

```powershell
git add src/app/runtime-process-lock.ts tests/runtime-process-lock.test.ts tests/run-all.ts
git commit -m "feat: add runtime process lock"
```

---

### Task 2: Runtime Ownership Migration And Store Contract

**Files:**
- Create: `migrations/0024_add_runtime_ownership.sql`
- Create: `src/domain/runtime-ownership.ts`
- Create: `src/modules/db/runtime-ownership-interfaces.ts`
- Create: `src/modules/db/repositories/in-memory-runtime-ownership-store.ts`
- Create: `src/modules/db/repositories/sqlite-runtime-ownership-store.ts`
- Create: `tests/runtime-ownership-store-contract.test.ts`
- Modify: `tests/db-sqlite-wiring.test.ts`
- Modify: `tests/live-database-identity.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Produces: `RuntimeOwnershipStore`
- Produces: `RuntimeOwnershipRecord`, `RuntimeOwnershipEventRecord`, and exact acquire/renew/release input/output types
- Consumes: `withImmediateTransaction` and `DatabaseSync`

- [ ] **Step 1: Write the common ownership-store contract first**

The common contract must verify:

```ts
const first = await store.acquireAfterProcessLock({
  ownerToken: "a".repeat(64),
  executionMode: "LIVE",
  acquiredAtEpochMs: 1_000,
  expiresAtEpochMs: 46_000,
});
assert.equal(first.record.generation, 1);
assert.equal(first.takeover, false);

const renewed = await store.renew({
  ownerToken: first.record.ownerToken,
  generation: 1,
  heartbeatAtEpochMs: 11_000,
  expiresAtEpochMs: 56_000,
});
assert.equal(renewed?.heartbeatAtEpochMs, 11_000);

const takeover = await store.acquireAfterProcessLock({
  ownerToken: "b".repeat(64),
  executionMode: "LIVE",
  acquiredAtEpochMs: 12_000,
  expiresAtEpochMs: 57_000,
});
assert.equal(takeover.record.generation, 2);
assert.equal(takeover.takeover, true);
assert.equal(await store.release({ ownerToken: "a".repeat(64), generation: 1, releasedAtEpochMs: 13_000 }), false);
```

Also reject malformed tokens, unsafe integers, non-increasing expiry, stale renewals, stale releases, timestamp rollback, invalid stored rows, and generation overflow.

- [ ] **Step 2: Write migration and SQLite race tests**

Require both tables, constraints, indexes, append-only event triggers, migration-ledger entry, foreign-key integrity, and two independent SQLite connections racing for generation ownership. Require migration failure and ledger insertion to roll back atomically using the repository's existing injected-ledger-failure pattern.

Update LIVE identity tests so a database missing `0024_add_runtime_ownership.sql` fails read-only identity verification and a fully provisioned fixture passes.

- [ ] **Step 3: Run tests and verify the expected failure**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/runtime-ownership-store-contract.test.js'); await import('./dist/tests/db-sqlite-wiring.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL for missing migration, types, and stores.

- [ ] **Step 4: Add the domain and repository contracts**

Define:

```ts
export interface RuntimeOwnershipRecord {
  readonly ownerToken: string;
  readonly generation: number;
  readonly executionMode: "DRY_RUN" | "LIVE";
  readonly acquiredAtEpochMs: number;
  readonly heartbeatAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface RuntimeOwnershipAcquisition {
  readonly record: RuntimeOwnershipRecord;
  readonly takeover: boolean;
}

export interface RuntimeOwnershipStore {
  getCurrent(): Promise<RuntimeOwnershipRecord | null>;
  acquireAfterProcessLock(input: AcquireRuntimeOwnershipInput): Promise<RuntimeOwnershipAcquisition>;
  renew(input: RenewRuntimeOwnershipInput): Promise<RuntimeOwnershipRecord | null>;
  release(input: ReleaseRuntimeOwnershipInput): Promise<boolean>;
  recordLost(input: RecordRuntimeOwnershipLostInput): Promise<boolean>;
  listRecentEvents(limit: number): Promise<readonly RuntimeOwnershipEventRecord[]>;
}
```

Keep validation in `runtime-ownership-interfaces.ts`; do not import execution or strategy modules.

- [ ] **Step 5: Implement migration and both stores**

Create a singleton current-state table with `lease_scope='APPLICATION_RUNTIME'`, owner token, generation, mode, and millisecond timestamps. Create append-only `runtime_ownership_events` for `ACQUIRED`, `TAKEN_OVER`, `RELEASED`, and `LOST`.

`acquireAfterProcessLock` must use one `BEGIN IMMEDIATE` transaction, read the current row and maximum event generation, allocate `max + 1`, replace current ownership, and append exactly one acquisition or takeover event. `renew` and `release` match owner plus generation. `release` appends evidence before deleting the current row. `recordLost` appends evidence only when the supplied owner and generation are still current and never deletes or rewrites a newer owner.

- [ ] **Step 6: Run focused tests, integrity checks, and typecheck**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/runtime-ownership-store-contract.test.js'); await import('./dist/tests/db-sqlite-wiring.test.js'); await import('./dist/tests/live-database-identity.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
npm.cmd run typecheck
```

Expected: PASS with temporary databases only.

- [ ] **Step 7: Commit the persistence unit**

```powershell
git add migrations/0024_add_runtime_ownership.sql src/domain/runtime-ownership.ts src/modules/db/runtime-ownership-interfaces.ts src/modules/db/repositories/in-memory-runtime-ownership-store.ts src/modules/db/repositories/sqlite-runtime-ownership-store.ts tests/runtime-ownership-store-contract.test.ts tests/db-sqlite-wiring.test.ts tests/live-database-identity.test.ts tests/run-all.ts
git commit -m "feat: persist runtime ownership generations"
```

---

### Task 3: Ownership Guard And Heartbeat

**Files:**
- Create: `src/app/runtime-ownership-guard.ts`
- Create: `src/app/runtime-heartbeat.ts`
- Create: `tests/runtime-ownership-guard.test.ts`
- Create: `tests/runtime-heartbeat.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `RuntimeProcessLock`, `RuntimeOwnershipStore`, and `RuntimeOwnershipRecord`
- Produces: `RuntimeOwnershipAuthority` for later service fencing
- Produces: `RuntimeHeartbeat.start()` and asynchronous `RuntimeHeartbeat.stop()`

- [ ] **Step 1: Write guard state-machine tests**

Require `UNOWNED -> OWNED -> LOST`, forbid reacquisition in one guard, and verify both process-lock loss and persisted generation mismatch permanently fence authority.

```ts
await guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 1_000 });
assert.equal(guard.snapshot().status, "OWNED");
await store.acquireAfterProcessLock({
  ownerToken: "new-owner".padEnd(64, "x"),
  executionMode: "LIVE",
  acquiredAtEpochMs: 2_000,
  expiresAtEpochMs: 47_000,
});
await assert.rejects(() => guard.assertCurrent(2_001), /RUNTIME_OWNERSHIP_LOST/u);
assert.equal(guard.snapshot().status, "LOST");
```

- [ ] **Step 2: Write deterministic heartbeat tests**

Inject clock and timer interfaces. Verify renew at 10 seconds, no renewal of a newer generation, retries only before expiry, sleep jump beyond 45 seconds, one loss callback, and idempotent stop.

- [ ] **Step 3: Run tests and verify failure**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/runtime-ownership-guard.test.js'); await import('./dist/tests/runtime-heartbeat.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL because guard and heartbeat modules are absent.

- [ ] **Step 4: Implement the guard**

Expose this narrow dependency to operational services:

```ts
export interface RuntimeOwnershipAuthority {
  snapshot(): RuntimeOwnershipSnapshot;
  assertLocallyHeld(): void;
  assertCurrent(atEpochMs: number): Promise<RuntimeOwnershipRecord>;
}

export interface RuntimeOwnershipSnapshot {
  readonly status: "UNOWNED" | "OWNED" | "LOST";
  readonly generation: number | null;
  readonly executionMode: "DRY_RUN" | "LIVE" | null;
  readonly acquiredAtEpochMs: number | null;
  readonly heartbeatAtEpochMs: number | null;
  readonly expiresAtEpochMs: number | null;
  readonly takeover: boolean;
  readonly lossReason: string | null;
}
```

`assertLocallyHeld` must be synchronous and check permanent guard state plus the process lock. `assertCurrent` additionally reads the exact owner/generation and rejects expired authority. Neither method may mutate execution state or silently reacquire.

- [ ] **Step 5: Implement heartbeat constants and lifecycle**

Export:

```ts
export const RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
export const RUNTIME_OWNERSHIP_TTL_MS = 45_000;
export const RUNTIME_SHUTDOWN_TIMEOUT_MS = 30_000;
```

On compare-and-set mismatch or expiry, call `guard.markLost(reason)` exactly once. On transient store error, schedule the next bounded attempt only if the current lease has not expired. Never renew after loss.

- [ ] **Step 6: Run focused tests and typecheck**

Run the focused command from Step 3 and `npm.cmd run typecheck`.

Expected: PASS.

- [ ] **Step 7: Commit the authority unit**

```powershell
git add src/app/runtime-ownership-guard.ts src/app/runtime-heartbeat.ts tests/runtime-ownership-guard.test.ts tests/runtime-heartbeat.test.ts tests/run-all.ts
git commit -m "feat: fence runtime ownership with heartbeat"
```

---

### Task 4: Acquire Ownership Before Application Construction

**Files:**
- Create: `src/app/runtime-ownership-context.ts`
- Modify: `src/modules/db/repositories/contracts.ts`
- Modify: `src/modules/db/repositories/sqlite-repositories.ts`
- Modify: `src/app/create-app.ts`
- Modify: `src/index.ts`
- Modify: `tests/create-app.test.ts`
- Modify: `tests/index-startup.test.ts`
- Modify: `tests/runtime-startup-gate.test.ts`

**Interfaces:**
- Produces: `RuntimeOwnershipContext` containing process lock, ownership store/connection, guard, heartbeat, and close/release operations
- Produces: `verifyAndResolveRuntimeDatabase(config: AppConfig): VerifiedRuntimeDatabase`
- Consumes: verified configuration and the process/store units from Tasks 1-3
- Changes: `runMain` becomes the sole owner of runtime acquisition and application construction order

- [ ] **Step 1: Write startup ordering and zero-side-effect contention tests**

Require this exact success prefix:

```ts
assert.deepEqual(events.slice(0, 8), [
  "config:load",
  "identity:verify",
  "process-lock:acquire",
  "ownership-db:open",
  "ownership:acquire",
  "heartbeat:start",
  "app:create",
  "candidate-authority",
]);
```

For a contended process lock, require zero calls to mutable SQLite open, app construction, bootstrap, candidate initialization/recovery, Upbit reads, Telegram delivery/menu/polling, scheduler, and order send.

- [ ] **Step 2: Run startup tests and verify failure**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/index-startup.test.js'); await import('./dist/tests/runtime-startup-gate.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL because startup does not own a process or DB runtime lease.

- [ ] **Step 3: Add a separate ownership SQLite context**

`createRuntimeOwnershipContext` opens a dedicated SQLite connection after process-lock acquisition, constructs `SqliteRuntimeOwnershipStore`, acquires one generation, starts heartbeat, and exposes the guard. It must close its own connection independently of `SqlitePersistenceBundle`.

Define the composition result explicitly:

```ts
export interface VerifiedRuntimeDatabase {
  readonly canonicalDatabasePath: string;
  readonly lockIdentity: RuntimeLockIdentity;
}

export interface RuntimeOwnershipContext {
  readonly guard: RuntimeOwnershipAuthority;
  readonly heartbeat: RuntimeHeartbeat;
  snapshot(): RuntimeOwnershipSnapshot;
  fence(reason: string): void;
  releaseCurrentOwnership(releasedAtEpochMs: number): Promise<boolean>;
  closeOwnershipDatabase(): void;
  releaseProcessLock(): Promise<void>;
}
```

Do not make `createApp` asynchronous. Pass the already-owned `RuntimeOwnershipAuthority` through `CreateAppOverrides`; tests may use an explicit always-owned fake. Production `runMain` supplies the real guard. `createApp` must reject a fully enabled LIVE send path when no runtime authority is supplied. Explicit DRY_RUN smoke compositions remain exempt and must not be able to select the live adapter.

- [ ] **Step 4: Refactor `runMain` without import-time startup**

Implement the production order:

```ts
const config = loadAppConfig();
const verified = verifyAndResolveRuntimeDatabase(config);
const processLock = await acquireRuntimeProcessLock(verified.lockIdentity);
const ownership = await createRuntimeOwnershipContext({ config, processLock });
try {
  const app = createApp(config, { runtimeOwnershipAuthority: ownership.guard });
  await runAppStartup(app, { runtimeOwnership: ownership });
} catch (error) {
  await ownership.shutdownAfterStartupFailure();
  throw error;
}
```

Preserve the existing guarantee that importing `src/index.ts` performs no startup action.

- [ ] **Step 5: Run focused startup, create-app, and identity tests**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/index-startup.test.js'); await import('./dist/tests/runtime-startup-gate.test.js'); await import('./dist/tests/create-app.test.js'); await import('./dist/tests/live-database-identity.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
npm.cmd run typecheck
```

Expected: PASS with no network access.

- [ ] **Step 6: Commit the startup composition unit**

```powershell
git add src/app/runtime-ownership-context.ts src/modules/db/repositories/contracts.ts src/modules/db/repositories/sqlite-repositories.ts src/app/create-app.ts src/index.ts tests/create-app.test.ts tests/index-startup.test.ts tests/runtime-startup-gate.test.ts
git commit -m "feat: acquire ownership before runtime startup"
```

---

### Task 5: Asynchronous Fail-Closed Shutdown

**Files:**
- Modify: `src/app/runtime-lifecycle.ts`
- Modify: `src/app/strategy-scheduler.ts`
- Modify: `src/modules/telegram/inbound.ts`
- Modify: `src/index.ts`
- Modify: `tests/runtime-lifecycle.test.ts`
- Modify: `tests/strategy-scheduler.test.ts`
- Modify: `tests/telegram-inbound.test.ts`

**Interfaces:**
- Consumes: `RuntimeOwnershipContext` and worker stop methods
- Produces: asynchronous idempotent `RuntimeShutdown`
- Changes: shutdown fences first, then stops and quiesces workers, releases DB ownership, closes both SQLite connections, and finally releases the process lock

- [ ] **Step 1: Convert lifecycle expectations to asynchronous ordering tests**

Require:

```ts
assert.deepEqual(events, [
  "ownership:fence",
  "telegram:stop",
  "scheduler:stop",
  "workers:quiesce",
  "ownership:release",
  "app-db:close",
  "ownership-db:close",
  "process-lock:release",
]);
```

Also require idempotence, bounded timeout behavior, no release after ownership mismatch, `PARTIAL_FAILURE` on release/close failure, and non-zero signal exit on partial failure.

- [ ] **Step 2: Add worker quiescence tests**

Add `stopAndWait(timeoutMs)` behavior to scheduler and Telegram inbound polling tests. A stopped worker must reject new starts/ticks/polls, clear timers, and resolve only after its current promise settles or timeout is reached.

The worker contracts are:

```ts
strategyScheduler.stopAndWait(timeoutMs: number): Promise<StrategySchedulerStatus>;
telegramInboundPolling.stopAndWait(timeoutMs: number): Promise<TelegramInboundPollingStatus>;
```

- [ ] **Step 3: Run tests and verify failure**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/runtime-lifecycle.test.js'); await import('./dist/tests/strategy-scheduler.test.js'); await import('./dist/tests/telegram-inbound.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: FAIL because shutdown and stop methods are currently synchronous.

- [ ] **Step 4: Implement asynchronous shutdown ownership**

Change the public shutdown shape to:

```ts
export type RuntimeShutdown = (reason: string) => Promise<RuntimeStopSummary>;
```

Install signal handlers that await shutdown and then exit 0 only for `STOPPED`. Preserve the first shutdown summary for repeated calls. Record every step with explicit status and error without hiding the original startup or signal reason.

- [ ] **Step 5: Wire guard loss to the same shutdown owner**

The heartbeat loss callback invokes the shared shutdown with `RUNTIME_OWNERSHIP_LOST`. It must not create a second shutdown path or release a newer generation.

- [ ] **Step 6: Run focused tests and typecheck**

Run Step 3, then `npm.cmd run typecheck`.

Expected: PASS.

- [ ] **Step 7: Commit the shutdown unit**

```powershell
git add src/app/runtime-lifecycle.ts src/app/strategy-scheduler.ts src/modules/telegram/inbound.ts src/index.ts tests/runtime-lifecycle.test.ts tests/strategy-scheduler.test.ts tests/telegram-inbound.test.ts
git commit -m "feat: stop runtime after ownership loss"
```

---

### Task 6: Fence Scheduler, Telegram, Sync, And Live Order Sends

**Files:**
- Modify: `src/app/strategy-scheduler.ts`
- Modify: `src/app/sync-controller.ts`
- Modify: `src/app/strategy-run-controller.ts`
- Modify: `src/modules/telegram/inbound.ts`
- Modify: `src/modules/telegram/delivery.ts`
- Modify: `src/modules/execution/execution-service.ts`
- Modify: `src/app/create-app.ts`
- Modify: `tests/strategy-scheduler.test.ts`
- Modify: `tests/sync-controller.test.ts`
- Modify: `tests/strategy-run-controller.test.ts`
- Modify: `tests/telegram-inbound.test.ts`
- Modify: `tests/telegram-delivery.test.ts`
- Modify: `tests/execution-send-authority.test.ts`
- Modify: `tests/execution-service.test.ts`

**Interfaces:**
- Consumes: `RuntimeOwnershipAuthority`
- Preserves: existing account execution lease and adapter discriminant contracts
- Adds: final persisted runtime generation check immediately before the currently reachable `createOrder` call
- Preserves: no runtime cancellation caller exists in the current codebase; this task must not invent a new cancellation flow

- [ ] **Step 1: Write no-side-effect lost-authority tests per boundary**

For each component, inject an authority fake that transitions from owned to lost and assert no downstream call:

```ts
authority.lose("TEST_GENERATION_REPLACED");
await assert.rejects(() => service.submitOrderFromDecision(input), /RUNTIME_OWNERSHIP_LOST/u);
assert.equal(exchangeCreateOrderCalls, 0);
assert.equal(syncCalls, 0);
assert.equal(strategyCalls, 0);
assert.equal(telegramSendCalls, 0);
```

Require the execution test to replace the persisted generation after all existing order checks but before the adapter call; the final authority check must still prevent transmission. Add a dependency-boundary assertion that production runtime code has no `cancelOrder` caller, so stale ownership cannot reach cancellation through an undisclosed path.

- [ ] **Step 2: Run affected tests and verify failure**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/execution-send-authority.test.js'); await import('./dist/tests/strategy-scheduler.test.js'); await import('./dist/tests/sync-controller.test.js'); await import('./dist/tests/strategy-run-controller.test.js'); await import('./dist/tests/telegram-delivery.test.js'); await import('./dist/tests/telegram-inbound.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: new lost-authority tests FAIL.

- [ ] **Step 3: Add local entry fencing**

Call `assertLocallyHeld()` before a scheduler cycle, mutating Telegram route, notification claim/send loop, sync request, and strategy run. Treat failure as explicit runtime ownership loss, not as a strategy HOLD or successful skipped run. Read-only Telegram routing also stops after ownership loss to avoid duplicate operator responses.

- [ ] **Step 4: Add persisted final-send fencing**

In `ExecutionService`, keep the existing account execution lease sequence. Immediately before calling the adapter's `createOrder`, await `runtimeOwnership.assertCurrent(Date.now())`; perform no further awaited local work between that check and starting the adapter call. Do not add a cancellation service as part of this work.

If authority fails after local order persistence, persist explicit reconciliation-required evidence only when the caller still owns the same generation; otherwise leave the immutable local event and let the new owner recover it. Never retry or resend automatically.

- [ ] **Step 5: Run focused tests, existing lease contract, and typecheck**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/account-execution-lease-contract.test.js'); await import('./dist/tests/execution-send-authority.test.js'); await import('./dist/tests/execution-service.test.js'); await import('./dist/tests/strategy-scheduler.test.js'); await import('./dist/tests/sync-controller.test.js'); await import('./dist/tests/strategy-run-controller.test.js'); await import('./dist/tests/telegram-delivery.test.js'); await import('./dist/tests/telegram-inbound.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
npm.cmd run typecheck
```

Expected: PASS; existing order lease behavior remains unchanged.

- [ ] **Step 6: Commit the fencing unit**

```powershell
git add src/app/strategy-scheduler.ts src/app/sync-controller.ts src/app/strategy-run-controller.ts src/modules/telegram/inbound.ts src/modules/telegram/delivery.ts src/modules/execution/execution-service.ts src/app/create-app.ts tests/strategy-scheduler.test.ts tests/sync-controller.test.ts tests/strategy-run-controller.test.ts tests/telegram-inbound.test.ts tests/telegram-delivery.test.ts tests/execution-send-authority.test.ts tests/execution-service.test.ts
git commit -m "feat: fence runtime side effects by ownership"
```

---

### Task 7: Operator Visibility And Authoritative Documentation

**Files:**
- Modify: `src/modules/telegram/commands.ts`
- Modify: `src/modules/telegram/presentation/status.ts`
- Modify: `src/modules/telegram/presentation/readiness.ts`
- Modify: `src/modules/telegram/presentation/technical.ts`
- Modify: `src/index.ts`
- Modify: `tests/telegram-commands.test.ts`
- Modify: `tests/telegram-presentation.test.ts`
- Modify: `tests/telegram-operator-contracts.test.ts`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `ARCHITECTURE.md`
- Modify: `RISK_POLICY.md`
- Modify: `ORDER_LIFECYCLE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: immutable `RuntimeOwnershipSnapshot`
- Produces: locale-aware concise ownership health and canonical technical detail
- Preserves: Telegram as an operator surface, never a truth source

- [ ] **Step 1: Write Korean, English, and secret-boundary presentation tests**

Require concise output to include owned/lost/unavailable state, generation, mode, heartbeat time/age, takeover flag, and non-secret reason. Require technical output to retain canonical values. Assert output excludes owner token, raw database path, scope digest, named-pipe name, and access-key fingerprint.

- [ ] **Step 2: Write startup banner assertions**

Require the banner to include:

```ts
runtimeOwnership: {
  status: "OWNED",
  generation: 4,
  executionMode: "LIVE",
  heartbeatIntervalMs: 10_000,
  ttlMs: 45_000,
  takeover: false,
  lossReason: null,
}
```

Do not include path or token fields.

- [ ] **Step 3: Run presentation tests and verify failure**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/telegram-presentation.test.js'); await import('./dist/tests/telegram-commands.test.js'); await import('./dist/tests/telegram-operator-contracts.test.js'); await import('./dist/tests/index-startup.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: new ownership fields are absent and tests FAIL.

- [ ] **Step 4: Implement status and readiness visibility**

Pass one immutable ownership snapshot into the existing command DTO. Keep concise Korean as the default and preserve `/status detail` and `/readiness detail` canonical fields. `RUNTIME_ALREADY_OWNED` remains console-only because the duplicate has no DB/Telegram authority.

- [ ] **Step 5: Update all mandatory documentation**

Document:

- one mutating runtime per canonical DB/account across modes
- OS lock plus DB fencing responsibilities
- no multi-host/network-share support
- heartbeat loss and shutdown semantics
- final send/cancel authority checks
- duplicate startup operator response
- offline migration `0024` deployment sequence
- no change to per-order lease, strategy, sizing, risk, or Telegram truth boundaries

- [ ] **Step 6: Run focused tests, docs checks, and typecheck**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/telegram-presentation.test.js'); await import('./dist/tests/telegram-commands.test.js'); await import('./dist/tests/telegram-operator-contracts.test.js'); await import('./dist/tests/index-startup.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
npm.cmd run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit operator visibility and docs**

```powershell
git add src/modules/telegram/commands.ts src/modules/telegram/presentation/status.ts src/modules/telegram/presentation/readiness.ts src/modules/telegram/presentation/technical.ts src/index.ts tests/telegram-commands.test.ts tests/telegram-presentation.test.ts tests/telegram-operator-contracts.test.ts PRODUCT_BOUNDARY.md ARCHITECTURE.md RISK_POLICY.md ORDER_LIFECYCLE.md README.md
git commit -m "docs: expose runtime ownership health"
```

---

### Task 8: Integration, Independent Review, And Offline Verification

**Files:**
- Create: `tests/runtime-single-ownership-integration.test.ts`
- Modify: `tests/run-all.ts`
- Modify: files identified by independent reviewers only when required to satisfy the approved spec

**Interfaces:**
- Verifies the complete startup-to-shutdown contract from the approved spec
- Produces no runtime deployment, operational DB mutation, network call, or secret access

- [ ] **Step 1: Add a real child-process integration fixture**

Use temporary databases and child processes with fake operational services. On Windows, child A acquires the named pipe and persisted ownership; child B must exit with `RUNTIME_ALREADY_OWNED` and report zero side effects. Terminate child A without clean release, then require child C to acquire the released OS lock, allocate the next persisted generation, and record `TAKEN_OVER`.

On non-Windows, assert production lock acquisition fails closed and keep store/guard integration tests platform independent.

- [ ] **Step 2: Add end-to-end loss and shutdown tests**

Simulate heartbeat generation replacement and expiry. Require scheduler and Telegram stop, final order/cancel calls remain zero, newer DB ownership remains untouched, and process-lock release occurs last.

- [ ] **Step 3: Run the integration test first**

```powershell
npm.cmd run build
node --input-type=module -e "await import('./dist/tests/runtime-single-ownership-integration.test.js'); const {runRegisteredTests}=await import('./dist/tests/harness.js'); await runRegisteredTests();"
```

Expected: PASS.

- [ ] **Step 4: Run complete verification**

```powershell
npm.cmd run typecheck
npm.cmd test
git diff --check
git status --short
```

Expected: typecheck exits 0, every test passes, diff check is empty, and status contains only intended implementation changes if any review fix remains uncommitted.

- [ ] **Step 5: Request independent specification and safety reviews**

Dispatch one reviewer to compare the implementation against the approved design and one reviewer to inspect split-brain, heartbeat, shutdown, final-send, migration, and secret-boundary risks. Reviewers must not access LIVE state, secrets, Upbit, Telegram, or the operational DB.

- [ ] **Step 6: Correct verified review findings with TDD**

For each valid finding, add a focused failing regression test, run it to confirm failure, apply the smallest correction, rerun the focused test, then rerun complete verification. Do not apply speculative refactors unrelated to runtime ownership.

- [ ] **Step 7: Commit integration and review corrections**

```powershell
git add tests/runtime-single-ownership-integration.test.ts tests/run-all.ts
git status --short
git add -u
git commit -m "test: verify single runtime ownership"
```

Because execution occurs in a clean isolated worktree, `git add -u` may stage only the already tracked implementation files verified by the immediately preceding `git status --short`. Stop instead of staging if that status shows any unrelated change.

- [ ] **Step 8: Confirm the deployment boundary**

Report all commits, tests, reviewer findings, and changed files. Explicitly confirm:

- the original LIVE process was not stopped, restarted, signaled, or inspected
- the operational SQLite database was not opened or migrated
- no Upbit or Telegram API was called
- migration `0024` is not deployed
- a later explicit operator request is required for stop, backup, offline migration, read-only readiness, restart, and duplicate-launch rehearsal

Do not push, deploy, or restart from this task.
