import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDatabase, type Database } from "./client.js";
import { migrateDatabase } from "./migrations.js";
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
import { withAccountScope } from "./unit-of-work.js";
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
  "syntholo_worker",
] as const;

const customerTables = [
  "accounts",
  "audit_events",
  "jobs",
  "member_identities",
  "memberships",
  "outbox_events",
] as const;

function runtimeDatabaseUrl(baseUrl: string, role: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

function createSingleConnectionRoleDatabase(
  baseUrl: string,
  role: string,
): Database {
  const pool = new Pool({
    application_name: `syntholo-${role}-integration`,
    connectionString: runtimeDatabaseUrl(baseUrl, role),
    max: 1,
  });
  return Object.assign(drizzle(pool, {
    schema: {
      accounts,
      auditEvents,
      jobs,
      memberIdentities,
      memberships,
      outboxEvents,
      providerEventReceipts,
      staffIdentities,
    },
  }), {
    close: () => pool.end(),
    pool,
  });
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
      (account_id, actor_type, action, target_type)
     values ($1, 'member', 'created', 'account'),
            ($2, 'member', 'created', 'account')`,
    [accountA, accountB],
  );
  await database.pool.query(
    `insert into outbox_events
      (account_id, type, aggregate_id, payload)
     values ($1, 'account.created', $3, '{}'),
            ($2, 'account.created', $4, '{}')`,
    [accountA, accountB, accountA, accountB],
  );
  await database.pool.query(
    `insert into jobs
      (account_id, type, payload)
     values ($1, 'sync.account', '{}'), ($2, 'sync.account', '{}')`,
    [accountA, accountB],
  );
  await database.pool.query(
    `insert into provider_event_receipts
      (provider, provider_event_id)
     values ('stripe', 'evt_rls_seed')`,
  );
}

async function currentScope(database: Database): Promise<string | null> {
  const result = await database.pool.query<{ account_id: string | null }>(
    "select nullif(current_setting('app.account_id', true), '') as account_id",
  );
  return result.rows[0]?.account_id ?? null;
}

function databaseName(kind: "fresh" | "upgrade"): string {
  return `syntholo_rls_${kind}_${process.pid}`;
}

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  url.search = "";
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

describe("PostgreSQL account role boundary", () => {
  let harness: TestDatabaseHarness;
  let memberDb: Database;
  let staffDb: Database;
  let workerDb: Database;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    memberDb = createSingleConnectionRoleDatabase(
      baseUrl,
      "syntholo_member_api",
    );
    staffDb = createSingleConnectionRoleDatabase(
      baseUrl,
      "syntholo_staff_api",
    );
    workerDb = createSingleConnectionRoleDatabase(
      baseUrl,
      "syntholo_worker",
    );
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await Promise.allSettled([
      memberDb?.close(),
      staffDb?.close(),
      workerDb?.close(),
      harness?.close(),
    ]);
  });

  it("creates exactly the four no-login, non-superuser, non-bypass capability roles", async () => {
    const result = await harness.database.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolname: string;
      rolsuper: boolean;
    }>(
      `select rolname, rolcanlogin, rolsuper, rolbypassrls
       from pg_roles
       where rolname like 'syntholo\\_%' escape '\\'
       order by rolname`,
    );

    expect(result.rows).toEqual(capabilityRoles.map((rolname) => ({
      rolbypassrls: false,
      rolcanlogin: false,
      rolname,
      rolsuper: false,
    })));
  });

  it("enables and forces RLS with member and staff policies on all customer tables", async () => {
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
        policyname: `${tablename}_member_scope`,
        roles: ["syntholo_member_api"],
        tablename,
      },
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
    const workerPolicies = ([
      ["audit_events", "INSERT"],
      ["audit_events", "SELECT"],
      ["jobs", "INSERT"],
      ["jobs", "SELECT"],
      ["jobs", "UPDATE"],
      ["outbox_events", "INSERT"],
      ["outbox_events", "SELECT"],
      ["outbox_events", "UPDATE"],
    ] as const).map(([tablename, cmd]) => ({
      cmd,
      policyname: `${tablename}_worker_${cmd === "SELECT" ? "read" : cmd.toLowerCase()}`,
      roles: ["syntholo_worker"],
      tablename,
    }));

    expect(policies.rows).toEqual([...universalPolicies, ...workerPolicies].sort(
      (left, right) =>
        `${left.tablename}:${left.policyname}`.localeCompare(
          `${right.tablename}:${right.policyname}`,
        ),
    ));
  });

  it("runs member queries as the non-bypass capability rather than the owner", async () => {
    const identity = await memberDb.pool.query<{
      current_user: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
      session_user: string;
    }>(
      `select current_user, session_user, rolsuper, rolbypassrls
       from pg_roles
       where rolname = current_user`,
    );

    expect(identity.rows[0]).toMatchObject({
      current_user: "syntholo_member_api",
      rolbypassrls: false,
      rolsuper: false,
    });
    expect(identity.rows[0]?.session_user).not.toBe("syntholo_member_api");
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
  });

  it("rejects a non-canonical scope before opening a database connection", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) {
      throw new Error("TEST_DATABASE_URL_REQUIRED");
    }
    const unopened = createDatabase({
      applicationName: "syntholo-invalid-scope-integration",
      url: runtimeDatabaseUrl(baseUrl, "syntholo_member_api"),
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
      aggregateId: accountA,
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
    const outboxRows = await staffDb.select({ id: outboxEvents.id })
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

    const insertedAudit = await workerDb.insert(auditEvents).values({
      accountId: accountA,
      action: "processed",
      actorType: "system",
      targetType: "job",
    }).returning({ id: auditEvents.id });
    expect(insertedAudit).toHaveLength(1);
    await expect(workerDb.update(auditEvents).set({ action: "forbidden" }))
      .rejects.toMatchObject({ cause: { code: "42501" } });

    const insertedOutbox = await workerDb.insert(outboxEvents).values({
      accountId: accountA,
      aggregateId: accountA,
      payload: {},
      type: "worker.test",
    }).returning({ id: outboxEvents.id });
    expect(insertedOutbox).toHaveLength(1);
    const updatedOutbox = await workerDb.update(outboxEvents)
      .set({ status: "processing" })
      .where(eq(outboxEvents.id, insertedOutbox[0]!.id))
      .returning({ id: outboxEvents.id });
    expect(updatedOutbox).toHaveLength(1);

    const insertedJob = await workerDb.insert(jobs).values({
      accountId: accountA,
      payload: {},
      type: "worker.test",
    }).returning({ id: jobs.id });
    expect(insertedJob).toHaveLength(1);
    const updatedJob = await workerDb.update(jobs)
      .set({ status: "running", workerId: "worker-test" })
      .where(eq(jobs.id, insertedJob[0]!.id))
      .returning({ id: jobs.id });
    expect(updatedJob).toHaveLength(1);

    const insertedReceipt = await workerDb.insert(providerEventReceipts).values({
      provider: "stripe",
      providerEventId: "evt_worker_insert",
    }).returning({ id: providerEventReceipts.id });
    expect(insertedReceipt).toHaveLength(1);
    await expect(workerDb.delete(providerEventReceipts)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  });

  it("grants only the explicit current runtime table privilege matrix", async () => {
    const grants = await harness.database.pool.query<{
      grantee: string;
      privilege_type: string;
      table_name: string;
    }>(
      `select grantee, table_name, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee = any($1::text[])
       order by grantee, table_name, privilege_type`,
      [capabilityRoles],
    );
    const runtimeGrants = grants.rows.filter(({ grantee }) =>
      grantee !== "syntholo_migrator"
    );

    expect(runtimeGrants).toEqual([
      ...["accounts", "member_identities", "memberships"].flatMap(
        (table_name) => ["INSERT", "SELECT", "UPDATE"].map(
          (privilege_type) => ({
            grantee: "syntholo_member_api",
            privilege_type,
            table_name,
          }),
        ),
      ),
      ...[
        "accounts",
        "audit_events",
        "jobs",
        "member_identities",
        "memberships",
        "outbox_events",
        "staff_identities",
      ].map((table_name) => ({
        grantee: "syntholo_staff_api",
        privilege_type: "SELECT",
        table_name,
      })),
      ...[
        ["audit_events", ["INSERT", "SELECT"]],
        ["jobs", ["INSERT", "SELECT", "UPDATE"]],
        ["outbox_events", ["INSERT", "SELECT", "UPDATE"]],
        ["provider_event_receipts", ["INSERT", "SELECT", "UPDATE"]],
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

  it("upgrades a journaled 0001 database and applies all migrations fresh", async () => {
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
    const temporaryMigrations = await mkdtemp(join(tmpdir(), "syntholo-0001-"));
    let upgradeDb: Database | undefined;
    let freshDb: Database | undefined;

    try {
      await dropDatabase(maintenance, upgradeName);
      await dropDatabase(maintenance, freshName);
      await maintenance.query(`create database ${quoteDatabaseName(upgradeName)}`);
      await maintenance.query(`create database ${quoteDatabaseName(freshName)}`);

      await mkdir(join(temporaryMigrations, "meta"));
      await writeFile(
        join(temporaryMigrations, "0001_foundation.sql"),
        await readFile(new URL("../drizzle/0001_foundation.sql", import.meta.url)),
      );
      const fullJournal = JSON.parse(await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      )) as { entries: unknown[] };
      await writeFile(
        join(temporaryMigrations, "meta/_journal.json"),
        JSON.stringify({ ...fullJournal, entries: fullJournal.entries.slice(0, 1) }),
      );

      upgradeDb = createDatabase({
        applicationName: "syntholo-rls-upgrade-test",
        url: databaseUrl(baseUrl, upgradeName),
      });
      await migrate(upgradeDb, { migrationsFolder: temporaryMigrations });
      const beforeUpgrade = await upgradeDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(beforeUpgrade.rows[0]?.count).toBe("1");
      await migrateDatabase(upgradeDb);
      const afterUpgrade = await upgradeDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(afterUpgrade.rows[0]?.count).toBe("2");
      await migrateDatabase(upgradeDb);
      const afterRerun = await upgradeDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(afterRerun.rows[0]?.count).toBe("2");

      freshDb = createDatabase({
        applicationName: "syntholo-rls-fresh-test",
        url: databaseUrl(baseUrl, freshName),
      });
      await migrateDatabase(freshDb);
      const freshJournal = await freshDb.pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      expect(freshJournal.rows[0]?.count).toBe("2");
    } finally {
      await Promise.allSettled([upgradeDb?.close(), freshDb?.close()]);
      try {
        await dropDatabase(maintenance, upgradeName);
      } finally {
        try {
          await dropDatabase(maintenance, freshName);
        } finally {
          await maintenance.end();
          await rm(temporaryMigrations, { force: true, recursive: true });
        }
      }
    }
  }, 30_000);
});
