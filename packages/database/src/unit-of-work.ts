import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function assertCanonicalAccountId(accountId: string): void {
  if (!canonicalUuidPattern.test(accountId)) {
    throw new Error("ACCOUNT_ID_INVALID");
  }
}

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

/**
 * Runs trusted package/server code inside an account-scoped transaction.
 * Never pass an untrusted SQL, plugin, or user-supplied callback: the callback
 * receives the transaction and could deliberately overwrite PostgreSQL GUCs.
 */
export async function withAccountScope<T>(
  database: Database,
  accountId: string,
  run: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  assertCanonicalAccountId(accountId);
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.account_id', ${accountId}, true)`,
    );
    return run(transaction);
  });
}
