import {
  CertificateCandidateInputError,
  DatabaseDependencyUnavailableError,
  LearningPrerequisiteInputError,
} from "@syntholo/database";
import { describe, expect, it, vi } from "vitest";
import { createCertificatePrerequisiteRecordHandler } from "./certificate-prerequisite-record.js";

describe("certificate prerequisite record handler", () => {
  it("records and safely replays the exact event", async () => {
    const recordCertificatePrerequisite = vi.fn(async () => ({ kind: "duplicate" as const }));
    const stageCertificateCandidate = vi.fn(async () => ({ kind: "duplicate" as const }));
    const handler = createCertificatePrerequisiteRecordHandler({
      recordCertificatePrerequisite,
      stageCertificateCandidate,
    });
    await expect(handler({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal)).resolves.toBeUndefined();
    expect(recordCertificatePrerequisite).toHaveBeenCalledOnce();
    expect(stageCertificateCandidate).toHaveBeenCalledOnce();
    expect(recordCertificatePrerequisite.mock.invocationCallOrder[0])
      .toBeLessThan(stageCertificateCandidate.mock.invocationCallOrder[0]!);
  });

  it("does not stage until the prerequisite command succeeds", async () => {
    const stageCertificateCandidate = vi.fn();
    const invalid = createCertificatePrerequisiteRecordHandler({
      recordCertificatePrerequisite: vi.fn(async () => { throw new LearningPrerequisiteInputError(); }),
      stageCertificateCandidate,
    });
    await expect(invalid({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_INPUT_INVALID", permanent: true } });
    expect(stageCertificateCandidate).not.toHaveBeenCalled();
  });

  it("makes invalid candidate provenance permanent and typed dependencies retryable", async () => {
    const invalid = createCertificatePrerequisiteRecordHandler({
      recordCertificatePrerequisite: vi.fn(async () => ({ kind: "recorded" as const })),
      stageCertificateCandidate: vi.fn(async () => { throw new CertificateCandidateInputError(); }),
    });
    await expect(invalid({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_INPUT_INVALID", permanent: true } });

    const dependency = createCertificatePrerequisiteRecordHandler({
      recordCertificatePrerequisite: vi.fn(async () => ({ kind: "recorded" as const })),
      stageCertificateCandidate: vi.fn(async () => {
        throw new DatabaseDependencyUnavailableError("lock_timeout");
      }),
    });
    await expect(dependency({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false } });
  });

  it("does not misclassify an unexpected result or programmer failure as dependency downtime", async () => {
    const unexpected = new Error("CERTIFICATE_STAGE_RESULT_INVALID");
    const handler = createCertificatePrerequisiteRecordHandler({
      recordCertificatePrerequisite: vi.fn(async () => ({ kind: "recorded" as const })),
      stageCertificateCandidate: vi.fn(async () => { throw unexpected; }),
    });
    await expect(handler({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal))
      .rejects.toBe(unexpected);
  });
});
