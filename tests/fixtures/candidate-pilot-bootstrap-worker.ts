import { parentPort, workerData } from "node:worker_threads";

import type { CreateCandidatePilotDeploymentInput } from
  "../../src/modules/db/pilot-interfaces.js";
import { openSqliteDatabase } from
  "../../src/modules/db/repositories/sqlite-database.js";
import { SqliteCandidatePilotRepository } from
  "../../src/modules/db/repositories/sqlite-candidate-pilot-repository.js";

interface CandidateBootstrapWorkerData {
  databasePath: string;
  input: CreateCandidatePilotDeploymentInput;
  startBarrier: SharedArrayBuffer;
  lockHoldCounter: SharedArrayBuffer;
}

const port = parentPort;
if (!port) {
  throw new Error("Candidate bootstrap worker requires a parent port.");
}

const data = workerData as CandidateBootstrapWorkerData;
const startBarrier = new Int32Array(data.startBarrier);
const lockHoldCounter = new Int32Array(data.lockHoldCounter);
const handle = openSqliteDatabase(data.databasePath);

try {
  handle.db.function("hold_candidate_bootstrap_lock", () => {
    Atomics.add(lockHoldCounter, 0, 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    return 0;
  });

  const readyCount = Atomics.add(startBarrier, 0, 1) + 1;
  Atomics.notify(startBarrier, 0);
  if (readyCount < 2) {
    while (Atomics.load(startBarrier, 0) < 2) {
      const observed = Atomics.load(startBarrier, 0);
      Atomics.wait(startBarrier, 0, observed);
    }
  }

  const repository = new SqliteCandidatePilotRepository(handle.db);
  const result = await repository.initializeDeploymentWithInitialState(data.input);
  port.postMessage({ ok: true, result });
} catch (error) {
  port.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
} finally {
  handle.close();
  port.close();
}
