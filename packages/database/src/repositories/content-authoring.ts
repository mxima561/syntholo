import {
  AttachLessonMediaResponseSchema,
  ContentAuthoringConflictCodeSchema,
  CourseDraftResponseSchema,
  CourseDraftTreeResponseSchema,
  CourseDraftUpdateResponseSchema,
  CourseListResponseSchema,
  LessonDraftResponseSchema,
  LessonReviewResponseSchema,
  StageDraftResponseSchema,
  type ContentAuthoringConflictCode,
  type LessonBlock,
  type Transcript,
} from "@syntholo/contracts/content";
import { createHash } from "node:crypto";
import type { Database } from "../client.js";
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

export class ContentAuthoringCommandConflictError extends Error {
  readonly code: ContentAuthoringConflictCode;
  constructor(code: ContentAuthoringConflictCode) {
    super(code);
    this.name = "ContentAuthoringCommandConflictError";
    this.code = code;
  }
}

function conflictFrom(error: unknown): ContentAuthoringCommandConflictError | null {
  const parsed = ContentAuthoringConflictCodeSchema.safeParse(
    error instanceof Error ? error.message : undefined,
  );
  return parsed.success ? new ContentAuthoringCommandConflictError(parsed.data) : null;
}

export type CreateCourseDraftInput = Readonly<{
  actorId: string; correlationId: string;
  slug: string; title: string; description: string; idempotencyKey: string;
}>;

export type UpsertStageDraftInput = Readonly<{
  actorId: string; correlationId: string;
  courseId: string; expectedCourseRevision: number; stageId?: string;
  slug: string; title: string; description: string; order: number; idempotencyKey: string;
}>;

export type UpsertLessonDraftInput = Readonly<{
  actorId: string; correlationId: string;
  courseId: string; stageId: string; lessonId?: string;
  slug: string; title: string; summary: string; durationSeconds: number;
  blocks: readonly LessonBlock[]; transcript: Transcript;
  order: number; required: boolean; idempotencyKey: string;
}>;

export type AttachLessonMediaInput = Readonly<{
  actorId: string; correlationId: string;
  lessonId: string; expectedRevision: number;
  environmentId: string; providerAssetId: string; idempotencyKey: string;
}>;

export type RecordLessonReviewInput = Readonly<{
  actorId: string; correlationId: string;
  lessonId: string; expectedRevision: number; reason: string;
}>;

export type UpdateCourseDraftInput = Readonly<{
  actorId: string; correlationId: string;
  courseId: string; expectedRevision: number; title: string; description: string; idempotencyKey: string;
}>;

export type GetCourseDraftTreeInput = Readonly<{
  actorId: string; correlationId: string; courseId: string;
}>;

function validateUuidPair(actorId: string, correlationId: string): void {
  if (!uuid.test(actorId) || !uuid.test(correlationId)) throw new Error("CONTENT_COMMAND_INVALID");
}

export type CourseSummary = Readonly<{
  courseId: string; slug: string; title: string; description: string;
  revision: number; published: boolean; createdAt: string; enrolledCount: number;
}>;

export class StaffContentAuthoringRepository {
  constructor(private readonly database: Database) {}

  async listCourses(
    input: Readonly<{ actorId: string; correlationId: string }>,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<readonly CourseSummary[]> {
    validateUuidPair(input.actorId, input.correlationId);
    const result = await this.runCommand(input.actorId, input.correlationId,
      "select public.syntholo_content_list_courses_v1() result",
      [],
      parentDeadline,
    );
    const parsed = CourseListResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
    return parsed.data.courses;
  }

  private async runCommand<R extends Record<string, unknown>>(
    actorId: string,
    correlationId: string,
    sql: string,
    values: readonly unknown[],
    parentDeadline: number,
  ): Promise<unknown> {
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, params);
      const lockQuery = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadLockQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, params);
      await query("begin");
      open = true;
      await query(
        "select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)",
        [actorId, correlationId],
      );
      const result = await lockQuery<R>(sql, values);
      await query("commit");
      open = false;
      return result.rows[0]?.result;
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async createCourseDraft(input: CreateCourseDraftInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    const requestHash = createHash("sha256").update(JSON.stringify({
      slug: input.slug, title: input.title, description: input.description,
    }), "utf8").digest("hex");
    const result = await this.runCommand(input.actorId, input.correlationId,
      "select public.syntholo_content_create_course_draft_v1($1,$2,$3,$4,$5) result",
      [input.slug, input.title, input.description, input.idempotencyKey, requestHash],
      parentDeadline,
    );
    const parsed = CourseDraftResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
    return Object.freeze(parsed.data);
  }

  async upsertStageDraft(input: UpsertStageDraftInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    if (!uuid.test(input.courseId) || (input.stageId !== undefined && !uuid.test(input.stageId))) {
      throw new Error("CONTENT_COMMAND_INVALID");
    }
    const requestHash = createHash("sha256").update(JSON.stringify({
      courseId: input.courseId, expectedCourseRevision: input.expectedCourseRevision, stageId: input.stageId ?? null,
      slug: input.slug, title: input.title, description: input.description, order: input.order,
    }), "utf8").digest("hex");
    const result = await this.runCommand(input.actorId, input.correlationId,
      "select public.syntholo_content_upsert_stage_draft_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) result",
      [input.courseId, input.expectedCourseRevision, input.stageId ?? null, input.slug, input.title, input.description, input.order, input.idempotencyKey, requestHash],
      parentDeadline,
    );
    const parsed = StageDraftResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
    return Object.freeze(parsed.data);
  }

  async upsertLessonDraft(input: UpsertLessonDraftInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    if (!uuid.test(input.courseId) || !uuid.test(input.stageId) || (input.lessonId !== undefined && !uuid.test(input.lessonId))) {
      throw new Error("CONTENT_COMMAND_INVALID");
    }
    const requestHash = createHash("sha256").update(JSON.stringify({
      courseId: input.courseId, stageId: input.stageId, lessonId: input.lessonId ?? null,
      slug: input.slug, title: input.title, summary: input.summary, durationSeconds: input.durationSeconds,
      blocks: input.blocks, transcript: input.transcript, order: input.order, required: input.required,
    }), "utf8").digest("hex");
    const result = await this.runCommand(input.actorId, input.correlationId,
      "select public.syntholo_content_upsert_lesson_draft_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) result",
      [
        input.courseId, input.stageId, input.lessonId ?? null,
        input.slug, input.title, input.summary, input.durationSeconds,
        JSON.stringify(input.blocks), JSON.stringify(input.transcript), input.order, input.required,
        input.idempotencyKey, requestHash,
      ],
      parentDeadline,
    );
    const parsed = LessonDraftResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
    return Object.freeze(parsed.data);
  }

  async attachLessonMedia(input: AttachLessonMediaInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    if (!uuid.test(input.lessonId)) throw new Error("CONTENT_COMMAND_INVALID");
    const requestHash = createHash("sha256").update(JSON.stringify({
      lessonId: input.lessonId, expectedRevision: input.expectedRevision,
      environmentId: input.environmentId, providerAssetId: input.providerAssetId,
    }), "utf8").digest("hex");
    const result = await this.runCommand(input.actorId, input.correlationId,
      "select public.syntholo_content_attach_lesson_media_v1($1,$2,$3,$4,$5,$6) result",
      [input.lessonId, input.expectedRevision, input.environmentId, input.providerAssetId, input.idempotencyKey, requestHash],
      parentDeadline,
    );
    const parsed = AttachLessonMediaResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
    return Object.freeze(parsed.data);
  }

  async updateCourseDraft(input: UpdateCourseDraftInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    if (!uuid.test(input.courseId)) throw new Error("CONTENT_COMMAND_INVALID");
    const requestHash = createHash("sha256").update(JSON.stringify({
      courseId: input.courseId, expectedRevision: input.expectedRevision,
      title: input.title, description: input.description,
    }), "utf8").digest("hex");
    const result = await this.runCommand(input.actorId, input.correlationId,
      "select public.syntholo_content_update_course_draft_v1($1,$2,$3,$4,$5,$6) result",
      [input.courseId, input.expectedRevision, input.title, input.description, input.idempotencyKey, requestHash],
      parentDeadline,
    );
    const parsed = CourseDraftUpdateResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
    return Object.freeze(parsed.data);
  }

  async getCourseDraftTree(input: GetCourseDraftTreeInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    if (!uuid.test(input.courseId)) throw new Error("CONTENT_COMMAND_INVALID");
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, params);
      await query("begin"); open = true;
      await query("select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)", [input.actorId, input.correlationId]);
      const result = await query<{ result: unknown }>(
        "select public.syntholo_content_get_course_draft_tree_v1($1) result",
        [input.courseId],
      );
      const parsed = CourseDraftTreeResponseSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      await query("commit"); open = false;
      return Object.freeze(parsed.data);
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async recordLessonReview(input: RecordLessonReviewInput, parentDeadline = memberReadParentDeadline()) {
    validateUuidPair(input.actorId, input.correlationId);
    if (!uuid.test(input.lessonId)) throw new Error("CONTENT_COMMAND_INVALID");
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, params);
      const lockQuery = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadLockQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, params);
      await query("begin"); open = true;
      await query("select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)", [input.actorId, input.correlationId]);
      const result = await lockQuery<{ result: unknown }>(
        "select public.syntholo_content_admin_record_lesson_review_v1($1,$2,$3) result",
        [input.lessonId, input.expectedRevision, input.reason],
      );
      const parsed = LessonReviewResponseSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success) throw new Error("CONTENT_COMMAND_RESULT_INVALID");
      await query("commit"); open = false;
      return Object.freeze(parsed.data);
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("CONTENT_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}
