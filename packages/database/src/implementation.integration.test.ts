import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeArtifactContent } from "@syntholo/domain/implementation";
import type { ArtifactContent, ArtifactState } from "@syntholo/contracts/implementation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { createTestDatabaseHarness, type TestDatabaseHarness } from "../../testing/src/database.js";
import { createDatabase, type Database } from "./client.js";
import { migrateDatabase } from "./migrations.js";

type Actor = Readonly<{ accountId: string; identityId: string; membershipId: string }>;
type SaveResult = Readonly<{
  artifact: Readonly<{ currentVersion: number }>;
  content: ArtifactContent;
  implementationCompletion: Readonly<{ completed: boolean; completedAt: string | null }>;
  version: Readonly<{ id: string; version: number }>;
}>;

const ids = {
  accountA: randomUUID(), accountB: randomUUID(), identityA: randomUUID(), identityB: randomUUID(),
  teammateIdentity: randomUUID(), membershipA: randomUUID(), membershipB: randomUUID(), teammateMembership: randomUUID(),
  staff: randomUUID(), course: randomUUID(), preview: randomUUID(), courseVersion: randomUUID(), source: randomUUID(),
  access: randomUUID(), enrollmentA: randomUUID(), teammateEnrollment: randomUUID(), courseCompletion: randomUUID(),
  teammateCourseCompletion: randomUUID(),
} as const;
const actorA: Actor = { accountId: ids.accountA, identityId: ids.identityA, membershipId: ids.membershipA };
const actorB: Actor = { accountId: ids.accountB, identityId: ids.identityB, membershipId: ids.membershipB };
const teammate: Actor = { accountId: ids.accountA, identityId: ids.teammateIdentity, membershipId: ids.teammateMembership };

function loginUrl(baseUrl: string, roleName: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function roleSql(database: Database, template: string, values: readonly string[]): Promise<string> {
  const parameters = values.map((_, index) => `$${index + 1}::text`).join(",");
  const result = await database.pool.query<{ statement: string }>(
    `select format($fmt$${template}$fmt$,${parameters}) statement`, [...values],
  );
  const statement = result.rows[0]?.statement;
  if (statement === undefined) throw new Error("IMPLEMENTATION_TEST_ROLE_SQL_FAILED");
  return statement;
}

async function setMemberContext(client: PoolClient, actor: Actor): Promise<void> {
  await client.query(
    "select set_config('app.account_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.membership_id',$3,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$4,true),set_config('app.actor_role','owner',true),set_config('app.authenticated_at',$5,true)",
    [actor.accountId, actor.identityId, actor.membershipId, randomUUID(), "2026-08-15T12:00:00.000Z"],
  );
}

async function memberQuery<T extends QueryResultRow>(
  database: Database, actor: Actor, text: string, values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await setMemberContext(client, actor);
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

async function systemSeed(database: Database, accessId: string = ids.access): Promise<string> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.actor_kind','system',true),set_config('app.actor_id','implementation-integration',true),set_config('app.correlation_id',$1,true)",
      [randomUUID()],
    );
    const result = await client.query<{ result: string }>(
      "select public.syntholo_implementation_seed_workspace_v1($1) result", [accessId],
    );
    await client.query("commit");
    return result.rows[0]?.result ?? "missing";
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function save(
  database: Database,
  actor: Actor,
  artifactId: string,
  expectedVersion: number,
  state: ArtifactState,
  content: ArtifactContent,
  key = `impl-${randomUUID()}`,
): Promise<SaveResult> {
  const requestHash = canonicalizeArtifactContent({ artifactId, expectedVersion, state, content }).hash;
  const rows = await memberQuery<{ result: SaveResult }>(database, actor,
    "select public.syntholo_implementation_save_version_v1($1,$2,$3,$4::jsonb,$5,$6) result",
    [artifactId, expectedVersion, state, JSON.stringify(content), key, requestHash],
  );
  const result = rows[0]?.result;
  if (result === undefined) throw new Error("IMPLEMENTATION_TEST_SAVE_RESULT_MISSING");
  return result;
}

async function seedGraph(database: Database): Promise<void> {
  const manifest = "{}";
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  const suffix = randomUUID().replaceAll("-", "");
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into accounts(id,name) values($1,'Implementation Account A'),($2,'Implementation Account B')", [ids.accountA, ids.accountB]);
    await client.query(
      "insert into member_identities(id,account_id,provider,provider_user_id) values($1,$2,'clerk',$3),($4,$5,'clerk',$6),($7,$2,'clerk',$8)",
      [ids.identityA, ids.accountA, `impl-a-${suffix}`, ids.identityB, ids.accountB, `impl-b-${suffix}`, ids.teammateIdentity, `impl-team-${suffix}`],
    );
    await client.query(
      "insert into memberships(id,account_id,member_identity_id,role,status) values($1,$2,$3,'owner','active'),($4,$5,$6,'owner','active'),($7,$2,$8,'teammate','active')",
      [ids.membershipA, ids.accountA, ids.identityA, ids.membershipB, ids.accountB, ids.identityB, ids.teammateMembership, ids.teammateIdentity],
    );
    await client.query("insert into staff_identities(id,provider_user_id,role) values($1,$2,'admin')", [ids.staff, `impl-staff-${suffix}`]);
    await client.query("insert into courses(id,slug,title,description) values($1,$2,'Implementation Academy','Implementation integration')", [ids.course, `implementation-${suffix}`]);
    await client.query(
      "insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason) values($1,$2,1,$3::text,$4,($3::text)::jsonb,'[]',$5,'Implementation integration')",
      [ids.preview, ids.course, manifest, manifestHash, ids.staff],
    );
    await client.query(
      "insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) values($1,$2,1,'Implementation Academy','Implementation integration',$3,$4,$5,'Implementation integration')",
      [ids.courseVersion, ids.course, manifestHash, ids.preview, ids.staff],
    );
    await client.query(
      "insert into entitlement_sources(id,account_id,source_kind,source_id,offer_code,provenance,created_at) values($1,$2,'purchase',$3,'self_paced','implementation integration',date_trunc('milliseconds',clock_timestamp()))",
      [ids.source, ids.accountA, `impl-source-${suffix}`],
    );
    await client.query(
      `insert into entitlement_grants(account_id,source_registry_id,source_kind,source_id,offer_code,capability,status,starts_at,ends_at,provenance,created_at,updated_at) values
       ($1,$2,'purchase',$3,'self_paced','academy_course','active','2026-08-15T12:00:00.000Z',null,'implementation integration','2026-08-15T12:00:00.000Z','2026-08-15T12:00:00.000Z'),
       ($1,$2,'purchase',$3,'self_paced','support','active','2026-08-15T12:00:00.000Z','2027-08-15T12:00:00.000Z','implementation integration','2026-08-15T12:00:00.000Z','2026-08-15T12:00:00.000Z'),
       ($1,$2,'purchase',$3,'self_paced','circle_write','active','2026-08-15T12:00:00.000Z','2027-08-15T12:00:00.000Z','implementation integration','2026-08-15T12:00:00.000Z','2026-08-15T12:00:00.000Z')`,
      [ids.accountA, ids.source, `impl-source-${suffix}`],
    );
    await client.query(
      "insert into seat_reservations(account_id,slot,source_registry_id,state,membership_id,created_at,updated_at) values($1,1,$2,'active',$3,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp())),($1,2,$2,'active',$4,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()))",
      [ids.accountA, ids.source, ids.membershipA, ids.teammateMembership],
    );
    await client.query(
      "insert into account_course_accesses(id,account_id,entitlement_source_id,course_id,course_version_id) values($1,$2,$3,$4,$5)",
      [ids.access, ids.accountA, ids.source, ids.course, ids.courseVersion],
    );
    await client.query(
      "insert into enrollments(id,account_id,account_course_access_id,membership_id,course_id,course_version_id) values($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$5,$6)",
      [ids.enrollmentA, ids.accountA, ids.access, ids.membershipA, ids.course, ids.courseVersion, ids.teammateEnrollment, ids.teammateMembership],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const readinessDraft = { kind: "readiness_map", priorities: [], notes: "Draft marker alpha" } satisfies ArtifactContent;
const readinessFinal = { kind: "readiness_map", priorities: [{ opportunity: "Lead response", currentState: "Manual", targetOutcome: "Same day", owner: "Operations" }], notes: "Ready" } satisfies ArtifactContent;
const aiDraft = { kind: "ai_policy", purpose: "Draft policy", approvedUses: [], prohibitedUses: [], humanReviewRules: [] } satisfies ArtifactContent;
const aiFinal = { kind: "ai_policy", purpose: "Safe adoption", approvedUses: ["Research"], prohibitedUses: ["Unreviewed decisions"], humanReviewRules: ["Owner approves output"] } satisfies ArtifactContent;
const checklistFinal = { kind: "enablement_checklist", owner: "Operations", items: [{ label: "Train the team", complete: true }] } satisfies ArtifactContent;
const roadmapFinal = { kind: "roadmap", objective: "Launch safely", milestones: [{ horizon: "30_days", outcome: "Pilot complete", owner: "Operations" }] } satisfies ArtifactContent;
const workflow = (index: number, lifecycleState: "testing" | "live") => ({
  name: `Workflow ${index}`, engine: (["growth", "client", "management"] as const)[index - 1]!,
  problem: "Manual handoffs", trigger: "New qualified work", owner: "Operations", approvedTools: ["Approved CRM"],
  steps: ["Review input", "Run workflow"], humanReviewPoint: "Owner reviews before action", safetyNotes: "No sensitive data",
  baseline: "Two days", target: "Two hours", lifecycleState, testStatus: lifecycleState === "live" ? "passed" as const : "in_progress" as const,
  launchDate: lifecycleState === "live" ? "2026-08-15" : null,
});
const workflowDraft = { kind: "workflow_portfolio", workflows: [] } satisfies ArtifactContent;
const workflowTesting = { kind: "workflow_portfolio", workflows: [1, 2, 3].map((index) => workflow(index, "testing")) } satisfies ArtifactContent;
const workflowLive = { kind: "workflow_portfolio", workflows: [1, 2, 3].map((index) => workflow(index, "live")) } satisfies ArtifactContent;

describe.sequential("implementation workspace database authority", () => {
  let harness: TestDatabaseHarness;
  let member: Database;
  let system: Database;
  let workerDatabase: Database;
  const memberRole = `syntholo_impl_member_${randomUUID().replaceAll("-", "")}`;
  const systemRole = `syntholo_impl_system_${randomUUID().replaceAll("-", "")}`;
  const workerRole = `syntholo_impl_worker_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    await harness.reset();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const memberPassword = randomUUID();
    const systemPassword = randomUUID();
    const workerPassword = randomUUID();
    await harness.database.pool.query(await roleSql(harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [memberRole, memberPassword]));
    await harness.database.pool.query(await roleSql(harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [systemRole, systemPassword]));
    await harness.database.pool.query(await roleSql(harness.database,
      "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [workerRole, workerPassword]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_member_api to %I with inherit true,set false,admin false", [memberRole]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_system_api to %I with inherit true,set false,admin false", [systemRole]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_worker to %I with inherit true,set false,admin false", [workerRole]));
    member = createDatabase({ url: loginUrl(baseUrl, memberRole, memberPassword), applicationName: "syntholo-implementation-member-integration" });
    system = createDatabase({ url: loginUrl(baseUrl, systemRole, systemPassword), applicationName: "syntholo-implementation-system-integration" });
    workerDatabase = createDatabase({ url: loginUrl(baseUrl, workerRole, workerPassword), applicationName: "syntholo-implementation-worker-integration" });
    await seedGraph(harness.database);
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([member?.close(), system?.close(), workerDatabase?.close()]);
    if (harness !== undefined) {
      await harness.reset();
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_member_api from %I", [memberRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_system_api from %I", [systemRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_worker from %I", [workerRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [memberRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [systemRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [workerRole])).catch(() => undefined);
      await harness.close();
    }
  });

  it("backfills exact five-root provenance when a populated 0011 database upgrades to 0012", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const databaseName = `syntholo_impl_backfill_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const maintenance = new Pool({ connectionString: databaseUrl(baseUrl, "postgres"), max: 1 });
    const temporaryMigrations = await mkdtemp(join(tmpdir(), "syntholo-implementation-0011-"));
    let upgrade: Database | undefined;
    try {
      await maintenance.query(`create database "${databaseName}"`);
      await mkdir(join(temporaryMigrations, "meta"));
      const migrationNames = [
        "0001_foundation.sql", "0002_roles_and_rls.sql", "0003_staff_authentication.sql", "0004_audit_and_jobs.sql",
        "0005_entitlements.sql", "0006_runtime_readiness.sql", "0007_runtime_contract.sql", "0008_account_name.sql",
        "0009_content.sql", "0010_content_assets.sql", "0011_learning.sql",
      ];
      for (const name of migrationNames) {
        await writeFile(join(temporaryMigrations, name), await readFile(new URL(`../drizzle/${name}`, import.meta.url)));
      }
      const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
      await writeFile(join(temporaryMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 11) }));
      upgrade = createDatabase({ url: databaseUrl(baseUrl, databaseName), applicationName: "syntholo-implementation-backfill" });
      await migrate(upgrade, { migrationsFolder: temporaryMigrations });
      await seedGraph(upgrade);
      expect((await upgrade.pool.query("select to_regclass('public.implementation_artifacts') table_name")).rows)
        .toEqual([{ table_name: null }]);
      await migrateDatabase(upgrade);
      await migrateDatabase(upgrade);
      const backfilled = await upgrade.pool.query<{ count: number; access_count: number; version_count: number }>(
        "select count(*)::integer count,count(*) filter(where seeded_from_account_course_access_id=$1)::integer access_count,count(*) filter(where seeded_from_course_version_id=$2)::integer version_count from implementation_artifacts where account_id=$3 and course_id=$4",
        [ids.access, ids.courseVersion, ids.accountA, ids.course],
      );
      expect(backfilled.rows).toEqual([{ count: 5, access_count: 5, version_count: 5 }]);
      expect((await upgrade.pool.query("select count(*)::integer count from drizzle.__drizzle_migrations")).rows).toEqual([{ count: 14 }]);
    } finally {
      await upgrade?.close();
      await maintenance.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
      await Promise.allSettled([maintenance.end(), rm(temporaryMigrations, { recursive: true, force: true })]);
    }
  }, 60_000);

  it("enforces the full seed, actor, receipt, validation, concurrency, and completion lifecycle", async () => {
    expect(await systemSeed(system)).toBe("seeded");
    expect(await systemSeed(system)).toBe("duplicate");
    await harness.database.pool.query("create function public.syntholo_unexpected_system_test_v1() returns void language plpgsql as 'begin null; end'; revoke all on function public.syntholo_unexpected_system_test_v1() from public; grant execute on function public.syntholo_unexpected_system_test_v1() to syntholo_system_api");
    await expect(systemSeed(system)).rejects.toThrow("SYNTHOLO_RUNTIME_CAPABILITY_INVALID");
    await harness.database.pool.query("revoke execute on function public.syntholo_unexpected_system_test_v1() from syntholo_system_api; drop function public.syntholo_unexpected_system_test_v1()");
    const seeded = await harness.database.pool.query<{ id: string; kind: ArtifactContent["kind"] }>(
      "select id,kind from implementation_artifacts where account_id=$1 and course_id=$2 order by kind", [ids.accountA, ids.course],
    );
    expect(seeded.rowCount).toBe(5);
    const root = Object.fromEntries(seeded.rows.map(({ id, kind }) => [kind, id])) as Record<ArtifactContent["kind"], string>;
    const provenance = await harness.database.pool.query(
      "select count(*)::integer count from implementation_artifacts where account_id=$1 and seeded_from_account_course_access_id=$2 and seeded_from_course_version_id=$3",
      [ids.accountA, ids.access, ids.courseVersion],
    );
    expect(provenance.rows[0]?.count).toBe(5);
    const readiness = await harness.database.pool.query("select seed_backfill_ready from syntholo_implementation_readiness_v1()");
    expect(readiness.rows).toEqual([{ seed_backfill_ready: true }]);

    const list = await memberQuery<{ result: { items: readonly unknown[] } }>(member, actorA, "select syntholo_implementation_list_v1() result");
    expect(list[0]?.result.items).toHaveLength(5);
    await expect(member.pool.query("select syntholo_implementation_list_v1() result")).rejects.toThrow("IMPLEMENTATION_MEMBER_CONTEXT_REQUIRED");
    const halfScope = await member.pool.connect();
    try {
      await halfScope.query("begin");
      await halfScope.query("select set_config('app.account_id',$1,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$2,true)", [ids.accountA, randomUUID()]);
      await expect(halfScope.query("select syntholo_implementation_list_v1() result")).rejects.toThrow("IMPLEMENTATION_MEMBER_CONTEXT_REQUIRED");
    } finally {
      await halfScope.query("rollback").catch(() => undefined);
      halfScope.release();
    }
    await expect(memberQuery(member, actorB, "select syntholo_implementation_list_v1() result")).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");
    await expect(memberQuery(member, { ...actorA, membershipId: ids.membershipB }, "select syntholo_implementation_list_v1() result")).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");
    await expect(memberQuery(member, actorB, "select syntholo_implementation_get_v1($1) result", [root.readiness_map])).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");
    await expect(memberQuery(member, actorB, "select syntholo_implementation_versions_v1($1,null,null,25) result", [root.readiness_map])).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");
    await expect(save(member, actorB, root.readiness_map, 0, "draft", readinessDraft)).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");

    const replayKey = `impl-${randomUUID()}`;
    const first = await save(member, actorA, root.readiness_map, 0, "draft", readinessDraft, replayKey);
    const replay = await save(member, actorA, root.readiness_map, 0, "draft", readinessDraft, replayKey);
    expect(replay).toEqual(first);
    await expect(save(member, actorA, root.readiness_map, 0, "draft", { ...readinessDraft, notes: "Changed receipt body" }, replayKey))
      .rejects.toThrow("IDEMPOTENCY_KEY_REUSED");

    const contenderA = save(member, actorA, root.ai_policy, 0, "draft", aiDraft, `impl-${randomUUID()}`);
    const contenderB = save(member, teammate, root.ai_policy, 0, "draft", { ...aiDraft, purpose: "Teammate draft" }, `impl-${randomUUID()}`);
    const contenders = await Promise.allSettled([contenderA, contenderB]);
    expect(contenders.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter(({ status }) => status === "rejected").map((result) => String((result as PromiseRejectedResult).reason)))
      .toEqual([expect.stringContaining("VERSION_CONFLICT")]);
    const ownerAi = await memberQuery<{ result: { artifact: { authorLabel: string } } }>(member, actorA, "select syntholo_implementation_get_v1($1) result", [root.ai_policy]);
    const teammateAi = await memberQuery<{ result: { artifact: { authorLabel: string } } }>(member, teammate, "select syntholo_implementation_get_v1($1) result", [root.ai_policy]);
    expect([ownerAi[0]?.result.artifact.authorLabel, teammateAi[0]?.result.artifact.authorLabel].sort()).toEqual(["A teammate", "You"]);
    const teammateHistory = await memberQuery<{ result: { items: readonly { authorLabel: string }[] } }>(member, teammate, "select syntholo_implementation_versions_v1($1,null,null,25) result", [root.ai_policy]);
    expect(teammateHistory[0]?.result.items[0]?.authorLabel).toBe(teammateAi[0]?.result.artifact.authorLabel);

    const lockKey = `impl-${randomUUID()}`;
    const lockClient = await member.pool.connect();
    try {
      await lockClient.query("begin");
      await setMemberContext(lockClient, actorA);
      await lockClient.query(
        "select pg_advisory_xact_lock(hashtextextended('implementation:receipt:member:'||$1||':POST:/v1/member/artifacts/:artifactId/versions:'||$2,0))",
        [ids.identityA, lockKey],
      );
      await expect(save(member, actorA, root.enablement_checklist, 0, "draft", { kind: "enablement_checklist", owner: "", items: [] }, lockKey))
        .rejects.toThrow("IDEMPOTENCY_IN_PROGRESS");
    } finally {
      await lockClient.query("rollback").catch(() => undefined);
      lockClient.release();
    }

    await expect(save(member, actorA, root.workflow_portfolio, 0, "final", {
      ...workflowLive,
      workflows: workflowLive.workflows.map((item, index) => index === 0 ? { ...item, testStatus: "failed" as const, launchDate: null } : item),
    })).rejects.toThrow("IMPLEMENTATION_COMMAND_INVALID");
    await expect(save(member, actorA, root.workflow_portfolio, 0, "final", { ...workflowLive, workflows: workflowLive.workflows.slice(0, 2) }))
      .rejects.toThrow("IMPLEMENTATION_COMMAND_INVALID");
    await expect(save(member, actorA, root.workflow_portfolio, 0, "draft", { ...workflowDraft, workflows: [1, 2, 3, 4].map((index) => workflow(index > 3 ? 3 : index, "testing")) }))
      .rejects.toThrow("IMPLEMENTATION_COMMAND_INVALID");
    await save(member, actorA, root.workflow_portfolio, 0, "draft", workflowDraft);
    await expect(save(member, actorA, root.roadmap, 0, "final", { kind: "roadmap", objective: "", milestones: [] }))
      .rejects.toThrow("IMPLEMENTATION_COMMAND_INVALID");
    const unicode = await harness.database.pool.query<{ astral: boolean; padded: boolean; unicode_space: boolean; non_trim_space: boolean }>(
      "select syntholo_implementation_text_valid_v1('🚀',255) astral,syntholo_implementation_text_valid_v1(' x ',255) padded,syntholo_implementation_text_valid_v1(U&'\\00A0x\\00A0',255) unicode_space,syntholo_implementation_text_valid_v1(U&'\\0085',255) non_trim_space",
    );
    expect(unicode.rows[0]).toEqual({ astral: true, padded: false, unicode_space: false, non_trim_space: true });

    await harness.database.pool.query(
      `insert into course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id,required_lesson_set_hash,completed_at) values
       ($1,$2,$3,$4,$5,$6,$7,'2026-08-15T12:00:00.000Z'),($8,$2,$9,$10,$5,$6,$7,'2026-08-15T13:00:00.000Z')`,
      [ids.courseCompletion, ids.accountA, ids.membershipA, ids.enrollmentA, ids.course, ids.courseVersion, "a".repeat(64), ids.teammateCourseCompletion, ids.teammateMembership, ids.teammateEnrollment],
    );
    await save(member, actorA, root.readiness_map, 1, "final", readinessFinal);
    await save(member, actorA, root.ai_policy, 1, "final", aiFinal);
    await save(member, actorA, root.enablement_checklist, 0, "final", checklistFinal);
    await save(member, actorA, root.roadmap, 0, "final", roadmapFinal);
    const testing = await save(member, actorA, root.workflow_portfolio, 1, "final", workflowTesting);
    expect(testing.implementationCompletion).toEqual({ completed: false, completedAt: null });
    expect((await harness.database.pool.query("select id from implementation_completions where account_id=$1", [ids.accountA])).rowCount).toBe(0);

    const completed = await save(member, actorA, root.workflow_portfolio, 2, "final", workflowLive);
    expect(completed.implementationCompletion.completed).toBe(true);
    expect(completed.implementationCompletion.completedAt).not.toBeNull();
    const snapshot = await harness.database.pool.query<{ completion_id: string; artifacts: number; workflows: number }>(
      "select c.id completion_id,(select count(*)::integer from implementation_completion_artifact_snapshots s where s.completion_id=c.id) artifacts,(select count(*)::integer from implementation_completion_workflow_snapshots s where s.completion_id=c.id) workflows from implementation_completions c where c.account_id=$1 and c.course_id=$2",
      [ids.accountA, ids.course],
    );
    expect(snapshot.rows[0]).toMatchObject({ artifacts: 5, workflows: 3 });
    const completionId = snapshot.rows[0]?.completion_id;
    expect(completionId).toBeDefined();
    const recomputed = await harness.database.pool.query<{ id: string }>(
      "select syntholo_implementation_recompute_completion_v1($1,$2,'system','implementation-integration',$3) id",
      [ids.accountA, ids.course, randomUUID()],
    );
    expect(recomputed.rows[0]?.id).toBe(completionId);
    const exactSnapshot = await harness.database.pool.query<{ artifacts_exact: boolean; workflows_exact: boolean; personal: string; events: number; audits: number }>(
      `select
       not exists(select 1 from implementation_completion_artifact_snapshots s join implementation_artifacts a on a.id=s.artifact_id where s.completion_id=$1 and (s.artifact_version_id<>a.current_version_id or s.kind<>a.kind)) artifacts_exact,
       not exists(select 1 from implementation_completion_workflow_snapshots s join implementation_workflows w on w.id=s.workflow_id where s.completion_id=$1 and (s.artifact_version_id<>w.artifact_version_id or s.artifact_id<>w.artifact_id)) workflows_exact,
       (select course_completion_id::text from implementation_completions where id=$1) personal,
       (select count(*)::integer from outbox_events where type='implementation.program_completed.v1' and aggregate_id=$1::text) events,
       (select count(*)::integer from audit_events where action='implementation_program_completed' and target_id=$1::text) audits`,
      [completionId],
    );
    expect(exactSnapshot.rows).toEqual([{ artifacts_exact: true, workflows_exact: true, personal: ids.courseCompletion, events: 1, audits: 1 }]);
    const frozenIds = await harness.database.pool.query<{ artifact_ids: string[]; workflow_ids: string[] }>(
      "select array(select artifact_version_id::text from implementation_completion_artifact_snapshots where completion_id=$1 order by artifact_version_id) artifact_ids,array(select workflow_id::text from implementation_completion_workflow_snapshots where completion_id=$1 order by workflow_id) workflow_ids",
      [completionId],
    );
    await save(member, actorA, root.readiness_map, 2, "draft", { ...readinessDraft, notes: "Post-completion draft" });
    await save(member, actorA, root.workflow_portfolio, 3, "final", {
      ...workflowTesting,
      workflows: workflowTesting.workflows.map((item) => ({ ...item, lifecycleState: "paused" as const })),
    });
    const stable = await harness.database.pool.query(
      "select (select count(*)::integer from implementation_completions where account_id=$1) completions,(select count(*)::integer from implementation_completion_artifact_snapshots where completion_id=$2) artifacts,(select count(*)::integer from implementation_completion_workflow_snapshots where completion_id=$2) workflows",
      [ids.accountA, completionId],
    );
    expect(stable.rows).toEqual([{ completions: 1, artifacts: 5, workflows: 3 }]);
    const stillFrozen = await harness.database.pool.query<{ artifact_ids: string[]; workflow_ids: string[] }>(
      "select array(select artifact_version_id::text from implementation_completion_artifact_snapshots where completion_id=$1 order by artifact_version_id) artifact_ids,array(select workflow_id::text from implementation_completion_workflow_snapshots where completion_id=$1 order by workflow_id) workflow_ids",
      [completionId],
    );
    expect(stillFrozen.rows).toEqual(frozenIds.rows);
    await expect(harness.database.pool.query("update implementation_artifact_versions set content='{}' where id=$1", [completed.version.id])).rejects.toThrow("IMPLEMENTATION_IMMUTABLE");
    await expect(harness.database.pool.query("delete from implementation_workflows where artifact_version_id=$1", [completed.version.id])).rejects.toThrow("IMPLEMENTATION_IMMUTABLE");
    await expect(harness.database.pool.query("update implementation_completions set completed_at=completed_at+interval '1 second' where id=$1", [completionId])).rejects.toThrow("IMPLEMENTATION_IMMUTABLE");
    await expect(harness.database.pool.query("delete from implementation_completion_artifact_snapshots where completion_id=$1", [completionId])).rejects.toThrow("IMPLEMENTATION_IMMUTABLE");
    await expect(harness.database.pool.query("update implementation_artifacts set current_version=current_version-1 where id=$1", [root.workflow_portfolio])).rejects.toThrow("IMPLEMENTATION_HEAD_TRANSITION_INVALID");
    await expect(harness.database.pool.query("delete from implementation_artifacts where id=$1", [root.roadmap])).rejects.toThrow("IMPLEMENTATION_IMMUTABLE");
    const privacy = await harness.database.pool.query<{ leaked: boolean }>(
      "select exists(select 1 from audit_events where payload::text like '%Draft marker alpha%') or exists(select 1 from outbox_events where payload::text like '%Draft marker alpha%') leaked",
    );
    expect(privacy.rows).toEqual([{ leaked: false }]);

    const revokeTeammate = await harness.database.pool.connect();
    try {
      await revokeTeammate.query("begin");
      await revokeTeammate.query("update enrollments set status='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()) where id=$1", [ids.teammateEnrollment]);
      await revokeTeammate.query("update seat_reservations set state='revoked',updated_at=date_trunc('milliseconds',clock_timestamp()) where membership_id=$1", [ids.teammateMembership]);
      await revokeTeammate.query("update memberships set status='revoked',updated_at=date_trunc('milliseconds',clock_timestamp()) where id=$1", [ids.teammateMembership]);
      await revokeTeammate.query("commit");
    } catch (error) {
      await revokeTeammate.query("rollback");
      throw error;
    } finally {
      revokeTeammate.release();
    }
    await expect(memberQuery(member, teammate, "select syntholo_implementation_get_v1($1) result", [root.ai_policy])).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");
    await harness.database.pool.query("update enrollments set status='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()) where account_course_access_id=$1 and status='active'", [ids.access]);
    await harness.database.pool.query("update account_course_accesses set status='revoked' where id=$1", [ids.access]);
    await expect(memberQuery(member, actorA, "select syntholo_implementation_get_v1($1) result", [root.readiness_map])).rejects.toThrow("IMPLEMENTATION_NOT_FOUND");
  }, 30_000);

  it("converges artifacts-first completion through the strict learning worker event exactly once", async () => {
    const course = randomUUID();
    const preview = randomUUID();
    const courseVersion = randomUUID();
    const access = randomUUID();
    const enrollment = randomUUID();
    const personalCompletion = randomUUID();
    const eventId = randomUUID();
    const manifest = "{}";
    const manifestHash = createHash("sha256").update(manifest).digest("hex");
    const suffix = randomUUID().replaceAll("-", "");
    await harness.database.pool.query("insert into courses(id,slug,title,description) values($1,$2,'Artifacts first','Worker convergence')", [course, `artifacts-first-${suffix}`]);
    await harness.database.pool.query("insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason) values($1,$2,1,$3::text,$4,($3::text)::jsonb,'[]',$5,'Artifacts first')", [preview, course, manifest, manifestHash, ids.staff]);
    await harness.database.pool.query("insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) values($1,$2,1,'Artifacts first','Worker convergence',$3,$4,$5,'Artifacts first')", [courseVersion, course, manifestHash, preview, ids.staff]);
    await harness.database.pool.query("insert into account_course_accesses(id,account_id,entitlement_source_id,course_id,course_version_id) values($1,$2,$3,$4,$5)", [access, ids.accountA, ids.source, course, courseVersion]);
    await harness.database.pool.query("insert into enrollments(id,account_id,account_course_access_id,membership_id,course_id,course_version_id) values($1,$2,$3,$4,$5,$6)", [enrollment, ids.accountA, access, ids.membershipA, course, courseVersion]);
    expect(await systemSeed(system, access)).toBe("seeded");
    const roots = await harness.database.pool.query<{ id: string; kind: ArtifactContent["kind"] }>(
      "select id,kind from implementation_artifacts where account_id=$1 and course_id=$2", [ids.accountA, course],
    );
    const root = Object.fromEntries(roots.rows.map(({ id, kind }) => [kind, id])) as Record<ArtifactContent["kind"], string>;
    await save(member, actorA, root.readiness_map, 0, "final", readinessFinal);
    await save(member, actorA, root.ai_policy, 0, "final", aiFinal);
    await save(member, actorA, root.enablement_checklist, 0, "final", checklistFinal);
    await save(member, actorA, root.roadmap, 0, "final", roadmapFinal);
    const beforePersonal = await save(member, actorA, root.workflow_portfolio, 0, "final", workflowLive);
    expect(beforePersonal.implementationCompletion.completed).toBe(false);
    await harness.database.pool.query(
      "insert into course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id,required_lesson_set_hash,completed_at) values($1,$2,$3,$4,$5,$6,$7,'2026-08-15T14:00:00.000Z')",
      [personalCompletion, ids.accountA, ids.membershipA, enrollment, course, courseVersion, "b".repeat(64)],
    );
    await harness.database.pool.query(
      "insert into outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) values($1::uuid,$2::uuid,'learning.course_completed.v1',$3::text,jsonb_build_object('courseCompletionId',$3::text,'accountId',$2::text,'membershipId',$4::text,'enrollmentId',$5::text,'courseId',$6::text,'courseVersionId',$7::text),1,'pending',0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()),'member',$8::text,$9::uuid,10,0)",
      [eventId, ids.accountA, personalCompletion, ids.membershipA, enrollment, course, courseVersion, ids.identityA, randomUUID()],
    );
    const first = await workerDatabase.pool.query<{ result: string }>(
      "select syntholo_implementation_record_course_completion_v1($1,'implementation.completion_recompute') result", [eventId],
    );
    const replay = await workerDatabase.pool.query<{ result: string }>(
      "select syntholo_implementation_record_course_completion_v1($1,'implementation.completion_recompute') result", [eventId],
    );
    expect(first.rows).toEqual([{ result: "recorded" }]);
    expect(replay.rows).toEqual([{ result: "duplicate" }]);
    const convergence = await harness.database.pool.query(
      `select count(*)::integer completions,
       (select count(*)::integer from implementation_completion_artifact_snapshots s join implementation_completions c on c.id=s.completion_id where c.course_id=$1) artifacts,
       (select count(*)::integer from implementation_completion_workflow_snapshots s join implementation_completions c on c.id=s.completion_id where c.course_id=$1) workflows,
       (select count(*)::integer from outbox_events where type='implementation.program_completed.v1' and payload->>'courseId'=$1::text) program_events,
       (select count(*)::integer from audit_events where action='implementation_program_completed' and payload->>'courseId'=$1::text) program_audits
       from implementation_completions where account_id=$2 and course_id=$1`,
      [course, ids.accountA],
    );
    expect(convergence.rows).toEqual([{ completions: 1, artifacts: 5, workflows: 3, program_events: 1, program_audits: 1 }]);
  }, 30_000);
});
