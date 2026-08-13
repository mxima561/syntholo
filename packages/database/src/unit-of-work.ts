import type { Database } from "./client.js";

export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export interface TransactionContext {
  readonly db: DatabaseTransaction;
}

export interface UnitOfWork {
  transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Database) {}

  transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.database.transaction((db) => run({ db }));
  }
}

export function createUnitOfWork(database: Database): UnitOfWork {
  return new PostgresUnitOfWork(database);
}

export function withAccountScope<T>(
  database: Database,
  accountId: string,
  run: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  // Task 4 adds SET LOCAL and RLS inside this transaction boundary.
  void accountId;
  return database.transaction(run);
}
