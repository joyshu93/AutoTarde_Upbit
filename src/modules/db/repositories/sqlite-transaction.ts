import type { DatabaseSync } from "node:sqlite";

export function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) {
    throw new Error("Cannot start a nested SQLite immediate transaction.");
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    if (result instanceof Promise) {
      throw new Error("SQLite immediate transaction operations must be synchronous.");
    }
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SQLite transaction failed and rollback also failed.",
      );
    }
    throw error;
  }
}
