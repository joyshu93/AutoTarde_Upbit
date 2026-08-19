# Independent No-Trade Evidence Sidecar Design

## Goal

Add a read-only, immutable sidecar artifact that can independently explain nominal
hourly gaps without changing candle dataset schema version 1, strategy behavior, or
runtime wiring.

## Scope

This first unit defines only the pure evidence contract and validation boundary. It
does not collect data, call Upbit, evaluate a holdout, open SQLite, start Telegram,
or import execution/runtime modules.

## Artifact Contract

`ResearchNoTradeEvidence` contains:

- schema version and evidence kind;
- asset and market;
- the exact parent candle dataset SHA-256;
- evidence range `[from,to)` with explicit ISO-8601 timezones;
- independent source name, lower timeframe, collector version, and collection time;
- complete query segments with pagination status and response fingerprints;
- verified no-trade ranges; and
- a canonical SHA-256 over every field except the artifact checksum itself.

The first supported lower timeframe is `1m`. A query segment proves a closed
`[from,to)` interval only when `paginationComplete` is true. Its response fingerprint
is provenance evidence, not a replacement for source data.

## Validation Rules

- Only BTC/KRW-BTC and ETH/KRW-ETH are supported.
- Every timestamp must be an explicit-timezone ISO-8601 timestamp and comparisons use
  exact epoch order.
- Evidence and query ranges are canonical, ordered, non-overlapping, and contained in
  the parent dataset range.
- Every verified no-trade range must be fully covered by complete query segments.
- A verified no-trade range must not contain an observed parent 1h candle close.
- Parent asset, market, SHA-256, and range must match the supplied candle dataset.
- Missing, partial, overlapping, off-range, malformed, or checksum-invalid evidence is
  rejected explicitly.
- Dense parent hourly coverage needs no sidecar; sparse coverage remains unverified
  unless every nominal gap is covered by valid sidecar evidence.

## Safety Boundary

The module is pure except for an optional local-file reader. It may import only
performance timestamp and immutable dataset helpers. It must not import exchange,
execution, reconciliation, Telegram, application startup, writable database, or
network acquisition modules.

## Testing

TDD covers canonical checksum stability, mutation detection, mixed-offset ordering,
dataset identity mismatch, incomplete pagination, partial gap coverage, observed
candle collisions, overlapping ranges, malformed timestamps, and dense/sparse parent
coverage classification. Import-graph tests prove that runtime and network paths are
unreachable.

## Deferred Work

Actual 1m acquisition, prospective holdout collection, `BROAD_LOSS_CAUSE_HOLDOUT_V1`,
and any strategy or LIVE change require separate approval and implementation plans.
