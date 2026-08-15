import {
  ContentPublicationConflictCodeSchema,
  ContentPublicationIssuesSchema,
  DerivedCoursePreviewResponseSchema,
  type ContentPublicationConflictCode,
  type ContentPublicationIssue,
} from "@syntholo/contracts/content";
import { createHash } from "node:crypto";
import type { Database } from "../client.js";
import { z } from "zod";
import {
  acquireMemberReadClient,
  destroyMemberReadLease,
  isMemberReadDeadlineError,
  MEMBER_READ_DEADLINES,
  memberReadParentDeadline,
  runMemberReadCleanupQuery,
  runMemberReadLockQuery,
  runMemberReadQuery,
  translateMemberReadDependencyError,
} from "../member-read-deadlines.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PublishedCourseResultSchema = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  version: z.number().int().positive(),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  headRevision: z.number().int().positive(),
  publishedAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();
const PublishedLessonResultSchema = z.object({
  id: z.string().uuid(), lessonId: z.string().uuid(), courseId: z.string().uuid(),
  version: z.number().int().positive(), contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  publishedAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();
const PreviewCommandResultSchema = z.object({
  previewId: z.string().uuid(),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  manifest: z.record(z.string(), z.unknown()),
  publicationIssues: ContentPublicationIssuesSchema,
  createdAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();

type JsonObject = Readonly<Record<string, unknown>>;

export type CreateContentPreviewInput = Readonly<{
  actorId: string;
  correlationId: string;
  courseId: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}>;

export type GetContentPreviewInput = Readonly<{
  actorId: string;
  correlationId: string;
  courseId: string;
  draftRevision?: number;
}>;

export type DerivedContentPreviewRecord = Readonly<{
  draftRevision: number;
  candidateManifestHash: string;
  manifest: JsonObject;
  publicationIssues: readonly ContentPublicationIssue[];
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
  idempotencyKey: string;
}>;

export type PublishedCourseRecord = Readonly<{
  id: string;
  courseId: string;
  version: number;
  manifestHash: string;
  headRevision: number;
  publishedAt: string;
}>;
export type PublishLessonInput = Readonly<{
  actorId: string; correlationId: string; lessonId: string; expectedVersion: number;
  reason: string; idempotencyKey: string;
}>;
export type PublishedLessonRecord = z.infer<typeof PublishedLessonResultSchema>;

export class ContentCommandConflictError extends Error {
  readonly code: ContentPublicationConflictCode;
  readonly publicationIssues?: readonly ContentPublicationIssue[];

  constructor(code: ContentPublicationConflictCode, publicationIssues?: readonly ContentPublicationIssue[]) {
    super(code);
    this.name = "ContentCommandConflictError";
    this.code = code;
    this.publicationIssues = publicationIssues === undefined
      ? undefined
      : parsePublicationIssues(publicationIssues);
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
  if (!parsed.success) return null;
  let publicationIssues: readonly ContentPublicationIssue[] | undefined;
  if (parsed.data === "CONTENT_NOT_READY" && typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string") {
      try {
        publicationIssues = parsePublicationIssues(JSON.parse(detail) as unknown);
      } catch {
        publicationIssues = undefined;
      }
    }
  }
  return new ContentCommandConflictError(parsed.data, publicationIssues);
}

function validate(input: CreateContentPreviewInput): void {
  if (
    !uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.courseId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || input.reason.trim() === "" || input.reason.length > 1_000
    || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128
  ) throw new Error("CONTENT_COMMAND_INVALID");
}

export class StaffContentCommandRepository {
  constructor(private readonly database: Database) {}

  async getPreview(input: GetContentPreviewInput, parentDeadline = memberReadParentDeadline()): Promise<DerivedContentPreviewRecord> {
    if (!uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.courseId)
      || (input.draftRevision !== undefined && (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 1))) {
      throw new Error("CONTENT_READ_INVALID");
    }
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values);
      await query("begin read only"); open = true;
      await query("select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)", [input.actorId, input.correlationId]);
      const result = await query<{ result: unknown }>(
        "select public.syntholo_content_get_preview_v1($1,$2) result",
        [input.courseId, input.draftRevision ?? null],
      );
      const parsed = DerivedCoursePreviewResponseSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success) throw new Error("CONTENT_READ_RESULT_INVALID");
      await query("commit"); open = false;
      return Object.freeze({
        ...parsed.data,
        manifest: Object.freeze({ ...parsed.data.manifest }),
        publicationIssues: Object.freeze(parsed.data.publicationIssues.map((issue) => Object.freeze(issue))),
      });
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      throw error;
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async createPreview(input: CreateContentPreviewInput, parentDeadline = memberReadParentDeadline()): Promise<ContentPreviewRecord> {
    validate(input);
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values);
      const lockQuery = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadLockQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, values);
      await query("begin");
      open = true;
      await query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const requestHash = createHash("sha256").update(JSON.stringify({
        courseId: input.courseId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      }), "utf8").digest("hex");
      const result = await lockQuery<{ result: unknown }>(
        "select public.syntholo_content_create_preview_v3($1,$2,$3,$4,$5) result",
        [input.courseId, input.expectedVersion, input.reason, input.idempotencyKey, requestHash],
      );
      const parsed = PreviewCommandResultSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      const row = parsed.data;
      await query("commit");
      open = false;
      return Object.freeze({
        previewId: row.previewId,
        manifestHash: row.manifestHash,
        manifest: Object.freeze({ ...row.manifest }),
        publicationIssues: parsePublicationIssues(row.publicationIssues),
        createdAt: row.createdAt,
      });
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback")
          .catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async publishCourse(input: PublishCourseInput, parentDeadline = memberReadParentDeadline()): Promise<PublishedCourseRecord> {
    if (
      !uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.courseId)
      || !uuid.test(input.previewId) || !/^[0-9a-f]{64}$/u.test(input.expectedManifestHash)
      || !Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0
      || input.reason.trim() === "" || input.reason.length > 1_000
      || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128
    ) throw new Error("CONTENT_COMMAND_INVALID");
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values);
      const lockQuery = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadLockQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, values);
      await query("begin");
      open = true;
      await query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [input.actorId, input.correlationId],
      );
      const requestHash = createHash("sha256").update(JSON.stringify({
        courseId: input.courseId,
        previewId: input.previewId,
        expectedManifestHash: input.expectedManifestHash,
        expectedHeadRevision: input.expectedHeadRevision,
        reason: input.reason,
      }), "utf8").digest("hex");
      const result = await lockQuery<{
        result: unknown;
      }>(
        "select public.syntholo_content_publish_course_v2($1,$2,$3,$4,$5,$6) result",
        [input.previewId, input.expectedManifestHash, input.expectedHeadRevision, input.reason, input.idempotencyKey, requestHash],
      );
      const parsed = PublishedCourseResultSchema.safeParse(result.rows[0]?.result);
      const row = parsed.success ? parsed.data : undefined;
      if (
        !row || row.courseId !== input.courseId
        || row.manifestHash !== input.expectedManifestHash
        || !Number.isSafeInteger(row.version) || row.version < 1
        || !Number.isSafeInteger(row.headRevision) || row.headRevision !== input.expectedHeadRevision + 1
      ) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      await query("commit");
      open = false;
      return Object.freeze({
        id: row.id,
        courseId: row.courseId,
        version: row.version,
        manifestHash: row.manifestHash,
        headRevision: row.headRevision,
        publishedAt: row.publishedAt,
      });
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback")
          .catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async publishLesson(input: PublishLessonInput, parentDeadline = memberReadParentDeadline()): Promise<PublishedLessonRecord> {
    if (!uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.lessonId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || input.reason.trim() === "" || input.reason.length > 1_000
      || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) {
      throw new Error("CONTENT_COMMAND_INVALID");
    }
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values);
      const lockQuery = <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => runMemberReadLockQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, values);
      await query("begin"); open = true;
      await query("select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)", [input.actorId, input.correlationId]);
      const requestHash = createHash("sha256").update(JSON.stringify({ lessonId: input.lessonId, expectedVersion: input.expectedVersion, reason: input.reason }), "utf8").digest("hex");
      const result = await lockQuery<{ result: unknown }>(
        "select public.syntholo_content_publish_lesson_v2($1,$2,$3,$4,$5) result",
        [input.lessonId, input.expectedVersion, input.reason, input.idempotencyKey, requestHash],
      );
      const parsed = PublishedLessonResultSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success || parsed.data.lessonId !== input.lessonId) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      await query("commit"); open = false;
      return Object.freeze(parsed.data);
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error); if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}
