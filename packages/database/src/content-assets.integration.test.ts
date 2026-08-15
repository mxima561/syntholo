import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDatabaseCapability, createDatabase, type Database } from "./client.js";
import { createTestDatabaseHarness, type TestDatabaseHarness } from "../../testing/src/database.js";

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  url.search = "";
  return url.toString();
}

async function roleSql(database: Database, template: string, values: readonly string[]): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ value: string }>(
    `select format($fmt$${template}$fmt$,${parameters}) value`,
    [...values],
  );
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("TEST_ROLE_SQL_FORMAT_FAILED");
  return value;
}

describe("content media closed authority", () => {
  let harness: TestDatabaseHarness;
  let system: Database;
  let staff: Database;
  let worker: Database;
  const systemRole = `syntholo_mux_system_${randomUUID().replaceAll("-", "")}`;
  const staffRole = `syntholo_mux_staff_${randomUUID().replaceAll("-", "")}`;
  const workerRole = `syntholo_mux_worker_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    for (const [role, capability] of [[systemRole, "syntholo_system_api"], [staffRole, "syntholo_staff_api"], [workerRole, "syntholo_worker"]] as const) {
      const password = randomUUID();
      await harness.database.pool.query(await roleSql(harness.database,
        "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
        [role, password],
      ));
      await harness.database.pool.query(await roleSql(harness.database,
        "grant %I to %I with inherit true,set false,admin false", [capability, role],
      ));
      const database = createDatabase({
        applicationName: `syntholo-${capability}-content-assets-test`,
        url: loginUrl(baseUrl, role, password),
      });
      if (capability === "syntholo_system_api") system = database;
      else if (capability === "syntholo_staff_api") staff = database;
      else worker = database;
    }
  });
  beforeEach(async () => harness.reset());
  afterAll(async () => {
    await system?.close();
    await staff?.close();
    await worker?.close();
    if (harness !== undefined) {
      for (const [role, capability] of [[systemRole, "syntholo_system_api"], [staffRole, "syntholo_staff_api"], [workerRole, "syntholo_worker"]] as const) {
        await harness.database.pool.query(await roleSql(harness.database, "revoke %I from %I", [capability, role]));
        await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [role]));
      }
      await harness.close();
    }
  });

  async function apply(input: Readonly<{
    eventId: string;
    type?: string;
    at?: string;
    assetState?: string | null;
    playbackId?: string | null;
  }>) {
    const client = await system.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.actor_kind','system',true),set_config('app.actor_id','mux-webhook',true),set_config('app.correlation_id',$1,true)",
        [randomUUID()],
      );
      const result = await client.query(
        "select * from public.syntholo_mux_apply_event_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        ["env_staging", input.eventId, input.type ?? "video.asset.ready", "env_staging",
          new Date(input.at ?? "2026-08-14T18:00:00.000Z"), "asset_123",
          input.assetState ?? "ready", input.playbackId === undefined ? "playback_123" : input.playbackId,
          480_000, "16:9", null, null, null, null, null, null, null],
      );
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  it("applies, deduplicates, and refuses an older provider state without raw payload storage", async () => {
    await expect(apply({ eventId: "evt_ready" })).resolves.toMatchObject({ outcome: "applied", asset_revision: 1 });
    await expect(apply({ eventId: "evt_ready" })).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(apply({
      eventId: "evt_old_deleted",
      type: "video.asset.deleted",
      assetState: "deleted",
      playbackId: null,
      at: "2026-08-14T17:59:59.000Z",
    })).resolves.toMatchObject({ outcome: "stale", asset_revision: 1 });

    const evidence = await harness.database.pool.query(
      "select a.state,a.readiness_revision,r.status,r.payload from content_media_assets a join provider_event_receipts r on r.provider='mux' and r.provider_event_id='evt_ready'",
    );
    expect(evidence.rows[0]).toMatchObject({
      state: "ready",
      readiness_revision: 1,
      status: "processed",
      payload: {
        environmentId: "env_staging",
        eventType: "video.asset.ready",
        objectId: "asset_123",
        objectKind: "asset",
        outcomeCode: "APPLIED",
      },
    });
  });

  it("records an unknown valid type as receipt-only and requires signed proof before staff import", async () => {
    await expect(apply({
      eventId: "evt_unknown",
      type: "video.asset.static_rendition.ready",
      assetState: null,
      playbackId: null,
    })).resolves.toMatchObject({ outcome: "ignored", media_asset_id: null });
    expect((await harness.database.pool.query("select count(*)::int count from content_media_assets")).rows[0])
      .toEqual({ count: 0 });

    await apply({ eventId: "evt_ready" });
    const staffId = randomUUID();
    await harness.database.pool.query(
      "insert into staff_identities(id,provider_user_id,role) values($1,'workos_mux_staff','admin')",
      [staffId],
    );
    const client = await staff.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.actor_kind','staff',true),set_config('app.actor_id',$1,true),set_config('app.correlation_id',$2,true)",
        [staffId, randomUUID()],
      );
      const imported = await client.query(
        "select (asset).id,(asset).signed_policy_playback_id from (select public.syntholo_content_import_mux_asset_v1('env_staging','asset_123') asset) imported",
      );
      expect(imported.rows[0]?.signed_policy_playback_id).toBe("playback_123");
      await client.query("commit");
    } finally {
      client.release();
    }
  });

  it("denies system raw media reads and rejects unsafe Mux receipt payloads", async () => {
    await expect(system.pool.query("select id from content_media_assets"))
      .rejects.toThrow();
    await expect(harness.database.pool.query(
      "insert into provider_event_receipts(provider,provider_event_id,payload) values('mux','evt_raw',$1::jsonb)",
      [JSON.stringify({ rawBody: { customer: "private" } })],
    )).rejects.toThrow();
  });

  it("attests the actual system login against an exact additive function allowlist", async () => {
    await harness.database.pool.query(
      "create function public.provider_public_helper() returns void language plpgsql as 'begin return; end'",
    );
    try {
      await expect(assertDatabaseCapability(system, "syntholo_system_api")).resolves.toBeUndefined();
      await expect(apply({ eventId: "evt_provider_public" })).resolves.toMatchObject({ outcome: "applied" });
    } finally {
      await harness.database.pool.query("drop function public.provider_public_helper() ");
    }
    await harness.database.pool.query(
      "create function public.syntholo_mux_forbidden_system_extra() returns void language plpgsql as 'begin return; end'",
    );
    await harness.database.pool.query(
      "revoke all on function public.syntholo_mux_forbidden_system_extra() from public",
    );
    await harness.database.pool.query(
      "grant execute on function public.syntholo_mux_forbidden_system_extra() to syntholo_system_api",
    );
    try {
      await expect(assertDatabaseCapability(system, "syntholo_system_api"))
        .rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await expect(apply({ eventId: "evt_extra_acl" })).rejects.toMatchObject({ code: "42501" });
    } finally {
      await harness.database.pool.query(
        "revoke execute on function public.syntholo_mux_forbidden_system_extra() from syntholo_system_api",
      );
    }
    await harness.database.pool.query(
      "grant execute on function public.syntholo_mux_forbidden_system_extra() to public",
    );
    try {
      await expect(assertDatabaseCapability(system, "syntholo_system_api"))
        .rejects.toThrow("DATABASE_CAPABILITY_INVALID");
      await expect(apply({ eventId: "evt_public_syntholo" })).rejects.toMatchObject({ code: "42501" });
    } finally {
      await harness.database.pool.query(
        "revoke execute on function public.syntholo_mux_forbidden_system_extra() from public",
      );
      await harness.database.pool.query(
        "drop function public.syntholo_mux_forbidden_system_extra()",
      );
    }
    await expect(apply({ eventId: "evt_extra_acl" })).resolves.toMatchObject({ outcome: "stale" });
  });

  it("lets only the worker reconcile and validate an exact readiness event through closed commands", async () => {
    const applied = await apply({ eventId: "evt_worker_ready" });
    const target = await worker.pool.query(
      "select * from public.syntholo_content_load_mux_reconcile_target_v1($1,$2)",
      [applied.media_asset_id, applied.asset_revision],
    );
    expect(target.rows[0]).toMatchObject({
      outcome: "current", environment_id: "env_staging", provider_asset_id: "asset_123",
    });
    await expect(worker.pool.query(
      "select outcome from public.syntholo_content_apply_mux_reconciliation_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
      ["mux-webhook", randomUUID(), applied.media_asset_id, applied.asset_revision,
        "env_staging", "asset_123", "ready", "playback_123", 480_000, "16:9",
        JSON.stringify([{ providerTrackId: "track_123", state: "ready", language: "en-US", label: "English", closedCaptions: true, source: "human" }])],
    )).resolves.toMatchObject({ rows: [{ outcome: "applied" }] });
    const evidence = await harness.database.pool.query(
      "select a.readiness_revision,t.state from content_media_assets a join content_media_tracks t on t.media_asset_id=a.id where a.id=$1",
      [applied.media_asset_id],
    );
    expect(evidence.rows[0]).toEqual({ readiness_revision: 2, state: "ready" });
    const staffId = randomUUID();
    const courseId = randomUUID();
    const stageId = randomUUID();
    const lessonId = randomUUID();
    const lessonVersionId = randomUUID();
    const previewId = randomUUID();
    const courseVersionId = randomUUID();
    const accessibilityDecisionId = randomUUID();
    const disclosureDecisionId = randomUUID();
    const contentHash = "a".repeat(64);
    const manifestHash = createHash("sha256").update("{}").digest("hex");
    await harness.database.pool.query(
      "insert into staff_identities(id,provider_user_id,role) values($1,$2,'admin')",
      [staffId, `workos_${staffId}`],
    );
    await harness.database.pool.query(
      "insert into courses(id,slug,title,description) values($1,$2,'Course','Description')",
      [courseId, `course-${courseId.slice(0, 8)}`],
    );
    await harness.database.pool.query(
      "insert into stages(id,course_id,slug) values($1,$2,'stage')",
      [stageId, courseId],
    );
    await harness.database.pool.query(
      "insert into lessons(id,course_id,stage_id,slug) values($1,$2,$3,'lesson')",
      [lessonId, courseId, stageId],
    );
    await harness.database.pool.query(
      "insert into lesson_accessibility_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,reviewer_staff_id,reason) values($1,$2,1,$3,1,'approved',$4,'approved')",
      [accessibilityDecisionId, lessonId, contentHash, staffId],
    );
    await harness.database.pool.query(
      "insert into lesson_disclosure_decisions(id,lesson_id,draft_revision,draft_hash,decision_sequence,decision,policy_version,reviewer_staff_id,reason) values($1,$2,1,$3,1,'not_applicable','v1',$4,'reviewed')",
      [disclosureDecisionId, lessonId, contentHash, staffId],
    );
    await harness.database.pool.query(
      "insert into lesson_versions(id,lesson_id,course_id,stage_id,version,title,summary,duration_seconds,blocks,transcript,media_asset_id,stage_order,\"order\",required,release_rule,accessibility_decision_id,accessibility_decision_sequence,disclosure_decision_id,disclosure_decision_sequence,content_hash,published_by_staff_id,publish_reason) values($1,$2,$3,$4,1,'Lesson','Summary',300,'[{\"type\":\"action\"}]'::jsonb,'{\"schemaVersion\":1,\"blocks\":[{\"id\":\"b1\",\"text\":\"Transcript\"}]}'::jsonb,$5,1,1,true,'{\"kind\":\"immediate\"}'::jsonb,$6,1,$7,1,$8,$9,'published')",
      [lessonVersionId, lessonId, courseId, stageId, applied.media_asset_id,
        accessibilityDecisionId, disclosureDecisionId, contentHash, staffId],
    );
    await harness.database.pool.query(
      "insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason) values($1,$2,1,'{}',$3,'{}'::jsonb,'[]'::jsonb,$4,'preview')",
      [previewId, courseId, manifestHash, staffId],
    );
    await harness.database.pool.query(
      "insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) values($1,$2,1,'Course','Description',$3,$4,$5,'published')",
      [courseVersionId, courseId, manifestHash, previewId, staffId],
    );
    await harness.database.pool.query(
      "insert into course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id,stage_id,stage_title,stage_order,lesson_order,required,release_rule) values($1,$2,$3,$4,$5,'Stage',1,1,true,'{\"kind\":\"immediate\"}'::jsonb)",
      [courseVersionId, courseId, lessonId, lessonVersionId, stageId],
    );
    await harness.database.pool.query(
      "insert into course_heads(course_id,channel,current_course_version_id,manifest_hash,head_revision,set_by_staff_id) values($1,'production',$2,$3,1,$4)",
      [courseId, courseVersionId, manifestHash, staffId],
    );
    const event = await harness.database.pool.query<{ event_id: string }>(
      "select event_id from outbox_events where type='content.media_state_changed.v1' and aggregate_id=$1 order by created_at desc limit 1",
      [applied.media_asset_id],
    );
    await expect(worker.pool.query(
      "select outcome from public.syntholo_content_recompute_readiness_event_v1($1,'content.readiness_recompute')",
      [event.rows[0]?.event_id],
    )).resolves.toMatchObject({ rows: [{ outcome: "evaluated" }] });
    const initialEvaluation = await harness.database.pool.query<{ gate_hash: string; issues: Array<{ code: string }> }>(
      "select gate_hash,issues from content_readiness_evaluations where course_version_id=$1",
      [courseVersionId],
    );
    expect(initialEvaluation.rows[0]?.issues.map(({ code }) => code)).not.toContain("MEDIA_NOT_READY");
    await apply({
      eventId: "evt_worker_errored", type: "video.asset.errored", assetState: "errored",
      playbackId: null, at: "2026-08-14T18:01:00.000Z",
    });
    const erroredEvent = await harness.database.pool.query<{ event_id: string }>(
      "select event_id from outbox_events where type='content.media_state_changed.v1' and aggregate_id=$1 order by created_at desc limit 1",
      [applied.media_asset_id],
    );
    await worker.pool.query(
      "select outcome from public.syntholo_content_recompute_readiness_event_v1($1,'content.readiness_recompute')",
      [erroredEvent.rows[0]?.event_id],
    );
    const evaluations = await harness.database.pool.query<{ gate_hash: string; issues: Array<{ code: string }> }>(
      "select gate_hash,issues from content_readiness_evaluations where course_version_id=$1 order by evaluated_at,gate_hash",
      [courseVersionId],
    );
    expect(evaluations.rows).toHaveLength(2);
    expect(new Set(evaluations.rows.map(({ gate_hash }) => gate_hash)).size).toBe(2);
    expect(evaluations.rows.some(({ issues }) => issues.some(({ code }) => code === "MEDIA_NOT_READY"))).toBe(true);
    await expect(worker.pool.query("select id from content_media_assets")).rejects.toThrow();
  });
});
