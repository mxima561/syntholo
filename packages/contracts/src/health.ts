import { z } from "zod";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.enum(["api", "worker", "web", "admin"]),
  releaseSha: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function releaseSha(env: Record<string, string | undefined> = process.env) {
  return env.RELEASE_SHA?.trim() || env.GITHUB_SHA?.trim() || "dev";
}

export function healthPayload(service: HealthResponse["service"], env?: Record<string, string | undefined>): HealthResponse {
  return { ok: true, service, releaseSha: releaseSha(env) };
}
