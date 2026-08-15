import {
  ContentPublicationIssuesSchema,
  CreatePreviewRequestSchema,
  DerivedCoursePreviewResponseSchema,
  GetCoursePreviewQuerySchema,
  PublishCourseRequestSchema,
  PublishLessonRequestSchema,
} from "@syntholo/contracts/content";
import { ContentCommandConflictError, DatabaseDependencyUnavailableError } from "@syntholo/database";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { authorize, requireAdmin, requireRecentAuth } from "../../auth/authorize.js";
import { authenticateStaff, requireUnsafeStaffRequest } from "../../auth/staff.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";
import { requestHasBody } from "../../http/request-shape.js";

const CourseIdParametersSchema = z.object({ courseId: z.string().uuid() }).strict();
const LessonIdParametersSchema = z.object({ lessonId: z.string().uuid() }).strict();
const PreviewResponseSchema = z.object({
  previewId: z.string().uuid(),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  manifest: z.record(z.string(), z.unknown()),
  publicationIssues: ContentPublicationIssuesSchema,
  createdAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();
const CourseVersionResponseSchema = z.object({
  id: z.string().uuid(), courseId: z.string().uuid(), version: z.number().int().positive(),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/u), headRevision: z.number().int().positive(),
  publishedAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();
const LessonVersionResponseSchema = z.object({
  id: z.string().uuid(), lessonId: z.string().uuid(), courseId: z.string().uuid(),
  version: z.number().int().positive(), contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  publishedAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();

export type StaffContentPort = NonNullable<AuthRouteDependencies["staff"]["content"]>;

type Options = Readonly<{
  staff: AuthRouteDependencies["staff"];
  content: StaffContentPort;
}>;

function commandActor(
  actor: Awaited<ReturnType<typeof authenticateStaff>>,
  permission: string,
  now: Date,
): Awaited<ReturnType<typeof authenticateStaff>> {
  return requireRecentAuth(authorize(requireAdmin(actor), { permission }), 300, now);
}

function requireCommandRequest(
  request: Parameters<typeof requireUnsafeStaffRequest>[0],
  dependencies: Options,
): void {
  requireUnsafeStaffRequest(request, dependencies.staff);
}

async function contentCommand<T>(command: () => Promise<T>, reply?: FastifyReply): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof DatabaseDependencyUnavailableError) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
    }
    if (error instanceof ContentCommandConflictError) {
      if (error.code === "IDEMPOTENCY_IN_PROGRESS") void reply?.header("retry-after", "1");
      throw new AppError(
        error.code,
        409,
        "Content state changed; refresh and retry",
        error.publicationIssues === undefined
          ? undefined
          : { publicationIssues: error.publicationIssues },
      );
    }
    throw error;
  }
}

export const staffContentRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.get("/staff/content/courses/:courseId/preview", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const query = GetCoursePreviewQuerySchema.safeParse(request.query);
    if (!params.success || !query.success || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = authorize(authenticated, { permission: "content:read" });
    try {
      const result = DerivedCoursePreviewResponseSchema.parse(await dependencies.content.derivePreview({
        actor,
        correlationId: canonicalCorrelationId(request),
        courseId: params.data.courseId,
        ...(query.data.draftRevision === undefined ? {} : { draftRevision: query.data.draftRevision }),
      }));
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
      }
      if (error instanceof Error && error.message === "CONTENT_NOT_FOUND") {
        throw new AppError("CONTENT_NOT_FOUND", 404, "Content not found");
      }
      throw error;
    }
  });

  app.post("/staff/content/courses/:courseId/previews", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const body = CreatePreviewRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = commandActor(authenticated, "content:publish", dependencies.staff.clock.now());
    const result = PreviewResponseSchema.parse(await contentCommand(() => dependencies.content.materializePreview({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      expectedVersion: body.data.expectedVersion, reason: body.data.reason,
      idempotencyKey: key,
    }), reply));
    return reply.status(201).send(result);
  });

  app.post("/staff/content/courses/:courseId/publications", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const body = PublishCourseRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = commandActor(authenticated, "content:publish", dependencies.staff.clock.now());
    const result = CourseVersionResponseSchema.parse(await contentCommand(() => dependencies.content.publishCourse({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      previewId: body.data.previewId, expectedManifestHash: body.data.expectedManifestHash,
      expectedHeadRevision: body.data.expectedHeadRevision, reason: body.data.reason,
      idempotencyKey: key,
    }), reply));
    return reply.status(201).send(result);
  });

  app.post("/staff/content/lessons/:lessonId/publications", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = LessonIdParametersSchema.safeParse(request.params);
    const body = PublishLessonRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = commandActor(authenticated, "content:publish", dependencies.staff.clock.now());
    const result = LessonVersionResponseSchema.parse(await contentCommand(() => dependencies.content.publishLesson({
      actor, correlationId: canonicalCorrelationId(request), lessonId: params.data.lessonId,
      expectedVersion: body.data.expectedVersion, reason: body.data.reason, idempotencyKey: key,
    }), reply));
    return reply.status(201).send(result);
  });
};
