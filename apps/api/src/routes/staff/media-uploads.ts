import {
  AttachLessonMediaResponseSchema,
  ContentAuthoringConflictCodeSchema,
  CreateLessonUploadResponseSchema,
  FinalizeLessonUploadRequestSchema,
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

const CreateUploadRequestSchema = z.object({}).strict();
const LessonIdParametersSchema = z.object({ lessonId: z.string().uuid() }).strict();
const UploadFinalizeParametersSchema = z.object({
  lessonId: z.string().uuid(), uploadId: z.string().min(1).max(255),
}).strict();

export type StaffMediaUploadsPort = NonNullable<AuthRouteDependencies["staff"]["mediaUploads"]>;

type Options = Readonly<{
  staff: AuthRouteDependencies["staff"];
  mediaUploads: StaffMediaUploadsPort;
}>;

const MediaUploadConflictCodeSchema = z.enum(["MUX_UPLOAD_NOT_READY", "MUX_UPLOAD_FAILED"]);

async function mediaUploadCommand<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof DatabaseDependencyUnavailableError) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
    }
    const message = error instanceof Error ? error.message : undefined;
    const uploadConflict = MediaUploadConflictCodeSchema.safeParse(message);
    if (uploadConflict.success) {
      throw new AppError(uploadConflict.data, 409, "Upload is not ready yet; poll again shortly");
    }
    const conflict = ContentAuthoringConflictCodeSchema.safeParse(message);
    if (conflict.success) {
      throw new AppError(conflict.data, 409, "Content state changed; refresh and retry");
    }
    throw error;
  }
}

export const staffMediaUploadsRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.post("/staff/content/lessons/:lessonId/uploads", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = LessonIdParametersSchema.safeParse(request.params);
    const body = CreateUploadRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    requiredIdempotencyKey(request);
    requireUnsafeStaffRequest(request, dependencies.staff);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = CreateLessonUploadResponseSchema.parse(await mediaUploadCommand(() => dependencies.mediaUploads.createUpload({
      actor, correlationId: canonicalCorrelationId(request), lessonId: params.data.lessonId,
    })));
    return reply.status(201).send(result);
  });

  app.post("/staff/content/lessons/:lessonId/uploads/:uploadId/finalize", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const params = UploadFinalizeParametersSchema.safeParse(request.params);
    const body = FinalizeLessonUploadRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    requireUnsafeStaffRequest(request, dependencies.staff);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    const result = AttachLessonMediaResponseSchema.parse(await mediaUploadCommand(() => dependencies.mediaUploads.finalizeUpload({
      actor, correlationId: canonicalCorrelationId(request),
      lessonId: params.data.lessonId, uploadId: params.data.uploadId,
      expectedRevision: body.data.expectedRevision,
    })));
    return reply.status(200).send(result);
  });
};
