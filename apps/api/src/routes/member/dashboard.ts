import { MemberDashboardQuerySchema } from "@syntholo/contracts/member-dashboard";
import {
  DatabaseDependencyUnavailableError,
  ImplementationRepositoryError,
  MemberAccessUnavailableError,
} from "@syntholo/database";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { authenticateMember } from "../../auth/member.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import {
  getMemberDashboard,
  getMemberDashboardV2,
  getMemberDashboardV3,
  MemberDashboardActorUnavailableError,
} from "../../modules/member/get-dashboard.js";
import { AppError } from "../../plugins/error-handler.js";

const VERSION_HEADER = "syntholo-dashboard-version";

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function requestHasBody(request: FastifyRequest): boolean {
  const contentLengths = rawHeaderValues(request, "content-length");
  const transferEncodings = rawHeaderValues(request, "transfer-encoding");
  return transferEncodings.length > 0
    || contentLengths.length > 1
    || contentLengths.some((value) => value !== "0")
    || request.body !== undefined;
}

function selectVersion(request: FastifyRequest): 1 | 2 | 3 {
  const values = rawHeaderValues(request, VERSION_HEADER);
  if (values.length === 0) return 1;
  if (values.length !== 1 || values[0]?.includes(",")) {
    throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
  }
  if (values[0] === "1") return 1;
  if (values[0] === "2") return 2;
  if (values[0] === "3") return 3;
  throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
}

export const memberDashboardRoutes: FastifyPluginAsync<
  Pick<AuthRouteDependencies, "member">
> = async (app, dependencies) => {
  app.get("/member/dashboard", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Authorization, Syntholo-Dashboard-Version");

    if (
      requestHasBody(request)
      || !MemberDashboardQuerySchema.safeParse(request.query).success
    ) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const version = selectVersion(request);
    const actor = await authenticateMember(request, dependencies.member);
    const dashboard = dependencies.member.dashboard;
    if (dashboard === undefined) throw new Error("MEMBER_DASHBOARD_NOT_COMPOSED");
    try {
      const response = version === 1
        ? await getMemberDashboard(actor, {
            accounts: dashboard.accounts,
            access: dependencies.member.access,
            clock: dashboard.clock,
          })
        : version === 2
          ? await getMemberDashboardV2(
            actor,
            request.id,
            {
              accounts: dashboard.accounts,
              access: dependencies.member.access,
              clock: dashboard.clock,
              learning: dependencies.member.learning
                ?? (() => { throw new Error("MEMBER_LEARNING_NOT_COMPOSED"); })(),
            },
          )
          : await getMemberDashboardV3(
              actor,
              request.id,
              {
                accounts: dashboard.accounts,
                access: dependencies.member.access,
                clock: dashboard.clock,
                learning: dependencies.member.learning
                  ?? (() => { throw new Error("MEMBER_LEARNING_NOT_COMPOSED"); })(),
                implementation: dependencies.member.implementation
                  ?? (() => { throw new Error("MEMBER_IMPLEMENTATION_NOT_COMPOSED"); })(),
              },
            );
      void reply.header("syntholo-dashboard-version", String(version));
      void reply.type("application/json; charset=utf-8");
      return response;
    } catch (error) {
      if (
        error instanceof MemberAccessUnavailableError
        || error instanceof MemberDashboardActorUnavailableError
      ) {
        throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
      }
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          503,
          "Service temporarily unavailable",
        );
      }
      if (
        error instanceof ImplementationRepositoryError
        && error.code === "IMPLEMENTATION_DEPENDENCY_FAILED"
      ) {
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          503,
          "Service temporarily unavailable",
        );
      }
      throw error;
    }
  });
};
