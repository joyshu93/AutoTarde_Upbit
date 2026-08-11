import { constants } from "node:fs";
import { copyFile, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { readResearchCandleDataset } from "./research-candle-dataset.js";

export async function assertResearchCandleDatasetOutputAvailable(
  outputPath: string,
): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Research candle dataset output already exists: ${outputPath}.`);
}

export type WriteVerifiedResearchCandleDatasetInput = {
  outputPath: string;
  json: string;
};

export type ResearchCandleDatasetWriterDependencies = {
  verifyArtifact?: (artifactPath: string) => Promise<unknown>;
  publishArtifact?: (temporaryPath: string, outputPath: string) => Promise<void>;
  cleanupArtifact?: (temporaryPath: string) => Promise<void>;
};

export function createResearchCandleDatasetWriter(
  dependencies: ResearchCandleDatasetWriterDependencies = {},
): (input: WriteVerifiedResearchCandleDatasetInput) => Promise<void> {
  const verifyArtifact = dependencies.verifyArtifact ?? readResearchCandleDataset;
  const publishArtifact = dependencies.publishArtifact
    ?? ((temporaryPath, outputPath) => copyFile(temporaryPath, outputPath, constants.COPYFILE_EXCL));
  const cleanupArtifact = dependencies.cleanupArtifact ?? removeTemporaryArtifact;

  return async (input): Promise<void> => {
    const parentPath = dirname(input.outputPath);
    const tempPath = join(
      parentPath,
      `.${basename(input.outputPath)}.${process.pid}-${randomUUID()}.tmp`,
    );

    await mkdir(parentPath, { recursive: true });
    let published = false;
    try {
      const json = `${input.json.trimEnd()}\n`;
      await writeFile(tempPath, json, { encoding: "utf8", flag: "wx" });
      await verifyArtifact(tempPath);
      await publishArtifact(tempPath, input.outputPath);
      published = true;
    } finally {
      try {
        await cleanupArtifact(tempPath);
      } catch (error) {
        if (!published) throw error;
      }
    }
  };
}

export const writeVerifiedResearchCandleDataset = createResearchCandleDatasetWriter();

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
