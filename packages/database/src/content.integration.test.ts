import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  url.search = "";
  return url.toString();
}

async function formattedRoleSql(
  database: Database,
  template: string,
  values: readonly string[],
): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ value: string }>(
    `select format($fmt$${template}$fmt$, ${parameters}) value`,
    [...values],
  );
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("TEST_ROLE_SQL_FORMAT_FAILED");
  return value;
}

describe("content publication closed commands", () => {
  let harness: TestDatabaseHarness;
  let staff: Database | undefined;
  const staffRole = `syntholo_content_staff_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const password = randomUUID();
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      [staffRole, password],
    ));
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "grant syntholo_staff_api to %I with inherit true, set false, admin false",
      [staffRole],
    ));
    staff = createDatabase({
      applicationName: "syntholo-content-staff-integration",
      url: loginUrl(baseUrl, staffRole, password),
    });
  });
  beforeEach(async () => harness.reset());
  afterAll(async () => {
    await staff?.close();
    if (harness !== undefined) {
      await harness.database.pool.query(await formattedRoleSql(
        harness.database,
        "revoke syntholo_staff_api from %I",
        [staffRole],
      ));
      await harness.database.pool.query(await formattedRoleSql(
        harness.database,
        "drop role if exists %I",
        [staffRole],
      ));
      await harness.close();
    }
  });

  it("rejects caller-asserted empty readiness before creating a preview or course version", async () => {
    const staffId = "10000000-0000-4000-8000-000000000001";
    const courseId = "10000000-0000-4000-8000-000000000010";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_content_admin', 'admin')`,
      [staffId],
    );
    await harness.database.pool.query(
      `insert into courses (id, slug, title, description, current_draft_revision)
       values ($1, 'launch-course', 'Launch course', 'Authoritative content required', 1)`,
      [courseId],
    );
    await harness.database.pool.query(
      `insert into course_drafts
        (course_id, revision, title, description, updated_by_staff_id)
       values ($1, 1, 'Launch course', 'Authoritative content required', $2)`,
      [courseId, staffId],
    );

    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const client = await staff.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [staffId, "40000000-0000-4000-8000-000000000001"],
      );
      const assertedManifest = "{}";
      const assertedHash = createHash("sha256").update(assertedManifest).digest("hex");
      await expect(client.query(
        "select public.syntholo_content_create_preview_v1($1,1,$2,$3,$4::jsonb,'[]'::jsonb,'Launch approval')",
        [courseId, assertedManifest, assertedHash, assertedManifest],
      )).rejects.toMatchObject({
        message: expect.stringContaining("CONTENT_PUBLICATION_PIPELINE_INCOMPLETE"),
      });
    } finally {
      await client.query("rollback");
      client.release();
    }

    const artifacts = await harness.database.pool.query<{
      previews: number;
      versions: number;
      lessons: number;
    }>(
      `select
         (select count(*)::int from content_previews) previews,
         (select count(*)::int from course_versions) versions,
         (select count(*)::int from course_version_lessons) lessons`,
    );
    expect(artifacts.rows[0]).toEqual({ previews: 0, versions: 0, lessons: 0 });
  });

  it("resets 0009 content state between repeated integration runs", async () => {
    const staffId = "10000000-0000-4000-8000-000000000002";
    const courseId = "10000000-0000-4000-8000-000000000012";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role)
       values ($1, 'workos_content_reset', 'admin')`,
      [staffId],
    );
    await harness.database.pool.query(
      `insert into courses (id, slug, title, description, current_draft_revision)
       values ($1, 'reset-course', 'Reset course', 'Reset evidence', 1)`,
      [courseId],
    );
    await harness.database.pool.query(
      `insert into course_drafts
        (course_id, revision, title, description, updated_by_staff_id)
       values ($1, 1, 'Reset course', 'Reset evidence', $2)`,
      [courseId, staffId],
    );

    await harness.reset();

    const rows = await harness.database.pool.query<{
      courses: number;
      drafts: number;
      staff: number;
    }>(
      `select
         (select count(*)::int from courses) courses,
         (select count(*)::int from course_drafts) drafts,
         (select count(*)::int from staff_identities) staff`,
    );
    expect(rows.rows[0]).toEqual({ courses: 0, drafts: 0, staff: 0 });
  });

  it("rejects every non-canonical release-rule shape at the persisted draft boundary", async () => {
    const staffId = "10000000-0000-4000-8000-000000000003";
    const courseId = "10000000-0000-4000-8000-000000000013";
    const stageId = "10000000-0000-4000-8000-000000000023";
    const lessonId = "10000000-0000-4000-8000-000000000033";
    await harness.database.pool.query(
      "insert into staff_identities (id,provider_user_id,role) values ($1,'workos_release_admin','admin')",
      [staffId],
    );
    await harness.database.pool.query(
      "insert into courses (id,slug,title,description) values ($1,'release-course','Release course','Release checks')",
      [courseId],
    );
    await harness.database.pool.query(
      "insert into stages (id,course_id,slug) values ($1,$2,'foundation')",
      [stageId, courseId],
    );
    await harness.database.pool.query(
      "insert into lessons (id,course_id,stage_id,slug) values ($1,$2,$3,'lesson-one')",
      [lessonId, courseId, stageId],
    );

    for (const releaseRule of [
      { kind: "immediate", extra: true },
      { kind: "elapsed_days", days: 1, extra: true },
      { kind: "fixed_at", at: "2026-08-14T16:00:00Z" },
      { kind: "fixed_at", at: "2026-08-14T12:00:00.000-04:00" },
      { kind: "fixed_at", at: "2026-02-30T12:00:00.000Z" },
    ]) {
      await expect(harness.database.pool.query(
        `insert into lesson_drafts
          (lesson_id,course_id,stage_id,revision,title,stage_order,"order",release_rule,updated_by_staff_id)
         values ($1,$2,$3,1,'Lesson one',1,1,$4::jsonb,$5)`,
        [lessonId, courseId, stageId, JSON.stringify(releaseRule), staffId],
      )).rejects.toThrow();
    }

    const constraints = await harness.database.pool.query<{ conname: string }>(
      `select conname from pg_constraint where conname=any($1::text[]) and contype='c' and convalidated
       order by conname`,
      [[
        "lesson_drafts_release_rule_check",
        "lesson_versions_release_rule_check",
        "course_draft_manifest_release_rule_check",
        "course_version_lessons_release_rule_check",
      ]],
    );
    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "course_draft_manifest_release_rule_check",
      "course_version_lessons_release_rule_check",
      "lesson_drafts_release_rule_check",
      "lesson_versions_release_rule_check",
    ]);
  });

  it("attests exact content ownership, types, immutable triggers, and closed ACL allowlists", async () => {
    const projection = await harness.database.pool.query<{
      function_acl_ready: boolean;
      immutable_triggers_ready: boolean;
      object_owner_ready: boolean;
      object_type_ready: boolean;
      public_execute_denied: boolean;
      table_acl_ready: boolean;
    }>("select * from public.syntholo_content_readiness_v1()");
    expect(projection.rows[0]).toMatchObject({
      function_acl_ready: true,
      immutable_triggers_ready: true,
      object_owner_ready: true,
      object_type_ready: true,
      public_execute_denied: true,
      table_acl_ready: true,
    });

    const client = await harness.database.pool.connect();
    try {
      await client.query("begin");
      await client.query("grant select on public.courses to syntholo_member_api");
      const widenedTable = await client.query<{ table_acl_ready: boolean }>(
        "select table_acl_ready from public.syntholo_content_readiness_v1()",
      );
      expect(widenedTable.rows[0]?.table_acl_ready).toBe(false);
      await client.query("rollback");

      await client.query("begin");
      await client.query(
        "grant execute on function public.syntholo_content_publish_course_v1(uuid,text,integer,text) to public",
      );
      const widenedFunction = await client.query<{
        function_acl_ready: boolean;
        public_execute_denied: boolean;
      }>("select function_acl_ready,public_execute_denied from public.syntholo_content_readiness_v1()");
      expect(widenedFunction.rows[0]).toEqual({
        function_acl_ready: false,
        public_execute_denied: false,
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
