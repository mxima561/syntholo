import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CertificateGenerationInputError,
  CertificateGenerationConsistencyError,
  CertificateGenerationRepositoryError,
  CertificateStorageRecoveryPriorDecisionError,
  WorkerCertificateRepository,
} from "./certificates-worker.js";

function client(query: ReturnType<typeof vi.fn>) {
  const events = new EventEmitter();
  const release = vi.fn((destroy?: boolean) => {
    if (destroy) events.emit("end");
  });
  return { query, release, once: events.once.bind(events) };
}

const fence = Object.freeze({
  jobId: "10000000-0000-4000-8000-000000000001",
  workerId: "certificate-test-worker-certificate-v1",
  attempt: 1,
  generation: 2,
  claimToken: "10000000-0000-4000-8000-000000000002",
});

const pendingRow = Object.freeze({
  id: "10000000-0000-4000-8000-000000000003",
  certificate_prerequisite_id: "10000000-0000-4000-8000-000000000004",
  course_completion_id: "10000000-0000-4000-8000-000000000005",
  account_id: "10000000-0000-4000-8000-000000000006",
  membership_id: "10000000-0000-4000-8000-000000000007",
  enrollment_id: "10000000-0000-4000-8000-000000000008",
  course_id: "10000000-0000-4000-8000-000000000009",
  course_version_id: "10000000-0000-4000-8000-00000000000a",
  business_name_snapshot: "Syntholo Test Account",
  course_title_snapshot: "Syntholo Academy",
  course_version: 1,
  completed_at: "2026-08-15T12:00:00+00:00",
  snapshot_renderable: true,
  recipient_name_version_id: "10000000-0000-4000-8000-00000000000b",
  recipient_name_version: 1,
  recipient_name_snapshot: "Ada Lovelace",
  renderer_version: "certificate-pdf.v1",
  status: "pending",
  failure_code: null,
  issued_at: null,
  created_at: "2026-08-15T12:00:00+00:00",
  updated_at: "2026-08-15T12:00:00+00:00",
});

describe("worker certificate repository", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads the exact live generation fence and maps only safe render inputs", async () => {
    const query = vi.fn(async () => ({ rows: [{ result: pendingRow }] }));
    const lease = client(query);
    const repository = new WorkerCertificateRepository({
      pool: { connect: vi.fn(async () => lease) },
    } as never);

    await expect(repository.loadGenerationFence(fence)).resolves.toEqual({
      kind: "pending",
      certificateId: pendingRow.id,
      courseCompletionId: pendingRow.course_completion_id,
      accountId: pendingRow.account_id,
      recipientName: pendingRow.recipient_name_snapshot,
      businessName: pendingRow.business_name_snapshot,
      courseTitle: pendingRow.course_title_snapshot,
      courseVersion: 1,
      completedAt: "2026-08-15T12:00:00.000Z",
    });
    expect(query).toHaveBeenCalledWith(
      "select to_jsonb(public.syntholo_certificate_load_generation_fence_v1($1,$2,$3,$4,$5)) result",
      [fence.jobId, fence.workerId, fence.attempt, fence.generation, fence.claimToken],
    );
  });

  it("returns issued and failed ACK-recovery discriminators without rendering inputs", async () => {
    const issued = { ...pendingRow, status: "issued", issued_at: "2026-08-15T12:01:00+00:00" };
    const failed = { ...pendingRow, status: "failed", failure_code: "storage_failed" };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ result: issued }] })
      .mockResolvedValueOnce({ rows: [{ result: failed }] });
    const lease = client(query);
    const repository = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.loadGenerationFence(fence)).resolves.toEqual({
      kind: "issued",
      certificateId: pendingRow.id,
      courseCompletionId: pendingRow.course_completion_id,
      accountId: pendingRow.account_id,
    });
    await expect(repository.loadGenerationFence(fence)).resolves.toEqual({
      kind: "failed",
      certificateId: pendingRow.id,
      courseCompletionId: pendingRow.course_completion_id,
      accountId: pendingRow.account_id,
      failureCode: "storage_failed",
    });
  });

  it("loads the exact issued file fence and acknowledges the same terminal failure", async () => {
    const file = {
      id: "10000000-0000-4000-8000-00000000000c",
      certificate_id: pendingRow.id,
      course_completion_id: pendingRow.course_completion_id,
      account_id: pendingRow.account_id,
      membership_id: pendingRow.membership_id,
      object_key: `certificates/v1/${pendingRow.account_id}/${pendingRow.course_completion_id}.pdf`,
      access: "private",
      content_type: "application/pdf",
      byte_length: 5821,
      sha256: "a".repeat(64),
      etag: "provider-etag",
      renderer_version: "certificate-pdf.v1",
      stored_at: "2026-08-15T12:01:00+00:00",
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ result: file }] })
      .mockResolvedValueOnce({ rows: [{ outcome: "duplicate" }] });
    const lease = client(query);
    const repository = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.loadIssuedFile(fence)).resolves.toMatchObject({
      certificateId: pendingRow.id,
      objectKey: file.object_key,
      etag: file.etag,
    });
    await expect(repository.markFailed({ ...fence, failureCode: "storage_failed" }))
      .resolves.toEqual({ kind: "duplicate" });
  });

  it("lists exact storage-retry candidates and requeues the same failed generation from safe observations", async () => {
    const failedCandidate = {
      ...pendingRow,
      status: "failed",
      failure_code: "storage_failed",
      recovery_job_id: fence.jobId,
      recovery_attempt: 1,
      recovery_claim_generation: 2,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ result: [failedCandidate] }] })
      .mockResolvedValueOnce({ rows: [{ outcome: "pending" }] })
      .mockResolvedValueOnce({ rows: [{ outcome: "prior_decision" }] });
    const lease = client(query);
    const repository = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.listStorageRetryCandidates(25)).resolves.toEqual([{
      certificateId: pendingRow.id,
      courseCompletionId: pendingRow.course_completion_id,
      accountId: pendingRow.account_id,
      recoveryJobId: fence.jobId,
      failedAttempt: 1,
      failedGeneration: 2,
      recipientName: pendingRow.recipient_name_snapshot,
      businessName: pendingRow.business_name_snapshot,
      courseTitle: pendingRow.course_title_snapshot,
      courseVersion: 1,
      completedAt: "2026-08-15T12:00:00.000Z",
    }]);
    const absent = {
      certificateId: pendingRow.id,
      recoveryJobId: fence.jobId,
      failedAttempt: 1,
      failedGeneration: 2,
      objectState: "absent" as const,
      byteLength: 5821,
      sha256: "a".repeat(64),
      etag: null,
    };
    await expect(repository.retry(absent))
      .resolves.toEqual({ kind: "pending" });
    await expect(repository.retry({ ...absent, objectState: "matching", etag: "provider-etag" }))
      .rejects.toBeInstanceOf(CertificateStorageRecoveryPriorDecisionError);
    expect(query).toHaveBeenNthCalledWith(
      2,
      "select public.syntholo_certificate_retry_v1($1,$2,$3,$4,$5,$6,$7,$8) outcome",
      [pendingRow.id, fence.jobId, 1, 2, "absent", 5821, "a".repeat(64), null],
    );
    await expect(repository.retry({ ...absent, objectState: "unknown" } as never))
      .rejects.toBeInstanceOf(CertificateGenerationInputError);
    await expect(repository.retry({ ...absent, extra: true } as never))
      .rejects.toBeInstanceOf(CertificateGenerationInputError);
    await expect(repository.retry({ ...absent, etag: "provider-etag" }))
      .rejects.toBeInstanceOf(CertificateGenerationInputError);
    await expect(repository.retry({ ...absent, objectState: "matching", etag: null }))
      .rejects.toBeInstanceOf(CertificateGenerationInputError);
  });

  it("records one safe terminal recovery rejection and rejects malformed candidates", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ outcome: "rejected" }] })
      .mockResolvedValueOnce({ rows: [{ result: [{ ...pendingRow, status: "failed", failure_code: "storage_failed" }] }] });
    const lease = client(query);
    const repository = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.rejectStorageRecovery({
      certificateId: pendingRow.id,
      recoveryJobId: fence.jobId,
      failedAttempt: 1,
      failedGeneration: 2,
      reason: "object_mismatch",
    })).resolves.toEqual({ kind: "rejected" });
    expect(query).toHaveBeenNthCalledWith(
      1,
      "select public.syntholo_certificate_recovery_reject_v1($1,$2,$3,$4,$5) outcome",
      [pendingRow.id, fence.jobId, 1, 2, "object_mismatch"],
    );
    await expect(repository.listStorageRetryCandidates(25))
      .rejects.toBeInstanceOf(CertificateGenerationRepositoryError);
    await expect(repository.listStorageRetryCandidates(0))
      .rejects.toBeInstanceOf(CertificateGenerationInputError);
    await expect(repository.rejectStorageRecovery({
      certificateId: pendingRow.id,
      recoveryJobId: fence.jobId,
      failedAttempt: 1,
      failedGeneration: 2,
      reason: "unknown",
    } as never)).rejects.toBeInstanceOf(CertificateGenerationInputError);
  });

  it("runs only the bounded closed historical candidate promoter", async () => {
    const query = vi.fn(async () => ({ rows: [{ outcome: 37 }] }));
    const lease = client(query);
    const repository = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.promote(100)).resolves.toEqual({ promoted: 37 });
    expect(query).toHaveBeenCalledWith(
      "select public.syntholo_certificate_promote_v1($1) outcome",
      [100],
    );
    await expect(repository.promote(101)).rejects.toBeInstanceOf(CertificateGenerationInputError);
  });

  it("finalizes with exact provider facts and safely replays the immutable file", async () => {
    const file = {
      id: "10000000-0000-4000-8000-00000000000c",
      certificate_id: pendingRow.id,
      course_completion_id: pendingRow.course_completion_id,
      account_id: pendingRow.account_id,
      membership_id: pendingRow.membership_id,
      object_key: `certificates/v1/${pendingRow.account_id}/${pendingRow.course_completion_id}.pdf`,
      access: "private",
      content_type: "application/pdf",
      byte_length: 5821,
      sha256: "a".repeat(64),
      etag: "provider-etag",
      renderer_version: "certificate-pdf.v1",
      stored_at: "2026-08-15T12:01:00+00:00",
    };
    const query = vi.fn(async () => ({ rows: [{ result: file }] }));
    const lease = client(query);
    const repository = new WorkerCertificateRepository({
      pool: { connect: vi.fn(async () => lease) },
    } as never);
    await expect(repository.finalize({
      ...fence,
      byteLength: file.byte_length,
      sha256: file.sha256,
      etag: file.etag,
    })).resolves.toMatchObject({ certificateId: pendingRow.id, etag: file.etag });
    expect(query).toHaveBeenCalledWith(
      "select to_jsonb(public.syntholo_certificate_finalize_v1($1,$2,$3,$4,$5,$6,$7,$8)) result",
      [fence.jobId, fence.workerId, fence.attempt, fence.generation, fence.claimToken, 5821, file.sha256, file.etag],
    );
  });

  it("translates only exact fence failures and never leaks arbitrary database detail", async () => {
    const exactLease = client(vi.fn(async () => { throw new Error("CERTIFICATE_JOB_FENCE_INVALID"); }));
    const exact = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => exactLease) } } as never);
    await expect(exact.loadGenerationFence(fence)).rejects.toBeInstanceOf(CertificateGenerationInputError);

    const marker = new Error("row contained PRIVATE-NAME-MARKER");
    const unknownLease = client(vi.fn(async () => { throw marker; }));
    const unknown = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => unknownLease) } } as never);
    const rejection = await unknown.loadGenerationFence(fence).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CertificateGenerationRepositoryError);
    expect(JSON.stringify(rejection)).not.toContain("PRIVATE-NAME-MARKER");
    expect(String(rejection)).not.toContain("PRIVATE-NAME-MARKER");

    for (const code of ["CERTIFICATE_JOB_ACK_MISMATCH", "CERTIFICATE_RETRY_RECONCILIATION_REQUIRED"]) {
      const consistencyLease = client(vi.fn(async () => { throw new Error(code); }));
      const consistency = new WorkerCertificateRepository({
        pool: { connect: vi.fn(async () => consistencyLease) },
      } as never);
      await expect(consistency.loadGenerationFence(fence))
        .rejects.toBeInstanceOf(CertificateGenerationConsistencyError);
    }
  });

  it("rejects malformed authoritative rows and poisons an aborted late lease", async () => {
    const malformedLease = client(vi.fn(async () => ({ rows: [{ result: { ...pendingRow, status: "unknown" } }] })));
    const malformed = new WorkerCertificateRepository({ pool: { connect: vi.fn(async () => malformedLease) } } as never);
    await expect(malformed.loadGenerationFence(fence)).rejects.toBeInstanceOf(CertificateGenerationRepositoryError);

    const informalDateLease = client(vi.fn(async () => ({
      rows: [{ result: { ...pendingRow, completed_at: "August 15, 2026" } }],
    })));
    const informalDate = new WorkerCertificateRepository({
      pool: { connect: vi.fn(async () => informalDateLease) },
    } as never);
    await expect(informalDate.loadGenerationFence(fence))
      .rejects.toBeInstanceOf(CertificateGenerationRepositoryError);

    const validFile = {
      id: "10000000-0000-4000-8000-00000000000c",
      certificate_id: pendingRow.id,
      course_completion_id: pendingRow.course_completion_id,
      account_id: pendingRow.account_id,
      membership_id: pendingRow.membership_id,
      object_key: `certificates/v1/${pendingRow.account_id}/${pendingRow.course_completion_id}.pdf`,
      access: "private",
      content_type: "application/pdf",
      byte_length: 5821,
      sha256: "a".repeat(64),
      etag: "provider-etag",
      renderer_version: "certificate-pdf.v1",
      stored_at: "2026-08-15T12:01:00+00:00",
    };
    for (const drift of [
      { object_key: `certificates/v1/${pendingRow.course_completion_id}/${pendingRow.account_id}.pdf` },
      { object_key: "certificates/v1/------------------------------------/------------------------------------.pdf" },
      { etag: '"quoted"' },
      { etag: "W/weak" },
      { etag: "has space" },
    ]) {
      const malformedFileLease = client(vi.fn(async () => ({
        rows: [{ result: { ...validFile, ...drift } }],
      })));
      const malformedFile = new WorkerCertificateRepository({
        pool: { connect: vi.fn(async () => malformedFileLease) },
      } as never);
      await expect(malformedFile.loadIssuedFile(fence))
        .rejects.toBeInstanceOf(CertificateGenerationRepositoryError);
    }

    let resolveLease!: (value: ReturnType<typeof client>) => void;
    const lateLease = client(vi.fn());
    const acquisition = new Promise<ReturnType<typeof client>>((resolve) => { resolveLease = resolve; });
    const controller = new AbortController();
    const repository = new WorkerCertificateRepository({ pool: { connect: vi.fn(() => acquisition) } } as never);
    const pending = repository.loadGenerationFence(fence, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DATABASE_DEPENDENCY_UNAVAILABLE" });
    resolveLease(lateLease);
    await vi.waitFor(() => expect(lateLease.release).toHaveBeenCalledWith(true));
  });
});
