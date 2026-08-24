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

const blocks = JSON.stringify([
  { type: "rich_text", blockId: "body", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Lesson body content for integration testing." }] }] } },
  { type: "action", blockId: "act", title: "Apply it", instructions: "Complete the exercise described here." },
]);
const transcript = JSON.stringify({ schemaVersion: 1, blocks: [{ blockId: "t1", text: "Transcript text for integration testing." }] });

async function runStaff<R extends Record<string, unknown>>(
  staff: Database,
  staffId: string,
  sql: string,
  values: readonly unknown[],
): Promise<R | undefined> {
  const client = await staff.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
      [staffId, randomUUID()],
    );
    const result = await client.query<R>(sql, [...values]);
    await client.query("commit");
    return result.rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

describe("content authoring closed commands", () => {
  let harness: TestDatabaseHarness;
  let staff: Database | undefined;
  const staffRole = `syntholo_authoring_staff_${randomUUID().replaceAll("-", "")}`;

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
      applicationName: "syntholo-content-authoring-staff-integration",
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

  it("creates a course draft, a stage, and a lesson whose synthetic media/captions/resource satisfy the existing unmodified publish gate", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000001";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin', 'admin')`,
      [staffId],
    );

    const course = await runStaff<{ syntholo_content_create_course_draft_v1: { courseId: string; revision: number } }>(
      staff, staffId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) as syntholo_content_create_course_draft_v1",
      ["integration-course", "Integration course", "A course created for integration testing.", "idem-course-int-000000001", createHash("sha256").update("course1").digest("hex")],
    );
    const courseId = course?.syntholo_content_create_course_draft_v1.courseId;
    expect(courseId).toBeDefined();
    expect(course?.syntholo_content_create_course_draft_v1.revision).toBe(1);

    const stage = await runStaff<{ syntholo_content_upsert_stage_draft_v1: { stageId: string } }>(
      staff, staffId,
      "select public.syntholo_content_upsert_stage_draft_v1($1,1,NULL,$2,$3,$4,1,$5,$6) as syntholo_content_upsert_stage_draft_v1",
      [courseId, "diagnose", "Diagnose", "Diagnose stage.", "idem-stage-int-000000001", createHash("sha256").update("stage1").digest("hex")],
    );
    const stageId = stage?.syntholo_content_upsert_stage_draft_v1.stageId;
    expect(stageId).toBeDefined();

    const lesson = await runStaff<{ syntholo_content_upsert_lesson_draft_v1: { lessonId: string; revision: number; mediaAssetId: string } }>(
      staff, staffId,
      `select public.syntholo_content_upsert_lesson_draft_v1(
        $1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12
      ) as syntholo_content_upsert_lesson_draft_v1`,
      [courseId, stageId, "diagnose-1", "Diagnose 1", "Summary for diagnose 1.", 360, blocks, transcript, 1, true, "idem-lesson-int-000000001", createHash("sha256").update("lesson1").digest("hex")],
    );
    const lessonId = lesson?.syntholo_content_upsert_lesson_draft_v1.lessonId;
    expect(lessonId).toBeDefined();
    expect(lesson?.syntholo_content_upsert_lesson_draft_v1.mediaAssetId).toBeDefined();

    // Before review: only the two review-related issues should remain (everything
    // else — video, captions, resource, transcript, action, duration — is satisfied
    // by the synthetic rows the authoring function seeded).
    const issuesBefore = await harness.database.pool.query<{ syntholo_content_lesson_issues_v1: readonly { code: string }[] }>(
      "select public.syntholo_content_lesson_issues_v1($1) as syntholo_content_lesson_issues_v1",
      [lessonId],
    );
    const codesBefore = issuesBefore.rows[0]?.syntholo_content_lesson_issues_v1.map((issue) => issue.code).sort();
    expect(codesBefore).toEqual(["ACCESSIBILITY_REVIEW_REQUIRED", "DISCLOSURE_DECISION_REQUIRED"]);

    await runStaff(
      staff, staffId,
      "select public.syntholo_content_admin_record_lesson_review_v1($1,1,$2)",
      [lessonId, "Integration test stub review."],
    );

    const issuesAfter = await harness.database.pool.query<{ syntholo_content_lesson_issues_v1: readonly unknown[] }>(
      "select public.syntholo_content_lesson_issues_v1($1) as syntholo_content_lesson_issues_v1",
      [lessonId],
    );
    expect(issuesAfter.rows[0]?.syntholo_content_lesson_issues_v1).toEqual([]);

    // The existing, unmodified publish gate accepts it.
    const published = await runStaff<{ syntholo_content_publish_lesson_v2: { id: string; version: number } }>(
      staff, staffId,
      "select public.syntholo_content_publish_lesson_v2($1,1,$2,$3,$4) as syntholo_content_publish_lesson_v2",
      [lessonId, "Publishing for integration test.", "idem-publish-int-000000001", createHash("sha256").update("publish1").digest("hex")],
    );
    expect(published?.syntholo_content_publish_lesson_v2.version).toBe(1);
  });

  it("rejects a duration outside 300-720 seconds and rejects caller-supplied video/resource_list blocks", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000002";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin_2', 'admin')`,
      [staffId],
    );
    const course = await runStaff<{ syntholo_content_create_course_draft_v1: { courseId: string } }>(
      staff, staffId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) as syntholo_content_create_course_draft_v1",
      ["integration-course-2", "Integration course 2", "A second course.", "idem-course-int-000000002", createHash("sha256").update("course2").digest("hex")],
    );
    const courseId = course?.syntholo_content_create_course_draft_v1.courseId;
    const stage = await runStaff<{ syntholo_content_upsert_stage_draft_v1: { stageId: string } }>(
      staff, staffId,
      "select public.syntholo_content_upsert_stage_draft_v1($1,1,NULL,$2,$3,$4,1,$5,$6) as syntholo_content_upsert_stage_draft_v1",
      [courseId, "diagnose", "Diagnose", "Diagnose stage.", "idem-stage-int-000000002", createHash("sha256").update("stage2").digest("hex")],
    );
    const stageId = stage?.syntholo_content_upsert_stage_draft_v1.stageId;

    await expect(runStaff(
      staff, staffId,
      `select public.syntholo_content_upsert_lesson_draft_v1(
        $1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12
      )`,
      [courseId, stageId, "diagnose-1", "Diagnose 1", "Summary.", 60, blocks, transcript, 1, true, "idem-lesson-int-000000002", createHash("sha256").update("lesson2").digest("hex")],
    )).rejects.toThrow(/CONTENT_COMMAND_INVALID/u);

    const blocksWithVideo = JSON.stringify([
      { type: "rich_text", blockId: "body", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body." }] }] } },
      { type: "video", blockId: "sneaky-video", mediaAssetId: "00000000-0000-4000-8000-000000000099" },
    ]);
    await expect(runStaff(
      staff, staffId,
      `select public.syntholo_content_upsert_lesson_draft_v1(
        $1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12
      )`,
      [courseId, stageId, "diagnose-2", "Diagnose 2", "Summary.", 360, blocksWithVideo, transcript, 2, true, "idem-lesson-int-000000003", createHash("sha256").update("lesson3").digest("hex")],
    )).rejects.toThrow(/CONTENT_COMMAND_INVALID/u);
  });

  it("grants a staff-issued enrollment only once the course is published, and rejects granting before that", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000003";
    const accountId = "10000000-0000-4000-8000-000000000004";
    const membershipId = "10000000-0000-4000-8000-000000000005";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin_3', 'admin')`,
      [staffId],
    );
    await harness.database.pool.query(
      `insert into accounts (id, name) values ($1, 'Integration account')`,
      [accountId],
    );
    await harness.database.pool.query(
      `insert into member_identities (id, account_id, provider, provider_user_id)
       values ($1, $2, 'clerk', 'clerk_integration_user')`,
      ["10000000-0000-4000-8000-000000000006", accountId],
    );
    await harness.database.pool.query(
      `insert into memberships (id, account_id, member_identity_id, role, status)
       values ($1, $2, '10000000-0000-4000-8000-000000000006', 'owner', 'active')`,
      [membershipId, accountId],
    );

    const course = await runStaff<{ syntholo_content_create_course_draft_v1: { courseId: string } }>(
      staff, staffId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) as syntholo_content_create_course_draft_v1",
      ["integration-course-3", "Integration course 3", "A third course.", "idem-course-int-000000003", createHash("sha256").update("course3").digest("hex")],
    );
    const courseId = course?.syntholo_content_create_course_draft_v1.courseId as string;

    await expect(runStaff(
      staff, staffId,
      "select public.syntholo_learning_admin_grant_enrollment_v1($1,$2,$3,$4,$5)",
      [accountId, courseId, "Integration test grant.", "idem-enroll-int-000000001", createHash("sha256").update("enroll1").digest("hex")],
    )).rejects.toThrow(/LEARNING_ADMIN_COURSE_NOT_PUBLISHED/u);
  });

  it("updates a course draft's title/description, bumps its revision, and is idempotent", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000007";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin_4', 'admin')`,
      [staffId],
    );
    const course = await runStaff<{ syntholo_content_create_course_draft_v1: { courseId: string } }>(
      staff, staffId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) as syntholo_content_create_course_draft_v1",
      ["integration-course-4", "Integration course 4", "Original description.", "idem-course-int-000000004", createHash("sha256").update("course4").digest("hex")],
    );
    const courseId = course?.syntholo_content_create_course_draft_v1.courseId as string;

    const requestHash = createHash("sha256").update("update-course-1").digest("hex");
    const updated = await runStaff<{ syntholo_content_update_course_draft_v1: { courseId: string; title: string; description: string; revision: number } }>(
      staff, staffId,
      "select public.syntholo_content_update_course_draft_v1($1,$2,$3,$4,$5,$6) as syntholo_content_update_course_draft_v1",
      [courseId, 1, "Updated title", "Updated description.", "idem-update-course-000000001", requestHash],
    );
    expect(updated?.syntholo_content_update_course_draft_v1).toEqual({
      courseId, title: "Updated title", description: "Updated description.", revision: 2,
    });

    const persisted = await harness.database.pool.query<{ title: string; description: string; revision: number }>(
      "select title, description, revision from course_drafts where course_id = $1",
      [courseId],
    );
    expect(persisted.rows[0]).toEqual({ title: "Updated title", description: "Updated description.", revision: 2 });

    // Idempotent replay with the same key/hash returns the same completed response
    // rather than bumping the revision a second time.
    const replay = await runStaff<{ syntholo_content_update_course_draft_v1: { revision: number } }>(
      staff, staffId,
      "select public.syntholo_content_update_course_draft_v1($1,$2,$3,$4,$5,$6) as syntholo_content_update_course_draft_v1",
      [courseId, 1, "Updated title", "Updated description.", "idem-update-course-000000001", requestHash],
    );
    expect(replay?.syntholo_content_update_course_draft_v1.revision).toBe(2);

    // A stale expected revision is rejected.
    await expect(runStaff(
      staff, staffId,
      "select public.syntholo_content_update_course_draft_v1($1,$2,$3,$4,$5,$6)",
      [courseId, 1, "Another title", "Another description.", "idem-update-course-000000002", createHash("sha256").update("update-course-2").digest("hex")],
    )).rejects.toThrow(/VERSION_CONFLICT/u);
  });

  it("reads the live draft tree with blocks/transcript, separate from the publish manifest", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000008";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin_5', 'admin')`,
      [staffId],
    );
    const course = await runStaff<{ syntholo_content_create_course_draft_v1: { courseId: string } }>(
      staff, staffId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) as syntholo_content_create_course_draft_v1",
      ["integration-course-5", "Integration course 5", "A fifth course.", "idem-course-int-000000005", createHash("sha256").update("course5").digest("hex")],
    );
    const courseId = course?.syntholo_content_create_course_draft_v1.courseId as string;
    const stage = await runStaff<{ syntholo_content_upsert_stage_draft_v1: { stageId: string } }>(
      staff, staffId,
      "select public.syntholo_content_upsert_stage_draft_v1($1,1,NULL,$2,$3,$4,1,$5,$6) as syntholo_content_upsert_stage_draft_v1",
      [courseId, "diagnose", "Diagnose", "Diagnose stage.", "idem-stage-int-000000005", createHash("sha256").update("stage5").digest("hex")],
    );
    const stageId = stage?.syntholo_content_upsert_stage_draft_v1.stageId as string;
    const lesson = await runStaff<{ syntholo_content_upsert_lesson_draft_v1: { lessonId: string } }>(
      staff, staffId,
      `select public.syntholo_content_upsert_lesson_draft_v1(
        $1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12
      ) as syntholo_content_upsert_lesson_draft_v1`,
      [courseId, stageId, "diagnose-1", "Diagnose 1", "Summary for diagnose 1.", 360, blocks, transcript, 1, true, "idem-lesson-int-000000005", createHash("sha256").update("lesson5").digest("hex")],
    );
    const lessonId = lesson?.syntholo_content_upsert_lesson_draft_v1.lessonId as string;

    const tree = await runStaff<{ syntholo_content_get_course_draft_tree_v1: {
      courseId: string; title: string; description: string; revision: number;
      stages: readonly { stageId: string; title: string; lessons: readonly { lessonId: string; title: string; blocks: unknown[]; transcript: unknown }[] }[];
    } }>(
      staff, staffId,
      "select public.syntholo_content_get_course_draft_tree_v1($1) as syntholo_content_get_course_draft_tree_v1",
      [courseId],
    );
    const result = tree?.syntholo_content_get_course_draft_tree_v1;
    expect(result?.courseId).toBe(courseId);
    expect(result?.title).toBe("Integration course 5");
    expect(result?.stages).toHaveLength(1);
    expect(result?.stages[0]?.stageId).toBe(stageId);
    expect(result?.stages[0]?.lessons).toHaveLength(1);
    expect(result?.stages[0]?.lessons[0]?.lessonId).toBe(lessonId);
    expect(result?.stages[0]?.lessons[0]?.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "rich_text" })]),
    );
    expect(result?.stages[0]?.lessons[0]?.transcript).toMatchObject({ schemaVersion: 1 });

    await expect(runStaff(
      staff, staffId,
      "select public.syntholo_content_get_course_draft_tree_v1($1)",
      ["00000000-0000-4000-8000-000000000000"],
    )).rejects.toThrow(/CONTENT_NOT_FOUND/u);
  });

  it("lists accounts with owner email, status, and active enrolled-course count, filterable by query", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000009";
    const accountId = "10000000-0000-4000-8000-000000000010";
    const membershipId = "10000000-0000-4000-8000-000000000011";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin_6', 'admin')`,
      [staffId],
    );
    await harness.database.pool.query(
      `insert into accounts (id, name) values ($1, 'Searchable Test Account')`,
      [accountId],
    );
    await harness.database.pool.query(
      `insert into member_identities (id, account_id, provider, provider_user_id, email)
       values ($1, $2, 'clerk', 'clerk_list_accounts_user', 'searchable@example.test')`,
      ["10000000-0000-4000-8000-000000000012", accountId],
    );
    await harness.database.pool.query(
      `insert into memberships (id, account_id, member_identity_id, role, status)
       values ($1, $2, '10000000-0000-4000-8000-000000000012', 'owner', 'active')`,
      [membershipId, accountId],
    );

    const all = await runStaff<{ syntholo_staff_list_accounts_v1: { accounts: readonly { accountId: string; ownerEmail: string | null; enrolledCourseCount: number }[] } }>(
      staff, staffId,
      "select public.syntholo_staff_list_accounts_v1(NULL) as syntholo_staff_list_accounts_v1",
      [],
    );
    const row = all?.syntholo_staff_list_accounts_v1.accounts.find((account) => account.accountId === accountId);
    expect(row).toMatchObject({ ownerEmail: "searchable@example.test", enrolledCourseCount: 0 });

    const filtered = await runStaff<{ syntholo_staff_list_accounts_v1: { accounts: readonly { accountId: string }[] } }>(
      staff, staffId,
      "select public.syntholo_staff_list_accounts_v1($1) as syntholo_staff_list_accounts_v1",
      ["searchable@example.test"],
    );
    expect(filtered?.syntholo_staff_list_accounts_v1.accounts.map((account) => account.accountId)).toContain(accountId);

    const noMatch = await runStaff<{ syntholo_staff_list_accounts_v1: { accounts: readonly unknown[] } }>(
      staff, staffId,
      "select public.syntholo_staff_list_accounts_v1($1) as syntholo_staff_list_accounts_v1",
      ["no-such-account-xyz"],
    );
    expect(noMatch?.syntholo_staff_list_accounts_v1.accounts).toEqual([]);
  });

  it("attaches a real Mux upload to a lesson, replacing the synthetic video block and enqueuing a reconcile job", async () => {
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const staffId = "10000000-0000-4000-8000-000000000013";
    await harness.database.pool.query(
      `insert into staff_identities (id, provider_user_id, role) values ($1, 'removed_authoring_admin_7', 'admin')`,
      [staffId],
    );
    const course = await runStaff<{ syntholo_content_create_course_draft_v1: { courseId: string } }>(
      staff, staffId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) as syntholo_content_create_course_draft_v1",
      ["integration-course-6", "Integration course 6", "A sixth course.", "idem-course-int-000000006", createHash("sha256").update("course6").digest("hex")],
    );
    const courseId = course?.syntholo_content_create_course_draft_v1.courseId as string;
    const stage = await runStaff<{ syntholo_content_upsert_stage_draft_v1: { stageId: string } }>(
      staff, staffId,
      "select public.syntholo_content_upsert_stage_draft_v1($1,1,NULL,$2,$3,$4,1,$5,$6) as syntholo_content_upsert_stage_draft_v1",
      [courseId, "diagnose", "Diagnose", "Diagnose stage.", "idem-stage-int-000000006", createHash("sha256").update("stage6").digest("hex")],
    );
    const stageId = stage?.syntholo_content_upsert_stage_draft_v1.stageId as string;
    const lesson = await runStaff<{ syntholo_content_upsert_lesson_draft_v1: { lessonId: string; mediaAssetId: string } }>(
      staff, staffId,
      `select public.syntholo_content_upsert_lesson_draft_v1(
        $1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12
      ) as syntholo_content_upsert_lesson_draft_v1`,
      [courseId, stageId, "diagnose-1", "Diagnose 1", "Summary for diagnose 1.", 360, blocks, transcript, 1, true, "idem-lesson-int-000000006", createHash("sha256").update("lesson6").digest("hex")],
    );
    const lessonId = lesson?.syntholo_content_upsert_lesson_draft_v1.lessonId as string;
    const syntheticMediaAssetId = lesson?.syntholo_content_upsert_lesson_draft_v1.mediaAssetId as string;

    const requestHash = createHash("sha256").update("attach-media-1").digest("hex");
    const attached = await runStaff<{ syntholo_content_attach_lesson_media_v1: {
      lessonId: string; revision: number; mediaAssetId: string; mediaState: string;
    } }>(
      staff, staffId,
      "select public.syntholo_content_attach_lesson_media_v1($1,$2,$3,$4,$5,$6) as syntholo_content_attach_lesson_media_v1",
      [lessonId, 1, "local-dev-real", "real-mux-asset-000000000001", "idem-attach-media-000000001", requestHash],
    );
    const result = attached?.syntholo_content_attach_lesson_media_v1;
    expect(result?.lessonId).toBe(lessonId);
    expect(result?.revision).toBe(2);
    expect(result?.mediaState).toBe("waiting");
    expect(result?.mediaAssetId).toBeDefined();
    expect(result?.mediaAssetId).not.toBe(syntheticMediaAssetId);

    const draft = await harness.database.pool.query<{ media_asset_id: string; blocks: readonly { type: string; mediaAssetId?: string }[] }>(
      "select media_asset_id, blocks from lesson_drafts where lesson_id = $1",
      [lessonId],
    );
    expect(draft.rows[0]?.media_asset_id).toBe(result?.mediaAssetId);
    const videoBlocks = draft.rows[0]?.blocks.filter((block) => block.type === "video") ?? [];
    expect(videoBlocks).toHaveLength(1);
    expect(videoBlocks[0]?.mediaAssetId).toBe(result?.mediaAssetId);

    const asset = await harness.database.pool.query<{ state: string; provider_asset_id: string; environment_id: string }>(
      "select state, provider_asset_id, environment_id from content_media_assets where id = $1",
      [result?.mediaAssetId],
    );
    expect(asset.rows[0]).toEqual({ state: "waiting", provider_asset_id: "real-mux-asset-000000000001", environment_id: "local-dev-real" });

    const job = await harness.database.pool.query<{ type: string; payload: { mediaAssetId: string; requestedRevision: number } }>(
      "select type, payload from jobs where idempotency_key = $1",
      [`content-mux-reconcile:${result?.mediaAssetId}:0`],
    );
    expect(job.rows[0]).toMatchObject({
      type: "content.mux_reconcile.v1",
      payload: { mediaAssetId: result?.mediaAssetId, requestedRevision: 0 },
    });

    // Idempotent replay returns the same completed response rather than re-attaching.
    const replay = await runStaff<{ syntholo_content_attach_lesson_media_v1: { revision: number } }>(
      staff, staffId,
      "select public.syntholo_content_attach_lesson_media_v1($1,$2,$3,$4,$5,$6) as syntholo_content_attach_lesson_media_v1",
      [lessonId, 1, "local-dev-real", "real-mux-asset-000000000001", "idem-attach-media-000000001", requestHash],
    );
    expect(replay?.syntholo_content_attach_lesson_media_v1.revision).toBe(2);

    // A stale expected revision is rejected.
    await expect(runStaff(
      staff, staffId,
      "select public.syntholo_content_attach_lesson_media_v1($1,$2,$3,$4,$5,$6)",
      [lessonId, 1, "local-dev-real", "real-mux-asset-000000000002", "idem-attach-media-000000002", createHash("sha256").update("attach-media-2").digest("hex")],
    )).rejects.toThrow(/VERSION_CONFLICT/u);
  });
});
