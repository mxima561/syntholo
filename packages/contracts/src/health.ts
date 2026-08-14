import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  releaseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  service: z.enum(["web", "api", "worker"]),
  dependencies: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["ok", "degraded"]),
      latencyMs: z.number().nonnegative(),
    }),
  ),
});
