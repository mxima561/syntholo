import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema> & {
  readonly pool: Pool;
  close(): Promise<void>;
};

export type DatabaseConfig = Readonly<{
  url: string;
  applicationName: string;
}>;

export function createDatabase(config: DatabaseConfig): Database {
  if (config.url.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  if (config.applicationName.trim() === "") {
    throw new Error("DATABASE_APPLICATION_NAME_REQUIRED");
  }

  const pool = new Pool({
    application_name: config.applicationName,
    connectionString: config.url,
  });
  return Object.assign(drizzle(pool, { schema }), {
    close: () => pool.end(),
    pool,
  });
}
