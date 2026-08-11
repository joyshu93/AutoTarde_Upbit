# Immutable Research Candle Dataset Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking, every implementation task follows TDD, and the main agent performs contract and safety integration review.

**Goal:** Add a standalone research command that creates checksum-verified, immutable BTC or ETH `1h`/`4h`/`1d` public candle datasets without coupling to LIVE execution or operational SQLite.

**Architecture:** A pure builder converts normalized historical candles into the existing validated research dataset schema. A narrow acquisition service reuses the existing public historical pagination boundary, while a separate filesystem adapter and research CLI provide explicit argument validation, no-overwrite persistence, and secret-free summaries. No runtime module imports the new path.

**Tech Stack:** TypeScript strict mode, Node.js built-ins, existing `UpbitPublicTickerClient`, existing PositionGuard public candle pagination, existing research dataset parser/checksum, repository test harness.

## Global Constraints

- Do not call Upbit during implementation tests or final verification.
- Do not open SQLite or inspect/mutate the operational database.
- Do not call Telegram, sync, scheduler ticks, strategy runtime, migrations, private exchange, or order APIs.
- Do not modify local secret files, live launcher scripts, execution state, strategy rules, or runtime wiring.
- Do not import this feature from `src/index.ts`, app creation, execution, scheduler, Telegram, reconciliation, or strategy runtime modules.
- The eventual operator-invoked CLI may call only unauthenticated Upbit public candle endpoints.
- Require explicit `--asset`, `--history-start`, `--end`, `--output`, `--page-size`, and `--page-limit` arguments.
- Refuse to overwrite an existing output artifact.
- Preserve exact explicit-timezone instant semantics and exact `1h`, `4h`, and `1d` elapsed durations.
- Do not interpolate candles or retain an interval that crosses either requested boundary.
- Do not commit or push until the user separately requests it.

## File Map And Ownership

- `src/modules/performance/research-candle-dataset-builder.ts`: pure filtering, ordering, signing, serialization, and parser round-trip.
- `tests/research-candle-dataset-builder.test.ts`: builder correctness and corruption cases.
- `src/modules/performance/upbit-research-candle-acquisition.ts`: injected-reader historical acquisition and result metadata.
- `tests/upbit-research-candle-acquisition.test.ts`: request, pagination, failure, and boundary tests.
- `src/modules/performance/research-candle-dataset-writer.ts`: exclusive verified filesystem publication.
- `src/research/upbit-candle-dataset.ts`: argument parsing, orchestration, real public-client construction, and CLI summary.
- `tests/upbit-candle-dataset-cli.test.ts`: argument, side-effect ordering, artifact, cleanup, and isolation tests.
- `tests/run-all.ts`: register the three new test files.
- `package.json`: add `research:candles` only.
- `README.md`, `ARCHITECTURE.md`, `PRODUCT_BOUNDARY.md`: document public research acquisition and safety boundary.

---

### Task 1: Pure Dataset Builder

**Ownership:** Builder subagent owns only the two files below plus its one `tests/run-all.ts` import. It must not edit acquisition, CLI, package, or root docs.

**Files:**
- Create: `src/modules/performance/research-candle-dataset-builder.ts`
- Create: `tests/research-candle-dataset-builder.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `SupportedAsset`, `StrategyMarketCandle`, `ResearchCandleDataset`, `calculateResearchCandleDatasetChecksum`, `parseResearchCandleDataset`, and exact timestamp comparison helpers.
- Produces:

```ts
export type BuildResearchCandleDatasetInput = {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  source: string;
  candles: Record<ResearchCandleTimeframe, readonly StrategyMarketCandle[]>;
};

export type BuiltResearchCandleDataset = {
  dataset: ResearchCandleDataset;
  json: string;
  candleCounts: Record<ResearchCandleTimeframe, number>;
};

export function buildResearchCandleDataset(
  input: BuildResearchCandleDatasetInput,
): BuiltResearchCandleDataset;
```

- [ ] **Step 1: Register a failing builder test and define valid fixture candles**

Add `await import("./research-candle-dataset-builder.test.js");` immediately after the existing research dataset test import. In the new test, import the missing builder and create BTC/ETH fixtures with at least one exact-duration candle per timeframe.

```ts
const result = buildResearchCandleDataset({
  asset: "BTC",
  historyStartAt: "2026-07-01T00:00:00.000Z",
  endAt: "2026-08-02T00:00:00.000Z",
  collectedAt: "2026-08-03T00:00:00.000Z",
  source: "upbit-public-historical-candles",
  candles: validCandles("KRW-BTC"),
});
assert.equal(parseResearchCandleDataset(result.json).provenance.sha256, result.dataset.provenance.sha256);
assert.equal(result.json.endsWith("\n"), true);
```

- [ ] **Step 2: Run the suite and confirm RED**

Run: `npm.cmd test`

Expected: TypeScript compilation fails because `research-candle-dataset-builder.ts` does not exist.

- [ ] **Step 3: Implement minimal valid signing and stable serialization**

Construct the checksum-free dataset, call `calculateResearchCandleDatasetChecksum`, serialize with `JSON.stringify(dataset, null, 2) + "\n"`, and call `parseResearchCandleDataset(json)` before returning. Derive market with `getMarketForAsset(input.asset)` and produce explicit counts for all three groups.

```ts
const signed: ResearchCandleDataset = {
  provenance: {
    ...unsigned.provenance,
    sha256: calculateResearchCandleDatasetChecksum(unsigned),
  },
  candles: unsigned.candles,
};
const json = `${JSON.stringify(signed, null, 2)}\n`;
const dataset = parseResearchCandleDataset(json);
```

- [ ] **Step 4: Run tests and confirm the valid round-trip passes**

Run: `npm.cmd test`

Expected: the valid BTC/ETH round-trip test passes while no existing tests regress.

- [ ] **Step 5: Add failing instant-boundary and deterministic-order tests**

Cover all of these independently:

- input candles supplied newest-first become oldest-first by exact epoch;
- mixed offsets order by epoch, not string;
- a candle with `openTime < historyStartAt` is excluded;
- a candle with `closeTime > endAt` is excluded;
- a candle exactly on both boundaries is retained;
- `historyStartAt >= endAt` is rejected;
- `endAt > collectedAt` is rejected;
- one empty post-filter timeframe is rejected;
- fixed input and `collectedAt` produce byte-identical JSON and checksum.

```ts
assert.deepEqual(result.dataset.candles["1h"].map(({ openTime }) => openTime), [
  "2026-08-01T09:00:00.000000001+09:00",
  "2026-08-01T00:00:00.000000003Z",
]);
assert.throws(() => buildResearchCandleDataset(futureEndInput), /endAt.*collectedAt/i);
```

- [ ] **Step 6: Implement exact filtering and validation delegation**

Use `parsePerformanceTimestamp` and `compareEpochNanoseconds`. Reject an invalid provenance timestamp before filtering. Sort cloned arrays without mutating caller input. Retain only `open >= historyStart` and `close <= end`; delegate duration, market, OHLC, finite-number, duplicate, and strict-order validation to the existing parser round-trip.

- [ ] **Step 7: Add corruption regression tests**

Assert rejection for wrong market, wrong timeframe duration, duplicate open instants, `NaN`, `Infinity`, negative volume, invalid OHLC, and timezone-less timestamps. Also assert the original input arrays remain unchanged.

- [ ] **Step 8: Run focused/full validation for Task 1**

Run: `npm.cmd test`

Expected: all builder and existing dataset tests pass.

Review gate: main agent verifies schema reuse, exact instant comparisons, immutability, and no side-effect imports. Do not commit.

---

### Task 2: Injected Public Acquisition Service

**Ownership:** Acquisition subagent owns only the two files below plus its one `tests/run-all.ts` import. It must not edit builder implementation, CLI, package, or docs.

**Files:**
- Create: `src/modules/performance/upbit-research-candle-acquisition.ts`
- Create: `tests/upbit-research-candle-acquisition.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `PositionGuardBacktestCandleReader`, `fetchPositionGuardBacktestCandles`, and `buildResearchCandleDataset` from Task 1.
- Produces:

```ts
export type AcquireUpbitResearchCandleDatasetInput = {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  pageSize: number;
  pageLimit: number;
};

export type ResearchCandleAcquisitionBoundary = {
  sqlite: false;
  privateExchange: false;
  telegram: false;
  scheduler: false;
  strategyExecution: false;
  orders: false;
};

export type AcquiredResearchCandleDataset = BuiltResearchCandleDataset & {
  asset: SupportedAsset;
  market: SupportedMarket;
  source: "upbit-public-historical-candles";
  boundary: ResearchCandleAcquisitionBoundary;
};

export async function acquireUpbitResearchCandleDataset(
  reader: PositionGuardBacktestCandleReader,
  input: AcquireUpbitResearchCandleDatasetInput,
): Promise<AcquiredResearchCandleDataset>;
```

- [ ] **Step 1: Write a failing three-timeframe request test**

Use an injected reader that records calls and returns complete fixture pages. Require exact request units `60`, `240`, and day, exact `pageSize`, and the caller's `endAt` as initial `to`.

```ts
const result = await acquireUpbitResearchCandleDataset(reader, {
  asset: "ETH",
  historyStartAt,
  endAt,
  collectedAt,
  pageSize: 200,
  pageLimit: 3,
});
assert.equal(result.market, "KRW-ETH");
assert.deepEqual(result.boundary, EXPECTED_NON_MUTATION_BOUNDARY);
```

- [ ] **Step 2: Run the suite and confirm RED**

Run: `npm.cmd test`

Expected: compilation fails because the acquisition module does not exist.

- [ ] **Step 3: Implement the minimal service**

Call `fetchPositionGuardBacktestCandles(reader, input)` with all pagination fields explicitly present, then call `buildResearchCandleDataset` using the returned normalized candle groups and fixed source label. Return the verified dataset, JSON, counts, market, source, and frozen boundary values.

- [ ] **Step 4: Run tests and confirm the success path passes**

Run: `npm.cmd test`

Expected: request and result contract tests pass.

- [ ] **Step 5: Add pagination, deduplication, and failure tests**

Use fixtures to assert overlapping pages are deduplicated, backward pagination reaches the requested history, and a page-limit exhaustion rejects with the existing explicit coverage error. Make one timeframe reader reject and assert the service rejects without returning a partial dataset.

```ts
await assert.rejects(
  acquireUpbitResearchCandleDataset(incompleteReader, input),
  /coverage did not reach historyStartAt.*pageLimit=1/i,
);
await assert.rejects(
  acquireUpbitResearchCandleDataset(failingFourHourReader, input),
  /fixture 4h failure/i,
);
```

- [ ] **Step 6: Add boundary-filter and empty-timeframe tests**

Assert the builder excludes a fetched candle crossing `historyStartAt` and rejects when the remaining group is empty. Assert no SQLite, private exchange, Telegram, scheduler, strategy-execution, or order dependency appears in this module's static imports.

- [ ] **Step 7: Run focused/full validation for Task 2**

Run: `npm.cmd test`

Expected: all acquisition and existing public-backtest tests pass.

Review gate: main agent verifies no network client construction in the service, no partial success, and correct reuse of public-only pagination. Do not commit.

---

### Task 3: Exclusive Artifact Writer And Research CLI

**Ownership:** CLI subagent owns the writer, CLI, CLI test, `package.json`, and its one `tests/run-all.ts` import. It must not modify runtime entrypoints, launch scripts, secrets, or operational modules.

**Files:**
- Create: `src/modules/performance/research-candle-dataset-writer.ts`
- Create: `src/research/upbit-candle-dataset.ts`
- Create: `tests/upbit-candle-dataset-cli.test.ts`
- Modify: `tests/run-all.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 acquisition result, `readResearchCandleDataset`, and `UpbitPublicTickerClient` only in the executable composition root.
- Produces:

```ts
export type ResearchCandleDatasetCliOptions = {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  outputPath: string;
  pageSize: number;
  pageLimit: number;
};

export type ResearchCandleDatasetCliDependencies = {
  now: () => Date;
  createReader: () => PositionGuardBacktestCandleReader;
  assertOutputAvailable: (outputPath: string) => Promise<void>;
  writeArtifact: (input: { outputPath: string; json: string }) => Promise<void>;
};

export function parseResearchCandleDatasetArgs(argv: readonly string[]): ResearchCandleDatasetCliOptions;
export async function runResearchCandleDatasetCli(
  options: ResearchCandleDatasetCliOptions,
  dependencies: ResearchCandleDatasetCliDependencies,
): Promise<ResearchCandleDatasetCliSummary>;
export async function assertResearchCandleDatasetOutputAvailable(outputPath: string): Promise<void>;
export async function writeVerifiedResearchCandleDataset(input: {
  outputPath: string;
  json: string;
}): Promise<void>;
```

- [ ] **Step 1: Write failing parser tests for the complete explicit contract**

Assert a valid invocation parses all six required values. Assert missing, duplicate, unknown, malformed numeric, unsupported asset, empty path, timezone-less timestamp, `historyStartAt >= endAt`, `pageSize` outside `1..200`, and non-positive `pageLimit` fail with stable messages.

```ts
const options = parseResearchCandleDatasetArgs([
  "--asset", "BTC",
  "--history-start", "2025-01-01T00:00:00.000Z",
  "--end", "2026-08-11T00:00:00.000Z",
  "--output", "./var/research/btc.json",
  "--page-size", "200",
  "--page-limit", "100",
]);
assert.equal(options.pageSize, 200);
```

- [ ] **Step 2: Run the suite and confirm RED**

Run: `npm.cmd test`

Expected: compilation fails because the CLI module does not exist.

- [ ] **Step 3: Implement the strict parser and orchestration ordering**

Use a closed argument-key set and reject duplicates. Parse timestamps through `parsePerformanceTimestamp`. In `runResearchCandleDatasetCli`, capture `now()` once, reject invalid dates and future `endAt`, await `assertOutputAvailable`, then and only then call `createReader()` and acquisition.

```ts
const collectedAtDate = dependencies.now();
if (Number.isNaN(collectedAtDate.getTime())) throw new Error("Research candle collection clock is invalid.");
const collectedAt = collectedAtDate.toISOString();
assertEndNotAfterCollectedAt(options.endAt, collectedAt);
await dependencies.assertOutputAvailable(options.outputPath);
const reader = dependencies.createReader();
```

- [ ] **Step 4: Add side-effect ordering tests**

Record dependency events. Assert invalid local arguments, future `endAt`, and an existing destination never call `createReader`, acquisition reader methods, or `writeArtifact`. Assert acquisition failure never calls `writeArtifact`.

- [ ] **Step 5: Implement and test exclusive verified writer**

Create the parent of the explicit output path, write a unique same-directory temporary file with exclusive creation, verify it with `readResearchCandleDataset`, and publish with `copyFile(tempPath, outputPath, constants.COPYFILE_EXCL)`. Always remove the temporary file in `finally`. A destination race must fail without replacement.

```ts
await writeFile(tempPath, input.json, { encoding: "utf8", flag: "wx" });
await readResearchCandleDataset(tempPath);
await copyFile(tempPath, input.outputPath, constants.COPYFILE_EXCL);
```

Tests use `mkdtemp` and assert:

- valid artifact is readable and checksum-valid;
- existing destination bytes remain unchanged;
- malformed JSON produces no destination;
- injected verification/copy failure leaves no matching temporary file;
- nested explicit parent directories are created;
- output JSON ends with one newline.

- [ ] **Step 6: Implement the executable composition root and summary**

Construct `UpbitPublicTickerClient` only inside default executable dependencies. Export a finite JSON summary containing service, status, asset, market, requested range, collected time, output path, counts, checksum, source, and non-mutation boundary. Use `pathToFileURL` main-module detection so test imports do not run the CLI.

```ts
export type ResearchCandleDatasetCliSummary = {
  service: "AutoTrade_Upbit";
  status: "COMPLETED";
  asset: SupportedAsset;
  market: SupportedMarket;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  outputPath: string;
  candleCounts: Record<ResearchCandleTimeframe, number>;
  sha256: string;
  source: "upbit-public-historical-candles";
  boundary: ResearchCandleAcquisitionBoundary;
};
```

- [ ] **Step 7: Add the package command and import-graph regression**

Add exactly:

```json
"research:candles": "npm run build && node dist/src/research/upbit-candle-dataset.js"
```

Test source imports recursively from `src/index.ts` and assert none resolve to the new builder, acquisition, writer, or CLI modules. Also assert the CLI source contains no private-client, DB, Telegram, execution, reconciliation, scheduler, or migration import.

- [ ] **Step 8: Run focused/full validation for Task 3**

Run: `npm.cmd test`

Expected: parser, writer, orchestration, import isolation, and all existing tests pass without network access.

Review gate: main agent verifies the public client is constructed only after local preconditions, no overwrite race is intentional, error output is secret-free, and importing the CLI has no side effects. Do not commit.

---

### Task 4: Documentation, Independent Review, And Final Verification

**Ownership:** Documentation subagent owns only the three root docs. Independent reviewers make no edits until the main agent evaluates findings. The main agent owns final integration fixes and the progress ledger.

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`
- Modify: `.superpowers/sdd/2026-08-11-immutable-research-candle-dataset-acquisition/progress.md` if the SDD ledger is created for execution

**Interfaces:**
- Consumes: final CLI arguments, summary fields, safety boundary, and package script from Tasks 1-3.
- Produces: operator instructions and explicit research boundary documentation.

- [ ] **Step 1: Update README with exact collection and evaluation workflow**

Document one BTC and one ETH example with all six required arguments. State that the command makes unauthenticated public candle requests only when manually invoked, refuses overwrite, and does not read operational SQLite. Show that the resulting paths are then supplied to `report:strategy-evaluation`; do not claim that collection itself runs a backtest.

- [ ] **Step 2: Update architecture and product boundary**

Add the pure builder, injected acquisition service, writer, and research CLI to the research-only module map. State that datasets are analysis evidence rather than trading truth and that no runtime import path may reach these modules.

- [ ] **Step 3: Run documentation consistency checks**

Run:

```text
rg -n "research:candles|history-start|page-size|page-limit|public candle|overwrite|SQLite" README.md ARCHITECTURE.md PRODUCT_BOUNDARY.md
```

Expected: all required arguments and safety statements appear consistently without undocumented defaults.

- [ ] **Step 4: Dispatch two independent read-only reviews**

Calculation review checks exact timeframe durations, complete-interval boundaries, mixed timezone ordering, checksum determinism, and pagination coverage. Safety review checks runtime isolation, no private credentials, no SQLite, no overwrite, no import side effects, and no accidental API call in tests.

Expected: reviewers return findings ordered by severity with exact file references, or explicitly report no P1/P2 findings.

- [ ] **Step 5: Apply accepted review fixes using new failing regressions first**

For each accepted issue, add a failing test that reproduces it, run `npm.cmd test` to confirm RED, apply the smallest fix, then rerun the suite to confirm GREEN. Do not make unrelated refactors.

- [ ] **Step 6: Run final repository verification**

Run:

```text
npm.cmd run typecheck
npm.cmd test
git diff --check
```

Expected: all commands exit `0`. `npm.cmd test` uses only fixture readers and temporary directories and makes no Upbit request.

- [ ] **Step 7: Verify operational non-mutation and import isolation**

Confirm no command in this implementation session opened `./var/company-live.sqlite`, called Upbit, invoked Telegram, sync, scheduler, or orders. Run a static import search from runtime roots and inspect `git diff --stat` to confirm only planned research/tests/docs/package files changed.

- [ ] **Step 8: Report completion without collecting live data**

Report implemented files, exact command contract, tests, reviewers, accepted findings, and safety verification. State that actual BTC/ETH public dataset collection remains a separate explicit operator action. Do not commit or push.

## Execution Order And Subagent Boundaries

1. Task 1 runs first because it defines the builder contract.
2. Task 2 begins after Task 1's interface review; its fixture work may be prepared in parallel without editing Task 1 files.
3. Task 3 begins after Tasks 1 and 2 contracts are accepted.
4. Documentation may begin after Task 3 exports stabilize.
5. The main agent integrates all changes, resolves `tests/run-all.ts` ownership overlap, performs both independent reviews, and runs final validation.

No subagent may modify `src/index.ts`, app/runtime modules, operational databases, local secrets, launcher scripts, or another subagent's owned implementation files.
