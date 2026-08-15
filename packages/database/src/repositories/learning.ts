import { createHash } from "node:crypto";
import {
  CompleteLessonRequestSchema,
  CompleteLessonResponseSchema,
  MemberCourseResponseSchema,
  MemberLessonProgressSchema,
  MemberLessonResponseSchema,
  ResumeLessonRequestSchema,
  type CompleteLessonRequest,
  type CompleteLessonResponse,
  type MemberCourseResponse,
  type MemberLessonResponse,
  type ResumeLessonRequest,
} from "@syntholo/contracts/learning";
import type { MemberActor } from "@syntholo/domain";
import { z } from "zod";
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
  throwIfMemberReadDeadlineExpired,
  translateMemberReadDependencyError,
} from "../member-read-deadlines.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PlaybackTargetSchema = z.object({
  lessonVersionId: z.string().uuid(), durationSeconds: z.number().int().min(300).max(720),
  mediaState: z.enum(["waiting", "preparing", "ready", "errored", "deleted"]),
  signedPlaybackId: z.string().trim().min(1).max(255).nullable(),
}).strict();

export type LearningPlaybackTarget = z.infer<typeof PlaybackTargetSchema>;

function validateActor(actor: MemberActor): void {
  if (actor.kind !== "member" || !uuid.test(actor.actorId) || !uuid.test(actor.accountId) || !uuid.test(actor.membershipId)) {
    throw new Error("LEARNING_ACTOR_INVALID");
  }
}

export class LearningRepositoryError extends Error {
  constructor(readonly code: string, readonly availableAt?: string) {
    super(code);
    this.name = "LearningRepositoryError";
  }
}

function safeCode(error: unknown): Readonly<{ code: string; availableAt?: string }> | null {
  const message = error instanceof Error ? error.message : "";
  const code = [
    "ACADEMY_ENROLLMENT_MISSING", "LEARNING_ENROLLMENT_INTEGRITY", "LEARNING_LESSON_NOT_FOUND",
    "LESSON_NOT_RELEASED", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "LEARNING_RESUME_INVALID",
  ].find((candidate) => message === candidate);
  if (code === undefined) return null;
  if (code !== "LESSON_NOT_RELEASED") return { code };
  const detail = typeof error === "object" && error !== null && "detail" in error
    ? (error as { detail?: unknown }).detail
    : undefined;
  const availableAt = z.string().datetime({ offset: false, precision: 3 }).safeParse(detail);
  return availableAt.success ? { code, availableAt: availableAt.data } : { code };
}

export class MemberLearningRepository {
  constructor(private readonly database: Database) {}

  private async command<T>(
    actor: MemberActor,
    correlationId: string,
    parentDeadline: number,
    run: (
      query: <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => Promise<readonly R[]>,
      lockQuery: <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => Promise<readonly R[]>,
    ) => Promise<T>,
  ): Promise<T> {
    validateActor(actor);
    if (!uuid.test(correlationId)) throw new Error("LEARNING_CORRELATION_INVALID");
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(
        this.database.pool,
        performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs,
        parentDeadline,
      );
      const query = async <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) =>
        (await runMemberReadQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, values)).rows;
      const lockQuery = async <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) =>
        (await runMemberReadLockQuery<R>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, values)).rows;
      await query("begin");
      open = true;
      await query(
        "select set_config('app.account_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.membership_id',$3,true),set_config('app.actor_kind','member',true),set_config('app.correlation_id',$4,true),set_config('app.actor_role',$5,true),set_config('app.authenticated_at',$6,true)",
        [actor.accountId, actor.actorId, actor.membershipId, correlationId, actor.role, actor.authenticatedAt.toISOString()],
      );
      const value = await run(query, lockQuery);
      await throwIfMemberReadDeadlineExpired(lease, parentDeadline);
      await query("commit");
      open = false;
      return value;
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback")
          .catch(async () => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const code = safeCode(error);
      if (code !== null) throw new LearningRepositoryError(code.code, code.availableAt);
      throw error;
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }

  async getDashboardCourse(
    actor: MemberActor,
    correlationId: string,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<MemberCourseResponse | null> {
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const candidates = await query<{ course_id: string }>(
        `select e.course_id
         from public.enrollments e
         join public.memberships m
           on m.id=e.membership_id
          and m.account_id=e.account_id
          and m.member_identity_id=nullif(current_setting('app.actor_id',true),'')::uuid
          and m.status='active'
         join public.account_course_accesses aca
           on aca.id=e.account_course_access_id
          and aca.account_id=e.account_id
          and aca.course_id=e.course_id
          and aca.course_version_id=e.course_version_id
          and aca.status='active'
         where e.account_id=nullif(current_setting('app.account_id',true),'')::uuid
           and e.membership_id=nullif(current_setting('app.membership_id',true),'')::uuid
           and e.status='active'
         order by e.id
         limit 2`,
      );
      if (candidates.length === 0) return null;
      if (candidates.length !== 1) throw new Error("LEARNING_ENROLLMENT_INTEGRITY");
      const rows = await query<{ result: unknown }>(
        "select public.syntholo_learning_get_course_v1($1) result",
        [candidates[0]!.course_id],
      );
      return MemberCourseResponseSchema.parse(rows[0]?.result);
    });
  }

  async getCourse(actor: MemberActor, correlationId: string, courseId: string, parentDeadline = memberReadParentDeadline()): Promise<MemberCourseResponse> {
    if (!uuid.test(courseId)) throw new Error("LEARNING_INPUT_INVALID");
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>("select public.syntholo_learning_get_course_v1($1) result", [courseId]);
      return MemberCourseResponseSchema.parse(rows[0]?.result);
    });
  }

  async getLesson(actor: MemberActor, correlationId: string, lessonId: string, parentDeadline = memberReadParentDeadline()): Promise<MemberLessonResponse> {
    if (!uuid.test(lessonId)) throw new Error("LEARNING_INPUT_INVALID");
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>("select public.syntholo_learning_get_lesson_v1($1) result", [lessonId]);
      const parsed = MemberLessonResponseSchema.parse(rows[0]?.result);
      return MemberLessonResponseSchema.parse({
        ...parsed,
        resources: parsed.resources.map((resource) => ({ ...resource, availability: "unavailable" as const })),
      });
    });
  }

  async getPlaybackTarget(actor: MemberActor, correlationId: string, lessonId: string, parentDeadline = memberReadParentDeadline()): Promise<LearningPlaybackTarget> {
    if (!uuid.test(lessonId)) throw new Error("LEARNING_INPUT_INVALID");
    return this.command(actor, correlationId, parentDeadline, async (query) => {
      const rows = await query<{ result: unknown }>("select public.syntholo_learning_get_playback_target_v1($1) result", [lessonId]);
      return PlaybackTargetSchema.parse(rows[0]?.result);
    });
  }

  async resumeLesson(actor: MemberActor, correlationId: string, lessonId: string, input: ResumeLessonRequest, parentDeadline = memberReadParentDeadline()): Promise<z.infer<typeof MemberLessonProgressSchema>> {
    if (!uuid.test(lessonId)) throw new Error("LEARNING_INPUT_INVALID");
    const parsed = ResumeLessonRequestSchema.parse(input);
    return this.command(actor, correlationId, parentDeadline, async (_query, lockQuery) => {
      const videoSeconds = parsed.path === "video" ? parsed.position.seconds : null;
      const transcriptBlockId = parsed.path === "transcript" ? parsed.position.blockId : null;
      const rows = await lockQuery<{ result: unknown }>("select public.syntholo_learning_resume_lesson_v1($1,$2,$3,$4,$5) result", [lessonId, parsed.expectedVersion, parsed.path, videoSeconds, transcriptBlockId]);
      return MemberLessonProgressSchema.parse(rows[0]?.result);
    });
  }

  async completeLesson(actor: MemberActor, correlationId: string, lessonId: string, input: CompleteLessonRequest, idempotencyKey: string, parentDeadline = memberReadParentDeadline()): Promise<CompleteLessonResponse> {
    if (!uuid.test(lessonId) || idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new Error("LEARNING_INPUT_INVALID");
    const parsed = CompleteLessonRequestSchema.parse(input);
    const requestHash = createHash("sha256").update(JSON.stringify({ lessonId, method: parsed.method }), "utf8").digest("hex");
    return this.command(actor, correlationId, parentDeadline, async (_query, lockQuery) => {
      const rows = await lockQuery<{ result: unknown }>("select public.syntholo_learning_complete_lesson_v1($1,$2,$3,$4) result", [lessonId, parsed.method, idempotencyKey, requestHash]);
      return CompleteLessonResponseSchema.parse(rows[0]?.result);
    });
  }
}
