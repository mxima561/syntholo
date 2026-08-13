import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import rawBody from "fastify-raw-body";
import { correlationIdForRequest, requestContextPlugin } from "./plugins/context.js";
import { safeErrorHandler } from "./plugins/error-handler.js";
import {
  healthRoutes,
  type ReadinessDependency,
} from "./routes/health.js";

export type ApiDependencies = Readonly<{
  releaseSha: string;
  logger?: FastifyServerOptions["logger"];
  health: Readonly<{
    dependencies: readonly ReadinessDependency[];
  }>;
}>;

export async function buildApp(
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ?? false,
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
    releaseSha: dependencies.releaseSha,
    dependencies: dependencies.health.dependencies,
  });

  return app;
}
