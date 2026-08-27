# Runtime Single-Ownership Offline Migration And Readiness Rehearsal

## Verdict

**SYNTHETIC_REHEARSAL_PASS / OPERATIONAL_DEPLOYMENT_HOLD**

Migration `0024_add_runtime_ownership.sql`, LIVE database identity verification,
read-only LIVE readiness, the Windows process lock, and persisted ownership
generation were rehearsed successfully against a temporary synthetic SQLite
database on 2026-08-27.

This is evidence that the checked-in offline path works on an operational-like
fixture. It is not evidence that the operational database has been backed up,
migrated, or verified, and it is not approval to merge, push, deploy, restart a
LIVE process, or enable scheduling or order transmission.

## Rehearsal Boundary

- Worktree: `AutoTrade_Upbit/.worktrees/runtime-single-ownership`
- Branch: `codex/runtime-single-ownership`
- Rehearsed source HEAD: `1eac1760c2376239ec14c4b4c246adbeee2a6ab4`
- Database: unique OS-temporary synthetic SQLite fixture only
- Credentials: fixed synthetic strings only
- Network: unused
- Upbit and Telegram APIs: not called
- Runtime/application start: not performed
- Scheduler, strategy, sync, Telegram polling, and delivery: not started
- Order creation and cancellation: not called
- Operational database and migration state: not accessed or changed
- Temporary harness, database, backup, WAL, and SHM files: removed after the run

The one-time harness imported the built production migration, identity,
readiness, named-pipe lock, and ownership-store paths. It was deleted after the
evidence below was captured; no rehearsal-only production path remains.

## Commands And Results

| Command | Result |
| --- | --- |
| `npm.cmd run build` | PASS, exit 0 |
| `node .tmp-runtime-ownership-offline-rehearsal.mjs` | PASS, exit 0 |

Node printed its expected experimental SQLite warning. No assertion failed.

## Migration And Backup Evidence

### Pre-migration fixture

- Canonical migration ledger count: 22
- Latest applied migration: `0023_add_live_database_identity.sql`
- `0024_add_runtime_ownership.sql` ledger entry: absent
- Runtime ownership tables, indexes, and triggers: absent
- `PRAGMA quick_check`: `ok`
- `PRAGMA foreign_key_check`: zero violations
- Preserved seed evidence: one user, one primary Upbit KRW spot account, and one
  LIVE/enabled/running execution-state row

### Backup rehearsal

The closed synthetic database and every existing SQLite sidecar were copied as
one backup set before applying 0024.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| database | 434176 | `3b5efc9036797a291721b1ed0f0783a15f9bd6b16ff45ef1b4d52275a0a1b209` |
| `-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `-shm` | 32768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

The copied database opened successfully after the live fixture was migrated. It
still had the pre-0024 ledger, no runtime-ownership schema, clean quick/foreign
key checks, and the same three seeded records. This proves the rehearsal backup
was independent from the migrated fixture; it does not substitute for an
operator-approved backup and restore drill on the real host.

### Post-migration fixture

- `0024_add_runtime_ownership.sql` ledger count: exactly 1
- `PRAGMA quick_check`: `ok`
- `PRAGMA foreign_key_check`: zero violations
- Seeded user/account/execution-state counts: unchanged
- Current ownership rows immediately after migration: zero
- Installed schema objects:
  - tables: `runtime_ownership`, `runtime_ownership_events`
  - indexes: `idx_runtime_ownership_expires_at`,
    `idx_runtime_ownership_events_recent`,
    `idx_runtime_ownership_events_generation_acquisition`
  - append-only triggers: `runtime_ownership_events_no_update`,
    `runtime_ownership_events_no_delete`

The migration was applied through `openSqliteDatabase`, the same canonical
migration runner used by the explicit offline provisioning path. No SQL was
manually reimplemented for the migration step.

## Identity And Readiness Evidence

- First synthetic identity provisioning: `CREATED`
- Repeated identical provisioning: `ALREADY_MATCHED`
- LIVE database identity verification: `VERIFIED`
- Credential fingerprint or credential value rendered: no
- Read-only LIVE readiness result: `WARN`
- Blocking checks: none
- Expected warnings: `balance_snapshot`, `position_snapshot`,
  `latest_reconciliation`
- Database byte length and SHA-256 before versus after readiness: unchanged
- Readiness non-mutation boundary reported false for database writes,
  migrations, bootstrap, candidate initialization, orders, strategy, sync,
  scheduler, Telegram polling, exchange probe, and notification delivery
- Order transmission attempted: false
- Exchange probe attempted: false

This captured result predates the later explicit readiness-freshness contract.
Current code requires `LIVE_READINESS_MAX_EVIDENCE_AGE_MS`; the historical
fixture result above is retained as rehearsal evidence rather than rewritten as
though the new policy had been exercised.

`WARN` is the correct result for this intentionally network-free fixture: no
synthetic exchange snapshot or reconciliation success was invented. The absence
of blockers proves identity, LIVE mode/gate, execution state, scheduler-off
configuration, active-order state, and local schema/ledger checks passed.

## Process Lock And Ownership Evidence

The production Windows named-pipe lock was exercised against the synthetic
database scope.

1. The first owner acquired the process lock and persisted generation 1.
2. A second lock attempt failed with `RUNTIME_ALREADY_OWNED` before an ownership
   context could be created.
3. Current ownership and audit rows were byte-for-byte equivalent before and
   after the failed duplicate attempt; the duplicate caused no database write.
4. The first owner completed a clean release.
5. A new owner acquired generation 2 and completed a clean release.
6. Final current ownership row count was zero.

Newest-first audit chronology:

1. `RELEASED:2:CLEAN_RELEASE`
2. `ACQUIRED:2:PROCESS_LOCK_ACQUIRED`
3. `RELEASED:1:CLEAN_RELEASE`
4. `ACQUIRED:1:PROCESS_LOCK_ACQUIRED`

This rehearsal covers normal duplicate exclusion and clean reacquisition. Crash
takeover, expiry, generation replacement, process-lock loss, and timeout fencing
remain covered by the branch's runtime single-ownership integration and focused
regression suites; this run did not deliberately crash or time out a process.

## Operational Offline Procedure (Not Executed)

The following is the deployment runbook to use only after separate operational
approval. Paths, identities, and credentials must come from the approved local
LIVE configuration; do not copy synthetic values from this report.

1. **Freeze the change set.** Confirm the exact approved commit, required Node
   version, canonical local SQLite path, expected database-instance UUID, and
   primary Upbit account identity. Confirm `DRY_RUN` remains the repository
   default and that the LIVE launcher still disables scheduler run-on-start.
2. **Enter an offline maintenance window.** Stop the sole LIVE runtime through
   the approved operator procedure. Confirm it has fully exited and no process
   owns the database scope. Do not run `/sync`, `/run`, `/pause`, `/resume`, a
   scheduler tick, or any Telegram delivery during the window.
3. **Capture one recoverable backup set.** With SQLite closed, copy the database
   plus any existing `-wal` and `-shm` sidecars together to a new dated backup
   directory. Record file sizes and SHA-256 hashes. Do not overwrite an earlier
   backup. Test-open a separate copy read-only and record `quick_check`,
   `foreign_key_check`, migration ledger, and critical row counts.
4. **Apply the approved offline operation once.** Use the checked-in local copy
   of `scripts/provision-live-database-identity.example.ps1` with the existing
   absolute database path, approved database-instance UUID, primary account ID,
   and current Upbit access key. The operation applies pending migrations and
   creates or exactly matches the singleton identity. Never run it while LIVE is
   active, and never accept an identity mismatch by overwriting the binding.
5. **Verify the migrated database before startup.** Confirm 0024 appears exactly
   once in `_schema_migrations`; all seven ownership schema objects exist;
   `quick_check` is `ok`; `foreign_key_check` is empty; critical pre-migration
   row counts and selected records match; and no current runtime-ownership row
   exists before startup.
6. **Run only the read-only LIVE readiness smoke.** Keep scheduler and
   run-on-start disabled. Treat any identity, ledger, integrity, active-order,
   execution-state, or reconciliation blocker as a stop condition. The current
   Set an explicitly approved positive-safe-integer
   `LIVE_READINESS_MAX_EVIDENCE_AGE_MS`. The smoke blocks a missing policy and
   malformed, future, or uncomparable timestamps; evidence exactly at the limit
   passes. Missing or stale evidence warns and requires a separately approved
   `/sync` before `/run`; this migration procedure itself must not call it.
7. **Start exactly one runtime after separate approval.** Confirm ownership is
   `OWNED`, generation is present, heartbeat is fresh, and takeover status is
   expected. Keep the scheduler disabled until the normal operator checklist is
   complete.
8. **Run the dedicated probe only after separate operational approval.** Use
   the ignored local copy of `scripts/probe-live-duplicate-owner.example.ps1`,
   never a normal second LIVE launcher. The checked-in command verifies identity
   read-only and attempts only the production named-pipe lock. Require exit 0
   with `PASS/DUPLICATE_BLOCKED`; `BLOCK/NO_ACTIVE_OWNER` means it acquired and
   immediately released the lock and the exercise must stop. This source task
   did not execute that command on the real host.
9. **Rollback only while fully offline.** If migration or verification fails,
   do not attempt an ad-hoc down migration. Stop every process, quarantine the
   failed database set, and restore the verified database plus matching sidecars
   as one set. Re-run read-only integrity, ledger, identity, and readiness checks
   before any restart. Escalate identity or integrity mismatches instead of
   repairing them in place.

## Remaining Hold Points

- Migration 0024 has not been applied to the operational database.
- No operational backup or restore drill has been performed.
- No operational read-only readiness smoke has been run.
- No LIVE runtime has been started, stopped, restarted, or duplicate-probed.
- No merge, push, deployment, Upbit call, Telegram call, sync, strategy run,
  scheduler tick, order creation, or cancellation has occurred.

The branch is eligible for further code review and a separately authorized
integration decision. It is not yet operationally deployable solely on the basis
of this synthetic rehearsal.
