import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CertificateCandidateInputError,
  LearningPrerequisiteInputError,
  WorkerLearningRepository,
} from "./learning-worker.js";

function client(query: ReturnType<typeof vi.fn>) {
  const events = new EventEmitter();
  const release = vi.fn((destroy?: boolean) => {
    if (destroy) events.emit("end");
  });
  return { query, release, once: events.once.bind(events) };
}

describe("worker learning repository", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records a prerequisite only through the closed event command", async () => {
    const query = vi.fn(async () => ({ rows: [{ outcome: "recorded" }] }));
    const lease = client(query);
    const repository = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.recordCertificatePrerequisite({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    }, new AbortController().signal)).resolves.toEqual({ kind: "recorded" });
    expect(query).toHaveBeenCalledWith(
      "select public.syntholo_learning_record_certificate_prerequisite_v1($1,$2) outcome",
      ["10000000-0000-4000-8000-000000000001", "learning.certificate_prerequisite_record"],
    );
    expect(lease.release).toHaveBeenCalledWith();
  });

  it("stages a certificate candidate only through the exact closed event command", async () => {
    const query = vi.fn(async () => ({ rows: [{ outcome: "recorded" }] }));
    const lease = client(query);
    const repository = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.stageCertificateCandidate({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    }, new AbortController().signal)).resolves.toEqual({ kind: "recorded" });
    expect(query).toHaveBeenCalledWith(
      "select public.syntholo_certificate_stage_candidate_v1($1,$2) outcome",
      ["10000000-0000-4000-8000-000000000001", "learning.certificate_prerequisite_record"],
    );
    expect(lease.release).toHaveBeenCalledWith();
  });

  it("translates only the exact candidate input error to a safe terminal type", async () => {
    const exactLease = client(vi.fn(async () => { throw new Error("CERTIFICATE_EVENT_INPUT_INVALID"); }));
    const exact = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => exactLease) } } as never);
    await expect(exact.stageCertificateCandidate({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    })).rejects.toBeInstanceOf(CertificateCandidateInputError);

    const unknownFailure = new Error("unexpected CERTIFICATE_EVENT_INPUT_INVALID suffix");
    const unknownLease = client(vi.fn(async () => { throw unknownFailure; }));
    const unknown = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => unknownLease) } } as never);
    await expect(unknown.stageCertificateCandidate({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    })).rejects.toBe(unknownFailure);
  });

  it("classifies a mismatched event as terminal input", async () => {
    const repository = new WorkerLearningRepository({ pool: { connect: vi.fn() } } as never);
    await expect(repository.recordCertificatePrerequisite({ eventId: "bad", handlerName: "learning.certificate_prerequisite_record" }))
      .rejects.toBeInstanceOf(LearningPrerequisiteInputError);
  });

  it("does not trust a database error that only contains the input code as a substring", async () => {
    const unknownFailure = new Error("unexpected LEARNING_PREREQUISITE_INPUT_INVALID suffix");
    const lease = client(vi.fn(async () => { throw unknownFailure; }));
    const repository = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    await expect(repository.recordCertificatePrerequisite({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    })).rejects.toBe(unknownFailure);
  });

  it("bounds a stalled worker command and poisons its lease", async () => {
    const query = vi.fn(() => new Promise(() => undefined));
    const lease = client(query);
    const repository = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    const pending = repository.recordCertificatePrerequisite({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "DATABASE_DEPENDENCY_UNAVAILABLE", kind: "lock_timeout",
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_001);
    await vi.advanceTimersByTimeAsync(1_001);
    await rejected;
    expect(lease.release).toHaveBeenCalledWith(true);
  });

  it("cancels a running command on worker shutdown and poisons its lease", async () => {
    const query = vi.fn(() => new Promise(() => undefined));
    const lease = client(query);
    const controller = new AbortController();
    const repository = new WorkerLearningRepository({ pool: { connect: vi.fn(async () => lease) } } as never);
    const pending = repository.recordCertificatePrerequisite({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "learning.certificate_prerequisite_record",
    }, controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "DATABASE_DEPENDENCY_UNAVAILABLE", kind: "parent_timeout",
    });
    expect(lease.release).toHaveBeenCalledWith(true);
  });
});
