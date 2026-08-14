import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDatabaseCapability, createDatabase } from "./client.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";

describe("authentication migration and ACLs", () => {
  let harness: TestDatabaseHarness;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
  });
  beforeEach(async () => harness.reset());
  afterAll(async () => harness?.close());

  it("creates bounded secret-bearing tables and the third journal entry", async () => {
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
    expect(journal.rows[0]?.count).toBe("7");
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
    const client = await harness.database.pool.connect();
    try {
      await client.query("set role syntholo_staff_api");
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
      await client.query("reset role");
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
    const client = await harness.database.pool.connect();
    try {
      await client.query("set role syntholo_staff_api");
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
      await client.query("reset role");
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

    const client = await harness.database.pool.connect();
    try {
      await client.query("set role syntholo_staff_api");
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
      await client.query("reset role");
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

  it("independently attests the expected capability role as inert", async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const role = `syntholo_task6_cap_${process.pid}`;
    const direct = `syntholo_task6_cap_direct_${process.pid}`;
    const transitive = `syntholo_task6_cap_transitive_${process.pid}`;
    const password = `task6-cap-${process.pid}-password`;
    if (![role, direct, transitive].every((name) => /^[a-z0-9_]+$/u.test(name))) {
      throw new Error("TEST_ROLE_INVALID");
    }
    await harness.database.pool.query(
      `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
    await harness.database.pool.query(`create role "${direct}" nologin`);
    await harness.database.pool.query(`create role "${transitive}" nologin`);
    await harness.database.pool.query(
      `grant syntholo_staff_api to "${role}" with inherit true, set false, admin false`,
    );
    const url = new URL(base);
    url.username = role;
    url.password = password;
    const database = createDatabase({
      url: url.toString(),
      applicationName: "syntholo-capability-attestation-test",
    });
    const expectInvalid = async () => {
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).rejects.toThrow("DATABASE_CAPABILITY_INVALID");
    };
    const mutate = async (unsafe: string, restore: string) => {
      await harness.database.pool.query(unsafe);
      try {
        await expectInvalid();
      } finally {
        await harness.database.pool.query(restore);
      }
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).resolves.toBeUndefined();
    };

    try {
      await expect(
        assertDatabaseCapability(database, "syntholo_staff_api"),
      ).resolves.toBeUndefined();
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
      const currentDatabase = await harness.database.pool.query<{ name: string }>(
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
      await harness.database.pool.query(
        `grant "${transitive}" to "${direct}" with inherit true, set false, admin false`,
      );
      try {
        await mutate(
          `grant "${direct}" to syntholo_staff_api with inherit true, set false, admin false`,
          `revoke "${direct}" from syntholo_staff_api`,
        );
      } finally {
        await harness.database.pool.query(`revoke "${transitive}" from "${direct}"`);
      }
    } finally {
      await database.close();
      await harness.database.pool.query(
        "alter role syntholo_staff_api nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      );
      await harness.database.pool.query(
        "alter role syntholo_staff_api reset statement_timeout",
      );
      const currentDatabase = await harness.database.pool.query<{ name: string }>(
        "select current_database() as name",
      );
      const databaseName = currentDatabase.rows[0]?.name;
      if (databaseName && /^[a-zA-Z0-9_]+$/u.test(databaseName)) {
        await harness.database.pool.query(
          `alter role syntholo_staff_api in database "${databaseName}" reset statement_timeout`,
        );
      }
      await harness.database.pool.query(
        `revoke "${direct}" from syntholo_staff_api`,
      );
      await harness.database.pool.query(
        `revoke "${transitive}" from "${direct}"`,
      );
      await harness.database.pool.query(`revoke syntholo_staff_api from "${role}"`);
      await harness.database.pool.query(`drop role "${role}"`);
      await harness.database.pool.query(`drop role "${direct}"`);
      await harness.database.pool.query(`drop role "${transitive}"`);
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
