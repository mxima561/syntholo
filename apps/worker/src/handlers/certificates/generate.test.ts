import { createHash } from "node:crypto";
import {
  CertificateGenerationConsistencyError,
  CertificateGenerationInputError,
  DatabaseDependencyUnavailableError,
} from "@syntholo/database";
import { CertificateBlobError } from "@syntholo/integrations";
import { describe, expect, it, vi } from "vitest";
import { createCertificateGenerationHandler } from "./generate.js";

const job = Object.freeze({
  accountId: "10000000-0000-4000-8000-000000000006",
  correlationId: "10000000-0000-4000-8000-000000000010",
  attempt: 1,
  claimGeneration: 2,
  claimToken: "10000000-0000-4000-8000-000000000002",
  id: "10000000-0000-4000-8000-000000000001",
  idempotencyKey: "certificate:10000000-0000-4000-8000-000000000005",
  leaseExpiresAt: new Date("2026-08-15T12:05:00.000Z"),
  maxAttempts: 5,
  payload: {
    certificateId: "10000000-0000-4000-8000-000000000003",
    courseCompletionId: "10000000-0000-4000-8000-000000000005",
  },
  sourceActorId: "10000000-0000-4000-8000-000000000011",
  sourceActorType: "member" as const,
  type: "learning.course_completed.certificate.v1",
  workerId: "certificate-test-worker-certificate-v1",
});
const generation = Object.freeze({
  kind: "pending" as const,
  certificateId: job.payload.certificateId,
  courseCompletionId: job.payload.courseCompletionId,
  accountId: job.accountId,
  recipientName: "Ada Lovelace",
  businessName: "Syntholo Test Account",
  courseTitle: "Syntholo Academy",
  courseVersion: 1,
  completedAt: "2026-08-15T12:00:00.000Z",
});
const pdf = new TextEncoder().encode("%PDF-1.7\ncertificate");
const sha256 = createHash("sha256").update(pdf).digest("hex");
const pathname = `certificates/v1/${job.accountId}/${job.payload.courseCompletionId}.pdf`;
const providerFact = Object.freeze({
  byteLength: pdf.byteLength,
  sha256,
  etag: "strong-provider-etag",
  contentType: "application/pdf" as const,
});

function dependencies() {
  return {
    repository: {
      loadGenerationFence: vi.fn(async () => generation),
      loadIssuedFile: vi.fn(async () => ({
        certificateId: generation.certificateId,
        courseCompletionId: generation.courseCompletionId,
        accountId: generation.accountId,
        membershipId: "10000000-0000-4000-8000-000000000007",
        objectKey: pathname,
        byteLength: pdf.byteLength,
        sha256,
        etag: providerFact.etag,
        storedAt: "2026-08-15T12:01:00.000Z",
      })),
      finalize: vi.fn(async () => ({ certificateId: generation.certificateId })),
      markFailed: vi.fn(async () => ({ kind: "failed" as const })),
    },
    blob: {
      upload: vi.fn(async () => providerFact),
      reconcileUpload: vi.fn(async () => providerFact),
    },
    render: vi.fn(async () => pdf),
  };
}

describe("certificate generation handler", () => {
  it("renders, privately uploads, and fenced-finalizes one exact pending certificate", async () => {
    const input = dependencies();
    const handler = createCertificateGenerationHandler(input);
    const signal = new AbortController().signal;
    await expect(handler(job, signal)).resolves.toBeUndefined();
    expect(input.render).toHaveBeenCalledWith({
      recipientName: generation.recipientName,
      businessName: generation.businessName,
      courseTitle: generation.courseTitle,
      courseVersion: generation.courseVersion,
      completedAt: generation.completedAt,
    });
    expect(input.blob.upload).toHaveBeenCalledWith({ pathname, bytes: pdf, sha256, signal });
    expect(input.repository.finalize).toHaveBeenCalledWith({
      jobId: job.id,
      workerId: job.workerId,
      attempt: job.attempt,
      generation: job.claimGeneration,
      claimToken: job.claimToken,
      byteLength: pdf.byteLength,
      sha256,
      etag: providerFact.etag,
    }, signal);
  });

  it("ACK-recovers issued and failed records without rendering or provider work", async () => {
    for (const terminal of [
      { kind: "issued" as const, certificateId: generation.certificateId, courseCompletionId: generation.courseCompletionId, accountId: generation.accountId },
      { kind: "failed" as const, certificateId: generation.certificateId, courseCompletionId: generation.courseCompletionId, accountId: generation.accountId, failureCode: "storage_failed" as const },
    ]) {
      const input = dependencies();
      input.repository.loadGenerationFence.mockResolvedValueOnce(terminal as never);
      const handler = createCertificateGenerationHandler(input);
      const outcome = expect(handler(job, new AbortController().signal));
      if (terminal.kind === "failed") {
        await outcome.rejects.toMatchObject({
          failure: { code: "JOB_HANDLER_FAILED", permanent: true },
        });
        expect(input.repository.markFailed).toHaveBeenCalledWith(
          expect.objectContaining({ failureCode: "storage_failed" }),
          expect.any(AbortSignal),
        );
      } else await outcome.resolves.toBeUndefined();
      expect(input.render).not.toHaveBeenCalled();
      expect(input.blob.upload).not.toHaveBeenCalled();
      if (terminal.kind === "issued") expect(input.repository.loadIssuedFile).toHaveBeenCalledOnce();
      else expect(input.repository.loadIssuedFile).not.toHaveBeenCalled();
    }

    const renderedFailed = dependencies();
    renderedFailed.repository.loadGenerationFence.mockResolvedValueOnce({
      kind: "failed",
      certificateId: generation.certificateId,
      courseCompletionId: generation.courseCompletionId,
      accountId: generation.accountId,
      failureCode: "render_failed",
    } as never);
    renderedFailed.repository.markFailed.mockResolvedValueOnce({ kind: "duplicate" } as never);
    await expect(createCertificateGenerationHandler(renderedFailed)(job, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(renderedFailed.repository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "render_failed" }),
      expect.any(AbortSignal),
    );
  });

  it("reconciles the deterministic object after an ambiguous PUT response before finalizing", async () => {
    const input = dependencies();
    input.blob.upload.mockRejectedValueOnce(
      new CertificateBlobError("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true),
    );
    const handler = createCertificateGenerationHandler(input);
    await expect(handler(job, new AbortController().signal)).resolves.toBeUndefined();
    expect(input.blob.reconcileUpload).toHaveBeenCalledWith({
      pathname,
      expected: { byteLength: pdf.byteLength, sha256 },
      signal: expect.any(AbortSignal),
    });
    expect(input.repository.finalize).toHaveBeenCalledOnce();

    const malformedResponse = dependencies();
    malformedResponse.blob.upload.mockRejectedValueOnce(
      new CertificateBlobError("CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID", false),
    );
    await expect(createCertificateGenerationHandler(malformedResponse)(job, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(malformedResponse.blob.reconcileUpload).toHaveBeenCalledOnce();
    expect(malformedResponse.repository.finalize).toHaveBeenCalledOnce();
  });

  it("revalidates the complete live fence after rendering and uploads zero bytes when it is stale", async () => {
    const input = dependencies();
    input.repository.loadGenerationFence
      .mockResolvedValueOnce(generation)
      .mockResolvedValueOnce({
        kind: "issued",
        certificateId: generation.certificateId,
        courseCompletionId: generation.courseCompletionId,
        accountId: generation.accountId,
      } as never);
    await expect(createCertificateGenerationHandler(input)(job, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(input.render).toHaveBeenCalledOnce();
    expect(input.blob.upload).not.toHaveBeenCalled();
    expect(input.repository.finalize).not.toHaveBeenCalled();
  });

  it("marks deterministic render/provider failures terminal but leaves dependency failures retryable", async () => {
    const renderFailure = dependencies();
    renderFailure.render.mockRejectedValueOnce(new Error("CERTIFICATE_RENDER_INPUT_INVALID"));
    await expect(createCertificateGenerationHandler(renderFailure)(job, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(renderFailure.repository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "render_failed" }),
      expect.any(AbortSignal),
    );

    const storageFailure = dependencies();
    storageFailure.blob.upload.mockRejectedValueOnce(
      new CertificateBlobError("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false),
    );
    await expect(createCertificateGenerationHandler(storageFailure)(job, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_HANDLER_FAILED", permanent: true } });
    expect(storageFailure.repository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "storage_failed" }),
      expect.any(AbortSignal),
    );

    const dependency = dependencies();
    dependency.repository.loadGenerationFence.mockRejectedValueOnce(
      new DatabaseDependencyUnavailableError("lock_timeout"),
    );
    await expect(createCertificateGenerationHandler(dependency)(job, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false } });

    const lifecycleAbort = dependencies();
    lifecycleAbort.blob.upload.mockRejectedValueOnce(
      new CertificateBlobError("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true),
    );
    lifecycleAbort.blob.reconcileUpload.mockRejectedValueOnce(
      new CertificateBlobError("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true),
    );
    await expect(createCertificateGenerationHandler(lifecycleAbort)(job, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false } });
    expect(lifecycleAbort.repository.markFailed).not.toHaveBeenCalled();

    for (const code of ["CERTIFICATE_BLOB_DISABLED", "CERTIFICATE_BLOB_INPUT_INVALID", "CERTIFICATE_BLOB_CONFIG_INVALID"]) {
      const configurationFailure = dependencies();
      configurationFailure.blob.upload.mockRejectedValueOnce(new CertificateBlobError(code, false));
      await expect(createCertificateGenerationHandler(configurationFailure)(job, new AbortController().signal))
        .rejects.toMatchObject({ failure: { code: "JOB_HANDLER_FAILED", permanent: true } });
      expect(configurationFailure.repository.markFailed).not.toHaveBeenCalled();
      expect(configurationFailure.blob.reconcileUpload).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed job provenance and exact fence failures permanently", async () => {
    const input = dependencies();
    const handler = createCertificateGenerationHandler(input);
    await expect(handler({ ...job, idempotencyKey: "certificate:wrong" }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_INPUT_INVALID", permanent: true } });
    expect(input.repository.loadGenerationFence).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort();
    await expect(handler(job, aborted.signal))
      .rejects.toMatchObject({ failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false } });
    expect(input.repository.loadGenerationFence).not.toHaveBeenCalled();

    input.repository.loadGenerationFence.mockRejectedValueOnce(new CertificateGenerationInputError());
    await expect(handler(job, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_INPUT_INVALID", permanent: true } });
    expect(input.render).not.toHaveBeenCalled();
    expect(input.blob.upload).not.toHaveBeenCalled();

    input.repository.loadGenerationFence.mockRejectedValueOnce(
      new CertificateGenerationConsistencyError(),
    );
    await expect(handler(job, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_HANDLER_FAILED", permanent: true } });
  });
});
