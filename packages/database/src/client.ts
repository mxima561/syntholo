import { Buffer } from "node:buffer";
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

const reservedConnectionQueryKeys = new Set([
  "application_name",
  "database",
  "dbname",
  "fallback_application_name",
  "host",
  "hostaddr",
  "password",
  "port",
  "replication",
  "service",
  "user",
]);

function validateDatabaseUrl(value: string): string {
  const url = value.trim();
  if (url === "") {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (/\s|\p{Cc}/u.test(decodeURIComponent(url))) {
      throw new Error("unsafe URL characters");
    }
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || parsed.hostname === ""
    || parsed.username === ""
    || parsed.password === ""
    || parsed.pathname.length <= 1
    || parsed.hash !== ""
    || [...parsed.searchParams.keys()].some((key) =>
      reservedConnectionQueryKeys.has(key.toLowerCase())
    )
  ) {
    throw new Error("DATABASE_URL_INVALID");
  }

  return url;
}

function validateApplicationName(value: string): string {
  const applicationName = value.trim();
  if (applicationName === "") {
    throw new Error("DATABASE_APPLICATION_NAME_REQUIRED");
  }
  if (
    /\p{Cc}/u.test(applicationName)
    || Buffer.byteLength(applicationName) > 63
  ) {
    throw new Error("DATABASE_APPLICATION_NAME_INVALID");
  }
  return applicationName;
}

export function createDatabase(config: DatabaseConfig): Database {
  const url = validateDatabaseUrl(config.url);
  const applicationName = validateApplicationName(config.applicationName);

  const pool = new Pool({
    application_name: applicationName,
    connectionString: url,
  });
  return Object.assign(drizzle(pool, { schema }), {
    close: () => pool.end(),
    pool,
  });
}
