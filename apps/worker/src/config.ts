import { z } from "zod";
import { artifactReleaseSha } from "./release.js";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const WorkerEnvironmentSchema = z.object({
  DATABASE_URL: z.string().trim().min(1),
  RELEASE_SHA: z.string().trim().regex(/^[0-9a-f]{40}$/u),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100),
  WORKER_IDLE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  MUX_CONTENT_ENABLED: z.enum(["true", "false"]).default("false"),
  MUX_ENVIRONMENT_ID: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u).optional(),
  MUX_RECONCILE_TOKEN_ID: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u).optional(),
  MUX_RECONCILE_TOKEN_SECRET: z.string().trim().min(16).optional(),
  CERTIFICATE_BLOB_ENABLED: z.enum(["true", "false"]).default("false"),
  CERTIFICATE_BLOB_ENVIRONMENT: z.enum(["staging", "production"]).optional(),
  CERTIFICATE_BLOB_TOKEN: z.string().trim().min(1).optional(),
  CERTIFICATE_BLOB_STAGING_STORE_ID: z.string().trim().regex(/^[A-Za-z0-9]{3,64}$/u).optional(),
  CERTIFICATE_BLOB_PRODUCTION_STORE_ID: z.string().trim().regex(/^[A-Za-z0-9]{3,64}$/u).optional(),
  CERTIFICATE_BLOB_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),
  DEPLOYMENT_ENVIRONMENT: z.enum(["staging", "production"]).optional(),
});

export type WorkerConfig = Readonly<{
  databaseUrl: string;
  releaseSha: string;
  concurrency: number;
  idleDelayMs: number;
  mux?: Readonly<{
    enabled: boolean;
    environmentId?: string;
    tokenId?: string;
    tokenSecret?: string;
  }>;
  certificateBlob?: Readonly<{
    enabled: true;
    environment: "staging" | "production";
    token: string;
    storeIds: Readonly<{ staging: string; production: string }>;
    operationTimeoutMs: number;
  }>;
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

  const enabled = result.data.MUX_CONTENT_ENABLED === "true";
  const hasId = result.data.MUX_RECONCILE_TOKEN_ID !== undefined;
  const hasSecret = result.data.MUX_RECONCILE_TOKEN_SECRET !== undefined;
  const hasEnvironment = result.data.MUX_ENVIRONMENT_ID !== undefined;
  if (hasId !== hasSecret || hasEnvironment !== hasId
    || (enabled && (!hasEnvironment || !hasId || !hasSecret))) {
    throw new Error("WORKER_CONFIG_INVALID");
  }

  const certificateBlobEnabled = result.data.CERTIFICATE_BLOB_ENABLED === "true";
  const certificateBlobValues = [
    result.data.CERTIFICATE_BLOB_ENVIRONMENT,
    result.data.CERTIFICATE_BLOB_TOKEN,
    result.data.CERTIFICATE_BLOB_STAGING_STORE_ID,
    result.data.CERTIFICATE_BLOB_PRODUCTION_STORE_ID,
  ];
  const configuredCertificateBlobValues = certificateBlobValues.filter((value) => value !== undefined).length;
  if ((configuredCertificateBlobValues !== 0 && configuredCertificateBlobValues !== certificateBlobValues.length)
    || (certificateBlobEnabled && configuredCertificateBlobValues !== certificateBlobValues.length)
    || (certificateBlobEnabled
      && result.data.DEPLOYMENT_ENVIRONMENT !== result.data.CERTIFICATE_BLOB_ENVIRONMENT)
    || (result.data.CERTIFICATE_BLOB_STAGING_STORE_ID !== undefined
      && result.data.CERTIFICATE_BLOB_STAGING_STORE_ID === result.data.CERTIFICATE_BLOB_PRODUCTION_STORE_ID)) {
    throw new Error("WORKER_CONFIG_INVALID");
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    releaseSha: result.data.RELEASE_SHA,
    concurrency: result.data.WORKER_CONCURRENCY,
    idleDelayMs: result.data.WORKER_IDLE_DELAY_MS,
    mux: Object.freeze({
      enabled,
      ...(hasId ? {
        environmentId: result.data.MUX_ENVIRONMENT_ID,
        tokenId: result.data.MUX_RECONCILE_TOKEN_ID,
        tokenSecret: result.data.MUX_RECONCILE_TOKEN_SECRET,
      } : {}),
    }),
    ...(certificateBlobEnabled ? {
      certificateBlob: Object.freeze({
        enabled: true as const,
        environment: result.data.CERTIFICATE_BLOB_ENVIRONMENT!,
        token: result.data.CERTIFICATE_BLOB_TOKEN!,
        storeIds: Object.freeze({
          staging: result.data.CERTIFICATE_BLOB_STAGING_STORE_ID!,
          production: result.data.CERTIFICATE_BLOB_PRODUCTION_STORE_ID!,
        }),
        operationTimeoutMs: result.data.CERTIFICATE_BLOB_OPERATION_TIMEOUT_MS,
      }),
    } : {}),
  };
}
