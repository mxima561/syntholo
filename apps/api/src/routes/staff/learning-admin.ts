import {
  EnrollmentGrantResponseSchema,
  GrantEnrollmentRequestSchema,
  LearningAdminConflictCodeSchema,
} from "@syntholo/contracts/content";
import { DatabaseDependencyUnavailableError } from "@syntholo/database";
import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "../../auth/authorize.js";
import { authenticateStaff, requireUnsafeStaffRequest } from "../../auth/staff.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";

export type StaffLearningAdminPort = NonNullable<AuthRouteDependencies["staff"]["learningAdmin"]>;

type Options = Readonly<{
  staff: AuthRouteDependencies["staff"];
  learningAdmin: StaffLearningAdminPort;
}>;

export const staffLearningAdminRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.post("/staff/learning/enrollments", async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    const body = GrantEnrollmentRequestSchema.safeParse(request.body);
    if (!body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const key = requiredIdempotencyKey(request);
    requireUnsafeStaffRequest(request, dependencies.staff);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    try {
      const result = EnrollmentGrantResponseSchema.parse(await dependencies.learningAdmin.grantEnrollment({
        actor, correlationId: canonicalCorrelationId(request),
        accountId: body.data.accountId, courseId: body.data.courseId, reason: body.data.reason,
        idempotencyKey: key,
      }));
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
      }
      const parsed = LearningAdminConflictCodeSchema.safeParse(
        error instanceof Error ? error.message : undefined,
      );
      if (parsed.success) {
        throw new AppError(parsed.data, 409, "Enrollment state changed; refresh and retry");
      }
      throw error;
    }
  });
};
