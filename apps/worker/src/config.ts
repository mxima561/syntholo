import { z } from "zod";
import { artifactReleaseSha } from "./release.js";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const WorkerEnvironmentSchema = z.object({
  DATABASE_URL: z.string().trim().min(1),
  RELEASE_SHA: z.string().trim().regex(/^[0-9a-f]{40}$/u),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100),
  WORKER_IDLE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
});

export type WorkerConfig = Readonly<{
  databaseUrl: string;
  releaseSha: string;
  concurrency: number;
  idleDelayMs: number;
}>;

export function parseWorkerConfig(
  environment: RuntimeEnvironment,
  embeddedReleaseSha: string | undefined = artifactReleaseSha,
): WorkerConfig {
  const result = WorkerEnvironmentSchema.safeParse(environment);
  if (
    !result.success
    || (embeddedReleaseSha !== undefined
      && (!/^[0-9a-f]{40}$/u.test(embeddedReleaseSha)
        || result.data.RELEASE_SHA !== embeddedReleaseSha))
  ) throw new Error("WORKER_CONFIG_INVALID");

  return {
    databaseUrl: result.data.DATABASE_URL,
    releaseSha: result.data.RELEASE_SHA,
    concurrency: result.data.WORKER_CONCURRENCY,
    idleDelayMs: result.data.WORKER_IDLE_DELAY_MS,
  };
}
