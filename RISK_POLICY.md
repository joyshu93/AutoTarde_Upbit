# Risk Policy

## Runtime Ownership Risk Boundary
For a canonical local SQLite database and exchange account, one mutating runtime is permitted across `DRY_RUN` and `LIVE`. Both modes must use the same accepted canonical path for lock identity and SQLite open. UNC/network or device paths, Windows short names, symlink/junction/reparse aliases, and hardlink ambiguity fail closed before ownership or database mutation. A same-host Windows operating-system lock establishes process exclusion; the canonical scope digest is persisted as `scope_key` on every current-owner operation and audit event, while generation and heartbeat establish durable fencing. Multi-host and network-share operation are unsupported, and a stale heartbeat alone never proves another host/process is safe to replace.

Heartbeat loss, lock loss, expiry, or a persisted generation mismatch fails closed: every local side-effect admission samples the runtime clock and rejects `now >= expires_at` without waiting for heartbeat renewal; new worker work is fenced; notification delivery, polling, scheduler timers, and heartbeat renewal stop; and shutdown waits for settlement or explicit bounded-timeout evidence before closing SQLite and the process lock. Scheduler startup-block reporting is ownership-checked before and after transport and remains tracked until it settles. Exact-generation `LOST` audit recording is best-effort before ownership DB close and cannot touch a superseding owner; normal shutdown is `RELEASED`, not `LOST`. The execution path retains the per-order account lease and performs one final synchronous persisted assertion that atomically combines runtime generation with account execution status, kill switch, mode, and live gate, then invokes the reachable order send inside the same non-async authority callback before yielding. After adapter fulfillment or rejection it must reassert current ownership before any stale finalization, pause, notification, or lease release; failure preserves `SUBMITTING` and the lease for the current owner. This changes neither risk limits, strategy decisions, sizing, nor the Telegram operator-only truth boundary.

A clean release additionally requires observable worker quiescence and a still-held process lock. Loss after the normal cleanup fence is escalated and persisted as `LOST`, never overwritten by `RELEASED`. Timeout, rejected settlement, or any status showing work still active records quiescence loss and retains both SQLite connections plus the process lock in both long-running and scoped shutdown until terminal process exit; this deliberately prevents a new owner while an outbound operation may still finish. Such a result is fatal rather than eligible for same-process restart.

Ownership health is safe to expose only as non-secret status, generation, mode, heartbeat time/age, takeover, and reason. Owner tokens, raw/canonical database paths, lock identifiers, scope digests, and key fingerprints are never operator output. `RUNTIME_ALREADY_OWNED` is console-only for a duplicate that never acquired authority. Migration `0024_add_runtime_ownership.sql` requires a separately approved offline stop, backup, migration, read-only verification, and restart procedure.

DRY_RUN readiness and completion smokes make no trading or business-state mutation while acquiring and releasing process plus persisted runtime-control ownership evidence; each contends with an existing owner. Their ownership-control writes are not a reason to describe them as globally read-only or non-mutating. Only a provably read-only report, inspection, or smoke that does not construct a mutable runtime composition is ownership-free.

## LIVE Database Selection Guard

LIVE must fail before runtime construction when `DATABASE_PATH` is relative, missing, not a regular uniquely named local file, uses network/device/short-name syntax, passes through a symlink/junction/reparse alias, has hardlink ambiguity, has a non-canonical migration ledger, lacks its singleton identity, or does not match the configured database UUID, primary account, or Upbit access-key fingerprint. The guard must not reveal credentials or fingerprints in errors. It must not create a replacement DB or silently bind/rebind an identity. `DRY_RUN` may create a missing local database only after its existing ancestor and complete target path pass the same canonical-scope checks.

LIVE verification binds the native file identity as well as the path and persisted identity. Every subsequent SQLite handle must derive the main-database location from that opened connection, canonicalize it, reassert the verified file identity, and validate migration/account/instance/credential evidence on that same handle before any mutable initialization. A file replacement or different actual handle in the verification/open gap is a blocking identity change and leaves the replacement unmodified. Tilde text alone is not a short-name failure; a short-name rejection requires native canonical resolution to prove an alias.

Identity provisioning is an offline database mutation: stop LIVE, make a backup, use the explicit confirmation command once, and preserve its UUID in ignored local scripts. Upbit key rotation must block LIVE until a separate reviewed rebind operation exists; operators must not work around it by deleting or editing the identity row.

## Non-Negotiable Safety Rules

- default execution mode is `DRY_RUN`
- live order transmission stays disabled until explicitly enabled by the user
- only Upbit spot trading is allowed
- only `KRW-BTC` and `KRW-ETH` are allowed
- Telegram cannot mutate balance or position truth
- failures must be recorded explicitly

## Dual Live-Mode Gate

Live trading is considered allowed only when both conditions are true:

1. `APP_EXECUTION_MODE=LIVE`
2. `ENABLE_LIVE_ORDERS=true`

If either condition is missing, the system must behave as non-live, and risk evaluation should block any attempt to treat the run as live.

## BTC Candidate Pilot Safety

Baseline and `DRY_RUN` remain the defaults; candidate implementation availability is not activation or approval. The only allowed pilot identity is `BTC_COMBINED_CONSERVATIVE_PILOT_V1` on `KRW-BTC` with policy `COMBINED_CONSERVATIVE` and version `PCS-2026-001.DEPLOYMENT_READINESS_V1`. ETH always remains baseline for this pilot.

Persisted phases fail closed: `DISABLED` is baseline-only; `PENDING_FLAT` suppresses new BTC `ENTER` and `ADD` until exchange-backed flat proof; `ACTIVE` allows candidate influence only while all persisted authority and ordinary risk/execution gates remain valid; canonical `DRAINING` survives restart unchanged and allows only risk-reducing `REDUCE` or `EXIT` while rollback inventory remains; and `PAUSED_FAULT` blocks the pilot pending explicit investigation. A phase change never enables LIVE transmission or automatically resumes execution by itself.

Startup always inspects persisted pilot authority before later startup side effects. Baseline selection permits a fresh database, no deployment, or one canonical `DISABLED` deployment; any nonterminal deployment, malformed row, duplicate, or identity mismatch fails closed. Candidate startup retains valid `PENDING_FLAT`, `ACTIVE`, `PAUSED_FAULT`, or canonical `DRAINING` authority and never activates, resumes, or converts it automatically.

Persisted deployment, state, execution-evidence, immutable execution bindings, and audit records are authoritative. Exact state replay and complete decision/order/binding/exchange-confirmed-fill provenance are mandatory, and every executable decision remains protected by the account execution lease. Lease acquisition, all runtime send paths, and read-only readiness use one account-wide evidence-based submission-blocking classification: active lifecycle rows and unresolved potentially dispatched `FAILED`/`REJECTED` rows block, while definitive pre-send terminal rows, exact exchange rejections, and bounded absence with no durable `FOUND` evidence do not. Submission uncertainty pauses global execution. Recovery inconsistency faults the pilot. Neither path automatically resumes. Rollback may start only while global execution is paused, must remain `DRAINING` across restart while inventory remains, may reach `DISABLED` only after exchange-backed flat evidence, and requires a separate explicit resume after readiness review.

`inspect:btc-pilot:readiness` is a direct read-only inspection command, and `scripts/inspect-btc-pilot-readiness.example.ps1` requires an explicit existing database path plus explicit account and deployment identity while forcing the default `BASELINE` policy selection. It applies the same submission-blocking classification as runtime, reports blocking order identities/reasons, and validates each terminal candidate evidence row against its exact persisted decision, terminal source order, immutable binding, timestamp-bounded exchange-confirmed fills, exact quantity/gross/confirmed-fee aggregate, replayed state, and audit chain. The checked-in example must not contain candidate selection or confirmation, secrets, mutate a local script or database, activate a phase, call Upbit or Telegram, start runtime or scheduler services, invoke sync/strategy/order paths, or enable LIVE orders. Candidate selection and confirmation require separate local configuration, no-order validation, operator review, and a later explicit activation request; inspection grants no activation authority.

## Guardrail Set

### Global Kill Switch

- must immediately block new execution
- must be inspectable
- should remain sticky until an operator deliberately resets it

### Pause / Resume

- `PAUSED` blocks new execution while preserving existing records
- resume must be explicit
- pause reason should be preserved for operator visibility

### Degraded Startup Health

- `DEGRADED` is a persisted operator-state signal for unresolved startup health problems, especially unexplained portfolio drift
- `DEGRADED` must be inspectable with explicit reason and timestamp
- `DEGRADED` must not overwrite `PAUSED` or `KILL_SWITCHED`; those states keep priority while degraded metadata remains durable
- resume must restore `DEGRADED` when degraded metadata is still active
- execution guardrails must block new orders while the effective system status is `DEGRADED`

### Duplicate Order Guard

- every order intent requires an idempotency key
- the system must reject duplicate active intents for the same fingerprint
- duplicate suppression must not rely only on message cooldowns or human-readable summaries
- a candidate retry may return `DUPLICATE` only when its persisted order, first event, decision, immutable execution binding, deployment authority, and order material match exactly. Missing or conflicting candidate evidence must atomically pause the pilot and global execution, transmit no order, and never create or attach a replacement binding. Non-candidate duplicate behavior is unchanged.

### Account Execution Lease

- every executable decision must acquire the account-scoped database lease after idempotency duplicate detection and before execution, risk, exchange-validation, or order-persistence work
- `ACCOUNT_EXECUTION_LEASE_MS` must be a positive explicit configuration value; its default is `30000`
- lease conflict or ambiguity must create no order row, make no exchange create-order call, persist `ACCOUNT_EXECUTION_LEASE_BLOCKED` evidence, and require a durable automatic pause; pause or release ambiguity is fatal rather than a safe blocked result
- after durable `SUBMITTING`, ownership must be renewed and verified with a fresh clock instant immediately before the sole send; renewal ambiguity retains recovery evidence and forbids the send
- after renewal, candidate execution must complete its awaited first-event, persisted `READY` decision, deployment, exact state, and binding checks before the authoritative operator-state read. Every path must then perform the canonical bounded account-wide submission-blocker scan followed by an exact account-plus-order-ID read; the exact own-row read is the final order-state await before synchronous revalidation. One SQLite statement then atomically checks the persisted runtime generation, lease expiry, account execution status, kill switch, execution mode, and live gate. This combined assertion is the final await, and the sole `createOrder` call begins synchronously after it with no intervening awaited work. Any unavailable or ambiguous combined authority fails closed. The execution adapter carries its own required discriminant instead of accepting an independent path label. The tagged `LIVE` adapter requires persisted `executionMode=LIVE` and `liveExecutionGate=ENABLED` both initially and finally. The tagged `DRY_RUN` adapter accepts any non-fully-live initial tuple, including `DRY_RUN`/`ENABLED` and `LIVE`/`DISABLED`, but requires the exact initial mode-and-gate tuple to remain unchanged at the final check. Any drift retains recovery evidence and sends nothing.
- the final canonical blocker scan applies identically to candidate and baseline orders, covers active rows plus potentially dispatched `FAILED` and `REJECTED` recovery rows, excludes only rows with definitive non-dispatch authority such as absence-confirmed `FAILED`, and treats saturation as unsafe. The own row must still be the exact expected local `SUBMITTING` lifecycle with no exchange or failure evidence. Strict plain own enumerable data-property projections must match every expected candidate record, and only status may be projected back to `PERSISTED` for the reviewed aggregate validator. A competing order, missing row, changed authority, or material mismatch uses the appropriate fail-closed pause path, retains the lease and bound order, and sends nothing.
- safe pre-send exits and definitive terminal outcomes release the lease; active, uncertain, or post-send persistence-failure outcomes retain it for recovery

### Stale Price Guard

- orders require a recent price snapshot
- missing or stale pricing must block submission
- stale thresholds must be explicit configuration, not hidden constants
- the captured time must be the exchange ticker timestamp that supplied the strategy reference price; the local order-request time must not replace that evidence
- `STALE_PRICE_THRESHOLD_MS` is an absolute timestamp tolerance: snapshots older than it or materially farther than it into the future must block, while smaller exchange/local clock skew is tolerated

### Minimum Order Value Guard

- the system must reject orders below the configured local minimum
- the local minimum is a risk control and must not be confused with exchange-enforced minimums
- market sell orders with quantity but no order price must derive order value from the strategy reference price before local and exchange minimum-total checks

### Exposure Controls

- enforce a per-asset allocation cap
- enforce a total exposure cap
- evaluate projected exposure, not only current exposure
- model `bid` orders as exposure-increasing and `ask` orders as exposure-reducing for projection
- do not block a risk-reducing `ask` solely because the current portfolio is already above a cap
- treat total exposure as the primary reserve-policy anchor
- treat per-asset caps as concentration backstops, not as an equal-split-by-asset budgeting rule

## Exchange Validation Requirements

The execution path should validate orders through:
- Upbit order chance data
- Upbit order test where appropriate
- explicit response handling for rejected or offline markets

## Recovery Requirements

- local persistence must happen before an order is considered safely handled
- failures between persistence and exchange acknowledgement must remain visible
- reconciliation runs must produce durable records
- process startup should attempt a recovery sweep when exchange-backed reads are available
- reconciliation should respect an explicit per-run lookup budget to avoid exchange read bursts
- exchange-history recovery should stop at the configured historical boundary, expose the configured exchange-history retention assumption, report archive coverage as `IN_PROGRESS` or `COMPLETE`, and separately report confidence as `HIGH`, `PARTIAL`, or `FAILED`
- reconciliation should compare new exchange-backed balance/position snapshots against the prior persisted snapshots plus local fill history to surface unexplained portfolio drift
- reconciliation should treat Upbit order-level `paid_fee` as fill-fee evidence when individual trade fills omit fee data, so normal trading fees do not become unexplained KRW drift
- reconciliation may tolerate at most 1 KRW of residual KRW dust after fee-adjusted fill explanation, but larger unexplained KRW movement must remain explicit drift evidence
- reconciliation fill windows must compare parsed timestamp instants so exchange timestamps with offsets are not ordered as raw text
- reconciliation may use a bounded one-second start-window grace only when an otherwise-drifting fill window is fully explained by a nearby exchange fill, because Upbit trade timestamps can be rounded to whole seconds while local snapshots are millisecond-precise
- reconciliation must recheck stored canceled `bid`/`price` market-buy records when local evidence shows executed volume, because Upbit can report filled market buys as `cancel` after dust-sized KRW or fee lock remains
- market-buy quote amounts must preserve decimal intent through eight places and truncate only excess places before decision persistence, order persistence, and transmission. The execution boundary requires a positive explicit decision notional, a matching canonical `price`, and null `volume`; canonical-but-different wire amounts are rejected before persistence. Reconciliation may apply only that same observed eight-place `bid`/`price` equivalence for legacy recovery; it must still reject any mismatch within that precision and every UUID, identifier, market, side, order-type, time-in-force, or SMP mismatch
- reconciliation must not query Upbit for local `DRY_RUN` adapter artifacts such as `dryrun_*` UUIDs; those records must be repaired locally and remain visibly simulated
- simulated `DRY_RUN` fills must not be used as exchange-balance explanations in portfolio drift detection
- partial fills, cancel requests, rejects, and unresolved states must remain queryable
- a typed or untyped exception from `createOrder` is uncertain unless it is a clear definitive exchange rejection; `duplicate_identifier` remains `RECONCILIATION_REQUIRED` so recovery can query by identifier without resending
- uncertain submission recovery is lookup-only. Each UUID-first/identifier-fallback found, not-found, and transient observation is persisted with an injected-clock timestamp; transient errors never count as absence, and every potentially dispatched `SUBMITTING`, `RECONCILIATION_REQUIRED`, `FAILED`, or `REJECTED` row requires both persisted count and elapsed-time bounds before an atomic compare-and-set failure, audit event, and fault pause. Recovery never resumes execution or releases the retained lease.
- an `ORDER_SUBMISSION_ABSENCE_CONFIRMED` `FAILED` row is a completed recovery conclusion and must be excluded before the next run constructs or budgets exchange lookup candidates
- terminal BTC candidate evidence may advance only from a persisted `STRATEGY` order with a valid persisted deployment binding and PositionGuard decision, terminal `FILLED` or `CANCELED` lifecycle, nonzero aggregate fills, and confirmed per-fill KRW fees on every fill. Exact decimal evidence is persisted atomically with candidate-state CAS and audit data; legacy, allocated, missing, or conflicting provenance faults and pauses instead of substituting values or retrying execution.
- a candidate projection fault event is disposed only with its matching persisted automatic fault-pause transition. A restart must atomically repair standard or recovered-projection event-written/pause-missing states without changing immutable event time; the repair transition uses an explicit attempt time raised atomically to at least the current execution-state time. A terminal no-fill marker cannot suppress later durable fills, which require projection or an explicit fault. Malformed persisted deployment activation data must enter this fault path rather than aborting the sweep.
- normal candidate recovery-fault persistence keeps strict caller-supplied chronology and rejects backdated timestamps. Its exact input shape has no timestamp-advancement option. Only the dedicated `pauseForCandidateIntentFault` capability may resolve a canonical occurrence time, and only after validating exact `CANDIDATE_INTENT_FAULT_V1` provenance, an allowed `DUPLICATE`/`DERIVATION`/`PERSISTENCE` stage, request-bound deployment/account/decision/order/binding identities, the stage-specific reason, and the deterministic SHA-256 fault ID. Inside the same serialized transaction that capability advances the immutable attempted time to exactly one nanosecond after the latest deployment or audit chronology when required; ordinary pause semantics and fault provenance remain unchanged.
- if post-send local persistence fails, retain the durable `SUBMITTING` order and lease, attempt an automatic pause, and fail the run rather than retrying transmission

## Operator Controls

The operator surface should expose:
- `/help`
- `/config`
- `/readiness`
- `/status`
- `/statehistory`
- `/synchistory`
- `/recovery`
- `/alerts`
- `/risks`
- `/balances`
- `/positions`
- `/orders`
- `/order <order-id|identifier>`
- `/scheduler`
- `/inbound [detail]`
- `/pause`
- `/resume`
- `/killswitch`
- `/sync`
- `/preview BTC|ETH`
- `/run BTC|ETH`

These commands exist for control and inspection, not for manual portfolio editing.
`/help` is static command-contract inspection only and must not trigger sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission.
`/config` is non-secret runtime configuration inspection only; it may expose live blockers, explicit risk limits, and ignored deprecated environment variable names, but must not print raw credentials, tokens, or chat identifiers.
Localized `/config` must call a credential required only when the feature depending on it is enabled; disabled optional Telegram or exchange-read features must not be presented as configuration failures.
Localized `/statehistory`, `/synchistory`, and `/recovery` are presentation over the same bounded persisted reads. They must preserve canonical evidence, must not add active probes or mutations, and must not describe historical or partial archive evidence as current exchange truth.
`/readiness` is read-only operator readiness inspection only; it may summarize blockers, warnings, and bounded local persistence health such as active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count, but must not actively probe Upbit or Telegram, mutate offset state, trigger sync, run strategies, tick schedulers, submit orders, cancel orders, or deliver notifications.
When live order transmission is intentionally configured, `/readiness` should warn that `/run` is real-order capable rather than treating the live send path itself as a blocking health failure. Paused, kill-switched, degraded, active-order, unresolved-order, and blocking reconciliation states must still remain `BLOCK`.
When a `LIVE` scheduler is enabled, `/readiness` must warn if the latest persisted balance snapshot, position snapshot, or reconciliation run is stale relative to the shortest configured scheduler interval. It remains read-only and must not run `/sync` to refresh those records.
Reconciliation recovery progress such as recovered historical exchange orders and fill backfills may be reported as `WARN`; unresolved portfolio drift, missing order references, lookup failures, deferred lookups, or recovery-required orders remain `BLOCK`.
Inbound polling must stay disabled by default, must reject non-private chats and require both the text-command source chat ID and sender ID to equal `TELEGRAM_OPERATOR_CHAT_ID` before routing commands, and may persist only Telegram update-offset progress as transport state. Rejected updates still advance the durable offset so unauthorized commands cannot be replayed.
Inbound transport failures exposed through runtime status must redact Telegram bot-token paths, bearer credentials, and secret-bearing query values before persistence in memory or operator display.
Inline-button callbacks must require both the callback source chat ID and sender ID to equal the configured operator chat ID. Callback data must be limited to Telegram's 64-byte boundary and parsed into a closed read-only action union; mutation commands such as run, sync, pause, resume, and kill switch must not be representable. The update offset must be persisted before callback acknowledgement or handling so acknowledgement failure is explicit but cannot replay the callback.
Valid callback navigation must execute in the order offset persistence, callback acknowledgement, bounded read-only lookup, and originating-message edit. It must never call the generic text command route or operator-state transition, sync, preview, run, exchange-write, order-write, scheduler-tick, or notification-delivery dependencies. Callback edit output must remain within an explicit 3,500-character transport cap after HTML escaping and wrapper markup; the complete slash-command technical detail remains available separately.
Telegram command-menu registration is display metadata, not execution authority. Replacing localized commands must not invoke the router, transition operator state, run sync or strategy, call Upbit, create or mutate orders, or change scheduler behavior. Missing setup configuration is an explicit skip; Telegram setup rejection is an isolated secret-free failure and must not block scheduler or inbound startup.
Inbound polling may split long command replies into multiple Telegram messages to satisfy transport limits; such splitting is not execution state and must not change command semantics.
`/inbound` and `/inbound detail` are inspection-only. The default summary may compare one in-memory status snapshot with one persisted offset record, while detail preserves canonical technical fields. Neither form may call Telegram polling, start or stop the polling worker, trigger command routing, mutate offset state, call Upbit, run sync or strategy, mutate orders, or change execution state.
Localized `/pause`, `/resume`, and `/killswitch` responses are presentation over the existing persisted transition only. They must preserve canonical blocker codes and must not imply that `/resume` clears an active kill switch or that real orders are available while any execution blocker remains.
Localized `/sync` responses are presentation over exactly one existing reconciliation-controller result. They must preserve canonical status, raw request time, and exact detail, must not describe `COMPLETED` as proof of drift-free reconciliation, and must not run a second sync or add exchange, repository, strategy, scheduler, order, execution-state, or notification side effects.
The Telegram inbound smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable scheduler starts, and execute only one bounded poll.
The dry-run readiness smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable scheduler starts, read only local persisted readiness evidence, and never run `/sync`, run strategy, poll Telegram, call Upbit, deliver notifications, or transmit orders.
The dry-run sync smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable Telegram delivery and inbound polling, disable scheduler starts, require Upbit read credentials, and run only exchange-backed `/sync` plus read-only inspection commands. It may persist balance snapshots, position snapshots, reconciliation runs, risk evidence from drift detection, and recovery records, but it must not run strategy or transmit orders.
The dry-run operator smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, clear Upbit private read credentials for the process, disable Telegram delivery and inbound polling, disable scheduler starts, use fixture public market data, and never transmit live orders. It may persist local DRY_RUN snapshots and strategy decisions because it routes `/sync` and `/run BTC|ETH` through the operator surface.
The PositionGuard public backtest command is research-only. It may call Upbit public candle endpoints and run the pure offline replay/report path, including offline diagnostic comparisons such as buy-and-hold benchmark, monthly returns, regime return contribution, skip-reason counts, and trade diagnostics, but it must not read or write the local execution database, poll or deliver Telegram, call Upbit private endpoints, create strategy decisions in persistence, create order intents, mutate order lifecycle records, or transmit live orders. It fetches public timeframe groups sequentially and may use bounded 429 retry/backoff for Upbit public rate limits; this retry behavior is quotation-read handling only, not an execution retry.
Its default replay contract requires 200 completed candles for every timeframe and a 220-day warmup, preventing performance reports from silently evaluating EMA200-dependent rules with missing EMA200 inputs. If a full candle page still has not reached the requested history start when the explicit page limit is exhausted, the research run must fail instead of publishing a truncated performance report.
The local DRY_RUN scheduler launcher may enable scheduled strategy cycles and `RUN_ON_START=true` only after an explicit local DRY_RUN scheduler confirmation. It must keep `APP_EXECUTION_MODE=DRY_RUN`, keep `ENABLE_LIVE_ORDERS=false`, require Upbit and Telegram credentials locally, run exchange-backed DRY_RUN sync/readiness checks before startup, and stop before runtime startup when either smoke returns `BLOCK`.
The dry-run completion smoke command must force `DRY_RUN`, force `ENABLE_LIVE_ORDERS=false`, disable Telegram delivery and inbound polling, disable scheduler starts, require Upbit and Telegram credentials to be configured, and read only persisted completion evidence. It must block when latest snapshots, latest reconciliation, active-order state, recent risk blocks, pending operator notifications, or latest BTC/ETH scheduler-run completion evidence are unsafe or missing.
`/preview BTC|ETH` is a non-mutating strategy preview; it may compute deterministic decision evidence and order intent, but must not persist a strategy decision, create an order intent, run reconciliation, or transmit an order.
Localized `/preview BTC|ETH` output is presentation over that single controller result. It must preserve canonical values and the exact no-mutation boundary, distinguish no-order `HOLD` results from order intents, preserve Upbit market-buy/market-sell/limit semantics, and must not imply execution, recalculate sizing, add state reads, or promise that a later real-order-capable `/run` will produce the same result.
`/run BTC|ETH` is a controlled strategy trigger, not discretionary manual trading; it must produce deterministic strategy evidence and pass the same risk and execution guards as any scheduled cycle. In `LIVE`, manual `/run` must first pass persisted-health preflight over live gate, adapter wiring, execution state, Upbit read credentials, fresh balance and position snapshots, fresh latest reconciliation, active-order state, and blocking reconciliation issue codes before invoking the strategy runner.
Borderline bullish `DEFERRED_CONFIRMATION` decisions are observation records, not order intents. They are stored as `PENDING_CONFIRMATION`, and only a later deterministic `EXECUTED_AFTER_CONFIRMATION` decision may enter the execution and risk pipeline.
Localized `/run BTC|ETH` output must preserve the exact controller result and canonical fields, state that LIVE mode may transmit a real order, and never describe `submissionAccepted=true` as a fill or guaranteed completion.
When the strategy has no open position for the asset, bearish invalidation or breakdown evidence should remain a no-order `HOLD` rather than producing an `EXIT` or `REDUCE` order intent.
For open positions, PositionGuard may create staged risk-reducing `REDUCE` decisions when weak-downtrend, breakdown-risk, or range-deterioration evidence appears only with a profit buffer and a reduce value above the configured minimum trade value; these are deterministic sell intents and must still pass the normal execution and risk pipeline.
`/order <order-id|identifier>` is inspection-only and must read persisted order lifecycle evidence without creating, canceling, syncing, or retrying orders.
`/scheduler` is inspection-only; it may read current scheduler runtime status and persisted scheduler run history but must not trigger or retry strategy cycles.
The strategy scheduler is disabled by default, must use explicit intervals, and must share the same deterministic runner, duplicate protection, execution-state guardrails, and live-send blockers as `/run BTC|ETH`.
When the scheduler is enabled in `LIVE` mode, startup must run an automatic preflight before installing timers. It must block on dry-run adapter wiring, disabled live gate, non-running/degraded/paused/killswitched operator state, missing Upbit read credentials, missing or stale balance or position snapshots, missing or stale latest reconciliation evidence, active or reconciliation-required orders, and blocking reconciliation issue codes. The freshness threshold is the shortest configured scheduler interval, so automatic trading cannot start from older account-health evidence than its own cadence. Historical exchange-order recovery progress can remain a warning when no portfolio drift or unresolved order recovery is present.
Before every `LIVE` scheduled tick, the scheduler must run an exchange-backed account-health refresh that may persist balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`. The refresh is not a strategy run and must not create order intents or transmit orders.
The same persisted-health preflight must then run before every `LIVE` scheduled tick. If the refresh fails or the preflight blocks, the scheduler must persist a failed scheduler-run record and operator notification without invoking the strategy runner, creating a strategy decision, or creating an order intent.
When BTC and ETH scheduled timers become due at the same time, scheduler-triggered market cycles must be queued for the exchange account so a healthy second market cycle is not marked `ALREADY_RUNNING` only because the first market is still inside the account-scoped runner.
When a `LIVE` scheduled market cycle submits an order, later market cycles from the same one-second scheduler batch must be persisted as `SKIPPED` and deferred to their next interval before another strategy decision can be created.
The product does not require a ritualized manual first order before scheduler startup; the safety contract is the explicit preflight plus the same per-order risk and execution guards used by `/run BTC|ETH`.
A standalone live scheduler preflight smoke may assume scheduler-enabled startup preflight and report whether timers would be allowed, but it must not start the runtime, install timers, run a strategy cycle, run `/sync`, poll Telegram, call Upbit, or transmit orders.
A standalone live readiness smoke must require an explicit positive-safe-integer `LIVE_READINESS_MAX_EVIDENCE_AGE_MS`. It must pass evidence whose age equals that limit, warn on older or missing account-health evidence so an otherwise safe scheduler-disabled runtime can be started only for an approved `/sync`, and block malformed, future, or uncomparable evidence and a missing freshness policy.
A confirmed duplicate-owner probe may verify the configured LIVE database identity read-only and attempt only the production Windows named-pipe process lock. It must report success only when contention rejects it, immediately release and block if no active owner exists, fail closed if release fails, render no database path, scope digest, or credential evidence, and never construct the application, write SQLite, run migrations, start workers, call APIs, or transmit orders.
A live startup script must run the live readiness smoke before runtime startup and refuse to start when the smoke reports a blocking failure.
A live scheduler startup script must require a separate explicit automatic-scheduler confirmation, keep `STRATEGY_SCHEDULER_RUN_ON_START=false` by default, and run the scheduler preflight smoke before starting the runtime.
Windows Task Scheduler registration helpers must remain manual-only. They may point to ignored local launcher scripts, but must not include API keys, Telegram secrets, startup/logon triggers, catch-up triggers, or automatic task starts after registration.

## Prospective Research Guardrails

The prospective component-shadow protocol must remain disconnected from API clients, operational SQLite/DB, Upbit acquisition, Telegram, orders, reconciliation, scheduler/runtime, migrations, secrets, and LIVE process control. Its only subprocess capability is the explicit read-only Git allowlist required to inspect commitment history and verify the exact clean implementation checkout; it cannot checkout, fetch, push, mutate refs, or execute a non-Git process.

Registration preview is not a registration or approval path. It must remain a pure, non-binding calculation with no writer, Git, network, database, Upbit, Telegram, scheduler, strategy, sync, order, or process-control access; its output must explicitly state that no write occurred and that actual registration resamples time.

The experiment uses the fixed 120-day `[2026-08-23T08:00:00.000Z,2026-12-21T08:00:00.000Z)` no-peek window. Publication A must already contain the implementation and workflow on public `origin/main`; the registration is frozen against that commit and reserves 72 hours before `from`; Publication B then adds only the canonical registration and registry entry. The Publication B Actions evidence uses the exact run's REST `created_at`, must prove at least 48 hours of public lead time, remains non-cryptographic, and requires manual public-run confirmation plus external preservation beyond ephemeral artifact retention. Final evaluation also requires a public closure run at or after `to` plus separate manual closure and public-path-history confirmation. `PCS-2026-001` is publicly registered, and neither registration nor any prospective status grants deployment, strategy-change, `DRY_RUN`, `LIVE`, scheduler, or order approval.

Candidate policy and state modules remain pure, configuration-free, and execution-disconnected. Their reconciliation-only terminal-evidence projector has no order-send, resume, or lease-release authority; current percentage-based sizing and all execution guards are unchanged.

## Audit Expectations

Every important transition should leave a durable trail:
- strategy decision creation
- risk rejection
- order persistence
- exchange submission response
- fill ingestion
- reconciliation summary
- balance drift and position drift findings
- kill-switch or pause transitions
- `DEGRADED` mark/clear transitions during bootstrap health policy
- operator notification delivery attempts, including `SENT` / `FAILED`, `deliveredAt`, and `lastError`
- operator notification delivery attempt history, including `RETRY_SCHEDULED` / `STALE_LEASE`, attempt timestamps, and follow-up retry timing
- operator notification retry metadata, including `attemptCount`, `lastAttemptAt`, `nextAttemptAt`, and `failureClass`
- operator notification lease metadata, so concurrent workers can only finalize rows they claimed
- operator notification delivery-worker run records, including skipped, completed, and failed worker executions
- operator notification follow-up delivery passes when new due notifications are kicked during an in-flight worker run
- derived operator notification queue metrics, including active leases, expired leases, abandoned-lease candidates, recent delivery-run summaries, and recent delivery-attempt outcomes
- strategy scheduler run records, including started, completed, failed, and skipped scheduler-triggered cycles
- scheduler operator notifications for failed scheduled cycles, overlapping-run skips, and scheduler-triggered order submission or rejection
- scheduler startup-block notifications when live scheduler preflight refuses to install automatic timers
- scheduler per-run account-refresh or preflight block notifications before any scheduled strategy decision or order intent is created
- Telegram inbound offset records, including the next update offset and last update id for replay prevention

Telegram delivery failure must not alter execution, reconciliation, or risk outcomes. It is an operator-reporting concern with its own durable state.
Retryable delivery failures should remain explicit as `PENDING` plus future `nextAttemptAt`, not silently disappear.
Concurrent delivery workers should only finalize a notification when the persisted lease token still matches the worker claim.
Delivery kicks requested during an active inline worker run should not strand due `PENDING` notifications; they should trigger a follow-up worker pass.
Long-running runtime shutdown should be explicit: signal handling must stop inbound polling, clear scheduler timers, and close SQLite persistence. Cleanup failures should be visible as partial shutdown failures instead of being swallowed.
SQLite migration application must not expose schema effects without the matching `_schema_migrations` authority row. Migration transaction structure is validated rather than rewritten heuristically; schema and ledger changes commit atomically, foreign-key enforcement is restored, and historical ledger repair requires exact canonical schema compatibility. Unknown, malformed, or incompatible partial migration state blocks startup instead of being silently recorded as applied.

## Current Implementation Note

This repository now enforces the policy through pure guard logic, durable SQLite persistence, persisted execution-state controls, startup recovery sweep plus `/sync` reconciliation, checkpointed exchange-history recovery with bounded stop-before coverage reporting, retention-assumption confidence semantics, page-limit truncation flags, and lookup-failure confidence records, startup `DEGRADED` policy for unresolved portfolio drift, instant-based fill/snapshot drift windows with bounded Upbit timestamp precision grace, execution prechecks through Upbit `orders/chance` and `orders/test`, reference-price notional derivation for market sell minimum-value checks, exposure cap projection that treats `ask` orders as risk-reducing, immediate simulated `FILLED` settlement for supported `DRY_RUN` orders, local repair for older `DRY_RUN` adapter artifacts, local `FILLED` mapping and terminal recheck repair for Upbit filled `bid`/`price` dust-cancel snapshots, a persisted-evidence DRY_RUN completion gate for the automatic scheduler rehearsal, automatic live scheduler startup preflight, scheduled account-health refresh with `SCHEDULER_PREFLIGHT` reconciliation evidence, per-run preflight with persisted-health freshness checks and durable block notifications, queued scheduled market cycles for simultaneous BTC/ETH timers, one-second same-batch live scheduler deferral after an order submission, manual live `/run` preflight, and durable `operator_notifications` with separately gated Telegram delivery retry/backoff, lease-based compare-and-set finalization, separate delivery-attempt history, delivery-worker run records, and derived claim/abandon queue metrics. The `PositionGuard_PaperTrade` runner can now preview decisions through Telegram `/preview BTC|ETH`, persist decisions and route eligible decisions into the default `DRY_RUN` execution lifecycle through Telegram `/run BTC|ETH`, and run through a disabled-by-default scheduler with persisted scheduler run history. Its REDUCE path treats `riskLevel` as a derived summary rather than a separate weakness score input and keeps losing/range positions on HOLD when only borderline bearish momentum is present without independent weakening evidence. The live send path remains intentionally disabled until explicit runtime configuration enables it.
