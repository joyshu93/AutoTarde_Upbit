import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import type { CreateCandidatePilotDeploymentInput } from
  "../../src/modules/db/pilot-interfaces.js";
import { SqliteCandidatePilotRepository } from
  "../../src/modules/db/repositories/sqlite-candidate-pilot-repository.js";

const LOCK_HELD = 0;
const CONTENDER_ATTEMPTED = 1;
const LOCK_HOLD_COUNT = 2;
const HANDSHAKE_TIMEOUT_MS = 5_000;

interface CandidateBootstrapWorkerData {
  databasePath: string;
  input: CreateCandidatePilotDeploymentInput;
  role: "HOLDER" | "CONTENDER";
  synchronization: SharedArrayBuffer;
}

const port = parentPort;
if (!port) {
  throw new Error("Candidate bootstrap worker requires a parent port.");
}

const data = workerData as CandidateBootstrapWorkerData;
const synchronization = new Int32Array(data.synchronization);
let db: DatabaseSync | null = null;

try {
  db = new DatabaseSync(data.databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.function("hold_candidate_bootstrap_lock", () => {
    if (data.role !== "HOLDER") {
      throw new Error("Only the holder worker may insert the candidate deployment.");
    }
    Atomics.add(synchronization, LOCK_HOLD_COUNT, 1);
    Atomics.store(synchronization, LOCK_HELD, 1);
    Atomics.notify(synchronization, LOCK_HELD);
    waitForSignal(synchronization, CONTENDER_ATTEMPTED, "candidate bootstrap contender");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    return 0;
  });

  if (data.role === "CONTENDER") {
    waitForSignal(synchronization, LOCK_HELD, "candidate bootstrap write lock");
    Atomics.store(synchronization, CONTENDER_ATTEMPTED, 1);
    Atomics.notify(synchronization, CONTENDER_ATTEMPTED);
  }

  const repository = new SqliteCandidatePilotRepository(db);
  const result = await repository.initializeDeploymentWithInitialState(data.input);
  port.postMessage({ ok: true, result });
} catch (error) {
  port.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
} finally {
  db?.close();
  port.close();
}

function waitForSignal(view: Int32Array, index: number, label: string): void {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Atomics.load(view, index) !== 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    Atomics.wait(view, index, 0, remainingMs);
  }
}
