import { LearningPrerequisiteInputError } from "@syntholo/database";
import { describe, expect, it, vi } from "vitest";
import { createCertificatePrerequisiteRecordHandler } from "./certificate-prerequisite-record.js";

describe("certificate prerequisite record handler", () => {
  it("records and safely replays the exact event", async () => {
    const recordCertificatePrerequisite = vi.fn(async () => ({ kind: "duplicate" as const }));
    const handler = createCertificatePrerequisiteRecordHandler({ recordCertificatePrerequisite });
    await expect(handler({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal)).resolves.toBeUndefined();
    expect(recordCertificatePrerequisite).toHaveBeenCalledOnce();
  });

  it("makes invalid event ownership permanent and dependencies retryable", async () => {
    const invalid = createCertificatePrerequisiteRecordHandler({ recordCertificatePrerequisite: vi.fn(async () => { throw new LearningPrerequisiteInputError(); }) });
    await expect(invalid({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_INPUT_INVALID", permanent: true } });
    const dependency = createCertificatePrerequisiteRecordHandler({ recordCertificatePrerequisite: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(dependency({ eventId: "10000000-0000-4000-8000-000000000001", handlerName: "learning.certificate_prerequisite_record" }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false } });
  });
});
