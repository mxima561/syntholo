import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { isCanonicalAccountName } from "@syntholo/contracts/member-dashboard";
import { createDatabase } from "../client.js";
import { migrateDatabase } from "../migrations.js";
import {
  createTestDatabaseHarness,
  createTestMigrationEnvironment,
  type TestDatabaseHarness,
} from "../../../testing/src/database.js";

const execFileAsync = promisify(execFile);
const databasePackageRoot = fileURLToPath(new URL("../..", import.meta.url));

async function runDatabaseNpm(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stderr: string; stdout: string }> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) {
    throw new Error("NPM_EXEC_PATH_REQUIRED");
  }
  return execFileAsync(process.execPath, [npmExecPath, ...args], {
    cwd: databasePackageRoot,
    env: environment,
  });
}

function disposableDatabaseName(kind: "target" | "trap"): string {
  return `syntholo_migration_${kind}_${process.pid}`;
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function databaseUrlWithParameters(
  baseUrl: string,
  parameters: Readonly<Record<string, string>>,
): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function quotedDatabaseName(databaseName: string): string {
  if (!/^[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error("INVALID_TEST_DATABASE_NAME");
  }
  return `"${databaseName}"`;
}

async function dropTestDatabase(
  maintenancePool: Pool,
  databaseName: string,
): Promise<void> {
  await maintenancePool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [databaseName],
  );
  await maintenancePool.query(
    `drop database if exists ${quotedDatabaseName(databaseName)}`,
  );
}

describe("foundation migration", () => {
  let harness: TestDatabaseHarness;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("migrates a fresh test database once despite conflicting production variables", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }

    const maintenanceUrl = databaseUrl(baseUrl, "postgres");
    const targetName = disposableDatabaseName("target");
    const trapName = disposableDatabaseName("trap");
    const targetUrl = databaseUrl(baseUrl, targetName);
    const trapUrl = databaseUrl(baseUrl, trapName);
    const maintenancePool = new Pool({
      application_name: "syntholo-migration-test-maintenance",
      connectionString: maintenanceUrl,
      max: 1,
    });
    let targetPool: Pool | undefined;
    let trapPool: Pool | undefined;

    try {
      await dropTestDatabase(maintenancePool, targetName);
      await dropTestDatabase(maintenancePool, trapName);
      await maintenancePool.query(
        `create database ${quotedDatabaseName(targetName)}`,
      );
      await maintenancePool.query(
        `create database ${quotedDatabaseName(trapName)}`,
      );

      const childEnvironment = createTestMigrationEnvironment({
        ...process.env,
        DATABASE_MIGRATION_TARGET: "production",
        DATABASE_URL: trapUrl,
        DATABASE_DIRECT_URL: trapUrl,
        DATABASE_POOLED_URL: trapUrl,
        TEST_DATABASE_URL: targetUrl,
      });
      const first = await runDatabaseNpm(
        ["run", "db:migrate"],
        childEnvironment,
      );

      targetPool = new Pool({ connectionString: targetUrl, max: 1 });
      trapPool = new Pool({ connectionString: trapUrl, max: 1 });
      const migratedTables = await targetPool.query<{ count: string }>(
        `select count(*)::text as count
         from information_schema.tables
         where table_schema = 'public'
           and table_type = 'BASE TABLE'`,
      );
      const firstJournal = await targetPool.query<{
        hash: string;
        created_at: string;
      }>(
        "select hash, created_at::text from drizzle.__drizzle_migrations order by id",
      );
      const trapState = await trapPool.query<{
        accounts: string | null;
        journal: string | null;
      }>(
        `select
          to_regclass('public.accounts')::text as accounts,
          to_regclass('drizzle.__drizzle_migrations')::text as journal`,
      );

      expect(first.stderr).toBe("");
      expect(migratedTables.rows[0]?.count).toBe("51");
      expect(firstJournal.rows).toEqual([
        { created_at: "1786618800000", hash: "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c" },
        { created_at: "1786626000000", hash: "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4" },
        { created_at: "1786633200000", hash: "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da" },
        { created_at: "1786640400000", hash: "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1" },
        { created_at: "1786647600000", hash: "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5" },
        { created_at: "1786654800000", hash: "6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5" },
        { created_at: "1786662000000", hash: "cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002" },
        { created_at: "1786669200000", hash: "505693d0977b3cf51b156ac792605be7bf6e4a5c89c5ead8d4c728d1c298f513" },
        { created_at: "1786676400000", hash: "2cf79d036accf426172ab2249e690e34c17a8f145c8e2afa72bb8e3994425922" },
      ]);
      expect(trapState.rows[0]).toEqual({ accounts: null, journal: null });

      const rerun = await runDatabaseNpm(
        ["run", "db:migrate"],
        childEnvironment,
      );
      const rerunJournal = await targetPool.query<{
        hash: string;
        created_at: string;
      }>(
        "select hash, created_at::text from drizzle.__drizzle_migrations order by id",
      );

      expect(rerun.stderr).toBe("");
      expect(rerunJournal.rows).toEqual(firstJournal.rows);
    } finally {
      await Promise.allSettled([targetPool?.end(), trapPool?.end()]);
      try {
        await dropTestDatabase(maintenancePool, targetName);
      } finally {
        try {
          await dropTestDatabase(maintenancePool, trapName);
        } finally {
          await maintenancePool.end();
        }
      }
    }
  }, 20_000);

  it("canonicalizes legacy names during a populated upgrade and rolls back an irreparable 0008 preflight", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const maintenancePool = new Pool({
      application_name: "syntholo-account-name-upgrade-maintenance",
      connectionString: databaseUrl(baseUrl, "postgres"),
      max: 1,
    });
    const compatibleName = `syntholo_account_name_compatible_${process.pid}`;
    const incompatibleName = `syntholo_account_name_incompatible_${process.pid}`;
    const temporaryMigrations = await mkdtemp(join(tmpdir(), "syntholo-0007-"));
    let compatible: ReturnType<typeof createDatabase> | undefined;
    let incompatible: ReturnType<typeof createDatabase> | undefined;
    try {
      await dropTestDatabase(maintenancePool, compatibleName);
      await dropTestDatabase(maintenancePool, incompatibleName);
      await maintenancePool.query(`create database ${quotedDatabaseName(compatibleName)}`);
      await maintenancePool.query(`create database ${quotedDatabaseName(incompatibleName)}`);
      await mkdir(join(temporaryMigrations, "meta"));
      for (const migration of [
        "0001_foundation.sql",
        "0002_roles_and_rls.sql",
        "0003_staff_authentication.sql",
        "0004_audit_and_jobs.sql",
        "0005_entitlements.sql",
        "0006_runtime_readiness.sql",
        "0007_runtime_contract.sql",
      ]) {
        await writeFile(
          join(temporaryMigrations, migration),
          await readFile(new URL(`../../drizzle/${migration}`, import.meta.url)),
        );
      }
      const fullJournal = JSON.parse(await readFile(
        new URL("../../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      )) as { entries: unknown[] };
      await writeFile(
        join(temporaryMigrations, "meta/_journal.json"),
        JSON.stringify({ ...fullJournal, entries: fullJournal.entries.slice(0, 7) }),
      );

      compatible = createDatabase({
        applicationName: "syntholo-account-name-compatible",
        url: databaseUrl(baseUrl, compatibleName),
      });
      incompatible = createDatabase({
        applicationName: "syntholo-account-name-incompatible",
        url: databaseUrl(baseUrl, incompatibleName),
      });
      await migrate(compatible, { migrationsFolder: temporaryMigrations });
      await migrate(incompatible, { migrationsFolder: temporaryMigrations });
      await compatible.pool.query(
        "insert into accounts(id,name) values($1,$2),($3,$4),($5,$6)",
        [
          "30000000-0000-4000-8000-000000000001",
          "Café",
          "30000000-0000-4000-8000-000000000002",
          "a".repeat(255),
          "30000000-0000-4000-8000-000000000004",
          "  Cafe\u0301  ",
        ],
      );
      await incompatible.pool.query(
        "insert into accounts(id,name) values($1,$2)",
        ["30000000-0000-4000-8000-000000000003", "Cafe\u00a0"],
      );

      await migrateDatabase(compatible);
      await migrateDatabase(compatible);
      const upgraded = await compatible.pool.query(
        `select
          (select count(*)::int from drizzle.__drizzle_migrations) journal_count,
          (select convalidated from pg_constraint
             where conrelid='accounts'::regclass
               and conname='accounts_name_canonical_check') constraint_validated,
          public.syntholo_account_name_is_canonical('Café') canonical,
          public.syntholo_account_name_is_canonical($1) boundary,
          has_function_privilege('syntholo_member_api',
            'public.syntholo_account_name_is_canonical(text)','EXECUTE') member_execute,
          has_function_privilege('syntholo_staff_api',
            'public.syntholo_account_name_is_canonical(text)','EXECUTE') staff_execute,
          exists(select 1 from pg_proc p,
            aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            where p.oid='public.syntholo_account_name_is_canonical(text)'::regprocedure
              and acl.grantee=0 and acl.privilege_type='EXECUTE') public_execute,
          (select name from accounts where id=$2) upgraded_legacy_name`,
        ["a".repeat(255), "30000000-0000-4000-8000-000000000004"],
      );
      expect(upgraded.rows).toEqual([{
        boundary: true,
        canonical: true,
        constraint_validated: true,
        journal_count: 9,
        member_execute: true,
        public_execute: false,
        staff_execute: false,
        upgraded_legacy_name: "Café",
      }]);
      await compatible.pool.query(
        "insert into accounts(id,name) values($1,$2)",
        ["30000000-0000-4000-8000-000000000005", "  Rollback Cafe\u0301  "],
      );
      await expect(compatible.pool.query(
        "select name from accounts where id=$1",
        ["30000000-0000-4000-8000-000000000005"],
      )).resolves.toMatchObject({ rows: [{ name: "Rollback Café" }] });
      const accountNameCorpus = [
        "",
        " ",
        " Acme",
        "Acme ",
        "Acme  Advisory",
        "Café",
        "Cafe\u0301",
        "a".repeat(255),
        "a".repeat(256),
        "é".repeat(127) + "a",
        "é".repeat(128),
        ...[
          1, 31, 127, 159, 160, 173, 1564, 5760, 6158, 8192, 8207,
          8232, 8239, 8287, 8303, 12288, 64976, 65007, 65279, 65534,
          65535, 0x1fffe, 0x1ffff,
        ].map((codePoint) => `A${String.fromCodePoint(codePoint)}`),
        ...[33, 126, 161, 174, 1565, 5759, 6157, 6159, 8208, 8240, 8304,
          64975, 65008, 65278, 0x10000, 0x1fffd]
          .map((codePoint) => `A${String.fromCodePoint(codePoint)}`),
      ];
      const sqlCorpus = await compatible.pool.query<{
        canonical: boolean;
        ordinal: number;
      }>(
        `select ordinal::int, public.syntholo_account_name_is_canonical(value) canonical
         from unnest($1::text[]) with ordinality as corpus(value,ordinal)
         order by ordinal`,
        [accountNameCorpus],
      );
      expect(sqlCorpus.rows.map((row) => row.canonical)).toEqual(
        accountNameCorpus.map(isCanonicalAccountName),
      );

      await expect(migrateDatabase(incompatible)).rejects.toThrow(
        "SYNTHOLO_0008_ACCOUNT_NAME_PREFLIGHT_FAILED",
      );
      const rolledBack = await incompatible.pool.query(
        `select
          (select count(*)::int from drizzle.__drizzle_migrations) journal_count,
          (select name from accounts where id=$1) legacy_name,
          to_regprocedure('public.syntholo_account_name_is_canonical(text)') is not null function_exists,
          exists(select 1 from pg_constraint
            where conrelid='accounts'::regclass
              and conname='accounts_name_canonical_check') constraint_exists`,
        ["30000000-0000-4000-8000-000000000003"],
      );
      expect(rolledBack.rows).toEqual([{
        constraint_exists: false,
        function_exists: false,
        journal_count: 7,
        legacy_name: "Cafe\u00a0",
      }]);
    } finally {
      await Promise.allSettled([compatible?.close(), incompatible?.close()]);
      try {
        await dropTestDatabase(maintenancePool, compatibleName);
      } finally {
        try {
          await dropTestDatabase(maintenancePool, incompatibleName);
        } finally {
          await Promise.allSettled([maintenancePool.end(), rm(temporaryMigrations, {
            force: true,
            recursive: true,
          })]);
        }
      }
    }
  }, 30_000);

  it("creates all foundation and authentication tables", async () => {
    const result = await harness.database.pool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name`,
      [[
        "accounts",
        "audit_events",
        "event_handler_receipts",
        "job_attempts",
        "jobs",
        "member_identities",
        "memberships",
        "outbox_events",
        "provider_event_receipts",
        "staff_identities",
        "staff_login_attempts",
        "staff_sessions",
      ]],
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "accounts",
      "audit_events",
      "event_handler_receipts",
      "job_attempts",
      "jobs",
      "member_identities",
      "memberships",
      "outbox_events",
      "provider_event_receipts",
      "staff_identities",
      "staff_login_attempts",
      "staff_sessions",
    ]);
  });

  it("keeps the 0007 foundation projection stable and exposes additive 0008 readiness", async () => {
    const result = await harness.database.pool.query<{
      capability: string;
      migration_count: number;
      migration_hashes: string[];
      required_objects: string[];
      runtime_role: string;
      schema_version: string;
    }>(
      "select schema_version, migration_count, migration_hashes, required_objects, runtime_role, capability from public.syntholo_runtime_readiness()",
    );

    expect(result.rows).toEqual([{
      capability: "syntholo_migrator",
      migration_count: 7,
      migration_hashes: [
        "bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c",
        "6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4",
        "5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da",
        "717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1",
        "b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5",
        "6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5",
        "cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002",
      ],
      required_objects: [
        "public.access_decision_audit",
        "public.account_hold_sources",
        "public.account_holds",
        "public.accounts",
        "public.administrative_grant_restorations",
        "public.audit_events",
        "public.business_os_setup_receipts",
        "public.business_os_subscription_cancellations",
        "public.club_subscription_cancellations",
        "public.commerce_fulfillment_receipts",
        "public.commerce_reconciliations",
        "public.entitlement_commands",
        "public.entitlement_grants",
        "public.entitlement_sources",
        "public.event_handler_receipts",
        "public.job_attempts",
        "public.jobs",
        "public.member_identities",
        "public.memberships",
        "public.outbox_events",
        "public.provider_event_receipts",
        "public.seat_invitation_token_generations",
        "public.seat_invitations",
        "public.seat_reservations",
        "public.staff_identities",
        "public.staff_login_attempts",
        "public.staff_sessions",
      ],
      runtime_role: expect.any(String),
      schema_version: "0007_runtime_contract",
    }]);

    const accountName = await harness.database.pool.query(
      "select contract_version, migration_created_at::text, migration_hash, predicate_ready, constraint_ready, writer_compatibility_ready, acl_ready from public.syntholo_account_name_readiness_v1()",
    );
    expect(accountName.rows).toEqual([{
      acl_ready: true,
      constraint_ready: true,
      contract_version: "0008_account_name.v1",
      migration_created_at: "1786669200000",
      migration_hash: "505693d0977b3cf51b156ac792605be7bf6e4a5c89c5ead8d4c728d1c298f513",
      predicate_ready: true,
      writer_compatibility_ready: true,
    }]);
  });

  it("keeps the exact Task 7 constraint, recovery-index, and trigger inventory", async () => {
    const exactConstraints = await harness.database.pool.query(
      `select count(*)::int as count,
              md5(string_agg(conrelid::regclass::text||':'||conname||':'||
                pg_get_constraintdef(oid,true), E'\\n'
                order by conrelid::regclass::text,conname)) as hash
       from pg_constraint where conrelid in (
         'audit_events'::regclass,'outbox_events'::regclass,'jobs'::regclass,
         'job_attempts'::regclass,'event_handler_receipts'::regclass)`,
    );
    expect(exactConstraints.rows).toEqual([{
      count: 72,
      hash: "6788699933d75570f5b162b6ff72f438",
    }]);
    const constraints = await harness.database.pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid in ('audit_events'::regclass,'outbox_events'::regclass,
         'jobs'::regclass,'job_attempts'::regclass,'event_handler_receipts'::regclass)
         and conname = any($1::text[]) order by conname`,
      [[
        "audit_events_payload_size_check",
        "event_handler_receipts_state_check",
        "event_handler_receipts_updated_check",
        "job_attempts_finish_check",
        "job_attempts_time_check",
        "jobs_max_attempts_upper_check",
        "jobs_state_fields_check",
        "outbox_events_attempt_bounds_check",
        "outbox_events_identity_check",
        "outbox_events_state_fields_check",
      ]],
    );
    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "audit_events_payload_size_check",
      "event_handler_receipts_state_check",
      "event_handler_receipts_updated_check",
      "job_attempts_finish_check",
      "job_attempts_time_check",
      "jobs_max_attempts_upper_check",
      "jobs_state_fields_check",
      "outbox_events_attempt_bounds_check",
      "outbox_events_identity_check",
      "outbox_events_state_fields_check",
    ]);
    const exactIndexes = await harness.database.pool.query(
      `select count(*)::int as count,
              md5(string_agg(tablename||':'||indexname||':'||indexdef, E'\\n'
                order by tablename,indexname)) as hash
       from pg_indexes where schemaname='public' and tablename in (
         'audit_events','outbox_events','jobs','job_attempts','event_handler_receipts')`,
    );
    expect(exactIndexes.rows).toEqual([{
      count: 16,
      hash: "7fed100399d35d25ae2d78da5f8e7e18",
    }]);
    const indexes = await harness.database.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public'
       and indexname = any($1::text[]) order by indexname`,
      [[
        "event_handler_receipts_recovery_idx",
        "job_attempts_account_started_idx",
        "jobs_claim_idx",
        "jobs_recovery_idx",
        "outbox_events_claim_idx",
        "outbox_events_recovery_idx",
      ]],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "event_handler_receipts_recovery_idx",
      "job_attempts_account_started_idx",
      "jobs_claim_idx",
      "jobs_recovery_idx",
      "outbox_events_claim_idx",
      "outbox_events_recovery_idx",
    ]);
    const triggers = await harness.database.pool.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal
       and tgrelid in ('audit_events'::regclass,'outbox_events'::regclass,
         'jobs'::regclass,'job_attempts'::regclass,'event_handler_receipts'::regclass)
       order by tgname`,
    );
    expect(triggers.rows.map(({ tgname }) => tgname)).toEqual([
      "audit_events_account_id_immutable",
      "audit_events_append_only_rows",
      "audit_events_append_only_truncate",
      "event_handler_receipts_account_id_immutable",
      "event_handler_receipts_parent_account",
      "job_attempts_account_id_immutable",
      "job_attempts_parent_account",
      "jobs_account_id_immutable",
      "outbox_events_account_id_immutable",
      "outbox_events_identity_compatibility",
    ]);
  });

  it("sets the configured PostgreSQL application name", async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    const database = createDatabase({
      url: databaseUrlWithParameters(url, {
        channel_binding: "prefer",
      }),
      applicationName: "syntholo-foundation-integration",
    });

    try {
      const result = await database.pool.query<{ application_name: string }>(
        "select current_setting('application_name') as application_name",
      );
      expect(result.rows[0]?.application_name).toBe(
        "syntholo-foundation-integration",
      );
    } finally {
      await database.close();
    }
  });

  it("rejects a conflicting URL application name before connecting", () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }

    expect(() => createDatabase({
      url: databaseUrlWithParameters(url, {
        application_name: "url-override",
      }),
      applicationName: "syntholo-foundation-integration",
    })).toThrow("DATABASE_URL_INVALID");
  });

  it("enforces provider identity and event uniqueness", async () => {
    const accountId = await harness.factories.account(harness.database);
    await harness.factories.memberIdentity(harness.database, {
      accountId,
      provider: "clerk",
      providerUserId: "user_1",
    });

    await expect(
      harness.factories.memberIdentity(harness.database, {
        accountId,
        provider: "clerk",
        providerUserId: "user_1",
      }),
    ).rejects.toMatchObject({ code: "23505" });

    await harness.factories.providerReceipt(harness.database, {
      provider: "stripe",
      eventId: "evt_1",
    });
    await expect(
      harness.factories.providerReceipt(harness.database, {
        provider: "stripe",
        eventId: "evt_1",
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects changing the account of a customer identity", async () => {
    const firstAccountId = await harness.factories.account(harness.database, {
      name: "First account",
    });
    const secondAccountId = await harness.factories.account(harness.database, {
      name: "Second account",
    });
    const identityId = await harness.factories.memberIdentity(harness.database, {
      accountId: firstAccountId,
      provider: "clerk",
      providerUserId: "immutable_user",
    });

    await expect(
      harness.database.pool.query(
        "update member_identities set account_id = $1 where id = $2",
        [secondAccountId, identityId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("stores empty and populated staff permissions as PostgreSQL string arrays", async () => {
    const empty = await harness.database.pool.query<{ permissions: string[] }>(
      `insert into staff_identities
        (provider, provider_user_id, role)
       values ($1, $2, $3)
       returning permissions`,
      ["workos", "staff_empty_permissions", "admin"],
    );
    const populated = await harness.database.pool.query<{ permissions: string[] }>(
      `insert into staff_identities
        (provider, provider_user_id, role, permissions)
       values ($1, $2, $3, $4::text[])
       returning permissions`,
      [
        "workos",
        "staff_string_permissions",
        "admin",
        ["content:publish", "support:assign"],
      ],
    );

    expect(empty.rows[0]?.permissions).toEqual([]);
    expect(populated.rows[0]?.permissions).toEqual([
      "content:publish",
      "support:assign",
    ]);
  });

  it("rejects a PostgreSQL text array containing a null permission", async () => {
    await expect(
      harness.database.pool.query(
        `insert into staff_identities
          (provider, provider_user_id, role, permissions)
         values ($1, $2, $3, $4::text[])`,
        [
          "workos",
          "staff_invalid_permissions",
          "admin",
          ["content:publish", null],
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
