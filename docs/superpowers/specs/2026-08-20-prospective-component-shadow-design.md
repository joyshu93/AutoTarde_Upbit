# Prospective Component Shadow Design

## Purpose

Create a research-only prospective shadow protocol that tests two pre-registered
component hypotheses on evidence that did not exist when the hypotheses were
chosen. The protocol must not change PositionGuard rules, execution state,
scheduler behavior, Telegram behavior, operational persistence, or Upbit state.

This is a fresh prospective experiment. The retrospective development, holdout,
and component-ablation reports may justify which hypotheses are registered, but
they are never observations in the prospective result.

## Safety Boundary

- The feature is offline and manually invoked.
- It does not import from `app`, `execution`, `exchange`, `reconciliation`,
  `telegram`, runtime scheduler, migration, or writable DB modules.
- It does not open the operational SQLite database.
- It does not call Upbit private/public APIs or Telegram APIs.
- The offline CLI/evaluator never calls GitHub. The external commitment
  workflow alone may make one authenticated read-only Actions REST request for
  its own run ID to obtain GitHub's server `created_at`; it receives only the
  automatic `GITHUB_TOKEN` with `actions: read` and `contents: read`.
- It does not create, cancel, test, or inspect exchange orders.
- It does not start, pause, resume, or inspect a LIVE process.
- It does not modify strategy runtime files or local secret/configuration files.
- Registration and reports are local research artifacts only.
- Every result sets `readOnly: true`, `causalClaim: false`,
  `deploymentApproval: false`, and `liveApproval: false`.
- No result authorizes DRY_RUN, LIVE, shadow-runtime wiring, deployment, or a
  strategy rule change.

## Why A New Protocol Is Required

The existing component-ablation report was designed after observing the
retrospective holdout. Its directional associations cannot be promoted into a
prospective conclusion. A valid next test must freeze the hypotheses, replay
contract, costs, time boundary, support threshold, and decision rules before
any eligible candle is observed.

The current retrospective evidence nominates only these two ablations:

1. `COMBINED_MINUS_EARLY_THESIS_FAILURE`
2. `COMBINED_MINUS_COOLDOWN_CONTROL`

`COMBINED_CONSERVATIVE` is the reference path. HTF trend gating and
`ADD_LIMITED` remain part of every registered path because removing them was
directionally harmful in the retrospective evidence. `STRICT_PULLBACK` is not
part of `COMBINED_CONSERVATIVE` and is not tested.

No scenario, threshold, or combination may be added after registration.

## Immutable Registration

The registration authority is `PROSPECTIVE_COMPONENT_SHADOW_V1` and its single
experiment identifier is `PCS-2026-001`. The only valid registration location
is `docs/research/prospective-shadow/PCS-2026-001.registration.json`; copies at
other paths are not authorities. A canonical registration artifact contains:

- schema and authority version
- explicit `registeredAt` with an ISO-8601 timezone
- `window.from` and exclusive `window.to`
- the exact ordered scenario list
- independent BTC and ETH market identities
- exact ordered timing models
- exact ordered BASE and STRESS cost cells
- exact per-asset initial state: `1,000,000` KRW cash, zero BTC/ETH quantity,
  no open episode, zero ADD count, and inactive cooldown
- minimum order value `5,000` KRW
- the canonical `BROAD_LOSS_CAUSE_V1` policy manifest, ordered component set,
  thresholds, action precedence, development/warmup start, and their SHA-256
- implementation authority `implementationCommitSha`; this is the public
  `origin/main` commit containing the workflow and the complete Git tree for
  manifest parsing, frame construction, decisions, modeled fills, FIFO
  matching, and metrics before registration artifacts are added
- the development authority and retrospective report SHA-256 values used only
  to explain hypothesis nomination
- support and comparison policy
- canonical payload SHA-256
- the interpretation and safety boundary

`window.from` is the first whole UTC hour at least 72 hours after
`registeredAt`. This preparation buffer permits Publication B to complete while
the validator independently requires its GitHub server `created_at` to be at
least 48 hours before `window.from`.
`window.to` is exactly `10,368,000,000` milliseconds (120 fixed 24-hour days)
after `window.from`. The 120-day horizon matches
the scale of the retrospective holdout while preventing optional stopping.
The evaluator must not extend, shorten, or roll this window. If support is
insufficient at `window.to`, the result is `INSUFFICIENT`; another experiment
requires a new authority version and a new future window.

The registration writer is no-overwrite and verifies its own serialized output
before publication. It accepts an injected clock for deterministic tests but
the production CLI obtains the registration time once and records it. The
writer may create only the fixed registration directory and its own temporary
or lock artifacts. It reserves the final directory itself with exclusive
creation, immediately writes a unique hidden in-progress/owner marker, writes
and verifies the two canonical artifacts, and removes the marker last as the
logical publication commit point. A reader must reject any directory while the
marker exists or either canonical artifact is absent, so a partial directory is
never valid publication. Pre-commit cleanup removes a directory only after
re-verifying its unique owner marker; a crash residue requires explicit
inspection and is never silently adopted. The writer rejects symlink/junction
components and verifies real-path containment under the repository root. It
never opens SQLite or a network client. A separate explicit abandonment
operation may later replace only `registry.jsonl` under an exclusive non-empty
lock directory after validating the unchanged registration and prior registry
bytes; it appends one canonical `ABANDONED` event and cannot create a new
registration. Once registry replacement commits, cleanup failures are reported
as explicit warnings rather than an ambiguous failed abandonment.

Local creation alone does not activate the experiment. Registration uses two
public commits with distinct roles. First, `implementationCommitSha` containing
the implementation and workflow must already be pushed to canonical public
`origin/main`. Second, the exact registration and one initial `REGISTERED`
registry entry mapping `PCS-2026-001` to its payload SHA-256 are added in
`publicationCommitSha` and pushed before `window.from`.
`publicationCommitSha` must have exactly one parent,
`implementationCommitSha`, and its complete changed-path set must be exactly
the canonical registration and `registry.jsonl`; the workflow bytes must be
identical in both commits. A dedicated GitHub Actions workflow, already present
in the implementation commit, triggers only when the canonical registration or
registry changes. It checks out full history with `fetch-depth: 0`, validates
the parent relationship, changed-path allowlist, fixed ID/path, payload
checksum, unique initial registry entry, exact committed bytes, and both commit
identities, then emits machine-readable commitment metadata containing the
GitHub run ID/URL, server-created run time, repository, branch, implementation
commit SHA, publication commit SHA, registration path, and payload SHA-256. A
successful run created at least 48 hours before `window.from` is the external timestamped
commitment. The workflow obtains its authoritative `created_at` by querying the
GitHub Actions workflow-run REST endpoint with the exact `github.run_id`, using
only the automatic `GITHUB_TOKEN` with `actions: read` and `contents: read`. It
verifies the returned run ID, repository, branch, and head SHA before emitting
metadata. Runner wall-clock, author timestamp, and committer timestamp are not
commitment time. The workflow receives no trading or user-managed secrets and
never runs the app, tests that open SQLite, market-data acquisition, or any
execution path.

Evaluation requires the downloaded commitment metadata as an immutable local
input. It runs the implementation from an exact `implementationCommitSha`
checkout and reads registration/registry bytes from the local Git object for
`publicationCommitSha`. It verifies that current `HEAD` is the implementation
commit, `git show <publicationCommitSha>:<path>` matches the registration
bytes, the publication commit's sole parent is the implementation commit, its
changed paths are exactly the two canonical artifacts, workflow bytes are
identical in both commits, all commitment identities match, and the GitHub
server run time precedes `window.from`. The evaluator does not call GitHub or
any other network service.
The operator must preserve the successful workflow metadata and public run URL
outside ephemeral Actions artifact retention.

At or after `window.to`, final evaluation also requires a public registry
closure run from the same workflow's manual `workflow_dispatch` entry point.
That run obtains its own GitHub server `created_at`, verifies that the original
publication commit is an ancestor of canonical `main`, enumerates every change
to the canonical registration and registry since publication, confirms the
registration and workflow bytes are unchanged, and classifies the registry as
`ACTIVE_AT_CLOSE` or `ABANDONED`. An optional abandonment commit may appear
after unrelated commits, but it must have one parent, change only
`registry.jsonl`, preserve the one original `REGISTERED` event, add exactly one
canonical `ABANDONED` event, and have a successful server-timestamped workflow
run created before `window.to`. The closure run must be created at or after
`window.to`; it emits closure tip SHA, relevant path history, registry bytes and
hash, classification, and any abandonment run identity.

Because the downloaded metadata is not cryptographically authenticated by the
offline evaluator, final evaluation also requires a mandatory manual commitment
verification record. The operator must open the canonical public Actions run,
compare repository, branch, run ID, server-created time, implementation commit
SHA, publication commit SHA, path, and payload SHA-256, then supply the exact
confirmation
`I_VERIFIED_PUBLIC_GITHUB_COMMITMENT` together with `verifiedAt` and the public
run URL. Results label this assurance
`HUMAN_VERIFIED_PUBLIC_GITHUB_RUN`, never `CRYPTOGRAPHICALLY_VERIFIED`. Missing
manual verification, an inaccessible/mismatched public run, or a confirmation
record created before the Actions run fails registration validation. The
confirmation is auditable provenance, not automated proof, and the report must
state this limitation prominently.

Final evaluation separately requires the exact confirmation
`I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE`, a `verifiedAt` not earlier than the
closure run, and the public closure-run URL. The operator confirms that this is
the canonical public closure run at or after `window.to`, that its repository,
branch, run ID, server time, closure tip, path history, and registry hash match,
and that no later canonical registration/registry workflow run supersedes it.
The operator must also inspect public `origin/main` path history directly at
`verifiedAt`: the latest public commits and hashes for the registration and
registry must equal the closure metadata, and no later commit may touch either
path, whether a workflow succeeded, failed, was disabled, or never ran. Any
later relevant-path commit makes the closure stale. This remains human-verified
provenance rather than cryptographic proof, is current only through
`verifiedAt`, and must be labeled with that limitation. Missing or stale closure
metadata/confirmation fails `REGISTRATION_INVALID`.

There may be only one `REGISTERED` registry event and one registration payload
for `PCS-2026-001` in canonical `origin/main`. Abandonment is an optional second
`ABANDONED` registry event with an explicit reason, event time, registration
payload SHA-256, and the original publication commit; it does not permit reuse
of the ID, window, or authority version. The `abandon` CLI is the only writer
for that event, preserves registration bytes, and refuses duplicate or
`abandonedAt >= window.to`. The abandonment workflow's GitHub server
`created_at`, not caller-supplied `abandonedAt`, determines whether it was
published before the window closed. Any valid abandonment makes final evaluation fail
`REGISTRATION_INVALID`. A missing, duplicate, replaced, unpublished, or
late-published commitment likewise fails evaluation and produces no
prospective result. Public Git history makes abandoned
registrations visible, while the server-created Actions run time prevents a
locally backdated clock from activating a late registration. This mechanism is
an auditable external commitment, not an RFC 3161 trusted timestamp.

## Evidence Admission

The evaluator accepts caller-supplied immutable BTC and ETH candle datasets and
their authenticated no-trade sidecars. Existing dataset and sidecar validation
contracts remain authoritative.

Final evaluation evidence is admitted only when all of the following hold:

- the registration checksum is valid
- initial commitment and final registry-closure metadata/manual confirmations
  are valid for the canonical public history
- BTC and ETH dataset and sidecar identities match their declared markets
- each dataset was collected at or after `window.to`
- each dataset covers the exact registered feature warmup and prospective window
- the prospective score uses only decisions and fills in `[window.from,window.to)`
- candles before `window.from` initialize indicators only; no pre-window
  decision or modeled fill may mutate portfolio or episode state
- at `window.from`, every path starts from the exact identical registered cash,
  zero-position, zero-episode, zero-ADD, and inactive-cooldown state
- no candle, no-trade interval, decision, or fill at or after `window.to` enters
  a metric, coverage gate, relationship, classification, or status
- missing hours are covered only by authenticated no-trade evidence; candles
  are never synthesized or interpolated

Data before `window.from` may initialize deterministic feature state but cannot
create a strategy decision, intervention, position, episode, trade, return,
fee, cooldown, ADD count, or action attribution. Consequently prospective paths
have no carry-in inventory or carry-in episode. An episode still open at
`window.to` is reported but excluded from known closed-PnL statistics.

Before `window.to`, the CLI may inspect only registration identity, calendar
progress, and artifact integrity. It returns `COLLECTING` without replaying or
displaying candidate/reference outcome metrics. The evaluator receives an
explicit `asOf` timestamp, records it in provenance, and never substitutes a
hidden wall-clock value. Once `asOf` is at or after `window.to`, final evaluation
requires both datasets to declare `collectedAt >= window.to` and complete
coverage through the exclusive end. This prevents interim peeking from changing
the registered candidates or stopping rule.

## Frozen Replay Matrix

BTC and ETH use independent capital and are never pooled. Each asset runs the
following exact matrix:

- scenarios, ordered:
  - `COMBINED_CONSERVATIVE`
  - `COMBINED_MINUS_EARLY_THESIS_FAILURE`
  - `COMBINED_MINUS_COOLDOWN_CONTROL`
- timing models, ordered:
  - `SAME_CLOSE_MODELED`
  - `NEXT_FRAME_MODELED`
- cost cells, ordered:
  - `BASE`: fee rate `0.0005`, slippage rate `0.0003`
  - `STRESS`: fee rate `0.001`, slippage rate `0.002`

This produces 12 prospective paths per asset and 24 paths overall. The
registration embeds the exact strategy thresholds, active components, action
precedence, minimum order value, and frame-builder authority. Commitment
evidence binds the complete implementation Git tree. Evaluation must run from
the exact `implementationCommitSha` checkout; registration bytes come from the
verified publication commit. A different `HEAD` is rejected instead of
silently using changed strategy or metric code. The evaluator must reject missing, extra,
reordered, renamed, or
numerically altered paths before replay.

## Episode And Metric Semantics

FIFO realization slices and flat-to-flat position episodes remain separate.
Partial exits stay in their original episode. Direct episode matching uses only
a unique exact first executed `ENTER` decision instant represented as an
explicit-timezone epoch-nanosecond value. A duplicate entry key is rejected; no
secondary cross-path tie-break is invented. Stable fill-ID ordering applies
only to otherwise valid same-side fills inside one path. Matching does not use
overlapping ranges, path-local IDs, or fill IDs as cross-path identity.

Each path reports:

- completed prospective episode count
- open episode count
- net return ratio
- realized gross and net PnL
- maximum realized drawdown ratio
- turnover and modeled fees in KRW
- position-episode and FIFO-lot win/loss/breakeven counts
- payoff ratio and profit factor when mathematically defined
- maximum losing streak
- average/minimum/maximum holding duration
- time in market
- action contribution for ENTER, ADD, REDUCE, and EXIT
- complete episode and FIFO realization evidence

Missing fees, lifecycle gaps, non-finite metrics, unmatched exits, and unknown
closed net outcomes remain explicit. They are never
converted to zero or silently excluded.

## Frozen Decision Policy

The minimum support is exactly 10 known-net-PnL completed prospective episodes
for both the reference and candidate in every timing/cost cell of an asset.
Directional harm is sufficiently known only when that same cell has at least
10 such episodes for both paths and every metric used for the harmful
comparison is complete. A harmful delta with 1-9 episodes is not known harm and
therefore remains `INSUFFICIENT`; known harm may override a different,
unrelated incomplete gate only after this support and metric-completeness rule
is satisfied.

Result statuses are:

- `COLLECTING`: explicit `asOf` is before `window.to`. Only registration and
  calendar progress are displayed; replay and outcome metrics are unavailable.
- `INSUFFICIENT`: the window is complete but any cadence, feature, no-trade,
  initial-state, lifecycle, fee, finite-metric, or episode-support requirement is
  incomplete.
- `REJECTED`: any comparison with sufficient evidence to establish directional
  harm is worse than the reference on net return or maximum drawdown beyond the
  frozen tolerance, or increases turnover/fees beyond the frozen KRW tolerance,
  even when a separate gate remains incomplete. Complete supported evidence is
  also `REJECTED` when no cell improves net return beyond the frozen
  percentage-point tolerance.
- `SUPPORTS_CONTINUED_SHADOW`: evidence is complete and supported; every cell
  is non-worse than the reference on net return, maximum drawdown, turnover,
  and fees; and at least one cell has a net-return improvement beyond the
  frozen percentage-point tolerance.

The frozen tolerances remain:

- return/drawdown: `0.000001` percentage points
- turnover/fees: `0.000000001` KRW

Each candidate is adjudicated independently for BTC and ETH. A supported result
for one asset does not support the other asset. There is no cross-asset vote or
combined portfolio status.

`SUPPORTS_CONTINUED_SHADOW` means only that another explicitly designed
observation phase may be considered. It is not permission to change code,
enable a runtime shadow path, or trade.

After the window closes, status precedence is exhaustive and conservative:

1. invalid registration or authority fails evaluation
2. any known harmful comparison yields `REJECTED`, even if another independent
   evidence gate is incomplete
3. absent known harm, any incomplete gate or insufficient support yields
   `INSUFFICIENT`
4. complete evidence with no meaningful net-return improvement yields
   `REJECTED`
5. only complete, supported, non-worse evidence with at least one qualifying
   net-return improvement yields `SUPPORTS_CONTINUED_SHADOW`

## Components And File Boundaries

### Registration contract

`src/modules/performance/performance-prospective-shadow-registration.ts`

- defines the exact manifest types and frozen constants
- validates explicit timestamps, ordering, numeric values, hashes, and window
- creates a detached deeply frozen registration value
- canonicalizes and verifies the registration SHA-256 payload
- owns canonical `REGISTERED` and `ABANDONED` registry event types, parsing,
  ordering, and stable serialization shared by all writers/readers

### Registration artifact writer

`src/modules/performance/performance-prospective-shadow-registration-writer.ts`

- serializes stable JSON
- verifies before publication
- reserves the final directory exclusively and uses a verified hidden
  in-progress/owner marker whose removal is the logical publication commit
- removes only its own temporary artifact on failure
- appends an explicit canonical abandonment event under an exclusive lock while
  preserving registration bytes and all prior registry events
- rejects symlink/junction escapes and distinguishes committed cleanup warnings
  from pre-commit failures

### Prospective evaluator

`src/modules/performance/performance-prospective-shadow-evaluation.ts`

- validates exact matrix and evidence coverage
- consumes completed replay paths and episode attribution evidence
- applies the frozen status policy as a pure function
- returns detached, deeply frozen results with complete provenance

### Research orchestration and CLI

`src/research/prospective-component-shadow.ts`

- exposes exactly `register`, `abandon`, `inspect`, and `evaluate` commands
- `register` only stages the two canonical artifacts; `abandon` only appends a
  canonical registry event under the writer lock; `inspect` before close shows
  registration/calendar integrity only; `evaluate` performs replay only after
  all close-time evidence is valid
- reuses existing immutable dataset, no-trade, replay, FIFO, and diagnostic
  contracts
- reads and writes research artifacts only
- does not open SQLite or instantiate exchange, Telegram, or runtime services

### Git commitment reader

`src/research/prospective-shadow-git-commitment-reader.ts`

- reads only local Git object and ancestry evidence through an injected command
  boundary
- never fetches, pushes, checks out, modifies refs, or accesses the network
- returns bytes and commit/tree identities to the pure registration validator
- requires human-verifiable canonical remote publication provenance
- distinguishes implementation, publication, and optional abandonment commits
- validates caller-supplied close-time tip/path-history evidence from local Git
  objects without fetching or claiming that local refs prove public freshness

### External commitment workflow

`.github/workflows/prospective-shadow-registration.yml`

- runs only for canonical registration/registry changes on `main`
- also supports manual close-time `workflow_dispatch`
- uses no trading/user-managed secrets and has only `contents: read` and
  `actions: read` for its automatic `GITHUB_TOKEN`
- invokes a narrow checksum/uniqueness validator, not application runtime code
- verifies full-history parentage, the two-path publication diff, and unchanged
  workflow bytes between implementation and publication commits
- has three exclusive validation modes:
  `REGISTERED_PUBLICATION` requires publication parent = implementation and the
  exact two-artifact diff; `ABANDONED` requires one parent, a registry-only diff,
  unchanged registration/workflow, and exactly one new abandonment event;
  `CLOSURE` is manual read-only history inspection with no tracked-file change
- emits server-time commitment metadata in logs and a downloadable artifact
- calls only the read-only Actions endpoint for its exact own run ID to obtain
  and verify GitHub server `created_at`
- never fetches market data, opens SQLite, starts services, or sends orders

The existing integrated report may share pure types/helpers after targeted
extraction, but this work must not add another prospective subsystem inside the
already large `integrated-strategy-evaluation.ts`. Any extraction must preserve
legacy JSON/text output byte-for-byte when prospective inputs are absent.

## Output Contract

Stable JSON contains:

- registration and artifact checksums
- exact datasets, sidecars, collection times, and replay fingerprints
- exact `[from,to)` and observed-as-of time
- safety booleans and interpretation boundary
- per-asset, per-candidate status and reason codes
- every timing/cost path metric and completeness gate
- complete episode attribution and unmatched/open evidence
- reference deltas in percentage points and KRW with units named explicitly
- data-quality warnings and omitted/unknown metric reasons

Text output leads with the experiment state, remaining/finished window,
evidence completeness, sample support, and non-deployment warning. It then
summarizes BTC and ETH independently and retains exact IDs and provenance in a
technical section. Text presentation must not soften `INSUFFICIENT` or describe
`SUPPORTS_CONTINUED_SHADOW` as an approval.

## Validation And Failure Behavior

Reject explicitly:

- malformed or timezone-free timestamps
- invalid calendar dates or fractional precision beyond nanoseconds
- `NaN`, `Infinity`, negative zero, negative price/quantity/cost evidence
- changed registration payload or checksum
- evidence collected before the exclusive window ends
- datasets, sidecars, assets, markets, costs, timing models, or scenarios that
  do not match registration
- incomplete registered feature warmup or prospective cadence
- future evidence entering an earlier calculation
- corrupt cross-path episode or realization relationships
- caller mutation during asynchronous reads

Failures produce no completed output artifact and never fall back to a changed
scenario, threshold, time range, cost, or initial state.

## Test Strategy

Implementation follows TDD. Required tests include:

- canonical registration and checksum stability
- at-least-48-hour publication lead, whole-hour start, and exact 120-day end
- canonical Git commitment, duplicate registration, late publication, and
  abandonment evidence
- close-time registry metadata, active/abandoned classification, latest public
  closure manual confirmation, and stale closure rejection
- distinct implementation/publication commit identities, exact parentage,
  publication changed-path allowlist, and unchanged workflow bytes
- mandatory public-run manual verification, mismatched confirmation, and
  explicit non-cryptographic assurance labeling
- no-overwrite writer and cleanup after failure/race
- altered/reordered scenario, timing, or cost rejection
- pre-registration and post-window evidence exclusion
- dataset collected before `window.to` rejection
- warmup-only pre-window processing and exact identical state reset at `from`
- open episode exclusion from support
- exact epoch-nanosecond episode matching, duplicate-key rejection, and
  same-side intra-path fill ordering
- partial exits and FIFO realization preservation
- `COLLECTING`, `INSUFFICIENT`, `REJECTED`, and
  `SUPPORTS_CONTINUED_SHADOW` boundaries
- minimum 10-episode boundary at 9 and 10
- 9 supported episodes plus a harmful delta remains `INSUFFICIENT`, while 10
  supported episodes plus complete harmful metric evidence is `REJECTED` even
  when an unrelated gate is incomplete
- return, drawdown, turnover, and fee directional failures
- missing fee/lifecycle/cadence/no-trade/feature evidence
- BTC/ETH independence
- future candle mutation invariance
- future feature-coverage and status mutation invariance
- asynchronous caller mutation invariance
- stable JSON and text output
- operational dependency graph exclusion
- full migrated-schema compatibility where shared read-only contracts apply

Final validation runs `npm.cmd run typecheck`, focused tests, the complete test
suite, and `git diff --check`. If an operational DB hash is inspected, it is
read-only and must remain byte-identical. No runtime process-control command is
needed for this feature.

## Explicit Non-Goals

- changing the LIVE PositionGuard strategy
- creating a shadow branch inside the scheduler
- paper or real orders
- automatic candle acquisition
- API calls
- Telegram commands or notifications
- operational database tables or migrations
- parameter search, candidate expansion, or best-result selection
- combining BTC and ETH performance
- deployment or LIVE approval
- trusted-timestamp automation; public Git publication is auditable commitment
  evidence with its limitation stated explicitly
