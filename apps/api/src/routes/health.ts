import { HealthResponseSchema } from "@syntholo/contracts";
import type { FastifyPluginAsync } from "fastify";

export type ReadinessDependency = Readonly<{
  name: string;
  check(): Promise<unknown>;
}>;

export type HealthRouteOptions = Readonly<{
  releaseSha: string;
  dependencies: readonly ReadinessDependency[];
}>;

const DependencySummarySchema = HealthResponseSchema.shape.dependencies.element;

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  app,
  options,
) => {
  app.get("/live", async (_request, reply) => {
    const payload = HealthResponseSchema.parse({
      status: "ok",
      releaseSha: options.releaseSha,
      service: "api",
      dependencies: [],
    });
    return reply.status(200).send(payload);
  });

  app.get("/ready", async (_request, reply) => {
    const dependencies = await Promise.all(
      options.dependencies.map(async (dependency) => {
        try {
          const result = await dependency.check();
          const parsed = DependencySummarySchema.safeParse({
            ...(typeof result === "object" && result !== null ? result : {}),
            name: dependency.name,
          });
          if (parsed.success) return parsed.data;
        } catch {
          // Adapter failures are represented only through the typed summary below.
        }
        return {
          name: dependency.name,
          status: "degraded" as const,
          latencyMs: 0,
        };
      }),
    );
    const status = dependencies.some(
      (dependency) => dependency.status === "degraded",
    )
      ? "degraded"
      : "ok";
    const payload = HealthResponseSchema.parse({
      status,
      releaseSha: options.releaseSha,
      service: "api",
      dependencies,
    });
    return reply.status(status === "ok" ? 200 : 503).send(payload);
  });
};
