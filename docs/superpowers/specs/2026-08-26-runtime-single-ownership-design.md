# Runtime Single-Ownership Design

## Status

- Date: 2026-08-26
- Scope: mutating `AutoTrade_Upbit` long-running runtimes
- Applies to: `LIVE` and `DRY_RUN`
- Does not apply to: provably read-only reports, inspections, and smoke commands that do not construct a mutable runtime composition
- Safety posture: fail closed

## Problem

Two application processes previously ran against the same SQLite database and Upbit account. Both processes could poll Telegram, run startup recovery, deliver notifications, and install scheduler timers. The per-order `account_execution_leases` table prevents some concurrent order submissions, but it does not establish one owner for the process-level runtime.

The system needs one authoritative mutating runtime per canonical SQLite file and exchange account. A duplicate must fail before recovery, Telegram, scheduler, reconciliation, or order side effects begin. The design must also recover safely after process crashes and Windows restarts without treating a stale timestamp alone as proof that the old process is dead.

## Goals

- Permit exactly one mutating runtime for a canonical SQLite file and exchange account.
- Apply the same exclusion boundary to `LIVE` and `DRY_RUN` so they cannot overlap on one database.
- Reject duplicate startup before operational services are constructed or invoked.
- Preserve process ownership evidence and a monotonically increasing fencing generation in SQLite.
- Block every live order transmission when runtime ownership is missing, expired, or superseded.
- Release ownership only after workers are fenced and stopped.
- Recover automatically from a crashed process or host restart when operating-system ownership proves that no prior local process still owns the runtime.
- Keep tokens, database paths, key fingerprints, and operating-system lock names out of operator output.

## Non-Goals

- Replacing the short-lived per-order `account_execution_leases` contract.
- Supporting shared SQLite files across multiple hosts or network filesystems.
- Implementing a distributed lock service.
- Changing strategy decisions, position sizing, risk limits, or order lifecycle rules.
- Starting, stopping, or migrating the currently running LIVE process during implementation.
- Giving provably read-only CLI tools, reports, inspections, or smoke commands runtime ownership.

## Considered Approaches

### Operating-System Lock Plus SQLite Ownership

This is the selected approach. A Node `net` named-pipe listener supplies a process-lifetime Windows lock. SQLite supplies durable ownership, heartbeat, generation fencing, and audit evidence. The operating system releases the named pipe on process death or host restart, while the database records which generation was authoritative.

### SQLite Lease Only

This was rejected as the sole exclusion primitive. Expiry is based on application time and cannot prove that a suspended process is dead. Automatic timestamp-based takeover can create split brain after sleep or a long event-loop stall.

### PID Or Lock File

This was rejected. Crash leftovers require unsafe stale-file deletion, PID reuse is ambiguous, and path or reparse behavior complicates reliable ownership.

### Native Windows Mutex

A native mutex has strong process-lifetime semantics, but Node has no built-in safe mutex API. Adding a native binding would increase installation and deployment risk. A Windows named pipe provides the required same-host operating-system exclusivity using built-in Node APIs.

## Scope Identity

The ownership scope is the pair:

- canonical absolute SQLite database path
- `exchange_account_id`

The named-pipe identifier is a domain-separated SHA-256 digest of that pair. The original path and account identifier are never included in the pipe name or logs. The same derivation is used in `LIVE` and `DRY_RUN`, so two modes cannot overlap on one database.

`LIVE` retains its existing database identity verification before any mutable database open. Canonical path validation and identity verification are separate from runtime ownership and remain authoritative.

## Components

### `RuntimeProcessLock`

Owns one Windows named-pipe listener for the runtime scope.

- `acquire()` resolves only after the listener is bound.
- `EADDRINUSE` maps to `RUNTIME_ALREADY_OWNED`.
- unexpected listener closure or error permanently marks the lock lost.
- `release()` closes only the caller's listener and is idempotent.
- no command shell, PowerShell helper, PID lookup, native dependency, or lock file is used.

### `RuntimeOwnershipStore`

Owns the SQLite compare-and-set contract.

- reads current ownership
- acquires a new generation
- renews heartbeat and expiry for an exact owner and generation
- replaces stale persisted ownership only after the caller already owns the operating-system lock
- releases only an exact current, unexpired owner and generation
- appends acquisition, takeover, release, and loss evidence

Store methods use short `BEGIN IMMEDIATE` transactions and perform no network or asynchronous work inside a transaction.

### `RuntimeOwnershipGuard`

Combines process-lock state with the current SQLite owner token and generation.

- starts in `UNOWNED`
- becomes `OWNED` only after both layers are acquired
- becomes permanently `LOST` after process-lock loss, ownership mismatch, generation mismatch, or lease expiry
- `assertCurrent()` checks process-lock state and exact persisted ownership
- a lost guard never becomes owned again in the same process

### `RuntimeHeartbeat`

Renews the persisted heartbeat every 10,000 milliseconds. Ownership expires 45,000 milliseconds after the last successful renewal.

- a compare-and-set mismatch causes immediate ownership loss
- transient SQLite errors may retry only while the persisted expiry remains in the future
- failure to renew before expiry causes permanent ownership loss
- timer delay beyond expiry, including sleep or a long event-loop pause, causes permanent ownership loss
- heartbeat never extends a different owner or generation

### Existing `AccountExecutionLeaseStore`

This remains unchanged in purpose. It serializes individual account order submissions and protects uncertain submission recovery. Runtime ownership is an additional outer authority boundary, not a replacement.

## Persistence Model

Migration `0024_add_runtime_ownership.sql` adds two tables.

### Current State

`runtime_ownership` contains one row per database/account scope:

- `scope_key`: domain-separated hash of canonical database path and account
- `owner_token`: opaque random process token
- `generation`: monotonically increasing positive integer
- `execution_mode`: `DRY_RUN` or `LIVE`
- `acquired_at_epoch_ms`
- `heartbeat_at_epoch_ms`
- `expires_at_epoch_ms`

An absent row means no persisted owner has ever been acquired. A clean release deletes the current row after appending release evidence. The next acquisition derives its generation from audit evidence so generation never resets.

### Audit Evidence

`runtime_ownership_events` is append-only and contains:

- event ID
- scope key
- generation
- event type: `ACQUIRED`, `TAKEN_OVER`, `RELEASED`, or `LOST`
- execution mode
- non-secret reason code
- event timestamp

Heartbeat renewals do not append events to avoid unbounded high-frequency growth. The current state row retains the latest heartbeat.

Owner tokens are persisted for compare-and-set operations but are never rendered by Telegram, banners, logs, or inspection output.

## Startup Sequence

The authoritative sequence is:

1. Load configuration.
2. Canonicalize the database path and derive the ownership scope.
3. In `LIVE`, perform existing read-only database identity and migration-ledger verification.
4. Acquire the operating-system process lock.
5. Open the SQLite persistence layer.
6. Acquire or take over persisted runtime ownership and allocate a new generation.
7. Start heartbeat and confirm one successful ownership check.
8. Bootstrap persisted application records when required.
9. Construct application services.
10. Run candidate startup authority and recovery.
11. Run generic startup recovery and notification delivery.
12. Build scheduler preflight.
13. Start scheduler and Telegram inbound polling.
14. Install shutdown handlers and configure the Telegram command menu.

If any step after process-lock acquisition fails, startup fences the guard, stops any constructed workers, conditionally releases exact persisted ownership, closes SQLite, and releases the process lock. The original startup error remains the primary error.

A duplicate that cannot acquire the process lock stops after step 4. It does not open mutable SQLite, bootstrap state, construct exchange or Telegram clients, run recovery, deliver notifications, install timers, or transmit an order.

### Scoped Smoke Ownership

A mutable or composed smoke acquires and releases process and persisted runtime ownership even when it is non-trading and makes no business-state mutation; it must contend with an existing owner exactly like the long-running runtime. This includes one-shot smoke paths that construct a writable application composition or can touch mutable runtime-control state. Only a provably read-only report, inspection, or smoke command that does not construct a mutable runtime composition remains ownership-free.

## Takeover Rules

Persisted ownership may be replaced only when the new process already owns the same operating-system lock. This proves that no other process on the supported single Windows host currently owns that lock.

- an unexpired leftover row is classified as crash or interrupted-shutdown evidence and replaced with a new generation
- an expired leftover row is classified as stale ownership and replaced with a new generation
- every replacement appends `TAKEN_OVER`
- a database on a network path or a multi-host deployment is unsupported and must fail validation

Timestamp expiry never authorizes takeover by itself.

## Runtime Authority Checks

All long-running worker entry points check the in-memory guard before work. External mutations additionally verify persisted generation at their final safe boundary.

Required boundaries include:

- scheduler cycle before reconciliation or strategy execution
- Telegram inbound routing before a mutating command
- notification delivery before Telegram transmission
- sync and strategy controllers before exchange access
- execution service immediately before Upbit `createOrder`
- any future reachable cancellation sender immediately before exchange cancellation; no current cancellation sender exists

Read-only Telegram inspection may continue only while the process still owns the operating-system lock. Once ownership is lost, all routing stops to avoid duplicate operator responses.

## Ownership Loss

Ownership loss is terminal for the process.

1. Mark the guard `LOST` synchronously.
2. Reject queued and future worker entry.
3. Stop Telegram polling and scheduler timers.
4. Prevent notification, sync, strategy, create-order, and any future cancellation-sender network calls.
5. Append `LOST` evidence if the process still has safe database authority to do so.
6. Quiesce active workers within a bounded shutdown interval.
7. Close persistence and release the operating-system lock.
8. Exit non-zero.

The process does not release or delete persisted ownership after an ownership mismatch because it may belong to a newer generation.

## Shutdown Sequence

Normal `SIGINT` and `SIGTERM` shutdown is asynchronous and idempotent:

1. Fence new work.
2. Stop Telegram inbound polling.
3. Stop scheduler timers.
4. Await bounded in-flight worker completion.
5. Release exact current persisted ownership.
6. Close SQLite.
7. Release the named pipe.

Release failure produces `PARTIAL_FAILURE` and a non-zero exit. It is never reported as a clean handoff.

## Operator Surface

The startup banner, `/status`, and `/readiness` expose:

- runtime ownership: owned, lost, or unavailable
- current generation
- execution mode attached to ownership
- last heartbeat timestamp and age
- whether startup performed a takeover
- non-secret blocker or loss reason

They do not expose:

- owner token
- named-pipe name
- raw database path or path hash
- Upbit key fingerprint

Duplicate startup reports `RUNTIME_ALREADY_OWNED` to its console. It does not write an alert through the database because it never acquired runtime authority.

## Configuration

The first version uses documented constants rather than environment overrides:

- heartbeat interval: 10,000 milliseconds
- ownership TTL: 45,000 milliseconds
- bounded shutdown wait: 30,000 milliseconds

These values are declared in the runtime-ownership module, included in the startup banner, and covered by tests. They are not money, quantity, allocation, or strategy defaults. Making them configurable is deferred until operational evidence demonstrates a need.

## LIVE Migration And Deployment

`LIVE` startup continues to reject a database missing any canonical migration. Therefore migration `0024` must be applied while LIVE is stopped through the existing separately confirmed identity-provisioning/migration procedure.

Deployment sequence is separate from implementation:

1. keep the existing LIVE process unchanged during development
2. finish implementation and full offline verification
3. explicitly stop LIVE
4. back up the operational database and sidecars
5. apply migration `0024` through the approved offline procedure
6. run read-only LIVE identity/readiness verification
7. start one runtime and confirm ownership fields
8. attempt a second local start and verify `RUNTIME_ALREADY_OWNED` with zero side effects

No deployment step occurs without a separate explicit operator request.

## TDD And Verification

Implementation proceeds test first.

### Pure And Store Tests

- deterministic, domain-separated scope derivation
- owner token and generation validation
- acquire, contention, renewal, release, and takeover contracts
- stale owner cannot renew or release a newer generation
- timestamp rollback, unsafe integer, and malformed row rejection
- two SQLite connections racing for ownership
- migration and migration-ledger atomicity

### Process Lock Tests

- one named-pipe owner succeeds
- a second process receives `RUNTIME_ALREADY_OWNED`
- graceful release permits a new owner
- child-process crash releases the operating-system lock
- lock loss permanently fences the original guard

### Startup And Shutdown Tests

- ownership acquisition precedes bootstrap and every operational side effect
- duplicate startup produces zero recovery, Telegram, scheduler, exchange, and order calls
- successful ownership precedes `RUN_ON_START` scheduler work
- startup failure releases only the ownership it acquired
- normal shutdown ordering and idempotence
- release failure yields partial failure and non-zero exit

### Runtime Safety Tests

- heartbeat compare-and-set mismatch fences the runtime
- expiry after simulated sleep fences the runtime
- SQLite busy that persists through expiry fences the runtime
- queued scheduler and Telegram work cannot proceed after loss
- final create-order checks reject stale generations, and any future reachable cancellation sender must apply the same final check
- existing `account_execution_leases` behavior remains unchanged
- provably read-only report, inspection, and smoke commands do not acquire ownership

### Final Verification

- `npm.cmd run typecheck`
- complete `npm.cmd test`
- `git diff --check`
- independent code review focused on split-brain, shutdown ordering, and final-send fencing
- confirmation that the current LIVE process and operational database were not modified during implementation

## Acceptance Criteria

- One canonical database/account has at most one mutating runtime on the supported host.
- Duplicate startup reaches no operational side effect.
- Crash and restart allocate a new generation with explicit takeover evidence.
- A stale or superseded process cannot submit or cancel an Upbit order.
- Heartbeat loss fails closed and terminates the runtime.
- Normal shutdown releases ownership only after worker quiescence.
- Operator output provides actionable ownership health without exposing sensitive identifiers.
- DRY_RUN and LIVE cannot overlap on the same database.
- Existing order lease, strategy, risk, reconciliation, and Telegram truth boundaries remain intact.
