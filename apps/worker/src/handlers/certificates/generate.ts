import { createHash } from "node:crypto";
import {
  CertificateGenerationConsistencyError,
  CertificateGenerationInputError,
  DatabaseDependencyUnavailableError,
  type CertificateFile,
  type CertificateGeneration,
  type CertificateGenerationFence,
} from "@syntholo/database";
import {
  CertificateBlobError,
  type PrivateCertificateBlobStore,
} from "@syntholo/integrations";
import { z } from "zod";
import type { JobHandler } from "../index.js";
import { HandlerFailure } from "../index.js";
import type { CertificateRenderInput } from "./render.js";

const JobSchema = z.object({
  accountId: z.string().uuid(),
  correlationId: z.string().uuid(),
  attempt: z.number().int().positive().max(2_147_483_647),
  claimGeneration: z.number().int().nonnegative().max(2_147_483_647),
  claimToken: z.string().uuid(),
  id: z.string().uuid(),
  idempotencyKey: z.string(),
  leaseExpiresAt: z.date(),
  maxAttempts: z.literal(5),
  payload: z.object({
    certificateId: z.string().uuid(),
    courseCompletionId: z.string().uuid(),
  }).strict(),
  sourceActorId: z.string().min(1),
  sourceActorType: z.literal("member"),
  type: z.literal("learning.course_completed.certificate.v1"),
  workerId: z.string().min(1),
}).strict().superRefine((job, context) => {
  if (job.idempotencyKey !== `certificate:${job.payload.courseCompletionId}`) {
    context.addIssue({ code: "custom", path: ["idempotencyKey"], message: "job key mismatch" });
  }
});

export type CertificateGenerationRepositoryPort = Readonly<{
  loadGenerationFence(
    input: CertificateGenerationFence,
    signal?: AbortSignal,
  ): Promise<CertificateGeneration>;
  loadIssuedFile(input: CertificateGenerationFence, signal?: AbortSignal): Promise<CertificateFile>;
  finalize(
    input: CertificateGenerationFence & Readonly<{ byteLength: number; sha256: string; etag: string }>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  markFailed(
    input: CertificateGenerationFence & Readonly<{ failureCode: "render_failed" | "storage_failed" }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ kind: "failed" | "duplicate" }>>;
}>;

type CertificateGenerationBlobPort = Pick<PrivateCertificateBlobStore, "upload" | "reconcileUpload">;

export function createCertificateGenerationHandler(input: Readonly<{
  repository: CertificateGenerationRepositoryPort;
  blob: CertificateGenerationBlobPort;
  render(renderInput: CertificateRenderInput): Promise<Uint8Array>;
}>): JobHandler {
  return async (rawJob, signal): Promise<void> => {
    const parsed = JobSchema.safeParse(rawJob);
    if (!parsed.success) throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    if (signal.aborted) throw dependencyUnavailable();
    const job = parsed.data;
    const generationFence: CertificateGenerationFence = Object.freeze({
      jobId: job.id,
      workerId: job.workerId,
      attempt: job.attempt,
      generation: job.claimGeneration,
      claimToken: job.claimToken,
    });
    let generation: CertificateGeneration;
    try {
      generation = await input.repository.loadGenerationFence(generationFence, signal);
    } catch (error) {
      throw classifyRepositoryError(error);
    }
    if (generation.accountId !== job.accountId
      || generation.certificateId !== job.payload.certificateId
      || generation.courseCompletionId !== job.payload.courseCompletionId) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (generation.kind !== "pending") {
      await acknowledgeTerminal(input.repository, generationFence, generation, signal);
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = await input.render({
        recipientName: generation.recipientName,
        businessName: generation.businessName,
        courseTitle: generation.courseTitle,
        courseVersion: generation.courseVersion,
        completedAt: generation.completedAt,
      });
    } catch (error) {
      if (error instanceof Error
        && ["CERTIFICATE_RENDER_INPUT_INVALID", "CERTIFICATE_RENDER_GLYPH_UNAVAILABLE"].includes(error.message)) {
        await markFailed(input.repository, generationFence, "render_failed", signal);
        return;
      }
      throw error;
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 25 * 1_024 * 1_024) {
      throw new Error("CERTIFICATE_RENDER_RESULT_INVALID");
    }
    let current: CertificateGeneration;
    try {
      current = await input.repository.loadGenerationFence(generationFence, signal);
    } catch (error) {
      throw classifyRepositoryError(error);
    }
    if (current.accountId !== generation.accountId
      || current.certificateId !== generation.certificateId
      || current.courseCompletionId !== generation.courseCompletionId) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (current.kind !== "pending") {
      await acknowledgeTerminal(input.repository, generationFence, current, signal);
      return;
    }
    if (current.recipientName !== generation.recipientName
      || current.businessName !== generation.businessName
      || current.courseTitle !== generation.courseTitle
      || current.courseVersion !== generation.courseVersion
      || current.completedAt !== generation.completedAt) {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pathname = objectKey(generation.accountId, generation.courseCompletionId);
    let stored: Readonly<{ byteLength: number; sha256: string; etag: string }>;
    try {
      stored = await input.blob.upload({ pathname, bytes, sha256, signal });
    } catch (error) {
      if (!(error instanceof CertificateBlobError)) throw error;
      const shouldReconcile = error.retryable
        || error.message === "CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID";
      if (!shouldReconcile) {
        if (permanentStorageFailure(error)) {
          await markStorageFailed(input.repository, generationFence, signal);
        }
        throw permanentBlobFailure();
      }
      try {
        stored = await input.blob.reconcileUpload({
          pathname,
          expected: { byteLength: bytes.byteLength, sha256 },
          signal,
        });
      } catch (reconcileError) {
        if (reconcileError instanceof CertificateBlobError) {
          if (reconcileError.message === "CERTIFICATE_BLOB_NOT_FOUND") {
            if (error.retryable) throw dependencyUnavailable();
            await markStorageFailed(input.repository, generationFence, signal);
          }
          if (reconcileError.retryable) throw dependencyUnavailable();
          if (permanentStorageFailure(reconcileError)) {
            await markStorageFailed(input.repository, generationFence, signal);
          }
        }
        throw reconcileError;
      }
    }
    if (stored.byteLength !== bytes.byteLength || stored.sha256 !== sha256) {
      await markStorageFailed(input.repository, generationFence, signal);
    }
    try {
      await input.repository.finalize({
        ...generationFence,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        etag: stored.etag,
      }, signal);
    } catch (error) {
      throw classifyRepositoryError(error);
    }
  };
}

async function acknowledgeTerminal(
  repository: CertificateGenerationRepositoryPort,
  fence: CertificateGenerationFence,
  generation: CertificateGeneration,
  signal: AbortSignal,
): Promise<boolean> {
  if (generation.kind === "pending") return false;
  if (generation.kind === "issued") {
    try {
      const file = await repository.loadIssuedFile(fence, signal);
      if (file.certificateId !== generation.certificateId
        || file.courseCompletionId !== generation.courseCompletionId
        || file.accountId !== generation.accountId
        || file.objectKey !== objectKey(generation.accountId, generation.courseCompletionId)) {
        throw new CertificateGenerationInputError();
      }
      return true;
    } catch (error) {
      throw classifyRepositoryError(error);
    }
  }
  if (generation.failureCode === "snapshot_not_renderable") {
    throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
  }
  await markFailed(repository, fence, generation.failureCode, signal);
  if (generation.failureCode === "storage_failed") throw storageDeadLetter();
  return true;
}

function objectKey(accountId: string, courseCompletionId: string): string {
  return `certificates/v1/${accountId}/${courseCompletionId}.pdf`;
}

function dependencyUnavailable(): HandlerFailure {
  return new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
}

function classifyRepositoryError(error: unknown): unknown {
  if (error instanceof CertificateGenerationInputError) {
    return new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
  }
  if (error instanceof CertificateGenerationConsistencyError) {
    return new HandlerFailure({ code: "JOB_HANDLER_FAILED", permanent: true });
  }
  if (error instanceof DatabaseDependencyUnavailableError) return dependencyUnavailable();
  return error;
}

function permanentStorageFailure(error: CertificateBlobError): boolean {
  return [
    "CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID",
    "CERTIFICATE_BLOB_CONSISTENCY_INCIDENT",
  ].includes(error.message);
}

async function markFailed(
  repository: CertificateGenerationRepositoryPort,
  fence: CertificateGenerationFence,
  failureCode: "render_failed" | "storage_failed",
  signal: AbortSignal,
): Promise<void> {
  try {
    await repository.markFailed({ ...fence, failureCode }, signal);
  } catch (error) {
    throw classifyRepositoryError(error);
  }
}

async function markStorageFailed(
  repository: CertificateGenerationRepositoryPort,
  fence: CertificateGenerationFence,
  signal: AbortSignal,
): Promise<never> {
  await markFailed(repository, fence, "storage_failed", signal);
  throw storageDeadLetter();
}

function storageDeadLetter(): HandlerFailure {
  return new HandlerFailure({ code: "JOB_HANDLER_FAILED", permanent: true });
}

function permanentBlobFailure(): HandlerFailure {
  return new HandlerFailure({ code: "JOB_HANDLER_FAILED", permanent: true });
}
