import assert from "node:assert/strict";

import {
  classifyIndependentNoTradeCoverage,
  computeResearchNoTradeEvidenceSha256,
  parseResearchNoTradeEvidence,
  validateResearchNoTradeEvidenceForDataset,
  type ResearchNoTradeEvidence,
} from "../src/modules/performance/research-no-trade-evidence.js";
import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  type ResearchCandle,
  type ResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset.js";
import { test } from "./harness.js";

type ResearchNoTradeEvidenceInput = Omit<ResearchNoTradeEvidence, "provenance"> & {
  provenance: Omit<ResearchNoTradeEvidence["provenance"], "sha256">;
};

type ResearchCandleDatasetInput = Omit<ResearchCandleDataset, "provenance"> & {
  provenance: Omit<ResearchCandleDataset["provenance"], "sha256">;
};

test("research no-trade evidence accepts a checksum-verified valid sidecar", () => {
  const sidecar = withChecksum(baseEvidence());

  const parsed = parseResearchNoTradeEvidence(JSON.stringify(sidecar));

  assert.deepEqual(parsed, sidecar);
  assert.doesNotThrow(() => validateResearchNoTradeEvidenceForDataset(parsed, parentDataset()));
});

test("research no-trade evidence checksum is canonical across property order and changes with evidence", () => {
  const original = baseEvidence();
  const reordered: ResearchNoTradeEvidenceInput = {
    verifiedNoTradeRanges: original.verifiedNoTradeRanges.map((range) => ({ to: range.to, from: range.from })),
    querySegments: original.querySegments.map((segment) => ({
      responseFingerprint: segment.responseFingerprint,
      paginationComplete: segment.paginationComplete,
      to: segment.to,
      from: segment.from,
    })),
    provenance: {
      collectedAt: original.provenance.collectedAt,
      collectorVersion: original.provenance.collectorVersion,
      lowerTimeframe: original.provenance.lowerTimeframe,
      source: original.provenance.source,
      to: original.provenance.to,
      from: original.provenance.from,
      parentDatasetSha256: original.provenance.parentDatasetSha256,
      market: original.provenance.market,
      asset: original.provenance.asset,
      evidenceKind: original.provenance.evidenceKind,
      schemaVersion: original.provenance.schemaVersion,
    },
  };
  const changed = baseEvidence();
  changed.querySegments[0]!.responseFingerprint = "b".repeat(64);

  assert.equal(
    computeResearchNoTradeEvidenceSha256(reordered),
    computeResearchNoTradeEvidenceSha256(original),
  );
  assert.notEqual(
    computeResearchNoTradeEvidenceSha256(changed),
    computeResearchNoTradeEvidenceSha256(original),
  );
});

test("research no-trade evidence has a fixed canonical checksum", () => {
  const dataset = parentDataset();

  assert.equal(dataset.provenance.sha256, "4e7ca18ac36ba93f16e5cbdaf153bbce45789fa806fed6947793afa61ee7c7af");
  assert.equal(
    computeResearchNoTradeEvidenceSha256(baseEvidence(dataset)),
    "024d1bef615760ef71b66a7318377090df7710d293920a072ab39985a5b11098",
  );
});

test("research no-trade evidence rejects checksum mutation", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.provenance.sha256 = "0".repeat(64);

  assert.throws(() => parseResearchNoTradeEvidence(JSON.stringify(sidecar)), /checksum/i);
});

test("research no-trade evidence rejects malformed timestamps", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.verifiedNoTradeRanges[0]!.from = "2026-08-01T01:00:00";

  assert.throws(() => parseResearchNoTradeEvidence(JSON.stringify(sidecar)), /timestamp.*timezone/i);
});

test("research no-trade evidence rejects a parent dataset identity mismatch", () => {
  const dataset = parentDataset();
  const sidecar = withChecksum(baseEvidence(dataset));
  sidecar.provenance.parentDatasetSha256 = "b".repeat(64);
  resign(sidecar);

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(
      parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
      dataset,
    ),
    /parent.*sha256/i,
  );
});

test("research no-trade evidence authenticates the parent dataset checksum before validation", () => {
  const dataset = parentDataset();
  dataset.candles["1h"][0]!.closePrice = 100.5;
  const sidecar = parseResearchNoTradeEvidence(JSON.stringify(withChecksum(baseEvidence())));

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(sidecar, dataset),
    /dataset checksum/i,
  );
});

test("research no-trade evidence rejects an invalid declared parent checksum", () => {
  const dataset = parentDataset();
  dataset.provenance.sha256 = "0".repeat(64);
  const sidecar = parseResearchNoTradeEvidence(JSON.stringify(withChecksum(baseEvidence())));

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(sidecar, dataset), /dataset checksum/i);
});

test("research no-trade evidence rejects an asset mismatch with the parent dataset", () => {
  const dataset = parentDataset();
  const sidecar = withChecksum(baseEvidence(dataset));
  sidecar.provenance.asset = "ETH";
  sidecar.provenance.market = "KRW-ETH";
  resign(sidecar);

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(
      parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
      dataset,
    ),
    /parent asset/i,
  );
});

test("research no-trade evidence rejects a market that does not belong to its asset", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.provenance.market = "KRW-ETH";

  assert.throws(() => parseResearchNoTradeEvidence(JSON.stringify(sidecar)), /market.*KRW-BTC/i);
});

test("research no-trade evidence rejects a parent range mismatch", () => {
  const dataset = parentDataset();
  const sidecar = withChecksum(baseEvidence(dataset));
  sidecar.provenance.to = "2026-08-01T04:00:00.000Z";
  resign(sidecar);

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(
      parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
      dataset,
    ),
    /parent range/i,
  );
});

test("research no-trade evidence rejects no-trade ranges backed only by incomplete pagination", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.querySegments[0]!.paginationComplete = false;
  resign(sidecar);

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(
      parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
      parentDataset(),
    ),
    /complete query segments/i,
  );
});

test("research no-trade evidence rejects partial query coverage for a verified range", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.querySegments[0]!.to = "2026-08-01T01:30:00.000Z";
  resign(sidecar);

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(
      parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
      parentDataset(),
    ),
    /complete query segments/i,
  );
});

test("research no-trade evidence rejects overlapping ranges", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.verifiedNoTradeRanges.push({
    from: "2026-08-01T01:30:00.000Z",
    to: "2026-08-01T02:30:00.000Z",
  });

  assert.throws(() => parseResearchNoTradeEvidence(JSON.stringify(sidecar)), /non-overlapping/i);
});

test("research no-trade evidence rejects overlapping query segments", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.querySegments.push({
    from: "2026-08-01T01:30:00.000Z",
    to: "2026-08-01T02:30:00.000Z",
    paginationComplete: true,
    responseFingerprint: "b".repeat(64),
  });

  assert.throws(() => parseResearchNoTradeEvidence(JSON.stringify(sidecar)), /non-overlapping/i);
});

test("research no-trade evidence rejects a candle occupying the claimed no-trade interval", () => {
  const dataset = parentDataset([hourlyCandle("2026-08-01T01:00:00.000Z", "2026-08-01T02:00:00.000Z")]);
  const sidecar = withChecksum(baseEvidence(dataset));

  assert.throws(
    () => validateResearchNoTradeEvidenceForDataset(
      parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
      dataset,
    ),
    /observed.*hourly candle/i,
  );
});

test("research no-trade evidence permits candles exactly before and after a no-trade interval", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
    hourlyCandle("2026-08-01T02:00:00.000Z", "2026-08-01T03:00:00.000Z"),
  ]);
  const sidecar = withChecksum(baseEvidence(dataset));

  assert.doesNotThrow(() => validateResearchNoTradeEvidenceForDataset(
    parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
    dataset,
  ));
});

test("research no-trade evidence compares mixed-offset ranges and query order by exact instant", () => {
  const dataset = parentDataset();
  const sidecar = withChecksum(baseEvidence(dataset));
  sidecar.provenance.from = "2026-08-01T09:00:00.000+09:00";
  sidecar.provenance.to = "2026-08-01T12:00:00.000+09:00";
  sidecar.querySegments = [{
    from: "2026-08-01T09:00:00.000+09:00",
    to: "2026-08-01T10:00:00.000+09:00",
    paginationComplete: true,
    responseFingerprint: "a".repeat(64),
  }, {
    from: "2026-08-01T01:00:00.000Z",
    to: "2026-08-01T11:00:00.000+09:00",
    paginationComplete: true,
    responseFingerprint: "b".repeat(64),
  }];
  sidecar.verifiedNoTradeRanges = [{
    from: "2026-08-01T10:00:00.000+09:00",
    to: "2026-08-01T02:00:00.000Z",
  }];
  resign(sidecar);

  assert.doesNotThrow(() => validateResearchNoTradeEvidenceForDataset(
    parseResearchNoTradeEvidence(JSON.stringify(sidecar)),
    dataset,
  ));
});

test("independent no-trade coverage classifies dense valid parent candles without a sidecar", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
    hourlyCandle("2026-08-01T01:00:00.000Z", "2026-08-01T02:00:00.000Z"),
    hourlyCandle("2026-08-01T02:00:00.000Z", "2026-08-01T03:00:00.000Z"),
  ]);

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset), {
    status: "DENSE",
    missingRanges: [],
    uncoveredRanges: [],
  });
});

test("independent no-trade coverage verifies every missing nominal hour with an authenticated sidecar", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
    hourlyCandle("2026-08-01T03:00:00.000Z", "2026-08-01T04:00:00.000Z"),
  ], "2026-08-01T04:00:00.000Z");
  const sidecar = evidenceForDataset(dataset, [{
    from: "2026-08-01T01:00:00.000Z",
    to: "2026-08-01T03:00:00.000Z",
  }]);

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset, sidecar), {
    status: "VERIFIED_SPARSE",
    missingRanges: [{
      from: "2026-08-01T01:00:00.000Z",
      to: "2026-08-01T03:00:00.000Z",
    }],
    uncoveredRanges: [],
  });
});

test("independent no-trade coverage reports exact nominal hours left uncovered by a partial sidecar", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
    hourlyCandle("2026-08-01T03:00:00.000Z", "2026-08-01T04:00:00.000Z"),
  ], "2026-08-01T04:00:00.000Z");
  const sidecar = evidenceForDataset(dataset, [{
    from: "2026-08-01T01:00:00.000Z",
    to: "2026-08-01T02:00:00.000Z",
  }]);

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset, sidecar), {
    status: "UNVERIFIED_SPARSE",
    missingRanges: [{
      from: "2026-08-01T01:00:00.000Z",
      to: "2026-08-01T03:00:00.000Z",
    }],
    uncoveredRanges: [{
      from: "2026-08-01T02:00:00.000Z",
      to: "2026-08-01T03:00:00.000Z",
    }],
  });
});

test("independent no-trade coverage keeps sparse parent data unverified without a sidecar", () => {
  const dataset = parentDataset();

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset), {
    status: "UNVERIFIED_SPARSE",
    missingRanges: [{
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-01T02:00:00.000Z",
    }],
    uncoveredRanges: [{
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-01T02:00:00.000Z",
    }],
  });
});

test("independent no-trade coverage uses fully contained absolute UTC hours for mixed-offset nanosecond parent boundaries", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T01:00:00.000Z", "2026-08-01T02:00:00.000Z"),
    hourlyCandle("2026-08-01T02:00:00.000Z", "2026-08-01T03:00:00.000Z"),
  ], "2026-08-01T12:30:00.000000001+09:00", "2026-08-01T09:30:00.000000001+09:00");

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset), {
    status: "DENSE",
    missingRanges: [],
    uncoveredRanges: [],
  });
});

test("independent no-trade coverage preserves exact nanosecond gaps within mixed-offset parent boundaries", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T01:00:00.000Z", "2026-08-01T02:00:00.000Z"),
  ], "2026-08-01T12:30:00.000000001+09:00", "2026-08-01T09:30:00.000000001+09:00");
  const sidecar = evidenceForDataset(dataset, [{
    from: "2026-08-01T02:00:00.000000001Z",
    to: "2026-08-01T02:30:00.000000001Z",
  }]);

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset, sidecar), {
    status: "UNVERIFIED_SPARSE",
    missingRanges: [{
      from: "2026-08-01T02:00:00.000Z",
      to: "2026-08-01T03:00:00.000Z",
    }],
    uncoveredRanges: [{
      from: "2026-08-01T02:00:00.000Z",
      to: "2026-08-01T02:00:00.000000001Z",
    }, {
      from: "2026-08-01T02:30:00.000000001Z",
      to: "2026-08-01T03:00:00.000Z",
    }],
  });
});

test("independent no-trade coverage rejects an off-grid hourly candle even when nominal hours are present", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
    hourlyCandle("2026-08-01T00:30:00.000Z", "2026-08-01T01:30:00.000Z"),
    hourlyCandle("2026-08-01T01:00:00.000Z", "2026-08-01T02:00:00.000Z"),
    hourlyCandle("2026-08-01T02:00:00.000Z", "2026-08-01T03:00:00.000Z"),
  ]);

  assert.throws(
    () => classifyIndependentNoTradeCoverage(dataset),
    /expected nominal hourly interval/i,
  );
});

test("independent no-trade coverage subtracts adjacent and fragmented verified ranges exactly", () => {
  const dataset = parentDataset([
    hourlyCandle("2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
  ], "2026-08-01T02:00:00.000Z");
  const sidecar = evidenceForDataset(dataset, [{
    from: "2026-08-01T01:00:00.000Z",
    to: "2026-08-01T01:15:00.000Z",
  }, {
    from: "2026-08-01T01:15:00.000Z",
    to: "2026-08-01T01:30:00.000Z",
  }, {
    from: "2026-08-01T01:45:00.000Z",
    to: "2026-08-01T02:00:00.000Z",
  }]);

  assert.deepEqual(classifyIndependentNoTradeCoverage(dataset, sidecar), {
    status: "UNVERIFIED_SPARSE",
    missingRanges: [{
      from: "2026-08-01T01:00:00.000Z",
      to: "2026-08-01T02:00:00.000Z",
    }],
    uncoveredRanges: [{
      from: "2026-08-01T01:30:00.000Z",
      to: "2026-08-01T01:45:00.000Z",
    }],
  });
});

test("independent no-trade coverage rejects an invalid supplied sidecar instead of downgrading it", () => {
  const sidecar = withChecksum(baseEvidence());
  sidecar.provenance.sha256 = "0".repeat(64);

  assert.throws(
    () => classifyIndependentNoTradeCoverage(parentDataset(), sidecar),
    /checksum/i,
  );
});

function baseEvidence(dataset = parentDataset()): ResearchNoTradeEvidenceInput {
  return {
    provenance: {
      schemaVersion: 1,
      evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1",
      asset: "BTC",
      market: "KRW-BTC",
      parentDatasetSha256: dataset.provenance.sha256,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-01T03:00:00.000Z",
      source: "independent-upbit-public-candle-collector",
      lowerTimeframe: "1m",
      collectorVersion: "test-collector-v1",
      collectedAt: "2026-08-01T04:00:00.000Z",
    },
    querySegments: [{
      from: "2026-08-01T01:00:00.000Z",
      to: "2026-08-01T02:00:00.000Z",
      paginationComplete: true,
      responseFingerprint: "a".repeat(64),
    }],
    verifiedNoTradeRanges: [{
      from: "2026-08-01T01:00:00.000Z",
      to: "2026-08-01T02:00:00.000Z",
    }],
  };
}

function withChecksum(evidence: ResearchNoTradeEvidenceInput): ResearchNoTradeEvidence {
  return {
    ...evidence,
    provenance: {
      ...evidence.provenance,
      sha256: computeResearchNoTradeEvidenceSha256(evidence),
    },
  };
}

function resign(evidence: ResearchNoTradeEvidence): void {
  const { sha256: _sha256, ...provenance } = evidence.provenance;
  evidence.provenance.sha256 = computeResearchNoTradeEvidenceSha256({
    provenance,
    querySegments: evidence.querySegments,
    verifiedNoTradeRanges: evidence.verifiedNoTradeRanges,
  });
}

function evidenceForDataset(
  dataset: ResearchCandleDataset,
  verifiedNoTradeRanges: ResearchNoTradeEvidence["verifiedNoTradeRanges"],
): ResearchNoTradeEvidence {
  const evidence = baseEvidence(dataset);
  evidence.provenance.from = dataset.provenance.historyStartAt;
  evidence.provenance.to = dataset.provenance.endAt;
  evidence.querySegments = verifiedNoTradeRanges.map((range, index) => ({
    ...range,
    paginationComplete: true,
    responseFingerprint: `${index}`.repeat(64),
  }));
  evidence.verifiedNoTradeRanges = verifiedNoTradeRanges.map((range) => ({ ...range }));
  return withChecksum(evidence);
}

function parentDataset(
  candles: ResearchCandle[] = [
    hourlyCandle("2026-08-01T02:00:00.000Z", "2026-08-01T03:00:00.000Z"),
  ],
  endAt = "2026-08-01T03:00:00.000Z",
  historyStartAt = "2026-08-01T00:00:00.000Z",
): ResearchCandleDataset {
  const unsigned: ResearchCandleDatasetInput = {
    provenance: {
      schemaVersion: 1,
      asset: "BTC",
      market: "KRW-BTC",
      historyStartAt,
      endAt,
      collectedAt: "2026-08-01T04:00:00.000Z",
      source: "parent-fixture",
    },
    candles: {
      "1h": candles,
      "4h": [],
      "1d": [],
    },
  };
  return parseResearchCandleDataset(JSON.stringify(withParentChecksum(unsigned)));
}

function withParentChecksum(dataset: ResearchCandleDatasetInput): ResearchCandleDataset {
  return {
    ...dataset,
    provenance: {
      ...dataset.provenance,
      sha256: calculateResearchCandleDatasetChecksum(dataset),
    },
  };
}

function hourlyCandle(openTime: string, closeTime: string): ResearchCandle {
  return {
    market: "KRW-BTC",
    timeframe: "1h",
    openTime,
    closeTime,
    openPrice: 100,
    highPrice: 102,
    lowPrice: 99,
    closePrice: 101,
    volume: 1,
    quoteVolume: 101,
  };
}
