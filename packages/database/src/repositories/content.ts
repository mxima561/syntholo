import {
  ContentPublicationConflictCodeSchema,
  ContentPublicationIssuesSchema,
  type ContentPublicationConflictCode,
  type ContentPublicationIssue,
} from "@syntholo/contracts/content";
import { canonicalContentManifest, contentManifestHash } from "@syntholo/domain/content";
import type { Database } from "../client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type JsonObject = Readonly<Record<string, unknown>>;

export type CreateContentPreviewInput = Readonly<{
  actorId: string;
  correlationId: string;
  courseId: string;
  expectedVersion: number;
  manifest: JsonObject;
  publicationIssues: readonly ContentPublicationIssue[];
  reason: string;
}>;

export type ContentPreviewRecord = Readonly<{
  previewId: string;
  manifestHash: string;
  manifest: JsonObject;
  publicationIssues: readonly ContentPublicationIssue[];
  createdAt: string;
}>;

export type PublishCourseInput = Readonly<{
  actorId: string;
  correlationId: string;
  courseId: string;
  previewId: string;
  expectedManifestHash: string;
  expectedHeadRevision: number;
  reason: string;
}>;

export type PublishedCourseRecord = Readonly<{
  id: string;
  courseId: string;
  version: number;
  manifestHash: string;
  headRevision: number;
  publishedAt: string;
}>;

export class ContentCommandConflictError extends Error {
  readonly code: ContentPublicationConflictCode;

  constructor(code: ContentPublicationConflictCode) {
    super(code);
    this.name = "ContentCommandConflictError";
    this.code = code;
  }
}

function parsePublicationIssues(value: unknown): readonly ContentPublicationIssue[] {
  const parsed = ContentPublicationIssuesSchema.safeParse(value);
  if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
  return Object.freeze(parsed.data.map((issue) => Object.freeze(issue)));
}

function conflictFrom(error: unknown): ContentCommandConflictError | null {
  const parsed = ContentPublicationConflictCodeSchema.safeParse(
    error instanceof Error ? error.message : undefined,
  );
  return parsed.success ? new ContentCommandConflictError(parsed.data) : null;
}

function validate(input: CreateContentPreviewInput): void {
  if (
    !uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.courseId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || input.reason.trim() === "" || input.reason.length > 1_000
    || !ContentPublicationIssuesSchema.safeParse(input.publicationIssues).success
  ) throw new Error("CONTENT_COMMAND_INVALID");
}

export class StaffContentCommandRepository {
  constructor(private readonly database: Database) {}

  async createPreview(input: CreateContentPreviewInput): Promise<ContentPreviewRecord> {
    validate(input);
    const manifestCanonicalJson = canonicalContentManifest(input.manifest);
    const manifestHash = contentManifestHash(input.manifest);
    const client = await this.database.pool.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      await client.query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const result = await client.query<{
        id: string;
        manifest_hash: string;
        manifest_projection: JsonObject;
        publication_issues: unknown[];
        created_at: Date;
      }>(
        "select (created).id, (created).manifest_hash, (created).manifest_projection, (created).publication_issues, (created).created_at from (select public.syntholo_content_create_preview_v1($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) created) command",
        [input.courseId, input.expectedVersion, manifestCanonicalJson, manifestHash,
          JSON.stringify(input.manifest), JSON.stringify(input.publicationIssues), input.reason],
      );
      const row = result.rows[0];
      if (!row || row.manifest_hash !== manifestHash || !uuid.test(row.id) || !Number.isFinite(row.created_at.getTime())) {
        throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      }
      await client.query("commit");
      open = false;
      return Object.freeze({
        previewId: row.id,
        manifestHash: row.manifest_hash,
        manifest: Object.freeze({ ...row.manifest_projection }),
        publicationIssues: parsePublicationIssues(row.publication_issues),
        createdAt: row.created_at.toISOString(),
      });
    } catch (error) {
      if (open) await client.query("rollback").catch(() => undefined);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      client.release();
    }
  }

  async publishCourse(input: PublishCourseInput): Promise<PublishedCourseRecord> {
    if (
      !uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.courseId)
      || !uuid.test(input.previewId) || !/^[0-9a-f]{64}$/u.test(input.expectedManifestHash)
      || !Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0
      || input.reason.trim() === "" || input.reason.length > 1_000
    ) throw new Error("CONTENT_COMMAND_INVALID");
    const client = await this.database.pool.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      await client.query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const result = await client.query<{
        id: string;
        course_id: string;
        version: number;
        manifest_hash: string;
        head_revision: number;
        published_at: Date;
      }>(
        "select (published).id, (published).course_id, (published).version, (published).manifest_hash, (select head_revision from public.course_heads where course_id=(published).course_id and channel='production') head_revision, (published).published_at from (select public.syntholo_content_publish_course_v1($1,$2,$3,$4) published) command",
        [input.previewId, input.expectedManifestHash, input.expectedHeadRevision, input.reason],
      );
      const row = result.rows[0];
      if (
        !row || !uuid.test(row.id) || row.course_id !== input.courseId
        || row.manifest_hash !== input.expectedManifestHash
        || !Number.isSafeInteger(row.version) || row.version < 1
        || !Number.isSafeInteger(row.head_revision) || row.head_revision !== input.expectedHeadRevision + 1
        || !Number.isFinite(row.published_at.getTime())
      ) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      await client.query("commit");
      open = false;
      return Object.freeze({
        id: row.id,
        courseId: row.course_id,
        version: row.version,
        manifestHash: row.manifest_hash,
        headRevision: row.head_revision,
        publishedAt: row.published_at.toISOString(),
      });
    } catch (error) {
      if (open) await client.query("rollback").catch(() => undefined);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      client.release();
    }
  }
}
