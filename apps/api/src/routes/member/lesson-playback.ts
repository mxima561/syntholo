import { LessonPlaybackResponseSchema } from "@syntholo/contracts/learning";
import { MuxPlaybackDependencyUnavailableError } from "@syntholo/integrations";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { queryIsEmpty, requestHasBody } from "../../http/request-shape.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import {
  authorizeLearningMember,
  learningResponseHeaders,
  mapLearningError,
  type MemberLearningPort,
} from "./learning.js";

const LessonParametersSchema = z.object({ lessonId: z.string().uuid() }).strict();

export const memberLessonPlaybackRoutes: FastifyPluginAsync<{
  member: AuthRouteDependencies["member"];
  learning: MemberLearningPort;
}> = async (app, dependencies) => {
  app.get("/member/lessons/:lessonId/playback", { exposeHeadRoute: false }, async (request, reply) => {
    learningResponseHeaders(reply);
    const params = LessonParametersSchema.safeParse(request.params);
    if (!params.success || !queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    const correlationId = canonicalCorrelationId(request);
    try {
      const lesson = await dependencies.learning.getLesson(actor, correlationId, params.data.lessonId);
      const target = await dependencies.learning.getPlaybackTarget(actor, correlationId, params.data.lessonId);
      if (lesson.lessonVersionId !== target.lessonVersionId) {
        throw new Error("LEARNING_PLAYBACK_VERSION_MISMATCH");
      }
      const fallback = {
        title: lesson.title,
        summary: lesson.summary,
        blocks: lesson.blocks,
        transcript: lesson.transcript,
        resources: lesson.resources,
      };
      if (target.mediaState !== "ready" || target.signedPlaybackId === null) {
        const reason = target.mediaState === "errored"
          ? "MEDIA_ERRORED"
          : target.mediaState === "deleted"
            ? "MEDIA_DELETED"
            : "MEDIA_NOT_READY";
        return LessonPlaybackResponseSchema.parse({
          schemaVersion: 1,
          lessonVersionId: target.lessonVersionId,
          playbackStatus: "degraded",
          reason,
          fallback,
        });
      }
      if (dependencies.member.playback === undefined) {
        return LessonPlaybackResponseSchema.parse({
          schemaVersion: 1,
          lessonVersionId: target.lessonVersionId,
          playbackStatus: "degraded",
          reason: "MUX_UNAVAILABLE",
          fallback,
        });
      }
      try {
        const signed = await dependencies.member.playback.sign({
          playbackId: target.signedPlaybackId,
          durationSeconds: target.durationSeconds,
          now: dependencies.member.playback.clock.now(),
        });
        return LessonPlaybackResponseSchema.parse({
          schemaVersion: 1,
          lessonVersionId: target.lessonVersionId,
          playbackStatus: "ready",
          mux: { playbackId: target.signedPlaybackId, ...signed },
        });
      } catch (error) {
        if (!(error instanceof MuxPlaybackDependencyUnavailableError)) throw error;
        return LessonPlaybackResponseSchema.parse({
          schemaVersion: 1,
          lessonVersionId: target.lessonVersionId,
          playbackStatus: "degraded",
          reason: "MUX_UNAVAILABLE",
          fallback,
        });
      }
    } catch (error) {
      return mapLearningError(error);
    }
  });
};
