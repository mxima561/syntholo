import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase } from "../client.js";
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
           and table_name = any($1::text[])`,
        [[
          "accounts",
          "audit_events",
          "jobs",
          "member_identities",
          "memberships",
          "outbox_events",
          "provider_event_receipts",
          "staff_identities",
        ]],
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
      expect(migratedTables.rows[0]?.count).toBe("8");
      expect(firstJournal.rows).toHaveLength(2);
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

  it("creates all eight foundation tables", async () => {
    const result = await harness.database.pool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name`,
      [[
        "accounts",
        "audit_events",
        "jobs",
        "member_identities",
        "memberships",
        "outbox_events",
        "provider_event_receipts",
        "staff_identities",
      ]],
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "accounts",
      "audit_events",
      "jobs",
      "member_identities",
      "memberships",
      "outbox_events",
      "provider_event_receipts",
      "staff_identities",
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
