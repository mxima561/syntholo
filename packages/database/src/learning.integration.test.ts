import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { createTestDatabaseHarness, type TestDatabaseHarness } from "../../testing/src/database.js";
import { createDatabase, type Database } from "./client.js";

const ids = {
  accountA: "11000000-0000-4000-8000-000000000001",
  accountB: "11000000-0000-4000-8000-000000000002",
  identity: "11000000-0000-4000-8000-000000000003",
  membership: "11000000-0000-4000-8000-000000000004",
  staff: "11000000-0000-4000-8000-000000000005",
  course: "11000000-0000-4000-8000-000000000006",
  stage: "11000000-0000-4000-8000-000000000007",
  lesson: "11000000-0000-4000-8000-000000000008",
  accessibility: "11000000-0000-4000-8000-000000000009",
  disclosure: "11000000-0000-4000-8000-000000000010",
  lessonVersion: "11000000-0000-4000-8000-000000000011",
  preview: "11000000-0000-4000-8000-000000000012",
  courseVersion: "11000000-0000-4000-8000-000000000013",
  source: "11000000-0000-4000-8000-000000000014",
  access: "11000000-0000-4000-8000-000000000015",
  enrollment: "11000000-0000-4000-8000-000000000016",
} as const;

const requiredLessons = Array.from({ length: 18 }, (_, index) => {
  if (index === 0) return { lesson: ids.lesson, version: ids.lessonVersion };
  const suffix = String(index + 1).padStart(12, "0");
  return {
    lesson: `12000000-0000-4000-8000-${suffix}`,
    version: `13000000-0000-4000-8000-${suffix}`,
  };
});

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  url.search = "";
  return url.toString();
}

async function formattedRoleSql(database: Database, template: string, values: readonly string[]): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ value: string }>(
    `select format($fmt$${template}$fmt$, ${parameters}) value`,
    [...values],
  );
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("TEST_ROLE_SQL_FORMAT_FAILED");
  return value;
}

async function seedLearningGraph(database: Database): Promise<void> {
  const manifest = "{}";
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  const contentHash = "a".repeat(64);
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into accounts(id,name) values($1,'Account A'),($2,'Account B')", [ids.accountA, ids.accountB]);
    await client.query("insert into member_identities(id,account_id,provider,provider_user_id) values($1,$2,'clerk','learning-member')", [ids.identity, ids.accountA]);
    await client.query("insert into memberships(id,account_id,member_identity_id,role,status) values($1,$2,$3,'owner','active')", [ids.membership, ids.accountA, ids.identity]);
    await client.query("insert into staff_identities(id,provider_user_id,role) values($1,'learning-staff','admin')", [ids.staff]);
    await client.query("insert into courses(id,slug,title,description) values($1,'academy','Academy','Learning course')", [ids.course]);
    await client.query("insert into stages(id,course_id,slug) values($1,$2,'foundation')", [ids.stage, ids.course]);
    await client.query("insert into lessons(id,course_id,stage_id,slug) values($1,$2,$3,'lesson-one')", [ids.lesson, ids.course, ids.stage]);
    await client.query(
      "insert into lesson_accessibility_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,reviewer_staff_id,reason) values($1,$2,1,$3,1,'approved',$4,'Approved')",
      [ids.accessibility, ids.lesson, contentHash, ids.staff],
    );
    await client.query(
      "insert into lesson_disclosure_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,policy_version,reviewer_staff_id,reason) values($1,$2,1,$3,1,'not_applicable','academy-v1',$4,'Not applicable')",
      [ids.disclosure, ids.lesson, contentHash, ids.staff],
    );
    await client.query(
      `insert into lesson_versions(id,lesson_id,course_id,stage_id,version,title,summary,duration_seconds,blocks,transcript,stage_order,"order",required,release_rule,accessibility_decision_id,accessibility_decision_sequence,disclosure_decision_id,disclosure_decision_sequence,content_hash,published_by_staff_id,publish_reason)
       values($1,$2,$3,$4,1,'Lesson one','Summary',600,'[]','{"schemaVersion":1,"blocks":[{"blockId":"transcript-1","text":"Transcript one"}]}',1,1,true,'{"kind":"immediate"}',$5,1,$6,1,$7,$8,'Published for learning test')`,
      [ids.lessonVersion, ids.lesson, ids.course, ids.stage, ids.accessibility, ids.disclosure, contentHash, ids.staff],
    );
    await client.query(
      "insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason) values($1,$2,1,$3::text,$4,($3::text)::jsonb,'[]',$5,'Learning test preview')",
      [ids.preview, ids.course, manifest, manifestHash, ids.staff],
    );
    await client.query(
      "insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) values($1,$2,1,'Academy','Learning course',$3,$4,$5,'Learning test publication')",
      [ids.courseVersion, ids.course, manifestHash, ids.preview, ids.staff],
    );
    await client.query(
      `insert into course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id,stage_id,stage_title,stage_order,lesson_order,required,release_rule)
       values($1,$2,$3,$4,$5,'Foundation',1,1,true,'{"kind":"immediate"}')`,
      [ids.courseVersion, ids.course, ids.lesson, ids.lessonVersion, ids.stage],
    );
    for (let index = 1; index < requiredLessons.length; index += 1) {
      const lesson = requiredLessons[index];
      if (lesson === undefined) throw new Error("TEST_LESSON_FIXTURE_INVALID");
      const accessibility = `14000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const disclosure = `15000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      await client.query("insert into lessons(id,course_id,stage_id,slug) values($1,$2,$3,$4)", [lesson.lesson, ids.course, ids.stage, `lesson-${index + 1}`]);
      await client.query(
        "insert into lesson_accessibility_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,reviewer_staff_id,reason) values($1,$2,1,$3,1,'approved',$4,'Approved')",
        [accessibility, lesson.lesson, contentHash, ids.staff],
      );
      await client.query(
        "insert into lesson_disclosure_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,policy_version,reviewer_staff_id,reason) values($1,$2,1,$3,1,'not_applicable','academy-v1',$4,'Not applicable')",
        [disclosure, lesson.lesson, contentHash, ids.staff],
      );
      await client.query(
        `insert into lesson_versions(id,lesson_id,course_id,stage_id,version,title,summary,duration_seconds,blocks,transcript,stage_order,"order",required,release_rule,accessibility_decision_id,accessibility_decision_sequence,disclosure_decision_id,disclosure_decision_sequence,content_hash,published_by_staff_id,publish_reason)
         values($1,$2,$3,$4,1,$5,'Summary',600,'[]',$6::jsonb,1,$7,true,'{"kind":"immediate"}',$8,1,$9,1,$10,$11,'Published for learning test')`,
        [lesson.version, lesson.lesson, ids.course, ids.stage, `Lesson ${index + 1}`, JSON.stringify({ schemaVersion: 1, blocks: [{ blockId: `transcript-${index + 1}`, text: `Transcript ${index + 1}` }] }), index + 1, accessibility, disclosure, contentHash, ids.staff],
      );
      await client.query(
        `insert into course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id,stage_id,stage_title,stage_order,lesson_order,required,release_rule)
         values($1,$2,$3,$4,$5,'Foundation',1,$6,true,'{"kind":"immediate"}')`,
        [ids.courseVersion, ids.course, lesson.lesson, lesson.version, ids.stage, index + 1],
      );
    }
    await client.query(
      "insert into entitlement_sources(id,account_id,source_kind,source_id,provenance,created_at) values($1,$2,'administrative','learning-test-source','learning integration',date_trunc('milliseconds',clock_timestamp()))",
      [ids.source, ids.accountA],
    );
    await client.query(
      "insert into account_course_accesses(id,account_id,entitlement_source_id,course_id,course_version_id) values($1,$2,$3,$4,$5)",
      [ids.access, ids.accountA, ids.source, ids.course, ids.courseVersion],
    );
    await client.query(
      "insert into enrollments(id,account_id,account_course_access_id,membership_id,course_id,course_version_id) values($1,$2,$3,$4,$5,$6)",
      [ids.enrollment, ids.accountA, ids.access, ids.membership, ids.course, ids.courseVersion],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setMemberContext(client: PoolClient, actorId: string = ids.identity): Promise<void> {
  await client.query(
    "select set_config('app.account_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.membership_id',$3,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$4,true),set_config('app.actor_role','owner',true),set_config('app.authenticated_at',$5,true)",
    [ids.accountA, actorId, ids.membership, "41000000-0000-4000-8000-000000000001", "2026-08-15T12:00:00.000Z"],
  );
}

async function setStaffContext(client: PoolClient): Promise<void> {
  await client.query(
    "select set_config('app.actor_kind','staff',true),set_config('app.actor_id',$1,true),set_config('app.correlation_id',$2,true)",
    [ids.staff, "41000000-0000-4000-8000-000000000002"],
  );
}

async function seedPublishableLesson(database: Database): Promise<Readonly<{ courseId: string; lessonId: string }>> {
  const courseId = "31000000-0000-4000-8000-000000000001";
  const stageId = "31000000-0000-4000-8000-000000000002";
  const lessonId = "31000000-0000-4000-8000-000000000003";
  const mediaId = "31000000-0000-4000-8000-000000000004";
  const trackId = "31000000-0000-4000-8000-000000000005";
  const resourceId = "31000000-0000-4000-8000-000000000006";
  const accessibilityId = "31000000-0000-4000-8000-000000000007";
  const disclosureId = "31000000-0000-4000-8000-000000000008";
  const contentHash = "b".repeat(64);
  const blocks = JSON.stringify([
    { type: "video", blockId: "video-1", mediaAssetId: mediaId },
    { type: "action", blockId: "action-1", title: "Apply the lesson", instructions: "Write the next implementation step." },
    { type: "resource_list", blockId: "resources-1", resourceIds: [resourceId] },
  ]);
  const transcript = JSON.stringify({ schemaVersion: 1, blocks: [{ blockId: "transcript-1", text: "A complete transcript." }] });
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into staff_identities(id,provider_user_id,role) values($1,'publication-staff','admin')", [ids.staff]);
    await client.query("insert into courses(id,slug,title,description) values($1,'publication-course','Publication course','Publication integration')", [courseId]);
    await client.query("insert into stages(id,course_id,slug) values($1,$2,'diagnose')", [stageId, courseId]);
    await client.query("insert into lessons(id,course_id,stage_id,slug) values($1,$2,$3,'diagnose-1')", [lessonId, courseId, stageId]);
    await client.query(
      "insert into content_media_assets(id,environment_id,provider_asset_id,signed_policy_playback_id,state,duration_milliseconds) values($1,'env-production-test','asset-publication','playback-publication','ready',600000)",
      [mediaId],
    );
    await client.query(
      "insert into content_media_tracks(id,media_asset_id,provider_track_id,language,label,closed_captions,source,state) values($1,$2,'track-publication','en','English',true,'human','ready')",
      [trackId, mediaId],
    );
    await client.query(
      `insert into lesson_drafts(lesson_id,course_id,stage_id,revision,title,summary,duration_seconds,blocks,transcript,media_asset_id,stage_order,"order",required,release_rule,updated_by_staff_id)
       values($1,$2,$3,1,'Diagnose one','A complete summary',600,$4::jsonb,$5::jsonb,$6,1,1,true,'{"kind":"immediate"}',$7)`,
      [lessonId, courseId, stageId, blocks, transcript, mediaId, ids.staff],
    );
    await client.query(
      "insert into content_resource_drafts(id,lesson_id,lesson_draft_revision,revision,label,accessible_label,delivery,delivery_reference,mime,byte_size,content_hash) values($1,$2,1,1,'Worksheet','Download the lesson worksheet','external_https','https://assets.syntholo.com/worksheet.pdf','application/pdf',1024,$3)",
      [resourceId, lessonId, contentHash],
    );
    await client.query("insert into resource_delivery_health(delivery_reference,state) values('https://assets.syntholo.com/worksheet.pdf','ready')");
    const hash = (await client.query<{ hash: string }>("select public.syntholo_lesson_draft_hash_v1($1) hash", [lessonId])).rows[0]?.hash;
    if (hash === undefined) throw new Error("TEST_DRAFT_HASH_MISSING");
    await client.query(
      "insert into lesson_accessibility_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,reviewer_staff_id,reason) values($1,$2,1,$3,1,'approved',$4,'Approved')",
      [accessibilityId, lessonId, hash, ids.staff],
    );
    await client.query(
      "insert into lesson_accessibility_review_heads(lesson_id,decision_sequence,current_decision_id,current_draft_revision,current_draft_hash) values($1,1,$2,1,$3)",
      [lessonId, accessibilityId, hash],
    );
    await client.query(
      "insert into lesson_disclosure_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,policy_version,reviewer_staff_id,reason) values($1,$2,1,$3,1,'not_applicable','academy-v1',$4,'Not applicable')",
      [disclosureId, lessonId, hash, ids.staff],
    );
    await client.query(
      "insert into lesson_disclosure_review_heads(lesson_id,decision_sequence,current_decision_id,current_draft_revision,current_draft_hash) values($1,1,$2,1,$3)",
      [lessonId, disclosureId, hash],
    );
    await client.query("commit");
    return { courseId, lessonId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completePublishableCourse(database: Database, courseId: string): Promise<void> {
  const stageSlugs = ["diagnose", "rules", "growth", "client", "management", "launch"] as const;
  const lessonSlugs = stageSlugs.flatMap((stage) => [1, 2, 3].map((number) => `${stage}-${number}`));
  const firstVersion = await database.pool.query<{ id: string; content_hash: string; stage_id: string }>(
    "select id,content_hash,stage_id from lesson_versions where lesson_id=$1",
    ["31000000-0000-4000-8000-000000000003"],
  );
  const first = firstVersion.rows[0];
  if (first === undefined) throw new Error("TEST_FIRST_LESSON_VERSION_MISSING");
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "insert into course_drafts(course_id,revision,title,description,updated_by_staff_id) values($1,1,'Academy course','A complete production course',$2)",
      [courseId, ids.staff],
    );
    const stageIds: string[] = [first.stage_id];
    for (let stageIndex = 0; stageIndex < stageSlugs.length; stageIndex += 1) {
      const slug = stageSlugs[stageIndex];
      if (slug === undefined) throw new Error("TEST_STAGE_FIXTURE_INVALID");
      const stageId = stageIndex === 0 ? first.stage_id : `32000000-0000-4000-8000-${String(stageIndex + 1).padStart(12, "0")}`;
      if (stageIndex > 0) {
        await client.query("insert into stages(id,course_id,slug) values($1,$2,$3)", [stageId, courseId, slug]);
        stageIds.push(stageId);
      }
      await client.query(
        `insert into stage_drafts(stage_id,course_id,revision,title,description,"order",updated_by_staff_id) values($1,$2,1,$3,$4,$5,$6)`,
        [stageId, courseId, `${slug[0]?.toUpperCase()}${slug.slice(1)}`, `${slug} stage`, stageIndex + 1, ids.staff],
      );
    }
    for (let index = 1; index < lessonSlugs.length; index += 1) {
      const slug = lessonSlugs[index];
      const stageIndex = Math.floor(index / 3);
      const stageId = stageIds[stageIndex];
      if (slug === undefined || stageId === undefined) throw new Error("TEST_COURSE_FIXTURE_INVALID");
      const suffix = String(index + 1).padStart(12, "0");
      const lessonId = `33000000-0000-4000-8000-${suffix}`;
      const versionId = `34000000-0000-4000-8000-${suffix}`;
      const mediaId = `35000000-0000-4000-8000-${suffix}`;
      const trackId = `36000000-0000-4000-8000-${suffix}`;
      const resourceId = `37000000-0000-4000-8000-${suffix}`;
      const accessibilityId = `38000000-0000-4000-8000-${suffix}`;
      const disclosureId = `39000000-0000-4000-8000-${suffix}`;
      const contentHash = createHash("sha256").update(`lesson:${index + 1}`).digest("hex");
      const delivery = `https://assets.syntholo.com/resource-${index + 1}.pdf`;
      await client.query("insert into lessons(id,course_id,stage_id,slug) values($1,$2,$3,$4)", [lessonId, courseId, stageId, slug]);
      await client.query(
        "insert into content_media_assets(id,environment_id,provider_asset_id,signed_policy_playback_id,state,duration_milliseconds) values($1,'env-production-test',$2,$3,'ready',600000)",
        [mediaId, `asset-${index + 1}`, `playback-${index + 1}`],
      );
      await client.query(
        "insert into content_media_tracks(id,media_asset_id,provider_track_id,language,label,closed_captions,source,state) values($1,$2,$3,'en','English',true,'human','ready')",
        [trackId, mediaId, `track-${index + 1}`],
      );
      await client.query(
        "insert into lesson_accessibility_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,reviewer_staff_id,reason) values($1,$2,1,$3,1,'approved',$4,'Approved')",
        [accessibilityId, lessonId, contentHash, ids.staff],
      );
      await client.query(
        "insert into lesson_disclosure_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,policy_version,reviewer_staff_id,reason) values($1,$2,1,$3,1,'not_applicable','academy-v1',$4,'Not applicable')",
        [disclosureId, lessonId, contentHash, ids.staff],
      );
      await client.query(
        `insert into lesson_versions(id,lesson_id,course_id,stage_id,version,title,summary,duration_seconds,blocks,transcript,media_asset_id,stage_order,"order",required,release_rule,accessibility_decision_id,accessibility_decision_sequence,disclosure_decision_id,disclosure_decision_sequence,content_hash,published_by_staff_id,publish_reason)
         values($1,$2,$3,$4,1,$5,'Summary',600,'[]','{"schemaVersion":1,"blocks":[]}',$6,$7,$8,true,'{"kind":"immediate"}',$9,1,$10,1,$11,$12,'Published fixture')`,
        [versionId, lessonId, courseId, stageId, `Lesson ${index + 1}`, mediaId, stageIndex + 1, index + 1, accessibilityId, disclosureId, contentHash, ids.staff],
      );
      await client.query(
        "insert into content_resource_drafts(id,lesson_id,lesson_draft_revision,revision,label,accessible_label,delivery,delivery_reference,mime,byte_size,content_hash) values($1,$2,1,1,'Worksheet','Download worksheet','external_https',$3,'application/pdf',1024,$4)",
        [resourceId, lessonId, delivery, contentHash],
      );
      await client.query("insert into resource_delivery_health(delivery_reference,state) values($1,'ready')", [delivery]);
      await client.query(
        "insert into lesson_version_resources(lesson_version_id,resource_id,\"order\",label,accessible_label,delivery,delivery_reference,mime,byte_size,content_hash) values($1,$2,1,'Worksheet','Download worksheet','external_https',$3,'application/pdf',1024,$4)",
        [versionId, resourceId, delivery, contentHash],
      );
      await client.query(
        `insert into course_draft_manifest_entries(course_id,course_draft_revision,stage_id,stage_order,lesson_id,lesson_order,required,release_rule,selected_lesson_version_id,selected_lesson_version_hash)
         values($1,1,$2,$3,$4,$5,true,'{"kind":"immediate"}',$6,$7)`,
        [courseId, stageId, stageIndex + 1, lessonId, index + 1, versionId, contentHash],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("0011 learning authority", () => {
  let harness: TestDatabaseHarness;
  let member: Database | undefined;
  let staff: Database | undefined;
  const memberRole = `syntholo_learning_member_${randomUUID().replaceAll("-", "")}`;
  const staffRole = `syntholo_learning_staff_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const password = randomUUID();
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      [memberRole, password],
    ));
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "grant syntholo_member_api to %I with inherit true, set false, admin false",
      [memberRole],
    ));
    member = createDatabase({
      applicationName: "syntholo-learning-member-integration",
      url: loginUrl(baseUrl, memberRole, password),
    });
    const staffPassword = randomUUID();
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
      [staffRole, staffPassword],
    ));
    await harness.database.pool.query(await formattedRoleSql(
      harness.database,
      "grant syntholo_staff_api to %I with inherit true, set false, admin false",
      [staffRole],
    ));
    staff = createDatabase({ applicationName: "syntholo-learning-staff-integration", url: loginUrl(baseUrl, staffRole, staffPassword) });
  });

  beforeEach(async () => harness.reset());

  afterAll(async () => {
    await member?.close();
    await staff?.close();
    if (harness !== undefined) {
      await harness.database.pool.query(await formattedRoleSql(harness.database, "revoke syntholo_member_api from %I", [memberRole]));
      await harness.database.pool.query(await formattedRoleSql(harness.database, "drop role if exists %I", [memberRole]));
      await harness.database.pool.query(await formattedRoleSql(harness.database, "revoke syntholo_staff_api from %I", [staffRole]));
      await harness.database.pool.query(await formattedRoleSql(harness.database, "drop role if exists %I", [staffRole]));
      await harness.close();
    }
  });

  it("attests exact learning structure, policies, triggers, ACLs, and functions", async () => {
    const ready = await harness.database.pool.query(
      "select learning_contract_version,learning_migration_hash,learning_table_ready,learning_structure_ready,learning_immutability_ready,learning_rls_ready,learning_acl_ready,learning_function_ready,learning_public_execute_denied from public.syntholo_content_readiness_v1()",
    );
    expect(ready.rows[0]).toEqual({
      learning_acl_ready: true,
      learning_contract_version: "0011_learning.v1",
      learning_function_ready: true,
      learning_immutability_ready: true,
      learning_migration_hash: "2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf",
      learning_public_execute_denied: true,
      learning_rls_ready: true,
      learning_structure_ready: true,
      learning_table_ready: true,
    });
  });

  it("publishes a lesson once and replays the exact staff receipt representation", async () => {
    const fixture = await seedPublishableLesson(harness.database);
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const key = "lesson-publication-replay-0001";
    const hash = createHash("sha256").update(key).digest("hex");
    const client = await staff.pool.connect();
    try {
      await client.query("begin");
      await setStaffContext(client);
      const first = await client.query<{ result: unknown }>(
        "select public.syntholo_content_publish_lesson_v2($1,1,'Publish lesson',$2,$3) result",
        [fixture.lessonId, key, hash],
      );
      await client.query("commit");
      await client.query("begin");
      await setStaffContext(client);
      const replay = await client.query<{ result: unknown }>(
        "select public.syntholo_content_publish_lesson_v2($1,1,'Publish lesson',$2,$3) result",
        [fixture.lessonId, key, hash],
      );
      expect(replay.rows[0]?.result).toEqual(first.rows[0]?.result);
      await client.query("commit");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    const facts = await harness.database.pool.query(
      `select
        (select count(*)::int from lesson_versions where lesson_id=$1) versions,
        (select count(*)::int from api_command_receipts where route_template='/v1/staff/content/lessons/:lessonId/publications') receipts,
        (select count(*)::int from outbox_events where type='content.lesson_published.v1') events`,
      [fixture.lessonId],
    );
    expect(facts.rows[0]).toEqual({ events: 1, receipts: 1, versions: 1 });
  });

  it("publishes an exact 18-lesson course once and replays its staff receipt", async () => {
    const fixture = await seedPublishableLesson(harness.database);
    if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
    const client = await staff.pool.connect();
    try {
      await client.query("begin");
      await setStaffContext(client);
      const lessonKey = "course-fixture-lesson-publish-01";
      await client.query(
        "select public.syntholo_content_publish_lesson_v2($1,1,'Publish first lesson',$2,$3)",
        [fixture.lessonId, lessonKey, createHash("sha256").update(lessonKey).digest("hex")],
      );
      await client.query("commit");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    await completePublishableCourse(harness.database, fixture.courseId);

    const countsBeforeGet = await harness.database.pool.query(
      "select (select count(*)::int from content_previews) previews,(select count(*)::int from api_command_receipts) receipts,(select count(*)::int from audit_events) audits,(select count(*)::int from outbox_events) events",
    );
    const read = await staff.pool.connect();
    try {
      await read.query("begin read only");
      await setStaffContext(read);
      const derived = await read.query<{ result: unknown }>(
        "select public.syntholo_content_get_preview_v1($1,1) result",
        [fixture.courseId],
      );
      expect(derived.rows[0]?.result).toMatchObject({ draftRevision: 1, candidateManifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u), publicationIssues: [] });
      expect(derived.rows[0]?.result).not.toHaveProperty("previewId");
      await read.query("commit");
    } finally {
      await read.query("rollback").catch(() => undefined);
      read.release();
    }
    const staleRead = await staff.pool.connect();
    try {
      await staleRead.query("begin read only");
      await setStaffContext(staleRead);
      await expect(staleRead.query(
        "select public.syntholo_content_get_preview_v1($1,2)",
        [fixture.courseId],
      )).rejects.toThrow("CONTENT_NOT_FOUND");
      await staleRead.query("rollback");
    } finally {
      await staleRead.query("rollback").catch(() => undefined);
      staleRead.release();
    }
    const countsAfterGet = await harness.database.pool.query(
      "select (select count(*)::int from content_previews) previews,(select count(*)::int from api_command_receipts) receipts,(select count(*)::int from audit_events) audits,(select count(*)::int from outbox_events) events",
    );
    expect(countsAfterGet.rows[0]).toEqual(countsBeforeGet.rows[0]);

    const previewKey = "course-preview-materialize-0001";
    const previewRequestHash = createHash("sha256").update(JSON.stringify({
      courseId: fixture.courseId, expectedVersion: 1, reason: "Materialize course",
    })).digest("hex");
    async function materialize(): Promise<unknown> {
      if (staff === undefined) throw new Error("TEST_STAFF_DATABASE_REQUIRED");
      const client = await staff.pool.connect();
      try {
        await client.query("begin");
        await setStaffContext(client);
        const result = await client.query<{ result: unknown }>(
          "select public.syntholo_content_create_preview_v3($1,1,'Materialize course',$2,$3) result",
          [fixture.courseId, previewKey, previewRequestHash],
        );
        await client.query("commit");
        return result.rows[0]?.result;
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    }
    const raced = await Promise.all([materialize(), materialize()]);
    expect(raced[1]).toEqual(raced[0]);
    const replayed = await materialize();
    expect(replayed).toEqual(raced[0]);
    const materialized = raced[0] as { previewId?: unknown; manifestHash?: unknown } | undefined;
    if (typeof materialized?.previewId !== "string" || typeof materialized.manifestHash !== "string") throw new Error("TEST_PREVIEW_MISSING");

    const conflict = await staff.pool.connect();
    try {
      await conflict.query("begin");
      await setStaffContext(conflict);
      await expect(conflict.query(
        "select public.syntholo_content_create_preview_v3($1,1,'Changed reason',$2,$3)",
        [fixture.courseId, previewKey, createHash("sha256").update("changed").digest("hex")],
      )).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
      await conflict.query("rollback");
    } finally {
      await conflict.query("rollback").catch(() => undefined);
      conflict.release();
    }
    const inFlightKey = "course-preview-in-flight-0001";
    const inFlightHash = createHash("sha256").update("in-flight").digest("hex");
    await harness.database.pool.query(
      "insert into api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,created_at,expires_at) values('staff',$1,'POST','/v1/staff/content/courses/:courseId/previews',$2,$3,'in_progress',clock_timestamp(),clock_timestamp()+interval '31 days')",
      [ids.staff, inFlightKey, inFlightHash],
    );
    const inFlight = await staff.pool.connect();
    try {
      await inFlight.query("begin");
      await setStaffContext(inFlight);
      await expect(inFlight.query(
        "select public.syntholo_content_create_preview_v3($1,1,'Materialize course',$2,$3)",
        [fixture.courseId, inFlightKey, inFlightHash],
      )).rejects.toThrow("IDEMPOTENCY_IN_PROGRESS");
      await inFlight.query("rollback");
    } finally {
      await inFlight.query("rollback").catch(() => undefined);
      inFlight.release();
    }
    await harness.database.pool.query(
      "delete from api_command_receipts where principal_kind='staff' and principal_id=$1 and method='POST' and route_template='/v1/staff/content/courses/:courseId/previews' and idempotency_key=$2",
      [ids.staff, inFlightKey],
    );

    const publish = await staff.pool.connect();
    try {
      await publish.query("begin");
      await setStaffContext(publish);
      const key = "course-publication-replay-0001";
      const hash = createHash("sha256").update(key).digest("hex");
      const first = await publish.query<{ result: unknown }>(
        "select public.syntholo_content_publish_course_v2($1,$2,0,'Publish course',$3,$4) result",
        [materialized.previewId, materialized.manifestHash, key, hash],
      );
      await publish.query("commit");
      await publish.query("begin");
      await setStaffContext(publish);
      const replay = await publish.query<{ result: unknown }>(
        "select public.syntholo_content_publish_course_v2($1,$2,0,'Publish course',$3,$4) result",
        [materialized.previewId, materialized.manifestHash, key, hash],
      );
      expect(replay.rows[0]?.result).toEqual(first.rows[0]?.result);
      await publish.query("commit");
    } finally {
      await publish.query("rollback").catch(() => undefined);
      publish.release();
    }
    const facts = await harness.database.pool.query(
      `select
        (select count(*)::int from course_versions where course_id=$1) versions,
        (select count(*)::int from course_version_lessons cvl join course_versions cv on cv.id=cvl.course_version_id where cv.course_id=$1) lessons,
        (select count(*)::int from content_previews where course_id=$1) previews,
        (select count(*)::int from api_command_receipts where route_template='/v1/staff/content/courses/:courseId/previews') preview_receipts,
        (select count(*)::int from audit_events where action='content_preview_materialized' and target_id=$1::text) preview_audits,
        (select count(*)::int from api_command_receipts where route_template='/v1/staff/content/courses/:courseId/publications') receipts,
        (select count(*)::int from outbox_events where type='content.course_published.v1') events`,
      [fixture.courseId],
    );
    expect(facts.rows[0]).toEqual({ events: 1, lessons: 18, preview_audits: 1, preview_receipts: 1, previews: 1, receipts: 1, versions: 1 });
  }, 15_000);

  it("fails readiness closed for widened policy, disabled identity trigger, or missing ownership constraint", async () => {
    const client = await harness.database.pool.connect();
    try {
      await client.query("begin");
      await client.query("alter policy enrollments_member_read on public.enrollments using(true)");
      expect((await client.query("select learning_rls_ready from public.syntholo_content_readiness_v1()")).rows[0]).toEqual({ learning_rls_ready: false });
      await client.query("rollback");

      await client.query("begin");
      await client.query("alter table public.enrollments disable trigger enrollments_identity_immutable");
      expect((await client.query("select learning_immutability_ready from public.syntholo_content_readiness_v1()")).rows[0]).toEqual({ learning_immutability_ready: false });
      await client.query("rollback");

      await client.query("begin");
      await client.query("alter table public.account_course_accesses drop constraint account_course_accesses_source_account_fk");
      expect((await client.query("select learning_structure_ready from public.syntholo_content_readiness_v1()")).rows[0]).toEqual({ learning_structure_ready: false });
      await client.query("rollback");

      await client.query("begin");
      await client.query("create schema learning_shadow");
      await client.query("create table learning_shadow.accounts(id uuid primary key)");
      await client.query("create table learning_shadow.sources(id uuid,account_id uuid,unique(id,account_id))");
      await client.query("create table learning_shadow.account_course_accesses(entitlement_source_id uuid,account_id uuid,constraint account_course_accesses_source_account_fk foreign key(entitlement_source_id,account_id) references learning_shadow.sources(id,account_id))");
      await client.query("alter table public.account_course_accesses drop constraint account_course_accesses_source_account_fk");
      expect((await client.query("select learning_structure_ready from public.syntholo_content_readiness_v1()")).rows[0]).toEqual({ learning_structure_ready: false });
      await client.query("rollback");

      await client.query("begin");
      await client.query("alter table public.lesson_progress drop constraint lesson_progress_position_check");
      await client.query(`alter table public.lesson_progress add constraint lesson_progress_position_check check(
        (last_path='video' and video_seconds between 0 and 86400) or transcript_block_id is null or
        (last_path='transcript' and video_seconds is null and octet_length(transcript_block_id) between 1 and 128)
      )`);
      expect((await client.query("select learning_structure_ready from public.syntholo_content_readiness_v1()")).rows[0]).toEqual({ learning_structure_ready: false });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("rejects an entitlement source owned by another account", async () => {
    await seedLearningGraph(harness.database);
    await expect(harness.database.pool.query(
      "insert into account_course_accesses(account_id,entitlement_source_id,course_id,course_version_id) values($1,$2,$3,$4)",
      [ids.accountB, ids.source, ids.course, ids.courseVersion],
    )).rejects.toMatchObject({ constraint: "account_course_accesses_source_account_fk" });
  });

  it("rejects a mismatched member identity inside the closed course read", async () => {
    await seedLearningGraph(harness.database);
    if (member === undefined) throw new Error("TEST_MEMBER_DATABASE_REQUIRED");
    const client = await member.pool.connect();
    try {
      await client.query("begin");
      await setMemberContext(client, "11000000-0000-4000-8000-000000000099");
      await expect(client.query("select public.syntholo_learning_get_course_v1($1)", [ids.course]))
        .rejects.toMatchObject({ message: expect.stringContaining("ACADEMY_ENROLLMENT_MISSING") });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("keeps an enrollment pinned to version one after a later course version is published", async () => {
    await seedLearningGraph(harness.database);
    const manifest = '{"v":2}';
    const hash = createHash("sha256").update(manifest).digest("hex");
    const preview = "21000000-0000-4000-8000-000000000001";
    const version = "21000000-0000-4000-8000-000000000002";
    await harness.database.pool.query(
      "insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason) values($1,$2,2,$3::text,$4,($3::text)::jsonb,'[]',$5,'Version two preview')",
      [preview, ids.course, manifest, hash, ids.staff],
    );
    await harness.database.pool.query(
      "insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) values($1,$2,2,'Academy v2','Later draft',$3,$4,$5,'Version two')",
      [version, ids.course, hash, preview, ids.staff],
    );

    if (member === undefined) throw new Error("TEST_MEMBER_DATABASE_REQUIRED");
    const client = await member.pool.connect();
    try {
      await client.query("begin");
      await setMemberContext(client);
      const result = await client.query<{ result: { course: { versionId: string; title: string } } }>(
        "select public.syntholo_learning_get_course_v1($1) result",
        [ids.course],
      );
      expect(result.rows[0]?.result.course).toMatchObject({ versionId: ids.courseVersion, title: "Academy" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("makes transcript resume replay unchanged and rejects a stale different representation", async () => {
    await seedLearningGraph(harness.database);
    if (member === undefined) throw new Error("TEST_MEMBER_DATABASE_REQUIRED");
    const client = await member.pool.connect();
    try {
      await client.query("begin");
      await setMemberContext(client);
      const first = await client.query<{ result: unknown }>(
        "select public.syntholo_learning_resume_lesson_v1($1,0,'transcript',null,'transcript-1') result",
        [ids.lesson],
      );
      const replay = await client.query<{ result: unknown }>(
        "select public.syntholo_learning_resume_lesson_v1($1,0,'transcript',null,'transcript-1') result",
        [ids.lesson],
      );
      expect(first.rows[0]?.result).toEqual({
        lastPath: "transcript", position: { blockId: "transcript-1" }, revision: 1, state: "in_progress",
      });
      expect(replay.rows[0]?.result).toEqual(first.rows[0]?.result);
      await client.query("commit");

      await client.query("begin");
      await setMemberContext(client);
      await expect(client.query(
        "select public.syntholo_learning_resume_lesson_v1($1,0,'video',10,null)",
        [ids.lesson],
      )).rejects.toMatchObject({ message: expect.stringContaining("VERSION_CONFLICT") });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("creates no course fact at 17 of 18 and exactly one fact and event at 18 of 18", async () => {
    await seedLearningGraph(harness.database);
    if (member === undefined) throw new Error("TEST_MEMBER_DATABASE_REQUIRED");
    const client = await member.pool.connect();
    try {
      await client.query("begin");
      await setMemberContext(client);
      for (let index = 0; index < 17; index += 1) {
        const lesson = requiredLessons[index];
        if (lesson === undefined) throw new Error("TEST_LESSON_FIXTURE_INVALID");
        const key = `learning-complete-required-${String(index + 1).padStart(2, "0")}`;
        const hash = createHash("sha256").update(key).digest("hex");
        await client.query(
          "select public.syntholo_learning_complete_lesson_v1($1,'transcript',$2,$3)",
          [lesson.lesson, key, hash],
        );
      }
      expect((await client.query("select count(*)::int count from course_completions")).rows[0]).toEqual({ count: 0 });
      await client.query("commit");
      const beforeFinal = await harness.database.pool.query(
        `select
          (select count(*)::int from lesson_completions) lessons,
          (select count(*)::int from course_completions) courses,
          (select count(*)::int from outbox_events where type='learning.course_completed.v1') events`,
      );
      expect(beforeFinal.rows[0]).toEqual({ courses: 0, events: 0, lessons: 17 });

      const last = requiredLessons[17];
      if (last === undefined) throw new Error("TEST_LESSON_FIXTURE_INVALID");
      const key = "learning-complete-required-18";
      const hash = createHash("sha256").update(key).digest("hex");
      await client.query("begin");
      await setMemberContext(client);
      const completed = await client.query<{ result: unknown }>(
        "select public.syntholo_learning_complete_lesson_v1($1,'transcript',$2,$3) result",
        [last.lesson, key, hash],
      );
      const replay = await client.query<{ result: unknown }>(
        "select public.syntholo_learning_complete_lesson_v1($1,'transcript',$2,$3) result",
        [last.lesson, key, hash],
      );
      expect(completed.rows[0]?.result).toEqual(replay.rows[0]?.result);
      expect(completed.rows[0]?.result).toMatchObject({ courseCompletion: { courseVersionId: ids.courseVersion } });
      await client.query("commit");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }

    const facts = await harness.database.pool.query(
      `select
        (select count(*)::int from lesson_completions) lessons,
        (select count(*)::int from course_completions) courses,
        (select count(*)::int from outbox_events where type='learning.course_completed.v1') events`,
    );
    expect(facts.rows[0]).toEqual({ courses: 1, events: 1, lessons: 18 });
  });

  it.each(["access", "enrollment"] as const)("refuses a completed receipt replay after %s revocation", async (kind) => {
    await seedLearningGraph(harness.database);
    if (member === undefined) throw new Error("TEST_MEMBER_DATABASE_REQUIRED");
    const idempotencyKey = `learning-complete-${kind}-0001`;
    const requestHash = createHash("sha256").update(`complete:${kind}`).digest("hex");
    const first = await member.pool.connect();
    try {
      await first.query("begin");
      await setMemberContext(first);
      await expect(first.query(
        "select public.syntholo_learning_complete_lesson_v1($1,'transcript',$2,$3) result",
        [ids.lesson, idempotencyKey, requestHash],
      )).resolves.toMatchObject({ rows: [{ result: expect.objectContaining({ schemaVersion: 1 }) }] });
      await first.query("commit");
    } finally {
      await first.query("rollback").catch(() => undefined);
      first.release();
    }

    if (kind === "access") {
      await harness.database.pool.query("update account_course_accesses set status='revoked' where id=$1", [ids.access]);
    } else {
      await harness.database.pool.query(
        "update enrollments set status='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()) where id=$1",
        [ids.enrollment],
      );
    }

    const replay = await member.pool.connect();
    try {
      await replay.query("begin");
      await setMemberContext(replay);
      await expect(replay.query(
        "select public.syntholo_learning_complete_lesson_v1($1,'transcript',$2,$3)",
        [ids.lesson, idempotencyKey, requestHash],
      )).rejects.toMatchObject({ message: expect.stringContaining("LEARNING_LESSON_NOT_FOUND") });
    } finally {
      await replay.query("rollback").catch(() => undefined);
      replay.release();
    }
  });
});
