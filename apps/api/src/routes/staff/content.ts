import {
  ContentPublicationIssuesSchema,
  CreatePreviewRequestSchema,
  PublishCourseRequestSchema,
} from "@syntholo/contracts/content";
import { ContentCommandConflictError } from "@syntholo/database";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { authorize, requireAdmin, requireRecentAuth } from "../../auth/authorize.js";
import { authenticateStaff, requireUnsafeStaffRequest } from "../../auth/staff.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";

const CourseIdParametersSchema = z.object({ courseId: z.string().uuid() }).strict();
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

async function contentCommand<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof ContentCommandConflictError) {
      throw new AppError(error.code, 409, "Content state changed; refresh and retry");
    }
    throw error;
  }
}

export const staffContentRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.post("/staff/content/courses/:courseId/previews", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const body = CreatePreviewRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = commandActor(authenticated, "content:publish", dependencies.staff.clock.now());
    const result = PreviewResponseSchema.parse(await contentCommand(() => dependencies.content.materializePreview({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      expectedVersion: body.data.expectedVersion, reason: body.data.reason,
    })));
    return reply.status(201).send(result);
  });

  app.post("/staff/content/courses/:courseId/publications", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    const params = CourseIdParametersSchema.safeParse(request.params);
    const body = PublishCourseRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    requireCommandRequest(request, dependencies);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = commandActor(authenticated, "content:publish", dependencies.staff.clock.now());
    const result = CourseVersionResponseSchema.parse(await contentCommand(() => dependencies.content.publishCourse({
      actor, correlationId: canonicalCorrelationId(request), courseId: params.data.courseId,
      previewId: body.data.previewId, expectedManifestHash: body.data.expectedManifestHash,
      expectedHeadRevision: body.data.expectedHeadRevision, reason: body.data.reason,
    })));
    return reply.status(201).send(result);
  });
};
