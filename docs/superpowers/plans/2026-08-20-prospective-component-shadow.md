# Prospective Component Shadow Implementation Plan

> **Required workflow:** Execute behavioral Tasks 1-6 with
> `superpowers:test-driven-development` and all implementation with
> `superpowers:subagent-driven-development`. Task 7's architecture
> characterization is an explicit RED/GREEN exception. Do not commit or push
> until the user explicitly requests it.

**Goal:** Add a future-only, preregistered, read-only research tool that can
evaluate the two frozen component ablations after a fixed 120-day window,
without touching operational SQLite, Upbit, Telegram, the LIVE process, or the
strategy runtime.

**Architecture:** Keep all policy and calculations in pure performance modules.
Use narrow filesystem and local-Git adapters only at the research CLI boundary.
Reuse immutable candle/no-trade/backtest/FIFO/episode contracts, but start every
prospective path from the exact registered flat virtual portfolio at
`window.from`. A GitHub Actions workflow provides an auditable public
commitment record; the offline evaluator additionally requires explicit human
verification and never calls GitHub.

**Tech stack:** TypeScript strict mode, Node.js 22 ESM, `node:test` through the
repository harness, SHA-256 from `node:crypto`, filesystem operations from
`node:fs/promises`, local read-only Git commands through an injected runner,
GitHub Actions with read-only repository permissions.

**Authoritative design:**
`docs/superpowers/specs/2026-08-20-prospective-component-shadow-design.md`

## Global Safety And Implementation Rules

- Do not import `app`, `execution`, `exchange`, `reconciliation`, `telegram`,
  migrations, runtime scheduler, or writable DB modules from prospective files.
- The offline CLI/evaluator must not open SQLite, call Upbit/Telegram/GitHub
  APIs, or inspect/control a LIVE process. The external workflow alone may call
  the exact read-only Actions endpoint for its own run ID as specified below.
- Do not create the real `PCS-2026-001` registration during implementation.
  First land and publicly push the implementation/workflow in a later,
  user-approved `implementationCommitSha`. Registration creation and its public
  `publicationCommitSha` are a separate operator step; publication must be the
  implementation commit's direct child and change only registration/registry.
- Keep `COMBINED_CONSERVATIVE` as reference and test only
  `COMBINED_MINUS_EARLY_THESIS_FAILURE` and
  `COMBINED_MINUS_COOLDOWN_CONTROL`.
- Preserve the exact 24-path matrix, `[from,to)` boundary, initial portfolio,
  cost cells, support threshold, tolerances, and status precedence from the
  design.
- Never coerce missing evidence to zero. Reject malformed/non-finite evidence
  and preserve explicit unknown/incomplete reasons.
- Tests may use temporary directories and synthetic candles only. They must not
  read `var/company-live.sqlite`.
- All new values returned by pure modules must be detached and deeply frozen.
- Every focused test follows: write test, prove expected failure, implement the
  minimum behavior, prove pass, then refactor.

## Task 1: Frozen Registration Contract

**Owner:** Registration contract agent. No other task edits these files.

**Files:**
- Create: `src/modules/performance/performance-prospective-shadow-registration.ts`
- Create: `tests/performance-prospective-shadow-registration.test.ts`

**Interfaces:**

```ts
export const PROSPECTIVE_SHADOW_AUTHORITY =
  "PROSPECTIVE_COMPONENT_SHADOW_V1" as const;
export const PROSPECTIVE_SHADOW_EXPERIMENT_ID = "PCS-2026-001" as const;

export interface CreateProspectiveShadowRegistrationInput {
  readonly registeredAt: string;
  readonly implementationCommitSha: string;
  readonly developmentAuthoritySha256: string;
  readonly retrospectiveReportSha256: string;
  readonly policyManifest: RegisteredPolicyManifest;
}

export function createProspectiveShadowRegistration(
  input: CreateProspectiveShadowRegistrationInput,
): ProspectiveShadowRegistration;
export function validateProspectiveShadowRegistration(
  value: unknown,
): ProspectiveShadowRegistration;
export function serializeProspectiveShadowRegistration(
  registration: ProspectiveShadowRegistration,
): string;
export function parseProspectiveShadowRegistry(
  bytes: string,
): ProspectiveShadowRegistry;
export function serializeProspectiveShadowRegistryEvent(
  event: ProspectiveShadowRegistryEvent,
): string;
```

### Step 1: Write failing contract tests

Cover:
- exact constants, scenario/timing/cost/asset ordering and 24-path count
- whole-hour start at least 72 hours after registration, preserving a separately enforced 48-hour public-commitment lead
- exact-hour and fractional-hour boundary examples
- exactly `10_368_000_000` ms end
- exact initial state and 5,000 KRW minimum
- implementation commit identity is distinct from later publication commit
- canonical `REGISTERED`/`ABANDONED` event schema, order, parser, and stable
  newline serialization shared by writer and commitment validator
- stable canonical serialization and payload SHA-256
- detached/deeply frozen output
- changed/reordered/extra matrix member rejection
- timezone-free, invalid calendar, over-nanosecond, non-finite, negative zero,
  malformed hash, and invalid commit rejection

Use a simple exact-hour case such as registration at
`2026-01-01T00:00:00Z`, start `2026-01-04T00:00:00Z`, and end exactly 120
fixed days later. Add a non-hour case to prove ceiling behavior.

### Step 2: Prove the test fails

```powershell
npm.cmd run build
node --test dist/tests/performance-prospective-shadow-registration.test.js
```

Expected: compile/module failure because the registration contract is absent.

### Step 3: Implement the smallest valid contract

- Reuse the repository timestamp parser for explicit-timezone validation.
- Freeze all constants in canonical order.
- Compute `window.from` from parsed epoch time, not string manipulation.
- Canonicalize the payload without its checksum, hash UTF-8 bytes, then attach
  the checksum.
- Validate by reconstructing canonical payload and comparing the checksum.
- Clone caller data before validation and deep-freeze the returned result.

### Step 4: Prove focused tests pass

Run the same two commands and confirm zero failures.

## Task 2: Atomic Registration And Registry Publication

**Owner:** Registration writer agent. It may import Task 1 but edits only these
files.

**Files:**
- Create: `src/modules/performance/performance-prospective-shadow-registration-writer.ts`
- Create: `tests/performance-prospective-shadow-registration-writer.test.ts`

**Interfaces:**

```ts
export interface ProspectiveShadowRegistrationWriterDependencies {
  readonly now: () => string;
  readonly randomSuffix: () => string;
  readonly fs: ProspectiveShadowRegistrationFileSystem;
}

export async function publishProspectiveShadowRegistration(
  input: PublishProspectiveShadowRegistrationInput,
  dependencies: ProspectiveShadowRegistrationWriterDependencies,
): Promise<PublishedProspectiveShadowRegistration>;
export async function appendProspectiveShadowAbandonment(
  input: AppendProspectiveShadowAbandonmentInput,
  dependencies: ProspectiveShadowRegistrationWriterDependencies,
): Promise<PublishedProspectiveShadowAbandonment>;
```

### Step 1: Write failing writer tests

Cover:
- production time sampled exactly once through the injected clock
- exclusive reservation of the fixed final directory, a unique hidden
  in-progress/owner marker, and exactly two canonical files after commit:
  `PCS-2026-001.registration.json` and `registry.jsonl`
- one canonical newline-terminated registry entry
- self-read and checksum verification before publication
- marker removal as the only logical commit point; marker-present or partial
  directories are always invalid
- no overwrite when final directory exists
- concurrent writer race leaves one valid publication
- injected write/read/rename failures remove only this invocation's temp path
- no partial final registration or registry on failure
- pre-commit cleanup only after owner-marker revalidation, and crash residue is
  rejected rather than adopted
- repository/docs/research/final symlink or junction escape rejection
- caller mutation during awaited I/O cannot change published bytes
- explicit abandonment appends exactly one `ABANDONED` event under an exclusive
  lock, preserves registration/prior registry bytes, and rejects duplicate,
  ID/hash mismatch, and `abandonedAt >= window.to`

### Step 2: Prove failure

```powershell
npm.cmd run build
node --test dist/tests/performance-prospective-shadow-registration-writer.test.js
```

### Step 3: Implement atomic publication

- Materialize detached registration and registry bytes before the first await.
- Create the fixed final directory exclusively, write its unique owner marker
  first, then write and read back both canonical files. Remove the marker last
  only after full validation; no marker-free partial state is valid.
- On pre-commit failure, remove the final directory only after re-reading the
  unique owner marker. Never adopt or alter an existing marker-free directory.
- Resolve and inspect each path component, rejecting symlink/junction escapes.
- For explicit abandonment only, acquire a uniquely owned non-empty lock
  directory, validate
  unchanged registration and expected prior registry bytes, write and verify a
  replacement registry in a temp file, atomically replace only `registry.jsonl`,
  and always release only the owned lock. After replacement commits, return
  cleanup warnings without reporting the committed operation as failed; before
  commit, preserve explicit failure semantics and cleanup details.

### Step 4: Prove pass

Run the focused commands again.

## Task 3: Public Git Commitment Evidence

**Owner:** Commitment agent. No shared CLI/package edits in this task.

**Files:**
- Create: `src/modules/performance/performance-prospective-shadow-commitment.ts`
- Create: `src/research/prospective-shadow-git-commitment-reader.ts`
- Create: `src/research/prospective-shadow-commitment.ts`
- Create: `tests/performance-prospective-shadow-commitment.test.ts`
- Create: `tests/prospective-shadow-git-commitment-reader.test.ts`
- Create: `tests/prospective-shadow-commitment-cli.test.ts`
- Create: `.github/workflows/prospective-shadow-registration.yml`

**Interfaces:**

```ts
export function validateProspectiveShadowCommitment(
  input: ValidateProspectiveShadowCommitmentInput,
): ValidatedProspectiveShadowCommitment;

export interface ReadOnlyGitRunner {
  run(args: readonly string[]): Promise<ReadonlyGitResult>;
}

export async function readProspectiveShadowGitEvidence(
  input: ReadProspectiveShadowGitEvidenceInput,
  runner: ReadOnlyGitRunner,
): Promise<ProspectiveShadowGitEvidence>;
```

### Step 1: Write failing pure commitment tests

Cover exact repository, `main`, distinct implementation/publication commits,
registration path, payload hash, registry uniqueness, workflow run ID/URL/server
time, exact implementation checkout, and publication `git show` byte equality.
Cover:
- publication commit has exactly one parent and it is the implementation commit
- publication changed paths are exactly registration and registry
- workflow bytes are identical in implementation and publication commits
- server-created run at and after `window.from` rejection
- duplicate/replaced/abandoned/unpublished registration rejection
- missing or wrong `I_VERIFIED_PUBLIC_GITHUB_COMMITMENT`
- manual verification before the run rejection
- mismatched public run URL rejection
- assurance label exactly `HUMAN_VERIFIED_PUBLIC_GITHUB_RUN`
- explicit `cryptographicallyVerified: false`
- both commit SHAs present and equal across metadata/manual verification
- Actions REST response is for the exact run ID/repository/branch/head SHA and
  provides authoritative `created_at`; runner clock/commit timestamps rejected
- close-time workflow run is at/after `window.to`, publication is its ancestor,
  canonical path history is complete, and registry is `ACTIVE_AT_CLOSE`
- optional abandonment has one parent, changes only registry, preserves
  registration/workflow bytes, adds exactly one event, and its GitHub run
  `created_at` is before `window.to`
- stale/missing closure metadata or missing exact
  `I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE` rejection

### Step 2: Write failing local-Git adapter tests

Use a fake runner and assert the allowlist contains only read operations such as
`rev-parse`, `show`, and ancestry checks. Reject all ref mutation, checkout,
fetch, push, network URL, shell fragment, or unexpected argument requests.
Prove output bytes are detached across awaits.

### Step 3: Implement pure validation and read-only Git adapter

- Keep GitHub metadata caller-supplied and offline.
- Treat human verification as auditable provenance, not cryptographic proof.
- Never authenticate by trusting filename or user-provided booleans alone.
- Parse JSON strictly and reject duplicate registry entries.

### Step 4: Implement the narrow workflow/metadata CLI

The CLI validates only committed registration/registry bytes and emits stable
metadata from GitHub context plus the read-only response for its exact run ID.
The workflow must:
- trigger only on `main` changes to the canonical registration/registry paths
- declare only `permissions: { contents: read, actions: read }`
- use `actions/checkout` with `fetch-depth: 0`
- select exactly one validation mode from event/path history:
  `REGISTERED_PUBLICATION` requires publication parent = implementation and the
  exact registration+registry diff; `ABANDONED` requires one parent, a
  registry-only diff, unchanged registration/workflow, and exactly one new
  abandonment event; `CLOSURE` is manual, read-only, and changes no tracked file
- use no secrets
- use only the automatic `GITHUB_TOKEN` to call the read-only workflow-run
  endpoint for `github.run_id`, verifying returned identity before trusting
  `created_at`
- build and run only the narrow validator
- upload the JSON metadata artifact and print it in logs
- never run app startup, SQLite tests, data acquisition, or any network request
  other than the exact read-only Actions lookup for its own run ID
- support a manual close-time dispatch that emits the latest relevant path
  history and active/abandoned registry closure metadata

### Step 5: Prove focused tests and workflow invariants

```powershell
npm.cmd run build
node --test dist/tests/performance-prospective-shadow-commitment.test.js
node --test dist/tests/prospective-shadow-git-commitment-reader.test.js
node --test dist/tests/prospective-shadow-commitment-cli.test.js
```

Also add textual assertions in the CLI test for workflow triggers,
permissions, forbidden commands, every invalid event/diff-mode combination,
and a closure followed by a public relevant-path commit whose workflow is
failed/disabled/missing. That stale closure must be `REGISTRATION_INVALID` once
the required manual public-path-history verification is applied.

## Task 4: Pure Prospective Status Evaluation

**Owner:** Evaluation policy agent. It imports registration/commitment types but
does not edit their files.

**Files:**
- Create: `src/modules/performance/performance-prospective-shadow-evaluation.ts`
- Create: `tests/performance-prospective-shadow-evaluation.test.ts`

**Interfaces:**

```ts
export function evaluateProspectiveComponentShadow(
  input: ProspectiveShadowEvaluationInput,
): ProspectiveShadowEvaluation;
```

The input contains validated registration and commitment evidence, explicit
initial-publication evidence, validated close-time registry evidence, explicit
`asOf`, and normalized per-asset path/episode/completeness evidence. The
evaluator does no replay and no I/O.

### Step 1: Write failing status-policy tests

Cover:
- before-end `COLLECTING` with no replay/outcome metrics exposed
- exact `asOf === window.to` transition to final evaluation
- 9 vs 10 known-net closed episodes for reference and candidate per cell
- 9 episodes plus harmful delta remains `INSUFFICIENT`
- 10 episodes on both paths plus complete harmful metric evidence is
  `REJECTED` even when an unrelated gate is incomplete
- open episodes excluded from support
- known return, drawdown, turnover, or fee harm yields `REJECTED` even when an
  unrelated gate is incomplete
- absent known harm plus any gap yields `INSUFFICIENT`
- complete/non-worse/no meaningful return benefit yields `REJECTED`
- complete/non-worse plus at least one qualifying return improvement yields
  `SUPPORTS_CONTINUED_SHADOW`
- exact tolerance boundaries and named percentage-point/KRW units
- each candidate and BTC/ETH adjudicated independently
- missing fees/lifecycle/cadence/feature/no-trade evidence remains incomplete
- no cross-asset vote
- invalid registration/commitment fails without a completed output
- missing/stale close-time registry evidence, abandonment, or missing manual
  closure verification fails `REGISTRATION_INVALID`
- non-finite/negative-zero/corrupt relationship rejection
- detached/deeply frozen result and caller-mutation invariance

### Step 2: Prove failure

```powershell
npm.cmd run build
node --test dist/tests/performance-prospective-shadow-evaluation.test.js
```

### Step 3: Implement explicit precedence

Implement final status in this order only:
1. invalid authority throws `REGISTRATION_INVALID`
2. directional harm -> `REJECTED` only when the reference and candidate each
   have at least 10 known-net closed episodes in that cell and every compared
   harmful metric is complete
3. any incomplete gate/support -> `INSUFFICIENT`
4. complete evidence with no qualifying net-return benefit -> `REJECTED`
5. otherwise -> `SUPPORTS_CONTINUED_SHADOW`

Store all reasons as stable codes plus technical details. Do not use truthy
metric shortcuts; validate every numeric field and unit.

### Step 4: Prove pass

Run focused tests again.

## Task 5: Future-Window Replay And Evidence Builder

**Owner:** Replay agent. It must not edit runtime strategy files.

**Files:**
- Create: `src/modules/performance/performance-prospective-shadow-replay.ts`
- Create: `tests/performance-prospective-shadow-replay.test.ts`

**Interfaces:**

```ts
export function buildProspectiveShadowReplayEvidence(
  input: BuildProspectiveShadowReplayEvidenceInput,
): ProspectiveShadowReplayEvidence;
```

### Step 1: Write failing replay tests

Build small immutable candle/no-trade fixtures and cover:
- exactly 24 ordered paths
- warmup candles influence indicator features but produce no decisions, fills,
  portfolio changes, episodes, cooldown, or ADD state
- all paths reset at `window.from` to registered 1,000,000 KRW and zero position
- no carry-in inventory or episode
- exact `[from,to)` decision/fill boundary
- appending/changing candles at or after `to` cannot change features, coverage,
  relationships, metrics, or status
- `collectedAt < to` rejection and exact complete cadence/no-trade coverage
- exact BASE/STRESS costs and SAME_CLOSE/NEXT_FRAME timing
- only the three registered scenarios; HTF and ADD_LIMITED remain active
- partial exits preserved in episodes and FIFO slices
- direct episode match by unique exact first ENTER epoch-nanoseconds
- duplicate entry key rejection, no fallback cross-path match
- stable fill-ID ordering for valid same-side intra-path ties
- unknown fees/lifecycle evidence remains explicit
- asynchronous caller mutation invariance where any sidecar reader is async

### Step 2: Prove failure

```powershell
npm.cmd run build
node --test dist/tests/performance-prospective-shadow-replay.test.js
```

### Step 3: Implement with existing research-only contracts

- Validate and clip datasets/no-trade evidence before frame construction.
- Build feature-bearing frames with registered warmup, then pass only frames in
  `[from,to)` to the counterfactual runner. This permits indicator warmup but
  prevents pre-window state mutation.
- Create a fresh registered virtual portfolio for every asset/scenario/timing/
  cost path.
- Reuse the existing pure counterfactual, FIFO, diagnostics, and episode
  attribution helpers; extract a small pure helper only if required.
- Assert the replay matrix exactly matches registration before returning.

### Step 4: Prove pass and legacy compatibility

```powershell
npm.cmd run build
node --test dist/tests/performance-prospective-shadow-replay.test.js
node --test dist/tests/strategy-counterfactual.test.js
node --test dist/tests/performance-holdout-episode-attribution.test.js
node --test dist/tests/performance-component-ablation.test.js
```

## Task 6: Research CLI And Stable Reports

**Owner:** CLI integration agent. It may edit only the files listed here.

**Files:**
- Modify: `src/research/prospective-component-shadow.ts` (create if absent)
- Create: `tests/prospective-component-shadow-cli.test.ts`
- Modify: `package.json`

**CLI contract:**

```text
npm.cmd run research:prospective-shadow -- register ...
npm.cmd run research:prospective-shadow -- abandon ...
npm.cmd run research:prospective-shadow -- inspect ...
npm.cmd run research:prospective-shadow -- evaluate ...
```

### Step 1: Write failing CLI tests

Cover:
- `register` accepts only explicit authority inputs and fixed output root
- `abandon` requires explicit reason and time, preserves registration bytes,
  appends one canonical registry event, and cannot reuse the experiment ID
- `inspect` before end returns registration/calendar progress only and never
  invokes replay
- `evaluate` before end also returns `COLLECTING` without outcome metrics
- final evaluation requires both datasets, both sidecars, commitment metadata,
  initial manual verification, close-time registry metadata/manual verification,
  and exact implementation commit checkout
- stable JSON and human-readable text
- BTC/ETH sections independent
- exact provenance, checksums, path fingerprints, safety booleans, and reason
  codes retained
- no report file on failure
- exclusive no-overwrite report publication
- CLI import has no execution/runtime/SQLite/network side effect

### Step 2: Prove failure

```powershell
npm.cmd run build
node --test dist/tests/prospective-component-shadow-cli.test.js
```

### Step 3: Implement orchestration

- Parse arguments without hidden time/money defaults.
- Obtain registration time exactly once for `register`.
- Route `abandon` only through the locked append-only writer and never evaluate
  or replay as part of abandonment.
- For `inspect`, validate registration and compute only calendar progress.
- For final `evaluate`, clone inputs, validate commitment, build replay evidence,
  evaluate status, format text/JSON, then atomically publish research output.
- Lead text with non-deployment boundary and do not soften `INSUFFICIENT`.
- Add only research scripts to `package.json`; do not alter `start`, smoke, or
  runtime scripts.

### Step 4: Prove focused tests pass

Run the focused commands again and inspect representative JSON/text snapshots.

## Task 7: Dependency Guard, Suite Wiring, And Documentation

**Owner:** Integration/documentation agent. This task owns all shared wiring to
avoid overlapping agent edits.

**Files:**
- Modify: `tests/run-all.ts`
- Create: `tests/prospective-shadow-dependency-boundary.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `RISK_POLICY.md`
- Modify: `ORDER_LIFECYCLE.md` only if needed to state explicit non-integration

### Step 1: Add an architecture characterization test

Statically walk prospective source imports and assert no dependency on app,
execution, exchange, reconciliation, telegram, migration, scheduler, SQLite,
Upbit acquisition, or operational DB files. Also assert prospective files are
not imported by `src/index.ts`, app creation, scheduler, strategy runtime, or
Telegram commands.

### Step 2: Run characterization, then wire all new tests

Add all new test imports to `tests/run-all.ts` only after focused suites pass.
This is a characterization/safety test rather than a behavior TDD RED/GREEN
cycle: it may pass immediately when the implementation correctly preserved the
boundary. If it fails, first add a focused regression assertion for the leaked
edge, then remove the dependency.

### Step 3: Update authoritative docs

Document:
- prospective research purpose and exact non-runtime boundary
- two-stage public commitment procedure: first land workflow/code, then create
  and publicly commit registration before its future window
- manual public Actions verification and non-cryptographic limitation
- read-only workflow-run REST lookup for GitHub server `created_at`, plus the
  mandatory at/after-end public registry closure run and manual confirmation
- fixed 120-day no-peeking horizon and statuses
- no SQLite/API/Telegram/order/LIVE-process behavior
- no result grants deployment or live approval

### Step 4: Run integrated tests

```powershell
npm.cmd run typecheck
npm.cmd run build
node --test dist/tests/prospective-shadow-dependency-boundary.test.js
npm.cmd test
```

## Task 8: Independent Review And Final Verification

**Owner:** Main agent for integration and safety; separate review agents inspect
metric correctness and the operational boundary. Review agents do not edit the
same files concurrently.

### Step 1: Main-agent contract audit

Trace registration -> publication -> commitment -> replay -> evaluation ->
report. Check all exact constants, status precedence, time boundaries, cost
units, support counts, BTC/ETH independence, and deep immutability.

### Step 2: Independent correctness review

Assign one review agent to verify prospective causality/no-peeking, episode/FIFO
separation, tolerance math, support policy, and status precedence. Fix all
Critical/Important findings with a new failing regression test first.

### Step 3: Independent safety review

Assign another review agent to verify no operational SQLite, API, Telegram,
runtime, order, scheduler, process-control, or secret path is reachable. Fix all
Critical/Important findings with a regression test first.

### Step 4: Safe CLI smoke with synthetic artifacts only

Create a temporary Git repository or temporary checkout with its own working
directory, then run `register`, pre-window `inspect`, and synthetic post-window
evaluation using the same canonical relative path inside that temporary repo.
Do not add an arbitrary output-root option, do not create the canonical artifact
in the real repository, and do not use operational data.

### Step 5: Final verification

```powershell
npm.cmd run typecheck
npm.cmd test
git diff --check
git status --short
```

Record:
- focused and full test counts/results
- changed files
- generated synthetic artifact hashes
- subagents and their owned files
- reviewer findings and fixes
- confirmation that no operational DB/API/LIVE/process-control path ran
- confirmation that no real registration, commit, or push occurred

## Recommended Execution Order

1. Run Task 1 first to freeze registration and shared authority names.
2. Run Tasks 2 and 3 in parallel after Task 1; their write scopes are disjoint.
3. Run Task 4 after Task 3 commitment types stabilize.
4. Run Task 5 after Tasks 1 and 4 stabilize.
5. Run Task 6 after Tasks 2-5.
6. Run Task 7 as the single owner of shared test/docs/package integration
   (`package.json` remains owned by Task 6; coordinate its final handoff).
7. Main agent performs Task 8 and final integration.

No task includes a Git commit. Commit and push remain a separate explicit user
decision. After implementation is publicly pushed, actual experiment
registration and public commitment must be performed as a second, explicitly
confirmed operation before `window.from`.
