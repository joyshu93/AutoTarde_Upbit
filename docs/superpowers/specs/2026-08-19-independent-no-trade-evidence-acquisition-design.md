# Independent No-Trade Evidence Acquisition Design

## Goal

Add a manually invoked, research-only collector that authenticates an existing
research candle dataset, queries only its missing nominal `1h` intervals through
Upbit public `1m` candles, and publishes an immutable
`INDEPENDENT_NO_TRADE_EVIDENCE_V1` sidecar without changing strategy or LIVE
behavior.

## Scope

This unit includes a pure collection planner, an injected public-candle acquisition
service, an exclusive local artifact writer, and a standalone CLI. It does not run a
holdout, synthesize candles, change the parent dataset, open SQLite, use private
credentials, poll Telegram, start a scheduler, execute a strategy, or submit an
order.

## Selected Approach

Use the existing V1 sidecar contract and collect only gaps reported by
`classifyIndependentNoTradeCoverage(parentDataset)`. The collector does not fetch
the complete parent range and does not reuse the existing `1h`/`4h`/`1d` dataset
acquisition service.

The existing sidecar intentionally stores a canonical response fingerprint rather
than raw 1m responses. The fingerprint is provenance evidence, not a replacement
for independently retained source data. A future auditable page-manifest schema
would require a separate versioned design and is not introduced by this unit.

## Components

### Collection planner

- Re-parse the parent JSON with `parseResearchCandleDataset` before any network
  dependency is created.
- Derive exact missing ranges from `classifyIndependentNoTradeCoverage(parent)`.
- Return a dense sidecar with no query segments when the parent has no missing
  intervals; do not call the reader.
- Split every missing range into non-overlapping nominal one-hour query segments.

### Public 1m acquisition service

- Accept an injected reader exposing only `getMinuteCandles`.
- Use only `KRW-BTC` and `KRW-ETH` with minute unit `1`.
- Query backward from each segment's exclusive `to` with explicit `pageSize` and
  `pageLimit`.
- Validate market, unit, finite raw values, explicit UTC candle timestamps, strict
  cursor progress, and deterministic duplicate handling.
- Normalize Upbit `candle_date_time_utc` by accepting only its UTC wall-clock form
  and appending `Z` before exact parsing. The numeric `timestamp` is the exchange's
  last-trade observation time, not the candle open time; require it to be a finite,
  non-negative safe integer and retain it in the fingerprint, but do not require it
  to equal the candle open instant.
- Sort each successful page by exact candle-open instant descending. Equal open
  instants with different validated payloads are corrupt and rejected. Identical
  duplicate rows are retained in canonical fingerprint membership but collapsed for
  cursor traversal and in-range conflict detection.
- Use the oldest unique candle open as the next exclusive Upbit `to` cursor without
  subtracting time. It must be strictly earlier than the request cursor. A page whose
  oldest unique open does not advance the cursor, including a repeated duplicate-only
  page, fails explicitly.
- Reject any returned candle whose open is at or after the page request cursor. Raw
  page row count and every sorted canonical row, including identical duplicates, are
  bound into the fingerprint.
- Filter using exact `[from,to)` epoch comparisons. A candle exactly at `from` is in
  range; a candle exactly at `to` is outside the range.
- Treat the segment as completely traversed only after the returned sequence crosses
  below `from`, or an HTTP-successful empty response terminates an otherwise valid
  cursor chain as `SOURCE_EXHAUSTED`. An empty first response is therefore complete
  source-exhaustion evidence for that request boundary; an HTTP error, thrown reader
  error, malformed response, or omitted request is never converted into an empty
  response.
- Page-limit exhaustion, a repeated/non-decreasing cursor, malformed rows, HTTP
  failure, or partial traversal fails the entire acquisition. No partial artifact is
  published.

If any valid 1m candle exists inside a missing parent hourly segment, acquisition
fails with an explicit parent-evidence conflict. It must not mark the segment as
no-trade or repair the parent dataset.

## Fingerprint Contract

Each V1 query segment receives one lowercase SHA-256 fingerprint over canonical JSON
containing:

- schema label and collector version;
- asset, market, minute unit, segment `from` and `to`;
- explicit page size and ordered request cursors;
- every successful response page in request order;
- every normalized response row in deterministic timestamp order, retaining the
  validated timestamp and numeric candle fields;
- page row counts and the terminal reason.

Object property order and source response row order must not change the fingerprint.
Changing a request cursor, response value, row membership, terminal reason, or an
empty response must change it. The sidecar's canonical checksum then binds the
fingerprint and all other V1 fields.

## Artifact Construction And Publication

- `source` is a fixed public-research collector identifier.
- `lowerTimeframe` is `1m` and `collectorVersion` is explicit and fixed in source.
- `from`, `to`, asset, market, and `parentDatasetSha256` come only from the
  authenticated parent artifact.
- Every completed zero-candle segment is included in both `querySegments` and
  `verifiedNoTradeRanges`.
- Construct the canonical sidecar checksum, parse it again, and validate it against
  the authenticated parent before any publication.
- Publish through a temporary file and exclusive copy. Existing destinations are
  never overwritten; verification or publication failure removes the temporary
  file and leaves no output artifact.

## CLI Contract

Expose:

```text
npm run research:no-trade-evidence -- \
  --parent-dataset <existing JSON> \
  --output <new JSON> \
  --page-size <1..200> \
  --page-limit <positive integer>
```

There are no hidden monetary, market, asset, range, or pagination defaults. The
parent supplies asset, market, range, and checksum. The CLI validates all arguments,
clock, parent, and output availability before constructing `UpbitPublicTickerClient`.

On success, stdout contains stable JSON with service, status, parent path and SHA-256,
output path and sidecar SHA-256, segment/page counts, verified-range count, collection
time, source, and explicit false-valued operational boundary flags. Errors go to
stderr and set exit code `1`; secrets and raw response bodies are not logged.

## Import And Runtime Boundary

- The pure V1 sidecar module must not import the collector, writer, public client, or
  CLI.
- The collector may import only pure timestamp/dataset/sidecar helpers and public
  candle contracts.
- `UpbitPublicTickerClient` is instantiated only in the standalone research CLI.
- Runtime, app, execution, reconciliation, Telegram, DB, migrations, scheduler,
  private exchange, and order graphs must not import the collector or CLI.
- Tests enforce static, side-effect, export-from, literal dynamic-import, and
  `require` edges plus transitive literal relative imports. This is a declared-source
  dependency guarantee, not proof against arbitrary generated runtime loading.

## TDD And Verification

Tests must first fail for the missing behavior and cover:

- authenticated parent planning, dense-parent no-read behavior, and exact gap splits;
- one completed zero-candle gap and multiple non-overlapping gaps;
- in-range candle conflict and exact `[from,to)` edges;
- full-page continuation, source exhaustion, page-limit failure, cursor regression,
  duplicate-only pages, malformed market/unit/numbers/timestamps, and API failure;
- deterministic fingerprints across property/row ordering and mutation sensitivity;
- parent checksum mutation before reader creation;
- fixed-clock byte-identical output;
- no-overwrite publication and temporary-file cleanup;
- exact CLI argument validation and side-effect ordering;
- runtime/import graph isolation and full migration-suite compatibility by absence of
  DB access.

Final verification is `npm.cmd run typecheck`, the focused suites, full
`npm.cmd run check`, and `git diff --check`. Automated tests use injected readers and
must not call Upbit. Focused acquisition and CLI tests install a temporary throwing
`globalThis.fetch` trap while injected dependencies run, then restore it, so an
accidental network fallback fails the test.

## Deferred Work

Manual production of BTC and ETH sidecars, prospective holdout collection,
`BROAD_LOSS_CAUSE_HOLDOUT_V1`, raw/page-manifest evidence schema V2, strategy changes,
and LIVE resumption remain separate explicit tasks.
