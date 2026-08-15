import {
  MemberAccessQuerySchema,
  MemberAccessResponseSchema,
} from "@syntholo/contracts";
import type { FastifyPluginAsync } from "fastify";
import {
  DatabaseDependencyUnavailableError,
  MemberAccessUnavailableError,
} from "@syntholo/database";
import { authenticateMember } from "../../auth/member.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { AppError } from "../../plugins/error-handler.js";

export const memberAccessRoutes: FastifyPluginAsync<
  Pick<AuthRouteDependencies, "member">
> = async (app, dependencies) => {
  app.get("/member/access", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Authorization");

    if (!MemberAccessQuerySchema.safeParse(request.query).success) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authenticateMember(request, dependencies.member);
    let access: unknown;
    try {
      access = await dependencies.member.access.getEffectiveAccess(actor);
    } catch (error) {
      if (error instanceof MemberAccessUnavailableError) {
        throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
      }
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          503,
          "Service temporarily unavailable",
        );
      }
      throw error;
    }
    const parsed = MemberAccessResponseSchema.safeParse(access);
    if (!parsed.success) throw new Error("MEMBER_ACCESS_RESPONSE_INVALID");
    return parsed.data;
  });
};
