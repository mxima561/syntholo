import {
  CompleteLessonRequestSchema,
  CompleteLessonResponseSchema,
  MemberLessonProgressSchema,
  ResumeLessonRequestSchema,
} from "@syntholo/contracts/learning";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";
import { queryIsEmpty } from "../../http/request-shape.js";
import {
  authorizeLearningMember,
  learningResponseHeaders,
  mapLearningError,
  type MemberLearningPort,
} from "./learning.js";

const LessonParametersSchema = z.object({ lessonId: z.string().uuid() }).strict();

export const memberProgressRoutes: FastifyPluginAsync<{
  member: AuthRouteDependencies["member"];
  learning: MemberLearningPort;
}> = async (app, dependencies) => {
  app.put("/member/lessons/:lessonId/resume", async (request, reply) => {
    learningResponseHeaders(reply);
    const params = LessonParametersSchema.safeParse(request.params);
    const body = ResumeLessonRequestSchema.safeParse(request.body);
    if (!params.success || !body.success || !queryIsEmpty(request.query)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return MemberLessonProgressSchema.parse(await dependencies.learning.resumeLesson(
        actor,
        canonicalCorrelationId(request),
        params.data.lessonId,
        body.data,
      ));
    } catch (error) {
      return mapLearningError(error);
    }
  });

  app.post("/member/lessons/:lessonId/complete", async (request, reply) => {
    learningResponseHeaders(reply);
    const params = LessonParametersSchema.safeParse(request.params);
    const body = CompleteLessonRequestSchema.safeParse(request.body);
    const key = requiredIdempotencyKey(request);
    if (!params.success || !body.success || !queryIsEmpty(request.query)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return CompleteLessonResponseSchema.parse(await dependencies.learning.completeLesson(
        actor,
        canonicalCorrelationId(request),
        params.data.lessonId,
        body.data,
        key,
      ));
    } catch (error) {
      return mapLearningError(error);
    }
  });
};
