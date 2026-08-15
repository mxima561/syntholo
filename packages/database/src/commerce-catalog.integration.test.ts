import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import { createDatabase, type Database } from "./client.js";
import { checkDatabaseReadiness } from "./readiness.js";

const migrationNames = [
  "0001_foundation.sql",
  "0002_roles_and_rls.sql",
  "0003_staff_authentication.sql",
  "0004_audit_and_jobs.sql",
  "0005_entitlements.sql",
  "0006_runtime_readiness.sql",
  "0007_runtime_contract.sql",
  "0008_account_name.sql",
  "0009_content.sql",
  "0010_content_assets.sql",
  "0011_learning.sql",
  "0012_implementation.sql",
  "0013_certificates.sql",
  "0014_commerce_catalog.sql",
] as const;

const commerceMigrationWhen = 1_787_029_200_000;
const commerceMigrationHash = "4bc124a641e6912d84fc6675133476f92e52e8fa89151079d05433d31deba8d4";
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());
const describeDatabase = hasTestDatabase ? describe.sequential : describe.skip;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function writeMigrationFolder(directory: string, count: number): Promise<void> {
  await mkdir(join(directory, "meta"), { recursive: true });
  for (const name of migrationNames.slice(0, count)) {
    await copyFile(new URL(`../drizzle/${name}`, import.meta.url), join(directory, name));
  }
  const sourceJournal = JSON.parse(
    await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as {
    dialect: string;
    entries: Array<Record<string, unknown>>;
    version: string;
  };
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify({ ...sourceJournal, entries: sourceJournal.entries.slice(0, count) }),
  );
}

async function withDisposableDatabase(
  label: string,
  run: (database: Database) => Promise<void>,
): Promise<void> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const databaseName = `syntholo_commerce_${label}_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Pool({ connectionString: databaseUrl(baseUrl, "postgres"), max: 1 });
  let database: Database | undefined;
  try {
    await maintenance.query(`create database "${databaseName}"`);
    database = createDatabase({
      url: databaseUrl(baseUrl, databaseName),
      applicationName: `syntholo-commerce-${label}`,
    });
    await run(database);
  } finally {
    await database?.close();
    await maintenance.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await maintenance.end();
  }
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
  if (statement === undefined) throw new Error("COMMERCE_TEST_ROLE_SQL_FAILED");
  return statement;
}

async function contextualQuery<T extends QueryResultRow>(
  database: Database,
  actorId: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.actor_kind','system',true),
        set_config('app.actor_id',$1,true),
        set_config('app.correlation_id',$2,true),
        set_config('app.account_id','',true)`,
      [actorId, randomUUID()],
    );
    const result = await client.query<T>(text, [...values]);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function contextualMemberQuery<T extends QueryResultRow>(
  database: Database,
  actor: Readonly<{ accountId: string; identityId: string; membershipId: string }>,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.actor_kind','member',true),
        set_config('app.actor_id',$1,true),set_config('app.account_id',$2,true),
        set_config('app.membership_id',$3,true),
        set_config('app.correlation_id',$4,true),
        set_config('app.actor_role','owner',true),
        set_config('app.authenticated_at',$5,true)`,
      [
        actor.identityId,
        actor.accountId,
        actor.membershipId,
        randomUUID(),
        "2026-08-15T13:00:00.000Z",
      ],
    );
    const result = await client.query<T>(text, [...values]);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedReadyAcademyCourse(database: Database): Promise<Readonly<{
  courseId: string;
  courseVersionId: string;
  gateHash: string;
}>> {
  const staffId = randomUUID();
  const courseId = randomUUID();
  const stageId = randomUUID();
  const previewId = randomUUID();
  const courseVersionId = randomUUID();
  const evaluationId = randomUUID();
  const gateHash = sha256(`commerce-content-gate:${courseId}`);
  const manifestHash = sha256("{}");
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local row_security=off");
    await client.query(
      "insert into staff_identities(id,provider_user_id,role) values($1,$2,'admin')",
      [staffId, `commerce-content-${randomUUID()}`],
    );
    await client.query(
      "insert into courses(id,slug,title,description) values($1,$2,'Commerce Academy','Commerce paid-flow evidence')",
      [courseId, `commerce-academy-${randomUUID()}`],
    );
    await client.query(
      "insert into stages(id,course_id,slug) values($1,$2,'academy')",
      [stageId, courseId],
    );
    await client.query(
      `insert into content_previews(
        id,course_id,draft_revision,manifest_canonical_json,manifest_hash,
        manifest_projection,publication_issues,created_by_staff_id,reason
      ) values($1,$2,1,'{}',$3,'{}'::jsonb,'[]'::jsonb,$4,'Commerce evidence')`,
      [previewId, courseId, manifestHash, staffId],
    );
    await client.query(
      `insert into course_versions(
        id,course_id,version,title,description,manifest_hash,source_preview_id,
        published_by_staff_id,publish_reason
      ) values($1,$2,1,'Commerce Academy','Commerce paid-flow evidence',$3,$4,$5,'Commerce evidence')`,
      [courseVersionId, courseId, manifestHash, previewId, staffId],
    );
    for (let order = 1; order <= 18; order += 1) {
      const lessonId = randomUUID();
      const accessibilityId = randomUUID();
      const disclosureId = randomUUID();
      const lessonVersionId = randomUUID();
      const contentHash = sha256(`commerce-lesson:${order}`);
      await client.query(
        "insert into lessons(id,course_id,stage_id,slug) values($1,$2,$3,$4)",
        [lessonId, courseId, stageId, `lesson-${order}`],
      );
      await client.query(
        `insert into lesson_accessibility_decisions(
          id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,
          reviewer_staff_id,reason
        ) values($1,$2,1,$3,1,'approved',$4,'Commerce evidence')`,
        [accessibilityId, lessonId, contentHash, staffId],
      );
      await client.query(
        `insert into lesson_disclosure_decisions(
          id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,
          policy_version,reviewer_staff_id,reason
        ) values($1,$2,1,$3,1,'not_applicable','commerce.v1',$4,'Commerce evidence')`,
        [disclosureId, lessonId, contentHash, staffId],
      );
      await client.query(
        `insert into lesson_versions(
          id,lesson_id,course_id,stage_id,version,title,summary,duration_seconds,
          blocks,transcript,stage_order,"order",required,release_rule,
          accessibility_decision_id,accessibility_decision_sequence,
          disclosure_decision_id,disclosure_decision_sequence,content_hash,
          published_by_staff_id,publish_reason
        ) values(
          $1,$2,$3,$4,1,$5,'Commerce evidence',300,'[]'::jsonb,
          '{"schemaVersion":1,"blocks":[]}'::jsonb,1,$6,true,
          '{"kind":"immediate"}'::jsonb,$7,1,$8,1,$9,$10,'Commerce evidence'
        )`,
        [
          lessonVersionId,
          lessonId,
          courseId,
          stageId,
          `Lesson ${order}`,
          order,
          accessibilityId,
          disclosureId,
          contentHash,
          staffId,
        ],
      );
      await client.query(
        `insert into course_version_lessons(
          course_version_id,course_id,lesson_id,lesson_version_id,stage_id,
          stage_title,stage_order,lesson_order,required,release_rule
        ) values($1,$2,$3,$4,$5,'Academy',1,$6,true,'{"kind":"immediate"}'::jsonb)`,
        [courseVersionId, courseId, lessonId, lessonVersionId, stageId, order],
      );
    }
    await client.query(
      `insert into course_heads(
        course_id,channel,current_course_version_id,manifest_hash,head_revision,
        set_by_staff_id
      ) values($1,'production',$2,$3,1,$4)`,
      [courseId, courseVersionId, manifestHash, staffId],
    );
    await client.query(
      `insert into content_readiness_evaluations(
        id,course_version_id,gate_hash,issues,passed,evaluator_version
      ) values($1,$2,$3,'[]'::jsonb,true,'commerce-evidence.v1')`,
      [evaluationId, courseVersionId, gateHash],
    );
    await client.query(
      `insert into content_readiness_approvals(
        evaluation_id,gate_hash,approver_staff_id,reason
      ) values($1,$2,$3,'Commerce evidence')`,
      [evaluationId, gateHash, staffId],
    );
    await client.query("commit");
    return { courseId, courseVersionId, gateHash };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectReadinessMutation(
  database: Database,
  statements: string | readonly string[],
  expectedFalseField: string,
): Promise<void> {
  const baseline = await database.pool.query<Record<string, unknown>>(
    "select * from syntholo_commerce_catalog_readiness_v1()",
  );
  expect(baseline.rows).toHaveLength(1);
  expect(baseline.rows[0]?.[expectedFalseField]).toBe(true);
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    for (const statement of typeof statements === "string" ? [statements] : statements) {
      await client.query(statement);
    }
    const drift = await client.query<Record<string, unknown>>(
      "select * from syntholo_commerce_catalog_readiness_v1()",
    );
    expect(drift.rows).toHaveLength(1);
    expect(drift.rows[0]?.[expectedFalseField]).toBe(false);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  const restored = await database.pool.query("select * from syntholo_commerce_catalog_readiness_v1()");
  expect(restored.rows).toEqual(baseline.rows);
}

describeDatabase("0014 Commerce catalog migration upgrades", () => {
  it("applies all fourteen migrations to a blank database and replays exactly", async () => {
    await withDisposableDatabase("blank", async (database) => {
      const directory = await mkdtemp(join(tmpdir(), "syntholo-commerce-blank-"));
      try {
        await writeMigrationFolder(directory, 14);
        await migrate(database, { migrationsFolder: directory });
        const before = await database.pool.query("select * from syntholo_commerce_catalog_readiness_v1()");
        await migrate(database, { migrationsFolder: directory });
        const after = await database.pool.query("select * from syntholo_commerce_catalog_readiness_v1()");
        expect(after.rows).toEqual(before.rows);
        expect(after.rows[0]).toMatchObject({
          catalog_ready: true,
          cleanup_disabled: true,
          contract_version: "0014_commerce_catalog.v1",
          migration_hash: commerceMigrationHash,
        });
        expect((await database.pool.query(
          "select count(*)::int count from drizzle.__drizzle_migrations",
        )).rows).toEqual([{ count: 14 }]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  }, 90_000);

  it("upgrades a populated 0013 database and preserves non-Stripe facts", async () => {
    await withDisposableDatabase("populated", async (database) => {
      const prior = await mkdtemp(join(tmpdir(), "syntholo-commerce-prior-"));
      const current = await mkdtemp(join(tmpdir(), "syntholo-commerce-current-"));
      try {
        await writeMigrationFolder(prior, 13);
        await writeMigrationFolder(current, 14);
        await migrate(database, { migrationsFolder: prior });
        const accountId = randomUUID();
        const identityId = randomUUID();
        const membershipId = randomUUID();
        const receiptId = randomUUID();
        const client = await database.pool.connect();
        try {
          await client.query("begin");
          await client.query("insert into accounts(id,name) values($1,'Populated Account')", [accountId]);
          await client.query(
            "insert into member_identities(id,account_id,provider,provider_user_id) values($1,$2,'clerk',$3)",
            [identityId, accountId, `commerce-${randomUUID()}`],
          );
          await client.query(
            "insert into memberships(id,account_id,member_identity_id,role,status) values($1,$2,$3,'owner','active')",
            [membershipId, accountId, identityId],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        await database.pool.query(
          "insert into provider_event_receipts(id,provider,provider_event_id) values($1,'mux',$2)",
          [receiptId, `mux-${randomUUID()}`],
        );
        await migrate(database, { migrationsFolder: current });
        expect((await database.pool.query(
          `select (select name_status from accounts where id=$1) name_status,
            (select provider from provider_event_receipts where id=$2) provider,
            (select count(*)::int from offers) offer_count`,
          [accountId, receiptId],
        )).rows).toEqual([{ name_status: "confirmed", offer_count: 6, provider: "mux" }]);
      } finally {
        await Promise.all([
          rm(prior, { force: true, recursive: true }),
          rm(current, { force: true, recursive: true }),
        ]);
      }
    });
  }, 90_000);

  it("fails closed instead of guessing legacy Stripe receipt authority", async () => {
    await withDisposableDatabase("unsafe_receipt", async (database) => {
      const prior = await mkdtemp(join(tmpdir(), "syntholo-commerce-unsafe-prior-"));
      const current = await mkdtemp(join(tmpdir(), "syntholo-commerce-unsafe-current-"));
      try {
        await writeMigrationFolder(prior, 13);
        await writeMigrationFolder(current, 14);
        await migrate(database, { migrationsFolder: prior });
        await database.pool.query(
          "insert into provider_event_receipts(id,provider,provider_event_id) values($1,'stripe',$2)",
          [randomUUID(), `evt_${randomUUID().replaceAll("-", "")}`],
        );
        await expect(migrate(database, { migrationsFolder: current })).rejects.toThrow(
          "COMMERCE_LEGACY_STRIPE_RECEIPT_UNSAFE",
        );
        expect((await database.pool.query(
          "select count(*)::int count from drizzle.__drizzle_migrations",
        )).rows).toEqual([{ count: 13 }]);
      } finally {
        await Promise.all([
          rm(prior, { force: true, recursive: true }),
          rm(current, { force: true, recursive: true }),
        ]);
      }
    });
  }, 90_000);
});

describeDatabase("Commerce catalog PostgreSQL authority", () => {
  let database: Database;
  let maintenance: Pool;
  let authorityDatabaseName: string;
  let systemDatabase: Database;
  let memberDatabase: Database;
  let staffDatabase: Database;
  let workerDatabase: Database;
  const suffix = randomUUID().replaceAll("-", "");
  const systemRole = `syntholo_commerce_system_${suffix}`;
  const memberRole = `syntholo_commerce_member_${suffix}`;
  const staffRole = `syntholo_commerce_staff_${suffix}`;
  const workerRole = `syntholo_commerce_worker_${suffix}`;

  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    authorityDatabaseName = `syntholo_commerce_authority_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    maintenance = new Pool({ connectionString: databaseUrl(baseUrl, "postgres"), max: 1 });
    await maintenance.query(`create database "${authorityDatabaseName}"`);
    const authorityUrl = databaseUrl(baseUrl, authorityDatabaseName);
    database = createDatabase({ url: authorityUrl, applicationName: "syntholo-commerce-owner-integration" });
    const migrations = await mkdtemp(join(tmpdir(), "syntholo-commerce-authority-"));
    try {
      await writeMigrationFolder(migrations, 14);
      await migrate(database, { migrationsFolder: migrations });
    } finally {
      await rm(migrations, { force: true, recursive: true });
    }
    const roles = [
      [systemRole, "syntholo_system_api"],
      [memberRole, "syntholo_member_api"],
      [staffRole, "syntholo_staff_api"],
      [workerRole, "syntholo_worker"],
    ] as const;
    const passwords = new Map<string, string>();
    for (const [role, capability] of roles) {
      const password = randomUUID();
      passwords.set(role, password);
      await database.pool.query(await roleSql(database,
        "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
        [role, password]));
      await database.pool.query(await roleSql(database,
        `grant ${capability} to %I with inherit true,set false,admin false`, [role]));
    }
    systemDatabase = createDatabase({ url: loginUrl(authorityUrl, systemRole, passwords.get(systemRole)!), applicationName: "syntholo-commerce-system-integration" });
    memberDatabase = createDatabase({ url: loginUrl(authorityUrl, memberRole, passwords.get(memberRole)!), applicationName: "syntholo-commerce-member-integration" });
    staffDatabase = createDatabase({ url: loginUrl(authorityUrl, staffRole, passwords.get(staffRole)!), applicationName: "syntholo-commerce-staff-integration" });
    workerDatabase = createDatabase({ url: loginUrl(authorityUrl, workerRole, passwords.get(workerRole)!), applicationName: "syntholo-commerce-worker-integration" });
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([
      systemDatabase?.close(), memberDatabase?.close(), staffDatabase?.close(), workerDatabase?.close(),
    ]);
    if (database !== undefined) {
      for (const [role, capability] of [
        [systemRole, "syntholo_system_api"], [memberRole, "syntholo_member_api"],
        [staffRole, "syntholo_staff_api"], [workerRole, "syntholo_worker"],
      ] as const) {
        await database.pool.query(await roleSql(database, `revoke ${capability} from %I`, [role])).catch(() => undefined);
        await database.pool.query(await roleSql(database, "drop role if exists %I", [role])).catch(() => undefined);
      }
      await database.close();
      await maintenance.query(`drop database if exists "${authorityDatabaseName}" with (force)`).catch(() => undefined);
      await maintenance.end();
    }
  });

  it("attests the exact journal, frozen upstream authority, catalog, and startup projection for all roles", async () => {
    const migration = await readFile(new URL("../drizzle/0014_commerce_catalog.sql", import.meta.url));
    expect(sha256(migration)).toBe(commerceMigrationHash);
    const journal = await database.pool.query<{ created_at: string; hash: string }>(
      "select created_at::text,hash from drizzle.__drizzle_migrations order by created_at,id",
    );
    expect(journal.rows).toHaveLength(14);
    expect(journal.rows.at(-1)).toEqual({ created_at: String(commerceMigrationWhen), hash: commerceMigrationHash });
    const readiness = await database.pool.query("select * from syntholo_commerce_catalog_readiness_v1()");
    expect(readiness.rows).toEqual([{
      catalog_ready: true,
      certificates_migration_hash: "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9",
      cleanup_disabled: true,
      contract_version: "0014_commerce_catalog.v1",
      function_acl_ready: true,
      function_ready: true,
      implementation_completion_is_authority: false,
      implementation_migration_hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
      independence_ready: true,
      immutability_ready: true,
      migration_created_at: String(commerceMigrationWhen),
      migration_hash: commerceMigrationHash,
      policy_ready: true,
      public_execute_denied: true,
      rls_ready: true,
      structure_ready: true,
      table_acl_ready: true,
      table_ready: true,
      upstream_ready: true,
    }]);
    await expect(checkDatabaseReadiness(memberDatabase, "syntholo_member_api")).resolves.toMatchObject({ status: "ok" });
    await expect(checkDatabaseReadiness(staffDatabase, "syntholo_staff_api")).resolves.toMatchObject({ status: "ok" });
    await expect(checkDatabaseReadiness(systemDatabase, "syntholo_system_api")).resolves.toMatchObject({ status: "ok" });
    await expect(checkDatabaseReadiness(workerDatabase, "syntholo_worker")).resolves.toMatchObject({ status: "ok" });
  });

  it("denies raw Commerce data and system-only commands to member, staff, and worker logins", async () => {
    for (const runtime of [memberDatabase, staffDatabase, workerDatabase]) {
      await expect(runtime.pool.query("select * from offers")).rejects.toThrow(/permission denied/u);
      await expect(runtime.pool.query(
        "select * from syntholo_commerce_stage_catalog_version_v1('scorecard','v1','{\"policy\":\"v1\"}'::jsonb,null,repeat('a',64),'2026-08-15T12:00:00Z')",
      )).rejects.toThrow(/permission denied/u);
    }
    await expect(systemDatabase.pool.query("select * from offers")).rejects.toThrow(/permission denied/u);
    await expect(workerDatabase.pool.query(
      "select * from syntholo_cleanup_public_bos_intents_v1(null,null,null,null,null,null,null,null,null,null)",
    )).rejects.toThrow(/permission denied/u);
  });

  it("detects structure, trigger, RLS, policy, table, column, and function ACL drift", async () => {
    await expectReadinessMutation(database, "alter table offers add column hostile text", "structure_ready");
    await expectReadinessMutation(database, "drop index provider_event_processing_claim_idx", "structure_ready");
    await expectReadinessMutation(database, "alter table offers disable trigger offers_guard", "immutability_ready");
    await expectReadinessMutation(database, "alter table offers disable row level security", "rls_ready");
    await expectReadinessMutation(database,
      "alter policy offers_migrator on offers to public using(true) with check(true)", "policy_ready");
    await expectReadinessMutation(database, "grant select on offers to syntholo_member_api", "table_acl_ready");
    await expectReadinessMutation(database, "grant select(code) on offers to syntholo_member_api", "table_acl_ready");
    await expectReadinessMutation(database,
      "grant execute on function syntholo_commerce_stage_catalog_version_v1(text,text,jsonb,text,text,timestamptz) to syntholo_system_api with grant option",
      "function_acl_ready");
    await expectReadinessMutation(database,
      "grant execute on function syntholo_commerce_stage_catalog_version_v1(text,text,jsonb,text,text,timestamptz) to public",
      "public_execute_denied");
  });

  it("detects function, upstream, catalog, cleanup, independence, and journal drift", async () => {
    await expectReadinessMutation(database,
      "alter function syntholo_commerce_stage_catalog_version_v1(text,text,jsonb,text,text,timestamptz) stable",
      "function_ready");
    await expectReadinessMutation(database,
      "alter function syntholo_content_readiness_v1() volatile", "upstream_ready");
    await expectReadinessMutation(database, [
      "alter table offers disable trigger offers_guard",
      "update offers set readiness_policy='hostile.v1' where code='guided_pilot'",
    ], "catalog_ready");
    await expectReadinessMutation(database,
      "grant execute on function syntholo_cleanup_public_bos_intents_v1(uuid,text,integer,integer,uuid,uuid,integer,integer,uuid,integer) to syntholo_worker",
      "cleanup_disabled");
    await expectReadinessMutation(database,
      "create function syntholo_commerce_hostile_certificate_v1() returns integer language sql stable set search_path=pg_catalog,pg_temp as 'select count(*)::integer from public.certificate_records'",
      "independence_ready");
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from drizzle.__drizzle_migrations where created_at=$1", [commerceMigrationWhen]);
      expect((await client.query("select * from syntholo_commerce_catalog_readiness_v1()")).rows).toEqual([]);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("serializes concurrent catalog staging to one immutable version", async () => {
    const command = () => contextualQuery<{
      catalog_version_id: string;
      replayed: boolean;
      state: string;
    }>(
      systemDatabase,
      "commerce-catalog-race.v1",
      "select * from syntholo_commerce_stage_catalog_version_v1($1,$2,$3::jsonb,$4,$5,$6)",
      [
        "scorecard",
        "race-v1",
        JSON.stringify({ terms: "race-v1" }),
        null,
        "c".repeat(64),
        "2026-08-15T11:59:59.999Z",
      ],
    );
    const results = (await Promise.all([command(), command()])).flat();
    expect(results).toHaveLength(2);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ catalog_version_id: id }) => id)).size).toBe(1);
    expect((await database.pool.query(
      "select count(*)::int count from offer_catalog_versions where offer_code='scorecard' and version='race-v1'",
    )).rows).toEqual([{ count: 1 }]);
  });

  it("publishes the free catalog exactly and fences provider receipt processing through a real system login", async () => {
    const now = "2026-08-15T12:00:00.000Z";
    const staged = await contextualQuery<{
      catalog_version_id: string;
      replayed: boolean;
      state: string;
    }>(
      systemDatabase,
      "commerce-catalog-publisher.v1",
      "select * from syntholo_commerce_stage_catalog_version_v1($1,$2,$3::jsonb,$4,$5,$6)",
      ["scorecard", "v1", JSON.stringify({ terms: "v1" }), null, "a".repeat(64), now],
    );
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ replayed: false, state: "draft" });
    const catalogVersionId = staged[0]?.catalog_version_id;
    expect(catalogVersionId).toMatch(/^[0-9a-f-]{36}$/u);
    const replay = await contextualQuery<{ replayed: boolean }>(
      systemDatabase,
      "commerce-catalog-publisher.v1",
      "select replayed from syntholo_commerce_stage_catalog_version_v1($1,$2,$3::jsonb,$4,$5,$6)",
      ["scorecard", "v1", JSON.stringify({ terms: "v1" }), null, "a".repeat(64), now],
    );
    expect(replay).toEqual([{ replayed: true }]);
    await expect(contextualQuery(
      systemDatabase,
      "commerce-catalog-publisher.v1",
      "select * from syntholo_commerce_stage_catalog_version_v1($1,$2,$3::jsonb,$4,$5,$6)",
      ["scorecard", "v1", JSON.stringify({ terms: "v2" }), null, "a".repeat(64), now],
    )).rejects.toThrow("COMMERCE_CATALOG_RECONCILIATION_REQUIRED");
    const published = await contextualQuery<{ replayed: boolean; state: string }>(
      systemDatabase,
      "commerce-catalog-publisher.v1",
      "select replayed,state from syntholo_commerce_publish_catalog_version_v1($1,$2,$3,$4)",
      [catalogVersionId, "scorecard", "test", "2026-08-15T12:00:00.001Z"],
    );
    expect(published).toEqual([{ replayed: false, state: "published" }]);
    expect(await contextualQuery<{ replayed: boolean; state: string }>(
      systemDatabase,
      "commerce-catalog-publisher.v1",
      "select replayed,state from syntholo_commerce_publish_catalog_version_v1($1,$2,$3,$4)",
      [catalogVersionId, "scorecard", "test", "2026-08-15T12:00:00.001Z"],
    )).toEqual([{ replayed: true, state: "published" }]);

    const providerEventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const dataObjectId = `cs_test_${randomUUID().replaceAll("-", "")}`;
    const event = await contextualQuery<{
      receipt_id: string;
      replayed: boolean;
      status: string;
    }>(
      systemDatabase,
      "commerce-webhook.v1",
      `select * from syntholo_commerce_record_provider_event_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        providerEventId,
        "checkout.session.completed",
        false,
        "2026-08-15",
        now,
        "checkout.session",
        dataObjectId,
        true,
        "acct_test_syntholo",
        null,
        null,
        "b".repeat(64),
        false,
        "2026-08-15",
        "acct_test_syntholo",
        "2026-08-15T12:00:00.002Z",
      ],
    );
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({ replayed: false, status: "received" });
    const receiptId = event[0]?.receipt_id;
    expect(await contextualQuery<{ replayed: boolean; status: string }>(
      systemDatabase,
      "commerce-webhook.v1",
      `select replayed,status from syntholo_commerce_record_provider_event_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        providerEventId,
        "checkout.session.completed",
        false,
        "2026-08-15",
        now,
        "checkout.session",
        dataObjectId,
        true,
        "acct_test_syntholo",
        null,
        null,
        "b".repeat(64),
        false,
        "2026-08-15",
        "acct_test_syntholo",
        "2026-08-15T12:00:00.002Z",
      ],
    )).toEqual([{ replayed: true, status: "received" }]);
    const missingVersionEventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const missingVersion = await contextualQuery<{
      receipt_id: string;
      status: string;
    }>(
      systemDatabase,
      "commerce-webhook.v1",
      `select receipt_id,status from syntholo_commerce_record_provider_event_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        missingVersionEventId,
        "checkout.session.completed",
        false,
        null,
        now,
        "checkout.session",
        `cs_test_${randomUUID().replaceAll("-", "")}`,
        true,
        "acct_test_syntholo",
        null,
        null,
        "c".repeat(64),
        false,
        "2026-08-15",
        "acct_test_syntholo",
        "2026-08-15T12:00:00.002Z",
      ],
    );
    expect(missingVersion).toHaveLength(1);
    expect(missingVersion[0]?.status).toBe("failed_terminal");
    expect((await database.pool.query(
      "select api_version from provider_event_receipts where id=$1",
      [missingVersion[0]?.receipt_id],
    )).rows).toEqual([{ api_version: null }]);
    const objectMismatch = await contextualQuery<{
      receipt_id: string;
      status: string;
    }>(
      systemDatabase,
      "commerce-webhook.v1",
      `select receipt_id,status from syntholo_commerce_record_provider_event_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        `evt_${randomUUID().replaceAll("-", "")}`,
        "checkout.session.completed",
        false,
        "2026-08-15",
        now,
        "invoice",
        `in_test_${randomUUID().replaceAll("-", "")}`,
        false,
        "acct_test_syntholo",
        null,
        null,
        "d".repeat(64),
        false,
        "2026-08-15",
        "acct_test_syntholo",
        "2026-08-15T12:00:00.002Z",
      ],
    );
    expect(objectMismatch).toHaveLength(1);
    expect(objectMismatch[0]?.status).toBe("failed_terminal");
    expect((await database.pool.query(
      "select outcome_code from provider_event_processing where receipt_id=$1",
      [objectMismatch[0]?.receipt_id],
    )).rows).toEqual([{ outcome_code: "event_object_mismatch" }]);
    const claimed = await contextualQuery<{
      lease_generation: number;
      lease_token: string;
      receipt_id: string;
    }>(
      systemDatabase,
      "commerce-worker.v1",
      "select receipt_id,lease_token,lease_generation from syntholo_commerce_claim_provider_event_v1($1,$2,$3)",
      ["commerce-worker.v1", 60_000, "2026-08-15T12:00:00.003Z"],
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.receipt_id).toBe(receiptId);
    const reclaimed = await contextualQuery<{
      lease_generation: number;
      lease_token: string;
      receipt_id: string;
    }>(
      systemDatabase,
      "commerce-worker-recovery.v1",
      "select receipt_id,lease_token,lease_generation from syntholo_commerce_claim_provider_event_v1($1,$2,$3)",
      ["commerce-worker-recovery.v1", 60_000, "2026-08-15T12:01:00.004Z"],
    );
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      lease_generation: (claimed[0]?.lease_generation ?? 0) + 1,
      receipt_id: receiptId,
    });
    await expect(contextualQuery(
      systemDatabase,
      "commerce-worker.v1",
      "select * from syntholo_commerce_finish_provider_event_v1($1,$2,$3,$4,$5,$6,$7)",
      [
        receiptId,
        "commerce-worker.v1",
        claimed[0]?.lease_token,
        claimed[0]?.lease_generation,
        "processed",
        "applied",
        "2026-08-15T12:01:00.005Z",
      ],
    )).rejects.toThrow("COMMERCE_PROVIDER_EVENT_FENCE_INVALID");
    const acknowledged = await contextualQuery<{ replayed: boolean; status: string }>(
      systemDatabase,
      "commerce-worker-recovery.v1",
      "select * from syntholo_commerce_finish_provider_event_v1($1,$2,$3,$4,$5,$6,$7)",
      [
        receiptId,
        "commerce-worker-recovery.v1",
        reclaimed[0]?.lease_token,
        reclaimed[0]?.lease_generation,
        "processed",
        "applied",
        "2026-08-15T12:01:00.005Z",
      ],
    );
    expect(acknowledged).toEqual([{ replayed: false, status: "processed" }]);
    expect(await contextualQuery<{ replayed: boolean; status: string }>(
      systemDatabase,
      "commerce-worker-recovery.v1",
      "select * from syntholo_commerce_finish_provider_event_v1($1,$2,$3,$4,$5,$6,$7)",
      [
        receiptId,
        "commerce-worker-recovery.v1",
        reclaimed[0]?.lease_token,
        reclaimed[0]?.lease_generation,
        "processed",
        "applied",
        "2026-08-15T12:01:00.005Z",
      ],
    )).toEqual([{ replayed: true, status: "processed" }]);
  });

  it("converges a signed paid self-paced purchase through claim, owner seat, workspace, and onboarding", async () => {
    const content = await seedReadyAcademyCourse(database);
    const receiver = "acct_test_syntholo";
    const catalogNow = "2026-08-15T13:00:00.000Z";
    const staged = await contextualQuery<{ catalog_version_id: string }>(
      systemDatabase,
      "commerce-paid-catalog.v1",
      "select catalog_version_id from syntholo_commerce_stage_catalog_version_v1($1,$2,$3::jsonb,$4,$5,$6)",
      [
        "self_paced",
        "paid-flow-v1",
        JSON.stringify({ privacy: "v1", refund: "v1", terms: "v1" }),
        content.gateHash,
        sha256("commerce-paid-flow-catalog"),
        catalogNow,
      ],
    );
    const catalogVersionId = staged[0]?.catalog_version_id;
    expect(catalogVersionId).toMatch(/^[0-9a-f-]{36}$/u);
    const priceFingerprint = sha256([
      "commerce-price-binding.v1",
      "self_paced",
      "test",
      receiver,
      "prod_self_paced_test",
      "price_self_paced_test",
      "self_paced_once",
      "txcd_self_paced_test",
      "usd",
      "39900",
      "-",
      "0",
      "inclusive",
      "1",
    ].join("\n"));
    const binding = await contextualQuery<{ price_binding_id: string }>(
      systemDatabase,
      "commerce-paid-catalog.v1",
      `select price_binding_id from syntholo_commerce_stage_price_binding_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        catalogVersionId,
        "self_paced",
        "test",
        receiver,
        "prod_self_paced_test",
        "price_self_paced_test",
        "self_paced_once",
        "txcd_self_paced_test",
        "usd",
        39_900,
        null,
        null,
        "inclusive",
        priceFingerprint,
        catalogNow,
        "2026-08-15T13:00:00.001Z",
      ],
    );
    const priceBindingId = binding[0]?.price_binding_id;
    expect(priceBindingId).toMatch(/^[0-9a-f-]{36}$/u);
    await contextualQuery(
      systemDatabase,
      "commerce-paid-catalog.v1",
      "select * from syntholo_commerce_publish_catalog_version_v1($1,$2,$3,$4)",
      [catalogVersionId, "self_paced", "test", "2026-08-15T13:00:00.002Z"],
    );
    const activation = await database.pool.connect();
    try {
      await activation.query("begin");
      await activation.query("set local row_security=off");
      await activation.query(
        "select set_config('app.commerce_transition','offers',true)",
      );
      await activation.query(
        "update offers set state='enabled',updated_at=$1 where code='self_paced'",
        ["2026-08-15T13:00:00.003Z"],
      );
      await activation.query("select set_config('app.commerce_transition','',true)");
      await activation.query("commit");
    } finally {
      activation.release();
    }

    const businessName = "Commerce Flow Company";
    const emailFingerprint = Buffer.alloc(32, 7);
    const requestHash = sha256("commerce-paid-flow-request");
    const reserved = await contextualQuery<{
      action_id: string;
      authorization_id: string;
    }>(
      systemDatabase,
      "commerce-public-checkout.v1",
      `select action_id,authorization_id from syntholo_commerce_reserve_public_self_paced_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20::jsonb,$21,$22
      )`,
      [
        "public-flow.v1",
        `public-flow-${randomUUID()}`,
        "test",
        receiver,
        catalogVersionId,
        priceBindingId,
        emailFingerprint,
        Buffer.from("encrypted-email"),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        "contact-key.v1",
        Buffer.from("encrypted-business-name"),
        Buffer.alloc(12, 3),
        Buffer.alloc(16, 4),
        "business-key.v1",
        sha256(businessName),
        "account_name_v1",
        requestHash,
        "syntholo_TestFlow",
        JSON.stringify({ privacy: "v1", refund: "v1", terms: "v1" }),
        "2026-08-15T14:01:00.000Z",
        "2026-08-15T13:01:00.000Z",
      ],
    );
    expect(reserved).toHaveLength(1);
    const authorizationId = reserved[0]?.authorization_id;
    const actionId = reserved[0]?.action_id;
    const begun = await contextualQuery<{ attempt: number }>(
      systemDatabase,
      "commerce-checkout-provider.v1",
      "select attempt from syntholo_commerce_begin_checkout_action_v1($1,$2,$3)",
      [actionId, requestHash, "2026-08-15T13:01:00.001Z"],
    );
    expect(begun).toEqual([{ attempt: 1 }]);
    const providerSessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
    await contextualQuery(
      systemDatabase,
      "commerce-checkout-provider.v1",
      `select * from syntholo_commerce_record_checkout_session_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )`,
      [
        actionId,
        requestHash,
        1,
        providerSessionId,
        null,
        "payment",
        "unpaid",
        Buffer.from("encrypted-checkout-url"),
        Buffer.alloc(12, 5),
        Buffer.alloc(16, 6),
        "checkout-key.v1",
        "2026-08-15T14:01:00.000Z",
        "2026-08-15T13:01:00.002Z",
      ],
    );
    const providerEventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const event = await contextualQuery<{ receipt_id: string }>(
      systemDatabase,
      "commerce-webhook-paid.v1",
      `select receipt_id from syntholo_commerce_record_provider_event_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )`,
      [
        providerEventId,
        "checkout.session.completed",
        false,
        "2026-08-15",
        "2026-08-15T13:01:03.000Z",
        "checkout.session",
        providerSessionId,
        true,
        receiver,
        null,
        null,
        sha256("signed-paid-event"),
        false,
        "2026-08-15",
        receiver,
        "2026-08-15T13:01:03.001Z",
      ],
    );
    const receiptId = event[0]?.receipt_id;
    const claimed = await contextualQuery<{
      lease_generation: number;
      lease_token: string;
    }>(
      systemDatabase,
      "commerce-paid-worker.v1",
      "select lease_token,lease_generation from syntholo_commerce_claim_provider_event_v1($1,$2,$3)",
      ["commerce-paid-worker.v1", 60_000, "2026-08-15T13:01:03.002Z"],
    );
    expect(claimed).toHaveLength(1);
    const claimTokenHash = sha256("commerce-claim-token");
    const paid = await contextualQuery<{
      account_id: string;
      claim_id: string;
      fulfillment_status: string;
      purchase_id: string;
      status: string;
    }>(
      systemDatabase,
      "commerce-paid-worker.v1",
      `select account_id,claim_id,fulfillment_status,purchase_id,status
       from syntholo_commerce_record_public_self_paced_paid_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
      )`,
      [
        receiptId,
        receiver,
        claimed[0]?.lease_token,
        claimed[0]?.lease_generation,
        authorizationId,
        `pi_${randomUUID().replaceAll("-", "")}`,
        `ch_${randomUUID().replaceAll("-", "")}`,
        39_900,
        0,
        "2026-08-15T13:01:03.000Z",
        randomUUID(),
        businessName,
        claimTokenHash,
        Buffer.from("encrypted-delivery-token"),
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 8),
        "delivery-key.v1",
        "2026-08-15T13:01:03.003Z",
      ],
    );
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ fulfillment_status: "fulfilled", status: "paid" });
    const accountId = paid[0]!.account_id;
    const sessionHandleHash = sha256("commerce-claim-session");
    const initiated = await contextualQuery<{ replayed: boolean }>(
      systemDatabase,
      "commerce-claim.v1",
      "select replayed from syntholo_commerce_initiate_claim_v1($1,$2,$3)",
      [claimTokenHash, sessionHandleHash, "2026-08-15T13:02:00.000Z"],
    );
    expect(initiated).toEqual([{ replayed: false }]);
    expect(await contextualQuery<{ replayed: boolean }>(
      systemDatabase,
      "commerce-claim.v1",
      "select replayed from syntholo_commerce_initiate_claim_v1($1,$2,$3)",
      [claimTokenHash, sessionHandleHash, "2026-08-15T13:02:00.000Z"],
    )).toEqual([{ replayed: true }]);
    const redeemed = await contextualQuery<{
      account_id: string;
      enrollment_id: string;
      identity_id: string;
      membership_id: string;
      replayed: boolean;
      seat_activated: boolean;
    }>(
      systemDatabase,
      "commerce-claim.v1",
      "select * from syntholo_commerce_redeem_claim_v1($1,$2,$3,$4,$5,$6,$7)",
      [
        sessionHandleHash,
        randomUUID(),
        sha256(JSON.stringify({ clerkUserId: "clerk_commerce_owner", email: "owner@example.test" })),
        "clerk_commerce_owner",
        "owner@example.test",
        emailFingerprint,
        "2026-08-15T13:02:00.001Z",
      ],
    );
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toMatchObject({
      account_id: accountId,
      replayed: false,
      seat_activated: true,
    });
    const actor = {
      accountId,
      identityId: redeemed[0]!.identity_id,
      membershipId: redeemed[0]!.membership_id,
    };
    const onboarding = await contextualMemberQuery<{ version: number }>(
      memberDatabase,
      actor,
      "select version from syntholo_commerce_get_onboarding_v1()",
    );
    expect(onboarding).toEqual([{ version: 1 }]);
    const saved = await contextualMemberQuery<{ version: number }>(
      memberDatabase,
      actor,
      `select version from syntholo_commerce_save_onboarding_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::text[],$12,$13,$14,$15,$16
      )`,
      [
        1,
        businessName,
        "https://example.test",
        "Education",
        "US",
        "America/New_York",
        "solo",
        "Founder",
        "Launch the academy",
        JSON.stringify({ crm: ["CRM"], scheduling: ["Calendar"], email: ["Email"] }),
        ["Publish", "Enroll", "Implement"],
        null,
        true,
        true,
        "delivery",
        "2026-08-15T13:03:00.000Z",
      ],
    );
    expect(saved).toEqual([{ version: 2 }]);
    const completionHash = (await database.pool.query<{ hash: string }>(
      `select encode(sha256(convert_to(
        syntholo_canonical_jsonb_text_v1(jsonb_build_object(
          'routeVersion','commerce-onboarding-complete.v1','accountId',$1::text,
          'membershipId',$2::text,'expectedVersion',2
        )),'UTF8')),'hex') hash`,
      [accountId, actor.membershipId],
    )).rows[0]!.hash;
    const completionKey = `onboarding-${randomUUID()}`;
    const completed = await contextualMemberQuery<{
      destination: string;
      replayed: boolean;
      version: number;
    }>(
      memberDatabase,
      actor,
      "select * from syntholo_commerce_complete_onboarding_v1($1,$2,$3,$4)",
      [2, completionKey, completionHash, "2026-08-15T13:03:00.001Z"],
    );
    expect(completed).toEqual([{ destination: "academy", replayed: false, version: 2 }]);
    expect(await contextualMemberQuery(
      memberDatabase,
      actor,
      "select replayed,version,destination from syntholo_commerce_complete_onboarding_v1($1,$2,$3,$4)",
      [2, completionKey, completionHash, "2026-08-15T13:03:00.001Z"],
    )).toEqual([{ destination: "academy", replayed: true, version: 2 }]);

    const convergence = await database.pool.query<{
      active_accesses: number;
      active_enrollments: number;
      active_owner_seats: number;
      implementation_roots: number;
      onboarding_events: number;
      source_grants: number;
    }>(
      `select
        (select count(*)::int from account_course_accesses where account_id=$1 and status='active') active_accesses,
        (select count(*)::int from enrollments where account_id=$1 and membership_id=$2 and status='active') active_enrollments,
        (select count(*)::int from seat_reservations where account_id=$1 and membership_id=$2 and state='active') active_owner_seats,
        (select count(*)::int from implementation_artifacts where account_id=$1) implementation_roots,
        (select count(*)::int from outbox_events where account_id=$1 and type='onboarding.completed.v1') onboarding_events,
        (select count(*)::int from entitlement_grants where account_id=$1 and source_kind='purchase' and offer_code='self_paced' and status='active') source_grants`,
      [accountId, actor.membershipId],
    );
    expect(convergence.rows).toEqual([{
      active_accesses: 1,
      active_enrollments: 1,
      active_owner_seats: 1,
      implementation_roots: 5,
      onboarding_events: 1,
      source_grants: 3,
    }]);
    expect((await database.pool.query(
      "select name_status from accounts where id=$1",
      [accountId],
    )).rows).toEqual([{ name_status: "confirmed" }]);
  }, 90_000);
});
