import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { ArtifactContent, ArtifactState } from "@syntholo/contracts/implementation";
import { canonicalizeArtifactContent } from "@syntholo/domain/implementation";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";
import { createDatabase, type Database } from "./client.js";

type Actor = Readonly<{
  accountId: string;
  identityId: string;
  membershipId: string;
}>;

type BaseFixture = Readonly<{
  accountA: string;
  accountB: string;
  actorA: Actor;
  actorB: Actor;
  staffId: string;
  teammate: Actor;
}>;

type CompletionFixture = Readonly<{
  accountId: string;
  actorIdentityId: string;
  completionId: string;
  correlationId: string;
  courseId: string;
  courseVersionId: string;
  enrollmentId: string;
  eventId: string;
  membershipId: string;
}>;

type CertificateRecord = Readonly<{
  id: string;
  course_completion_id: string;
  account_id: string;
  membership_id: string;
  status: "awaiting_recipient_name" | "pending" | "failed" | "issued";
  failure_code: "snapshot_not_renderable" | "render_failed" | "storage_failed" | null;
  snapshot_renderable: boolean;
  recipient_name_version_id: string | null;
  recipient_name_snapshot: string | null;
}>;

type ClaimedJob = Readonly<{
  attempt: number;
  claimToken: string;
  generation: number;
  id: string;
  workerId: string;
}>;

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
] as const;

const certificateMigrationWhen = 1_786_942_800_000;
const certificateJobType = "learning.course_completed.certificate.v1";
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());
const describeDatabase = hasTestDatabase ? describe.sequential : describe.skip;
const implementationFinals = {
  ai_policy: {
    kind: "ai_policy",
    purpose: "Safe certificate-independent adoption",
    approvedUses: ["Research"],
    prohibitedUses: ["Unreviewed decisions"],
    humanReviewRules: ["Owner approves output"],
  },
  enablement_checklist: {
    kind: "enablement_checklist",
    owner: "Operations",
    items: [{ label: "Train the team", complete: true }],
  },
  readiness_map: {
    kind: "readiness_map",
    priorities: [{ opportunity: "Response", currentState: "Manual", targetOutcome: "Same day", owner: "Operations" }],
    notes: "Ready",
  },
  roadmap: {
    kind: "roadmap",
    objective: "Launch safely",
    milestones: [{ horizon: "30_days", outcome: "Pilot complete", owner: "Operations" }],
  },
  workflow_portfolio: {
    kind: "workflow_portfolio",
    workflows: ["growth", "client", "management"].map((engine, index) => ({
      name: `Workflow ${index + 1}`,
      engine: engine as "growth" | "client" | "management",
      problem: "Manual handoffs",
      trigger: "New qualified work",
      owner: "Operations",
      approvedTools: ["Approved CRM"],
      steps: ["Review input", "Run workflow"],
      humanReviewPoint: "Owner reviews before action",
      safetyNotes: "No sensitive data",
      baseline: "Two days",
      target: "Two hours",
      lifecycleState: "live" as const,
      testStatus: "passed" as const,
      launchDate: "2026-08-15",
    })),
  },
} satisfies Record<ArtifactContent["kind"], ArtifactContent>;

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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nameRequestHash(
  actor: Actor,
  expectedVersion: number,
  displayName: string,
): string {
  return sha256(JSON.stringify({
    accountId: actor.accountId,
    displayName,
    expectedVersion,
    membershipId: actor.membershipId,
    routeVersion: "certificate-recipient-name.v1",
  }));
}

function deliveryRequestHash(certificateId: string, reason: string): string {
  return sha256(JSON.stringify({
    certificateId,
    reason,
    routeVersion: "certificate-delivery.v1",
  }));
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
  if (statement === undefined) throw new Error("CERTIFICATE_TEST_ROLE_SQL_FAILED");
  return statement;
}

async function setMemberContext(client: PoolClient, actor: Actor): Promise<void> {
  await client.query(
    `select set_config('app.account_id',$1,true),
      set_config('app.actor_id',$2,true),
      set_config('app.membership_id',$3,true),
      set_config('app.actor_kind','member',true),
      set_config('app.correlation_id',$4,true),
      set_config('app.actor_role','owner',true),
      set_config('app.authenticated_at',$5,true)`,
    [
      actor.accountId,
      actor.identityId,
      actor.membershipId,
      randomUUID(),
      "2026-08-15T12:00:00.000Z",
    ],
  );
}

async function setStaffContext(client: PoolClient, staffId: string): Promise<void> {
  await client.query(
    `select set_config('app.actor_id',$1,true),
      set_config('app.actor_kind','staff',true),
      set_config('app.correlation_id',$2,true),
      set_config('app.authenticated_at',$3,true)`,
    [staffId, randomUUID(), "2026-08-15T12:00:00.000Z"],
  );
}

async function setWorkerContext(client: PoolClient): Promise<void> {
  await client.query(
    `select set_config('app.actor_id','certificate-integration-worker',true),
      set_config('app.actor_kind','system',true),
      set_config('app.correlation_id',$1,true)`,
    [randomUUID()],
  );
}

async function setSystemContext(client: PoolClient, accountId: string): Promise<void> {
  await client.query(
    `select set_config('app.account_id',$1,true),
      set_config('app.actor_id','certificate-integration-system',true),
      set_config('app.actor_kind','system',true),
      set_config('app.correlation_id',$2,true)`,
    [accountId, randomUUID()],
  );
}

async function contextualQuery<T extends QueryResultRow>(
  database: Database,
  setContext: (client: PoolClient) => Promise<void>,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await setContext(client);
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

async function ownerQuery<T extends QueryResultRow>(
  database: Database,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local row_security=off");
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

async function memberQuery<T extends QueryResultRow>(
  database: Database,
  actor: Actor,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  return contextualQuery(database, (client) => setMemberContext(client, actor), text, values);
}

async function staffQuery<T extends QueryResultRow>(
  database: Database,
  staffId: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  return contextualQuery(database, (client) => setStaffContext(client, staffId), text, values);
}

async function workerQuery<T extends QueryResultRow>(
  database: Database,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  return contextualQuery(database, setWorkerContext, text, values);
}

async function systemQuery<T extends QueryResultRow>(
  database: Database,
  accountId: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  return contextualQuery(database, (client) => setSystemContext(client, accountId), text, values);
}

async function saveImplementationVersion(
  memberDatabase: Database,
  actor: Actor,
  artifactId: string,
  expectedVersion: number,
  state: ArtifactState,
  content: ArtifactContent,
): Promise<void> {
  const requestHash = canonicalizeArtifactContent({ artifactId, expectedVersion, state, content }).hash;
  await memberQuery(
    memberDatabase,
    actor,
    "select syntholo_implementation_save_version_v1($1,$2,$3,$4::jsonb,$5,$6)",
    [artifactId, expectedVersion, state, JSON.stringify(content), `implementation-${randomUUID()}`, requestHash],
  );
}

async function seedBase(database: Database): Promise<BaseFixture> {
  const accountA = randomUUID();
  const accountB = randomUUID();
  const identityA = randomUUID();
  const identityB = randomUUID();
  const teammateIdentity = randomUUID();
  const membershipA = randomUUID();
  const membershipB = randomUUID();
  const teammateMembership = randomUUID();
  const staffId = randomUUID();
  const sourceId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "");
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query(
    "insert into accounts(id,name) values($1,'Certificate Account A'),($2,'Certificate Account B')",
    [accountA, accountB],
  );
    await client.query(
    `insert into member_identities(id,account_id,provider,provider_user_id,email) values
      ($1,$2,'clerk',$3,'owner-a@example.invalid'),
      ($4,$5,'clerk',$6,'owner-b@example.invalid'),
      ($7,$2,'clerk',$8,'teammate@example.invalid')`,
    [
      identityA,
      accountA,
      `certificate-a-${suffix}`,
      identityB,
      accountB,
      `certificate-b-${suffix}`,
      teammateIdentity,
      `certificate-team-${suffix}`,
    ],
  );
    await client.query(
    `insert into memberships(id,account_id,member_identity_id,role,status) values
      ($1,$2,$3,'owner','active'),
      ($4,$5,$6,'owner','active'),
      ($7,$2,$8,'teammate','active')`,
    [
      membershipA,
      accountA,
      identityA,
      membershipB,
      accountB,
      identityB,
      teammateMembership,
      teammateIdentity,
    ],
  );
    await client.query(
      `insert into entitlement_sources(id,account_id,source_kind,source_id,offer_code,provenance,created_at)
        values($1,$2,'purchase',$3,'self_paced','certificate base integration','2026-08-15T00:00:00.000Z')`,
      [sourceId, accountA, `certificate-base-${suffix}`],
    );
    await client.query(
      `insert into entitlement_grants
        (account_id,source_registry_id,source_kind,source_id,offer_code,capability,status,starts_at,ends_at,provenance,created_at,updated_at) values
        ($1,$2,'purchase',$3,'self_paced','academy_course','active','2026-08-15T00:00:00.000Z',null,'certificate base integration','2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z'),
        ($1,$2,'purchase',$3,'self_paced','support','active','2026-08-15T00:00:00.000Z','2027-08-15T00:00:00.000Z','certificate base integration','2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z'),
        ($1,$2,'purchase',$3,'self_paced','circle_write','active','2026-08-15T00:00:00.000Z','2027-08-15T00:00:00.000Z','certificate base integration','2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z')`,
      [accountA, sourceId, `certificate-base-${suffix}`],
    );
    await client.query(
      `insert into seat_reservations(account_id,slot,source_registry_id,state,membership_id,created_at,updated_at) values
        ($1,1,$2,'active',$3,'2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z'),
        ($1,2,$2,'active',$4,'2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z')`,
      [accountA, sourceId, membershipA, teammateMembership],
    );
    await client.query(
    `insert into staff_identities(id,provider_user_id,role,status,permissions)
      values($1,$2,'admin','active',array['certificates:deliver'])`,
    [staffId, `certificate-staff-${suffix}`],
  );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    accountA,
    accountB,
    actorA: { accountId: accountA, identityId: identityA, membershipId: membershipA },
    actorB: { accountId: accountB, identityId: identityB, membershipId: membershipB },
    staffId,
    teammate: {
      accountId: accountA,
      identityId: teammateIdentity,
      membershipId: teammateMembership,
    },
  };
}

async function seedCompletion(
  database: Database,
  workerDatabase: Database,
  actor: Actor,
  options: Readonly<{
    businessName?: string;
    courseTitle?: string;
    prerequisite?: boolean;
  }> = {},
): Promise<CompletionFixture> {
  const courseId = randomUUID();
  const previewId = randomUUID();
  const courseVersionId = randomUUID();
  const accessId = randomUUID();
  const enrollmentId = randomUUID();
  const completionId = randomUUID();
  const eventId = randomUUID();
  const correlationId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "");
  const manifest = "{}";
  const manifestHash = sha256(manifest);
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    if (options.businessName !== undefined) {
      await client.query("update accounts set name=$2 where id=$1", [actor.accountId, options.businessName]);
    }
    await client.query(
      "insert into courses(id,slug,title,description) values($1,$2,$3,'Certificate integration')",
      [courseId, `certificate-${suffix}`, options.courseTitle ?? "Certificate Course"],
    );
    const staff = await client.query<{ id: string }>(
      "select id from staff_identities order by created_at limit 1",
    );
    const staffId = staff.rows[0]?.id;
    if (staffId === undefined) throw new Error("CERTIFICATE_TEST_STAFF_MISSING");
    const source = await client.query<{ id: string }>(
      "select id::text from entitlement_sources where account_id=$1 and source_kind='purchase' and offer_code='self_paced' order by created_at,id limit 1",
      [actor.accountId],
    );
    const sourceId = source.rows[0]?.id;
    if (sourceId === undefined) throw new Error("CERTIFICATE_TEST_SOURCE_MISSING");
    await client.query(
    `insert into content_previews
      (id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason)
      values($1,$2,1,$3::text,$4,($3::text)::jsonb,'[]',$5,'Certificate integration')`,
    [previewId, courseId, manifest, manifestHash, staffId],
  );
    await client.query(
    `insert into course_versions
      (id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason)
      values($1,$2,1,$3,'Certificate integration',$4,$5,$6,'Certificate integration')`,
    [courseVersionId, courseId, options.courseTitle ?? "Certificate Course", manifestHash, previewId, staffId],
  );
    await client.query(
    `insert into account_course_accesses
      (id,account_id,entitlement_source_id,course_id,course_version_id)
      values($1,$2,$3,$4,$5)`,
    [accessId, actor.accountId, sourceId, courseId, courseVersionId],
  );
    await client.query(
    `insert into enrollments
      (id,account_id,account_course_access_id,membership_id,course_id,course_version_id)
      values($1,$2,$3,$4,$5,$6)`,
    [enrollmentId, actor.accountId, accessId, actor.membershipId, courseId, courseVersionId],
  );
    await client.query(
    `insert into course_completions
      (id,account_id,membership_id,enrollment_id,course_id,course_version_id,required_lesson_set_hash,completed_at)
      values($1,$2,$3,$4,$5,$6,$7,'2026-08-15T12:00:00.000Z')`,
    [completionId, actor.accountId, actor.membershipId, enrollmentId, courseId, courseVersionId, "a".repeat(64)],
  );
    await client.query(
    `insert into outbox_events
      (event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation)
      values($1::uuid,$2::uuid,'learning.course_completed.v1',$3::text,
        jsonb_build_object('courseCompletionId',$3::text,'accountId',$2::text,'membershipId',$4::text,'enrollmentId',$5::text,'courseId',$6::text,'courseVersionId',$7::text),
        1,'pending',0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()),
        '2026-08-15T12:00:00.000Z','member',$8::text,$9::uuid,10,0)`,
    [
      eventId,
      actor.accountId,
      completionId,
      actor.membershipId,
      enrollmentId,
      courseId,
      courseVersionId,
      actor.identityId,
      correlationId,
    ],
  );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (options.prerequisite !== false) {
    const result = await workerQuery<{ outcome: string }>(
      workerDatabase,
      "select syntholo_learning_record_certificate_prerequisite_v1($1,'learning.certificate_prerequisite_record') outcome",
      [eventId],
    );
    expect(result).toEqual([{ outcome: "recorded" }]);
  }
  return {
    accountId: actor.accountId,
    actorIdentityId: actor.identityId,
    completionId,
    correlationId,
    courseId,
    courseVersionId,
    enrollmentId,
    eventId,
    membershipId: actor.membershipId,
  };
}

async function stageCandidate(
  workerDatabase: Database,
  eventId: string,
): Promise<string> {
  const rows = await workerQuery<{ outcome: string }>(
    workerDatabase,
    "select syntholo_certificate_stage_candidate_v1($1,'learning.certificate_prerequisite_record') outcome",
    [eventId],
  );
  const outcome = rows[0]?.outcome;
  if (outcome === undefined) throw new Error("CERTIFICATE_TEST_STAGE_RESULT_MISSING");
  return outcome;
}

async function confirmName(
  memberDatabase: Database,
  actor: Actor,
  expectedVersion: number,
  displayName: string,
  key = `certificate-name-${randomUUID()}`,
  requestHash = nameRequestHash(actor, expectedVersion, displayName),
): Promise<unknown> {
  const rows = await memberQuery<{ result: unknown }>(
    memberDatabase,
    actor,
    "select syntholo_certificate_confirm_recipient_name_v1($1,$2,$3,$4) result",
    [expectedVersion, displayName, key, requestHash],
  );
  return rows[0]?.result;
}

async function certificateFor(
  database: Database,
  completionId: string,
): Promise<CertificateRecord> {
  const result = await database.pool.query<CertificateRecord>(
    `select id::text,course_completion_id::text,account_id::text,membership_id::text,status,
      failure_code,snapshot_renderable,recipient_name_version_id::text,recipient_name_snapshot
      from certificate_records where course_completion_id=$1`,
    [completionId],
  );
  const record = result.rows[0];
  if (record === undefined) throw new Error("CERTIFICATE_TEST_RECORD_MISSING");
  return record;
}

async function claimCertificateJob(
  database: Database,
  completionId: string,
): Promise<ClaimedJob> {
  const claimToken = randomUUID();
  const workerId = "certificate-integration-worker-certificate-v1";
  const result = await database.pool.query<{ id: string }>(
    `with claimed as (
      update jobs set status='running',attempts=1,claim_generation=1,claim_token=$2,
        worker_id=$3,claimed_at=date_trunc('milliseconds',clock_timestamp()),
        lease_expires_at=date_trunc('milliseconds',clock_timestamp())+interval '5 minutes',updated_at=date_trunc('milliseconds',clock_timestamp())
      where idempotency_key='certificate:'||$1
      returning id,account_id,attempts,claim_generation,claim_token,worker_id,claimed_at,lease_expires_at
    )
    insert into job_attempts(job_id,account_id,attempt,claim_generation,claim_token,worker_id,started_at,lease_expires_at)
    select id,account_id,attempts,claim_generation,claim_token,worker_id,claimed_at,lease_expires_at from claimed
    returning job_id::text id`,
    [completionId, claimToken, workerId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("CERTIFICATE_TEST_JOB_MISSING");
  return { attempt: 1, claimToken, generation: 1, id, workerId };
}

async function deadLetterCertificateJob(
  workerDatabase: Database,
  job: ClaimedJob,
): Promise<void> {
  const result = await workerQuery<{ transitioned: boolean }>(
    workerDatabase,
    `select syntholo_fail_job($1,$2,$3,$4,$5,date_trunc('milliseconds',clock_timestamp()),
      'JOB_HANDLER_FAILED','Job handler failed',null) transitioned`,
    [job.id, job.workerId, job.attempt, job.generation, job.claimToken],
  );
  expect(result).toEqual([{ transitioned: true }]);
}

async function claimQueuedCertificateJob(
  workerDatabase: Database,
  jobId: string,
): Promise<ClaimedJob> {
  const workerId = "certificate-recovery-integration-certificate-v1";
  const result = await workerQuery<{
    id: string;
    attempt: number;
    generation: number;
    claim_token: string;
  }>(workerDatabase,
    `select id::text,attempts attempt,claim_generation generation,claim_token::text
      from syntholo_claim_jobs(100,$1,date_trunc('milliseconds',clock_timestamp()),300000) where id=$2`,
    [workerId, jobId]);
  const row = result[0];
  if (row === undefined) throw new Error("CERTIFICATE_RECOVERY_TEST_JOB_NOT_CLAIMED");
  return { id: row.id, workerId, attempt: row.attempt, generation: row.generation, claimToken: row.claim_token };
}

async function finalizeCertificate(
  workerDatabase: Database,
  job: ClaimedJob,
  byteLength = 4096,
  hash = "b".repeat(64),
  etag = "certificate-etag",
): Promise<Record<string, unknown>> {
  const rows = await workerQuery<{ result: Record<string, unknown> }>(
    workerDatabase,
    "select to_jsonb(syntholo_certificate_finalize_v1($1,$2,$3,$4,$5,$6,$7,$8)) result",
    [job.id, job.workerId, job.attempt, job.generation, job.claimToken, byteLength, hash, etag],
  );
  const result = rows[0]?.result;
  if (result === undefined) throw new Error("CERTIFICATE_TEST_FINALIZE_RESULT_MISSING");
  return result;
}

async function createDelivery(
  staffDatabase: Database,
  staffId: string,
  certificateId: string,
  reason: string,
  key = `certificate-delivery-${randomUUID()}`,
  requestHash = deliveryRequestHash(certificateId, reason),
): Promise<unknown> {
  const rows = await staffQuery<{ result: unknown }>(
    staffDatabase,
    staffId,
    "select syntholo_certificate_create_delivery_v1($1,$2,$3,$4) result",
    [certificateId, reason, key, requestHash],
  );
  return rows[0]?.result;
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
  const entries = sourceJournal.entries.slice(0, count);
  if (count === 13 && entries.length === 12) {
    entries.push({
      breakpoints: true,
      idx: 12,
      tag: "0013_certificates",
      version: "7",
      when: certificateMigrationWhen,
    });
  }
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify({ ...sourceJournal, entries }),
  );
}

async function withDisposableDatabase(
  label: string,
  run: (database: Database) => Promise<void>,
): Promise<void> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const databaseName = `syntholo_cert_${label}_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Pool({ connectionString: databaseUrl(baseUrl, "postgres"), max: 1 });
  let database: Database | undefined;
  try {
    await maintenance.query(`create database "${databaseName}"`);
    database = createDatabase({
      url: databaseUrl(baseUrl, databaseName),
      applicationName: `syntholo-certificate-${label}`,
    });
    await run(database);
  } finally {
    await database?.close();
    await maintenance.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await maintenance.end();
  }
}

async function expectReadinessMutation(
  database: Database,
  statements: string | readonly string[],
  expectedFalseField: string,
): Promise<void> {
  const baseline = await database.pool.query<Record<string, unknown>>(
    "select * from syntholo_certificates_readiness_v1()",
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
      "select * from syntholo_certificates_readiness_v1()",
    );
    expect(drift.rows).toHaveLength(1);
    expect(drift.rows[0]?.[expectedFalseField]).toBe(false);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  const restored = await database.pool.query("select * from syntholo_certificates_readiness_v1()");
  expect(restored.rows).toEqual(baseline.rows);
}

describeDatabase("0013 certificate migration upgrades", () => {
  it("applies all thirteen migrations to a blank database", async () => {
    await withDisposableDatabase("blank", async (database) => {
      const directory = await mkdtemp(join(tmpdir(), "syntholo-cert-blank-"));
      try {
        await writeMigrationFolder(directory, 13);
        await migrate(database, { migrationsFolder: directory });
        const state = await database.pool.query(
          `select (select count(*)::int from drizzle.__drizzle_migrations) journal_count,
            to_regclass('public.certificate_records')::text certificate_table`,
        );
        expect(state.rows).toEqual([{ certificate_table: "certificate_records", journal_count: 13 }]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  }, 60_000);

  it("upgrades an unpopulated published 0012 database to 0013", async () => {
    await withDisposableDatabase("prior", async (database) => {
      const prior = await mkdtemp(join(tmpdir(), "syntholo-cert-prior-"));
      const current = await mkdtemp(join(tmpdir(), "syntholo-cert-current-"));
      try {
        await writeMigrationFolder(prior, 12);
        await writeMigrationFolder(current, 13);
        await migrate(database, { migrationsFolder: prior });
        expect((await database.pool.query("select count(*)::int count from drizzle.__drizzle_migrations")).rows)
          .toEqual([{ count: 12 }]);
        await migrate(database, { migrationsFolder: current });
        expect((await database.pool.query("select count(*)::int count from drizzle.__drizzle_migrations")).rows)
          .toEqual([{ count: 13 }]);
      } finally {
        await Promise.all([
          rm(prior, { force: true, recursive: true }),
          rm(current, { force: true, recursive: true }),
        ]);
      }
    });
  }, 60_000);

  it("replays 0013 without adding journal rows or changing readiness", async () => {
    await withDisposableDatabase("repeat", async (database) => {
      const directory = await mkdtemp(join(tmpdir(), "syntholo-cert-repeat-"));
      try {
        await writeMigrationFolder(directory, 13);
        await migrate(database, { migrationsFolder: directory });
        const before = await database.pool.query("select * from syntholo_certificates_readiness_v1()");
        await migrate(database, { migrationsFolder: directory });
        const after = await database.pool.query("select * from syntholo_certificates_readiness_v1()");
        expect(after.rows).toEqual(before.rows);
        expect((await database.pool.query("select count(*)::int count from drizzle.__drizzle_migrations")).rows)
          .toEqual([{ count: 13 }]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  }, 60_000);

  it("preserves populated 0012 learning rows without direct jobs during upgrade", async () => {
    await withDisposableDatabase("populated", async (database) => {
      const prior = await mkdtemp(join(tmpdir(), "syntholo-cert-populated-prior-"));
      const current = await mkdtemp(join(tmpdir(), "syntholo-cert-populated-current-"));
      try {
        await writeMigrationFolder(prior, 12);
        await writeMigrationFolder(current, 13);
        await migrate(database, { migrationsFolder: prior });
        const base = await seedBase(database);
        const courseId = randomUUID();
        const previewId = randomUUID();
        const courseVersionId = randomUUID();
        const accessId = randomUUID();
        const enrollmentId = randomUUID();
        const completionId = randomUUID();
        const eventId = randomUUID();
        const manifest = "{}";
        const manifestHash = sha256(manifest);
        const source = await database.pool.query<{ id: string }>(
          "select id::text from entitlement_sources where account_id=$1 and offer_code='self_paced' order by created_at,id limit 1",
          [base.accountA],
        );
        const sourceId = source.rows[0]?.id;
        if (sourceId === undefined) throw new Error("CERTIFICATE_TEST_SOURCE_MISSING");
        await database.pool.query("insert into courses(id,slug,title,description) values($1,$2,'Upgrade Course','Upgrade')", [courseId, `upgrade-${randomUUID()}`]);
        await database.pool.query("insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason) values($1::uuid,$2::uuid,1,$3::text,$4::text,$3::jsonb,'[]',$5::uuid,'Upgrade')", [previewId, courseId, manifest, manifestHash, base.staffId]);
        await database.pool.query("insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) values($1,$2,1,'Upgrade Course','Upgrade',$3,$4,$5,'Upgrade')", [courseVersionId, courseId, manifestHash, previewId, base.staffId]);
        await database.pool.query("insert into account_course_accesses(id,account_id,entitlement_source_id,course_id,course_version_id) values($1,$2,$3,$4,$5)", [accessId, base.accountA, sourceId, courseId, courseVersionId]);
        await database.pool.query("insert into enrollments(id,account_id,account_course_access_id,membership_id,course_id,course_version_id) values($1,$2,$3,$4,$5,$6)", [enrollmentId, base.accountA, accessId, base.actorA.membershipId, courseId, courseVersionId]);
        await database.pool.query("insert into course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id,required_lesson_set_hash,completed_at) values($1,$2,$3,$4,$5,$6,$7,'2026-08-15T12:00:00Z')", [completionId, base.accountA, base.actorA.membershipId, enrollmentId, courseId, courseVersionId, "c".repeat(64)]);
        await database.pool.query("insert into certificate_prerequisites(course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) values($1,$2,$3,$4,$5,$6)", [completionId, base.accountA, base.actorA.membershipId, enrollmentId, courseId, courseVersionId]);
        await database.pool.query("insert into outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) values($1::uuid,$2::uuid,'learning.course_completed.v1',$3::text,jsonb_build_object('courseCompletionId',$3::text,'accountId',$2::text,'membershipId',$4::text,'enrollmentId',$5::text,'courseId',$6::text,'courseVersionId',$7::text),1,'pending',0,clock_timestamp(),clock_timestamp(),'2026-08-15T12:00:00Z','member',$8::text,$9::uuid,10,0)", [eventId, base.accountA, completionId, base.actorA.membershipId, enrollmentId, courseId, courseVersionId, base.actorA.identityId, randomUUID()]);
        await migrate(database, { migrationsFolder: current });
        const state = await database.pool.query(
          `select (select count(*)::int from certificate_prerequisites) prerequisites,
            (select count(*)::int from certificate_records) records,
            (select count(*)::int from jobs where type='learning.course_completed.certificate.v1') jobs`,
        );
        expect(state.rows).toEqual([{ jobs: 0, prerequisites: 1, records: 0 }]);
      } finally {
        await Promise.all([
          rm(prior, { force: true, recursive: true }),
          rm(current, { force: true, recursive: true }),
        ]);
      }
    });
  }, 60_000);
});

describeDatabase("certificate PostgreSQL authority", () => {
  let harness: TestDatabaseHarness;
  let memberDatabase: Database;
  let staffDatabase: Database;
  let systemDatabase: Database;
  let workerDatabase: Database;
  let fixture: BaseFixture;
  const suffix = randomUUID().replaceAll("-", "");
  const memberRole = `syntholo_cert_member_${suffix}`;
  const staffRole = `syntholo_cert_staff_${suffix}`;
  const systemRole = `syntholo_cert_system_${suffix}`;
  const workerRole = `syntholo_cert_worker_${suffix}`;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (baseUrl === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
    const memberPassword = randomUUID();
    const staffPassword = randomUUID();
    const systemPassword = randomUUID();
    const workerPassword = randomUUID();
    await harness.database.pool.query(await roleSql(harness.database, "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [memberRole, memberPassword]));
    await harness.database.pool.query(await roleSql(harness.database, "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [staffRole, staffPassword]));
    await harness.database.pool.query(await roleSql(harness.database, "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [systemRole, systemPassword]));
    await harness.database.pool.query(await roleSql(harness.database, "create role %I login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls", [workerRole, workerPassword]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_member_api to %I with inherit true,set false,admin false", [memberRole]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_staff_api to %I with inherit true,set false,admin false", [staffRole]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_system_api to %I with inherit true,set false,admin false", [systemRole]));
    await harness.database.pool.query(await roleSql(harness.database, "grant syntholo_worker to %I with inherit true,set false,admin false", [workerRole]));
    memberDatabase = createDatabase({ url: loginUrl(baseUrl, memberRole, memberPassword), applicationName: "syntholo-certificate-member-integration" });
    staffDatabase = createDatabase({ url: loginUrl(baseUrl, staffRole, staffPassword), applicationName: "syntholo-certificate-staff-integration" });
    systemDatabase = createDatabase({ url: loginUrl(baseUrl, systemRole, systemPassword), applicationName: "syntholo-certificate-system-integration" });
    workerDatabase = createDatabase({ url: loginUrl(baseUrl, workerRole, workerPassword), applicationName: "syntholo-certificate-worker-integration" });
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
    fixture = await seedBase(harness.database);
  });

  afterAll(async () => {
    await Promise.allSettled([
      memberDatabase?.close(),
      staffDatabase?.close(),
      systemDatabase?.close(),
      workerDatabase?.close(),
    ]);
    if (harness !== undefined) {
      await harness.reset().catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_member_api from %I", [memberRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_staff_api from %I", [staffRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_system_api from %I", [systemRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "revoke syntholo_worker from %I", [workerRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [memberRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [staffRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [systemRole])).catch(() => undefined);
      await harness.database.pool.query(await roleSql(harness.database, "drop role if exists %I", [workerRole])).catch(() => undefined);
      await harness.close();
    }
  });

  it("attests the exact thirteen-row journal and every certificate readiness predicate", async () => {
    const migration = await readFile(new URL("../drizzle/0013_certificates.sql", import.meta.url));
    const journal = await harness.database.pool.query<{ created_at: string; hash: string }>(
      "select created_at::text,hash from drizzle.__drizzle_migrations order by created_at,id",
    );
    expect(journal.rows).toHaveLength(14);
    expect(journal.rows[12]).toEqual({
      created_at: String(certificateMigrationWhen),
      hash: sha256(migration),
    });
    const readiness = await harness.database.pool.query("select * from syntholo_certificates_readiness_v1()");
    expect(readiness.rows).toEqual([{
      contract_version: "0013_certificates.v1",
      font_manifest_hash: "08b07f94c69e07cf51395aaa8057a4f5c2aebd1571fcf50e32baa89e9c881f96",
      function_acl_ready: true,
      function_ready: true,
      implementation_completion_is_authority: false,
      implementation_migration_hash: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
      independence_ready: true,
      immutability_ready: true,
      migration_created_at: String(certificateMigrationWhen),
      migration_hash: sha256(migration),
      policy_ready: true,
      public_execute_denied: true,
      receipt_binding_ready: true,
      rls_ready: true,
      structure_ready: true,
      table_acl_ready: true,
      table_ready: true,
      upstream_ready: true,
    }]);
  });

  it("detects catalog, collation, check, FK, index, and trigger readiness drift", async () => {
    await expectReadinessMutation(
      harness.database,
      "alter table certificate_records alter column renderer_version set default 'certificate-pdf.v2'",
      "structure_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter table certificate_delivery_requests alter column reason type text collate \"C\"",
      "structure_ready",
    );
    await expectReadinessMutation(harness.database, [
      "alter table certificate_delivery_requests drop constraint certificate_delivery_requests_status_check",
      "alter table certificate_delivery_requests add constraint certificate_delivery_requests_status_check check(status='DELIVERY_PENDING')",
    ], "structure_ready");
    await expectReadinessMutation(
      harness.database,
      "alter table memberships drop constraint memberships_id_account_identity_unique cascade",
      "upstream_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "drop index certificate_records_member_history_idx",
      "structure_ready",
    );
    await expectReadinessMutation(harness.database, [
      "drop trigger certificate_records_guard on certificate_records",
      "create trigger certificate_records_guard before update or delete on certificate_records for each row when(false) execute function syntholo_certificate_record_guard_v1()",
    ], "immutability_ready");
    await expectReadinessMutation(
      harness.database,
      "alter table certificate_files disable trigger certificate_files_immutable",
      "immutability_ready",
    );
  });

  it("detects RLS, policy, table, column, and function ACL readiness drift", async () => {
    await expectReadinessMutation(
      harness.database,
      "alter table certificate_records disable row level security",
      "rls_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter policy certificate_records_migrator on certificate_records using(false) with check(false)",
      "policy_ready",
    );
    await expectReadinessMutation(harness.database, [
      "drop policy certificate_files_migrator on certificate_files",
      "create policy certificate_files_migrator on certificate_files as permissive for all to public using(true) with check(true)",
    ], "policy_ready");
    await expectReadinessMutation(
      harness.database,
      "grant select on certificate_records to syntholo_member_api",
      "table_acl_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "grant select(status) on certificate_records to syntholo_member_api",
      "table_acl_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "grant execute on function syntholo_certificate_retry_v1(uuid,uuid,integer,integer,text,integer,text,text) to syntholo_worker with grant option",
      "function_acl_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "grant execute on function syntholo_certificate_retry_v1(uuid,uuid,integer,integer,text,integer,text,text) to public",
      "public_execute_denied",
    );
  });

  it("detects function body, metadata, prior-attestation, inventory, and forbidden-dependency drift", async () => {
    await expectReadinessMutation(
      harness.database,
      `create or replace function syntholo_certificate_etag_valid_v1(p_value text) returns boolean
        language sql immutable strict parallel safe set search_path=pg_catalog,pg_temp as 'select true'`,
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter function syntholo_certificate_etag_valid_v1(text) volatile",
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter function syntholo_certificate_etag_valid_v1(text) set search_path=public",
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter function syntholo_implementation_readiness_v1() volatile",
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter function syntholo_content_readiness_v1() volatile",
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      "alter function syntholo_attest_runtime_capability(text) set search_path=public",
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      `create or replace function syntholo_claim_jobs(p_limit integer,p_worker text,p_now timestamptz,p_lease_ms integer) returns setof jobs
        language sql volatile security definer set search_path=pg_catalog,public as 'select * from public.jobs where false'`,
      "function_ready",
    );
    await expectReadinessMutation(harness.database, [
      "create role syntholo_certificate_hostile_owner nologin",
      "grant syntholo_certificate_hostile_owner to current_user",
      "grant usage,create on schema public to syntholo_certificate_hostile_owner",
      "alter function syntholo_certificate_etag_valid_v1(text) owner to syntholo_certificate_hostile_owner",
    ], "function_ready");
    await expectReadinessMutation(harness.database, [
      "drop function syntholo_certificate_promote_v1(integer)",
      "create procedure syntholo_certificate_promote_v1(integer) language plpgsql set search_path=pg_catalog,pg_temp as 'begin null; end'",
    ], "function_ready");
    await expectReadinessMutation(
      harness.database,
      "create function syntholo_certificate_hostile_extra_v1() returns integer language sql set search_path=pg_catalog,pg_temp as 'select 1'",
      "function_ready",
    );
    await expectReadinessMutation(
      harness.database,
      `create function syntholo_certificate_hostile_dependency_v1() returns integer language sql stable
        set search_path=pg_catalog,pg_temp as 'select count(*)::integer from public.implementation_artifacts'`,
      "independence_ready",
    );
    await expectReadinessMutation(harness.database, [
      "alter table certificate_records add column hostile_entitlement_source_id uuid",
      "alter table certificate_records add constraint certificate_records_hostile_entitlement_fk foreign key(hostile_entitlement_source_id) references entitlement_sources(id)",
    ], "independence_ready");
  });

  it("detects wrong, missing, and duplicate 0013 journal facts and restores exact readiness", async () => {
    const baseline = await harness.database.pool.query<Record<string, unknown>>(
      "select * from syntholo_certificates_readiness_v1()",
    );
    expect(baseline.rows).toHaveLength(1);
    const expectedHash = baseline.rows[0]?.migration_hash;
    const mutations = [
      "update drizzle.__drizzle_migrations set hash=repeat('f',64) where created_at=1786942800000",
      "delete from drizzle.__drizzle_migrations where created_at=1786942800000",
      "insert into drizzle.__drizzle_migrations(hash,created_at) select hash,created_at from drizzle.__drizzle_migrations where created_at=1786942800000",
    ];
    for (const [index, mutation] of mutations.entries()) {
      const client = await harness.database.pool.connect();
      try {
        await client.query("begin");
        await client.query(mutation);
        const drift = await client.query<Record<string, unknown>>(
          "select * from syntholo_certificates_readiness_v1()",
        );
        if (index === 0) {
          expect(drift.rows).toHaveLength(1);
          expect(drift.rows[0]?.migration_hash).not.toBe(expectedHash);
        } else if (index === 1) {
          expect(drift.rows).toEqual([]);
        } else {
          expect(drift.rows).toHaveLength(2);
        }
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
      expect((await harness.database.pool.query("select * from syntholo_certificates_readiness_v1()")).rows)
        .toEqual(baseline.rows);
    }
  });

  it("permits only the actual member, staff, and worker login capabilities", async () => {
    const memberReady = await memberDatabase.pool.query("select contract_version from syntholo_certificates_readiness_v1()");
    const staffReady = await staffDatabase.pool.query("select contract_version from syntholo_certificates_readiness_v1()");
    const systemReady = await systemDatabase.pool.query("select contract_version from syntholo_certificates_readiness_v1()");
    const workerReady = await workerDatabase.pool.query("select contract_version from syntholo_certificates_readiness_v1()");
    expect(memberReady.rows).toEqual([{ contract_version: "0013_certificates.v1" }]);
    expect(staffReady.rows).toEqual([{ contract_version: "0013_certificates.v1" }]);
    expect(systemReady.rows).toEqual([{ contract_version: "0013_certificates.v1" }]);
    expect(workerReady.rows).toEqual([{ contract_version: "0013_certificates.v1" }]);
    await expect(memberDatabase.pool.query("select syntholo_certificate_promote_v1(1)"))
      .rejects.toThrow(/permission denied|SYNTHOLO_RUNTIME_CAPABILITY_INVALID/u);
    await expect(staffDatabase.pool.query("select syntholo_certificate_recipient_name_get_v1()"))
      .rejects.toThrow(/permission denied|SYNTHOLO_RUNTIME_CAPABILITY_INVALID/u);
    await expect(workerDatabase.pool.query("select syntholo_certificate_create_delivery_v1($1,'x','abcdefghijklmnop',$2)", [randomUUID(), "a".repeat(64)]))
      .rejects.toThrow(/permission denied|SYNTHOLO_RUNTIME_CAPABILITY_INVALID/u);
  });

  it("denies unset and half-scoped member contexts", async () => {
    await expect(memberDatabase.pool.query("select syntholo_certificate_recipient_name_get_v1()"))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
    const client = await memberDatabase.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.account_id',$1,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$2,true)", [fixture.accountA, randomUUID()]);
      await expect(client.query("select syntholo_certificate_recipient_name_get_v1()"))
        .rejects.toThrow("CERTIFICATE_NOT_FOUND");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("enforces the frozen PostgreSQL recipient-name scalar boundary", async () => {
    const accepted = ["Ada Lovelace", "李雷", "ليلى", "आर्या", "נועה", "🚀 Pilot"];
    const rejected = [
      "e\u0301",
      "Ada\u00a0Lovelace",
      "Ada\u202eLovelace",
      String.fromCodePoint(0xfdd0),
      String.fromCodePoint(0x20000),
      "a".repeat(121),
    ];
    const result = await harness.database.pool.query<{ accepted: boolean[]; rejected: boolean[] }>(
      `select
        array(select syntholo_certificate_recipient_name_valid_v1(value) from unnest($1::text[]) value) accepted,
        array(select syntholo_certificate_recipient_name_valid_v1(value) from unnest($2::text[]) value) rejected`,
      [accepted, rejected],
    );
    expect(result.rows).toEqual([{
      accepted: [true, true, true, true, true, true],
      rejected: [false, false, false, false, false, false],
    }]);
  });

  it("denies cross-account, cross-member, and teammate certificate access", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    await expect(memberQuery(memberDatabase, fixture.actorB, "select syntholo_certificates_list_v1(null,null,25) result"))
      .resolves.toEqual([{ result: [] }]);
    await expect(memberQuery(memberDatabase, { ...fixture.actorA, membershipId: fixture.actorB.membershipId }, "select syntholo_certificates_list_v1(null,null,25) result"))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
    await expect(memberQuery(memberDatabase, fixture.teammate, "select syntholo_certificate_download_fence_v1($1)", [(await certificateFor(harness.database, completion.completionId)).id]))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
  });

  it("confirms the first name and replays the exact same scoped command", async () => {
    const key = `certificate-name-${randomUUID()}`;
    const first = await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace", key);
    const replay = await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace", key);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ recipientName: { displayName: "Ada Lovelace", version: 1 }, schemaVersion: 1 });
    const rows = await harness.database.pool.query(
      "select count(*)::int versions,(select current_version from certificate_recipient_name_heads where account_id=$1 and membership_id=$2) current_version from certificate_recipient_name_versions where account_id=$1 and membership_id=$2",
      [fixture.accountA, fixture.actorA.membershipId],
    );
    expect(rows.rows).toEqual([{ current_version: 1, versions: 1 }]);
  });

  it("rejects changed intent under a used name key", async () => {
    const key = `certificate-name-${randomUUID()}`;
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace", key);
    await expect(confirmName(memberDatabase, fixture.actorA, 0, "Grace Hopper", key))
      .rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });

  it("creates a new optimistic name version without rebinding an existing certificate", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const original = await certificateFor(harness.database, completion.completionId);
    expect(original).toMatchObject({ recipient_name_snapshot: "Ada Lovelace", status: "pending" });
    const changed = await confirmName(memberDatabase, fixture.actorA, 1, "Grace Hopper");
    expect(changed).toMatchObject({ recipientName: { displayName: "Grace Hopper", version: 2 } });
    expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({
      recipient_name_snapshot: "Ada Lovelace",
      recipient_name_version_id: original.recipient_name_version_id,
      status: "pending",
    });
  });

  it("reports an in-flight name receipt without creating a version", async () => {
    const key = `certificate-name-${randomUUID()}`;
    const principal = `${fixture.actorA.identityId}:${fixture.actorA.accountId}:${fixture.actorA.membershipId}`;
    const blocker = await harness.database.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtext('certificate-recipient-name.v1'),hashtext($1))", [`${principal}:${key}`]);
      await expect(confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace", key))
        .rejects.toThrow("IDEMPOTENCY_IN_PROGRESS");
      expect((await harness.database.pool.query("select count(*)::int count from certificate_recipient_name_versions")).rows)
        .toEqual([{ count: 0 }]);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  });

  it("scopes the same name key independently across accounts and memberships", async () => {
    const key = `certificate-name-${randomUUID()}`;
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace", key);
    await confirmName(memberDatabase, fixture.actorB, 0, "Grace Hopper", key);
    await confirmName(memberDatabase, fixture.teammate, 0, "Katherine Johnson", key);
    const rows = await harness.database.pool.query("select account_id::text,membership_id::text,display_name from certificate_recipient_name_versions order by display_name");
    expect(rows.rows).toEqual([
      { account_id: fixture.accountA, display_name: "Ada Lovelace", membership_id: fixture.actorA.membershipId },
      { account_id: fixture.accountB, display_name: "Grace Hopper", membership_id: fixture.actorB.membershipId },
      { account_id: fixture.accountA, display_name: "Katherine Johnson", membership_id: fixture.teammate.membershipId },
    ]);
  });

  it("allows exactly one different-key optimistic name contender", async () => {
    const contenders = await Promise.allSettled([
      confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace"),
      confirmName(memberDatabase, fixture.actorA, 0, "Grace Hopper"),
    ]);
    expect(contenders.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter(({ status }) => status === "rejected").map((item) => String((item as PromiseRejectedResult).reason)))
      .toEqual([expect.stringContaining("VERSION_CONFLICT")]);
    expect((await harness.database.pool.query("select count(*)::int count from certificate_recipient_name_versions")).rows)
      .toEqual([{ count: 1 }]);
  });

  it("records and stages an eligibility event exactly once under replay", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA, { prerequisite: false });
    const prerequisite = await workerQuery<{ outcome: string }>(workerDatabase, "select syntholo_learning_record_certificate_prerequisite_v1($1,'learning.certificate_prerequisite_record') outcome", [completion.eventId]);
    const prerequisiteReplay = await workerQuery<{ outcome: string }>(workerDatabase, "select syntholo_learning_record_certificate_prerequisite_v1($1,'learning.certificate_prerequisite_record') outcome", [completion.eventId]);
    expect(prerequisite).toEqual([{ outcome: "recorded" }]);
    expect(prerequisiteReplay).toEqual([{ outcome: "duplicate" }]);
    expect(await stageCandidate(workerDatabase, completion.eventId)).toBe("recorded");
    expect(await stageCandidate(workerDatabase, completion.eventId)).toBe("duplicate");
    const counts = await harness.database.pool.query("select (select count(*)::int from certificate_prerequisites where course_completion_id=$1) prerequisites,(select count(*)::int from certificate_records where course_completion_id=$1) records", [completion.completionId]);
    expect(counts.rows).toEqual([{ prerequisites: 1, records: 1 }]);
  });

  it("converges racing event candidate staging to one immutable record", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    const outcomes = await Promise.all([
      stageCandidate(workerDatabase, completion.eventId),
      stageCandidate(workerDatabase, completion.eventId),
    ]);
    expect(outcomes.sort()).toEqual(["duplicate", "recorded"]);
    expect((await harness.database.pool.query("select count(*)::int count from certificate_records where course_completion_id=$1", [completion.completionId])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("stages name-before-completion directly as pending with one exact job", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const record = await certificateFor(harness.database, completion.completionId);
    expect(record).toMatchObject({ recipient_name_snapshot: "Ada Lovelace", status: "pending" });
    const jobs = await harness.database.pool.query("select type,idempotency_key,payload from jobs where idempotency_key=$1", [`certificate:${completion.completionId}`]);
    expect(jobs.rows).toEqual([{
      idempotency_key: `certificate:${completion.completionId}`,
      payload: { certificateId: record.id, courseCompletionId: completion.completionId },
      type: certificateJobType,
    }]);
  });

  it("binds completion-before-name once and enqueues one job", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({ status: "awaiting_recipient_name" });
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({ recipient_name_snapshot: "Ada Lovelace", status: "pending" });
    expect((await harness.database.pool.query("select count(*)::int count from jobs where idempotency_key=$1", [`certificate:${completion.completionId}`])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("serializes name confirmation with candidate staging on the exact account-membership scope", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await harness.database.pool.query(
      `create function public.syntholo_test_certificate_stage_gate() returns trigger language plpgsql
        set search_path=pg_catalog,pg_temp as $test$
        begin
          perform pg_advisory_xact_lock(hashtext('certificate-stage-test-gate.v1'),hashtext(new.course_completion_id::text));
          return new;
        end $test$`,
    );
    await harness.database.pool.query(
      "create trigger certificate_stage_test_gate before insert on certificate_records for each row execute function public.syntholo_test_certificate_stage_gate()",
    );
    const gate = await harness.database.pool.connect();
    let staging: Promise<string> | undefined;
    let confirmation: Promise<unknown> | undefined;
    let confirmationSettledBeforeStage = false;
    try {
      await gate.query("begin");
      await gate.query(
        "select pg_advisory_xact_lock(hashtext('certificate-stage-test-gate.v1'),hashtext($1))",
        [completion.completionId],
      );
      staging = stageCandidate(workerDatabase, completion.eventId);
      let stageReachedGate = false;
      for (let attempt = 0; attempt < 40 && !stageReachedGate; attempt += 1) {
        const activity = await harness.database.pool.query<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity
            where application_name='syntholo-certificate-worker-integration'
              and query like '%syntholo_certificate_stage_candidate_v1%'
              and wait_event_type='Lock') waiting`,
        );
        stageReachedGate = activity.rows[0]?.waiting === true;
        if (!stageReachedGate) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stageReachedGate).toBe(true);
      confirmation = confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
      void confirmation.then(
        () => { confirmationSettledBeforeStage = true; },
        () => { confirmationSettledBeforeStage = true; },
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(confirmationSettledBeforeStage).toBe(false);
    } finally {
      await gate.query("rollback").catch(() => undefined);
      gate.release();
    }
    try {
      await expect(staging).resolves.toBe("recorded");
      await expect(confirmation).resolves.toMatchObject({ recipientName: { version: 1 } });
      expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({
        recipient_name_snapshot: "Ada Lovelace",
        status: "pending",
      });
      expect((await harness.database.pool.query("select count(*)::int count from jobs where idempotency_key=$1", [`certificate:${completion.completionId}`])).rows)
        .toEqual([{ count: 1 }]);
    } finally {
      await harness.database.pool.query("drop trigger if exists certificate_stage_test_gate on certificate_records");
      await harness.database.pool.query("drop function if exists public.syntholo_test_certificate_stage_gate()");
    }
  });

  it("promotes historical prerequisites once and is replay safe", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    const first = await workerQuery<{ count: number }>(workerDatabase, "select syntholo_certificate_promote_v1(100) count");
    const replay = await workerQuery<{ count: number }>(workerDatabase, "select syntholo_certificate_promote_v1(100) count");
    expect(first).toEqual([{ count: 1 }]);
    expect(replay).toEqual([{ count: 0 }]);
    expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({ status: "awaiting_recipient_name" });
    expect((await harness.database.pool.query("select count(*)::int count from jobs where type=$1", [certificateJobType])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("converges racing promoters without duplicate records or jobs", async () => {
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const results = await Promise.all([
      workerQuery<{ count: number }>(workerDatabase, "select syntholo_certificate_promote_v1(100) count"),
      workerQuery<{ count: number }>(workerDatabase, "select syntholo_certificate_promote_v1(100) count"),
    ]);
    expect(results.flat().map(({ count }) => count).sort()).toEqual([0, 1]);
    expect((await harness.database.pool.query("select count(*)::int count from certificate_records where course_completion_id=$1", [completion.completionId])).rows)
      .toEqual([{ count: 1 }]);
    expect((await harness.database.pool.query("select count(*)::int count from jobs where idempotency_key=$1", [`certificate:${completion.completionId}`])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("enqueues the exact event-bound job provenance and rejects a hostile provenance mutation", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const record = await certificateFor(harness.database, completion.completionId);
    const provenance = await harness.database.pool.query(
      "select account_id::text,source_actor_type,source_actor_id,correlation_id::text,queue,type,idempotency_key,payload,priority,max_attempts from jobs where idempotency_key=$1",
      [`certificate:${completion.completionId}`],
    );
    expect(provenance.rows).toEqual([{
      account_id: completion.accountId,
      correlation_id: completion.correlationId,
      idempotency_key: `certificate:${completion.completionId}`,
      max_attempts: 5,
      payload: { certificateId: record.id, courseCompletionId: completion.completionId },
      priority: 0,
      queue: "default",
      source_actor_id: completion.actorIdentityId,
      source_actor_type: "member",
      type: certificateJobType,
    }]);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await harness.database.pool.query("update jobs set payload=payload||jsonb_build_object('hostile',true) where id=$1", [job.id]);
    await expect(workerQuery(workerDatabase, "select syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)", [job.id, job.workerId, job.attempt, job.generation, job.claimToken]))
      .rejects.toThrow("CERTIFICATE_JOB_FENCE_INVALID");
  });

  it("keeps direct certificate jobs invisible to old or inactive workers", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const normalJobId = randomUUID();
    await harness.database.pool.query(
      `insert into jobs(id,account_id,source_actor_type,source_actor_id,correlation_id,queue,type,idempotency_key,payload,status,priority,attempts,max_attempts,run_at,claim_generation,created_at,updated_at)
       values($1,null,'system','certificate-rollout-test',$2,'default','foundation.rollout_probe.v1',$3,'{}'::jsonb,'queued',0,0,5,date_trunc('milliseconds',clock_timestamp()),0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()))`,
      [normalJobId, randomUUID(), `rollout-probe-${randomUUID()}`],
    );
    const inactive = await harness.database.pool.query<{ id: string; type: string }>(
      "select id::text,type from syntholo_claim_jobs(10,'old-revision-worker',clock_timestamp(),300000)",
    );
    expect(inactive.rows).toEqual([{ id: normalJobId, type: "foundation.rollout_probe.v1" }]);
    const activeWorker = "new-revision-worker-certificate-v1";
    const active = await harness.database.pool.query<{ id: string }>(
      "select id::text from syntholo_claim_jobs(10,$1,clock_timestamp(),300000)",
      [activeWorker],
    );
    expect(active.rows).toHaveLength(1);
    const claimedJob = active.rows[0];
    if (claimedJob === undefined) throw new Error("CERTIFICATE_CAPABILITY_CLAIM_MISSING");
    const fence = await harness.database.pool.query<{ attempts: number; claim_generation: number; claim_token: string }>(
      "select attempts,claim_generation,claim_token::text from jobs where id=$1",
      [claimedJob.id],
    );
    const claimed = fence.rows[0];
    if (claimed === undefined) throw new Error("CERTIFICATE_CAPABILITY_FENCE_MISSING");
    await expect(workerQuery(
      workerDatabase,
      "select syntholo_certificate_load_generation_fence_v1($1,'old-revision-worker',$2,$3,$4)",
      [claimedJob.id, claimed.attempts, claimed.claim_generation, claimed.claim_token],
    )).rejects.toThrow("CERTIFICATE_JOB_FENCE_INVALID");
    await expect(workerQuery(
      workerDatabase,
      "select syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)",
      [claimedJob.id, activeWorker, claimed.attempts, claimed.claim_generation, claimed.claim_token],
    )).resolves.toHaveLength(1);
  });

  it("rejects every corrupted live job and running-attempt fence fact", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    const load = () => workerQuery(
      workerDatabase,
      "select syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)",
      [job.id, job.workerId, job.attempt, job.generation, job.claimToken],
    );
    const mutations = [
      ["update jobs set priority=1 where id=$1", "update jobs set priority=0 where id=$1"],
      ["update jobs set max_attempts=6 where id=$1", "update jobs set max_attempts=5 where id=$1"],
      ["update jobs set worker_id='hostile-worker' where id=$1", "update jobs set worker_id='certificate-integration-worker-certificate-v1' where id=$1"],
      ["update jobs set claimed_at=clock_timestamp()+interval '1 minute' where id=$1", "update jobs j set claimed_at=ja.started_at from job_attempts ja where j.id=$1 and ja.job_id=j.id and ja.attempt=1"],
      ["update job_attempts set claim_token=gen_random_uuid() where job_id=$1 and attempt=1", "update job_attempts set claim_token=$2 where job_id=$1 and attempt=1"],
    ] as const;
    for (const [mutate, restore] of mutations) {
      await harness.database.pool.query(mutate, [job.id]);
      await expect(load()).rejects.toThrow("CERTIFICATE_JOB_FENCE_INVALID");
      await harness.database.pool.query(restore, restore.includes("$2")
        ? [job.id, job.claimToken]
        : [job.id]);
      await expect(load()).resolves.toHaveLength(1);
    }
  });

  it("distinguishes pending, issued, and failed crash acknowledgement states", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const pendingCompletion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, pendingCompletion.eventId);
    const pendingJob = await claimCertificateJob(harness.database, pendingCompletion.completionId);
    const pending = await workerQuery<{ status: string }>(workerDatabase, "select status from syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)", [pendingJob.id, pendingJob.workerId, 1, 1, pendingJob.claimToken]);
    expect(pending).toEqual([{ status: "pending" }]);
    await expect(workerQuery(workerDatabase, "select syntholo_certificate_load_issued_file_v1($1,$2,$3,$4,$5)", [pendingJob.id, pendingJob.workerId, 1, 1, pendingJob.claimToken]))
      .rejects.toThrow("CERTIFICATE_JOB_FENCE_INVALID");

    await finalizeCertificate(workerDatabase, pendingJob);
    const issued = await workerQuery<{ status: string }>(workerDatabase, "select status from syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)", [pendingJob.id, pendingJob.workerId, 1, 1, pendingJob.claimToken]);
    const issuedFile = await workerQuery<{ content_type: string }>(workerDatabase, "select content_type from syntholo_certificate_load_issued_file_v1($1,$2,$3,$4,$5)", [pendingJob.id, pendingJob.workerId, 1, 1, pendingJob.claimToken]);
    expect(issued).toEqual([{ status: "issued" }]);
    expect(issuedFile).toEqual([{ content_type: "application/pdf" }]);

    const failedCompletion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, failedCompletion.eventId);
    const failedJob = await claimCertificateJob(harness.database, failedCompletion.completionId);
    await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'render_failed')", [failedJob.id, failedJob.workerId, 1, 1, failedJob.claimToken]);
    const failed = await workerQuery<{ status: string; failure_code: string }>(workerDatabase, "select status,failure_code from syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)", [failedJob.id, failedJob.workerId, 1, 1, failedJob.claimToken]);
    expect(failed).toEqual([{ failure_code: "render_failed", status: "failed" }]);
    await expect(workerQuery(workerDatabase, "select syntholo_certificate_load_issued_file_v1($1,$2,$3,$4,$5)", [failedJob.id, failedJob.workerId, 1, 1, failedJob.claimToken]))
      .rejects.toThrow("CERTIFICATE_JOB_FENCE_INVALID");
  });

  it("finalizes one exact file idempotently and rejects mismatched acknowledgement", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    const first = await finalizeCertificate(workerDatabase, job);
    const replay = await finalizeCertificate(workerDatabase, job);
    expect(replay).toEqual(first);
    await expect(finalizeCertificate(workerDatabase, job, 4096, "b".repeat(64), "different-etag"))
      .rejects.toThrow("CERTIFICATE_JOB_ACK_MISMATCH");
    const record = await certificateFor(harness.database, completion.completionId);
    const files = await harness.database.pool.query("select certificate_id::text,course_completion_id::text,object_key,access,content_type,byte_length,sha256,etag,renderer_version from certificate_files where certificate_id=$1", [record.id]);
    expect(files.rows).toEqual([{
      access: "private",
      byte_length: 4096,
      certificate_id: record.id,
      content_type: "application/pdf",
      course_completion_id: completion.completionId,
      etag: "certificate-etag",
      object_key: `certificates/v1/${fixture.accountA}/${completion.completionId}.pdf`,
      renderer_version: "certificate-pdf.v1",
      sha256: "b".repeat(64),
    }]);
  });

  it("requeues only storage_failed on the exact same dead-letter job", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'storage_failed')", [job.id, job.workerId, 1, 1, job.claimToken]);
    await deadLetterCertificateJob(workerDatabase, job);
    const record = await certificateFor(harness.database, completion.completionId);
    const candidates = await workerQuery<{ result: Array<Record<string, unknown>> }>(
      workerDatabase,
      "select syntholo_certificate_storage_retry_candidates_v1(25) result",
    );
    expect(candidates[0]?.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: record.id, recovery_job_id: job.id, recovery_attempt: 1, recovery_claim_generation: 1 }),
    ]));
    const retryArguments = [record.id, job.id, 1, 1, "absent", 4096, "b".repeat(64), null] as const;
    const retry = await workerQuery<{ outcome: string }>(
      workerDatabase,
      "select syntholo_certificate_retry_v1($1,$2,$3,$4,$5,$6,$7,$8) outcome",
      retryArguments,
    );
    expect(retry).toEqual([{ outcome: "pending" }]);
    const exactReplay = await workerQuery<{ outcome: string }>(
      workerDatabase,
      "select syntholo_certificate_retry_v1($1,$2,$3,$4,$5,$6,$7,$8) outcome",
      retryArguments,
    );
    expect(exactReplay).toEqual([{ outcome: "duplicate" }]);
    const replay = await workerQuery<{ outcome: string }>(
      workerDatabase,
      "select syntholo_certificate_retry_v1($1,$2,$3,$4,'matching',$5,$6,'later-strong-etag') outcome",
      [record.id, job.id, 1, 1, 4096, "b".repeat(64)],
    );
    expect(replay).toEqual([{ outcome: "prior_decision" }]);
    const hashDrift = await workerQuery<{ outcome: string }>(
      workerDatabase,
      "select syntholo_certificate_retry_v1($1,$2,$3,$4,'absent',$5,$6,null) outcome",
      [record.id, job.id, 1, 1, 4096, "c".repeat(64)],
    );
    expect(hashDrift).toEqual([{ outcome: "prior_decision" }]);
    const exactJob = await harness.database.pool.query("select id::text,status,attempts,claim_token,worker_id,completed_at,last_error_code,last_error_message from jobs where id=$1", [job.id]);
    expect(exactJob.rows).toEqual([{
      attempts: 1,
      claim_token: null,
      completed_at: null,
      id: job.id,
      last_error_code: null,
      last_error_message: null,
      status: "queued",
      worker_id: null,
    }]);
    expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({ failure_code: null, status: "pending" });
    const audit = await harness.database.pool.query(
      "select actor_id,action,payload from audit_events where action='certificate_storage_retry_authorized' and target_id=$1",
      [record.id],
    );
    expect(audit.rows).toEqual([{
      action: "certificate_storage_retry_authorized",
      actor_id: "certificate-recovery.v1",
      payload: {
        attempt: 1,
        byteLength: 4096,
        claimGeneration: 1,
        failureCode: "storage_failed",
        jobId: job.id,
        objectState: "absent",
        sha256: "b".repeat(64),
      },
    }]);

    for (const attempt of [2, 3, 4, 5]) {
      const recoveredJob = await claimQueuedCertificateJob(workerDatabase, job.id);
      expect(recoveredJob).toMatchObject({ attempt, generation: attempt });
      await workerQuery(workerDatabase,
        "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'storage_failed')",
        [recoveredJob.id, recoveredJob.workerId, recoveredJob.attempt, recoveredJob.generation, recoveredJob.claimToken]);
      await deadLetterCertificateJob(workerDatabase, recoveredJob);
      const currentCandidates = await workerQuery<{ result: Array<Record<string, unknown>> }>(
        workerDatabase,
        "select syntholo_certificate_storage_retry_candidates_v1(25) result",
      );
      if (attempt === 5) {
        expect(currentCandidates[0]?.result).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: record.id }),
        ]));
        break;
      }
      expect(currentCandidates[0]?.result).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: record.id, recovery_attempt: attempt, recovery_claim_generation: attempt }),
      ]));
      const recovered = await workerQuery<{ outcome: string }>(workerDatabase,
        "select syntholo_certificate_retry_v1($1,$2,$3,$4,'absent',4096,$5,null) outcome",
        [record.id, job.id, attempt, attempt, "b".repeat(64)]);
      expect(recovered).toEqual([{ outcome: "pending" }]);
    }
    const bounded = await harness.database.pool.query(
      `select (select count(*)::int from audit_events where target_id=$1::text and action='certificate_storage_retry_authorized') authorizations,
        j.status,j.attempts,r.status record_status,r.failure_code
      from jobs j join certificate_records r on r.id=$1 where j.id=$2`,
      [record.id, job.id],
    );
    expect(bounded.rows).toEqual([{
      attempts: 5,
      authorizations: 4,
      failure_code: "storage_failed",
      record_status: "failed",
      status: "dead_letter",
    }]);
  });

  it("rejects storage retry when exact job provenance is mismatched", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'storage_failed')", [job.id, job.workerId, 1, 1, job.claimToken]);
    await deadLetterCertificateJob(workerDatabase, job);
    await harness.database.pool.query("update jobs set payload=payload||jsonb_build_object('hostile',true) where id=$1", [job.id]);
    const record = await certificateFor(harness.database, completion.completionId);
    await expect(workerQuery(workerDatabase, "select syntholo_certificate_retry_v1($1,$2,1,1,'absent',4096,$3,null)", [record.id, job.id, "b".repeat(64)]))
      .rejects.toThrow("CERTIFICATE_RETRY_RECONCILIATION_REQUIRED");
  });

  it("records one exact recovery rejection and makes drift or the opposite decision non-mutating", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'storage_failed')", [job.id, job.workerId, 1, 1, job.claimToken]);
    await deadLetterCertificateJob(workerDatabase, job);
    const record = await certificateFor(harness.database, completion.completionId);
    const reject = await workerQuery<{ outcome: string }>(workerDatabase,
      "select syntholo_certificate_recovery_reject_v1($1,$2,1,1,'object_mismatch') outcome", [record.id, job.id]);
    expect(reject).toEqual([{ outcome: "rejected" }]);
    const exactReplay = await workerQuery<{ outcome: string }>(workerDatabase,
      "select syntholo_certificate_recovery_reject_v1($1,$2,1,1,'object_mismatch') outcome", [record.id, job.id]);
    expect(exactReplay).toEqual([{ outcome: "duplicate" }]);
    const reasonDrift = await workerQuery<{ outcome: string }>(workerDatabase,
      "select syntholo_certificate_recovery_reject_v1($1,$2,1,1,'provider_shape_invalid') outcome", [record.id, job.id]);
    expect(reasonDrift).toEqual([{ outcome: "prior_decision" }]);
    const opposite = await workerQuery<{ outcome: string }>(workerDatabase,
      "select syntholo_certificate_retry_v1($1,$2,1,1,'matching',4096,$3,'strong-etag') outcome", [record.id, job.id, "b".repeat(64)]);
    expect(opposite).toEqual([{ outcome: "prior_decision" }]);
    expect(await certificateFor(harness.database, completion.completionId)).toMatchObject({ failure_code: "storage_failed", status: "failed" });
    const facts = await harness.database.pool.query(
      `select (select count(*)::int from audit_events where target_id=$1::text and action='certificate_storage_retry_rejected') rejected,
        (select count(*)::int from audit_events where target_id=$1::text and action='certificate_storage_retry_authorized') authorized,
        (select status from jobs where id=$2) job_status`,
      [record.id, job.id],
    );
    expect(facts.rows).toEqual([{ authorized: 0, job_status: "dead_letter", rejected: 1 }]);
  });

  it("serializes concurrent recovery authorization and rejection into one exact decision in either order", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    for (const winner of ["authorize", "reject"] as const) {
      const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
      await stageCandidate(workerDatabase, completion.eventId);
      const job = await claimCertificateJob(harness.database, completion.completionId);
      await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'storage_failed')", [job.id, job.workerId, 1, 1, job.claimToken]);
      await deadLetterCertificateJob(workerDatabase, job);
      const record = await certificateFor(harness.database, completion.completionId);
      const authorizeSql = "select syntholo_certificate_retry_v1($1,$2,1,1,'absent',4096,$3,null) outcome";
      const rejectSql = "select syntholo_certificate_recovery_reject_v1($1,$2,1,1,'object_mismatch') outcome";
      const first = await workerDatabase.pool.connect();
      const second = await workerDatabase.pool.connect();
      try {
        await first.query("begin");
        await second.query("begin");
        await setWorkerContext(first);
        await setWorkerContext(second);
        const firstResult = winner === "authorize"
          ? await first.query<{ outcome: string }>(authorizeSql, [record.id, job.id, "b".repeat(64)])
          : await first.query<{ outcome: string }>(rejectSql, [record.id, job.id]);
        let secondSettled = false;
        const secondResult = (winner === "authorize"
          ? second.query<{ outcome: string }>(rejectSql, [record.id, job.id])
          : second.query<{ outcome: string }>(authorizeSql, [record.id, job.id, "b".repeat(64)]))
          .finally(() => { secondSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(secondSettled).toBe(false);
        await first.query("commit");
        const loser = await secondResult;
        await second.query("commit");
        expect(firstResult.rows).toEqual([{ outcome: winner === "authorize" ? "pending" : "rejected" }]);
        expect(loser.rows).toEqual([{ outcome: "prior_decision" }]);
      } finally {
        await first.query("rollback").catch(() => undefined);
        await second.query("rollback").catch(() => undefined);
        first.release();
        second.release();
      }
      const facts = await harness.database.pool.query(
        `select count(*)::int decisions,
          count(*) filter(where action='certificate_storage_retry_authorized')::int authorized,
          count(*) filter(where action='certificate_storage_retry_rejected')::int rejected
        from audit_events where target_id=$1::text and action in('certificate_storage_retry_authorized','certificate_storage_retry_rejected')`,
        [record.id],
      );
      expect(facts.rows).toEqual([winner === "authorize"
        ? { authorized: 1, decisions: 1, rejected: 0 }
        : { authorized: 0, decisions: 1, rejected: 1 }]);
    }
  });

  it("never accepts malformed reserved recovery audit provenance as a decision", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'storage_failed')", [job.id, job.workerId, 1, 1, job.claimToken]);
    await deadLetterCertificateJob(workerDatabase, job);
    const record = await certificateFor(harness.database, completion.completionId);
    await ownerQuery(harness.database,
      `insert into audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
        values($1,$2,'system','malformed-recovery-actor','certificate_storage_retry_authorized','certificate',$3,$4,$5::jsonb,date_trunc('milliseconds',clock_timestamp()))`,
      [randomUUID(), fixture.accountA, record.id, completion.correlationId, JSON.stringify({
        failureCode: "storage_failed",
        jobId: job.id,
        attempt: 1,
        claimGeneration: 1,
        objectState: "absent",
        byteLength: 4096,
        sha256: "b".repeat(64),
      })]);
    const candidates = await workerQuery<{ result: Array<Record<string, unknown>> }>(workerDatabase,
      "select syntholo_certificate_storage_retry_candidates_v1(25) result");
    expect(candidates[0]?.result).toEqual(expect.arrayContaining([expect.objectContaining({ id: record.id })]));
    await expect(workerQuery(workerDatabase,
      "select syntholo_certificate_retry_v1($1,$2,1,1,'absent',4096,$3,null)",
      [record.id, job.id, "b".repeat(64)]))
      .rejects.toThrow("CERTIFICATE_RETRY_RECONCILIATION_REQUIRED");
    const after = await workerQuery<{ result: Array<Record<string, unknown>> }>(workerDatabase,
      "select syntholo_certificate_storage_retry_candidates_v1(25) result");
    expect(after[0]?.result).toEqual(expect.arrayContaining([expect.objectContaining({ id: record.id })]));
  });

  it("keeps render_failed terminal", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await workerQuery(workerDatabase, "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'render_failed')", [job.id, job.workerId, 1, 1, job.claimToken]);
    await deadLetterCertificateJob(workerDatabase, job);
    const record = await certificateFor(harness.database, completion.completionId);
    await expect(workerQuery(workerDatabase, "select syntholo_certificate_retry_v1($1,$2,1,1,'absent',4096,$3,null)", [record.id, job.id, "b".repeat(64)]))
      .rejects.toThrow("CERTIFICATE_RETRY_RECONCILIATION_REQUIRED");
  });

  it("authorizes staff delivery before replay and freezes one audited pending fact", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await finalizeCertificate(workerDatabase, job);
    const certificate = await certificateFor(harness.database, completion.completionId);
    const key = `certificate-delivery-${randomUUID()}`;
    const first = await createDelivery(staffDatabase, fixture.staffId, certificate.id, "Customer requested recovery", key);
    const replay = await createDelivery(staffDatabase, fixture.staffId, certificate.id, "Customer requested recovery", key);
    expect(first).toEqual({ status: "delivery_pending" });
    expect(replay).toEqual(first);
    const facts = await harness.database.pool.query(
      `select (select count(*)::int from certificate_delivery_requests where certificate_id=$1) requests,
        (select count(*)::int from audit_events where action='certificate_delivery_requested' and target_id=$1::text) audits,
        (select count(*)::int from api_command_receipts where route_template='/v1/staff/certificates/:certificateId/deliveries' and idempotency_key=$2) receipts`,
      [certificate.id, key],
    );
    expect(facts.rows).toEqual([{ audits: 1, receipts: 1, requests: 1 }]);
    await harness.database.pool.query("update staff_identities set status='disabled' where id=$1", [fixture.staffId]);
    await expect(createDelivery(staffDatabase, fixture.staffId, certificate.id, "Customer requested recovery", key))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
  });

  it("creates no receipt, request, or audit for unknown, unissued, failed, or file-missing delivery targets", async () => {
    const awaitingCompletion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, awaitingCompletion.eventId);
    const awaiting = await certificateFor(harness.database, awaitingCompletion.completionId);
    await expect(createDelivery(staffDatabase, fixture.staffId, randomUUID(), "Unknown target"))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
    await expect(createDelivery(staffDatabase, fixture.staffId, awaiting.id, "Awaiting target"))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");

    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const failedJob = await claimCertificateJob(harness.database, awaitingCompletion.completionId);
    await workerQuery(
      workerDatabase,
      "select syntholo_certificate_mark_failed_v1($1,$2,$3,$4,$5,'render_failed')",
      [failedJob.id, failedJob.workerId, 1, 1, failedJob.claimToken],
    );
    await expect(createDelivery(staffDatabase, fixture.staffId, awaiting.id, "Failed target"))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");

    const issuedCompletion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, issuedCompletion.eventId);
    await finalizeCertificate(workerDatabase, await claimCertificateJob(harness.database, issuedCompletion.completionId));
    const issued = await certificateFor(harness.database, issuedCompletion.completionId);
    await harness.database.pool.query("alter table certificate_files disable trigger certificate_files_immutable");
    try {
      await harness.database.pool.query("delete from certificate_files where certificate_id=$1", [issued.id]);
    } finally {
      await harness.database.pool.query("alter table certificate_files enable trigger certificate_files_immutable");
    }
    await expect(createDelivery(staffDatabase, fixture.staffId, issued.id, "Missing file target"))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");

    const facts = await harness.database.pool.query(
      `select
        (select count(*)::int from api_command_receipts where route_template='/v1/staff/certificates/:certificateId/deliveries') receipts,
        (select count(*)::int from certificate_delivery_requests) requests,
        (select count(*)::int from audit_events where action='certificate_delivery_requested') audits`,
    );
    expect(facts.rows).toEqual([{ audits: 0, receipts: 0, requests: 0 }]);
  });

  it("treats a reused delivery key for another certificate as changed intent", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const firstCompletion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    const secondCompletion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, firstCompletion.eventId);
    await stageCandidate(workerDatabase, secondCompletion.eventId);
    await finalizeCertificate(workerDatabase, await claimCertificateJob(harness.database, firstCompletion.completionId));
    await finalizeCertificate(workerDatabase, await claimCertificateJob(harness.database, secondCompletion.completionId));
    const first = await certificateFor(harness.database, firstCompletion.completionId);
    const second = await certificateFor(harness.database, secondCompletion.completionId);
    const key = `certificate-delivery-${randomUUID()}`;
    await createDelivery(staffDatabase, fixture.staffId, first.id, "Recovery", key);
    await expect(createDelivery(staffDatabase, fixture.staffId, second.id, "Recovery", key))
      .rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(createDelivery(staffDatabase, fixture.staffId, randomUUID(), "Recovery", key))
      .rejects.toThrow("CERTIFICATE_NOT_FOUND");
  });

  it("loses the staff delivery authorization race when revocation commits first", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    await finalizeCertificate(workerDatabase, await claimCertificateJob(harness.database, completion.completionId));
    const certificate = await certificateFor(harness.database, completion.completionId);
    const revocation = await harness.database.pool.connect();
    let delivery: Promise<unknown> | undefined;
    try {
      await revocation.query("begin");
      await revocation.query("update staff_identities set status='disabled' where id=$1", [fixture.staffId]);
      let settled = false;
      delivery = createDelivery(staffDatabase, fixture.staffId, certificate.id, "Recovery after revocation");
      void delivery.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await revocation.query("commit");
    } finally {
      await revocation.query("rollback").catch(() => undefined);
      revocation.release();
    }
    await expect(delivery).rejects.toThrow("CERTIFICATE_NOT_FOUND");
    expect((await harness.database.pool.query("select count(*)::int count from certificate_delivery_requests")).rows)
      .toEqual([{ count: 0 }]);
  });

  it("commits a delivery-first staff command before a racing revocation", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    await finalizeCertificate(workerDatabase, await claimCertificateJob(harness.database, completion.completionId));
    const certificate = await certificateFor(harness.database, completion.completionId);
    const deliveryClient = await staffDatabase.pool.connect();
    let revocation: Promise<unknown> | undefined;
    try {
      await deliveryClient.query("begin");
      await setStaffContext(deliveryClient, fixture.staffId);
      const reason = "Delivery wins revocation race";
      const key = `certificate-delivery-${randomUUID()}`;
      const response = await deliveryClient.query<{ result: unknown }>(
        "select syntholo_certificate_create_delivery_v1($1,$2,$3,$4) result",
        [certificate.id, reason, key, deliveryRequestHash(certificate.id, reason)],
      );
      expect(response.rows).toEqual([{ result: { status: "delivery_pending" } }]);
      let revocationSettled = false;
      revocation = harness.database.pool.query(
        "update staff_identities set status='disabled' where id=$1",
        [fixture.staffId],
      );
      void revocation.then(
        () => { revocationSettled = true; },
        () => { revocationSettled = true; },
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(revocationSettled).toBe(false);
      await deliveryClient.query("commit");
    } finally {
      await deliveryClient.query("rollback").catch(() => undefined);
      deliveryClient.release();
    }
    await expect(revocation).resolves.toBeDefined();
    const state = await harness.database.pool.query(
      `select
        (select status from staff_identities where id=$1) staff_status,
        (select count(*)::int from api_command_receipts where route_template='/v1/staff/certificates/:certificateId/deliveries') receipts,
        (select count(*)::int from certificate_delivery_requests where certificate_id=$2) requests,
        (select count(*)::int from audit_events where action='certificate_delivery_requested' and target_id=$2::text) audits`,
      [fixture.staffId, certificate.id],
    );
    expect(state.rows).toEqual([{ audits: 1, receipts: 1, requests: 1, staff_status: "disabled" }]);
  });

  it("rejects hostile mutation of immutable names, heads, records, files, and delivery facts", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const record = await certificateFor(harness.database, completion.completionId);
    const name = await harness.database.pool.query<{ id: string }>("select id::text from certificate_recipient_name_versions where account_id=$1", [fixture.accountA]);
    const nameId = name.rows[0]?.id;
    expect(nameId).toBeDefined();
    await expect(harness.database.pool.query("update certificate_recipient_name_versions set display_name='Mallory' where id=$1", [nameId]))
      .rejects.toThrow("CERTIFICATE_IMMUTABLE");
    await expect(harness.database.pool.query("delete from certificate_recipient_name_heads where account_id=$1 and membership_id=$2", [fixture.accountA, fixture.actorA.membershipId]))
      .rejects.toThrow("CERTIFICATE_NAME_HEAD_IMMUTABLE");
    await expect(harness.database.pool.query("update certificate_recipient_name_heads set current_version=current_version+2 where account_id=$1 and membership_id=$2", [fixture.accountA, fixture.actorA.membershipId]))
      .rejects.toThrow("CERTIFICATE_NAME_HEAD_IMMUTABLE");
    await expect(harness.database.pool.query("update certificate_records set business_name_snapshot='Hostile' where id=$1", [record.id]))
      .rejects.toThrow("CERTIFICATE_RECORD_IMMUTABLE");
    await expect(harness.database.pool.query("update certificate_records set recipient_name_snapshot='Mallory' where id=$1", [record.id]))
      .rejects.toThrow(/CERTIFICATE_TRANSITION_INVALID|foreign key/u);

    const job = await claimCertificateJob(harness.database, completion.completionId);
    await finalizeCertificate(workerDatabase, job);
    await createDelivery(staffDatabase, fixture.staffId, record.id, "Recovery");
    await expect(harness.database.pool.query("update certificate_files set etag='hostile' where certificate_id=$1", [record.id]))
      .rejects.toThrow("CERTIFICATE_IMMUTABLE");
    await expect(harness.database.pool.query("delete from certificate_delivery_requests where certificate_id=$1", [record.id]))
      .rejects.toThrow("CERTIFICATE_IMMUTABLE");
  });

  it("redacts both unsafe immutable snapshots from awaiting and failed member lists", async () => {
    const unsupported = String.fromCodePoint(0x20000);
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA, {
      businessName: `Unsafe Business ${unsupported}`,
      courseTitle: `Unsafe Course ${unsupported}`,
    });
    await stageCandidate(workerDatabase, completion.eventId);
    const awaiting = await memberQuery<{ result: Array<Record<string, unknown>> }>(memberDatabase, fixture.actorA, "select syntholo_certificates_list_v1(null,null,25) result");
    expect(awaiting[0]?.result).toEqual([expect.objectContaining({
      businessName: null,
      courseTitle: null,
      failureCode: null,
      snapshotRenderable: false,
      status: "awaiting_recipient_name",
    })]);
    expect(JSON.stringify(awaiting)).not.toContain(unsupported);
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const failed = await memberQuery<{ result: Array<Record<string, unknown>> }>(memberDatabase, fixture.actorA, "select syntholo_certificates_list_v1(null,null,25) result");
    expect(failed[0]?.result).toEqual([expect.objectContaining({
      businessName: null,
      courseTitle: null,
      failureCode: "snapshot_not_renderable",
      recipientName: "Ada Lovelace",
      snapshotRenderable: false,
      status: "failed",
    })]);
    expect(JSON.stringify(failed)).not.toContain(unsupported);
    expect((await harness.database.pool.query("select count(*)::int count from jobs where type=$1", [certificateJobType])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("keeps certificate snapshots independent of 0012 and commerce/access state", async () => {
    await confirmName(memberDatabase, fixture.actorA, 0, "Ada Lovelace");
    const completion = await seedCompletion(harness.database, workerDatabase, fixture.actorA);
    await stageCandidate(workerDatabase, completion.eventId);
    const job = await claimCertificateJob(harness.database, completion.completionId);
    await finalizeCertificate(workerDatabase, job);
    const before = await harness.database.pool.query(
      `select r.id::text,r.business_name_snapshot,r.course_title_snapshot,r.recipient_name_snapshot,r.status,
        f.object_key,f.sha256,f.etag,
        (select jsonb_agg(to_jsonb(v) order by v.version) from certificate_recipient_name_versions v where v.account_id=r.account_id and v.membership_id=r.membership_id) name_versions,
        (select to_jsonb(h) from certificate_recipient_name_heads h where h.account_id=r.account_id and h.membership_id=r.membership_id) name_head
        from certificate_records r join certificate_files f on f.certificate_id=r.id where r.course_completion_id=$1`,
      [completion.completionId],
    );
    const access = await harness.database.pool.query<{ id: string }>(
      "select account_course_access_id::text id from enrollments where id=$1",
      [completion.enrollmentId],
    );
    const accessId = access.rows[0]?.id;
    if (accessId === undefined) throw new Error("CERTIFICATE_TEST_ACCESS_MISSING");
    expect(await systemQuery<{ outcome: string }>(
      systemDatabase,
      fixture.accountA,
      "select syntholo_implementation_seed_workspace_v1($1) outcome",
      [accessId],
    )).toEqual([{ outcome: "seeded" }]);
    const artifacts = await harness.database.pool.query<{ id: string; kind: ArtifactContent["kind"] }>(
      "select id::text,kind from implementation_artifacts where account_id=$1 and course_id=$2",
      [fixture.accountA, completion.courseId],
    );
    const artifactByKind = Object.fromEntries(artifacts.rows.map(({ id, kind }) => [kind, id])) as Record<ArtifactContent["kind"], string>;
    await saveImplementationVersion(memberDatabase, fixture.actorA, artifactByKind.readiness_map, 0, "draft", {
      kind: "readiness_map",
      priorities: [],
      notes: "Draft implementation state",
    });
    await saveImplementationVersion(memberDatabase, fixture.actorA, artifactByKind.readiness_map, 1, "final", implementationFinals.readiness_map);
    await saveImplementationVersion(memberDatabase, fixture.actorA, artifactByKind.ai_policy, 0, "final", implementationFinals.ai_policy);
    await saveImplementationVersion(memberDatabase, fixture.actorA, artifactByKind.enablement_checklist, 0, "final", implementationFinals.enablement_checklist);
    await saveImplementationVersion(memberDatabase, fixture.actorA, artifactByKind.roadmap, 0, "final", implementationFinals.roadmap);
    await saveImplementationVersion(memberDatabase, fixture.actorA, artifactByKind.workflow_portfolio, 0, "final", implementationFinals.workflow_portfolio);
    const implementationStates = await harness.database.pool.query(
      `select
        (select count(*)::int from implementation_artifact_versions where state='draft') drafts,
        (select count(*)::int from implementation_artifact_versions where state='final') finals,
        (select count(*)::int from implementation_completions where account_id=$1 and course_id=$2) completions`,
      [fixture.accountA, completion.courseId],
    );
    expect(implementationStates.rows).toEqual([{ completions: 1, drafts: 1, finals: 5 }]);
    const source = await harness.database.pool.query<{ id: string }>(
      `select s.id::text from entitlement_sources s
        join account_course_accesses a on a.entitlement_source_id=s.id
        join enrollments e on e.account_course_access_id=a.id where e.id=$1`,
      [completion.enrollmentId],
    );
    const sourceId = source.rows[0]?.id;
    if (sourceId === undefined) throw new Error("CERTIFICATE_TEST_SOURCE_MISSING");
    const holdSource = randomUUID();
    const hold = randomUUID();
    await harness.database.pool.query(
      "insert into account_hold_sources(id,account_id,source_kind,source_id,target_source_registry_id,created_at) values($1,$2,'stripe_dispute',$3,$4,'2026-08-15T00:00:00.000Z')",
      [holdSource, fixture.accountA, `dispute-${randomUUID()}`, sourceId],
    );
    await harness.database.pool.query(
      "insert into account_holds(id,account_id,source_registry_id,kind,created_at) values($1,$2,$3,'commerce','2026-08-15T00:00:00.000Z')",
      [hold, fixture.accountA, holdSource],
    );
    const subscriptionSource = randomUUID();
    const subscriptionExternalId = `business-os-${randomUUID()}`;
    const subscriptionClient = await harness.database.pool.connect();
    try {
      await subscriptionClient.query("begin");
      await subscriptionClient.query(
        `insert into entitlement_sources(id,account_id,source_kind,source_id,offer_code,provenance,created_at)
          values($1,$2,'subscription',$3,'business_os','independence','2026-08-15T00:00:00.000Z')`,
        [subscriptionSource, fixture.accountA, subscriptionExternalId],
      );
      await subscriptionClient.query(
        `insert into entitlement_grants
          (account_id,source_registry_id,source_kind,source_id,offer_code,capability,status,starts_at,ends_at,provenance,created_at,updated_at)
          values($1,$2,'subscription',$3,'business_os','business_os','active','2026-08-15T00:00:00.000Z','2027-08-15T00:00:00.000Z','independence','2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z')`,
        [fixture.accountA, subscriptionSource, subscriptionExternalId],
      );
      await subscriptionClient.query("commit");
    } catch (error) {
      await subscriptionClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      subscriptionClient.release();
    }
    const revocationClient = await harness.database.pool.connect();
    try {
      await revocationClient.query("begin");
      await revocationClient.query(
        `update entitlement_grants set status=case
          when capability='business_os' then 'grace' else 'revoked' end,
          updated_at='2026-08-15T01:00:00.000Z' where account_id=$1`,
        [fixture.accountA],
      );
      await revocationClient.query("update seat_reservations set state='revoked',updated_at='2026-08-15T01:00:00.000Z' where source_registry_id=$1", [sourceId]);
      await revocationClient.query("update account_holds set released_at='2026-08-15T01:00:00.000Z' where id=$1", [hold]);
      await revocationClient.query("update account_course_accesses set status='revoked' where id in(select account_course_access_id from enrollments where id=$1)", [completion.enrollmentId]);
      await revocationClient.query("update enrollments set status='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()) where id=$1", [completion.enrollmentId]);
      await revocationClient.query("update memberships set status='revoked',updated_at=date_trunc('milliseconds',clock_timestamp()) where account_id=$1", [fixture.accountA]);
      await revocationClient.query("commit");
    } catch (error) {
      await revocationClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      revocationClient.release();
    }
    const laterPreview = randomUUID();
    const laterVersion = randomUUID();
    await harness.database.pool.query(
      `insert into content_previews(id,course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason)
        values($1,$2,2,'{}',$3,'{}','[]',$4,'Later publication')`,
      [laterPreview, completion.courseId, sha256("{}"), fixture.staffId],
    );
    await harness.database.pool.query(
      `insert into course_versions(id,course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason)
        values($1,$2,2,'Later Course Title','Later publication',$3,$4,$5,'Later publication')`,
      [laterVersion, completion.courseId, sha256("{}"), laterPreview, fixture.staffId],
    );
    const after = await harness.database.pool.query(
      `select r.id::text,r.business_name_snapshot,r.course_title_snapshot,r.recipient_name_snapshot,r.status,
        f.object_key,f.sha256,f.etag,
        (select jsonb_agg(to_jsonb(v) order by v.version) from certificate_recipient_name_versions v where v.account_id=r.account_id and v.membership_id=r.membership_id) name_versions,
        (select to_jsonb(h) from certificate_recipient_name_heads h where h.account_id=r.account_id and h.membership_id=r.membership_id) name_head
        from certificate_records r join certificate_files f on f.certificate_id=r.id where r.course_completion_id=$1`,
      [completion.completionId],
    );
    expect(after.rows).toEqual(before.rows);
    const dependencies = await harness.database.pool.query(
      `select count(*)::int count from pg_constraint c
        join pg_class source on source.oid=c.conrelid
        join pg_class target on target.oid=c.confrelid
        where source.relname like 'certificate_%'
          and target.relname~'(implementation_|entitlement_|commerce_|product_|subscription_|support_|circle_|business_os_|club_subscription_|seat_|account_hold|account_course_access)'`,
    );
    expect(dependencies.rows).toEqual([{ count: 0 }]);
  });
});
