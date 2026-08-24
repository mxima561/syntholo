import { StaffAccountListResponseSchema } from "@syntholo/contracts/staff";
import { DatabaseDependencyUnavailableError } from "@syntholo/database";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorize.js";
import { authenticateStaff } from "../../auth/staff.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { requestHasBody } from "../../http/request-shape.js";

const ListAccountsQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
}).strict();

export type StaffAccountsPort = NonNullable<AuthRouteDependencies["staff"]["accounts"]>;

type Options = Readonly<{
  staff: AuthRouteDependencies["staff"];
  accounts: StaffAccountsPort;
}>;

export const staffAccountsRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.get("/staff/accounts", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store"); void reply.header("vary", "Cookie");
    if (requestHasBody(request)) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const query = ListAccountsQuerySchema.safeParse(request.query);
    if (!query.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireAdmin(authenticated);
    try {
      const accounts = await dependencies.accounts.list({
        actor, correlationId: canonicalCorrelationId(request), query: query.data.q,
      });
      return reply.status(200).send(StaffAccountListResponseSchema.parse({ accounts }));
    } catch (error) {
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
      }
      throw error;
    }
  });
};
