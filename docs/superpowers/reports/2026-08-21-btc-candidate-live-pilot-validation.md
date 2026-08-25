# BTC Candidate LIVE Pilot Offline Validation

## Verdict

- Final offline implementation verdict: **GO**.
- Operational activation verdict: **NOT EVALUATED AND NOT APPROVED**.
- Branch: `codex/btc-candidate-live-pilot`.
- Reviewed implementation HEAD: `0177b7086a8ac849724a60f975ba3aa359e297a9`.
- Merge base: `d7ecfd758fa89030efa721cb9cc3f3d9a1fb6be2` (`main`).
- Default policy remains `BASELINE`.
- Default execution remains `DRY_RUN`, live-order transmission disabled, scheduler disabled.
- The candidate is implemented but was not selected, activated, started, merged, or pushed.

This report proves only offline implementation and no-order validation. It does not prove that an operational database, current exchange account, current balance/position state, or LIVE runtime is ready.

## Implemented Boundary

The branch adds the explicitly selected BTC-only pilot identity `BTC_COMBINED_CONSERVATIVE_PILOT_V1`, mapped to `KRW-BTC`, `COMBINED_CONSERVATIVE`, and `PCS-2026-001.DEPLOYMENT_READINESS_V1`. `KRW-ETH` remains baseline in every phase.

The implementation includes:

- strict fail-closed selection and checked-in abandonment authority validation;
- fee-inclusive exact candidate state and deterministic replay;
- persisted deployment, audit, evidence, execution-binding, and lease authority;
- BTC policy routing for `PENDING_FLAT`, `ACTIVE`, `DRAINING`, `PAUSED_FAULT`, and `DISABLED`;
- unchanged baseline sizing when candidate logic permits an action;
- account-wide duplicate-process and submission-blocking protection;
- sole-send ownership in `ExecutionService` with immediate final exact-intent authority;
- typed definitive and uncertain Upbit submission outcomes;
- bounded identifier recovery, immutable snapshot binding, and no uncertain retry;
- exchange-backed terminal evidence projection with exact decision, binding, fill, quantity, gross, fee, and chronology provenance;
- startup replay/recovery, global fault pause, no automatic resume, and governed rollback;
- direct read-only readiness inspection and Korean-first operator visibility without an activation command;
- crash-atomic migration schema and ledger application.

## Independent Reviews

Three independent final reviewers initially returned NO-GO and identified 11 unique load-bearing findings. All were reproduced and fixed with focused regression coverage:

| Finding | Final status | Safety result |
| --- | --- | --- |
| F1 persisted nonterminal pilot bypass under baseline config | ADDRESSED | startup always inspects persisted pilot authority |
| F2 DRAINING REDUCE/EXIT lacked candidate binding | ADDRESSED | risk-reducing orders retain exact pilot binding |
| F3 canonical DRAINING restart was rejected | ADDRESSED | valid DRAINING restarts; malformed lineage blocks |
| F4 startup omitted candidate exchange-backed recovery | ADDRESSED | recovery precedes runtime execution surfaces |
| F5 exchange snapshot was not bound to lookup/local intent | ADDRESSED | immutable snapshot and identity binding required |
| F6 durable FOUND could be overridden by later NOT_FOUND | ADDRESSED | FOUND authority prevents absence confirmation |
| F7 final send did not require its own exact active order | ADDRESSED | final exact own-order read is immediately before sole send |
| F8 lease acquisition omitted unresolved dispatched failures | ADDRESSED | canonical account-wide blocker is always checked |
| F9 readiness omitted the same unresolved blockers | ADDRESSED | runtime and inspection share blocker semantics |
| F10 readiness did not prove source order/binding provenance | ADDRESSED | exact decision, binding, fills, fees, and chronology required |
| F11 migration schema and ledger were not crash-atomic | ADDRESSED | schema and migration ledger commit or roll back together |

Boole then performed the narrow residual re-review of F7, F10, and the authoritative documentation. The reviewer marked all three ADDRESSED, found no new load-bearing regression, and returned GO for final offline validation. This reviewer verdict is not LIVE activation approval.

## Temporary Readiness Validation

Validation used a newly created, migrated SQLite fixture under the isolated worktree. It did not use or copy an operational database. Bootstrap values were synthetic and explicitly set to:

- execution mode: `DRY_RUN`;
- live gate: `DISABLED`;
- exchange account ID: `primary`;
- policy environment: baseline, with no candidate ID or confirmation;
- checked-at: `2026-08-25T00:00:00.000Z`;
- freshness threshold: `3600000` ms.

Observed report contract:

- overall status: `WARN`, expected for a fresh baseline fixture without deployment or health snapshots;
- selection: `BASELINE`;
- candidate selected: `false`;
- live operator confirmed: `false`;
- deployment: absent;
- ETH policy: `BASELINE`;
- active orders: `0`;
- uncertain orders: `0`;
- required migrated schema: `PASS`;
- direct non-mutation check: `PASS`;
- `readOnly=true`;
- database writes, migrations, order mutation, private exchange, Telegram, sync, scheduler, execution, and runtime actions: all `false`.

The SQLite snapshot check reported the documented `READER_MARKS_MAY_CHANGE` warning: read-only WAL inspection issues no database or WAL write, but SQLite may update SHM reader marks. The exact temporary database, WAL, SHM, and journal candidate paths were checked to remain inside the worktree and removed after validation.

## Fresh Verification Evidence

Executed from the isolated feature worktree:

| Command | Result |
| --- | --- |
| `npm.cmd run build` | exit 0 |
| `npm.cmd run typecheck` | exit 0 |
| `npm.cmd run test` | exit 0 outside the known sandbox filesystem restriction; isolated prospective child suite 102/102 |
| `npm.cmd run check` | exit 0; typecheck, byte-for-byte generated bundle check, and full tests passed |
| `git diff --check` | exit 0 |
| temporary migrated DB readiness assertions | PASS |
| temporary DB cleanup assertions | PASS |

The first sandboxed full-test attempt produced one false environmental failure: esbuild could not read the worktree source because the sandbox denied an ancestor directory scan. Reproduction isolated the result to the byte-for-byte prospective bundle test (101/102). Re-running the unchanged complete test command outside that filesystem restriction passed, including the bundle test (102/102). No code change was made for this environmental failure.

## Subagent Contributions

The project used bounded subagents because independent review of real-money execution authority was required. They were not all active simultaneously.

| Agent | Role | Owned or reviewed scope |
| --- | --- | --- |
| Averroes | final policy reviewer | identity, phase routing, sizing preservation, ETH baseline; identified F1-F3 |
| Parfit | final persistence/inspection reviewer | SQLite atomicity, leases, state/evidence replay, direct readiness; identified F8-F11 |
| Anscombe | final execution reviewer | startup recovery, reconciliation, uncertain send, final send authority; identified F1/F3-F7 |
| Hilbert | integrated fix implementer | F1-F11 fixes across app, execution, reconciliation, DB, readiness, tests, and docs |
| Boole | final residual reviewer | independent re-review of F7, F10, and authoritative docs; final offline GO |
| James | notification race implementer | deterministic pending re-kick and detached delivery history |
| Newton | notification reviewer | independent reporter/persistence race review and final approval |
| Helmholtz | reconciliation CAS reviewer | terminal-winner preservation under concurrent recovery races |
| Hume and Kepler | readiness implementer/reviewer | audit-chain, path, timestamp, and read-only readiness hardening |
| Cicero, Laplace, Jason, and Carver | docs/wrapper implementers and reviewers | baseline-safe inspection docs and exact PowerShell wrapper authority |
| Pauli and Bernoulli | Telegram visibility reviewer/implementer | persisted candidate visibility, localization, and no activation command |
| Huygens and Archimedes | rollback/notification reviewers | pause-phase atomicity, delivery kick, recovery exposure, crash gap |
| Chandrasekhar and Popper | lifecycle reviewers | LIVE fake-path, restart, partial-fill, and atomic fill persistence coverage |

The main agent retained product-boundary decisions, final finding adjudication, live-trading safety consistency, worktree integration, temporary readiness validation, full repository verification, and this final report. The final validation-stage document change is this report; the Task 15 ledger completion entries were already present in the reviewed branch.

## Changed Scope

The reviewed implementation at `0177b70` comprised 146 local commits across 154 files relative to `main`; this report is a subsequent documentation-only validation commit. The major areas are:

- migrations `0017` through `0022`;
- explicit pilot domain/configuration contracts;
- candidate persistence, exact state/evidence, and account lease stores;
- execution, reconciliation, recovery, and rollback safety paths;
- strategy routing and scheduler/manual-run preparation;
- direct read-only readiness inspection;
- Korean-first Telegram visibility;
- authoritative root documentation and baseline-safe inspection example;
- extensive pure, in-memory, fake-adapter, and temporary-SQLite tests.

## Residual Boundaries

- This validation did not open the operational LIVE database.
- It did not call Upbit public or private endpoints.
- It did not poll or send Telegram messages.
- It did not start or restart the app, scheduler, sync, strategy, or order paths.
- It did not change any `.local.ps1`, secret value, LIVE configuration, persisted operational state, or process state.
- Telegram delivery remains at-least-once across the external boundary where Telegram may accept a message before local SENT finalization; this is an existing documented transport limitation, not pilot execution authority.
- WAL read-only inspection may update SQLite SHM reader marks; it does not claim byte-for-byte SHM immutability.
- Direct path validation and open cannot eliminate every local filesystem TOCTOU without a platform-specific descriptor-opening redesign; symlink/junction and reopened-content checks fail closed within the documented scope.
- Historical or partial schemas that cannot prove canonical authority are blocked rather than repaired by the inspector.

## Activation Boundary

No new BTC pilot inspection/example script selects the candidate or starts LIVE scheduling, and no checked-in script selects the BTC candidate by default. Implementation availability is not activation.

Any future operational step requires a separate explicit operator decision and a new gate that may include an approved read-only inspection of the actual database, current exchange-backed reconciliation, explicit local candidate selection and confirmation, process startup review, and controlled LIVE validation. None of those actions is authorized or performed by this report.
