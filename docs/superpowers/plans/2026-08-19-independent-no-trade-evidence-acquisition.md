# Independent No-Trade Evidence Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manually invoked, public-API-only collector that produces an authenticated V1 no-trade evidence sidecar for missing parent hourly intervals without touching operational state.

**Architecture:** A pure acquisition service authenticates the parent dataset, plans exact missing one-hour ranges, and queries an injected Upbit `1m` reader. A standalone research CLI is the only composition root allowed to instantiate `UpbitPublicTickerClient`; an exclusive writer re-verifies the sidecar and parent before publication. The parser remains independent of acquisition and all operational graphs.

**Tech Stack:** TypeScript strict mode, Node.js crypto/fs, existing Upbit public client, existing research dataset and exact timestamp helpers, custom test harness.

**Spec:** `docs/superpowers/specs/2026-08-19-independent-no-trade-evidence-acquisition-design.md`

## Global Constraints

- Upbit public unauthenticated minute candles only; assets remain BTC and ETH, markets remain `KRW-BTC` and `KRW-ETH`.
- Never call private Upbit APIs, Telegram, SQLite, migrations, scheduler, strategy execution, reconciliation, or order paths.
- Automated tests use injected readers and never call the network.
- Parent datasets and output sidecars are checksum-authenticated and immutable; existing outputs are never overwritten.
- No hidden defaults for asset, market, range, page size, page limit, output, or collection behavior.
- No missing candle is synthesized and no observed 1m candle may be converted into no-trade evidence.
- Every production behavior starts with a focused failing test and an observed expected RED result.

---

### Task 1: Public 1m Contract And Pure Gap Acquisition

**Files:**
- Modify: `src/modules/exchange/upbit/contracts.ts`
- Modify: `src/modules/performance/research-no-trade-evidence.ts`
- Create: `src/modules/performance/upbit-no-trade-evidence-acquisition.ts`
- Create: `tests/upbit-no-trade-evidence-acquisition.test.ts`
- Modify: `tests/upbit-research-candle-acquisition.test.ts`
- Modify: `tests/run-all.ts`

**Interfaces:**
- Consumes: `ResearchCandleDataset`, `classifyIndependentNoTradeCoverage()`, `parseResearchCandleDataset()`, `parsePerformanceTimestamp()`, `UpbitCandleSnapshot`.
- Produces:

```ts
export interface ResearchNoTradeMinuteCandleReader {
  getMinuteCandles(request: UpbitGetMinuteCandlesRequest & { unit: 1 }):
    Promise<readonly UpbitCandleSnapshot[]>;
}

export type AcquireUpbitNoTradeEvidenceInput = {
  parentDataset: ResearchCandleDataset;
  collectedAt: string;
  pageSize: number;
  pageLimit: number;
};

export type AcquiredUpbitNoTradeEvidence = {
  evidence: ResearchNoTradeEvidence;
  json: string;
  segmentCount: number;
  pageCount: number;
  verifiedRangeCount: number;
  source: "upbit-public-independent-no-trade-collector";
  boundary: {
    sqlite: false;
    privateExchange: false;
    telegram: false;
    scheduler: false;
    strategyExecution: false;
    orders: false;
  };
};

export type NoTradeFingerprintRow = {
  market: "KRW-BTC" | "KRW-ETH";
  unit: 1;
  openTime: string;
  openingPrice: number;
  highPrice: number;
  lowPrice: number;
  tradePrice: number;
  exchangeTimestamp: number;
  quoteVolume: number;
  volume: number;
};

export type NoTradeResponseFingerprintPage = {
  requestTo: string;
  rawRowCount: number;
  rows: readonly NoTradeFingerprintRow[];
};

export function computeNoTradeResponseFingerprint(input: {
  asset: "BTC" | "ETH";
  market: "KRW-BTC" | "KRW-ETH";
  from: string;
  to: string;
  pageSize: number;
  requestPages: readonly NoTradeResponseFingerprintPage[];
  terminalReason: "CROSSED_RANGE_START" | "SOURCE_EXHAUSTED";
}): string;

export async function acquireUpbitNoTradeEvidence(
  reader: ResearchNoTradeMinuteCandleReader,
  input: AcquireUpbitNoTradeEvidenceInput,
): Promise<AcquiredUpbitNoTradeEvidence>;
```

- Export a named unsigned V1 sidecar type from `research-no-trade-evidence.ts` so acquisition can compute the checksum without duplicating its structure.

- [ ] **Step 1: Write failing contract and planner tests**

Add tests proving unit `1` is accepted, an authenticated dense parent returns a valid empty sidecar without calling the reader, sparse parent ranges split into exact hour segments, and a forged parent checksum fails before the first reader call. Also add the runtime source-graph test before the collector, writer, and CLI files exist so the expected missing-path failure is observed RED.

The focused acquisition tests must replace `globalThis.fetch` with a throwing function while injected readers execute and restore it in `finally`, proving that no hidden network fallback occurs.

```ts
test("no-trade acquisition does not read public candles for a dense authenticated parent", async () => {
  let reads = 0;
  const acquired = await acquireUpbitNoTradeEvidence({
    getMinuteCandles: async () => { reads += 1; return []; },
  }, validDenseInput());
  assert.equal(reads, 0);
  assert.deepEqual(acquired.evidence.querySegments, []);
  assert.deepEqual(acquired.evidence.verifiedNoTradeRanges, []);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx.cmd tsx -e "import('./tests/upbit-no-trade-evidence-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npx.cmd tsx -e "import('./tests/upbit-research-candle-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

Expected: the focused acquisition suite fails because the acquisition module and
minute unit `1` do not exist, and the import-firewall suite fails because the planned
collector/writer/CLI paths do not exist yet. Record both expected RED results before
creating production files.

- [ ] **Step 3: Implement the minimum authenticated planner**

Add `1` to `UpbitMinuteCandleUnit`. Re-parse the parent, validate collected time and explicit pagination values, classify missing ranges, split them into exact hour segments, and construct a checksum-valid empty sidecar for dense input.

- [ ] **Step 4: Write failing pagination and evidence tests**

Cover successful crossing below `from`, successful first-page source exhaustion, multiple gaps, exact `from`/`to` boundaries, an in-range candle conflict, page-limit exhaustion, non-decreasing cursor, duplicate-only pages, API rejection, wrong market/unit, invalid timestamp, non-finite/negative OHLCV values, and no partial result.

```ts
test("no-trade acquisition rejects a minute candle inside a missing parent hour", async () => {
  await assert.rejects(
    acquireUpbitNoTradeEvidence(readerReturning(minuteAt("2026-08-01T01:30:00Z")), sparseInput()),
    /parent.*gap.*contains.*1m candle/i,
  );
});
```

- [ ] **Step 5: Run the focused test and verify RED**

Expected: new pagination/evidence tests fail because the planner does not query or validate pages yet.

- [ ] **Step 6: Implement strict backward traversal**

Query each exact segment with unit `1`, canonical UTC cursor strings, explicit page size and page limit. Sort and validate response rows before use, reject in-range rows, stop only after crossing `from` or an HTTP-successful empty response, and reject stalled/partial traversal. Build complete query segments and verified ranges only after every segment succeeds.

Accept only Upbit UTC wall-clock strings and append `Z` for exact parsing. Require the numeric exchange timestamp to be a finite, non-negative safe integer but do not equate it with candle open time. Sort rows by exact open instant descending; reject conflicting payloads at one open, retain identical duplicate rows in fingerprint membership, collapse them only for traversal, and use the oldest unique open as the next exclusive cursor without subtraction. Reject rows at or after the request cursor and require the next cursor to be strictly earlier.

- [ ] **Step 7: Write fingerprint determinism tests**

Assert a fixed golden SHA-256; equivalent object property and source row order produce the same digest; changing market, range, cursor, page size, row value, empty-page membership, or terminal reason changes it.

- [ ] **Step 8: Run fingerprint tests and verify RED**

Run the focused acquisition suite again. Expected: fingerprint tests fail because canonical response fingerprinting and final V1 construction are not implemented.

- [ ] **Step 9: Implement canonical response fingerprinting and final V1 construction**

Hash canonical validated request/page/response evidence, construct and checksum the unsigned sidecar, parse it, validate it against the authenticated parent, serialize stable pretty JSON with one trailing newline, and return fixed false-valued boundary metadata.

- [ ] **Step 10: Run focused tests and typecheck**

```powershell
npx.cmd tsx -e "import('./tests/upbit-no-trade-evidence-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npm.cmd run typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 11: Independent Task 1 review**

Reviewer checks exact epoch boundaries, completeness semantics, fingerprint coverage, parent authentication, finite numeric validation, and absence of operational side effects. Resolve every blocking or correctness finding with a new RED/GREEN regression.

---

### Task 2: Exclusive Sidecar Writer And Standalone CLI

**Files:**
- Create: `src/modules/performance/research-no-trade-evidence-writer.ts`
- Create: `src/research/upbit-no-trade-evidence.ts`
- Create: `tests/upbit-no-trade-evidence-cli.test.ts`
- Modify: `tests/run-all.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `readResearchCandleDataset()`, `parseResearchNoTradeEvidence()`, `validateResearchNoTradeEvidenceForDataset()`, `acquireUpbitNoTradeEvidence()`, `UpbitPublicTickerClient`.
- Produces:

```ts
export async function assertResearchNoTradeEvidenceOutputAvailable(outputPath: string): Promise<void>;

export function createResearchNoTradeEvidenceWriter(dependencies?: {
  verifyArtifact?: (artifactPath: string, parent: ResearchCandleDataset) => Promise<void>;
  publishArtifact?: (temporaryPath: string, outputPath: string) => Promise<void>;
  cleanupArtifact?: (temporaryPath: string) => Promise<void>;
}): (input: {
  outputPath: string;
  json: string;
  parentDataset: ResearchCandleDataset;
}) => Promise<void>;

export type NoTradeEvidenceCliOptions = {
  parentDatasetPath: string;
  outputPath: string;
  pageSize: number;
  pageLimit: number;
};

export type NoTradeEvidenceCliDependencies = {
  now: () => Date;
  readParentDataset: (path: string) => Promise<ResearchCandleDataset>;
  assertOutputAvailable: (path: string) => Promise<void>;
  createReader: () => ResearchNoTradeMinuteCandleReader;
  writeArtifact: (input: {
    outputPath: string;
    json: string;
    parentDataset: ResearchCandleDataset;
  }) => Promise<void>;
};

export type NoTradeEvidenceCliSummary = {
  service: "AutoTrade_Upbit";
  status: "COMPLETED";
  parentDatasetPath: string;
  parentDatasetSha256: string;
  outputPath: string;
  evidenceSha256: string;
  collectedAt: string;
  segmentCount: number;
  pageCount: number;
  verifiedRangeCount: number;
  source: "upbit-public-independent-no-trade-collector";
  boundary: AcquiredUpbitNoTradeEvidence["boundary"];
};

export function parseNoTradeEvidenceArgs(argv: readonly string[]): NoTradeEvidenceCliOptions;
export async function runNoTradeEvidenceCli(
  options: NoTradeEvidenceCliOptions,
  dependencies: NoTradeEvidenceCliDependencies,
): Promise<NoTradeEvidenceCliSummary>;
```

- [ ] **Step 1: Write failing writer tests**

Test nested output creation, checksum and parent validation before publication, existing-output preservation, publication race, malformed JSON, verification failure, publication failure, temporary cleanup, and post-publication cleanup behavior.

- [ ] **Step 2: Run focused tests and verify RED**

Expected: fail because the sidecar writer does not exist.

- [ ] **Step 3: Implement the exclusive writer**

Write to a unique `wx` temporary file, parse the sidecar, validate it against the supplied parent, publish with `COPYFILE_EXCL`, and clean up without masking a successful publication.

- [ ] **Step 4: Write failing CLI contract tests**

Require exactly `--parent-dataset`, `--output`, `--page-size`, and `--page-limit`; reject unknown, duplicate, missing, empty, unsafe numeric, invalid clock, and future-parent-end inputs. Assert parent authentication and output availability occur before reader construction, acquisition failure never writes, and a fixed clock produces a stable finite summary and byte-identical artifact.

Install a throwing `globalThis.fetch` trap around injected CLI execution and restore it in `finally`. Any accidental default network fallback must fail the focused test.

```ts
const VALID_ARGV = [
  "--parent-dataset", "./var/research/btc.json",
  "--output", "./var/research/btc.no-trade.json",
  "--page-size", "200",
  "--page-limit", "100",
] as const;
```

- [ ] **Step 5: Run focused tests and verify RED**

Expected: fail because the CLI parser and runner do not exist.

- [ ] **Step 6: Implement the injected CLI runner**

Validate local options and clock, read/authenticate parent, reject a parent end after collection time, check output availability, then construct the public reader, acquire evidence, and write the verified artifact. Return stable JSON summary fields from persisted provenance only.

- [ ] **Step 7: Add the standalone composition root and package script**

Add:

```json
"research:no-trade-evidence": "npm run build && node dist/src/research/upbit-no-trade-evidence.js"
```

The default dependencies instantiate only `UpbitPublicTickerClient`, local authenticated readers/writers, and `new Date()`.

- [ ] **Step 8: Run focused tests and typecheck**

```powershell
npx.cmd tsx -e "import('./tests/upbit-no-trade-evidence-cli.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npm.cmd run typecheck
```

Expected: all writer/CLI tests and typecheck pass.

- [ ] **Step 9: Independent Task 2 review**

Reviewer checks side-effect ordering, no-overwrite race behavior, failure cleanup, secret-free output, argument completeness, and that the public client is created only after all local preconditions.

---

### Task 3: Import Firewall Completion And Documentation

**Files:**
- Modify: `tests/upbit-research-candle-acquisition.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT_BOUNDARY.md`

**Interfaces:**
- Consumes: new collector, writer, and CLI source paths.
- Produces: source-graph regressions and operator documentation; no runtime interface.

- [ ] **Step 1: Complete the already-RED source-graph contract**

Complete the TypeScript AST module-specifier assertions started before Task 1 implementation: runtime/app graphs cannot reach collector, writer, or CLI; the pure sidecar cannot reach acquisition, exchange, or CLI; the collector cannot reach operational modules; the CLI imports only public and approved research modules; and non-literal dynamic loading fails the allowlist.

- [ ] **Step 2: Run the import-boundary suite and inspect the transition**

Expected: the original missing-path RED from Task 1 is resolved by the implemented files; any undeclared or forbidden edge still fails before documentation work continues.

- [ ] **Step 3: Complete import-safe module boundaries**

Use type-only imports where possible and keep public-client construction in the CLI. Do not weaken the scanner or add broad directory exceptions.

- [ ] **Step 4: Update root documentation**

Document the exact CLI, public-only/no-secret behavior, immutable output, failure semantics, V1 fingerprint limitation, and that collection is not a backtest, deployment approval, strategy change, or LIVE action.

- [ ] **Step 5: Run focused boundaries and documentation checks**

```powershell
npx.cmd tsx -e "import('./tests/upbit-research-candle-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
rg -n "research:no-trade-evidence|V1|public|no-overwrite|LIVE" README.md ARCHITECTURE.md PRODUCT_BOUNDARY.md
git diff --check
```

Expected: import tests pass, required documentation is present, and no whitespace error is reported.

- [ ] **Step 6: Independent Task 3 review**

Reviewer verifies that documentation matches actual code and that no operational graph imports the feature.

---

### Task 4: Integrated Verification And Safety Audit

**Files:**
- Modify only if a verified review finding requires a regression and fix.

**Interfaces:**
- Consumes all completed tasks.
- Produces final verification evidence and a concise implementation report.

- [ ] **Step 1: Run all focused suites**

```powershell
npx.cmd tsx -e "import('./tests/upbit-no-trade-evidence-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npx.cmd tsx -e "import('./tests/upbit-no-trade-evidence-cli.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
npx.cmd tsx -e "import('./tests/upbit-research-candle-acquisition.test.ts').then(async () => (await import('./tests/harness.ts')).runRegisteredTests())"
```

- [ ] **Step 2: Run full verification**

```powershell
npm.cmd run typecheck
npm.cmd run check
git diff --check
git status --short
```

Expected: all commands succeed; status contains only intended source, test, plan, and documentation changes.

- [ ] **Step 3: Verify operational non-mutation**

Read, but do not open through SQLite APIs, the operating DB file metadata before and after verification. Confirm no command invoked Upbit, Telegram, sync, scheduler, strategy, migrations, or orders. Do not start or stop a LIVE process.

- [ ] **Step 4: Final independent review**

Reviewer re-reads the spec and plan, inspects all diffs, and returns findings ordered by severity plus explicit `SPEC APPROVED/NOT APPROVED` and `QUALITY APPROVED/NOT APPROVED`. Resolve findings with TDD before completion.

- [ ] **Step 5: Report without collecting real data**

Report implemented contracts, files, tests, subagent roles, main-agent integration changes, safety evidence, V1 limitations, and the separate manual command that would later collect BTC/ETH sidecars. Do not execute the manual network command and do not commit or push implementation unless the user separately asks.
