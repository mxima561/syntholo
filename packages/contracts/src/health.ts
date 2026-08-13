import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  releaseSha: z.string().min(1),
  service: z.enum(["web", "api", "worker"]),
  dependencies: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["ok", "degraded"]),
      latencyMs: z.number().nonnegative(),
    }),
  ),
});
