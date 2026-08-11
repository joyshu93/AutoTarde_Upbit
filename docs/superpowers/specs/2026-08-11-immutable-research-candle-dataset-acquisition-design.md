# Immutable Research Candle Dataset Acquisition Design

## Purpose

Build a research-only command that creates checksum-verified BTC or ETH candle datasets for the existing integrated strategy evaluation. The command acquires public Upbit candles for `1h`, `4h`, and `1d`, persists explicit provenance, and produces a local JSON artifact accepted by `readResearchCandleDataset`.

This feature prepares evidence for later `BASELINE` versus `NO_ADD` analysis. It does not change strategy rules, execution settings, or live-trading state.

## Safety Boundary

The acquisition path is isolated from the application runtime.

- It may call only unauthenticated Upbit public candle endpoints when the operator explicitly invokes the new research command.
- Its implementation and automated tests must not call Upbit. Tests use injected fixture readers and a fixed clock.
- It must not open SQLite, including the operational database.
- It must not import or invoke app creation, execution, reconciliation, risk, Telegram, scheduler, migration, private exchange, or order-lifecycle modules.
- It must not read Upbit credentials or Telegram secrets.
- It must not create, cancel, inspect, or reconcile orders.
- It must not modify local secret files or live launcher scripts.
- It must not be imported by `src/index.ts` or any runtime module.

The operational database and current LIVE process are therefore outside this feature's dependency graph.

## Chosen Approach

Add a standalone research CLI backed by the existing public quotation client and historical pagination logic. Keep artifact construction, validation, and serialization in a separate pure module so all correctness rules can be tested without network or filesystem side effects.

This approach is preferred over a raw-file converter because it gives the operator a complete acquisition path, and preferred over extending the public backtest CLI because an immutable evidence artifact has a different lifecycle from an ephemeral backtest run.

## Components

### Pure Dataset Builder

`src/modules/performance/research-candle-dataset-builder.ts` will:

- accept one explicit asset, history start, end, collection instant, source label, and the three normalized candle arrays;
- accept only `BTC` or `ETH`, deriving the matching `KRW-BTC` or `KRW-ETH` market;
- require explicit-timezone ISO-8601 timestamps;
- retain only candles whose complete interval is contained in `[historyStartAt,endAt]`;
- reject an `endAt` later than `collectedAt`;
- reject empty timeframe groups rather than creating an apparently usable partial dataset;
- reject duplicate instants, incorrect timeframe duration, market mismatch, invalid OHLC, negative volume, `NaN`, and `Infinity` through the existing dataset parser;
- sort candles by actual epoch instant before signing;
- calculate the canonical SHA-256 using `calculateResearchCandleDatasetChecksum`;
- serialize stable, human-inspectable UTF-8 JSON with one trailing newline;
- parse the serialized result again before returning it, making the existing dataset parser the final schema authority.

The builder receives `collectedAt` rather than reading the system clock. This keeps it pure and makes test output deterministic. The CLI captures the clock once and passes that instant explicitly.

### Public Acquisition Service

`src/modules/performance/upbit-research-candle-acquisition.ts` will:

- depend on the narrow `PositionGuardBacktestCandleReader` interface rather than constructing a network client itself;
- call the existing historical candle pagination function with explicit `pageSize` and `pageLimit` values;
- request `60` minute, `240` minute, and daily candles through that existing path;
- pass normalized results to the pure dataset builder;
- return the verified dataset, serialized bytes, candle counts, checksum, and non-mutation boundary metadata;
- propagate public request, pagination exhaustion, validation, and checksum errors without writing an artifact.

The service does not silently shorten requested history. If the configured page limit cannot cover the requested interval, acquisition fails explicitly.

### Research CLI

`src/research/upbit-candle-dataset.ts` will be exposed as:

```text
npm.cmd run research:candles -- \
  --asset BTC \
  --history-start 2025-01-01T00:00:00.000Z \
  --end 2026-08-11T00:00:00.000Z \
  --output ./var/research/krw-btc-20250101-20260811.json \
  --page-size 200 \
  --page-limit 100
```

Required arguments:

- `--asset BTC|ETH`
- `--history-start <explicit-timezone ISO-8601>`
- `--end <explicit-timezone ISO-8601>`
- `--output <new local JSON path>`
- `--page-size <integer 1..200>`
- `--page-limit <positive integer>`

There are no hidden acquisition-range or pagination defaults. The source label is fixed to `upbit-public-historical-candles` because the CLI has exactly one source. The generated `collectedAt` is the single captured CLI clock instant and is displayed in the result.

The CLI will:

- reject unknown, duplicate, or missing arguments;
- reject `historyStartAt >= endAt`;
- reject an `endAt` in the future relative to the captured collection instant;
- create the parent directory only for the explicit output path;
- refuse to overwrite an existing output file;
- construct `UpbitPublicTickerClient` only after all local arguments and output preconditions pass;
- write to a unique temporary file in the destination directory;
- re-read and checksum-verify the temporary artifact;
- promote it to the requested path without replacing an existing file;
- remove the temporary file after any failure;
- print JSON summary to stdout and errors to stderr without secrets.

The summary includes asset, market, requested range, collected time, output path, counts by timeframe, checksum, source, and the complete non-mutation boundary. It never describes successful collection as a backtest result or trading recommendation.

## Time And Candle Semantics

- The requested provenance interval is `[historyStartAt,endAt]` for complete candle intervals.
- A retained candle must satisfy `openTime >= historyStartAt` and `closeTime <= endAt`.
- `1h`, `4h`, and `1d` mean exact elapsed durations of one hour, four hours, and 24 hours respectively.
- Ordering and boundaries use parsed epoch instants, not timestamp string comparison.
- Mixed explicit offsets are accepted and normalized by instant.
- Snapshot or candle interpolation is prohibited.
- A currently forming candle is excluded because its close instant is later than the explicit `endAt`, and the CLI also requires `endAt <= collectedAt`.
- The dataset preserves the existing schema's explicit provenance and canonical checksum semantics.

## File Integrity

An artifact is considered complete only after all of these steps succeed:

1. Public pages cover the requested history without reaching the page limit prematurely.
2. The pure builder validates all three timeframe groups.
3. The canonical checksum is calculated.
4. The serialized artifact is parsed and checksum-verified in memory.
5. The temporary file is written and read back through `readResearchCandleDataset`.
6. The destination is confirmed absent and the verified artifact is promoted without intentional replacement.

If any step fails, the CLI exits non-zero, reports the specific stage, removes its temporary file, and leaves no completed destination artifact. Existing destination files are never modified.

## Testing Strategy

Implementation follows TDD.

Pure builder tests cover:

- valid BTC and ETH datasets;
- exact `1h`, `4h`, and `1d` durations;
- sorting by epoch with mixed timezone offsets;
- `[historyStartAt,endAt]` complete-interval filtering;
- exclusion of a candle crossing either boundary;
- rejection of empty timeframe evidence;
- rejection of future end time, invalid numbers, OHLC corruption, market mismatch, duplicate instants, and malformed timestamps;
- deterministic bytes and checksum with a fixed `collectedAt`;
- checksum round-trip through the existing parser.

Acquisition service tests cover:

- all three timeframe requests through an injected fixture reader;
- multi-page history and deduplication inherited from the historical fetcher;
- explicit page-limit failure;
- no result when any timeframe fetch or validation fails;
- accurate candle counts and non-mutation metadata.

CLI and filesystem tests cover:

- required and unknown argument handling;
- no client construction before local validation succeeds;
- refusal to overwrite an existing artifact;
- successful verified artifact creation in a temporary test directory;
- cleanup after write or verification failure;
- stable secret-free JSON summary;
- runtime import-graph isolation.

The full repository validation remains:

```text
npm.cmd run typecheck
npm.cmd test
git diff --check
```

No automated test or final verification command will invoke the new network-backed CLI against Upbit. Actual public data collection requires a separate explicit operator invocation after implementation review.

## Documentation

Update `README.md`, `ARCHITECTURE.md`, and `PRODUCT_BOUNDARY.md` to document:

- the research-only command and complete arguments;
- the public-only network boundary;
- immutable output and no-overwrite behavior;
- checksum and provenance interpretation;
- the fact that a dataset is evidence for analysis, not trading truth;
- the requirement to collect BTC and ETH independently before running integrated comparison;
- the continued separation from LIVE execution and operational SQLite.

## Completion Criteria

The feature is complete when:

- fixture-backed tests prove correct, deterministic artifact generation;
- CLI tests prove explicit arguments, no-overwrite behavior, cleanup, and isolation;
- the complete test suite, typecheck, and diff check pass;
- an independent review finds no runtime or live-trading coupling;
- no Upbit request was made during implementation verification;
- no operational database or LIVE process state changed;
- no commit or push is performed until the operator asks separately.
