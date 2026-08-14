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
  | "syntholo_system_api"
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
      reachable_count: number;
      expected_reachable_count: number;
      membership_options_safe: boolean;
      capability_name: string;
      capability_oid: string;
      capability_can_login: boolean;
      capability_super: boolean;
      capability_createdb: boolean;
      capability_createrole: boolean;
      capability_replication: boolean;
      capability_bypassrls: boolean;
      capability_config: string[] | null;
      capability_settings: number;
      capability_outbound_memberships: number;
      login_owned_objects: number;
      capability_owned_objects: number;
      login_database_create: boolean;
      login_database_temp: boolean;
      capability_database_create: boolean;
      capability_database_temp: boolean;
      login_schema_create: boolean;
      capability_schema_create: boolean;
      forbidden_system_schema_privileges: number;
      login_direct_acl_count: number;
      login_direct_column_acl_count: number;
      forbidden_system_table_privileges: number;
      forbidden_system_column_privileges: number;
      forbidden_system_routine_privileges: number;
    }>(
      `with recursive expected_capability as (
         select oid, rolname, rolcanlogin, rolsuper, rolcreatedb,
                rolcreaterole, rolreplication, rolbypassrls, rolconfig
         from pg_roles where rolname = $1
       ), memberships as (
         select am.roleid, am.inherit_option, am.set_option,
                am.admin_option, array[login.oid, am.roleid]::oid[] as path
         from pg_auth_members am
         join pg_roles login on login.oid = am.member
         where login.rolname = session_user
         union all
         select am.roleid, am.inherit_option, am.set_option,
                am.admin_option, parent.path || am.roleid
         from pg_auth_members am
         join memberships parent on parent.roleid = am.member
         where not am.roleid = any(parent.path)
       ), capability_memberships as (
         select am.roleid, array[cap.oid, am.roleid]::oid[] as path
         from expected_capability cap
         join pg_auth_members am on am.member = cap.oid
         union all
         select am.roleid, parent.path || am.roleid
         from pg_auth_members am
         join capability_memberships parent on parent.roleid = am.member
         where not am.roleid = any(parent.path)
       )
       select current_user, session_user, r.rolsuper, r.rolcreatedb,
              r.rolcreaterole, r.rolreplication, r.rolbypassrls,
              r.rolcanlogin, r.rolconfig,
              (select count(*)::integer from pg_db_role_setting s
               where s.setrole = r.oid) as database_settings,
              (select count(distinct roleid)::integer from memberships)
                as reachable_count,
              (select count(distinct roleid)::integer from memberships
               where roleid = cap.oid) as expected_reachable_count,
              coalesce((select bool_and(inherit_option and not set_option and not admin_option)
                        from memberships), false) as membership_options_safe,
              cap.rolname as capability_name,
              cap.oid as capability_oid,
              cap.rolcanlogin as capability_can_login,
              cap.rolsuper as capability_super,
              cap.rolcreatedb as capability_createdb,
              cap.rolcreaterole as capability_createrole,
              cap.rolreplication as capability_replication,
              cap.rolbypassrls as capability_bypassrls,
              cap.rolconfig as capability_config,
              (select count(*)::integer from pg_db_role_setting s
               where s.setrole = cap.oid) as capability_settings,
              (select count(distinct roleid)::integer
               from capability_memberships) as capability_outbound_memberships,
              ((select count(*) from pg_class where relowner = r.oid)
                + (select count(*) from pg_proc where proowner = r.oid)
                + (select count(*) from pg_namespace where nspowner = r.oid)
                + (select count(*) from pg_database where datdba = r.oid))::integer
                as login_owned_objects,
              ((select count(*) from pg_class where relowner = cap.oid)
                + (select count(*) from pg_proc where proowner = cap.oid)
                + (select count(*) from pg_namespace where nspowner = cap.oid)
                + (select count(*) from pg_database where datdba = cap.oid))::integer
                as capability_owned_objects,
              has_database_privilege(r.rolname, current_database(), 'CREATE')
                as login_database_create,
              has_database_privilege(r.rolname, current_database(), 'TEMP')
                as login_database_temp,
              has_database_privilege(cap.rolname, current_database(), 'CREATE')
                as capability_database_create,
              has_database_privilege(cap.rolname, current_database(), 'TEMP')
                as capability_database_temp,
              has_schema_privilege(r.rolname, 'public', 'CREATE')
                as login_schema_create,
              has_schema_privilege(cap.rolname, 'public', 'CREATE')
                as capability_schema_create,
              (select count(*)::integer from pg_namespace n
                where cap.rolname = 'syntholo_system_api'
                  and n.nspname <> 'information_schema'
                  and n.nspname !~ '^pg_'
                  and ((n.nspname = 'public' and (
                        not has_schema_privilege(cap.rolname,n.oid,'USAGE')
                        or has_schema_privilege(cap.rolname,n.oid,'CREATE')))
                    or (n.nspname <> 'public' and (
                        has_schema_privilege(cap.rolname,n.oid,'USAGE')
                        or has_schema_privilege(cap.rolname,n.oid,'CREATE')))))
                as forbidden_system_schema_privileges,
              ((select count(*) from pg_class c,
                    lateral aclexplode(coalesce(c.relacl,
                      acldefault(case when c.relkind = 'S' then 'S'::"char"
                        else 'r'::"char" end, c.relowner))) acl
                  where acl.grantee = r.oid)
                + (select count(*) from pg_proc p,
                    lateral aclexplode(coalesce(p.proacl,
                      acldefault('f', p.proowner))) acl
                  where acl.grantee = r.oid)
                + (select count(*) from pg_namespace n,
                    lateral aclexplode(coalesce(n.nspacl,
                      acldefault('n', n.nspowner))) acl
                  where acl.grantee = r.oid)
                + (select count(*) from pg_database d,
                    lateral aclexplode(coalesce(d.datacl,
                      acldefault('d', d.datdba))) acl
                  where acl.grantee = r.oid))::integer as login_direct_acl_count,
              (select count(*)::integer from pg_attribute a,
                  lateral aclexplode(a.attacl) acl
                where a.attnum > 0 and not a.attisdropped
                  and acl.grantee = r.oid) as login_direct_column_acl_count,
              (select count(*)::integer from pg_class c
                cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                  ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) privilege(name)
                where cap.rolname = 'syntholo_system_api'
                  and c.relnamespace in (select oid from pg_namespace
                    where nspname <> 'information_schema' and nspname !~ '^pg_')
                  and c.relkind in ('r', 'p', 'v', 'm', 'f')
                  and has_table_privilege(cap.rolname, c.oid, privilege.name)
                  and not (c.relnamespace = 'public'::regnamespace
                    and c.relname in ('audit_events', 'outbox_events')
                    and privilege.name = 'INSERT'))
                as forbidden_system_table_privileges,
              (select count(*)::integer from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                cross join (values ('SELECT'), ('INSERT'), ('UPDATE'),
                  ('REFERENCES')) privilege(name)
                where cap.rolname = 'syntholo_system_api'
                  and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
                  and c.relkind in ('r', 'p', 'v', 'm', 'f')
                  and has_any_column_privilege(cap.rolname, c.oid, privilege.name)
                  and not (n.nspname = 'public'
                    and c.relname in ('audit_events', 'outbox_events')
                    and privilege.name = 'INSERT'))
                as forbidden_system_column_privileges,
              (select count(*)::integer from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where cap.rolname = 'syntholo_system_api'
                  and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
                  and has_function_privilege(cap.rolname, p.oid, 'EXECUTE')
                  and (n.nspname <> 'public' or p.oid::regprocedure::text not in (
                    'syntholo_business_os_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_business_os_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_business_os_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_business_os_renewed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_club_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_club_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_club_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
                    'syntholo_establish_owner(uuid,uuid,text,text,text,timestamp with time zone)',
                    'syntholo_expire_business_os(uuid,uuid,text,uuid,timestamp with time zone)',
                    'syntholo_expire_club(uuid,uuid,text,uuid,timestamp with time zone)',
                    'syntholo_expire_included_support(uuid,uuid,text,uuid,timestamp with time zone)',
                    'syntholo_expire_invitation(uuid,uuid,text,uuid,timestamp with time zone)',
                    'syntholo_fulfill_product(uuid,uuid,text,text,text,text,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
                    'syntholo_lock_scoped_system_account(uuid)',
                    'syntholo_open_dispute(uuid,uuid,text,text,uuid,timestamp with time zone)',
                    'syntholo_record_business_os_setup_purchase(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)',
                    'syntholo_record_access_decision(uuid,uuid,text,boolean,text,uuid[],integer,text,timestamp with time zone)',
                    'syntholo_redeem_invitation(uuid,uuid,text,bytea,text,text,timestamp with time zone)',
                    'syntholo_refund_product(uuid,uuid,text,uuid,text,timestamp with time zone)',
                    'syntholo_resolve_dispute(uuid,uuid,text,uuid,text,timestamp with time zone)'
                  ))) as forbidden_system_routine_privileges
       from pg_roles r cross join expected_capability cap
       where r.rolname = session_user`,
      [expectedCapability],
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
      row.reachable_count !== 1 ||
      row.expected_reachable_count !== 1 ||
      row.capability_name !== expectedCapability ||
      !/^[1-9][0-9]*$/u.test(row.capability_oid) ||
      row.capability_can_login ||
      row.capability_super ||
      row.capability_createdb ||
      row.capability_createrole ||
      row.capability_replication ||
      row.capability_bypassrls ||
      row.capability_config !== null ||
      row.capability_settings !== 0 ||
      row.capability_outbound_memberships !== 0 ||
      row.login_owned_objects !== 0 ||
      row.capability_owned_objects !== 0 ||
      row.login_database_create ||
      row.login_database_temp ||
      row.capability_database_create ||
      row.capability_database_temp ||
      row.login_schema_create ||
      row.capability_schema_create ||
      row.forbidden_system_schema_privileges !== 0 ||
      row.login_direct_acl_count !== 0 ||
      row.login_direct_column_acl_count !== 0 ||
      row.forbidden_system_table_privileges !== 0 ||
      row.forbidden_system_column_privileges !== 0 ||
      row.forbidden_system_routine_privileges !== 0
    ) {
      throw new Error("invalid capability");
    }
  } catch {
    throw new Error("DATABASE_CAPABILITY_INVALID");
  }
}
