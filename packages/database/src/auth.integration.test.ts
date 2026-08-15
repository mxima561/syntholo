import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDatabaseCapability, createDatabase, type Database } from "./client.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function roleSql(
  database: Database,
  template: string,
  values: readonly string[],
): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ statement: string }>(
    `select format($fmt$${template}$fmt$,${parameters}) statement`,
    [...values],
  );
  const statement = result.rows[0]?.statement;
  if (statement === undefined) throw new Error("TEST_ROLE_SQL_FORMAT_FAILED");
  return statement;
}

describe("authentication migration and ACLs", () => {
  let harness: TestDatabaseHarness;
  let staff: Database;
  const staffRole = `syntholo_auth_staff_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const password = randomUUID();
    await harness.database.pool.query(await roleSql(
      harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      [staffRole, password],
    ));
    await harness.database.pool.query(await roleSql(
      harness.database,
      "grant syntholo_staff_api to %I with inherit true,set false,admin false",
      [staffRole],
    ));
    staff = createDatabase({
      applicationName: "syntholo-auth-staff-login-test",
      url: loginUrl(baseUrl, staffRole, password),
    });
    await assertDatabaseCapability(staff, "syntholo_staff_api");
  });
  beforeEach(async () => harness.reset());
  afterAll(async () => {
    await staff?.close();
    if (harness !== undefined) {
      await harness.database.pool.query(await roleSql(
        harness.database,
        "revoke syntholo_staff_api from %I",
        [staffRole],
      ));
      await harness.database.pool.query(await roleSql(
        harness.database,
        "drop role if exists %I",
        [staffRole],
      ));
      await harness.close();
    }
  });

  it("creates bounded secret-bearing tables within the complete published journal", async () => {
    const tables = await harness.database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('staff_sessions', 'staff_login_attempts')
       order by table_name`,
    );
    const journal = await harness.database.pool.query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "staff_login_attempts",
      "staff_sessions",
    ]);
    expect(journal.rows[0]?.count).toBe("13");
  });

  it("rejects malformed cryptographic field lengths", async () => {
    const staffIdentityId = "00000000-0000-4000-8000-000000000077";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_malformed', 'admin')`,
      [staffIdentityId],
    );
    await expect(
      harness.database.pool.query(
        `insert into staff_sessions
          (session_hash, staff_identity_id, workos_user_id, workos_session_id,
           organization_id, provider_roles, token_ciphertext, token_iv,
           token_tag, key_version, access_token_expires_at, hard_expires_at,
           authenticated_at)
         values ($1, $2, 'user', 'session', 'org', array['admin'], $3, $4,
                 $5, 1, now() + interval '5 minutes', now() + interval '1 hour', now())`,
        [randomBytes(31), staffIdentityId, randomBytes(4), randomBytes(12), randomBytes(16)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("grants only the staff capability and never grants delete", async () => {
    const grants = await harness.database.pool.query<{
      grantee: string;
      privilege_type: string;
      table_name: string;
    }>(
      `select grantee, privilege_type, table_name
       from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name in ('staff_sessions', 'staff_login_attempts')
       order by grantee, table_name, privilege_type`,
    );
    const runtime = grants.rows.filter((row) =>
      ["syntholo_member_api", "syntholo_staff_api", "syntholo_worker", "PUBLIC"].includes(row.grantee),
    );
    expect(new Set(runtime.map((row) => row.grantee))).toEqual(
      new Set(["syntholo_staff_api"]),
    );
    expect(runtime.every((row) => row.privilege_type !== "DELETE")).toBe(true);
    expect(runtime).toEqual([
      {
        grantee: "syntholo_staff_api",
        privilege_type: "SELECT",
        table_name: "staff_sessions",
      },
    ]);
  });

  it("denies direct staff secret mutation while narrow revocation works", async () => {
    const staffIdentityId = "00000000-0000-4000-8000-000000000078";
    const sessionHash = randomBytes(32);
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_acl', 'admin')`,
      [staffIdentityId],
    );
    await harness.database.pool.query(
      `insert into staff_sessions
        (session_hash, staff_identity_id, workos_user_id, workos_session_id,
         organization_id, provider_roles, token_ciphertext, token_iv,
         token_tag, key_version, access_token_expires_at, hard_expires_at,
         authenticated_at)
       values ($1,$2,'workos_acl','session_acl','org_acl',array['admin'],$3,$4,$5,
               1,now()+interval '5 minutes',now()+interval '1 hour',now())`,
      [sessionHash, staffIdentityId, randomBytes(64), randomBytes(12), randomBytes(16)],
    );
    const client = await staff.pool.connect();
    try {
      await expect(
        client.query(
          "update staff_sessions set revoked_at=null, hard_expires_at=now()+interval '1 year' where session_hash=$1",
          [sessionHash],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const revoked = await client.query<{ workos_session_id: string }>(
        "select * from staff_revoke_session($1)",
        [sessionHash],
      );
      expect(revoked.rows).toEqual([{ workos_session_id: "session_acl" }]);
    } finally {
      client.release();
    }
    const row = await harness.database.pool.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from staff_sessions where session_hash=$1",
      [sessionHash],
    );
    expect(row.rows[0]?.revoked).toBe(true);
  });

  it("bounds direct session rotation and permits one fenced new-provider-session reauth", async () => {
    const staffIdentityId = "00000000-0000-4000-8000-000000000079";
    const oldHash = randomBytes(32);
    const newHash = randomBytes(32);
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_rotate', 'admin')`,
      [staffIdentityId],
    );
    await harness.database.pool.query(
      `insert into staff_sessions
        (session_hash, staff_identity_id, workos_user_id, workos_session_id,
         organization_id, provider_roles, token_ciphertext, token_iv,
         token_tag, key_version, access_token_expires_at, hard_expires_at,
         authenticated_at)
       values ($1,$2,'workos_rotate','session_old','org_rotate',array['admin'],$3,$4,$5,
               1,now()+interval '5 minutes',now()+interval '1 hour',now())`,
      [oldHash, staffIdentityId, randomBytes(64), randomBytes(12), randomBytes(16)],
    );
    const rotate = async (prior: Buffer, hash: Buffer, hardExpiry: string, sid = "session_new") => {
      const result = await harness.database.pool.query<{ staff_rotate_session: boolean }>(
        `select staff_rotate_session(
          $1,$2,$3,'workos_rotate',$4,'org_rotate',array['admin'],array[]::text[],
          $5,$6,$7,1,now()+interval '5 minutes',${hardExpiry},now())`,
        [prior, hash, staffIdentityId, sid, randomBytes(64), randomBytes(12), randomBytes(16)],
      );
      return result.rows[0]?.staff_rotate_session;
    };
    const client = await staff.pool.connect();
    try {
      const sameHash = await client.query<{ staff_rotate_session: boolean }>(
        `select staff_rotate_session(
          $1,$1,$2,'workos_rotate','session_old','org_rotate',array['admin'],array[]::text[],
          $3,$4,$5,1,now()+interval '5 minutes',now()+interval '8 hours',now())`,
        [oldHash, staffIdentityId, randomBytes(64), randomBytes(12), randomBytes(16)],
      );
      expect(sameHash.rows[0]?.staff_rotate_session).toBe(false);
      const excessive = await client.query<{ staff_rotate_session: boolean }>(
        `select staff_rotate_session(
          $1,$2,$3,'workos_rotate','session_new','org_rotate',array['admin'],array[]::text[],
          $4,$5,$6,1,now()+interval '5 minutes',now()+interval '1 year',now())`,
        [oldHash, newHash, staffIdentityId, randomBytes(64), randomBytes(12), randomBytes(16)],
      );
      expect(excessive.rows[0]?.staff_rotate_session).toBe(false);
    } finally {
      client.release();
    }
    expect(await rotate(oldHash, newHash, "now()+interval '8 hours'")).toBe(true);
    const row = await harness.database.pool.query<{
      current_hash: boolean;
      previous_hash: boolean;
      workos_session_id: string;
    }>(
      `select session_hash=$1 as current_hash, previous_session_hash=$2 as previous_hash,
              workos_session_id
       from staff_sessions where staff_identity_id=$3`,
      [newHash, oldHash, staffIdentityId],
    );
    expect(row.rows[0]).toEqual({
      current_hash: true,
      previous_hash: true,
      workos_session_id: "session_new",
    });
  });

  it("fences refresh completion by lease, version, expiry, and revocation", async () => {
    const staffIdentityId = "00000000-0000-4000-8000-000000000081";
    const firstHash = randomBytes(32);
    const secondHash = randomBytes(32);
    const slowHash = randomBytes(32);
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_refresh', 'admin')`,
      [staffIdentityId],
    );
    const insert = (hash: Buffer, sid: string) =>
      harness.database.pool.query(
        `insert into staff_sessions
          (session_hash,staff_identity_id,workos_user_id,workos_session_id,
           organization_id,provider_roles,token_ciphertext,token_iv,token_tag,
           key_version,access_token_expires_at,hard_expires_at,authenticated_at)
         values ($1,$2,'workos_refresh',$3,'org_refresh',array['admin'],$4,$5,$6,
                 1,now()+interval '5 minutes',now()+interval '1 hour',now())`,
        [hash, staffIdentityId, sid, randomBytes(64), randomBytes(12), randomBytes(16)],
      );
    await insert(firstHash, "refresh_first");
    await insert(secondHash, "refresh_second");
    await insert(slowHash, "refresh_slow");

    const client = await staff.pool.connect();
    try {
      expect((await client.query(
        "select session_hash from staff_acquire_refresh($1,0,'lease-a',10)",
        [firstHash],
      )).rowCount).toBe(1);
      expect((await client.query(
        "select session_hash from staff_acquire_refresh($1,0,'lease-b',10)",
        [firstHash],
      )).rowCount).toBe(0);
      await client.query("select * from staff_revoke_session($1)", [firstHash]);
      expect((await client.query(
        `select session_hash from staff_complete_refresh(
          $1,'lease-a',0,$2,$3,$4,1,now()+interval '5 minutes',
          (select authenticated_at from staff_sessions where session_hash=$1),
          array['admin'],array[]::text[])`,
        [firstHash, randomBytes(64), randomBytes(12), randomBytes(16)],
      )).rowCount).toBe(0);

      expect((await client.query(
        "select session_hash from staff_acquire_refresh($1,0,'lease-current',10)",
        [secondHash],
      )).rowCount).toBe(1);
      expect((await client.query(
        `select session_hash from staff_complete_refresh(
          $1,'lease-stale',0,$2,$3,$4,1,now()+interval '5 minutes',
          (select authenticated_at from staff_sessions where session_hash=$1),
          array['admin'],array[]::text[])`,
        [secondHash, randomBytes(64), randomBytes(12), randomBytes(16)],
      )).rowCount).toBe(0);
      expect((await client.query(
        `select refresh_version from staff_complete_refresh(
          $1,'lease-current',0,$2,$3,$4,1,now()+interval '5 minutes',
          (select authenticated_at from staff_sessions where session_hash=$1),
          array['admin'],array[]::text[])`,
        [secondHash, randomBytes(64), randomBytes(12), randomBytes(16)],
      )).rows[0]?.refresh_version).toBe(1);
      expect((await client.query(
        `select session_hash from staff_complete_refresh(
          $1,'lease-current',0,$2,$3,$4,1,now()+interval '5 minutes',
          (select authenticated_at from staff_sessions where session_hash=$1),
          array['admin'],array[]::text[])`,
        [secondHash, randomBytes(64), randomBytes(12), randomBytes(16)],
      )).rowCount).toBe(0);

      expect((await client.query(
        "select session_hash from staff_acquire_refresh($1,0,'lease-short',1)",
        [slowHash],
      )).rowCount).toBe(1);
      await client.query("select pg_sleep(1.1)");
      expect((await client.query(
        `select session_hash from staff_complete_refresh(
          $1,'lease-short',0,$2,$3,$4,1,now()+interval '5 minutes',
          (select authenticated_at from staff_sessions where session_hash=$1),
          array['admin'],array[]::text[])`,
        [slowHash, randomBytes(64), randomBytes(12), randomBytes(16)],
      )).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it("attests one exact safe inherited capability and rejects privileged or ambiguous logins", async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const role = `syntholo_task6_staff_${process.pid}`;
    const intermediate = `syntholo_task6_mid_${process.pid}`;
    const extra = `syntholo_task6_extra_${process.pid}`;
    const password = `task6-${process.pid}-password`;
    if (![role, intermediate, extra].every((name) => /^[a-z0-9_]+$/u.test(name))) {
      throw new Error("TEST_ROLE_INVALID");
    }
    await harness.database.pool.query(
      `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
    await harness.database.pool.query(`create role "${intermediate}" nologin`);
    await harness.database.pool.query(`create role "${extra}" nologin`);
    await harness.database.pool.query(
      `grant syntholo_staff_api to "${role}" with inherit true, set false, admin false`,
    );
    const url = new URL(base);
    url.username = role;
    url.password = password;
    const database = createDatabase({
      url: url.toString(),
      applicationName: "syntholo-auth-attestation-test",
    });
    try {
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).resolves.toBeUndefined();
      await expect(database.pool.query(
        "select capability from public.syntholo_runtime_readiness()",
      )).resolves.toMatchObject({ rows: [{ capability: "syntholo_staff_api" }] });
      await expect(
        assertDatabaseCapability(database, "syntholo_member_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");

      await harness.database.pool.query(`alter role "${role}" bypassrls`);
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await harness.database.pool.query(`alter role "${role}" nobypassrls`);

      await harness.database.pool.query(
        `grant "${extra}" to "${role}" with inherit true, set false, admin false`,
      );
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await expect(database.pool.query(
        "select capability from public.syntholo_runtime_readiness()",
      )).resolves.toMatchObject({ rows: [] });
      await harness.database.pool.query(`revoke "${extra}" from "${role}"`);

      await harness.database.pool.query(`revoke syntholo_staff_api from "${role}"`);
      await harness.database.pool.query(
        `grant syntholo_staff_api to "${intermediate}" with inherit true, set false, admin false`,
      );
      await harness.database.pool.query(
        `grant "${intermediate}" to "${role}" with inherit true, set false, admin false`,
      );
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await harness.database.pool.query(`revoke "${intermediate}" from "${role}"`);
      await harness.database.pool.query(`revoke syntholo_staff_api from "${intermediate}"`);

      await harness.database.pool.query(
        `grant syntholo_staff_api to "${role}" with inherit true, set true, admin false`,
      );
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await harness.database.pool.query(`revoke syntholo_staff_api from "${role}"`);

      await harness.database.pool.query(
        `grant syntholo_staff_api to "${role}" with inherit true, set false, admin true`,
      );
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await harness.database.pool.query(`revoke syntholo_staff_api from "${role}"`);

      await harness.database.pool.query(
        `grant syntholo_staff_api to "${role}" with inherit true, set false, admin false`,
      );
      await harness.database.pool.query(`alter role "${role}" set statement_timeout = '5s'`);
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await harness.database.pool.query(`alter role "${role}" reset statement_timeout`);
    } finally {
      await database.close();
      await harness.database.pool.query(`revoke syntholo_staff_api from "${role}"`);
      await harness.database.pool.query(`drop role "${role}"`);
      await harness.database.pool.query(`drop role "${intermediate}"`);
      await harness.database.pool.query(`drop role "${extra}"`);
    }
  });

  it("independently proves the expected capability role is inert", async () => {
    const state = await harness.database.pool.query<{
      database_settings: number;
      outbound_memberships: number;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolconfig: string[] | null;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      `select capability.rolcanlogin,capability.rolsuper,capability.rolcreatedb,
              capability.rolcreaterole,capability.rolreplication,
              capability.rolbypassrls,capability.rolconfig,
              (select count(*)::int from pg_db_role_setting setting
               where setting.setrole=capability.oid) database_settings,
              (select count(*)::int from pg_auth_members membership
               where membership.member=capability.oid) outbound_memberships
       from pg_roles capability where capability.rolname='syntholo_staff_api'`,
    );
    expect(state.rows).toEqual([{
      database_settings: 0,
      outbound_memberships: 0,
      rolbypassrls: false,
      rolcanlogin: false,
      rolconfig: null,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolsuper: false,
    }]);
    await expect(assertDatabaseCapability(staff, "syntholo_staff_api"))
      .resolves.toBeUndefined();
  });

  it.skipIf(process.env.TEST_DATABASE_SUPERUSER_URL === undefined)(
    "rejects every hostile capability-role shape through a privileged fixture",
    async () => {
    const privilegedUrl = process.env.TEST_DATABASE_SUPERUSER_URL;
    if (privilegedUrl === undefined) throw new Error("TEST_DATABASE_SUPERUSER_URL_REQUIRED");
    const direct = `syntholo_task6_cap_direct_${process.pid}`;
    const transitive = `syntholo_task6_cap_transitive_${process.pid}`;
    if (![direct, transitive].every((name) => /^[a-z0-9_]+$/u.test(name))) {
      throw new Error("TEST_ROLE_INVALID");
    }
    const authority = createDatabase({
      url: privilegedUrl,
      applicationName: "syntholo-capability-mutation-authority-test",
    });
    let ownerRole: string | undefined;
    const expectInvalid = async () => {
      await expect(
        assertDatabaseCapability(staff, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
    };
    const mutate = async (unsafe: string, restore: string) => {
      await authority.pool.query(unsafe);
      try {
        await expectInvalid();
      } finally {
        await authority.pool.query(restore);
      }
      await expect(
        assertDatabaseCapability(staff, "syntholo_staff_api"),
      ).resolves.toBeUndefined();
    };
    const rejectUnsafeLogin = async (unsafe: string, restore: string) => {
      await authority.pool.query(unsafe);
      try {
        await expect(
          assertDatabaseCapability(staff, "syntholo_staff_api"),
        ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
        await expect(staff.pool.query(
          "select capability from public.syntholo_runtime_readiness()",
        )).resolves.toMatchObject({ rows: [] });
      } finally {
        await authority.pool.query(restore);
      }
      await expect(assertDatabaseCapability(staff, "syntholo_staff_api"))
        .resolves.toBeUndefined();
    };

    try {
      await authority.pool.query(`create role "${direct}" nologin`);
      await authority.pool.query(`create role "${transitive}" nologin`);
      await rejectUnsafeLogin(
        await roleSql(authority, "alter role %I superuser", [staffRole]),
        await roleSql(authority, "alter role %I nosuperuser", [staffRole]),
      );
      const readinessOwner = await authority.pool.query<{ rolname: string }>(
        `select owner.rolname from pg_proc procedure
         join pg_roles owner on owner.oid=procedure.proowner
         where procedure.oid='public.syntholo_runtime_readiness()'::regprocedure`,
      );
      ownerRole = readinessOwner.rows[0]?.rolname;
      if (ownerRole === undefined) throw new Error("READINESS_OWNER_MISSING");
      await rejectUnsafeLogin(
        await roleSql(authority,
          "grant %I to %I with inherit true,set false,admin false",
          [ownerRole, staffRole]),
        await roleSql(authority, "revoke %I from %I", [ownerRole, staffRole]),
      );
      await mutate(
        "alter role syntholo_staff_api login",
        "alter role syntholo_staff_api nologin",
      );
      await mutate(
        "alter role syntholo_staff_api superuser",
        "alter role syntholo_staff_api nosuperuser",
      );
      await mutate(
        "alter role syntholo_staff_api createdb",
        "alter role syntholo_staff_api nocreatedb",
      );
      await mutate(
        "alter role syntholo_staff_api createrole",
        "alter role syntholo_staff_api nocreaterole",
      );
      await mutate(
        "alter role syntholo_staff_api replication",
        "alter role syntholo_staff_api noreplication",
      );
      await mutate(
        "alter role syntholo_staff_api bypassrls",
        "alter role syntholo_staff_api nobypassrls",
      );
      await mutate(
        "alter role syntholo_staff_api set statement_timeout = '5s'",
        "alter role syntholo_staff_api reset statement_timeout",
      );
      const currentDatabase = await authority.pool.query<{ name: string }>(
        "select current_database() as name",
      );
      const databaseName = currentDatabase.rows[0]?.name;
      if (!databaseName || !/^[a-zA-Z0-9_]+$/u.test(databaseName)) {
        throw new Error("TEST_DATABASE_NAME_INVALID");
      }
      await mutate(
        `alter role syntholo_staff_api in database "${databaseName}" set statement_timeout = '5s'`,
        `alter role syntholo_staff_api in database "${databaseName}" reset statement_timeout`,
      );
      await mutate(
        `grant "${direct}" to syntholo_staff_api with inherit true, set false, admin false`,
        `revoke "${direct}" from syntholo_staff_api`,
      );
      await authority.pool.query(
        `grant "${transitive}" to "${direct}" with inherit true, set false, admin false`,
      );
      try {
        await mutate(
          `grant "${direct}" to syntholo_staff_api with inherit true, set false, admin false`,
          `revoke "${direct}" from syntholo_staff_api`,
        );
      } finally {
        await authority.pool.query(`revoke "${transitive}" from "${direct}"`);
      }
    } finally {
      await authority.pool.query(await roleSql(
        authority,
        "alter role %I nosuperuser",
        [staffRole],
      )).catch(() => undefined);
      if (ownerRole !== undefined) {
        await authority.pool.query(await roleSql(
          authority,
          "revoke %I from %I",
          [ownerRole, staffRole],
        )).catch(() => undefined);
      }
      await authority.pool.query(
        "alter role syntholo_staff_api nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      ).catch(() => undefined);
      await authority.pool.query(
        "alter role syntholo_staff_api reset statement_timeout",
      ).catch(() => undefined);
      const currentDatabase = await authority.pool.query<{ name: string }>(
        "select current_database() as name",
      );
      const databaseName = currentDatabase.rows[0]?.name;
      if (databaseName && /^[a-zA-Z0-9_]+$/u.test(databaseName)) {
        await authority.pool.query(
          `alter role syntholo_staff_api in database "${databaseName}" reset statement_timeout`,
        ).catch(() => undefined);
      }
      await authority.pool.query(
        `revoke "${direct}" from syntholo_staff_api`,
      ).catch(() => undefined);
      await authority.pool.query(
        `revoke "${transitive}" from "${direct}"`,
      ).catch(() => undefined);
      await authority.pool.query(`drop role if exists "${direct}"`).catch(() => undefined);
      await authority.pool.query(`drop role if exists "${transitive}"`).catch(() => undefined);
      await authority.close();
    }
  });

  it("exposes only one exact active Clerk actor through the bootstrap function", async () => {
    const accountId = await harness.factories.account(harness.database);
    const identityId = await harness.factories.memberIdentity(harness.database, {
      accountId,
      providerUserId: "clerk_bootstrap",
    });
    const membershipId = "00000000-0000-4000-8000-000000000099";
    await harness.database.pool.query(
      `insert into memberships (id, account_id, member_identity_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [membershipId, accountId, identityId],
    );
    const found = await harness.database.pool.query(
      "select * from member_actor_for_clerk_user($1)",
      ["clerk_bootstrap"],
    );
    const missing = await harness.database.pool.query(
      "select * from member_actor_for_clerk_user($1)",
      ["clerk_missing"],
    );
    expect(found.rows).toEqual([
      {
        actor_id: identityId,
        account_id: accountId,
        membership_id: membershipId,
        role: "owner",
      },
    ]);
    expect(missing.rows).toEqual([]);
  });

  it("keeps cleanup bounded to expired/consumed attempts and expired/revoked sessions", async () => {
    const executable = await harness.database.pool.query<{ worker: boolean; member: boolean; public: boolean }>(
      `select
        has_function_privilege('syntholo_worker', 'cleanup_staff_auth(timestamptz, integer)', 'EXECUTE') as worker,
        has_function_privilege('syntholo_member_api', 'cleanup_staff_auth(timestamptz, integer)', 'EXECUTE') as member,
        has_function_privilege('public', 'cleanup_staff_auth(timestamptz, integer)', 'EXECUTE') as public`,
    );
    expect(executable.rows[0]).toEqual({ worker: true, member: false, public: false });
    await expect(
      harness.database.pool.query("select * from cleanup_staff_auth(now() + interval '1 year', 1001)"),
    ).rejects.toMatchObject({ code: "22023" });

    const staffIdentityId = "00000000-0000-4000-8000-000000000080";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_cleanup', 'coach')`,
      [staffIdentityId],
    );
    const insertAttempt = async (state: Buffer, expires: string, consumed: string) =>
      harness.database.pool.query(
        `insert into staff_login_attempts
          (state_hash,browser_nonce_hash,verifier_ciphertext,verifier_iv,verifier_tag,
           key_version,return_to,created_at,expires_at,consumed_at)
         values ($1,$2,$3,$4,$5,1,'/coach',now()-interval '3 hours',${expires},${consumed})`,
        [state, randomBytes(32), randomBytes(32), randomBytes(12), randomBytes(16)],
      );
    const expiredAttempt = randomBytes(32);
    const activeAttempt = randomBytes(32);
    await insertAttempt(expiredAttempt, "now()-interval '2 hours'", "null");
    await insertAttempt(activeAttempt, "now()+interval '2 hours'", "null");

    const insertSession = async (hash: Buffer, sid: string, hardExpiry: string, revoked: string) =>
      harness.database.pool.query(
        `insert into staff_sessions
          (session_hash,staff_identity_id,workos_user_id,workos_session_id,organization_id,
           provider_roles,token_ciphertext,token_iv,token_tag,key_version,
           access_token_expires_at,hard_expires_at,authenticated_at,created_at,revoked_at)
         values ($1,$2,'workos_cleanup',$3,'org_cleanup',array['coach'],$4,$5,$6,1,
                 now()+interval '5 minutes',${hardExpiry},now()-interval '3 hours',
                 now()-interval '4 hours',${revoked})`,
        [hash, staffIdentityId, sid, randomBytes(64), randomBytes(12), randomBytes(16)],
      );
    const expiredSession = randomBytes(32);
    const activeSession = randomBytes(32);
    const recentRevokedSession = randomBytes(32);
    await insertSession(expiredSession, "cleanup_expired", "now()-interval '2 hours'", "null");
    await insertSession(activeSession, "cleanup_active", "now()+interval '2 hours'", "null");
    await insertSession(
      recentRevokedSession,
      "cleanup_recent_revoked",
      "now()+interval '2 hours'",
      "now()-interval '30 minutes'",
    );
    await harness.database.pool.query(
      "select * from cleanup_staff_auth(now()-interval '1 hour', 100)",
    );
    const remainingAttempts = await harness.database.pool.query<{ state_hash: Buffer }>(
      "select state_hash from staff_login_attempts",
    );
    const remainingSessions = await harness.database.pool.query<{ session_hash: Buffer }>(
      "select session_hash from staff_sessions",
    );
    expect(remainingAttempts.rows.map((row) => row.state_hash.toString("hex"))).toEqual([
      activeAttempt.toString("hex"),
    ]);
    expect(new Set(remainingSessions.rows.map((row) => row.session_hash.toString("hex")))).toEqual(
      new Set([activeSession.toString("hex"), recentRevokedSession.toString("hex")]),
    );
  });
});
