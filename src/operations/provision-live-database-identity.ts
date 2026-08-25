import { pathToFileURL } from "node:url";

import { provisionLiveDatabaseIdentity } from "../app/live-database-identity.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_WRITES_LIVE_DATABASE_IDENTITY";

export function runLiveDatabaseIdentityProvisioning(env: NodeJS.ProcessEnv = process.env) {
  if (env.LIVE_DATABASE_IDENTITY_PROVISION_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `Refusing to provision until LIVE_DATABASE_IDENTITY_PROVISION_CONFIRMATION=${CONFIRMATION}.`,
    );
  }
  return provisionLiveDatabaseIdentity({
    databasePath: env.DATABASE_PATH?.trim() ?? "",
    databaseInstanceId: env.LIVE_DATABASE_INSTANCE_ID?.trim() ?? "",
    exchangeAccountId: env.EXCHANGE_ACCOUNT_ID?.trim() || "primary",
    upbitAccessKey: env.UPBIT_ACCESS_KEY?.trim() ?? "",
  });
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = runLiveDatabaseIdentityProvisioning();
  console.log(JSON.stringify({
    status: result.created ? "CREATED" : "ALREADY_MATCHED",
    databasePath: result.databasePath,
    databaseInstanceId: result.databaseInstanceId,
    exchangeAccountId: result.exchangeAccountId,
    credentialFingerprintStored: true,
  }, null, 2));
}
