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

export type DatabaseCapability =
  | "syntholo_member_api"
  | "syntholo_staff_api"
  | "syntholo_worker";

const reservedConnectionQueryKeys = new Set([
  "application_name",
  "database",
  "dbname",
  "fallback_application_name",
  "host",
  "hostaddr",
  "options",
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
    options: "-c row_security=on -c app.account_id=",
  });
  return Object.assign(drizzle(pool, { schema }), {
    close: () => pool.end(),
    pool,
  });
}

export async function assertDatabaseCapability(
  database: Database,
  expectedCapability: DatabaseCapability,
): Promise<void> {
  try {
    const result = await database.pool.query<{
      current_user: string;
      session_user: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolconfig: string[] | null;
      database_settings: number;
      reachable: string[];
      membership_options_safe: boolean;
    }>(
      `with recursive memberships as (
         select am.roleid, role.rolname, am.inherit_option, am.set_option,
                am.admin_option
         from pg_auth_members am
         join pg_roles login on login.oid = am.member
         join pg_roles role on role.oid = am.roleid
         where login.rolname = session_user
         union all
         select am.roleid, role.rolname, am.inherit_option, am.set_option,
                am.admin_option
         from pg_auth_members am
         join memberships parent on parent.roleid = am.member
         join pg_roles role on role.oid = am.roleid
       )
       select current_user, session_user, r.rolsuper, r.rolcreatedb,
              r.rolcreaterole, r.rolreplication, r.rolbypassrls,
              r.rolcanlogin, r.rolconfig,
              (select count(*)::integer from pg_db_role_setting s
               where s.setrole = r.oid) as database_settings,
              coalesce((select array_agg(distinct rolname order by rolname)::text[]
                        from memberships), array[]::text[]) as reachable,
              coalesce((select bool_and(inherit_option and not set_option and not admin_option)
                        from memberships), false) as membership_options_safe
       from pg_roles r where r.rolname = session_user`,
    );
    const row = result.rows[0];
    if (
      !row ||
      row.current_user !== row.session_user ||
      row.rolsuper ||
      row.rolcreatedb ||
      row.rolcreaterole ||
      row.rolreplication ||
      row.rolbypassrls ||
      !row.rolcanlogin ||
      row.rolconfig !== null ||
      row.database_settings !== 0 ||
      !row.membership_options_safe ||
      row.reachable.length !== 1 ||
      row.reachable[0] !== expectedCapability
    ) {
      throw new Error("invalid capability");
    }
  } catch {
    throw new Error("DATABASE_CAPABILITY_INVALID");
  }
}
