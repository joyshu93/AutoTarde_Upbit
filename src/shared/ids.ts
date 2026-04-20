import { createHash, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createFingerprint(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
