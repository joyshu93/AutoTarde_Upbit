import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  parseResearchNoTradeEvidence,
  validateResearchNoTradeEvidenceForDataset,
} from "./research-no-trade-evidence.js";
import type { ResearchCandleDataset } from "./research-candle-dataset.js";

export async function assertResearchNoTradeEvidenceOutputAvailable(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Research no-trade evidence output already exists: ${outputPath}.`);
}

export type WriteResearchNoTradeEvidenceInput = {
  outputPath: string;
  json: string;
  parentDataset: ResearchCandleDataset;
};

export type ResearchNoTradeEvidenceWriterDependencies = {
  verifyArtifact?: (artifactPath: string, parent: ResearchCandleDataset) => Promise<void>;
  publishArtifact?: (temporaryPath: string, outputPath: string) => Promise<void>;
  cleanupArtifact?: (temporaryPath: string) => Promise<void>;
};

export function createResearchNoTradeEvidenceWriter(
  dependencies: ResearchNoTradeEvidenceWriterDependencies = {},
): (input: WriteResearchNoTradeEvidenceInput) => Promise<void> {
  const verifyArtifact = dependencies.verifyArtifact ?? verifyNoTradeEvidenceArtifact;
  const publishArtifact = dependencies.publishArtifact
    ?? ((temporaryPath, outputPath) => copyFile(temporaryPath, outputPath, constants.COPYFILE_EXCL));
  const cleanupArtifact = dependencies.cleanupArtifact ?? removeTemporaryArtifact;

  return async (input): Promise<void> => {
    const outputDirectory = dirname(input.outputPath);
    const temporaryPath = join(
      outputDirectory,
      `.${basename(input.outputPath)}.${process.pid}-${randomUUID()}.tmp`,
    );

    await mkdir(outputDirectory, { recursive: true });
    let published = false;
    try {
      await writeFile(temporaryPath, `${input.json.trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
      await verifyArtifact(temporaryPath, input.parentDataset);
      await publishArtifact(temporaryPath, input.outputPath);
      published = true;
    } finally {
      try {
        await cleanupArtifact(temporaryPath);
      } catch (error) {
        if (!published) throw error;
      }
    }
  };
}

export const writeVerifiedResearchNoTradeEvidence = createResearchNoTradeEvidenceWriter();

async function verifyNoTradeEvidenceArtifact(
  artifactPath: string,
  parentDataset: ResearchCandleDataset,
): Promise<void> {
  const bytes = await readFile(artifactPath);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Research no-trade evidence file must contain valid UTF-8 JSON.");
  }
  const evidence = parseResearchNoTradeEvidence(json);
  validateResearchNoTradeEvidenceForDataset(evidence, parentDataset);
}

async function removeTemporaryArtifact(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
