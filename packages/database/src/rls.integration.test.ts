import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDatabase, type Database } from "./client.js";
import { migrateDatabase, PUBLISHED_MIGRATIONS } from "./migrations.js";
import {
  accounts,
  auditEvents,
  jobs,
  memberIdentities,
  memberships,
  outboxEvents,
  providerEventReceipts,
  staffIdentities,
} from "./schema/index.js";
import { createUnitOfWork, withAccountScope } from "./unit-of-work.js";
import { JobRepository } from "./repositories/jobs.js";
import {
  HandlerReceiptRepository,
  OutboxProcessorRepository,
} from "./repositories/outbox-processing.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";

const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "20000000-0000-4000-8000-000000000002";
const identityA = "10000000-0000-4000-8000-000000000011";
const identityB = "20000000-0000-4000-8000-000000000012";
const membershipA = "10000000-0000-4000-8000-000000000021";
const membershipB = "20000000-0000-4000-8000-000000000022";

const capabilityRoles = [
  "syntholo_member_api",
  "syntholo_migrator",
  "syntholo_staff_api",
  "syntholo_system_api",
  "syntholo_worker",
] as const;

const customerTables = [
  "accounts",
  "audit_events",
  "event_handler_receipts",
  "job_attempts",
  "jobs",
  "member_identities",
  "memberships",
  "outbox_events",
] as const;

const foundationTables = [
  "access_decision_audit",
  "account_course_accesses",
  "account_hold_sources",
  "account_holds",
  "account_onboarding",
  "account_onboarding_priorities",
  "accounts",
  "administrative_grant_restorations",
  "api_command_receipts",
  "audit_events",
  "business_os_setup_receipts",
  "business_os_subscription_cancellations",
  "business_os_setup_epochs",
  "certificate_delivery_requests",
  "certificate_files",
  "certificate_prerequisites",
  "certificate_recipient_name_heads",
  "certificate_recipient_name_versions",
  "certificate_records",
  "checkout_authorizations",
  "checkout_provider_actions",
  "checkout_sessions",
  "claim_tokens",
  "club_subscription_cancellations",
  "commerce_fulfillment_receipts",
  "commerce_reconciliations",
  "controlled_payment_authorizations",
  "content_archives",
  "content_media_assets",
  "content_media_tracks",
  "content_previews",
  "content_readiness_approvals",
  "content_readiness_evaluations",
  "content_resource_drafts",
  "content_schedules",
  "course_draft_manifest_entries",
  "course_drafts",
  "course_heads",
  "course_version_lessons",
  "course_versions",
  "courses",
  "course_completions",
  "entitlement_commands",
  "entitlement_grants",
  "entitlement_sources",
  "enrollment_version_transitions",
  "enrollments",
  "event_handler_receipts",
  "implementation_artifact_versions",
  "implementation_artifacts",
  "implementation_completion_artifact_snapshots",
  "implementation_completion_workflow_snapshots",
  "implementation_completions",
  "implementation_workflows",
  "invoice_line_allocations",
  "invoices",
  "job_attempts",
  "jobs",
  "lesson_accessibility_decisions",
  "lesson_accessibility_review_heads",
  "lesson_disclosure_decisions",
  "lesson_disclosure_review_heads",
  "lesson_drafts",
  "lesson_completions",
  "lesson_progress",
  "lesson_version_resources",
  "lesson_versions",
  "lessons",
  "member_identities",
  "memberships",
  "offer_catalog_versions",
  "offer_price_bindings",
  "offers",
  "outbox_events",
  "pending_claim_sessions",
  "provider_event_attempts",
  "provider_event_effects",
  "provider_event_processing",
  "provider_event_receipts",
  "public_business_os_setup_fulfillments",
  "public_business_os_setup_intents",
  "purchase_payment_allocations",
  "purchases",
  "recurring_purchase_intents",
  "resource_delivery_health",
  "seat_invitation_token_generations",
  "seat_invitations",
  "seat_reservations",
  "secure_link_deliveries",
  "staff_identities",
  "staff_login_attempts",
  "staff_sessions",
  "stage_drafts",
  "stages",
  "stripe_customer_creation_actions",
  "stripe_customers",
  "subscription_schedules",
  "subscriptions",
] as const;

type RuntimeLogin = Readonly<{
  capability: "syntholo_member_api" | "syntholo_staff_api" | "syntholo_worker";
  database: Database;
  password: string;
  roleName: string;
  url: string;
}>;

function loginDatabaseUrl(
  baseUrl: string,
  roleName: string,
  password: string,
  database = new URL(baseUrl).pathname.slice(1),
): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function formatSql(
  pool: Pool,
  template: string,
  values: string[],
): Promise<string> {
  const placeholders = values.map((_, index) => `$${index + 1}::text`).join(", ");
  const result = await pool.query<{ statement: string }>(
    `select format($fmt$${template}$fmt$, ${placeholders}) as statement`,
    values,
  );
  const statement = result.rows[0]?.statement;
  if (statement === undefined) {
    throw new Error("TEST_SQL_FORMAT_FAILED");
  }
  return statement;
}

async function createRuntimeLogin(
  owner: Database,
  baseUrl: string,
  kind: "member" | "staff" | "worker",
  capability: RuntimeLogin["capability"],
): Promise<RuntimeLogin> {
  const roleName = `syntholo_test_${kind}_${process.pid}`;
  const password = randomUUID();
  const createRole = await formatSql(
    owner.pool,
    "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    [roleName, password],
  );
  const grantCapability = await formatSql(
    owner.pool,
    `grant ${capability} to %I with inherit true, set false, admin false`,
    [roleName],
  );
  await owner.pool.query(createRole);
  await owner.pool.query(grantCapability);
  const url = loginDatabaseUrl(baseUrl, roleName, password);
  const database = createDatabase({
    applicationName: `syntholo-${kind}-login-integration`,
    url,
  });
  return { capability, database, password, roleName, url };
}

async function dropRuntimeLogin(owner: Database, login: RuntimeLogin): Promise<void> {
  const revoke = await formatSql(
    owner.pool,
    `revoke ${login.capability} from %I`,
    [login.roleName],
  );
  const drop = await formatSql(owner.pool, "drop role if exists %I", [login.roleName]);
  await owner.pool.query(revoke);
  await owner.pool.query(drop);
}

async function seedFoundationRows(database: Database): Promise<void> {
  await database.pool.query(
    `insert into accounts (id, name) values ($1, $2), ($3, $4)`,
    [accountA, "Account A", accountB, "Account B"],
  );
  await database.pool.query(
    `insert into member_identities
      (id, account_id, provider, provider_user_id)
     values ($1, $2, 'clerk', 'member_a'), ($3, $4, 'clerk', 'member_b')`,
    [identityA, accountA, identityB, accountB],
  );
  await database.pool.query(
    `insert into memberships
      (id, account_id, member_identity_id, role)
     values ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner')`,
    [membershipA, accountA, identityA, membershipB, accountB, identityB],
  );
  await database.pool.query(
    `insert into staff_identities
      (provider_user_id, role)
     values ('staff_a', 'admin')`,
  );
  await database.pool.query(
    `insert into audit_events
      (account_id, actor_type, actor_id, correlation_id, action, target_type, occurred_at)
     values ($1, 'member', 'member_a', $3, 'created', 'account', $5),
            ($2, 'member', 'member_b', $4, 'created', 'account', $5)`,
    [accountA, accountB,
      "10000000-0000-4000-8000-000000000091",
      "20000000-0000-4000-8000-000000000092",
      new Date("2026-08-13T15:00:00.000Z")],
  );
  await database.pool.query(
    `insert into outbox_events
      (account_id, actor_type, actor_id, correlation_id, occurred_at, type, aggregate_id, payload)
     values ($1, 'member', 'member_a', $5, now(), 'account.created', $3, '{}'),
            ($2, 'member', 'member_b', $6, now(), 'account.created', $4, '{}')`,
    [accountA, accountB, accountA, accountB,
      "10000000-0000-4000-8000-000000000091",
      "20000000-0000-4000-8000-000000000092"],
  );
  await database.pool.query(
    `insert into jobs
      (account_id, source_actor_type, source_actor_id, correlation_id, type, payload)
     values ($1, 'member', 'member_a', $3, 'sync.account', '{}'),
            ($2, 'member', 'member_b', $4, 'sync.account', '{}')`,
    [accountA, accountB,
      "10000000-0000-4000-8000-000000000091",
      "20000000-0000-4000-8000-000000000092"],
  );
  await database.pool.query(
    `insert into provider_event_receipts
      (provider, provider_event_id)
     values ('mux', 'evt_rls_seed')`,
  );
}

async function currentScope(database: Database): Promise<string | null> {
  const result = await database.pool.query<{ account_id: string | null }>(
    "select nullif(current_setting('app.account_id', true), '') as account_id",
  );
  return result.rows[0]?.account_id ?? null;
}

async function currentTrustedScope(database: Database): Promise<Record<string, string | null>> {
  const result = await database.pool.query<Record<string, string | null>>(
    `select nullif(current_setting('app.account_id', true), '') as account_id,
            nullif(current_setting('app.actor_id', true), '') as actor_id,
            nullif(current_setting('app.actor_kind', true), '') as actor_kind,
            nullif(current_setting('app.correlation_id', true), '') as correlation_id`,
  );
  return result.rows[0]!;
}

function databaseName(kind: string): string {
  if (!/^[a-z0-9_]+$/u.test(kind)) {
    throw new Error("INVALID_TEST_DATABASE_KIND");
  }
  return `syntholo_rls_${kind}_${process.pid}`;
}

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteDatabaseName(name: string): string {
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new Error("INVALID_TEST_DATABASE_NAME");
  }
  return `"${name}"`;
}

async function dropDatabase(pool: Pool, name: string): Promise<void> {
  await pool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [name],
  );
  await pool.query(`drop database if exists ${quoteDatabaseName(name)}`);
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectProvisioningFailure(run: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  expect(errorChain(error)).toContain(
    "SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED",
  );
}

describe.sequential("capability role provisioning migration", () => {
  const actorName = `syntholo_test_migrator_${process.pid}`;
  const actorPassword = randomUUID();
  const privilegedCollisionRole = `syntholo_test_bypass_${process.pid}`;
  const databaseNames = {
    first: databaseName("provision_first"),
    second: databaseName("provision_second"),
    loginCollision: databaseName("collision_login"),
    membershipCollision: databaseName("collision_membership"),
    settingCollision: databaseName("collision_setting"),
  } as const;
  let baseUrl: string;
  let maintenance: Pool;
  let nestedDatabaseAuthorityAvailable = false;
  const preservedCapabilityRoles = new Map<string, string>();

  beforeAll(async () => {
    baseUrl = process.env.TEST_DATABASE_URL ?? "";
    if (baseUrl === "") {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    maintenance = new Pool({
      application_name: "syntholo-role-provisioning-maintenance",
      connectionString: databaseUrl(baseUrl, "postgres"),
      max: 1,
      options: "-c row_security=on -c app.account_id=",
    });
    const createActor = await formatSql(
      maintenance,
      "create role %I login password %L createrole nosuperuser nocreatedb noreplication nobypassrls",
      [actorName, actorPassword],
    );
    await maintenance.query(createActor);
    const authority = await maintenance.query<{ can_set_role: boolean }>(
      "select pg_has_role(session_user,$1,'SET') as can_set_role",
      [actorName],
    );
    if (authority.rows[0]?.can_set_role !== true) return;
    nestedDatabaseAuthorityAvailable = true;
    for (const capability of capabilityRoles) {
      const exists = await maintenance.query<{ exists: boolean }>(
        "select exists(select 1 from pg_roles where rolname = $1) as exists",
        [capability],
      );
      if (exists.rows[0]?.exists) {
        const preserved = `${capability}_preserved_${process.pid}`;
        const rename = await formatSql(
          maintenance,
          "alter role %I rename to %I",
          [capability, preserved],
        );
        await maintenance.query(rename);
        preservedCapabilityRoles.set(capability, preserved);
      }
    }
    for (const name of Object.values(databaseNames)) {
      await dropDatabase(maintenance, name);
      const createDatabaseStatement = await formatSql(
        maintenance,
        "create database %I owner %I",
        [name, actorName],
      );
      await maintenance.query(createDatabaseStatement);
    }
  });

  afterAll(async () => {
    for (const capability of capabilityRoles) {
      const revoke = await formatSql(
        maintenance,
        `revoke ${capability} from %I`,
        [actorName],
      );
      await maintenance.query(revoke).catch(() => undefined);
    }
    const resetLogin = await formatSql(
      maintenance,
      "alter role %I nologin password null",
      ["syntholo_member_api"],
    );
    await maintenance.query(resetLogin).catch(() => undefined);
    const resetSetting = await formatSql(
      maintenance,
      "alter role %I in database %I reset all",
      ["syntholo_staff_api", databaseNames.settingCollision],
    );
    await maintenance.query(resetSetting).catch(() => undefined);
    const revokePrivileged = await formatSql(
      maintenance,
      "revoke %I from %I",
      [privilegedCollisionRole, "syntholo_worker"],
    );
    await maintenance.query(revokePrivileged).catch(() => undefined);
    for (const name of Object.values(databaseNames)) {
      await dropDatabase(maintenance, name).catch(() => undefined);
    }
    const dropPrivileged = await formatSql(
      maintenance,
      "drop role if exists %I",
      [privilegedCollisionRole],
    );
    await maintenance.query(dropPrivileged).catch(() => undefined);
    const dropActor = await formatSql(
      maintenance,
      "drop role if exists %I",
      [actorName],
    );
    await maintenance.query(dropActor).catch(() => undefined);
    for (const capability of [...capabilityRoles].reverse()) {
      const dropCapability = await formatSql(
        maintenance,
        "drop role if exists %I",
        [capability],
      );
      await maintenance.query(dropCapability).catch(() => undefined);
      const preserved = preservedCapabilityRoles.get(capability);
      if (preserved !== undefined) {
        const restore = await formatSql(
          maintenance,
          "alter role %I rename to %I",
          [preserved, capability],
        );
        await maintenance.query(restore);
      }
    }
    await maintenance.end();
  });

  it("applies fresh, reuses safe cluster roles in a second owned database, and reruns as a non-superuser CREATEROLE actor", async ({ skip }) => {
    if (!nestedDatabaseAuthorityAvailable) {
      skip("maintenance login cannot SET ROLE to a nested database owner");
    }
    const actorState = await maintenance.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolreplication, rolbypassrls
       from pg_roles where rolname = $1`,
      [actorName],
    );
    expect(actorState.rows[0]).toEqual({
      rolbypassrls: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: true,
      rolreplication: false,
      rolsuper: false,
    });

    const first = createDatabase({
      applicationName: "syntholo-nonsuper-migration-first",
      url: loginDatabaseUrl(
        baseUrl,
        actorName,
        actorPassword,
        databaseNames.first,
      ),
    });
    const second = createDatabase({
      applicationName: "syntholo-nonsuper-migration-second",
      url: loginDatabaseUrl(
        baseUrl,
        actorName,
        actorPassword,
        databaseNames.second,
      ),
    });
    try {
      await migrateDatabase(first);
      const seedDormantPassword = await formatSql(
        maintenance,
        "alter role %I password %L",
        ["syntholo_member_api", randomUUID()],
      );
      await maintenance.query(seedDormantPassword);
      await migrateDatabase(second);
      await migrateDatabase(second);
      const journals = await Promise.all([first, second].map((database) =>
        database.pool.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations",
        )
      ));
      expect(journals.map(({ rows }) => rows[0]?.count)).toEqual([
        String(PUBLISHED_MIGRATIONS.length),
        String(PUBLISHED_MIGRATIONS.length),
      ]);
      const passwords = await maintenance.query<{
        rolname: string;
        rolpasswordisnull: boolean;
      }>(
        `select rolname, rolpassword is null as rolpasswordisnull
         from pg_authid
         where rolname = any($1::text[])
         order by rolname`,
        [capabilityRoles],
      );
      expect(passwords.rows).toEqual(capabilityRoles.map((rolname) => ({
        rolname,
        rolpasswordisnull: true,
      })));
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  }, 30_000);

  it("fails closed on an existing LOGIN/password capability collision", async ({ skip }) => {
    if (!nestedDatabaseAuthorityAvailable) {
      skip("maintenance login cannot SET ROLE to a nested database owner");
    }
    const makeUnsafe = await formatSql(
      maintenance,
      "alter role %I login password %L",
      ["syntholo_member_api", randomUUID()],
    );
    const restore = await formatSql(
      maintenance,
      "alter role %I nologin password null",
      ["syntholo_member_api"],
    );
    const database = createDatabase({
      applicationName: "syntholo-login-collision-migration",
      url: loginDatabaseUrl(
        baseUrl,
        actorName,
        actorPassword,
        databaseNames.loginCollision,
      ),
    });
    try {
      await maintenance.query(makeUnsafe);
      await expectProvisioningFailure(migrateDatabase(database));
    } finally {
      await database.close();
      await maintenance.query(restore);
    }
  }, 20_000);

  it("fails closed on outbound privileged membership", async ({ skip }) => {
    if (!nestedDatabaseAuthorityAvailable) {
      skip("maintenance login cannot SET ROLE to a nested database owner");
    }
    const createPrivileged = await formatSql(
      maintenance,
      "create role %I nologin bypassrls",
      [privilegedCollisionRole],
    );
    const grantPrivileged = await formatSql(
      maintenance,
      "grant %I to %I",
      [privilegedCollisionRole, "syntholo_worker"],
    );
    const revokePrivileged = await formatSql(
      maintenance,
      "revoke %I from %I",
      [privilegedCollisionRole, "syntholo_worker"],
    );
    const dropPrivileged = await formatSql(
      maintenance,
      "drop role if exists %I",
      [privilegedCollisionRole],
    );
    const database = createDatabase({
      applicationName: "syntholo-membership-collision-migration",
      url: loginDatabaseUrl(
        baseUrl,
        actorName,
        actorPassword,
        databaseNames.membershipCollision,
      ),
    });
    try {
      await maintenance.query(createPrivileged);
      await maintenance.query(grantPrivileged);
      await expectProvisioningFailure(migrateDatabase(database));
    } finally {
      await database.close();
      await maintenance.query(revokePrivileged).catch(() => undefined);
      await maintenance.query(dropPrivileged).catch(() => undefined);
    }
  }, 20_000);

  it("fails closed on a database-specific capability role setting", async ({ skip }) => {
    if (!nestedDatabaseAuthorityAvailable) {
      skip("maintenance login cannot SET ROLE to a nested database owner");
    }
    const setConfig = await formatSql(
      maintenance,
      "alter role %I in database %I set application_name = 'unsafe-capability-default'",
      ["syntholo_staff_api", databaseNames.settingCollision],
    );
    const resetConfig = await formatSql(
      maintenance,
      "alter role %I in database %I reset all",
      ["syntholo_staff_api", databaseNames.settingCollision],
    );
    const database = createDatabase({
      applicationName: "syntholo-setting-collision-migration",
      url: loginDatabaseUrl(
        baseUrl,
        actorName,
        actorPassword,
        databaseNames.settingCollision,
      ),
    });
    try {
      await maintenance.query(setConfig);
      await expectProvisioningFailure(migrateDatabase(database));
    } finally {
      await database.close();
      await maintenance.query(resetConfig);
    }
  }, 20_000);
});

describe("runtime login database URL", () => {
  it("preserves required transport security query parameters when changing login authority", () => {
    const rewritten = new URL(loginDatabaseUrl(
      "postgresql://owner:secret@db.example.test/syntholo?sslmode=require&channel_binding=require&connect_timeout=5",
      "runtime_member",
      "new-secret",
      "tenant_database",
    ));
    expect(rewritten.username).toBe("runtime_member");
    expect(rewritten.pathname).toBe("/tenant_database");
    expect(Object.fromEntries(rewritten.searchParams)).toEqual({
      channel_binding: "require",
      connect_timeout: "5",
      sslmode: "require",
    });
  });
});

describe("PostgreSQL account role boundary", () => {
  let harness: TestDatabaseHarness;
  let memberLogin: RuntimeLogin;
  let staffLogin: RuntimeLogin;
  let workerLogin: RuntimeLogin;
  let memberDb: Database;
  let staffDb: Database;
  let workerDb: Database;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    const originalPgOptions = process.env.PGOPTIONS;
    process.env.PGOPTIONS =
      "-c row_security=off -c app.account_id=20000000-0000-4000-8000-000000000002";
    try {
      memberLogin = await createRuntimeLogin(
        harness.database,
        baseUrl,
        "member",
        "syntholo_member_api",
      );
      staffLogin = await createRuntimeLogin(
        harness.database,
        baseUrl,
        "staff",
        "syntholo_staff_api",
      );
      workerLogin = await createRuntimeLogin(
        harness.database,
        baseUrl,
        "worker",
        "syntholo_worker",
      );
    } finally {
      if (originalPgOptions === undefined) {
        delete process.env.PGOPTIONS;
      } else {
        process.env.PGOPTIONS = originalPgOptions;
      }
    }
    memberDb = memberLogin.database;
    staffDb = staffLogin.database;
    workerDb = workerLogin.database;
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await Promise.allSettled([
      memberDb?.close(),
      staffDb?.close(),
      workerDb?.close(),
    ]);
    if (harness !== undefined) {
      for (const login of [memberLogin, staffLogin, workerLogin]) {
        if (login !== undefined) {
          await dropRuntimeLogin(harness.database, login);
        }
      }
      await harness.close();
    }
  });

  it("creates exactly five inert capability roles with no password, settings, or outbound membership", async () => {
    const result = await harness.database.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolconfig: string[] | null;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolname: string;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolreplication, rolbypassrls, rolconfig
       from pg_roles
       where rolname = any($1::text[])
       order by rolname`,
      [capabilityRoles],
    );

    expect(result.rows[0]?.rolbypassrls).toBe(false);
    expect(result.rows).toEqual(capabilityRoles.map((rolname) => ({
      rolbypassrls: false,
      rolcanlogin: false,
      rolconfig: null,
      rolcreatedb: false,
      rolcreaterole: false,
      rolname,
      rolreplication: false,
      rolsuper: false,
    })));
    const passwords = await harness.database.pool.query<{
      rolname: string;
      rolpasswordisnull: boolean;
    }>(
      `select rolname, rolpassword is null as rolpasswordisnull
       from pg_authid
       where rolname = any($1::text[])
       order by rolname`,
      [capabilityRoles],
    );
    expect(passwords.rows).toEqual(capabilityRoles.map((rolname) => ({
      rolname,
      rolpasswordisnull: true,
    })));
    const settings = await harness.database.pool.query(
      `select setrole, setdatabase, setconfig
       from pg_db_role_setting
       where setrole = any(
         select oid from pg_roles where rolname = any($1::text[])
       )`,
      [capabilityRoles],
    );
    expect(settings.rows).toEqual([]);
    const outboundMemberships = await harness.database.pool.query(
      `select member_role.rolname as member_role, parent_role.rolname as parent_role
       from pg_auth_members membership
       join pg_roles member_role on member_role.oid = membership.member
       join pg_roles parent_role on parent_role.oid = membership.roleid
       where member_role.rolname = any($1::text[])`,
      [capabilityRoles],
    );
    expect(outboundMemberships.rows).toEqual([]);
  });

  it("enables and forces RLS with the exact policies on original customer tables", async () => {
    const tableState = await harness.database.pool.query<{
      relforcerowsecurity: boolean;
      relname: string;
      relrowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
       from pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname`,
      [customerTables],
    );
    expect(tableState.rows).toEqual(customerTables.map((relname) => ({
      relforcerowsecurity: true,
      relname,
      relrowsecurity: true,
    })));

    const policies = await harness.database.pool.query<{
      cmd: string;
      policyname: string;
      roles: string[];
      tablename: string;
    }>(
      `select tablename, policyname, roles::text[] as roles, cmd
       from pg_policies
       where schemaname = 'public'
         and tablename = any($1::text[])
       order by tablename, policyname`,
      [customerTables],
    );
    const universalPolicies = customerTables.flatMap((tablename) => [
      {
        cmd: "ALL",
        policyname: `${tablename}_migrator_admin`,
        roles: ["syntholo_migrator"],
        tablename,
      },
      {
        cmd: "SELECT",
        policyname: `${tablename}_staff_read`,
        roles: ["syntholo_staff_api"],
        tablename,
      },
    ]);
    const memberPolicies = [
      "accounts",
      "member_identities",
      "memberships",
    ].flatMap((tablename) => ["INSERT", "SELECT", "UPDATE"].map((cmd) => ({
      cmd,
      policyname: `${tablename}_member_${cmd.toLowerCase()}`,
      roles: ["syntholo_member_api"],
      tablename,
    })));
    const workerPolicies: Array<{
      cmd: string; policyname: string; roles: string[]; tablename: string;
    }> = [];

    expect(policies.rows).toEqual([
      ...universalPolicies,
      ...memberPolicies,
      { cmd: "INSERT", policyname: "audit_events_member_insert", roles: ["syntholo_member_api"], tablename: "audit_events" },
      { cmd: "INSERT", policyname: "audit_events_staff_insert", roles: ["syntholo_staff_api"], tablename: "audit_events" },
      { cmd: "INSERT", policyname: "audit_events_system_insert", roles: ["syntholo_system_api"], tablename: "audit_events" },
      { cmd: "SELECT", policyname: "accounts_system_scope", roles: ["syntholo_system_api"], tablename: "accounts" },
      { cmd: "INSERT", policyname: "outbox_events_member_insert", roles: ["syntholo_member_api"], tablename: "outbox_events" },
      { cmd: "INSERT", policyname: "outbox_events_staff_insert", roles: ["syntholo_staff_api"], tablename: "outbox_events" },
      { cmd: "INSERT", policyname: "outbox_events_system_insert", roles: ["syntholo_system_api"], tablename: "outbox_events" },
      ...workerPolicies,
    ].sort(
      (left, right) =>
        `${left.tablename}:${left.policyname}`.localeCompare(
          `${right.tablename}:${right.policyname}`,
      ),
    ));
    expect(policies.rows.some(({ cmd, roles }) =>
      cmd === "DELETE" && roles.includes("syntholo_member_api")
    )).toBe(false);
    expect(policies.rows.some(({ roles, tablename, cmd }) =>
      roles.includes("syntholo_member_api")
      && ["audit_events", "outbox_events"].includes(tablename)
      && cmd !== "INSERT"
    )).toBe(false);
  });

  it("runs through actual safe login roles with exactly one inherited runtime capability", async () => {
    for (const login of [memberLogin, staffLogin, workerLogin]) {
      const identity = await login.database.pool.query<{
        current_user: string;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolconfig: string[] | null;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolsuper: boolean;
        session_user: string;
      }>(
        `select current_user, session_user, rolcanlogin, rolsuper, rolcreatedb,
                rolcreaterole, rolreplication, rolbypassrls, rolconfig
         from pg_roles
         where rolname = current_user`,
      );
      expect(identity.rows[0]).toEqual({
        current_user: login.roleName,
        rolbypassrls: false,
        rolcanlogin: true,
        rolconfig: null,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolsuper: false,
        session_user: login.roleName,
      });
      const memberships = await login.database.pool.query<{
        admin_option: boolean;
        inherit_option: boolean;
        rolname: string;
        set_option: boolean;
      }>(
        `select parent.rolname, membership.admin_option,
                membership.inherit_option, membership.set_option
         from pg_auth_members membership
         join pg_roles member on member.oid = membership.member
         join pg_roles parent on parent.oid = membership.roleid
         where member.rolname = current_user
         order by parent.rolname`,
      );
      expect(memberships.rows).toEqual([{
        admin_option: false,
        inherit_option: true,
        rolname: login.capability,
        set_option: false,
      }]);
      const reachable = await login.database.pool.query<{ rolname: string }>(
        `with recursive reachable(roleid) as (
           select membership.roleid
           from pg_auth_members membership
           join pg_roles member on member.oid = membership.member
           where member.rolname = current_user
           union
           select membership.roleid
           from pg_auth_members membership
           join reachable on reachable.roleid = membership.member
         )
         select role.rolname
         from reachable join pg_roles role on role.oid = reachable.roleid
         order by role.rolname`,
      );
      expect(reachable.rows).toEqual([{ rolname: login.capability }]);
      const settings = await login.database.pool.query(
        `select setdatabase, setconfig
         from pg_db_role_setting
         where setrole = (
           select oid from pg_roles where rolname = current_user
         )`,
      );
      expect(settings.rows).toEqual([]);
    }
  });

  it("shows a member only its account, identities, and memberships", async () => {
    await seedFoundationRows(harness.database);

    const visible = await withAccountScope(memberDb, accountA, async (tx) => {
      const accountRows = await tx.select({ id: accounts.id }).from(accounts);
      const identityRows = await tx.select({ id: memberIdentities.id })
        .from(memberIdentities);
      const membershipRows = await tx.select({ id: memberships.id })
        .from(memberships);
      const rawOther = await tx.select({ id: accounts.id }).from(accounts).where(
        eq(accounts.id, accountB),
      );
      return { accountRows, identityRows, membershipRows, rawOther };
    });

    expect(visible.accountRows).toEqual([{ id: accountA }]);
    expect(visible.identityRows).toEqual([{ id: identityA }]);
    expect(visible.membershipRows).toEqual([{ id: membershipA }]);
    expect(visible.rawOther).toEqual([]);
  });

  it("exposes only scoped AccountRepository reads and hides cross-account existence", async () => {
    const { AccountRepository } = await import("./index.js");
    const repository = new AccountRepository(memberDb);
    type RepositoryPublicKey = keyof typeof repository;
    const publicContract: Record<RepositoryPublicKey, true> = {
      getById: true,
    };
    await seedFoundationRows(harness.database);

    expect(Object.getOwnPropertyNames(AccountRepository.prototype).sort()).toEqual([
      "constructor",
      "getById",
    ]);
    expect(publicContract).toEqual({ getById: true });
    await expect(repository.getById({ accountId: accountA }, accountA))
      .resolves.toMatchObject({ id: accountA, name: "Account A" });
    await expect(repository.getById({ accountId: accountA }, accountB))
      .resolves.toBeNull();
    await expect(repository.getById({ accountId: accountB }, accountA))
      .resolves.toBeNull();
  });

  it("fails closed with no scope and cannot insert or update", async () => {
    await seedFoundationRows(harness.database);

    const startupState = await memberDb.pool.query<{
      account_id: string;
      row_security: string;
    }>(
      `select current_setting('app.account_id', true) as account_id,
              current_setting('row_security') as row_security`,
    );
    expect(startupState.rows[0]).toEqual({
      account_id: "",
      row_security: "on",
    });
    expect(await memberDb.select({ id: accounts.id }).from(accounts)).toEqual([]);
    await expect(memberDb.insert(accounts).values({
      id: "30000000-0000-4000-8000-000000000003",
      name: "Unscoped insert",
    })).rejects.toMatchObject({ cause: { code: "42501" } });

    const updated = await memberDb.update(accounts)
      .set({ name: "Unscoped update" })
      .where(eq(accounts.id, accountA))
      .returning({ id: accounts.id });
    expect(updated).toEqual([]);
    const ownerView = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountA],
    );
    expect(ownerView.rows[0]?.name).toBe("Account A");
  });

  it("does not leak account scope across success, rollback, or back-to-back requests", async () => {
    await seedFoundationRows(harness.database);

    const first = await withAccountScope(memberDb, accountA, async (tx) => {
      const setting = await tx.execute<{ account_id: string }>(
        sql`select current_setting('app.account_id') as account_id`,
      );
      const rows = await tx.select({ id: accounts.id }).from(accounts);
      return { rows, setting: setting.rows[0]?.account_id };
    });
    expect(first).toEqual({ rows: [{ id: accountA }], setting: accountA });
    expect(await currentScope(memberDb)).toBeNull();

    await expect(withAccountScope(memberDb, accountA, async (tx) => {
      const rows = await tx.select({ id: accounts.id }).from(accounts);
      expect(rows).toEqual([{ id: accountA }]);
      throw new Error("EXPECTED_ROLLBACK");
    })).rejects.toThrow("EXPECTED_ROLLBACK");
    expect(await currentScope(memberDb)).toBeNull();

    const second = await withAccountScope(memberDb, accountB, (tx) =>
      tx.select({ id: accounts.id }).from(accounts)
    );
    expect(second).toEqual([{ id: accountB }]);
    expect(await currentScope(memberDb)).toBeNull();
    expect(await memberDb.select({ id: accounts.id }).from(accounts)).toEqual([]);
    expect(memberDb.pool.totalCount).toBe(1);
  });

  it("commits attested member and staff audit/outbox facts through actual runtime logins", async () => {
    await seedFoundationRows(harness.database);
    const occurredAt = new Date("2026-08-13T16:00:00.000Z");
    const member = createUnitOfWork(memberDb, {
      accountId: accountA,
      actor: {
        accountId: accountA,
        actorId: identityA,
        authenticatedAt: occurredAt,
        clerkUserId: "member_a",
        kind: "member",
        membershipId: membershipA,
        role: "owner",
      },
      clock: { now: () => occurredAt },
      correlationId: "10000000-0000-4000-8000-000000000093",
    });
    await member.transaction(async (transaction) => {
      await transaction.accounts.rename("Member attested");
      await transaction.audit.append({
        action: "account_name_changed",
        payload: { changedFields: ["name"] },
        targetId: accountA,
        targetType: "account",
      });
      await transaction.outbox.enqueue(transaction.outbox.create({
        aggregateId: accountA,
        eventId: "10000000-0000-4000-8000-000000000094",
        payload: { changedFields: ["name"] },
        type: "foundation.account_name_changed.v1",
      }));
    });
    expect(await currentTrustedScope(memberDb)).toEqual({
      account_id: null,
      actor_id: null,
      actor_kind: null,
      correlation_id: null,
    });
    const retryEventId = "10000000-0000-4000-8000-000000000083";
    await Promise.all(Array.from({ length: 8 }, () => member.transaction(async (transaction) => {
      await transaction.outbox.enqueueOnce(transaction.outbox.create({
        aggregateId: accountA,
        eventId: retryEventId,
        payload: { changedFields: ["name"] },
        type: "foundation.account_name_changed.v1",
      }));
    })));
    expect((await harness.database.pool.query(
      "select count(*)::int as count from outbox_events where event_id=$1",
      [retryEventId],
    )).rows[0]?.count).toBe(1);
    await expect(member.transaction(async (transaction) => {
      await transaction.outbox.enqueueOnce(transaction.outbox.create({
        aggregateId: accountA,
        eventId: retryEventId,
        payload: { changedFields: ["status"] },
        type: "foundation.account_name_changed.v1",
      }));
    })).rejects.toThrow("OUTBOX_EVENT_CONFLICT");
    await expect(memberDb.pool.query(
      `select public.syntholo_enqueue_outbox_once(
        $1,null,'system','forged',$2,'foundation.aggregate_created.v1',
        'foundation_1',$3,'{"referenceId":"foundation_1"}'::jsonb)`,
      [
        "10000000-0000-4000-8000-000000000081",
        "10000000-0000-4000-8000-000000000082",
        occurredAt,
      ],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(member.transaction(async () => {
      throw new Error("EXPECTED_UOW_ROLLBACK");
    })).rejects.toThrow("EXPECTED_UOW_ROLLBACK");
    expect(await currentTrustedScope(memberDb)).toEqual({
      account_id: null,
      actor_id: null,
      actor_kind: null,
      correlation_id: null,
    });

    const staff = createUnitOfWork(staffDb, {
      accountId: null,
      actor: {
        actorId: "20000000-0000-4000-8000-000000000095",
        authenticatedAt: occurredAt,
        kind: "staff",
        permissions: ["foundation:write"],
        role: "admin",
        staffId: "20000000-0000-4000-8000-000000000096",
        workosUserId: "staff_a",
      },
      clock: { now: () => occurredAt },
      correlationId: "20000000-0000-4000-8000-000000000097",
    });
    await staff.transaction(async (transaction) => {
      await transaction.audit.append({
        action: "foundation_tested",
        payload: { referenceId: "foundation_1" },
        targetId: null,
        targetType: "foundation",
      });
      await transaction.outbox.enqueue(transaction.outbox.create({
        aggregateId: "foundation_1",
        eventId: "20000000-0000-4000-8000-000000000098",
        payload: { referenceId: "foundation_1" },
        type: "foundation.aggregate_created.v1",
      }));
    });

    expect(() => createUnitOfWork(memberDb, {
      accountId: accountB,
      actor: {
        accountId: accountA,
        actorId: identityA,
        authenticatedAt: occurredAt,
        clerkUserId: "member_a",
        kind: "member",
        membershipId: membershipA,
        role: "owner",
      },
      clock: { now: () => occurredAt },
      correlationId: "10000000-0000-4000-8000-000000000093",
    })).toThrow("ACTOR_ACCOUNT_MISMATCH");

    const persisted = await harness.database.pool.query(
      `select actor_type, actor_id, account_id, correlation_id
       from audit_events where correlation_id in ($1,$2) order by actor_type`,
      ["10000000-0000-4000-8000-000000000093",
        "20000000-0000-4000-8000-000000000097"],
    );
    expect(persisted.rows).toEqual([
      {
        account_id: accountA,
        actor_id: identityA,
        actor_type: "member",
        correlation_id: "10000000-0000-4000-8000-000000000093",
      },
      {
        account_id: null,
        actor_id: "20000000-0000-4000-8000-000000000095",
        actor_type: "staff",
        correlation_id: "20000000-0000-4000-8000-000000000097",
      },
    ]);
  });

  it.each([
    ["cross-account", accountB],
    ["null-account", null],
  ])("denies %s audit and outbox inserts under an account-A member scope", async (_label, rowAccount) => {
    await seedFoundationRows(harness.database);
    const correlationId = "10000000-0000-4000-8000-000000000087";
    const scopedInsert = (statement: string) => memberDb.transaction(async (transaction) => {
      await transaction.execute(sql`select
        set_config('app.account_id', ${accountA}, true),
        set_config('app.actor_id', ${identityA}, true),
        set_config('app.actor_kind', 'member', true),
        set_config('app.correlation_id', ${correlationId}, true)`);
      await transaction.execute(sql.raw(statement));
    });
    const accountSql = rowAccount === null ? "null" : `'${rowAccount}'::uuid`;
    await expect(scopedInsert(
      `insert into audit_events
       (account_id,actor_type,actor_id,action,target_type,correlation_id,payload,occurred_at)
       values (${accountSql},'member','${identityA}','foundation_tested','foundation',
         '${correlationId}'::uuid,'{}',now())`,
    )).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(scopedInsert(
      `insert into outbox_events
       (event_id,account_id,actor_type,actor_id,correlation_id,type,aggregate_id,
        occurred_at,payload,available_at)
       values ('10000000-0000-4000-8000-000000000086',${accountSql},'member',
         '${identityA}','${correlationId}'::uuid,'foundation.aggregate_created.v1',
         'foundation_1',now(),'{}',now())`,
    )).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("rejects a non-canonical scope before opening a database connection", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    const unopened = createDatabase({
      applicationName: "syntholo-invalid-scope-integration",
      url: memberLogin.url,
    });

    try {
      expect(unopened.pool.totalCount).toBe(0);
      await expect(withAccountScope(
        unopened,
        "10000000-0000-4000-8000-000000000001' OR true --",
        async () => "not reached",
      )).rejects.toThrow("ACCOUNT_ID_INVALID");
      expect(unopened.pool.totalCount).toBe(0);
    } finally {
      await unopened.close();
    }
  });

  it("denies member operational, staff, provider, and delete privileges", async () => {
    await seedFoundationRows(harness.database);

    await expect(memberDb.select().from(auditEvents)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await expect(memberDb.insert(outboxEvents).values({
      accountId: accountA,
      actorId: "member-test",
      actorType: "member",
      aggregateId: accountA,
      correlationId: "10000000-0000-4000-8000-000000000099",
      eventId: "10000000-0000-4000-8000-000000000088",
      occurredAt: new Date("2026-08-13T16:00:00.000Z"),
      payload: {},
      type: "forbidden",
    })).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(memberDb.select().from(jobs)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await expect(memberDb.select().from(staffIdentities)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await expect(memberDb.select().from(providerEventReceipts)).rejects
      .toMatchObject({ cause: { code: "42501" } });
    await expect(withAccountScope(memberDb, accountA, (tx) =>
      tx.delete(accounts).where(eq(accounts.id, accountA))
    )).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("allows staff cross-account reads but no customer mutation", async () => {
    await seedFoundationRows(harness.database);

    const accountRows = await staffDb.select({ id: accounts.id }).from(accounts);
    const identityRows = await staffDb.select({ id: memberIdentities.id })
      .from(memberIdentities);
    const membershipRows = await staffDb.select({ id: memberships.id })
      .from(memberships);
    const auditRows = await staffDb.select({ id: auditEvents.id })
      .from(auditEvents);
    const outboxRows = await staffDb.select({ id: outboxEvents.eventId })
      .from(outboxEvents);
    const jobRows = await staffDb.select({ id: jobs.id }).from(jobs);
    expect(accountRows).toHaveLength(2);
    expect(identityRows).toHaveLength(2);
    expect(membershipRows).toHaveLength(2);
    expect(auditRows).toHaveLength(2);
    expect(outboxRows).toHaveLength(2);
    expect(jobRows).toHaveLength(2);
    expect(await staffDb.select().from(staffIdentities)).toHaveLength(1);
    await expect(staffDb.select().from(providerEventReceipts)).rejects
      .toMatchObject({ cause: { code: "42501" } });
    await expect(staffDb.update(accounts).set({ name: "Forbidden staff write" }))
      .rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("limits the worker to append and processing operations on operational tables", async () => {
    await seedFoundationRows(harness.database);

    await expect(workerDb.select().from(accounts)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await expect(workerDb.select().from(memberIdentities)).rejects
      .toMatchObject({ cause: { code: "42501" } });

    await expect(workerDb.insert(auditEvents).values({
      accountId: accountA,
      action: "processed",
      actorId: "worker-test",
      actorType: "system",
      correlationId: "10000000-0000-4000-8000-000000000099",
      occurredAt: new Date("2026-08-13T16:00:00.000Z"),
      targetType: "job",
    })).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(workerDb.update(auditEvents).set({ action: "forbidden" }))
      .rejects.toMatchObject({ cause: { code: "42501" } });

    await expect(workerDb.insert(outboxEvents).values({
      accountId: accountA,
      actorId: "worker-test",
      actorType: "system",
      aggregateId: accountA,
      correlationId: "10000000-0000-4000-8000-000000000099",
      eventId: "10000000-0000-4000-8000-000000000089",
      occurredAt: new Date("2026-08-13T16:00:00.000Z"),
      payload: {},
      type: "worker.test",
    })).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(workerDb.update(outboxEvents)
      .set({ status: "processing" })
      .where(eq(outboxEvents.eventId, "10000000-0000-4000-8000-000000000089")))
      .rejects.toMatchObject({ cause: { code: "42501" } });

    await expect(workerDb.insert(jobs).values({
      accountId: accountA,
      correlationId: "10000000-0000-4000-8000-000000000099",
      payload: {},
      sourceActorId: "worker-test",
      sourceActorType: "system",
      type: "worker.test",
    })).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(workerDb.update(jobs)
      .set({ status: "running", workerId: "worker-test" })
      .where(eq(jobs.id, "10000000-0000-4000-8000-000000000089")))
      .rejects.toMatchObject({ cause: { code: "42501" } });

    await expect(workerDb.insert(providerEventReceipts).values({
      provider: "stripe",
      providerEventId: "evt_worker_insert",
    })).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(workerDb.delete(providerEventReceipts)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  });

  it("runs the function-only outbox, job, receipt, and worker-audit lifecycle as the actual worker login", async () => {
    await seedFoundationRows(harness.database);
    const now = new Date("2026-08-13T18:00:00.000Z");
    const eventId = "30000000-0000-4000-8000-000000000081";
    const correlationId = "30000000-0000-4000-8000-000000000082";
    await harness.database.pool.query(
      `insert into outbox_events
       (event_id, account_id, actor_type, actor_id, correlation_id, type,
        aggregate_id, occurred_at, payload, available_at)
       values ($1,$2,'member',$3,$4,'foundation.notification_sent.v1',
         $2::uuid::text,$5,'{"referenceId":"account_1"}',$5)`,
      [eventId, accountA, identityA, correlationId, now],
    );
    const outbox = new OutboxProcessorRepository(workerDb, { leaseMs: 10_000 });
    const jobsRepository = new JobRepository(workerDb, { leaseMs: 10_000 });
    const receipts = new HandlerReceiptRepository(workerDb, { leaseMs: 10_000 });
    const outboxClaim = (await outbox.claim(1, "actual-worker", now))[0]!;
    await expect(outbox.dispatch(
      outboxClaim,
      ["foundation_audit_projection"],
      now,
    )).resolves.toEqual({ jobsCreated: 1, kind: "published" });
    const jobClaim = (await jobsRepository.claim(1, "actual-worker", now))[0]!;
    const receipt = await receipts.acquire(jobClaim, now);
    expect(receipt).toMatchObject({ kind: "acquired", eventId });
    if (receipt.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");
    await expect(receipts.complete(receipt, new Date(now.getTime() + 1)))
      .resolves.toEqual({ kind: "completed" });
    await expect(jobsRepository.complete(jobClaim, new Date(now.getTime() + 2)))
      .resolves.toEqual({ kind: "completed" });

    const persisted = await harness.database.pool.query(
      `select o.status as event_status, j.status as job_status,
              r.status as receipt_status, a.account_id, a.actor_type,
              a.actor_id, a.correlation_id, a.action, a.payload
       from outbox_events o
       join jobs j on j.payload->>'eventId' = o.event_id::text
       join event_handler_receipts r on r.job_id = j.id
       join audit_events a on a.target_id = o.event_id::text
       where o.event_id = $1`,
      [eventId],
    );
    expect(persisted.rows).toEqual([{
      account_id: accountA,
      action: "handler_delivery_completed",
      actor_id: "actual-worker",
      actor_type: "system",
      correlation_id: correlationId,
      event_status: "published",
      job_status: "completed",
      payload: {
        eventId,
        handlerName: "foundation_audit_projection",
        outcome: "completed",
      },
      receipt_status: "completed",
    }]);
  });

  it("grants only the explicit current runtime table privilege matrix", async () => {
    const grants = await harness.database.pool.query<{
      grantee: string;
      privilege_type: string;
      table_name: string;
    }>(
      `select role.rolname grantee, relation.relname table_name, acl.privilege_type
       from pg_class relation
       join pg_namespace namespace on namespace.oid=relation.relnamespace
       cross join lateral aclexplode(relation.relacl) acl
       join pg_roles role on role.oid=acl.grantee
       where namespace.nspname = 'public'
         and role.rolname = any($1::text[])
       order by grantee, table_name, privilege_type`,
      [capabilityRoles],
    );
    const runtimeGrants = grants.rows.filter(({ grantee }) =>
      grantee !== "syntholo_migrator"
    );
    const implementationTables = new Set([
      "implementation_artifact_versions",
      "implementation_artifacts",
      "implementation_completion_artifact_snapshots",
      "implementation_completion_workflow_snapshots",
      "implementation_completions",
      "implementation_workflows",
    ]);
    expect(runtimeGrants.filter(({ table_name }) => implementationTables.has(table_name)))
      .toEqual([]);

    expect(runtimeGrants).toEqual([
      ...[
        "account_course_accesses",
        "account_holds",
        "accounts",
        "certificate_prerequisites",
        "course_completions",
        "entitlement_grants",
        "enrollment_version_transitions",
        "enrollments",
        "lesson_completions",
        "lesson_progress",
        "member_identities",
        "memberships",
        "seat_reservations",
      ].map((table_name) => ({
        grantee: "syntholo_member_api",
        privilege_type: "SELECT",
        table_name,
      })),
      ...[
        "access_decision_audit",
        "audit_events",
        "outbox_events",
      ].map((table_name) => ({
        grantee: "syntholo_member_api",
        privilege_type: "INSERT",
        table_name,
      })),
      ...[
        "accounts",
        "audit_events",
        "content_archives",
        "content_media_assets",
        "content_media_tracks",
        "content_previews",
        "content_readiness_approvals",
        "content_readiness_evaluations",
        "content_resource_drafts",
        "content_schedules",
        "course_draft_manifest_entries",
        "course_drafts",
        "course_heads",
        "course_version_lessons",
        "course_versions",
        "courses",
        "event_handler_receipts",
        "job_attempts",
        "jobs",
        "lesson_accessibility_decisions",
        "lesson_accessibility_review_heads",
        "lesson_disclosure_decisions",
        "lesson_disclosure_review_heads",
        "lesson_drafts",
        "lesson_version_resources",
        "lesson_versions",
        "lessons",
        "member_identities",
        "memberships",
        "outbox_events",
        "resource_delivery_health",
        "staff_identities",
        "staff_sessions",
        "stage_drafts",
        "stages",
      ].map((table_name) => ({
        grantee: "syntholo_staff_api",
        privilege_type: "SELECT",
        table_name,
      })),
      ...[
        "access_decision_audit",
        "audit_events",
        "content_resource_drafts",
        "course_drafts",
        "courses",
        "lesson_drafts",
        "lessons",
        "outbox_events",
        "stage_drafts",
        "stages",
      ].map((table_name) => ({
        grantee: "syntholo_staff_api",
        privilege_type: "INSERT",
        table_name,
      })),
      ...[
        "content_resource_drafts",
        "course_drafts",
        "lesson_drafts",
        "stage_drafts",
      ].map((table_name) => ({
        grantee: "syntholo_staff_api",
        privilege_type: "UPDATE",
        table_name,
      })),
      ...["audit_events", "outbox_events"].map((table_name) => ({
        grantee: "syntholo_system_api",
        privilege_type: "INSERT",
        table_name,
      })),
      ...[
        ["certificate_prerequisites", ["INSERT", "SELECT"]],
      ].flatMap(([table_name, privileges]) =>
        (privileges as string[]).map((privilege_type) => ({
          grantee: "syntholo_worker",
          privilege_type,
          table_name: table_name as string,
        }))
      ),
    ].sort((left, right) =>
      `${left.grantee}:${left.table_name}:${left.privilege_type}`.localeCompare(
        `${right.grantee}:${right.table_name}:${right.privilege_type}`,
      )
    ));
  });

  it("keeps audit immutable for the owner and every runtime capability", async () => {
    await seedFoundationRows(harness.database);
    for (const database of [harness.database, memberDb, staffDb, workerDb]) {
      await expect(database.pool.query("update audit_events set action='forbidden'"))
        .rejects.toMatchObject({ code: expect.stringMatching(/42501|55000/u) });
      await expect(database.pool.query("delete from audit_events"))
        .rejects.toMatchObject({ code: expect.stringMatching(/42501|55000/u) });
      await expect(database.pool.query("truncate audit_events"))
        .rejects.toMatchObject({ code: expect.stringMatching(/42501|55000/u) });
    }
    const triggers = await harness.database.pool.query(
      `select tgname, tgenabled from pg_trigger
       where tgrelid='audit_events'::regclass and not tgisinternal
       order by tgname`,
    );
    expect(triggers.rows).toEqual([
      { tgenabled: "O", tgname: "audit_events_account_id_immutable" },
      { tgenabled: "A", tgname: "audit_events_append_only_rows" },
      { tgenabled: "A", tgname: "audit_events_append_only_truncate" },
    ]);
  });

  it("locks every Task 7 transition function to worker/migrator with a fixed search path", async () => {
    const functions = await harness.database.pool.query<{
      executable_by_public: boolean;
      executable_by_member: boolean;
      executable_by_migrator: boolean;
      executable_by_staff: boolean;
      executable_by_worker: boolean;
      identity_arguments: string;
      name: string;
      proconfig: string[];
      prosecdef: boolean;
    }>(
      `select p.proname as name, p.prosecdef, p.proconfig,
              pg_get_function_identity_arguments(p.oid) as identity_arguments,
              has_function_privilege('public', p.oid, 'execute') as executable_by_public,
              has_function_privilege('syntholo_member_api', p.oid, 'execute') as executable_by_member,
              has_function_privilege('syntholo_staff_api', p.oid, 'execute') as executable_by_staff,
              has_function_privilege('syntholo_migrator', p.oid, 'execute') as executable_by_migrator,
              has_function_privilege('syntholo_worker', p.oid, 'execute') as executable_by_worker
       from pg_proc p
       where p.pronamespace='public'::regnamespace
         and p.proname like 'syntholo_%'
         and p.proname in (
           'syntholo_claim_jobs','syntholo_complete_job','syntholo_extend_job_lease','syntholo_fail_job',
           'syntholo_quarantine_job_payload','syntholo_claim_outbox',
           'syntholo_dispatch_outbox','syntholo_fail_outbox',
           'syntholo_acquire_handler_receipt','syntholo_complete_handler_receipt',
           'syntholo_abandon_handler_receipt','syntholo_enqueue_outbox_once'
         ) order by p.proname`,
    );
    expect(functions.rows).toHaveLength(12);
    expect(functions.rows.map(({ identity_arguments, name }) => ({ identity_arguments, name })))
      .toEqual([
        { name: "syntholo_abandon_handler_receipt", identity_arguments: "p_handler text, p_event uuid, p_job uuid, p_worker text, p_job_attempt integer, p_job_generation integer, p_job_token uuid, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone" },
        { name: "syntholo_acquire_handler_receipt", identity_arguments: "p_job uuid, p_worker text, p_job_attempt integer, p_job_generation integer, p_job_token uuid, p_now timestamp with time zone, p_lease_ms integer" },
        { name: "syntholo_claim_jobs", identity_arguments: "p_limit integer, p_worker text, p_now timestamp with time zone, p_lease_ms integer" },
        { name: "syntholo_claim_outbox", identity_arguments: "p_limit integer, p_worker text, p_now timestamp with time zone, p_lease_ms integer" },
        { name: "syntholo_complete_handler_receipt", identity_arguments: "p_handler text, p_event uuid, p_job uuid, p_worker text, p_job_attempt integer, p_job_generation integer, p_job_token uuid, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone" },
        { name: "syntholo_complete_job", identity_arguments: "p_job uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone" },
        { name: "syntholo_dispatch_outbox", identity_arguments: "p_event uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone, p_handlers text[]" },
        { name: "syntholo_enqueue_outbox_once", identity_arguments: "p_event uuid, p_account uuid, p_actor_type text, p_actor_id text, p_correlation uuid, p_type text, p_aggregate text, p_occurred timestamp with time zone, p_payload jsonb" },
        { name: "syntholo_extend_job_lease", identity_arguments: "p_job uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone, p_lease_ms integer" },
        { name: "syntholo_fail_job", identity_arguments: "p_job uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone, p_code text, p_message text, p_run_at timestamp with time zone" },
        { name: "syntholo_fail_outbox", identity_arguments: "p_event uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone, p_run_at timestamp with time zone" },
        { name: "syntholo_quarantine_job_payload", identity_arguments: "p_job uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid, p_now timestamp with time zone" },
      ]);
    expect(functions.rows.every((row) =>
      row.prosecdef && !row.executable_by_public
      && row.proconfig.includes("search_path=pg_catalog, public")
    )).toBe(true);
    const enqueue = functions.rows.find(({ name }) => name === "syntholo_enqueue_outbox_once");
    expect(enqueue).toMatchObject({
      executable_by_member: true,
      executable_by_migrator: false,
      executable_by_staff: true,
      executable_by_worker: false,
      identity_arguments: "p_event uuid, p_account uuid, p_actor_type text, p_actor_id text, p_correlation uuid, p_type text, p_aggregate text, p_occurred timestamp with time zone, p_payload jsonb",
    });
    expect(functions.rows.filter(({ name }) => name !== "syntholo_enqueue_outbox_once")
      .every((row) => row.executable_by_worker && row.executable_by_migrator
        && !row.executable_by_member && !row.executable_by_staff)).toBe(true);
    const identityTrigger = await harness.database.pool.query(
      `select pg_get_function_identity_arguments(p.oid) as identity_arguments,
              p.prosecdef, p.proconfig,
              has_function_privilege('public',p.oid,'execute') as public_execute,
              has_function_privilege('syntholo_member_api',p.oid,'execute') as member_execute,
              has_function_privilege('syntholo_staff_api',p.oid,'execute') as staff_execute,
              has_function_privilege('syntholo_worker',p.oid,'execute') as worker_execute
       from pg_proc p where p.oid='syntholo_sync_outbox_event_identity()'::regprocedure`,
    );
    expect(identityTrigger.rows).toEqual([{
      identity_arguments: "",
      member_execute: false,
      proconfig: ["search_path=pg_catalog, public"],
      prosecdef: false,
      public_execute: false,
      staff_execute: false,
      worker_execute: false,
    }]);
  });

  it("revokes PUBLIC paths and grants the intended migrator administration ACLs", async () => {
    const publicAcl = await harness.database.pool.query<{
      public_function_execute: boolean;
      public_schema_create: boolean;
      public_sequence_grants: string;
      public_table_grants: string;
    }>(
      `select
         exists (
           select 1
           from pg_namespace namespace
           cross join lateral aclexplode(
             coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
           ) acl
           where namespace.nspname = 'public'
             and acl.grantee = 0
             and acl.privilege_type = 'CREATE'
         ) as public_schema_create,
         (
           select count(*)::text
           from pg_class relation
           cross join lateral aclexplode(
             coalesce(relation.relacl, '{}'::aclitem[])
           ) acl
           where relation.relnamespace = 'public'::regnamespace
             and relation.relkind in ('r', 'p')
             and acl.grantee = 0
         ) as public_table_grants,
         (
           select count(*)::text
           from pg_class relation
           cross join lateral aclexplode(
             coalesce(relation.relacl, '{}'::aclitem[])
           ) acl
           where relation.relnamespace = 'public'::regnamespace
             and relation.relkind = 'S'
             and acl.grantee = 0
         ) as public_sequence_grants,
         exists (
           select 1
           from pg_proc procedure
           cross join lateral aclexplode(
             coalesce(procedure.proacl, acldefault('f', procedure.proowner))
           ) acl
           where procedure.oid = 'prevent_account_id_update()'::regprocedure
             and acl.grantee = 0
             and acl.privilege_type = 'EXECUTE'
         ) as public_function_execute`,
    );
    expect(publicAcl.rows[0]).toEqual({
      public_function_execute: false,
      public_schema_create: false,
      public_sequence_grants: "0",
      public_table_grants: "0",
    });

    const migratorAcl = await harness.database.pool.query<{
      function_execute: boolean;
      schema_create: boolean;
      schema_usage: boolean;
    }>(
      `select
         has_schema_privilege('syntholo_migrator', 'public', 'USAGE')
           as schema_usage,
         has_schema_privilege('syntholo_migrator', 'public', 'CREATE')
           as schema_create,
         has_function_privilege(
           'syntholo_migrator',
           'prevent_account_id_update()',
           'EXECUTE'
         ) as function_execute`,
    );
    expect(migratorAcl.rows[0]).toEqual({
      function_execute: true,
      schema_create: true,
      schema_usage: true,
    });

    const migratorTableGrants = await harness.database.pool.query<{
      privilege_type: string;
      table_name: string;
    }>(
      `select relation.relname table_name, acl.privilege_type
       from pg_class relation
       join pg_namespace namespace on namespace.oid=relation.relnamespace
       cross join lateral aclexplode(relation.relacl) acl
       join pg_roles role on role.oid=acl.grantee
       where namespace.nspname = 'public'
         and role.rolname = 'syntholo_migrator'
       order by table_name, privilege_type`,
    );
    const appendOnlyTables = new Set([
      "administrative_grant_restorations",
      "audit_events",
      "business_os_setup_receipts",
      "business_os_subscription_cancellations",
      "club_subscription_cancellations",
      "commerce_fulfillment_receipts",
      "commerce_reconciliations",
      "seat_invitations",
    ]);
    const serverVersion = await harness.database.pool.query<{ version: number }>(
      "select current_setting('server_version_num')::integer version",
    );
    const maintainPrivileges = (serverVersion.rows[0]?.version ?? 0) >= 170_000
      ? ["MAINTAIN"]
      : [];
    expect(migratorTableGrants.rows).toEqual(foundationTables.flatMap(
      (table_name) => {
        const privileges = table_name === "access_decision_audit"
          ? ["INSERT", "SELECT"]
          : appendOnlyTables.has(table_name)
            ? ["INSERT", ...maintainPrivileges, "REFERENCES", "SELECT", "TRIGGER"]
            : [
              "DELETE",
              "INSERT",
              ...maintainPrivileges,
              "REFERENCES",
              "SELECT",
              "TRIGGER",
              "TRUNCATE",
              "UPDATE",
            ];
        return privileges.map((privilege_type) => ({ privilege_type, table_name }));
      },
    ).sort((left, right) => {
      const leftKey = `${left.table_name}:${left.privilege_type}`;
      const rightKey = `${right.table_name}:${right.privilege_type}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }));
  });

  it("upgrades the exact populated 0001-0003 journal and applies all migrations fresh", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    const maintenance = new Pool({
      application_name: "syntholo-rls-migration-maintenance",
      connectionString: databaseUrl(baseUrl, "postgres"),
      max: 1,
    });
    const upgradeName = databaseName("upgrade");
    const freshName = databaseName("fresh");
    const incompatibleName = databaseName("incompatible");
    const temporaryMigrations = await mkdtemp(join(tmpdir(), "syntholo-0003-"));
    let upgradeDb: Database | undefined;
    let freshDb: Database | undefined;
    let concurrentFreshDb: Database | undefined;
    let incompatibleDb: Database | undefined;

    try {
      await dropDatabase(maintenance, upgradeName);
      await dropDatabase(maintenance, freshName);
      await dropDatabase(maintenance, incompatibleName);
      await maintenance.query(`create database ${quoteDatabaseName(upgradeName)}`);
      await maintenance.query(`create database ${quoteDatabaseName(freshName)}`);
      await maintenance.query(`create database ${quoteDatabaseName(incompatibleName)}`);

      await mkdir(join(temporaryMigrations, "meta"));
      for (const migration of [
        "0001_foundation.sql",
        "0002_roles_and_rls.sql",
        "0003_staff_authentication.sql",
      ]) {
        await writeFile(
          join(temporaryMigrations, migration),
          await readFile(new URL(`../drizzle/${migration}`, import.meta.url)),
        );
      }
      const fullJournal = JSON.parse(await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      )) as { entries: unknown[] };
      await writeFile(
        join(temporaryMigrations, "meta/_journal.json"),
        JSON.stringify({ ...fullJournal, entries: fullJournal.entries.slice(0, 3) }),
      );

      upgradeDb = createDatabase({
        applicationName: "syntholo-rls-upgrade-test",
        url: databaseUrl(baseUrl, upgradeName),
      });
      await migrate(upgradeDb, { migrationsFolder: temporaryMigrations });
      const beforeUpgrade = await upgradeDb.pool.query<{ hash: string }>(
        "select hash from drizzle.__drizzle_migrations order by id",
      );
      expect(beforeUpgrade.rows.map(({ hash }) => hash)).toEqual([
        "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c",
        "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4",
        "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da",
      ]);
      await upgradeDb.pool.query(`
        insert into audit_events
          (actor_type, action, target_type, payload)
        values ('system', 'legacy_created', 'foundation', '{}');
        insert into outbox_events
          (type, aggregate_id, payload, status, attempts, published_at)
        values
          ('legacy.published', 'legacy_1', '{}', 'published', 14, null),
          ('legacy.running', 'legacy_2', '{}', 'processing', 14, null),
          ('legacy.pending', 'legacy_3', '{}', 'pending', 14, now());
        insert into jobs
          (type, payload, status, attempts, max_attempts, completed_at)
        values
          ('legacy.completed', '{}', 'completed', 5, 5, null),
          ('legacy.running', '{}', 'running', 1, 5, null)
      `);
      await migrateDatabase(upgradeDb);
      const afterUpgrade = await upgradeDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(afterUpgrade.rows[0]?.count).toBe("14");
      await migrateDatabase(upgradeDb);
      const afterRerun = await upgradeDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(afterRerun.rows[0]?.count).toBe("14");
      const normalized = await upgradeDb.pool.query(
        `select
          (select bool_and(actor_id is not null and correlation_id is not null)
           from audit_events) as audit_provenance,
          (select bool_and(max_attempts >= attempts and status <> 'processing')
           from outbox_events) as outbox_state,
          (select bool_and(max_attempts >= attempts and status <> 'running')
           from jobs) as job_state`,
      );
      expect(normalized.rows).toEqual([{
        audit_provenance: true,
        job_state: true,
        outbox_state: true,
      }]);

      incompatibleDb = createDatabase({
        applicationName: "syntholo-rls-incompatible-upgrade-test",
        url: databaseUrl(baseUrl, incompatibleName),
      });
      await migrate(incompatibleDb, { migrationsFolder: temporaryMigrations });
      await incompatibleDb.pool.query(
        "insert into audit_events (actor_type, action, target_type, payload) values ('system','','foundation','{}')",
      );
      await expect(migrateDatabase(incompatibleDb)).rejects.toThrow(
        "SYNTHOLO_0004_LEGACY_DATA_PREFLIGHT_FAILED",
      );
      const rejected = await incompatibleDb.pool.query(
        `select
           (select count(*)::int from drizzle.__drizzle_migrations) as journal_count,
           (select action from audit_events limit 1) as action,
           exists (select 1 from information_schema.columns
             where table_name='outbox_events' and column_name='event_id') as mutated`,
      );
      expect(rejected.rows).toEqual([{
        action: "",
        journal_count: 3,
        mutated: false,
      }]);

      freshDb = createDatabase({
        applicationName: "syntholo-rls-fresh-test",
        url: databaseUrl(baseUrl, freshName),
      });
      concurrentFreshDb = createDatabase({
        applicationName: "syntholo-rls-concurrent-fresh-test",
        url: databaseUrl(baseUrl, freshName),
      });
      await Promise.all([
        migrateDatabase(freshDb),
        migrateDatabase(concurrentFreshDb),
      ]);
      const freshJournal = await freshDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(freshJournal.rows[0]?.count).toBe("14");
    } finally {
      await Promise.allSettled([
        upgradeDb?.close(),
        freshDb?.close(),
        concurrentFreshDb?.close(),
        incompatibleDb?.close(),
      ]);
      try {
        await dropDatabase(maintenance, upgradeName);
      } finally {
        try {
          await dropDatabase(maintenance, freshName);
        } finally {
          try {
            await dropDatabase(maintenance, incompatibleName);
          } finally {
            await maintenance.end();
            await rm(temporaryMigrations, { force: true, recursive: true });
          }
        }
      }
    }
  }, 90_000);
});
