import { MemberAccessResponseSchema } from "@syntholo/contracts";
import {
  MemberCourseResponseSchema,
  MemberLessonResponseSchema,
} from "@syntholo/contracts/learning";
import {
  DatabaseDependencyUnavailableError,
  LearningRepositoryError,
  MemberAccessUnavailableError,
} from "@syntholo/database";
import type { MemberActor } from "@syntholo/domain";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateMember } from "../../auth/member.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { queryIsEmpty, requestHasBody } from "../../http/request-shape.js";

const IdParametersSchema = z.object({
  courseId: z.string().uuid().optional(),
  lessonId: z.string().uuid().optional(),
}).strict();

export type MemberLearningPort = NonNullable<AuthRouteDependencies["member"]["learning"]>;

export function learningResponseHeaders(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
  void reply.header("vary", "Authorization");
}

export async function authorizeLearningMember(
  request: Parameters<typeof authenticateMember>[0],
  member: AuthRouteDependencies["member"],
): Promise<MemberActor> {
  const actor = await authenticateMember(request, member);
  try {
    const access = MemberAccessResponseSchema.parse(
      await member.access.getEffectiveAccess(actor),
    );
    if (access.accountId !== actor.accountId) {
      throw new Error("MEMBER_ACCESS_ACCOUNT_MISMATCH");
    }
    if (!access.capabilities.academy_course) {
      throw new AppError("COURSE_ACCESS_REQUIRED", 403, "Course access required");
    }
    return actor;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof MemberAccessUnavailableError) {
      throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
    }
    if (error instanceof DatabaseDependencyUnavailableError) {
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
    }
    throw error;
  }
}

export function mapLearningError(error: unknown): never {
  if (error instanceof DatabaseDependencyUnavailableError) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
  }
  if (error instanceof LearningRepositoryError) {
    switch (error.code) {
      case "ACADEMY_ENROLLMENT_MISSING":
        throw new AppError(error.code, 404, "Academy enrollment not found");
      case "LEARNING_LESSON_NOT_FOUND":
        throw new AppError("NOT_FOUND", 404, "Lesson not found");
      case "LESSON_NOT_RELEASED":
        throw new AppError(error.code, 403, "Lesson is not released", error.availableAt === undefined ? undefined : { availableAt: error.availableAt });
      case "VERSION_CONFLICT":
        throw new AppError(error.code, 409, "Progress changed; refresh and retry");
      case "IDEMPOTENCY_KEY_REUSED":
        throw new AppError(error.code, 409, "Idempotency key was already used");
      case "LEARNING_RESUME_INVALID":
        throw new AppError(error.code, 400, "Resume position is invalid");
      default:
        throw error;
    }
  }
  throw error;
}

export const memberLearningRoutes: FastifyPluginAsync<{
  member: AuthRouteDependencies["member"];
  learning: MemberLearningPort;
}> = async (app, dependencies) => {
  app.get("/member/courses/:courseId", { exposeHeadRoute: false }, async (request, reply) => {
    learningResponseHeaders(reply);
    const params = IdParametersSchema.safeParse(request.params);
    if (!params.success || params.data.courseId === undefined || !queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return MemberCourseResponseSchema.parse(await dependencies.learning.getCourse(
        actor,
        canonicalCorrelationId(request),
        params.data.courseId,
      ));
    } catch (error) {
      return mapLearningError(error);
    }
  });

  app.get("/member/lessons/:lessonId", { exposeHeadRoute: false }, async (request, reply) => {
    learningResponseHeaders(reply);
    const params = IdParametersSchema.safeParse(request.params);
    if (!params.success || params.data.lessonId === undefined || !queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return MemberLessonResponseSchema.parse(await dependencies.learning.getLesson(
        actor,
        canonicalCorrelationId(request),
        params.data.lessonId,
      ));
    } catch (error) {
      return mapLearningError(error);
    }
  });
};
