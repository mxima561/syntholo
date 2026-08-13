import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import { correlationIdForRequest, requestContextPlugin } from "./plugins/context.js";
import { safeErrorHandler } from "./plugins/error-handler.js";
import {
  healthRoutes,
  type ReadinessDependency,
} from "./routes/health.js";

export type ApiDependencies = Readonly<{
  releaseSha: string;
  logger?: boolean;
  health: Readonly<{
    dependencies: readonly ReadinessDependency[];
  }>;
}>;

const ApiDependenciesSchema = z
  .object({
    releaseSha: z.string().trim().min(1),
    logger: z.boolean().optional(),
    health: z
      .object({
        dependencies: z.array(
          z
            .object({
              name: z.string().trim().min(1),
              check: z.custom<ReadinessDependency["check"]>(
                (value) => typeof value === "function",
              ),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export async function buildApp(
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const parsedDependencies = ApiDependenciesSchema.safeParse(dependencies);
  if (!parsedDependencies.success) {
    throw new Error("API_DEPENDENCIES_INVALID");
  }
  const app = Fastify({
    logger: parsedDependencies.data.logger ?? false,
    requestIdHeader: false,
    genReqId: correlationIdForRequest,
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(requestContextPlugin);
  app.setErrorHandler(safeErrorHandler);
  await app.register(healthRoutes, {
    prefix: "/v1/health",
    releaseSha: parsedDependencies.data.releaseSha,
    dependencies: parsedDependencies.data.health.dependencies,
  });
  // Expose only the fully composed app; Fastify rejects later plugins/routes/hooks.
  await app.ready();

  return app;
}
