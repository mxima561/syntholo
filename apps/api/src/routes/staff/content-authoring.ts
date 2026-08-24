import {
  ContentAuthoringConflictCodeSchema,
  CourseDraftResponseSchema,
  CourseDraftTreeResponseSchema,
  CourseDraftUpdateResponseSchema,
  CourseListResponseSchema,
  CreateCourseDraftRequestSchema,
  LessonDraftResponseSchema,
  LessonReviewResponseSchema,
  RecordLessonReviewRequestSchema,
  StageDraftResponseSchema,
  UpdateCourseDraftRequestSchema,
  UpsertLessonDraftRequestSchema,
  UpsertStageDraftRequestSchema,
} from "@syntholo/contracts/content";
import { DatabaseDependencyUnavailableError } from "@syntholo/database";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorize.js";
import { authenticateStaff, requireUnsafeStaffRequest } from "../../auth/staff.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";
import { requestHasBody } from "../../http/request-shape.js";

const CourseIdParametersSchema = z.object({ courseId: z.string().uuid() }).strict();
const StageIdParametersSchema = z.object({ courseId: z.string().uuid(), stageId: z.string().uuid() }).strict();
const LessonCreateParametersSchema = z.object({ courseId: z.string().uuid(), stageId: z.string().uuid() }).strict();
const LessonUpdateParametersSchema = z.object({ courseId: z.string().uuid(), stageId: z.string().uuid(), lessonId: z.string().uuid() }).strict();
const LessonReviewParametersSchema = z.object({ lessonId: z.string().uuid() }).strict();

export type StaffContentAuthoringPort = NonNullable<AuthRouteDependencies["staff"]["contentAuthoring"]>;

type Options = Readonly<{
  staff: AuthRouteDependencies["staff"];
  contentAuthoring: StaffContentAuthoringPort;
}>;

function requireCommandRequest(
  request: Parameters<typeof requireUnsafeStaffRequest>[0],
  dependencies: Options,
): void {
  requireUnsafeStaffRequest(request, dependencies.staff);
}

async function authoringCommand<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof DatabaseDependencyUnavailableError) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
    }
    const parsed = ContentAuthoringConflictCodeSchema.safeParse(
      error instanceof Error ? error.message : undefined,
    );
    if (parsed.success) {
      throw new AppError(parsed.data, 409, "Content state changed; refresh and retry");
    }
    throw error;
  }
}

export const staffContentAuthoringRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.get("/staff/content/courses", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    if (requestHasBody(request)) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const courses = await dependencies.contentAuthoring.listCourses({
      actor, correlationId: canonicalCorrelationId(request),
    });
    return reply.status(200).send(CourseListResponseSchema.parse({ courses }));
  });

  app.get("/staff/content/courses/:courseId", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    if (!params.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    if (requestHasBody(request)) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = CourseDraftTreeResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.getCourseDraftTree({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
    })));
    return reply.status(200).send(result);
  });

  app.patch("/staff/content/courses/:courseId", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const body = UpdateCourseDraftRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = CourseDraftUpdateResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.updateCourseDraft({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      expectedRevision: body.data.expectedRevision, title: body.data.title, description: body.data.description,
      idempotencyKey: key,
    })));
    return reply.status(200).send(result);
  });

  app.post("/staff/content/courses", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const body = CreateCourseDraftRequestSchema.safeParse(request.body);
    if (!body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = CourseDraftResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.createCourseDraft({
      actor, correlationId: canonicalCorrelationId(request),
      slug: body.data.slug, title: body.data.title, description: body.data.description,
      idempotencyKey: key,
    })));
    return reply.status(201).send(result);
  });

  app.post("/staff/content/courses/:courseId/stages", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const body = UpsertStageDraftRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = StageDraftResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.upsertStageDraft({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      expectedCourseRevision: body.data.expectedCourseRevision,
      slug: body.data.slug, title: body.data.title, description: body.data.description, order: body.data.order,
      idempotencyKey: key,
    })));
    return reply.status(201).send(result);
  });

  app.patch("/staff/content/courses/:courseId/stages/:stageId", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = StageIdParametersSchema.safeParse(request.params);
    const body = UpsertStageDraftRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = StageDraftResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.upsertStageDraft({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      stageId: params.data.stageId, expectedCourseRevision: body.data.expectedCourseRevision,
      slug: body.data.slug, title: body.data.title, description: body.data.description, order: body.data.order,
      idempotencyKey: key,
    })));
    return reply.status(200).send(result);
  });

  app.post("/staff/content/courses/:courseId/stages/:stageId/lessons", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = LessonCreateParametersSchema.safeParse(request.params);
    const body = UpsertLessonDraftRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = LessonDraftResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.upsertLessonDraft({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId, stageId: params.data.stageId,
      slug: body.data.slug, title: body.data.title, summary: body.data.summary,
      durationSeconds: body.data.durationSeconds, blocks: body.data.blocks, transcript: body.data.transcript,
      order: body.data.order, required: body.data.required, idempotencyKey: key,
    })));
    return reply.status(201).send(result);
  });

  app.patch("/staff/content/courses/:courseId/stages/:stageId/lessons/:lessonId", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = LessonUpdateParametersSchema.safeParse(request.params);
    const body = UpsertLessonDraftRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = LessonDraftResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.upsertLessonDraft({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId, stageId: params.data.stageId,
      lessonId: params.data.lessonId,
      slug: body.data.slug, title: body.data.title, summary: body.data.summary,
      durationSeconds: body.data.durationSeconds, blocks: body.data.blocks, transcript: body.data.transcript,
      order: body.data.order, required: body.data.required, idempotencyKey: key,
    })));
    return reply.status(200).send(result);
  });

  app.post("/staff/content/lessons/:lessonId/review", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = LessonReviewParametersSchema.safeParse(request.params);
    const body = RecordLessonReviewRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = LessonReviewResponseSchema.parse(await authoringCommand(() => dependencies.contentAuthoring.recordLessonReview({
      actor, correlationId: canonicalCorrelationId(request), lessonId: params.data.lessonId,
      expectedRevision: body.data.expectedRevision, reason: body.data.reason,
    })));
    return reply.status(201).send(result);
  });
};
